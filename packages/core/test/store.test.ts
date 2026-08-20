import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";
import { ev } from "../src/events.js";

const pool = createPool();
let store: PgStateStore;

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "stest"); });
  store = new PgStateStore(pool, "agent_stest");
});
afterAll(async () => { await pool.end(); });

async function freshRun(): Promise<string> {
  const runId = randomUUID();
  await store.createRun({ runId, agent: "stest", input: { q: 1 } });
  return runId;
}

test("append from seq 0, read back in order", async () => {
  const runId = await freshRun();
  const r = await store.append(runId, "run", 0, [ev("RunCreated", {}), ev("RunStarted", {})]);
  expect(r).toEqual({ ok: true, lastSeq: 2 });
  const events = await store.read(runId, "run");
  expect(events.map((e) => [e.seq, e.type])).toEqual([[1, "RunCreated"], [2, "RunStarted"]]);
});

test("stale expectedSeq conflicts and writes nothing", async () => {
  const runId = await freshRun();
  await store.append(runId, "run", 0, [ev("RunCreated", {})]);
  const r = await store.append(runId, "run", 0, [ev("RunStarted", {})]);
  expect(r).toEqual({ ok: false, conflict: true, actualSeq: 1 });
  expect((await store.read(runId, "run")).length).toBe(1);
});

test("concurrent appenders: exactly one wins", async () => {
  const runId = await freshRun();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => store.append(runId, "run", 0, [ev("RunCreated", {})])),
  );
  expect(results.filter((r) => r.ok).length).toBe(1);
  expect((await store.read(runId, "run")).length).toBe(1);
});

test("read fromSeq is exclusive of prior events", async () => {
  const runId = await freshRun();
  await store.append(runId, "run", 0, [ev("RunCreated", {}), ev("RunStarted", {}), ev("RunCompleted", {})]);
  const tail = await store.read(runId, "run", 2);
  expect(tail.map((e) => e.seq)).toEqual([3]);
});
