import { afterAll, beforeAll, expect, test } from "vitest";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";
import { PgQueue } from "../src/queue.js";
import { PgLeases } from "../src/leases.js";
import type { AgentSpec } from "../src/loop.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../src/model.js";
import { startRun, type TickDeps } from "../src/orchestrator.js";
import { LocalWorkerRuntime, retryDelaySeconds } from "../src/worker.js";
import type { WorkflowFn } from "../src/workflow.js";

const pool = createPool();
const SCHEMA = "agent_failvistest";
const store = new PgStateStore(pool, SCHEMA);

/** Fails like a broken provider credential, then recovers. */
class FlakyProvider implements ModelProvider {
  failures = 2;
  async complete(req: ModelRequest): Promise<ModelResponse> {
    void req;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("credit balance too low");
    }
    return { content: [{ type: "text", text: "recovered" }], stopReason: "endTurn", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const spec: AgentSpec = { model: "mock/m", system: "s", tools: [], maxTokens: 50, maxSteps: 3 };
const wf: WorkflowFn = async (ctx) => {
  const w = await ctx.wave("main", [ctx.task("main", ctx.input)]);
  return w.results[0]?.output ?? "";
};

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "failvistest"); });
  await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.blobs, ${SCHEMA}.runs CASCADE`);
  await pool.query(`TRUNCATE toren_control.queue_messages, toren_control.dead_letters`);
});
afterAll(async () => { await pool.end(); });

test("retry delays back off exponentially and cap", () => {
  expect(retryDelaySeconds(1)).toBeCloseTo(0.2);
  expect(retryDelaySeconds(2)).toBeCloseTo(0.4);
  expect(retryDelaySeconds(5)).toBeCloseTo(3.2);
  expect(retryDelaySeconds(20)).toBe(60);
});

test("a failing dependency's error lands on the run while it retries, and clears when the run recovers", { timeout: 30_000 }, async () => {
  const deps: TickDeps = {
    store, queue: new PgQueue(pool), leases: new PgLeases(pool, SCHEMA),
    provider: new FlakyProvider(), agents: { main: spec }, workflows: { main: wf },
  };
  const worker = new LocalWorkerRuntime({ failvistest: deps }, { concurrency: 2 });
  worker.start();
  try {
    const runId = await startRun(deps, { agent: "failvistest", input: "go" });

    // Phase 1: while the provider is broken, the reason is visible on the run.
    let run = await store.getRun(runId);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !String(run?.error ?? "").includes("credit balance too low")) {
      await new Promise((r) => setTimeout(r, 100));
      run = await store.getRun(runId);
    }
    expect(String(run!.error)).toContain("credit balance too low");
    expect(run!.status).not.toBe("failed"); // still retrying, not given up

    // Phase 2: the provider recovers; the run completes and the stale error clears.
    while (Date.now() < deadline + 10_000 && run!.status !== "completed") {
      await new Promise((r) => setTimeout(r, 100));
      run = await store.getRun(runId);
    }
    expect(run!.status).toBe("completed");
    expect(run!.output).toBe("recovered");
    expect(run!.error).toBeNull();
  } finally {
    await worker.stop();
  }
});
