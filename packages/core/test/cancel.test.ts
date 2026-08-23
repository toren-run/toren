import { afterAll, beforeAll, expect, test } from "vitest";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";
import { PgQueue } from "../src/queue.js";
import { PgLeases } from "../src/leases.js";
import type { AgentSpec } from "../src/loop.js";
import type { ModelProvider, ModelResponse } from "../src/model.js";
import { cancelRun, startRun, tick, type TickDeps } from "../src/orchestrator.js";
import { LocalWorkerRuntime } from "../src/worker.js";
import type { WorkflowFn } from "../src/workflow.js";

const pool = createPool();
const SCHEMA = "agent_canceltest";
const store = new PgStateStore(pool, SCHEMA);

class BrokenProvider implements ModelProvider {
  async complete(): Promise<ModelResponse> { throw new Error("credit balance too low"); }
}

const spec: AgentSpec = { model: "mock/m", system: "s", tools: [], maxTokens: 50, maxSteps: 3 };
const wf: WorkflowFn = async (ctx) => {
  const w = await ctx.wave("main", [ctx.task("main", ctx.input)]);
  return w.results[0]?.output ?? "";
};

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "canceltest"); });
  await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.blobs, ${SCHEMA}.runs CASCADE`);
  await pool.query(`TRUNCATE toren_control.queue_messages, toren_control.dead_letters`);
});
afterAll(async () => { await pool.end(); });

const startedCount = async (runId: string) =>
  Number((await pool.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.events WHERE run_id = $1 AND type = 'TaskStarted'`, [runId])).rows[0].n);

test("cancel retires a run stuck on a broken dependency; retries stop, hints no-op", { timeout: 30_000 }, async () => {
  const deps: TickDeps = {
    store, queue: new PgQueue(pool), leases: new PgLeases(pool, SCHEMA),
    provider: new BrokenProvider(), agents: { main: spec }, workflows: { main: wf },
  };
  const worker = new LocalWorkerRuntime({ canceltest: deps }, { concurrency: 2 });
  worker.start();
  try {
    const runId = await startRun(deps, { agent: "canceltest", input: "go" });

    // Let it fail and retry at least once (the 1,273-attempts shape, in miniature).
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (await startedCount(runId)) < 2) await new Promise((r) => setTimeout(r, 100));
    expect(await startedCount(runId)).toBeGreaterThanOrEqual(2);

    expect(await cancelRun(deps, runId, "operator gave up")).toBe(true);
    const run = await store.getRun(runId);
    expect(run!.status).toBe("cancelled");
    expect(String(run!.error)).toContain("operator gave up");

    // Queued hints for the dead run must no-op: no new attempts after cancel.
    const after = await startedCount(runId);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await startedCount(runId)).toBe(after);
    expect(await tick(deps, runId)).toBe("terminal");

    // Cancelling again is a harmless yes; a random id is a no.
    expect(await cancelRun(deps, runId)).toBe(true);
    expect(await cancelRun(deps, "00000000-0000-4000-8000-00000000dead")).toBe(false);
  } finally {
    await worker.stop();
  }
});
