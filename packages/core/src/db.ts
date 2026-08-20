import pg from "pg";

export function createPool(url = process.env.DATABASE_URL ?? "postgres://toren:toren@localhost:5433/toren"): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
