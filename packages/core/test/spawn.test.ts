import { afterAll, beforeAll, expect, test } from "vitest";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";
import { PgQueue } from "../src/queue.js";
import { PgLeases } from "../src/leases.js";
import type { AgentSpec } from "../src/loop.js";
import { tick, type TickDeps } from "../src/orchestrator.js";
import { MockProvider } from "../src/providers/mock.js";
import type { WorkflowFn } from "../src/workflow.js";
import { makeProcessesFacet, sweepWatchers } from "../src/spawn.js";

const pool = createPool();
const SCHEMA = "agent_spawntest";
const store = new PgStateStore(pool, SCHEMA);

const spec: AgentSpec = { model: "mock/m", system: "s", tools: [], maxTokens: 200, maxSteps: 8 };
const weekly: WorkflowFn = async () => "42 pages";
const deps: TickDeps = {
  store, queue: new PgQueue(pool), leases: new PgLeases(pool, SCHEMA),
  provider: new MockProvider([]), agents: { main: spec },
  workflows: { main: weekly, "weekly-report": weekly },
};
const processes = makeProcessesFacet(pool, "spawntest", deps, { defaultProcess: "main" });

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "spawntest"); });
  await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.blobs, ${SCHEMA}.runs CASCADE`);
  await pool.query(`TRUNCATE toren_control.queue_messages, toren_control.dead_letters, toren_control.run_watchers`);
});
afterAll(async () => { await pool.end(); });

const spawnReq = (toolUseId: string) => ({
  process: "weekly-report", input: "acme", parentRunId: "11111111-1111-4111-8111-111111111111",
  parentTaskId: "w0t0", toolUseId,
});

test("start spawns the child with its process recorded, plus a watcher row; same key is effectively-once", async () => {
  const first = await processes.start(spawnReq("tu1"));
  expect(first.started).toBe(true);
  const child = await store.getRun(first.runId);
  expect(child!.process).toBe("weekly-report");
  expect(child!.mode).toBe("task");

  const watcher = await pool.query(`SELECT * FROM toren_control.run_watchers WHERE child_run_id = $1`, [first.runId]);
  expect(watcher.rows.length).toBe(1);
  expect(watcher.rows[0].parent_run_id).toBe("11111111-1111-4111-8111-111111111111");
  expect(watcher.rows[0].settled).toBe(false);

  const again = await processes.start(spawnReq("tu1"));
  expect(again.runId).toBe(first.runId);
  expect(again.started).toBe(false);

  const other = await processes.start(spawnReq("tu2"));
  expect(other.runId).not.toBe(first.runId);
});

test("an unknown process fails fast, listing what exists", async () => {
  await expect(processes.start({ ...spawnReq("tu3"), process: "nope" }))
    .rejects.toThrow(/no process "nope" for spawntest \(has: main, weekly-report\)/);
});

test("status reports the child's progress from its event log, then the output", async () => {
  const { runId } = await processes.start(spawnReq("tu4"));
  const before = await processes.status(runId);
  expect(before!.status).toBe("created");
  expect(before!.process).toBe("weekly-report");

  await tick(deps, runId);
  const after = await processes.status(runId);
  expect(after!.status).toBe("completed");
  expect(after!.output).toBe("42 pages");

  expect(await processes.status("00000000-0000-4000-8000-00000000dead")).toBeNull();
});
