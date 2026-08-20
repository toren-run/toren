import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgLeases } from "../src/leases.js";

const pool = createPool();
let leases: PgLeases;

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "ltest"); });
  leases = new PgLeases(pool, "agent_ltest");
});
afterAll(async () => { await pool.end(); });

test("acquire, contend, expire, takeover bumps epoch, zombie renew fails", async () => {
  const runId = randomUUID();

  const a = await leases.acquire(runId, "run", "worker-a", 60);
  expect(a?.epoch).toBe(1);

  expect(await leases.acquire(runId, "run", "worker-b", 60)).toBeNull();

  // force-expire a's lease (test-only clock manipulation)
  await pool.query(`UPDATE agent_ltest.leases SET expires_at = now() - interval '1 second'`);

  const b = await leases.acquire(runId, "run", "worker-b", 60);
  expect(b?.epoch).toBe(2);

  // zombie a wakes up: renew must fail (fencing)
  expect(await leases.renew(a!)).toBe(false);
  expect(await leases.renew(b!)).toBe(true);

  await leases.release(b!);
  const c = await leases.acquire(runId, "run", "worker-c", 60);
  expect(c?.epoch).toBe(3);
});
