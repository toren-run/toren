import { randomUUID } from "node:crypto";
import { effectiveEvents } from "./fold.js";
import { ev } from "./events.js";
import type { PgStateStore } from "./store.js";
import type { QueueAdapter } from "./queue.js";
import type { PgLeases } from "./leases.js";
import type { ModelProvider } from "./model.js";
import type { AgentSpec } from "./loop.js";
import { withSpan } from "./tracing.js";
import {
  createWorkflowCtx, foldRunStream, makeSession,
  RunLeaseLostError, WaveFailedError, WorkflowBlocked,
  type WorkflowFn,
} from "./workflow.js";

export interface TickDeps {
  store: PgStateStore;
  queue: QueueAdapter;
  leases: PgLeases;
  provider: ModelProvider;
  agents: Record<string, AgentSpec>;
  workflows: Record<string, WorkflowFn>;
}

export type TickResult = "leased" | "terminal" | "blocked" | "completed" | "failed";

const SESSION_WORKFLOW: WorkflowFn = async (ctx) => {
  const w = await ctx.wave("session", [ctx.task("main", ctx.input)]);
  return w.results[0]?.output ?? "";
};

export async function startRun(deps: TickDeps, req: { agent: string; input: string; runId?: string; mode?: "task" | "session" }): Promise<string> {
  const runId = req.runId ?? randomUUID();
  await deps.store.createRun({ runId, agent: req.agent, input: req.input, mode: req.mode });
  const r = await deps.store.append(runId, "run", 0, [ev("RunCreated", { agent: req.agent, input: req.input })]);
  if (!r.ok) throw new Error("fresh run stream was not empty");
  await deps.queue.send("orchestrator", { kind: "tick", runId, agent: req.agent, dedupeKey: `start-${runId}` });
  return runId;
}

export async function tick(deps: TickDeps, runId: string): Promise<TickResult> {
  return withSpan("toren.run.tick", { "toren.run_id": runId }, () => tickImpl(deps, runId));
}

async function tickImpl(deps: TickDeps, runId: string): Promise<TickResult> {
  const lease = await deps.leases.acquire(runId, "run", `orch-${randomUUID()}`, 60);
  if (!lease) return "leased";

  try {
    const run = await deps.store.getRun(runId);
    if (!run) return "terminal";
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return "terminal";

    // Sessions always converse with the crew's root agent through the
    // implicit single-task workflow. A crew's custom batch workflow (which
    // may parse structured input, fan out waves, etc.) never sees a chat.
    const workflow = run.mode === "session" ? SESSION_WORKFLOW : deps.workflows[run.agent];
    if (!workflow) throw new Error(`no workflow registered for agent ${run.agent}`);

    let raw = await deps.store.read(runId, "run");
    let head = raw.at(-1)?.seq ?? 0;
    let eff = effectiveEvents(raw);
    let folded = foldRunStream(eff);

    if (folded.terminal) {
      await deps.store.updateRun(runId, { status: folded.terminal.status, output: folded.terminal.output, error: folded.terminal.error });
      return "terminal";
    }

    const appendRun = async (events: Parameters<PgStateStore["append"]>[3]) => {
      const r = await deps.store.append(runId, "run", head, events);
      if (!r.ok) throw new RunLeaseLostError("run stream advanced concurrently");
      head = r.lastSeq;
    };

    if (!folded.started) await appendRun([ev("RunStarted", {})]);

    // Absorb task terminal states into the run stream;
    // track parked tasks so waves don't re-nudge work waiting on a human.
    const parkedTasks = new Set<string>();
    for (const w of folded.waves) {
      if (w.settled) continue;
      for (const t of w.tasks) {
        if (w.settledTasks.has(t.taskId)) continue;
        const taskEff = effectiveEvents(await deps.store.read(runId, `task:${t.taskId}`));
        const completed = taskEff.find((e) => e.type === "TaskCompleted");
        const failed = taskEff.find((e) => e.type === "TaskFailed" && !e.payload.willRetry);
        if (completed) {
          await appendRun([ev("WaveTaskSettled", { waveId: w.waveId, taskId: t.taskId, status: "completed", output: completed.payload.result })]);
        } else if (failed) {
          await appendRun([ev("WaveTaskSettled", { waveId: w.waveId, taskId: t.taskId, status: "failed", error: failed.payload.error })]);
        } else {
          const resolved = new Set(taskEff.filter((e) => e.type === "ApprovalResolved").map((e) => String(e.payload.stepId)));
          const parkedOnApproval = taskEff.some((e) => e.type === "ApprovalRequested" && !resolved.has(String(e.payload.stepId)));
          // Sessions park at the turn boundary: an InputRequested with no
          // later UserMessage means the agent is waiting for a human.
          let lastInputSeq = 0, lastUserSeq = 0;
          for (const e of taskEff) {
            if (e.type === "InputRequested") lastInputSeq = e.seq;
            else if (e.type === "UserMessage") lastUserSeq = e.seq;
          }
          const parkedOnInput = lastInputSeq > 0 && lastUserSeq < lastInputSeq;
          if (parkedOnApproval || parkedOnInput) parkedTasks.add(t.taskId);
        }
      }
    }

    // Re-read so the workflow sees absorbed settlements.
    raw = await deps.store.read(runId, "run");
    eff = effectiveEvents(raw);
    const session = makeSession(deps.store, runId, String(run.input ?? ""), raw, eff, parkedTasks);
    const ctx = createWorkflowCtx(session);

    const flush = async () => {
      for (const d of session.pendingDispatch) {
        await deps.queue.send(d.queue, { ...d.msg, agent: run.agent }, { delaySeconds: d.delaySeconds });
      }
      session.pendingDispatch = [];
    };

    try {
      const output = await workflow(ctx);
      const r = await deps.store.append(runId, "run", session.head, [ev("RunCompleted", { output })]);
      if (!r.ok) throw new RunLeaseLostError("run stream advanced concurrently");
      await deps.store.updateRun(runId, { status: "completed", output });
      await flush();
      return "completed";
    } catch (e) {
      if (e instanceof WorkflowBlocked) {
        await flush();
        await deps.store.updateRun(runId, { status: "running" });
        return "blocked";
      }
      if (e instanceof RunLeaseLostError) throw e;
      const error = e instanceof WaveFailedError ? e.message : `workflow error: ${e instanceof Error ? e.message : String(e)}`;
      const r = await deps.store.append(runId, "run", session.head, [ev("RunFailed", { error })]);
      if (r.ok) await deps.store.updateRun(runId, { status: "failed", error });
      await flush();
      return "failed";
    }
  } finally {
    await deps.leases.release(lease);
  }
}

/** Locates a planned task's spec by scanning the run stream (workers use this). */
export async function findTaskSpec(store: PgStateStore, runId: string, taskId: string): Promise<{ agentRef: string; input: string } | null> {
  const eff = effectiveEvents(await store.read(runId, "run"));
  for (const e of eff) {
    if (e.type !== "WavePlanned") continue;
    const tasks = e.payload.tasks as { taskId: string; agentRef: string; input: string }[];
    const hit = tasks.find((t) => t.taskId === taskId);
    if (hit) return { agentRef: hit.agentRef, input: hit.input };
  }
  return null;
}
