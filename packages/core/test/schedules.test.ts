import { afterAll, beforeAll, expect, test } from "vitest";
import type pg from "pg";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";
import { PgQueue } from "../src/queue.js";
import { PgLeases } from "../src/leases.js";
import type { AgentSpec } from "../src/loop.js";
import type { TickDeps } from "../src/orchestrator.js";
import { MockProvider } from "../src/providers/mock.js";
import {
  createSchedule, deleteSchedule, listFires, listSchedules, nextFire, setScheduleEnabled, sweepSchedules,
} from "../src/schedules.js";
import type { WorkflowFn } from "../src/workflow.js";

const pool = createPool();
const SCHEMA = "agent_schedtest";
const spec: AgentSpec = { model: "mock/m", system: "s", tools: [], maxTokens: 50, maxSteps: 3 };
const wf: WorkflowFn = async () => "";

function deps(p: pg.Pool): Record<string, TickDeps> {
  return {
    schedtest: {
      store: new PgStateStore(p, SCHEMA), queue: new PgQueue(p), leases: new PgLeases(p, SCHEMA),
      provider: new MockProvider([]), agents: { main: spec }, workflows: { main: wf },
    },
  };
}

const runCount = async () => Number((await pool.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.runs`)).rows[0].n);
const makeDue = (id: string, minutesAgo: number) =>
  pool.query(`UPDATE toren_control.schedules SET next_fire_at = now() - make_interval(mins => $2) WHERE id = $1`, [id, minutesAgo]);

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "schedtest"); });
  await pool.query(`TRUNCATE toren_control.schedules, toren_control.schedule_fires`);
  await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.blobs, ${SCHEMA}.runs CASCADE`);
  await pool.query(`TRUNCATE toren_control.queue_messages, toren_control.dead_letters`);
});
afterAll(async () => { await pool.end(); });

test("create validates cron and computes the next fire; pause/resume; invalid expressions rejected", async () => {
  const s = await createSchedule(pool, { agent: "schedtest", name: "daily", cron: "0 9 * * *", input: '"go"' });
  expect(s.nextFireAt.getTime()).toBeGreaterThan(Date.now());
  expect((await listSchedules(pool, ["schedtest"])).length).toBe(1);

  expect(await setScheduleEnabled(pool, s.id, false)).toBe(true);
  expect((await listSchedules(pool)).find((x) => x.id === s.id)!.enabled).toBe(false);
  expect(await setScheduleEnabled(pool, s.id, true)).toBe(true);

  await expect(createSchedule(pool, { agent: "schedtest", name: "bad", cron: "not a cron", input: "x" })).rejects.toThrow();
  expect(() => nextFire("61 * * * *", "UTC")).toThrow();
  expect(await deleteSchedule(pool, s.id)).toBe(true);
});

test("a due schedule fires exactly one run and advances into the future; a second sweep is a no-op", async () => {
  const s = await createSchedule(pool, { agent: "schedtest", name: "due", cron: "*/5 * * * *", input: '"tick"' });
  await makeDue(s.id, 60);
  const before = await runCount();

  expect(await sweepSchedules(pool, deps(pool))).toBe(1);
  expect(await runCount()).toBe(before + 1);
  expect(await sweepSchedules(pool, deps(pool))).toBe(0); // idempotent
  expect(await runCount()).toBe(before + 1);

  const after = (await listSchedules(pool)).find((x) => x.id === s.id)!;
  expect(after.nextFireAt.getTime()).toBeGreaterThan(Date.now());
  // catch-up lateness stays visible: the fire kept its originally scheduled time
  const fires = await listFires(pool, s.id);
  expect(fires.length).toBe(1);
  expect(fires[0]!.settled).toBe(true);
  expect(fires[0]!.scheduledFor.getTime()).toBeLessThan(Date.now() - 50 * 60_000);
  await deleteSchedule(pool, s.id);
});

test("ten concurrent sweeps race on one due schedule — exactly one run", async () => {
  const s = await createSchedule(pool, { agent: "schedtest", name: "race", cron: "*/5 * * * *", input: '"race"' });
  await makeDue(s.id, 10);
  const before = await runCount();

  await Promise.all(Array.from({ length: 10 }, () => sweepSchedules(pool, deps(pool))));
  expect(await runCount()).toBe(before + 1);
  expect((await listFires(pool, s.id)).length).toBe(1);
  await deleteSchedule(pool, s.id);
});

/** Counts every non-transactional query and crashes after the Nth. */
function crashingPool(real: pg.Pool, crashAfter: number): pg.Pool {
  let n = 0;
  const bump = (sql: unknown) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(String(sql))) return;
    if (++n > crashAfter) throw new Error("SimulatedCrash");
  };
  const wrapClient = (c: pg.PoolClient): pg.PoolClient =>
    new Proxy(c, {
      get(t, p) {
        if (p === "query") return (...a: unknown[]) => { bump(a[0]); return (t.query as (...x: unknown[]) => unknown)(...a); };
        const v = (t as unknown as Record<PropertyKey, unknown>)[p];
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
  return new Proxy(real, {
    get(t, p) {
      if (p === "query") return (...a: unknown[]) => { bump(a[0]); return (t.query as (...x: unknown[]) => unknown)(...a); };
      if (p === "connect") return async () => wrapClient(await t.connect());
      const v = (t as unknown as Record<PropertyKey, unknown>)[p];
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  });
}

test("kill matrix: crash after every write point in the fire path — never a miss, never a duplicate", { timeout: 120_000 }, async () => {
  const s = await createSchedule(pool, { agent: "schedtest", name: "chaos", cron: "*/5 * * * *", input: '"chaos"' });

  // Baseline: count the queries of one full clean fire.
  await makeDue(s.id, 5);
  let baselineQueries = 0;
  const counter = crashingPool(pool, Number.POSITIVE_INFINITY);
  const counted = new Proxy(counter, {
    get(t, p) {
      if (p === "query") return (...a: unknown[]) => { baselineQueries++; return (t.query as (...x: unknown[]) => unknown)(...a); };
      if (p === "connect") return async () => {
        const c = await t.connect();
        return new Proxy(c, { get(ct, cp) {
          if (cp === "query") return (...a: unknown[]) => { if (!/^(BEGIN|COMMIT|ROLLBACK)/i.test(String(a[0]))) baselineQueries++; return (ct.query as (...x: unknown[]) => unknown)(...a); };
          const v = (ct as unknown as Record<PropertyKey, unknown>)[cp];
          return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(ct) : v;
        } });
      };
      const v = (t as unknown as Record<PropertyKey, unknown>)[p];
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  }) as pg.Pool;
  await sweepSchedules(counted, deps(counted));
  expect(baselineQueries).toBeGreaterThanOrEqual(5);
  const runsAfterBaseline = await runCount();

  // Crash after every query index; heal with a clean sweep; assert exactly-once.
  for (let k = 1; k <= baselineQueries; k++) {
    await makeDue(s.id, 5); // a fresh occurrence for this iteration
    const chaos = crashingPool(pool, k);
    try {
      await sweepSchedules(chaos, deps(chaos));
    } catch (e) {
      expect((e as Error).message).toBe("SimulatedCrash");
    }
    await sweepSchedules(pool, deps(pool)); // recovery
    const expected = runsAfterBaseline + k;
    expect(await runCount(), `kill point ${k}/${baselineQueries}`).toBe(expected);
  }
  await deleteSchedule(pool, s.id);
});
