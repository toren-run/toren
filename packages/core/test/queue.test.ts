import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { createPool, tx } from "../src/db.js";
import { migrateControl } from "../src/migrate.js";
import { PgQueue } from "../src/queue.js";

const pool = createPool();
const q = () => new PgQueue(pool);

beforeAll(async () => { await tx(pool, async (c) => { await migrateControl(c); }); });
beforeEach(async () => { await pool.query(`TRUNCATE toren_control.queue_messages, toren_control.dead_letters`); });
afterAll(async () => { await pool.end(); });

const MSG = { kind: "tick" as const, runId: "r1", dedupeKey: "k1" };

test("send then receive leases the message; second receive sees nothing", async () => {
  const queue = q();
  await queue.send("orchestrator", MSG);
  const d1 = await queue.receive("orchestrator", { max: 5, visibilitySeconds: 30 });
  expect(d1.length).toBe(1);
  expect(d1[0]!.message.runId).toBe("r1");
  expect(await queue.receive("orchestrator", { max: 5, visibilitySeconds: 30 })).toEqual([]);
});

test("ack removes; expired visibility redelivers with attempt bump", async () => {
  const queue = q();
  await queue.send("orchestrator", MSG);
  const [d] = await queue.receive("orchestrator", { max: 1, visibilitySeconds: 30 });
  await pool.query(`UPDATE toren_control.queue_messages SET locked_until = now() - interval '1 second'`);
  const [redelivered] = await queue.receive("orchestrator", { max: 1, visibilitySeconds: 30 });
  expect(redelivered!.attempt).toBe(2);
  await queue.ack(redelivered!);
  expect((await pool.query(`SELECT count(*)::int AS n FROM toren_control.queue_messages`)).rows[0].n).toBe(0);
  void d;
});

test("nack with delay defers visibility", async () => {
  const queue = q();
  await queue.send("orchestrator", MSG);
  const [d] = await queue.receive("orchestrator", { max: 1, visibilitySeconds: 30 });
  await queue.nack(d!, { delaySeconds: 3600 });
  expect(await queue.receive("orchestrator", { max: 1, visibilitySeconds: 30 })).toEqual([]);
});

test("exhausted attempts dead-letter the message", async () => {
  const queue = q();
  await queue.send("orchestrator", MSG, { maxAttempts: 2 });
  for (let i = 0; i < 2; i++) {
    const [d] = await queue.receive("orchestrator", { max: 1, visibilitySeconds: 30 });
    expect(d).toBeDefined();
    await queue.nack(d!, { delaySeconds: 0 });
  }
  expect(await queue.receive("orchestrator", { max: 1, visibilitySeconds: 30 })).toEqual([]);
  expect((await pool.query(`SELECT count(*)::int AS n FROM toren_control.dead_letters`)).rows[0].n).toBe(1);
});

test("two concurrent receivers never share a message (SKIP LOCKED)", async () => {
  const queue = q();
  for (let i = 0; i < 20; i++) await queue.send("tasks-short", { kind: "task", runId: `r${i}`, dedupeKey: `k${i}` });
  const [a, b] = await Promise.all([
    queue.receive("tasks-short", { max: 20, visibilitySeconds: 30 }),
    queue.receive("tasks-short", { max: 20, visibilitySeconds: 30 }),
  ]);
  const ids = [...a, ...b].map((d) => d.message.runId);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBe(20);
});
