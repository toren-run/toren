import type { z } from "zod";
import { canonicalDigest } from "./digest.js";
import { effectiveEvents } from "./fold.js";
import { ev, type NewEvent, type RecordedEvent, type StreamId } from "./events.js";
import { needsApproval, toolSpecs, type ToolDefAny } from "./tools.js";
import type { ChatMessage, ContentBlock, ModelProvider, ModelRequest, ModelResponse } from "./model.js";
import type { PgStateStore } from "./store.js";
import { withSpan } from "./tracing.js";

export class TaskLeaseLostError extends Error {}

/**
 * Thrown instead of appending yet another StreamInvalidated when a stream has
 * been invalidated repeatedly in a short window — the signature of two worker
 * versions fighting over one stream during a rolling deploy, each re-paying
 * the other's voided model calls. The worker defers the message instead; the
 * war starves until one version drains, and a legitimate re-edit waits out
 * the window at worst.
 */
export class InvalidationStormError extends Error {}
export const INVALIDATION_STORM_LIMIT = 3;
export const INVALIDATION_STORM_WINDOW_MS = 5 * 60 * 1000;

export interface AgentSpec {
  model: string;
  system: string;
  tools: ToolDefAny[];
  maxTokens: number;
  maxSteps: number;
  outputSchema?: z.ZodTypeAny;
  /** Declared env values (from agent.yaml `env:`) passed to tool handlers as ctx.env. */
  env?: Record<string, string>;
  /** Model context window in tokens; drives compaction. Defaults per provider; unset for mock disables compaction. */
  contextWindow?: number;
}

/** Provider defaults; agent.yaml `contextWindow:` overrides. mock/ gets none, so tests never compact by surprise. */
export function defaultContextWindow(model: string): number | undefined {
  if (model.startsWith("anthropic/")) return 200_000;
  if (model.startsWith("openai/")) return 128_000;
  return undefined;
}

// ---- context compaction constants. Changing these mid-run invalidates in-flight
// suffixes (same contract as changing a prompt); recorded compactions replay by value.
export const COMPACT_ELIDE_AT = 0.5; // of contextWindow: replace old tool results with stubs
export const COMPACT_SUMMARY_AT = 0.78; // of contextWindow: fold history into a recorded summary
export const COMPACT_KEEP_RESULTS = 3; // most recent tool results always kept verbatim
export const COMPACT_KEEP_TAIL = 6; // minimum recent messages kept verbatim through a summary fold
export const COMPACT_MIN_ELIDE_CHARS = 500; // tool results smaller than this are never elided
export const COMPACT_SUMMARY_MAX_TOKENS = 2048;
const ELIDE_MARK = "[elided:";

export const SUMMARIZE_SYSTEM =
  "You compress an agent conversation so the agent can continue it in less space. " +
  "Write a summary that preserves, in this order: (1) the original task or request, quoted; " +
  "(2) every user message so far, enumerated verbatim; (3) decisions made and constraints discovered; " +
  "(4) facts, numbers, names, and URLs learned from tools that are still needed; " +
  "(5) current state of the work; (6) the immediate next step. " +
  "Be dense and specific. Output only the summary text.";

export interface TaskLoopArgs {
  store: PgStateStore;
  provider: ModelProvider;
  runId: string;
  taskId: string;
  agent: AgentSpec;
  input: string;
  /** Conversational session: end-of-turn parks awaiting the next UserMessage instead of completing. */
  sessionMode?: boolean;
}

export type TaskLoopResult =
  | { status: "completed"; output: string }
  | { status: "waitingApproval" }
  | { status: "awaitingInput" }
  | { status: "failed"; error: string };

type ToolUseBlock = Extract<ContentBlock, { type: "toolUse" }>;

// Events the loop itself emits in execution order; replay walks these.
const WALK_TYPES = new Set([
  "LlmCallStarted", "LlmCallCompleted",
  "ToolCallStarted", "ToolCallCompleted",
  "ApprovalRequested", "TaskCompleted",
  "InputRequested", "UserMessage",
  "ContextCompacted",
]);

