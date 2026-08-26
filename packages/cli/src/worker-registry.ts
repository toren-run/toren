import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import type pg from "pg";

/**
 * The fleet's sign-in sheet: every worker writes "I'm here, I'm version X"
 * on each sweep tick. Two live versions against one database is legal for
 * the minutes of a rolling deploy and a trap when it persists (containers
 * share toren_control, which the newest one migrates at boot), so skew is
 * detected and reported — loudly in the log on transition, again every few
 * minutes while it lasts, and continuously in /healthz. Detection, not
 * enforcement: blocking on mismatch would break every rolling deploy.
 */

/** A worker unseen this long is treated as gone (crashed or stopped). */
const LIVE_WINDOW_MS = 60_000;
/** Rows this stale get deleted opportunistically. */
const REAP_AFTER_MS = 60 * 60_000;
/** While skew persists, remind at this cadence rather than only once. */
const REMIND_MS = 5 * 60_000;

export interface WorkerRegistryStatus {
  workerId: string;
  version: string;
  /** Distinct versions among workers seen in the last minute. */
  liveVersions: string[];
  versionSkew: boolean;
  liveWorkers: { workerId: string; version: string; hostname: string | null; startedAt: string; lastSeenAt: string }[];
}

export class WorkerRegistry {
  readonly workerId: string;
  private skewed = false;
  private lastRemindAt = 0;
  private st: WorkerRegistryStatus;

  constructor(
    private pool: pg.Pool,
    private version: string,
    private log: (line: string) => void = console.log,
  ) {
    this.workerId = `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
    this.st = { workerId: this.workerId, version, liveVersions: [version], versionSkew: false, liveWorkers: [] };
  }

  status(): WorkerRegistryStatus { return { ...this.st, liveVersions: [...this.st.liveVersions], liveWorkers: [...this.st.liveWorkers] }; }

  /** Sign in (or refresh), then look at who else is signed in. Called every sweep tick. */
  async tick(): Promise<void> {
    await this.pool.query(
      `INSERT INTO toren_control.workers (worker_id, version, hostname, last_seen_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = now()`,
      [this.workerId, this.version, hostname()],
    );
    await this.pool.query(
      `DELETE FROM toren_control.workers WHERE last_seen_at < now() - make_interval(secs => $1)`,
      [REAP_AFTER_MS / 1000],
    );
    const { rows } = await this.pool.query<{ worker_id: string; version: string; hostname: string | null; started_at: Date; last_seen_at: Date }>(
      `SELECT worker_id, version, hostname, started_at, last_seen_at FROM toren_control.workers
       WHERE last_seen_at > now() - make_interval(secs => $1) ORDER BY started_at`,
      [LIVE_WINDOW_MS / 1000],
    );
    this.st.liveWorkers = rows.map((r) => ({
      workerId: r.worker_id, version: r.version, hostname: r.hostname,
      startedAt: r.started_at.toISOString(), lastSeenAt: r.last_seen_at.toISOString(),
    }));
    this.st.liveVersions = [...new Set(rows.map((r) => r.version))].sort();
    this.st.versionSkew = this.st.liveVersions.length > 1;

    const now = Date.now();
    if (this.st.versionSkew && (!this.skewed || now - this.lastRemindAt > REMIND_MS)) {
      this.log(`toren: version skew — ${this.st.liveVersions.join(" and ")} are both live against this database. Fine mid-deploy; if it persists, one deployment missed its upgrade (see /healthz workers).`);
      this.lastRemindAt = now;
    } else if (!this.st.versionSkew && this.skewed) {
      this.log(`toren: version skew cleared — all live workers on ${this.st.liveVersions[0]}`);
    }
    this.skewed = this.st.versionSkew;
  }

  /** Sign out on clean shutdown so a stopped worker doesn't linger for the live window. */
  async stop(): Promise<void> {
    await this.pool.query(`DELETE FROM toren_control.workers WHERE worker_id = $1`, [this.workerId]).catch(() => { /* shutdown path — best effort */ });
  }
}
