import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";

const pool = createPool();
const SCHEMA = "agent_proctest";
const store = new PgStateStore(pool, SCHEMA);

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "proctest"); });
  await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.blobs, ${SCHEMA}.runs CASCADE`);
  await pool.query(`TRUNCATE toren_control.queue_messages, toren_control.dead_letters`);
});
afterAll(async () => { await pool.end(); });

test("runs record their process; absent process defaults to main", async () => {
  const withProc = randomUUID();
  await store.createRun({ runId: withProc, agent: "proctest", input: "x", process: "weekly-report" });
  expect((await store.getRun(withProc))!.process).toBe("weekly-report");

  const bare = randomUUID();
  await store.createRun({ runId: bare, agent: "proctest", input: "x" });
  expect((await store.getRun(bare))!.process).toBe("main");

  const listed = await store.listRuns();
  expect(listed.find((r) => r.runId === withProc)!.process).toBe("weekly-report");
});
