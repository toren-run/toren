import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createPool, tx, migrateControl, provisionAgent,
  PgStateStore, PgQueue, PgLeases,
  LocalWorkerRuntime, startRun, sweep, effectiveEvents,
  type AgentSpec, type TickDeps, type WorkflowFn, type RecordedEvent,
} from "@toren-run/core";
import { RouterProvider } from "../src/router.js";

/**
 * Live end-to-end (needs ANTHROPIC_API_KEY): run a real two-wave crew on a
 * real model, abandon the stack mid-run, recover on a fresh one, and prove
 * from the event log that no completed model call was ever re-issued.
 * Costs a few short Opus calls.
 */
const KEY = !!process.env.ANTHROPIC_API_KEY;
const pool = createPool();
const SCHEMA = "agent_livetest";
let store: PgStateStore;

const MODEL = "anthropic/claude-opus-5";
const agent = (system: string): AgentSpec => ({ model: MODEL, system, tools: [], maxTokens: 300, maxSteps: 5 });

const wf: WorkflowFn = async (ctx) => {
  const research = await ctx.wave("research", [
    ctx.task("researcher", "In one short sentence: one advantage of solar-assisted cargo shipping."),
    ctx.task("researcher", "In one short sentence: one advantage of battery-electric freight trucks."),
  ]);
  const summary = await ctx.wave("summarize", [
    ctx.task("writer", `Combine into one sentence:\n${research.results.map((r) => r.output).join("\n")}`),
  ]);
  return summary.results[0]!.output ?? "";
};

function makeDeps(): TickDeps {
  return {
    store, queue: new PgQueue(pool), leases: new PgLeases(pool, SCHEMA),
    provider: new RouterProvider(),
    agents: { researcher: agent("You research crisply."), writer: agent("You write crisply.") },
    workflows: { main: wf },
  };
}

beforeAll(async () => {
  if (!KEY) return;
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "livetest"); });
  store = new PgStateStore(pool, SCHEMA);
  await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.blobs, ${SCHEMA}.runs CASCADE`);
  await pool.query(`TRUNCATE toren_control.queue_messages, toren_control.dead_letters`);
});
afterAll(async () => { await pool.end(); });

async function taskStreams(runId: string): Promise<Map<string, RecordedEvent[]>> {
  const runEff = effectiveEvents(await store.read(runId, "run"));
  const taskIds = runEff.filter((e) => e.type === "WavePlanned")
    .flatMap((e) => (e.payload.tasks as { taskId: string }[]).map((t) => t.taskId));
  const out = new Map<string, RecordedEvent[]>();
  for (const t of taskIds) out.set(t, effectiveEvents(await store.read(runId, `task:${t}`)));
  return out;
}

test.skipIf(!KEY)("live kill-resume on a real model: no completed call re-issued", { timeout: 180_000 }, async () => {
  // Phase A: start on stack 1, abandon as soon as the first real call lands.
  const deps1 = makeDeps();
  const worker1 = new LocalWorkerRuntime(deps1, { concurrency: 2 });
  worker1.start();
  const runId = await startRun(deps1, { agent: "live", input: "go" });

  const deadline = Date.now() + 90_000;
  let sawCompletion = false;
  while (Date.now() < deadline && !sawCompletion) {
    for (const [, events] of await taskStreams(runId)) {
      if (events.some((e) => e.type === "LlmCallCompleted")) { sawCompletion = true; break; }
    }
    if (!sawCompletion) await new Promise((r) => setTimeout(r, 100));
  }
  expect(sawCompletion, "no real model call completed within 90s").toBe(true);
  await worker1.stop(); // abandon mid-run

  const midway = await store.getRun(runId);
  expect(midway!.status).not.toBe("completed"); // we really did die mid-run

  // Phase B: fresh stack, guardians recover, run completes.
  await pool.query(`TRUNCATE toren_control.queue_messages`); // even lose all queue state
  const deps2 = makeDeps();
  await sweep(deps2);
  const worker2 = new LocalWorkerRuntime(deps2, { concurrency: 2 });
  worker2.start();
  try {
    const done = Date.now() + 90_000;
    while (Date.now() < done) {
      const run = await store.getRun(runId);
      if (run!.status === "completed") break;
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    await worker2.stop();
  }

  const run = await store.getRun(runId);
  expect(run!.status).toBe("completed");
  expect(String(run!.output).length).toBeGreaterThan(10);

  // THE claim, verified in the log: every model step started exactly once
  // across both stacks — completed calls were replayed, never re-issued.
  let totalCalls = 0;
  let inputTokens = 0, outputTokens = 0;
  for (const [taskId, events] of await taskStreams(runId)) {
    const started = events.filter((e) => e.type === "LlmCallStarted");
    const distinctSteps = new Set(started.map((e) => String(e.payload.stepId)));
    expect(started.length, `task ${taskId}: a completed call was re-issued`).toBe(distinctSteps.size);
    totalCalls += started.length;
    for (const e of events.filter((x) => x.type === "LlmCallCompleted")) {
      const usage = e.payload.usage as { inputTokens: number; outputTokens: number } | undefined;
      inputTokens += usage?.inputTokens ?? 0;
      outputTokens += usage?.outputTokens ?? 0;
    }
  }
  expect(totalCalls).toBe(3); // 2 researchers + 1 writer, once each
  console.log(`LIVE OUTPUT: ${String(run!.output)}`);
  console.log(`LIVE USAGE: ${totalCalls} calls, ${inputTokens} in / ${outputTokens} out tokens`);
});