/** Layered onto the system prompt in session mode; constant, so replay digests stay stable. */
export const SESSION_PREAMBLE =
  "\n\nYou are in an interactive session with a user. Answer their current message directly; " +
  "ask a clarifying question when the request is ambiguous. Keep responses conversational and " +
  "sized to the question — the user can always ask for more.";

export async function runTaskLoop(args: TaskLoopArgs): Promise<TaskLoopResult> {
  return withSpan("toren.task", { "toren.run_id": args.runId, "toren.task_id": args.taskId }, () => runTaskLoopImpl(args));
}

async function runTaskLoopImpl(args: TaskLoopArgs): Promise<TaskLoopResult> {
  const { store, provider, runId, taskId, agent } = args;
  const streamId: StreamId = `task:${taskId}`;

  const raw = await store.read(runId, streamId);
  let head = raw.at(-1)?.seq ?? 0;
  const eff = effectiveEvents(raw);

  const terminalFailure = eff.find((e) => e.type === "TaskFailed" && !e.payload.willRetry);
  if (terminalFailure) return { status: "failed", error: String(terminalFailure.payload.error ?? "") };

  const resolutions = new Map<string, { granted: boolean; by?: string; comment?: string }>();
  for (const e of eff) {
    if (e.type === "ApprovalResolved") {
      resolutions.set(String(e.payload.stepId), {
        granted: Boolean(e.payload.granted),
        by: e.payload.by as string | undefined,
        comment: e.payload.comment as string | undefined,
      });
    }
  }

  const walk = eff.filter((e) => WALK_TYPES.has(e.type));
  let ptr = 0;
  let invalidated = false;
  const peek = (): RecordedEvent | undefined => (invalidated || ptr >= walk.length ? undefined : walk[ptr]);

  async function append(events: NewEvent[]): Promise<void> {
    const r = await store.append(runId, streamId, head, events);
    if (!r.ok) throw new TaskLeaseLostError(`stream advanced concurrently (expected ${head}, actual ${r.actualSeq})`);
    head = r.lastSeq;
  }

  const recentInvalidations = raw.filter(
    (e) => e.type === "StreamInvalidated" && Date.now() - e.recordedAt.getTime() < INVALIDATION_STORM_WINDOW_MS,
  ).length;

  async function invalidateFrom(fromSeq: number, reason: string): Promise<void> {
    if (recentInvalidations >= INVALIDATION_STORM_LIMIT) {
      throw new InvalidationStormError(
        `invalidation storm: ${recentInvalidations} invalidations on ${streamId} in the last 5m — deferring instead of re-paying (likely mixed worker versions mid-deploy); latest cause: ${reason}`,
      );
    }
    await append([ev("StreamInvalidated", { fromSeq, reason })]);
    invalidated = true;
  }

  const attempt = raw.filter((e) => e.type === "TaskStarted").length + 1;
  await append([ev("TaskStarted", { attempt })]);

  const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: args.input }] }];
  const specs = toolSpecs(agent.tools);
  const system = args.sessionMode ? agent.system + SESSION_PREAMBLE : agent.system;
  let steps = 0;

  // ---- context pressure: exact usage from the previous model call plus a
  // chars/3 bound on what we appended since. Deterministic on replay because
  // usage rides in LlmCallCompleted and appends are reconstructed identically.
  const contextWindow = agent.contextWindow ?? defaultContextWindow(agent.model);
  let lastUsage: { inputTokens: number; outputTokens: number } | undefined;
  let pendingChars = 0;
  let elidedSavingsTokens = 0;
  const pressure = (): number =>
    lastUsage ? lastUsage.inputTokens + lastUsage.outputTokens + Math.ceil(pendingChars / 3) - elidedSavingsTokens : 0;

  /** The record/replay dance for one model call; identical semantics for the main loop and summarization. */
  async function recordedLlmCall(request: ModelRequest): Promise<ModelResponse> {
    const digest = canonicalDigest(request);
    let next = peek();
    if (next?.type === "ContextCompacted") {
      // A recorded compaction the live code no longer performs here: stale suffix.
      await invalidateFrom(next.seq, "compaction decision changed (code or thresholds)");
      next = peek();
    }
    if (next?.type === "LlmCallStarted" && next.payload.requestDigest !== digest) {
      await invalidateFrom(next.seq, "request digest mismatch (prompt or code changed)");
      next = peek();
    }
    let response: ModelResponse;
    if (next?.type === "LlmCallStarted") {
      const completed = walk[ptr + 1];
      if (completed?.type === "LlmCallCompleted" && completed.payload.stepId === next.payload.stepId) {
        response = completed.payload.response as ModelResponse; // replayed — zero tokens spent
        ptr += 2;
      } else {
        // Crash window: call was issued but the response never landed. Re-issue (at-least-once).
        ptr += 1;
        response = await withSpan("toren.llm", { "gen_ai.request.model": request.model }, () => provider.complete(request));
        await append([ev("LlmCallCompleted", { stepId: next.payload.stepId, response, usage: response.usage })]);
      }
    } else {
      const stepId = `s${head + 1}`;
      await append([ev("LlmCallStarted", { stepId, requestDigest: digest, model: request.model })]);
      response = await withSpan("toren.llm", { "gen_ai.request.model": request.model }, () => provider.complete(request));
      await append([ev("LlmCallCompleted", { stepId, response, usage: response.usage })]);
    }
    if (response.usage) {
      lastUsage = response.usage;
      pendingChars = 0;
      elidedSavingsTokens = 0;
    }
    return response;
  }

  /** Old, large tool results not among the last COMPACT_KEEP_RESULTS and not already stubbed. */
  function elidableTargets(): string[] {
    const hits: { id: string; chars: number }[] = [];
    for (const m of messages) {
      if (m.role !== "user") continue;
      for (const b of m.content) {
        if (b.type === "toolResult" && typeof b.content === "string"
          && b.content.length >= COMPACT_MIN_ELIDE_CHARS && !b.content.startsWith(ELIDE_MARK)) {
          hits.push({ id: b.toolUseId, chars: b.content.length });
        }
      }
    }
    return hits.slice(0, Math.max(0, hits.length - COMPACT_KEEP_RESULTS)).map((h) => h.id);
  }

  function toolNameFor(toolUseId: string): string {
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const b of m.content) if (b.type === "toolUse" && b.id === toolUseId) return b.name;
    }
    return "the tool";
  }

  function applyElide(toolUseIds: unknown): void {
    const ids = new Set(Array.isArray(toolUseIds) ? toolUseIds.map(String) : []);
    for (const m of messages) {
      if (m.role !== "user") continue;
      m.content = m.content.map((b) => {
        if (b.type !== "toolResult" || !ids.has(b.toolUseId) || typeof b.content !== "string") return b;
        const name = toolNameFor(b.toolUseId);
        elidedSavingsTokens += Math.floor(b.content.length / 3);
        return {
          ...b,
          content: `${ELIDE_MARK} earlier ${name} result removed to save context. The full output is preserved in the run's event log; call ${name} again if you need it.]`,
        };
      });
    }
  }

  /** Largest boundary landing on an assistant message, keeping at least COMPACT_KEEP_TAIL recent messages. */
  function summaryBoundary(): number {
    for (let b = messages.length - COMPACT_KEEP_TAIL; b >= 1; b--) {
      if (messages[b]!.role === "assistant") return b;
    }
    return 0;
  }

  function applySummary(payload: Record<string, unknown>): void {
    const keepFrom = Number(payload.keepFrom);
    const summary = String(payload.summary ?? "");
    messages.splice(0, keepFrom, {
      role: "user",
      content: [{
        type: "text",
        text: `[The earlier conversation was compacted to save context. Summary of everything before this point:]\n\n${summary}\n\n[Continue the task from here. The recent messages below are verbatim.]`,
      }],
    });
  }

  /**
   * Compaction pass, run before each model call. Both tiers are recorded events:
   * replay applies the recorded payload by value, so the fold is a pure function
   * of the log and survives prompt, threshold, and code changes.
   */
  async function maybeCompact(): Promise<void> {
    if (!contextWindow || !lastUsage || invalidated) return;

    if (pressure() >= COMPACT_ELIDE_AT * contextWindow) {
      const targets = elidableTargets();
      if (targets.length > 0) {
        const next = peek();
        if (next?.type === "ContextCompacted" && next.payload.kind === "elide") {
          ptr += 1;
          applyElide(next.payload.toolUseIds);
        } else {
          // A differing recorded suffix (older code compacted differently) is
          // voided first; the append then lands after the StreamInvalidated cut.
          if (next) await invalidateFrom(next.seq, "compaction decision changed (code or thresholds)");
          await append([ev("ContextCompacted", { kind: "elide", toolUseIds: targets })]);
          applyElide(targets);
        }
      }
    }

    if (pressure() >= COMPACT_SUMMARY_AT * contextWindow) {
      const keepFrom = summaryBoundary();
      if (keepFrom <= 1) return; // nothing worth folding
      const sumRequest: ModelRequest = {
        model: agent.model,
        system: SUMMARIZE_SYSTEM,
        messages: messages.slice(0, keepFrom),
        tools: specs,
        maxTokens: COMPACT_SUMMARY_MAX_TOKENS,
      };
      const sumResponse = await recordedLlmCall(sumRequest);
      const summary = sumResponse.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text).join("\n");
      const next = peek();
      if (next?.type === "ContextCompacted" && next.payload.kind === "summary") {
        ptr += 1;
        applySummary(next.payload);
      } else {
        if (next) await invalidateFrom(next.seq, "compaction decision changed (code or thresholds)");
        await append([ev("ContextCompacted", { kind: "summary", keepFrom, summary })]);
        applySummary({ keepFrom, summary });
      }
      // The summary replaces the history the trigger measured; usage resets on the next call.
      lastUsage = undefined;
    }
  }

  async function runHandlerAndComplete(def: ToolDefAny, tu: ToolUseBlock, stepId: string): Promise<ContentBlock> {
    let result: string;
    let isError = false;
    try {
      const parsed = def.input.parse(tu.input);
      result = await withSpan("toren.tool", { "toren.tool.name": def.name, "toren.tool.effects": def.effects }, () => def.handler(parsed, { runId, taskId, env: agent.env ?? {} }));
    } catch (e) {
      result = `tool error: ${e instanceof Error ? e.message : String(e)}`;
      isError = true;
    }
    await append([ev("ToolCallCompleted", { stepId, toolUseId: tu.id, result, isError })]);
    return { type: "toolResult", toolUseId: tu.id, content: result, ...(isError ? { isError } : {}) };
  }

  // Replays a recorded execution of this toolUse if the walk holds one; null = nothing recorded.
  async function replayRecordedTool(def: ToolDefAny, tu: ToolUseBlock): Promise<ContentBlock | null> {
    const next = peek();
    if (next?.type !== "ToolCallStarted" || next.payload.toolUseId !== tu.id) return null;
    const completed = walk[ptr + 1];
    if (completed?.type === "ToolCallCompleted" && completed.payload.toolUseId === tu.id) {
      ptr += 2;
      const isError = Boolean(completed.payload.isError);
      return { type: "toolResult", toolUseId: tu.id, content: String(completed.payload.result ?? ""), ...(isError ? { isError } : {}) };
    }
    // Crash window: started, never completed. Keyed tools re-run under the same
    // idempotency key (effectively-once downstream); unkeyed tools are documented at-least-once.
    ptr += 1;
    return runHandlerAndComplete(def, tu, String(next.payload.stepId));
  }

  async function executeToolLive(def: ToolDefAny, tu: ToolUseBlock): Promise<ContentBlock> {
    const recorded = await replayRecordedTool(def, tu);
    if (recorded) return recorded;
    const stepId = `s${head + 1}`;
    const idempotencyKey = canonicalDigest({ runId, taskId, stepId, tool: def.name, args: tu.input });
    await append([ev("ToolCallStarted", { stepId, toolUseId: tu.id, tool: def.name, args: tu.input, idempotencyKey, effects: def.effects })]);
    return runHandlerAndComplete(def, tu, stepId);
  }

  async function execTool(tu: ToolUseBlock): Promise<ContentBlock | "PARKED"> {
    const def = agent.tools.find((t) => t.name === tu.name);
    if (!def) return { type: "toolResult", toolUseId: tu.id, content: `unknown tool: ${tu.name}`, isError: true };

    const next = peek();
    if (next?.type === "ApprovalRequested" && next.payload.toolUseId === tu.id) {
      ptr += 1;
      const res = resolutions.get(String(next.payload.stepId));
      if (!res) return "PARKED"; // still parked; the recorded request stands
      if (!res.granted) {
        return {
          type: "toolResult", toolUseId: tu.id, isError: true,
          content: `denied by ${res.by ?? "operator"}${res.comment ? `: ${res.comment}` : ""}`,
        };
      }
      return executeToolLive(def, tu);
    }

    const recorded = await replayRecordedTool(def, tu);
    if (recorded) return recorded;

    if (needsApproval(def, tu.input)) {
      const stepId = `s${head + 1}`;
      await append([ev("ApprovalRequested", { stepId, toolUseId: tu.id, tool: tu.name, args: tu.input })]);
      return "PARKED";
    }
    return executeToolLive(def, tu);
  }

  while (true) {
    if (++steps > agent.maxSteps) {
      const error = "maxSteps exceeded";
      await append([ev("TaskFailed", { error, willRetry: false })]);
      return { status: "failed", error };
    }

    await maybeCompact();

    const request: ModelRequest = { model: agent.model, system, messages: [...messages], tools: specs, maxTokens: agent.maxTokens };
    const response = await recordedLlmCall(request);

    messages.push({ role: "assistant", content: response.content });

    if (response.stopReason === "toolUse") {
      const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === "toolUse");
      const results: ContentBlock[] = [];
      for (const tu of toolUses) {
        const r = await execTool(tu);
        if (r === "PARKED") return { status: "waitingApproval" };
        results.push(r);
      }
      messages.push({ role: "user", content: results });
      pendingChars += JSON.stringify(results).length;
      continue;
    }

    if (response.stopReason === "refusal") {
      const error = "model refused the request";
      await append([ev("TaskFailed", { error, willRetry: false })]);
      return { status: "failed", error };
    }

    // endTurn / maxTokens → final output
    const text = response.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text).join("\n");

    if (args.sessionMode) {
      // Turn boundary: park awaiting the user (or consume their recorded reply and go again).
      const recInput = peek();
      if (recInput?.type === "InputRequested") {
        ptr += 1;
      } else {
        await append([ev("InputRequested", { text })]);
        return { status: "awaitingInput" };
      }
      const userMsg = peek();
      if (userMsg?.type !== "UserMessage") return { status: "awaitingInput" };
      ptr += 1;
      if (userMsg.payload.close) {
        const recordedClose = peek();
        if (recordedClose?.type === "TaskCompleted") {
          ptr += 1;
          return { status: "completed", output: String(recordedClose.payload.result ?? "") };
        }
        await append([ev("TaskCompleted", { result: text })]);
        return { status: "completed", output: text };
      }
      messages.push({ role: "user", content: [{ type: "text", text: String(userMsg.payload.text ?? "") }] });
      pendingChars += String(userMsg.payload.text ?? "").length;
      steps = 0; // each user turn gets a fresh step budget
      continue;
    }

    if (agent.outputSchema) {
      try {
        agent.outputSchema.parse(JSON.parse(text));
      } catch (e) {
        messages.push({
          role: "user",
          content: [{ type: "text", text: `Your final answer failed output validation: ${e instanceof Error ? e.message : String(e)}. Reply with a corrected final answer only.` }],
        });
        continue;
      }
    }

    const recordedDone = peek();
    if (recordedDone?.type === "TaskCompleted") {
      ptr += 1;
      return { status: "completed", output: String(recordedDone.payload.result ?? "") };
    }
    await append([ev("TaskCompleted", { result: text })]);
    return { status: "completed", output: text };
  }
}
