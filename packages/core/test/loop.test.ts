import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";
import { MockProvider } from "../src/providers/mock.js";
import { defineTool } from "../src/tools.js";
import { runTaskLoop, type TaskLoopArgs } from "../src/loop.js";

const pool = createPool();
let store: PgStateStore;
let toolRuns = 0;

const lookup = defineTool({
  name: "lookup",
  description: "Look up a fact.",
  input: z.object({ q: z.string() }),
  effects: "external",
  idempotency: "keyed",
  approval: "never",
  handler: async ({ q }) => { toolRuns += 1; return `fact:${q}`; },
});

const gated = defineTool({
  name: "send_report",
  description: "Send the report.",
  input: z.object({ to: z.string() }),
  effects: "external",
  idempotency: "keyed",
  approval: "always",
  handler: async ({ to }) => `sent to ${to}`,
});

const SCRIPT = () => [
  { content: [{ type: "toolUse" as const, id: "tu1", name: "lookup", input: { q: "toren" } }], stopReason: "toolUse" as const },
  { content: [{ type: "text" as const, text: "done" }], stopReason: "endTurn" as const },
];

function taskArgs(provider: MockProvider, runId: string, taskId: string): TaskLoopArgs {
  return {
    store, provider, runId, taskId,
    agent: { model: "mock/m", system: "You are a test agent.", tools: [lookup, gated], maxTokens: 1000, maxSteps: 20 },
    input: "find the fact",
  };
}

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "looptest"); });
  store = new PgStateStore(pool, "agent_looptest");
});
afterAll(async () => { await pool.end(); });

async function newRun(): Promise<string> {
  const runId = randomUUID();
  await store.createRun({ runId, agent: "looptest" });
  return runId;
}

test("happy path: llm -> tool -> llm -> completed", async () => {
  toolRuns = 0;
  const runId = await newRun();
  const p = new MockProvider(SCRIPT());
  const r = await runTaskLoop(taskArgs(p, runId, "t1"));
  expect(r.status).toBe("completed");
  expect(p.calls).toBe(2);
  expect(toolRuns).toBe(1);
});

test("resume replays completed steps: zero provider calls, zero tool re-runs", async () => {
  toolRuns = 0;
  const runId = await newRun();
  await runTaskLoop(taskArgs(new MockProvider(SCRIPT()), runId, "t1"));
  const again = new MockProvider([]); // any provider call would throw
  const r = await runTaskLoop(taskArgs(again, runId, "t1"));
  expect(r.status).toBe("completed");
  if (r.status === "completed") expect(r.output).toBe("done");
  expect(again.calls).toBe(0);
  expect(toolRuns).toBe(1); // keyed tool not re-executed
});

test("changed system prompt invalidates surgically and re-executes", async () => {
  const runId = await newRun();
  await runTaskLoop(taskArgs(new MockProvider(SCRIPT()), runId, "t1"));
  const fresh = new MockProvider(SCRIPT());
  const args = taskArgs(fresh, runId, "t1");
  args.agent = { ...args.agent, system: "You are a DIFFERENT agent." };
  const r = await runTaskLoop(args);
  expect(r.status).toBe("completed");
  expect(fresh.calls).toBe(2); // everything after the divergence re-ran
  const events = await store.read(runId, "task:t1");
  expect(events.some((e) => e.type === "StreamInvalidated")).toBe(true);
});

test("approval parks the task, resolution resumes it", async () => {
  const runId = await newRun();
  const p = new MockProvider([
    { content: [{ type: "toolUse", id: "tu9", name: "send_report", input: { to: "ceo" } }], stopReason: "toolUse" },
    { content: [{ type: "text", text: "sent" }], stopReason: "endTurn" },
  ]);
  const args = taskArgs(p, runId, "t2");
  const parked = await runTaskLoop(args);
  expect(parked.status).toBe("waitingApproval");

  // approvals API appends the resolution (holds the task lease while parked)
  const events = await store.read(runId, "task:t2");
  const req = events.find((e) => e.type === "ApprovalRequested")!;
  await store.append(runId, "task:t2", events.at(-1)!.seq, [
    { type: "ApprovalResolved", payload: { v: 1, stepId: req.payload.stepId, granted: true, by: "founder" } },
  ]);

  const resumed = await runTaskLoop({ ...args, provider: p });
  expect(resumed.status).toBe("completed");
});
