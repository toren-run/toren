import type pg from "pg";

export type QueueName = "orchestrator" | "tasks-short" | "tasks-long";
export interface QueueMessage { kind: "tick" | "task"; runId: string; taskId?: string; dedupeKey: string }
export interface Delivery { message: QueueMessage; receipt: number | string; attempt: number }

/**
 * The queue seam (spec §4.1): at-least-once delivery with visibility
 * timeouts and a dead-letter policy. Messages are hints, never truth.
 * Local: Postgres SKIP LOCKED. AWS: SQS (@toren/adapters-aws).
 */
export interface QueueAdapter {
  send(queue: QueueName, msg: QueueMessage, opts?: { delaySeconds?: number; maxAttempts?: number }): Promise<void>;
  receive(queue: QueueName, opts: { max: number; visibilitySeconds: number }): Promise<Delivery[]>;
  extend(d: Delivery, visibilitySeconds: number): Promise<void>;
  ack(d: Delivery): Promise<void>;
  nack(d: Delivery, opts?: { delaySeconds?: number }): Promise<void>;
  /** Messages in flight or ready (delayed excluded) — used by drain/tests. */
  depth(): Promise<number>;
}

export class PgQueue implements QueueAdapter {
  constructor(private pool: pg.Pool) {}

  async send(queue: QueueName, msg: QueueMessage, opts?: { delaySeconds?: number; maxAttempts?: number }): Promise<void> {
    await this.pool.query(
      `INSERT INTO toren_control.queue_messages (queue, payload, dedupe_key, visible_at, max_attempts)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5)`,
      [queue, JSON.stringify(msg), msg.dedupeKey, opts?.delaySeconds ?? 0, opts?.maxAttempts ?? 5],
    );
  }

  async receive(queue: QueueName, opts: { max: number; visibilitySeconds: number }): Promise<Delivery[]> {
    // Move exhausted messages to the DLQ first, then claim visible ones.
    await this.pool.query(
      `WITH exhausted AS (
         DELETE FROM toren_control.queue_messages
         WHERE queue = $1 AND attempts >= max_attempts
           AND (locked_until IS NULL OR locked_until <= now())
         RETURNING id, queue, payload, attempts
       )
       INSERT INTO toren_control.dead_letters (id, queue, payload, attempts)
       SELECT id, queue, payload, attempts FROM exhausted ON CONFLICT DO NOTHING`,
      [queue],
    );
    const r = await this.pool.query(
      `UPDATE toren_control.queue_messages m
       SET locked_until = now() + make_interval(secs => $3), attempts = attempts + 1
       WHERE m.id IN (
         SELECT id FROM toren_control.queue_messages
         WHERE queue = $1 AND visible_at <= now()
           AND (locked_until IS NULL OR locked_until <= now())
           AND attempts < max_attempts
         ORDER BY id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, payload, attempts`,
      [queue, opts.max, opts.visibilitySeconds],
    );
    return r.rows.map((row) => ({ message: row.payload, receipt: Number(row.id), attempt: Number(row.attempts) }));
  }

  /** Messages that are in flight or ready for delivery (delayed ones excluded). */
  async depth(): Promise<number> {
    const r = await this.pool.query(
      `SELECT count(*)::int AS n FROM toren_control.queue_messages
       WHERE (locked_until IS NOT NULL AND locked_until > now())
          OR (visible_at <= now() AND (locked_until IS NULL OR locked_until <= now()) AND attempts < max_attempts)`,
    );
    return r.rows[0].n;
  }

  async extend(d: Delivery, visibilitySeconds: number): Promise<void> {
    await this.pool.query(
      `UPDATE toren_control.queue_messages SET locked_until = now() + make_interval(secs => $2) WHERE id = $1`,
      [d.receipt, visibilitySeconds],
    );
  }

  async ack(d: Delivery): Promise<void> {
    await this.pool.query(`DELETE FROM toren_control.queue_messages WHERE id = $1`, [d.receipt]);
  }

  async nack(d: Delivery, opts?: { delaySeconds?: number }): Promise<void> {
    await this.pool.query(
      `UPDATE toren_control.queue_messages
       SET locked_until = NULL, visible_at = now() + make_interval(secs => $2)
       WHERE id = $1`,
      [d.receipt, opts?.delaySeconds ?? 0],
    );
  }
}
