import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type pg from "pg";
import type { TickDeps } from "@toren-run/core";

const exec = promisify(execFile);

/**
 * The sandbox janitor. A worker that dies uncleanly (kill -9, OOM, deploy)
 * never reaches its sandbox teardown, so docker containers named
 * toren-sbx-<runId> outlive their runs indefinitely. This sweep collects them:
 *
 * - A container whose run is terminal (completed/failed/cancelled) is removed.
 * - A container whose run this deployment doesn't know is removed only once
 *   it is old (another deployment on the same docker host may own it — but a
 *   day-old unknown is a corpse on any reasonable reading).
 * - A container whose run is live is left alone, parked or not.
 *
 * Wrongly removing a live run's container costs one container start on its
 * next tool call, never data: the workspace directory is the durable part and
 * ensure() recreates the container around it on demand. Workspace directories
 * themselves are never touched — they can hold artifacts.
 *
 * E2B sandboxes expire server-side on their own; their crash-orphaned rows in
 * toren_control.sandboxes are deleted here so the table reflects reality.
 */

/** Unknown-run containers younger than this are presumed to belong to someone else's live run. */
const UNKNOWN_MIN_AGE_MS = 24 * 60 * 60_000;

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export interface SandboxReaperOpts {
  /** Injectable for tests: (args) => stdout. Defaults to the real docker CLI. */
  docker?: (args: string[]) => Promise<string>;
  log?: (line: string) => void;
  unknownMinAgeMs?: number;
}

async function findRunStatus(byAgent: Record<string, TickDeps>, runId: string): Promise<string | null> {
  for (const deps of Object.values(byAgent)) {
    const run = await deps.store.getRun(runId).catch(() => null);
    if (run) return run.status;
  }
  return null;
}

export async function sweepSandboxes(
  pool: pg.Pool,
  byAgent: Record<string, TickDeps>,
  opts: SandboxReaperOpts = {},
): Promise<void> {
  const docker = opts.docker ?? (async (args: string[]) => (await exec("docker", args)).stdout);
  const log = opts.log ?? (() => {});
  const minAge = opts.unknownMinAgeMs ?? UNKNOWN_MIN_AGE_MS;

  // Docker containers, discovered by label. No docker on this host → nothing to reap.
  let names: string[] = [];
  try {
    const out = await docker(["ps", "--filter", "label=toren-sandbox=1", "--format", "{{.Names}}"]);
    names = out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { /* docker absent or daemon down — this deployment has no docker sandboxes to reap */ }

  for (const name of names) {
    const runId = name.replace(/^toren-sbx-/, "");
    if (runId === name) continue; // not ours, despite the label
    const status = await findRunStatus(byAgent, runId);
    if (status !== null && !TERMINAL.has(status)) continue; // live run — leave it
    if (status === null) {
      // Unknown run: possibly another deployment's. Only collect the old.
      try {
        const created = await docker(["inspect", "-f", "{{.Created}}", name]);
        if (Date.now() - new Date(created.trim()).getTime() < minAge) continue;
      } catch { continue; /* vanished between ps and inspect */ }
    }
    try {
      await docker(["rm", "-f", name]);
      log(`toren sandbox: reaped ${name} (${status === null ? "unknown run, aged out" : `run ${status}`})`);
    } catch { /* vanished or busy — next sweep retries */ }
  }

  // E2B rows whose runs are over: the sandbox itself expires server-side; the row shouldn't outlive it.
  const { rows } = await pool.query<{ run_id: string }>(
    "SELECT run_id FROM toren_control.sandboxes WHERE provider = 'e2b'",
  );
  for (const r of rows) {
    const status = await findRunStatus(byAgent, r.run_id);
    if (status !== null && !TERMINAL.has(status)) continue;
    await pool.query("DELETE FROM toren_control.sandboxes WHERE run_id = $1", [r.run_id]);
  }
}
