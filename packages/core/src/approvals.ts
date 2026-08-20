import { effectiveEvents } from "./fold.js";
import type { PgStateStore } from "./store.js";
import type { QueueAdapter } from "./queue.js";
import type { PgLeases } from "./leases.js";
import type { StreamId } from "./events.js";

export interface PendingApproval {
  runId: string;
  taskId: string;
  stepId: string;
  tool: string;
  args: unknown;
}

/** Unresolved ApprovalRequested events across non-terminal runs (or one run). */
export async function listPendingApprovals(store: PgStateStore, runId?: string): Promise<PendingApproval[]> {
  const runIds = runId ? [runId] : await store.listNonTerminalRuns();
  const pending: PendingApproval[] = [];
  for (const rid of runIds) {
    const runEff = effectiveEvents(await store.read(rid, "run"));
    const taskIds = runEff
      .filter((e) => e.type === "WavePlanned")
      .flatMap((e) => (e.payload.tasks as { taskId: string }[]).map((t) => t.taskId));
    for (const taskId of taskIds) {
      const eff = effectiveEvents(await store.read(rid, `task:${taskId}`));
      const resolved = new Set(
        eff.filter((e) => e.type === "ApprovalResolved").map((e) => String(e.payload.stepId)),
      );
      for (const e of eff) {
        if (e.type === "ApprovalRequested" && !resolved.has(String(e.payload.stepId))) {
          pending.push({
            runId: rid, taskId,
            stepId: String(e.payload.stepId),
            tool: String(e.payload.tool),
            args: e.payload.args,
          });
        }
      }
    }
  }
  return pending;
}

export interface ResolveApprovalDeps { store: PgStateStore; leases: PgLeases; queue: QueueAdapter }
export interface ResolveApprovalReq {
  runId: string; taskId: string; stepId: string;
  granted: boolean; by: string; comment?: string;
}

/**
 * Append ApprovalResolved to the parked task's stream (taking its lease
 * briefly) and nudge the orchestrator so the run resumes.
 */
export async function resolveApproval(deps: ResolveApprovalDeps, req: ResolveApprovalReq): Promise<void> {
  const streamId: StreamId = `task:${req.taskId}`;
  const lease = await deps.leases.acquire(req.runId, streamId, `approvals-${req.by}`, 30);
  if (!lease) throw new Error(`task ${req.taskId} is currently leased — is a worker still running it?`);
  try {
    const raw = await deps.store.read(req.runId, streamId);
    const head = raw.at(-1)?.seq ?? 0;
    const r = await deps.store.append(req.runId, streamId, head, [
      {
        type: "ApprovalResolved",
        payload: { v: 1, stepId: req.stepId, granted: req.granted, by: req.by, comment: req.comment },
      },
    ]);
    if (!r.ok) throw new Error("task stream advanced concurrently; retry the approval");
  } finally {
    await deps.leases.release(lease);
  }
  // Wake the task, then the orchestrator will absorb the outcome.
  await deps.queue.send("tasks-short", { kind: "task", runId: req.runId, taskId: req.taskId, dedupeKey: `approve-${req.taskId}-${req.stepId}` });
}
