import { afterAll, beforeAll, expect, test } from "vitest";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent, agentSchemaName } from "../src/migrate.js";

const pool = createPool();
beforeAll(async () => { await tx(pool, async (c) => { await migrateControl(c); }); });
afterAll(async () => { await pool.end(); });

test("provisions an agent schema with all durable-core tables", async () => {
  await tx(pool, (c) => provisionAgent(c, "ptest"));
  const r = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
    [agentSchemaName("ptest")],
  );
  expect(r.rows.map((x) => x.table_name)).toEqual(["blobs", "events", "leases", "runs", "streams"]);
});

test("rejects hostile agent names", () => {
  expect(() => agentSchemaName("x; DROP TABLE runs;--")).toThrow(/invalid agent name/);
});
