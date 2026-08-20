import type { z } from "zod";
import { canonicalDigest } from "./digest.js";
import { effectiveEvents } from "./fold.js";
import { ev, type NewEvent, type RecordedEvent, type StreamId } from "./events.js";
import { needsApproval, toolSpecs, type ToolDefAny } from "./tools.js";
import type { ChatMessage, ContentBlock, ModelProvider, ModelRequest, ModelResponse } from "./model.js";
import type { PgStateStore } from "./store.js";
import { withSpan } from "./tracing.js";

export class TaskLeaseLostError extends Error {}

export interface AgentSpec {
  model: string;
  system: string;
  tools: ToolDefAny[];
  maxTokens: number;
  maxSteps: number;
  outputSchema?: z.ZodTypeAny;
  /** Declared env values (from agent.yaml `env:`) passed to tool handlers as ctx.env. */
  env?: Record<string, string>;
}

export interface TaskLoopArgs {
  store: PgStateStore;
  provider: ModelProvider;
  runId: string;
  taskId: string;
  agent: AgentSpec;
  input: string;
}

export type TaskLoopResult =
  | { status: "completed"; output: string }
  | { status: "waitingApproval" }
  | { status: "failed"; error: string };

type ToolUseBlock = Extract<ContentBlock, { type: "toolUse" }>;

// Events the loop itself emits in execution order; replay walks these.
const WALK_TYPES = new Set([
  "LlmCallStarted", "LlmCallCompleted",
  "ToolCallStarted", "ToolCallCompleted",
  "ApprovalRequested", "TaskCompleted",
]);

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

  async function invalidateFrom(fromSeq: number, reason: string): Promise<void> {
    await append([ev("StreamInvalidated", { fromSeq, reason })]);
    invalidated = true;
  }

  const attempt = raw.filter((e) => e.type === "TaskStarted").length + 1;
  await append([ev("TaskStarted", { attempt })]);

  const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: args.input }] }];
  const specs = toolSpecs(agent.tools);
  let steps = 0;

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

    const request: ModelRequest = { model: agent.model, system: agent.system, messages: [...messages], tools: specs, maxTokens: agent.maxTokens };
    const digest = canonicalDigest(request);

    let response: ModelResponse;
    const next = peek();
    if (next?.type === "LlmCallStarted") {
      if (next.payload.requestDigest !== digest) {
        await invalidateFrom(next.seq, "request digest mismatch (prompt or code changed)");
        continue;
      }
      const completed = walk[ptr + 1];
      if (completed?.type === "LlmCallCompleted" && completed.payload.stepId === next.payload.stepId) {
        response = completed.payload.response as ModelResponse; // replayed — zero tokens spent
        ptr += 2;
      } else {
        // Crash window: call was issued but the response never landed. Re-issue (at-least-once, spec §6.2).
        ptr += 1;
        response = await withSpan("toren.llm", { "gen_ai.request.model": agent.model }, () => provider.complete(request));
        await append([ev("LlmCallCompleted", { stepId: next.payload.stepId, response, usage: response.usage })]);
      }
    } else {
      const stepId = `s${head + 1}`;
      await append([ev("LlmCallStarted", { stepId, requestDigest: digest, model: agent.model })]);
      response = await withSpan("toren.llm", { "gen_ai.request.model": agent.model }, () => provider.complete(request));
      await append([ev("LlmCallCompleted", { stepId, response, usage: response.usage })]);
    }

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
