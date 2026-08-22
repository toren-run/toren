import type pg from "pg";
import { tx } from "./db.js";
import type { NewEvent, RecordedEvent, StreamId } from "./events.js";

export type AppendResult =
  | { ok: true; lastSeq: number }
  | { ok: false; conflict: true; actualSeq: number };

export interface CreateRun { runId: string; agent: string; input?: unknown; codeHash?: string; mode?: "task" | "session"; process?: string }

export class PgStateStore {
  constructor(private pool: pg.Pool, private schema: string) {}

  async createRun(req: CreateRun): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.schema}.runs (run_id, agent, input, code_hash, mode, process) VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.runId, req.agent, JSON.stringify(req.input ?? null), req.codeHash ?? null, req.mode ?? "task", req.process ?? "main"],
    );
  }

  async getRun(runId: string): Promise<{ runId: string; agent: string; status: string; mode: string; process: string; input: unknown; output: unknown; error: unknown } | null> {
    const r = await this.pool.query(
      `SELECT run_id, agent, status, mode, process, input, output, error FROM ${this.schema}.runs WHERE run_id = $1`, [runId],
    );
    const row = r.rows[0];
    return row ? { runId: row.run_id, agent: row.agent, status: row.status, mode: row.mode, process: row.process, input: row.input, output: row.output, error: row.error } : null;
  }

  async updateRun(runId: string, patch: { status?: string; output?: unknown; error?: unknown }): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.schema}.runs
       SET status = COALESCE($2, status),
           output = COALESCE($3, output),
           error  = COALESCE($4, error),
           updated_at = now()
       WHERE run_id = $1`,
      [
        runId,
        patch.status ?? null,
        patch.output !== undefined ? JSON.stringify(patch.output) : null,
        patch.error !== undefined ? JSON.stringify(patch.error) : null,
      ],
    );
  }

  async listRuns(limit = 50): Promise<{ runId: string; agent: string; status: string; mode: string; process: string; createdAt: Date }[]> {
    const r = await this.pool.query(
      `SELECT run_id, agent, status, mode, process, created_at FROM ${this.schema}.runs ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return r.rows.map((row) => ({ runId: row.run_id, agent: row.agent, status: row.status, mode: row.mode, process: row.process, createdAt: row.created_at }));
  }

  async listNonTerminalRuns(): Promise<string[]> {
    const r = await this.pool.query(
      `SELECT run_id FROM ${this.schema}.runs WHERE status NOT IN ('completed','failed','cancelled') ORDER BY created_at`,
    );
    return r.rows.map((row) => row.run_id);
  }

  async append(runId: string, streamId: StreamId, expectedSeq: number, events: NewEvent[]): Promise<AppendResult> {
    if (events.length === 0) throw new Error("append requires at least one event");
    return tx(this.pool, async (c) => {
      await c.query(
        `INSERT INTO ${this.schema}.streams (run_id, stream_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [runId, streamId],
      );
      const cas = await c.query(
        `UPDATE ${this.schema}.streams SET head_seq = head_seq + $3
         WHERE run_id = $1 AND stream_id = $2 AND head_seq = $4 RETURNING head_seq`,
        [runId, streamId, events.length, expectedSeq],
      );
      if (cas.rowCount === 0) {
        const cur = await c.query(
          `SELECT head_seq FROM ${this.schema}.streams WHERE run_id = $1 AND stream_id = $2`,
          [runId, streamId],
        );
        // COMMIT of a no-op tx is harmless; nothing was written.
        return { ok: false as const, conflict: true as const, actualSeq: Number(cur.rows[0].head_seq) };
      }
      let seq = expectedSeq;
      for (const e of events) {
        seq += 1;
        await c.query(
          `INSERT INTO ${this.schema}.events (run_id, stream_id, seq, type, payload) VALUES ($1,$2,$3,$4,$5)`,
          [runId, streamId, seq, e.type, JSON.stringify(e.payload)],
        );
      }
      return { ok: true as const, lastSeq: seq };
    });
  }

  async read(runId: string, streamId: StreamId, fromSeq = 0): Promise<RecordedEvent[]> {
    const r = await this.pool.query(
      `SELECT seq, type, payload, recorded_at FROM ${this.schema}.events
       WHERE run_id = $1 AND stream_id = $2 AND seq > $3 ORDER BY seq`,
      [runId, streamId, fromSeq],
    );
    return r.rows.map((row) => ({
      seq: Number(row.seq), type: row.type, payload: row.payload, recordedAt: row.recorded_at,
    }));
  }
}
