import { createHash } from "node:crypto";
import type pg from "pg";
import { effectiveEvents } from "./fold.js";
import { startRun, type TickDeps } from "./orchestrator.js";
import { sendSessionMessage, SessionBusyError } from "./conversations.js";
import { foldRunStream } from "./workflow.js";
import type { ProcessesCtx } from "./tools.js";

/**
 * The spawn arc: a conversation triggers a named process as a background run,
 * and the runtime messages the user when it settles.
 *
 * Spawning is effectively-once: the child runId derives deterministically from
 * (parent run, task, toolUseId), so the crash-window re-run of the keyed tool
 * finds the child already exists. The watcher row is written BEFORE the child
 * run so no settlement can slip between the two; an orphaned watcher (crash
 * before the child was created, run abandoned) settles after a grace period.
 *
 * The wake reuses the session machinery wholesale: sweepWatchers appends a
 * normal UserMessage (channel "watcher") via sendSessionMessage, so strict
 * turn-taking holds — a mid-turn session throws SessionBusyError and the wake
 * lands on a later sweep — and every channel delivers the agent's reply like
 * any other turn.
 */

const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/** Deterministic uuid (v4 shape) from a key — same key, same run. */
export function deterministicRunId(key: string): string {
  const h = createHash("sha256").update(key).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function makeProcessesFacet(
  pool: pg.Pool,
  agentName: string,
  deps: TickDeps,
  opts: { defaultProcess?: string } = {},
): ProcessesCtx {
  return {
    get names() { return Object.keys(deps.workflows); },
    defaultProcess: opts.defaultProcess,

    async start(req) {
      if (!deps.workflows[req.process]) {
        throw new Error(`no process "${req.process}" for ${agentName} (has: ${Object.keys(deps.workflows).join(", ")})`);
      }
      const runId = deterministicRunId(`spawn:${req.parentRunId}:${req.parentTaskId}:${req.toolUseId}`);
      await pool.query(
        `INSERT INTO toren_control.run_watchers (child_run_id, parent_run_id, agent, process)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [runId, req.parentRunId, agentName, req.process],
      );
      if (await deps.store.getRun(runId)) return { runId, started: false };
      await startRun(deps, { agent: agentName, input: req.input, process: req.process, runId });
      return { runId, started: true };
    },

    async status(runId) {
      const run = await deps.store.getRun(runId);
      if (!run) return null;
      const folded = foldRunStream(effectiveEvents(await deps.store.read(runId, "run")));
      const cap = (v: unknown) => (v == null ? undefined : String(v).slice(0, 4000));
      return {
        runId, process: run.process, status: run.status,
        ...(run.output != null ? { output: cap(run.output) } : {}),
        ...(run.error != null ? { error: cap(run.error) } : {}),
        waves: folded.waves.map((w) => ({ name: w.name, tasks: w.tasks.length, settled: w.settledTasks.size, done: w.settled })),
      };
    },
  };
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function wakeText(child: { runId: string; process: string; status: string; output: unknown; error: unknown }): string {
  const trim = (v: unknown) => { const s = String(v ?? ""); return s.length > 1500 ? `${s.slice(0, 1500)} …[truncated]` : s; };
  return child.status === "completed"
    ? `[background run] process "${child.process}" (run ${child.runId}) finished:\n${trim(child.output)}`
    : `[background run] process "${child.process}" (run ${child.runId}) ${child.status.toUpperCase()}: ${trim(child.error)}`;
}

/**
 * One sweep pass: wake every session whose watched child has settled. Safe to
 * run concurrently from any number of workers (the wake path CAS-es on the
 * session stream via sendSessionMessage). Returns the number of wakes delivered.
 */
export async function sweepWatchers(pool: pg.Pool, byAgent: Record<string, TickDeps>): Promise<number> {
  const agents = Object.keys(byAgent);
  if (agents.length === 0) return 0;
  const settle = (childRunId: string) =>
    pool.query(`UPDATE toren_control.run_watchers SET settled = true WHERE child_run_id = $1`, [childRunId]);

  const { rows } = await pool.query(
    `SELECT * FROM toren_control.run_watchers WHERE NOT settled AND agent = ANY($1)`,
    [agents],
  );
  let woken = 0;
  for (const w of rows) {
    const deps = byAgent[String(w.agent)];
    if (!deps) continue;
    const childId = String(w.child_run_id);
    const child = await deps.store.getRun(childId);
    if (!child) {
      // Crash before the child run was created and the parent never replayed.
      if (Date.now() - (w.created_at as Date).getTime() > ORPHAN_GRACE_MS) await settle(childId);
      continue;
    }
    if (!TERMINAL.has(child.status)) continue;
    const parent = await deps.store.getRun(String(w.parent_run_id));
    if (!parent || parent.mode !== "session" || TERMINAL.has(parent.status)) {
      // Nothing to wake: check_run remains the pull path for batch parents.
      await settle(childId);
      continue;
    }
    try {
      await sendSessionMessage(deps, String(w.parent_run_id), { text: wakeText(child), channel: "watcher" });
      await settle(childId);
      woken += 1;
    } catch (e) {
      if (e instanceof SessionBusyError) continue; // mid-turn — the next sweep delivers
      continue; // transient (DB flap, racing close) — retry next sweep
    }
  }
  return woken;
}
