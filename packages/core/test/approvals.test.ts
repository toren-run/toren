import { afterAll, beforeAll, expect, test } from "vitest";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";
import { PgQueue } from "../src/queue.js";
import { PgLeases } from "../src/leases.js";
import { z } from "zod";
import { defineTool } from "../src/tools.js";
import { MockProvider } from "../src/providers/mock.js";
import type { AgentSpec } from "../src/loop.js";
import { startRun, type TickDeps } from "../src/orchestrator.js";
import { LocalWorkerRuntime } from "../src/worker.js";
import { listPendingApprovals, resolveApproval } from "../src/approvals.js";
import type { WorkflowFn } from "../src/workflow.js";

const pool = createPool();
const SCHEMA = "agent_apprtest";
let store: PgStateStore;

const gated = defineTool({
  name: "send_report",
  description: "Send the report.",
  input: z.object({ to: z.string() }),
  effects: "external",
  idempotency: "keyed",
  approval: "always",
  handler: async ({ to }) => `sent to ${to}`,
});

const gatedAgent: AgentSpec = { model: "mock/m", system: "sys", tools: [gated], maxTokens: 100, maxSteps: 10 };
const wf: WorkflowFn = async (ctx) => {
  const w = await ctx.wave("send", [ctx.task("sender", "please send")]);
  return w.results[0]!.output ?? "";
};

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "apprtest"); });
  store = new PgStateStore(pool, SCHEMA);
  await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.blobs, ${SCHEMA}.runs CASCADE`);
  await pool.query(`TRUNCATE toren_control.queue_messages, toren_control.dead_letters`);
});
afterAll(async () => { await pool.end(); });

test("gated tool parks the run; listPendingApprovals finds it; resolveApproval resumes to completion", async () => {
  const provider = new MockProvider([
    { content: [{ type: "toolUse", id: "tu1", name: "send_report", input: { to: "board" } }], stopReason: "toolUse" },
    { content: [{ type: "text", text: "report away" }], stopReason: "endTurn" },
  ]);
  const deps: TickDeps = {
    store, queue: new PgQueue(pool), leases: new PgLeases(pool, SCHEMA),
    provider, agents: { sender: gatedAgent }, workflows: { main: wf },
  };
  const worker = new LocalWorkerRuntime(deps, { concurrency: 1 });
  worker.start();
  try {
    const runId = await startRun(deps, { agent: "appr", input: "go" });
    await worker.drain(15_000);

    // Parked: run non-terminal, approval pending, zero compute outstanding.
    expect((await store.getRun(runId))!.status).toBe("running");
    const pending = await listPendingApprovals(store);
    expect(pending.length).toBe(1);
    expect(pending[0]).toMatchObject({ runId, taskId: "w0t0", tool: "send_report", args: { to: "board" } });

    await resolveApproval(deps, { ...pending[0]!, granted: true, by: "founder" });
    await worker.drain(15_000);

    const run = await store.getRun(runId);
    expect(run!.status).toBe("completed");
    expect(run!.output).toBe("report away");
    expect(await listPendingApprovals(store)).toEqual([]);
  } finally {
    await worker.stop();
  }
});
