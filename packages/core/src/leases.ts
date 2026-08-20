import type pg from "pg";
import type { StreamId } from "./events.js";

export interface Lease { runId: string; streamId: StreamId; owner: string; epoch: number }

export class PgLeases {
  constructor(private pool: pg.Pool, private schema: string) {}

  async acquire(runId: string, streamId: StreamId, owner: string, ttlSeconds: number): Promise<Lease | null> {
    const r = await this.pool.query(
      `INSERT INTO ${this.schema}.leases (run_id, stream_id, owner, epoch, expires_at)
       VALUES ($1, $2, $3, 1, now() + make_interval(secs => $4))
       ON CONFLICT (run_id, stream_id) DO UPDATE
         SET owner = EXCLUDED.owner,
             epoch = ${this.schema}.leases.epoch + 1,
             expires_at = EXCLUDED.expires_at
         WHERE ${this.schema}.leases.expires_at < now()
       RETURNING epoch`,
      [runId, streamId, owner, ttlSeconds],
    );
    const row = r.rows[0];
    return row ? { runId, streamId, owner, epoch: Number(row.epoch) } : null;
  }

  async renew(lease: Lease, ttlSeconds = 60): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE ${this.schema}.leases SET expires_at = now() + make_interval(secs => $5)
       WHERE run_id = $1 AND stream_id = $2 AND owner = $3 AND epoch = $4 AND expires_at >= now()`,
      [lease.runId, lease.streamId, lease.owner, lease.epoch, ttlSeconds],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async release(lease: Lease): Promise<void> {
    // Expire rather than delete: the row keeps the epoch so the next acquire fences correctly.
    await this.pool.query(
      `UPDATE ${this.schema}.leases SET expires_at = now() - interval '1 second'
       WHERE run_id = $1 AND stream_id = $2 AND owner = $3 AND epoch = $4`,
      [lease.runId, lease.streamId, lease.owner, lease.epoch],
    );
  }
}
