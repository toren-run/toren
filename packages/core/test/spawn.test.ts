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

test("a busy or terminal parent: the wake waits for the turn boundary; a closed parent settles silently", async () => {
  const { startSession } = await import("../src/conversations.js");
  const sessionId = await startSession(deps, { agent: "spawntest", message: "hi" });
  // No worker has driven the session: it is mid-turn (not awaiting input).
  const { runId: childId } = await processes.start({
    process: "weekly-report", input: "x", parentRunId: sessionId, parentTaskId: "w0t0", toolUseId: "busy1",
  });
  await tick(deps, childId); // child settles

  await sweepWatchers(pool, { spawntest: deps });
  const busy = await pool.query(`SELECT settled FROM toren_control.run_watchers WHERE child_run_id = $1`, [childId]);
  expect(busy.rows[0].settled).toBe(false); // parked for the next sweep, never barged mid-turn

  await store.updateRun(sessionId, { status: "cancelled" });
  await sweepWatchers(pool, { spawntest: deps });
  const done = await pool.query(`SELECT settled FROM toren_control.run_watchers WHERE child_run_id = $1`, [childId]);
  expect(done.rows[0].settled).toBe(true); // nothing to wake — settled without a message
});

test("the full arc: chat spawns a process, the run settles, the agent messages the user", async () => {
  await pool.query(`UPDATE toren_control.run_watchers SET settled = true`);
  await pool.query(`TRUNCATE toren_control.queue_messages`);
  const { BUILTIN_TOOLS } = await import("../src/builtins.js");
  const { LocalWorkerRuntime } = await import("../src/worker.js");
  const { startSession, getSession } = await import("../src/conversations.js");

  const usage = { inputTokens: 1, outputTokens: 1 };
  const scripted = new MockProvider([
    { content: [{ type: "toolUse", id: "sp1", name: "run_process", input: { process: "weekly-report", input: "acme" } }], stopReason: "toolUse", usage },
    { content: [{ type: "text", text: "Started — I'll message you when it lands." }], stopReason: "endTurn", usage },
    { content: [{ type: "text", text: "Your weekly report is ready: 42 pages." }], stopReason: "endTurn", usage },
  ]);
  const chatAgent: AgentSpec = { ...spec, tools: [BUILTIN_TOOLS.run_process!, BUILTIN_TOOLS.check_run!] };
  const e2e: TickDeps = { ...deps, provider: scripted, agents: { main: chatAgent } };
  e2e.processes = makeProcessesFacet(pool, "spawntest", e2e);

  const worker = new LocalWorkerRuntime({ spawntest: e2e }, { concurrency: 2 });
  worker.start();
  try {
    const sessionId = await startSession(e2e, { agent: "spawntest", message: "run the weekly report for acme" });
    await worker.drain(15_000); // agent spawns the child, parks; the child run completes

    let s = (await getSession(store, sessionId))!;
    expect(s.state).toBe("awaiting_input");
    expect(s.transcript.at(-1)!.text).toContain("I'll message you");

    expect(await sweepWatchers(pool, { spawntest: e2e })).toBe(1);
    await worker.drain(15_000); // the wake turn

    s = (await getSession(store, sessionId))!;
    expect(s.state).toBe("awaiting_input");
    expect(s.transcript.at(-1)!.role).toBe("assistant");
    expect(s.transcript.at(-1)!.text).toContain("42 pages");
    expect(s.transcript.at(-2)!.text).toContain('[background run] process "weekly-report"');

    expect(await sweepWatchers(pool, { spawntest: e2e })).toBe(0); // idempotent
  } finally {
    await worker.stop();
  }
});
