import type pg from "pg";

export interface BlobRef { runId: string; key: string }

export class PgBlobs {
  constructor(private pool: pg.Pool, private schema: string) {}

  async put(runId: string, key: string, data: Buffer): Promise<BlobRef> {
    await this.pool.query(
      `INSERT INTO ${this.schema}.blobs (run_id, key, data) VALUES ($1, $2, $3)
       ON CONFLICT (run_id, key) DO UPDATE SET data = EXCLUDED.data`,
      [runId, key, data],
    );
    return { runId, key };
  }

  async get(ref: BlobRef): Promise<Buffer | null> {
    const r = await this.pool.query(
      `SELECT data FROM ${this.schema}.blobs WHERE run_id = $1 AND key = $2`,
      [ref.runId, ref.key],
    );
    return r.rows[0]?.data ?? null;
  }
}
