import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type pg from "pg";
import { startRun, type TickDeps } from "./orchestrator.js";

/**
 * Cron schedules with exactly-once firing. Schedules live in Postgres — no
 * process ever holds a timer, so nothing is lost when processes die. Firing
 * is two-phase, mirroring the hints-not-truth discipline:
 *
 *   Phase A (one transaction): claim due schedules (FOR UPDATE SKIP LOCKED),
 *   advance next_fire_at, and insert a fire record keyed (schedule, moment)
 *   carrying a pre-assigned run id. Commit. The fire record is now truth.
 *
 *   Phase B (idempotent): for every unsettled fire record, ensure its run
 *   exists (create is a no-op if a racing worker won), nudge the queue, and
 *   mark the fire settled.
 *
 * Any crash between any two writes is healed by the next sweep: no missed
 * fires, no duplicate runs — proven by the schedule kill-matrix test.
 */

export interface ScheduleRecord {
  id: string;
  agent: string;
  name: string;
  cron: string;
  tz: string;
  input: string;
  enabled: boolean;
  nextFireAt: Date;
  lastFiredAt: Date | null;
  createdAt: Date;
}

const row = (r: Record<string, unknown>): ScheduleRecord => ({
  id: String(r.id),
  agent: String(r.agent),
  name: String(r.name),
  cron: String(r.cron),
  tz: String(r.tz),
  input: String(r.input),
  enabled: Boolean(r.enabled),
  nextFireAt: r.next_fire_at as Date,
  lastFiredAt: (r.last_fired_at as Date | null) ?? null,
  createdAt: r.created_at as Date,
});

/** Next occurrence strictly after `after`. Throws on an invalid expression or timezone. */
export function nextFire(cron: string, tz: string, after: Date = new Date()): Date {
  const next = new Cron(cron, { timezone: tz }).nextRun(after);
  if (!next) throw new Error(`cron "${cron}" has no future occurrences`);
  return next;
}

export async function createSchedule(
  pool: pg.Pool,
  req: { agent: string; name: string; cron: string; input: string; tz?: string },
): Promise<ScheduleRecord> {
  const tz = req.tz ?? "UTC";
  const first = nextFire(req.cron, tz); // validates expression + tz
  const res = await pool.query(
    `INSERT INTO toren_control.schedules (id, agent, name, cron, tz, input, next_fire_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [randomUUID(), req.agent, req.name, req.cron, tz, req.input, first],
  );
  return row(res.rows[0]);
}

export async function listSchedules(pool: pg.Pool, agents?: string[]): Promise<ScheduleRecord[]> {
  const res = await pool.query(
    `SELECT * FROM toren_control.schedules
     WHERE ($1::text[] IS NULL OR agent = ANY($1))
     ORDER BY created_at DESC`,
    [agents ?? null],
  );
  return res.rows.map(row);
}

/** Pausing keeps the row; resuming recomputes next_fire_at from now (no surprise catch-up burst). */
export async function setScheduleEnabled(pool: pg.Pool, id: string, enabled: boolean): Promise<boolean> {
  if (!enabled) {
    const res = await pool.query(`UPDATE toren_control.schedules SET enabled = false WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }
  const cur = await pool.query(`SELECT cron, tz FROM toren_control.schedules WHERE id = $1`, [id]);
  if (!cur.rows[0]) return false;
  const next = nextFire(String(cur.rows[0].cron), String(cur.rows[0].tz));
  const res = await pool.query(
    `UPDATE toren_control.schedules SET enabled = true, next_fire_at = $2 WHERE id = $1`,
    [id, next],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function deleteSchedule(pool: pg.Pool, id: string): Promise<boolean> {
  const res = await pool.query(`DELETE FROM toren_control.schedules WHERE id = $1`, [id]);
  return (res.rowCount ?? 0) > 0;
}

export interface FireRecord {
  scheduleId: string;
  scheduledFor: Date;
  runId: string;
  agent: string;
  firedAt: Date;
  settled: boolean;
}

export async function listFires(pool: pg.Pool, scheduleId: string, limit = 20): Promise<FireRecord[]> {
  const res = await pool.query(
    `SELECT * FROM toren_control.schedule_fires WHERE schedule_id = $1 ORDER BY scheduled_for DESC LIMIT $2`,
    [scheduleId, limit],
  );
  return res.rows.map((r) => ({
    scheduleId: String(r.schedule_id),
    scheduledFor: r.scheduled_for as Date,
    runId: String(r.run_id),
    agent: String(r.agent),
    firedAt: r.fired_at as Date,
    settled: Boolean(r.settled),
  }));
}

/**
 * One sweep pass: fire everything due for the served agents. Safe to run
 * concurrently from any number of workers. Returns the number of runs whose
 * fires were settled this pass.
 */
export async function sweepSchedules(pool: pg.Pool, byAgent: Record<string, TickDeps>): Promise<number> {
  const agents = Object.keys(byAgent);
  if (agents.length === 0) return 0;

  // Phase A — claim + advance + record intent, atomically per schedule.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const due = await client.query(
      `SELECT * FROM toren_control.schedules
       WHERE enabled AND next_fire_at <= now() AND agent = ANY($1)
       FOR UPDATE SKIP LOCKED`,
      [agents],
    );
    for (const s of due.rows) {
      // Missed occurrences while workers were down collapse into this one
      // catch-up fire; the fire record keeps the originally scheduled time
      // so lateness stays visible.
      await client.query(
        `INSERT INTO toren_control.schedule_fires (schedule_id, scheduled_for, run_id, agent, input)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [s.id, s.next_fire_at, randomUUID(), s.agent, s.input],
      );
      await client.query(
        `UPDATE toren_control.schedules SET next_fire_at = $2, last_fired_at = now() WHERE id = $1`,
        [s.id, nextFire(String(s.cron), String(s.tz))],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  // Phase B — fulfill every unsettled fire, idempotently.
  const open = await pool.query(
    `SELECT * FROM toren_control.schedule_fires WHERE NOT settled AND agent = ANY($1)`,
    [agents],
  );
  let settled = 0;
  for (const f of open.rows) {
    const deps = byAgent[String(f.agent)];
    if (!deps) continue;
    const runId = String(f.run_id);
    const existing = await deps.store.getRun(runId);
    if (!existing) {
      try {
        await startRun(deps, { agent: String(f.agent), input: String(f.input), runId });
      } catch {
        // A racing worker created it between our check and insert — fine,
        // the run exists; settle below. Anything else retries next sweep.
        if (!(await deps.store.getRun(runId))) continue;
      }
    } else {
      // Run exists but the fire may have crashed before the queue nudge —
      // re-send; messages are hints, duplicates no-op.
      await deps.queue.send("orchestrator", { kind: "tick", runId, agent: String(f.agent), dedupeKey: `start-${runId}` });
    }
    await pool.query(
      `UPDATE toren_control.schedule_fires SET settled = true WHERE schedule_id = $1 AND scheduled_for = $2`,
      [f.schedule_id, f.scheduled_for],
    );
    settled += 1;
  }
  return settled;
}
