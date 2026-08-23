import { afterAll, beforeAll, expect, test } from "vitest";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";
import { ev } from "../src/events.js";
import { followRun, type TailCursor } from "../src/tail.js";

const pool = createPool();
const SCHEMA = "agent_tailtest";
const store = new PgStateStore(pool, SCHEMA);
const RUN = "0000c0d0-0000-4000-8000-000000000001";

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "tailtest"); });
  await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.runs CASCADE`);
  await store.createRun({ runId: RUN, agent: "tailtest", input: "go" });
  await store.append(RUN, "run", 0, [
    ev("RunCreated", { agent: "tailtest", input: "go" }),
    ev("WavePlanned", { waveId: "w0", name: "main", tasks: [{ taskId: "w0t0", agentRef: "main", input: "go" }] }),
  ]);
  await store.append(RUN, "task:w0t0", 0, [ev("TaskStarted", { attempt: 1 })]);
});
afterAll(async () => { await pool.end(); });

test("followRun yields everything once, then only what is new, and reports terminality", async () => {
  const cursor: TailCursor = {};
  const first = await followRun(store, RUN, cursor);
  expect(first.events.map((e) => e.type)).toEqual(["RunCreated", "WavePlanned", "TaskStarted"]);
  expect(first.events[2]!.streamId).toBe("task:w0t0");
  expect(first.done).toBe(false);

  const quiet = await followRun(store, RUN, cursor);
  expect(quiet.events).toEqual([]);

  await store.append(RUN, "task:w0t0", 1, [ev("LlmCallStarted", { stepId: "s1", requestDigest: "d", model: "mock/m" })]);
  await store.append(RUN, "run", 2, [ev("RunCompleted", { output: "done" })]);
  await store.updateRun(RUN, { status: "completed", output: "done" });

  const rest = await followRun(store, RUN, cursor);
  expect(rest.events.map((e) => e.type).sort()).toEqual(["LlmCallStarted", "RunCompleted"]);
  expect(rest.done).toBe(true);
});
