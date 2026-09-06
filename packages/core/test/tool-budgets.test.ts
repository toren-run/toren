import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";
import { PgQueue } from "../src/queue.js";
import { PgLeases } from "../src/leases.js";
import { countToolStarts, type AgentSpec } from "../src/loop.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../src/model.js";
import { startRun, type TickDeps } from "../src/orchestrator.js";
import { LocalWorkerRuntime } from "../src/worker.js";
import { defineTool } from "../src/tools.js";
import type { WorkflowFn } from "../src/workflow.js";
import type { RecordedEvent } from "../src/events.js";

const pool = createPool();
const SCHEMA = "agent_budgettest";
const store = new PgStateStore(pool, SCHEMA);
const usage = { inputTokens: 1, outputTokens: 1 };

/** First call asks for the tool; second call reports whatever the tool said. */
class ToolThenDone implements ModelProvider {
  seen: string[] = [];
  async complete(req: ModelRequest): Promise<ModelResponse> {
    const last = req.messages.at(-1)!;
    const toolResult = last.content.find((b) => b.type === "toolResult");
    if (toolResult && toolResult.type === "toolResult") {
      this.seen.push(toolResult.content);
      return { content: [{ type: "text", text: `model saw: ${toolResult.content}` }], stopReason: "endTurn", usage };
    }
    return { content: [{ type: "toolUse", id: "tb1", name: "slow", input: {} }], stopReason: "toolUse", usage };
  }
}

const slow = defineTool({
  name: "slow",
  description: "sleeps longer than its budget",
  input: z.object({}),
  effects: "none", idempotency: "keyed", approval: "never",
  timeoutMs: 100,
  handler: async () => { await new Promise((r) => setTimeout(r, 2_000)); return "finished late"; },
});

const wf: WorkflowFn = async (ctx) => {
  const w = await ctx.wave("main", [ctx.task("main", ctx.input)]);
  return w.results[0]?.output ?? "";
};

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "budgettest"); });
  await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.blobs, ${SCHEMA}.runs CASCADE`);
  await pool.query(`TRUNCATE toren_control.queue_messages, toren_control.dead_letters`);
});
afterAll(async () => { await pool.end(); });

test("timeoutMs: a stuck tool fails fast with an error the model sees; the run completes", { timeout: 30_000 }, async () => {
  const provider = new ToolThenDone();
  const spec: AgentSpec = { model: "mock/m", system: "s", tools: [slow], maxTokens: 50, maxSteps: 5 };
  const deps: TickDeps = { store, queue: new PgQueue(pool), leases: new PgLeases(pool, SCHEMA), provider, agents: { main: spec }, workflows: { main: wf } };
  const worker = new LocalWorkerRuntime({ budgettest: deps }, { concurrency: 1 });
  worker.start();
  try {
    const runId = await startRun(deps, { agent: "budgettest", input: "go" });
    await worker.drain(15_000);
    const run = (await store.getRun(runId))!;
    expect(run.status).toBe("completed");
    expect(String(run.output)).toContain("timed out after 100ms");
    expect(provider.seen[0]).toContain("timeoutMs budget");
    // the timeout is a recorded tool result, not a crash: exactly one start, one completion, isError
    const events = await store.read(runId, "task:w0t0");
    const starts = events.filter((e) => e.type === "ToolCallStarted");
    const done = events.filter((e) => e.type === "ToolCallCompleted");
    expect(starts.length).toBe(1);
    expect(done.length).toBe(1);
    expect(done[0]!.payload.isError).toBe(true);
  } finally {
    await worker.stop();
  }
});

test("countToolStarts counts crash-window re-runs of the same call", () => {
  const ev = (type: string, toolUseId: string, seq: number) => ({ seq, type, payload: { toolUseId }, streamId: "task:w0t0", recordedAt: new Date() }) as unknown as RecordedEvent;
  const events = [ev("ToolCallStarted", "a", 1), ev("ToolCallStarted", "a", 2), ev("ToolCallStarted", "b", 3), ev("ToolCallCompleted", "b", 4)];
  expect(countToolStarts(events, "a")).toBe(2);
  expect(countToolStarts(events, "b")).toBe(1);
  expect(countToolStarts(events, "zzz")).toBe(0);
});
