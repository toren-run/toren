import { beforeAll, afterAll, expect, test } from "vitest";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";
import { PgQueue, type QueueAdapter } from "../src/queue.js";
import { PgLeases } from "../src/leases.js";
import { LocalWorkerRuntime } from "../src/worker.js";
import { startRun, type TickDeps } from "../src/orchestrator.js";
import type { ModelProvider, ModelResponse } from "../src/model.js";
import type { AgentSpec } from "../src/loop.js";
import type { WorkflowFn } from "../src/workflow.js";

const pool = createPool();
const SCHEMA = "agent_dbrestest";

/** Delegates to PgQueue but fails the first N receive calls — a DB flap. */
class FlakyQueue implements QueueAdapter {
  receiveFailures = 0;
  constructor(private inner: PgQueue, private failFirst: number) {}
  send: QueueAdapter["send"] = (...a) => this.inner.send(...a);
  ack: QueueAdapter["ack"] = (...a) => this.inner.ack(...a);
  nack: QueueAdapter["nack"] = (...a) => this.inner.nack(...a);
  depth: QueueAdapter["depth"] = (...a) => this.inner.depth(...a);
  extend: QueueAdapter["extend"] = (...a) => this.inner.extend(...a);
  receive: QueueAdapter["receive"] = async (...a) => {
    if (this.receiveFailures < this.failFirst) {
      this.receiveFailures += 1;
      throw new Error("connection terminated unexpectedly (simulated DB flap)");
    }
    return this.inner.receive(...a);
  };
}

class Echo implements ModelProvider {
  async complete(): Promise<ModelResponse> {
    return { content: [{ type: "text", text: "ok" }], stopReason: "endTurn", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const spec: AgentSpec = { model: "mock/m", system: "s", tools: [], maxTokens: 100, maxSteps: 3 };
const wf: WorkflowFn = async (ctx) => {
  const w = await ctx.wave("main", [ctx.task("main", ctx.input)]);
  return w.results[0]?.output ?? "";
};

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "dbrestest"); });
  await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.blobs, ${SCHEMA}.runs CASCADE`);
  await pool.query(`TRUNCATE toren_control.queue_messages, toren_control.dead_letters`);
});
afterAll(async () => { await pool.end(); });

test("poll loops survive a burst of queue/DB errors and still complete the run", { timeout: 30_000 }, async () => {
  const queue = new FlakyQueue(new PgQueue(pool), 8); // more failures than poll loops
  const deps: TickDeps = {
    store: new PgStateStore(pool, SCHEMA), queue, leases: new PgLeases(pool, SCHEMA),
    provider: new Echo(), agents: { main: spec }, workflows: { main: wf },
  };
  const worker = new LocalWorkerRuntime({ res: deps }, { concurrency: 2, pollMs: 20 });
  worker.start();
  try {
    const runId = await startRun(deps, { agent: "res", input: "hello" });
    await worker.drain(20_000);
    expect(queue.receiveFailures).toBe(8); // the flap actually happened
    const run = await deps.store.getRun(runId);
    expect(run?.status).toBe("completed");
    expect(run?.output).toBe("ok");
  } finally {
    await worker.stop();
  }
});
