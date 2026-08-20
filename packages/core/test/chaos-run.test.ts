import { afterAll, beforeAll, expect, test } from "vitest";
import type pg from "pg";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";
import { PgQueue } from "../src/queue.js";
import { PgLeases } from "../src/leases.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../src/model.js";
import type { AgentSpec } from "../src/loop.js";
import { startRun, type TickDeps } from "../src/orchestrator.js";
import { LocalWorkerRuntime } from "../src/worker.js";
import { sweep } from "../src/guardians.js";
import type { WorkflowFn } from "../src/workflow.js";

const pool = createPool();
const SCHEMA = "agent_chaosrun";

class KeyedProvider implements ModelProvider {
  calls = new Map<string, number>();
  async complete(req: ModelRequest): Promise<ModelResponse> {
    const first = req.messages[0]!.content.find((b) => b.type === "text");
    const input = first && first.type === "text" ? first.text : "?";
    this.calls.set(input, (this.calls.get(input) ?? 0) + 1);
    return { content: [{ type: "text", text: `out(${input})` }], stopReason: "endTurn", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

class CrashingStore extends PgStateStore {
  public appends = 0;
  constructor(p: pg.Pool, schema: string, private crashAfter = Number.POSITIVE_INFINITY) {
    super(p, schema);
  }
  override async append(...a: Parameters<PgStateStore["append"]>): ReturnType<PgStateStore["append"]> {
    const r = await super.append(...a);
    if (r.ok && ++this.appends >= this.crashAfter) throw new Error("SimulatedCrash");
    return r;
  }
}

const simpleAgent: AgentSpec = { model: "mock/m", system: "sys", tools: [], maxTokens: 100, maxSteps: 5 };
const agents = { researcher: simpleAgent, writer: simpleAgent };

const wf: WorkflowFn = async (ctx) => {
  const w1 = await ctx.wave("research", [ctx.task("researcher", "topicA"), ctx.task("researcher", "topicB")]);
  const joined = w1.results.map((r) => r.output).join("+");
  const w2 = await ctx.wave("summarize", [ctx.task("writer", joined)]);
  return w2.results[0]!.output ?? "";
};

function makeDeps(store: PgStateStore, provider: ModelProvider): TickDeps {
  return { store, queue: new PgQueue(pool), leases: new PgLeases(pool, SCHEMA), provider, agents, workflows: { chaos: wf } };
}

const EXPECTED = "out(out(topicA)+out(topicB))";
const INPUTS = ["topicA", "topicB", "out(topicA)+out(topicB)"];

async function resetQueues(): Promise<void> {
  await pool.query(`TRUNCATE toren_control.queue_messages, toren_control.dead_letters`);
}

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "chaosrun"); });
});
afterAll(async () => { await pool.end(); });

test("run-level kill matrix: crash after every append point, recover, never re-pay a completed step", { timeout: 300_000 }, async () => {
  // Baseline — count total appends across run + task streams.
  await resetQueues();
  const baselineStore = new CrashingStore(pool, SCHEMA);
  const baselineProvider = new KeyedProvider();
  const baselineDeps = makeDeps(baselineStore, baselineProvider);
  const baselineWorker = new LocalWorkerRuntime(baselineDeps, { concurrency: 1 });
  baselineWorker.start();
  let baselineRun: string;
  try {
    baselineRun = await startRun(baselineDeps, { agent: "chaos", input: "go" });
    await baselineWorker.drain(20_000);
  } finally {
    await baselineWorker.stop();
  }
  expect((await baselineStore.getRun(baselineRun))!.output).toBe(EXPECTED);
  for (const i of INPUTS) expect(baselineProvider.calls.get(i)).toBe(1);
  const N = baselineStore.appends;
  expect(N).toBeGreaterThanOrEqual(15);

  for (let k = 1; k <= N; k++) {
    await resetQueues();
    const provider = new KeyedProvider(); // shared across crash + recovery
    const crashingDeps = makeDeps(new CrashingStore(pool, SCHEMA, k), provider);
    const crashedWorker = new LocalWorkerRuntime(crashingDeps, { concurrency: 1 });
    crashedWorker.start();
    try {
      await startRun(crashingDeps, { agent: "chaos", input: "go" });
    } catch (e) {
      expect((e as Error).message).toBe("SimulatedCrash"); // k=1 hits startRun itself
    }
    try {
      await crashedWorker.drain(6_000);
    } catch { /* wedged mid-crash is expected */ }
    await crashedWorker.stop();

    // Recovery: fresh healthy stack, same provider. Guardians find the stalled run.
    await resetQueues();
    const healthyDeps = makeDeps(new PgStateStore(pool, SCHEMA), provider);
    await sweep(healthyDeps);
    const recoveryWorker = new LocalWorkerRuntime(healthyDeps, { concurrency: 1 });
    recoveryWorker.start();
    try {
      await recoveryWorker.drain(20_000);
    } finally {
      await recoveryWorker.stop();
    }

    const open = await healthyDeps.store.listNonTerminalRuns();
    expect(open, `kill point ${k}/${N}: run left non-terminal`).toEqual([]);
    const failed = await pool.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.runs WHERE status = 'failed'`);
    expect(failed.rows[0].n, `kill point ${k}/${N}: a run failed`).toBe(0);
    // THE invariant: every LLM step across crash + recovery paid for exactly once.
    for (const i of INPUTS) {
      expect(provider.calls.get(i), `calls for "${i}" at kill point ${k}/${N}`).toBe(1);
    }
  }
});
