import { afterAll, beforeAll, expect, test } from "vitest";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";
import { PgQueue } from "../src/queue.js";
import { PgLeases } from "../src/leases.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../src/model.js";
import type { AgentSpec } from "../src/loop.js";
import { startRun, tick, type TickDeps } from "../src/orchestrator.js";
import { LocalWorkerRuntime } from "../src/worker.js";
import { sweep } from "../src/guardians.js";
import type { WorkflowFn } from "../src/workflow.js";

const pool = createPool();
const SCHEMA = "agent_orchtest";
let store: PgStateStore;

/** Deterministic provider: response is a pure function of the task input. */
class KeyedProvider implements ModelProvider {
  calls = new Map<string, number>();
  async complete(req: ModelRequest): Promise<ModelResponse> {
    const first = req.messages[0]!.content.find((b) => b.type === "text");
    const input = first && first.type === "text" ? first.text : "?";
    this.calls.set(input, (this.calls.get(input) ?? 0) + 1);
    if (input.startsWith("FAIL")) return { content: [], stopReason: "refusal", usage: { inputTokens: 1, outputTokens: 0 } };
    return { content: [{ type: "text", text: `out(${input})` }], stopReason: "endTurn", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const simpleAgent: AgentSpec = { model: "mock/m", system: "sys", tools: [], maxTokens: 100, maxSteps: 5 };
const agents = { researcher: simpleAgent, writer: simpleAgent };

const researchWf: WorkflowFn = async (ctx) => {
  const w1 = await ctx.wave("research", [ctx.task("researcher", "topicA"), ctx.task("researcher", "topicB")]);
  const joined = w1.results.map((r) => r.output).join("+");
  const w2 = await ctx.wave("summarize", [ctx.task("writer", joined)]);
  return w2.results[0]!.output ?? "";
};

function makeDeps(provider: ModelProvider, workflows: Record<string, WorkflowFn>): TickDeps {
  return { store, queue: new PgQueue(pool), leases: new PgLeases(pool, SCHEMA), provider, agents, workflows };
}

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "orchtest"); });
  store = new PgStateStore(pool, SCHEMA);
  await pool.query(`TRUNCATE toren_control.queue_messages, toren_control.dead_letters`);
});
afterAll(async () => { await pool.end(); });

test("first tick plans wave 1 and enqueues its tasks", async () => {
  const deps = makeDeps(new KeyedProvider(), { orch: researchWf });
  const runId = await startRun(deps, { agent: "orch", input: "go" });
  expect(await tick(deps, runId)).toBe("blocked");
  const events = await store.read(runId, "run");
  expect(events.some((e) => e.type === "WavePlanned")).toBe(true);
  const msgs = await deps.queue.receive("tasks-short", { max: 10, visibilitySeconds: 1 });
  expect(msgs.length).toBe(2);
  for (const m of msgs) await deps.queue.nack(m, { delaySeconds: 0 }); // put back for nothing — isolated run
  await pool.query(`TRUNCATE toren_control.queue_messages`);
});

test("worker-driven end to end: two waves, deterministic output", async () => {
  const provider = new KeyedProvider();
  const deps = makeDeps(provider, { orch: researchWf });
  const worker = new LocalWorkerRuntime(deps);
  worker.start();
  try {
    const runId = await startRun(deps, { agent: "orch", input: "go" });
    await worker.drain(15_000);
    const run = await store.getRun(runId);
    expect(run!.status).toBe("completed");
    expect(run!.output).toBe("out(out(topicA)+out(topicB))");
    expect(provider.calls.get("topicA")).toBe(1);
    expect(provider.calls.get("topicB")).toBe(1);
    expect(provider.calls.get("out(topicA)+out(topicB)")).toBe(1);
  } finally {
    await worker.stop();
  }
});

