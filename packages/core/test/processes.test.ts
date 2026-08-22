import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";
import { PgQueue } from "../src/queue.js";
import { PgLeases } from "../src/leases.js";
import type { AgentSpec } from "../src/loop.js";
import { startRun, tick, type TickDeps } from "../src/orchestrator.js";
import { MockProvider } from "../src/providers/mock.js";
import type { WorkflowFn } from "../src/workflow.js";

const pool = createPool();
const SCHEMA = "agent_proctest";
const store = new PgStateStore(pool, SCHEMA);

const spec: AgentSpec = { model: "mock/m", system: "s", tools: [], maxTokens: 50, maxSteps: 3 };
const daily: WorkflowFn = async () => "ran daily";
const weekly: WorkflowFn = async () => "ran weekly";
const deps: TickDeps = {
  store, queue: new PgQueue(pool), leases: new PgLeases(pool, SCHEMA),
  provider: new MockProvider([]), agents: { main: spec },
  workflows: { main: daily, "daily-digest": daily, "weekly-report": weekly },
};

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

test("startRun records the process and tick executes that workflow", async () => {
  const runId = await startRun(deps, { agent: "proctest", input: "go", process: "weekly-report" });
  expect((await store.getRun(runId))!.process).toBe("weekly-report");
  await tick(deps, runId);
  const run = await store.getRun(runId);
  expect(run!.status).toBe("completed");
  expect(run!.output).toBe("ran weekly");
});

test("no process named selects main", async () => {
  const runId = await startRun(deps, { agent: "proctest", input: "go" });
  await tick(deps, runId);
  expect((await store.getRun(runId))!.output).toBe("ran daily");
});

test("an unknown process fails fast at startRun, listing what exists", async () => {
  await expect(startRun(deps, { agent: "proctest", input: "go", process: "nope" }))
    .rejects.toThrow(/no process "nope" for proctest \(has: main, daily-digest, weekly-report\)/);
});
