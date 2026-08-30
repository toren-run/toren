import { createHash } from "node:crypto";
import type pg from "pg";
import { effectiveEvents } from "./fold.js";
import { startRun, type TickDeps } from "./orchestrator.js";
import { sendSessionMessage, SessionBusyError } from "./conversations.js";
import { foldRunStream } from "./workflow.js";
import type { AgentCallsCtx, ProcessesCtx } from "./tools.js";

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
        `INSERT INTO toren_control.run_watchers (child_run_id, parent_run_id, agent, parent_agent, process)
         VALUES ($1, $2, $3, $3, $4) ON CONFLICT DO NOTHING`,
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


/**
 * Cross-agent calls (beta): the spawn arc pointed at a consenting peer. The
 * child run lives in the CALLEE's schema under the callee's privileges; the
 * caller receives only the output, delivered by the same watcher wake that
 * serves run_process. Consent edges arrive pre-resolved from the fleet
 * runtime (caller's can_call ∩ callee's accept_from) — this facet enforces
 * them again at call time so a stale config can never widen access.
 */
/** Beta guardrails: a call chain deeper than this is refused (A→B→A ping-pong), and one run may place at most this many calls. Both bound the blast radius of a looping model; neither is configurable yet — tell us if a real workflow hits them. */
export const MAX_CALL_DEPTH = 4;
export const MAX_CALLS_PER_RUN = 25;

/** How many watcher hops sit above this run — i.e. how deep in a call/spawn chain it already is. */
async function chainDepth(pool: pg.Pool, runId: string): Promise<number> {
  const { rows } = await pool.query(
    `WITH RECURSIVE up AS (
       SELECT parent_run_id, 1 AS depth FROM toren_control.run_watchers WHERE child_run_id = $1
       UNION ALL
       SELECT w.parent_run_id, up.depth + 1 FROM toren_control.run_watchers w
         JOIN up ON w.child_run_id = up.parent_run_id
       WHERE up.depth < 16
     ) SELECT COALESCE(MAX(depth), 0) AS depth FROM up`,
    [runId],
  );
  return Number(rows[0]?.depth ?? 0);
}

export function makeAgentCallsFacet(
  pool: pg.Pool,
  callerName: string,
  byAgent: Record<string, TickDeps>,
  edges: { callable: string[]; defaultProcess: Record<string, string | undefined> },
): AgentCallsCtx {
  return {
    callable: [...edges.callable],

    async call(req) {
      if (!edges.callable.includes(req.agent)) {
        throw new Error(`call_agent: "${req.agent}" is not callable from ${callerName} (callable: ${edges.callable.join(", ") || "none"} — both sides must consent in agent.yaml)`);
      }
      const target = byAgent[req.agent];
      if (!target) throw new Error(`call_agent: agent "${req.agent}" is not served by this deployment`);
      const process = req.process ?? edges.defaultProcess[req.agent] ?? "main";
      if (!target.workflows[process]) {
        throw new Error(`call_agent: no process "${process}" on ${req.agent} (has: ${Object.keys(target.workflows).join(", ")})`);
      }
      const runId = deterministicRunId(`call:${req.parentRunId}:${req.parentTaskId}:${req.toolUseId}`);
      // Loop guards. Checked before the insert so a refused call leaves no watcher row;
      // the existing-child check below keeps crash replays of an ACCEPTED call exempt.
      if (!(await byAgent[req.agent]!.store.getRun(runId))) {
        const depth = await chainDepth(pool, req.parentRunId);
        if (depth >= MAX_CALL_DEPTH) {
          throw new Error(`call_agent: refused — this run is already ${depth} calls deep (limit ${MAX_CALL_DEPTH}). A call chain this deep is usually two agents ping-ponging; answer with what you have.`);
        }
        const { rows: cnt } = await pool.query(
          `SELECT count(*) AS n FROM toren_control.run_watchers WHERE parent_run_id = $1 AND parent_agent = $2`,
          [req.parentRunId, callerName],
        );
        if (Number(cnt[0]?.n ?? 0) >= MAX_CALLS_PER_RUN) {
          throw new Error(`call_agent: refused — this run has already placed ${MAX_CALLS_PER_RUN} calls. Answer with what you have.`);
        }
      }
      await pool.query(
        `INSERT INTO toren_control.run_watchers (child_run_id, parent_run_id, agent, parent_agent, process)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [runId, req.parentRunId, req.agent, callerName, process],
      );
      if (await target.store.getRun(runId)) return { runId, agent: req.agent, started: false };
      await startRun(target, { agent: req.agent, input: req.input, process, runId, channel: `agent:${callerName}` });
      return { runId, agent: req.agent, started: true };
    },

    async status(runId) {
      for (const name of edges.callable) {
        const target = byAgent[name];
        if (!target) continue;
        const run = await target.store.getRun(runId);
        if (!run) continue;
        const cap = (v: unknown) => (v == null ? undefined : String(v).slice(0, 4000));
        return {
          runId, agent: name, process: run.process, status: run.status,
          ...(run.output != null ? { output: cap(run.output) } : {}),
          ...(run.error != null ? { error: cap(run.error) } : {}),
        };
      }
      return null;
    },
  };
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function wakeText(child: { runId: string; process: string; status: string; output: unknown; error: unknown }, fromAgent?: string): string {
  const trim = (v: unknown) => { const s = String(v ?? ""); return s.length > 1500 ? `${s.slice(0, 1500)} …[truncated]` : s; };
  const label = fromAgent ? `[reply from ${fromAgent}]` : `[background run] process "${child.process}"`;
  return child.status === "completed"
    ? `${label} (run ${child.runId}) finished:\n${trim(child.output)}`
    : `${label} (run ${child.runId}) ${child.status.toUpperCase()}: ${trim(child.error)}`;
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
    const parentDeps = byAgent[String(w.parent_agent ?? w.agent)];
    if (!deps || !parentDeps) continue;
    const childId = String(w.child_run_id);
    const child = await deps.store.getRun(childId);
    if (!child) {
      // Crash before the child run was created and the parent never replayed.
      if (Date.now() - (w.created_at as Date).getTime() > ORPHAN_GRACE_MS) await settle(childId);
      continue;
    }
    if (!TERMINAL.has(child.status)) continue;
    const parent = await parentDeps.store.getRun(String(w.parent_run_id));
    if (!parent || parent.mode !== "session" || TERMINAL.has(parent.status)) {
      // Nothing to wake: check_run remains the pull path for batch parents.
      await settle(childId);
      continue;
    }
    try {
      const crossAgent = w.parent_agent != null && String(w.parent_agent) !== String(w.agent);
      await sendSessionMessage(parentDeps, String(w.parent_run_id), { text: wakeText(child, crossAgent ? String(w.agent) : undefined), channel: "watcher" });
      await settle(childId);
      woken += 1;
    } catch (e) {
      if (e instanceof SessionBusyError) continue; // mid-turn — the next sweep delivers
      continue; // transient (DB flap, racing close) — retry next sweep
    }
  }
  return woken;
}