test("failing task under 'fail' policy fails the run; 'collect' lets the workflow continue", async () => {
  const failWf: WorkflowFn = async (ctx) => {
    const w = await ctx.wave("research", [ctx.task("researcher", "FAIL-topic")]);
    return w.results[0]!.output ?? "";
  };
  const collectWf: WorkflowFn = async (ctx) => {
    const w = await ctx.wave("research", [ctx.task("researcher", "FAIL-topic")], { onTaskFailure: "collect" });
    return `saw:${w.results[0]!.status}`;
  };
  const deps = makeDeps(new KeyedProvider(), { orchfail: failWf, orchcollect: collectWf });
  const worker = new LocalWorkerRuntime(deps);
  worker.start();
  try {
    const failId = await startRun(deps, { agent: "orchfail", input: "go" });
    const collectId = await startRun(deps, { agent: "orchcollect", input: "go" });
    await worker.drain(15_000);
    expect((await store.getRun(failId))!.status).toBe("failed");
    const collected = await store.getRun(collectId);
    expect(collected!.status).toBe("completed");
    expect(collected!.output).toBe("saw:failed");
  } finally {
    await worker.stop();
  }
});

test("guardians recover a run whose queue messages were lost", async () => {
  const provider = new KeyedProvider();
  const deps = makeDeps(provider, { orch: researchWf });
  const runId = await startRun(deps, { agent: "orch", input: "go" });
  await tick(deps, runId); // plans wave 1, enqueues tasks
  await pool.query(`TRUNCATE toren_control.queue_messages`); // lose everything

  await sweep(deps);
  const worker = new LocalWorkerRuntime(deps);
  worker.start();
  try {
    await worker.drain(15_000);
    expect((await store.getRun(runId))!.status).toBe("completed");
  } finally {
    await worker.stop();
  }
});

test("durable timer: run pauses across the delay and completes after it", async () => {
  const timerWf: WorkflowFn = async (ctx) => {
    const w1 = await ctx.wave("research", [ctx.task("researcher", "topicA")]);
    await ctx.sleep(400);
    const w2 = await ctx.wave("summarize", [ctx.task("writer", w1.results[0]!.output ?? "")]);
    return w2.results[0]!.output ?? "";
  };
  const deps = makeDeps(new KeyedProvider(), { orchtimer: timerWf });
  const worker = new LocalWorkerRuntime(deps);
  worker.start();
  try {
    const runId = await startRun(deps, { agent: "orchtimer", input: "go" });
    await worker.drain(15_000); // drains up to the pending timer (delayed msg invisible)
    const mid = await store.getRun(runId);
    expect(mid!.status).toBe("running"); // parked on the timer
    await new Promise((r) => setTimeout(r, 500));
    await worker.drain(15_000);
    expect((await store.getRun(runId))!.status).toBe("completed");
    expect((await store.getRun(runId))!.output).toBe("out(out(topicA))");
  } finally {
    await worker.stop();
  }
});

test("editing the workflow mid-flight invalidates the plan and re-runs only what changed", async () => {
  const provider = new KeyedProvider();
  const v1: WorkflowFn = async (ctx) => {
    const w = await ctx.wave("research", [ctx.task("researcher", "topicA"), ctx.task("researcher", "topicB")]);
    return w.results.map((r) => r.output).join("+");
  };
  const v2: WorkflowFn = async (ctx) => {
    const w = await ctx.wave("research", [ctx.task("researcher", "topicC"), ctx.task("researcher", "topicD")]);
    return w.results.map((r) => r.output).join("+");
  };
  const deps1 = makeDeps(provider, { orchedit: v1 });
  const runId = await startRun(deps1, { agent: "orchedit", input: "go" });
  await tick(deps1, runId); // plans v1's wave
  await pool.query(`TRUNCATE toren_control.queue_messages`); // drop v1 task hints deterministically

  const deps2 = makeDeps(provider, { orchedit: v2 });
  await sweep(deps2);
  const worker = new LocalWorkerRuntime(deps2);
  worker.start();
  try {
    await worker.drain(15_000);
    const run = await store.getRun(runId);
    expect(run!.status).toBe("completed");
    expect(run!.output).toBe("out(topicC)+out(topicD)");
    expect(provider.calls.has("topicA")).toBe(false);
    expect(provider.calls.has("topicB")).toBe(false);
    const events = await store.read(runId, "run");
    expect(events.some((e) => e.type === "StreamInvalidated")).toBe(true);
  } finally {
    await worker.stop();
  }
});
