import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import {
  createPool, tx, migrateControl, provisionAgent,
  PgStateStore, PgQueue, PgLeases,
  LocalWorkerRuntime, startRun, sweep, effectiveEvents, defineTool,
  type AgentSpec, type TickDeps, type WorkflowFn, type RecordedEvent,
} from "@toren-run/core";
import { RouterProvider } from "../src/router.js";

/**
 * Longer live session (needs ANTHROPIC_API_KEY): planner → dynamic research
 * fan-out (from the model's own plan) → memo, with real tool calls, killed
 * mid-research and recovered. Verifies output quality signals and that no
 * completed call is ever re-issued. Costs ~8-10 short Opus calls.
 */
const KEY = !!process.env.ANTHROPIC_API_KEY;
const pool = createPool();
const SCHEMA = "agent_livememo";
let store: PgStateStore;

const MODEL = "anthropic/claude-opus-5";

const searchWeb = defineTool({
  name: "search_web",
  description: "Search the web for current facts on a query. Use once before answering.",
  input: z.object({ query: z.string() }),
  effects: "external",
  idempotency: "keyed",
  approval: "never",
  handler: async ({ query }) =>
    `[stub search results for "${query}": industry reports from 2025-2026 show steady growth, falling costs, and early regulatory support in the EU and US]`,
});

const planner: AgentSpec = {
  model: MODEL, maxTokens: 400, maxSteps: 4, tools: [],
  system: "You are a research planner. Output ONLY a numbered list of exactly 3 short, distinct research questions for the brief. No preamble.",
};
const researcher: AgentSpec = {
  model: MODEL, maxTokens: 500, maxSteps: 6, tools: [searchWeb],
  system: "You are a researcher. Use the search_web tool once, then answer the question in 2-3 crisp sentences grounded in the results.",
};
const writer: AgentSpec = {
  model: MODEL, maxTokens: 1200, maxSteps: 4, tools: [],
  system: "You are a memo writer. Compose a clear internal memo (200-350 words) with a title, 3 short sections matching the findings, and a one-sentence bottom line.",
};

const wf: WorkflowFn = async (ctx) => {
  const plan = await ctx.wave("plan", [ctx.task("planner", `Brief: ${ctx.input}`)]);
  const questions = (plan.results[0]!.output ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter((l) => l.length > 10)
    .slice(0, 3);
  if (questions.length === 0) throw new Error("planner produced no questions");

  const research = await ctx.wave(
    "research",
    questions.map((q) => ctx.task("researcher", q)),
    { onTaskFailure: "collect" },
  );

  const findings = research.results
    .map((r, i) => `Q${i + 1}: ${questions[i]}\nFinding: ${r.output ?? `(failed: ${r.error})`}`)
    .join("\n\n");

  const memo = await ctx.wave("memo", [ctx.task("writer", `Brief: ${ctx.input}\n\nFindings:\n${findings}`)]);
  return memo.results[0]!.output ?? "";
};

function makeDeps(): TickDeps {
  return {
    store, queue: new PgQueue(pool), leases: new PgLeases(pool, SCHEMA),
    provider: new RouterProvider(),
    agents: { planner, researcher, writer },
    workflows: { memo: wf },
  };
}

beforeAll(async () => {
  if (!KEY) return;
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "livememo"); });
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

test.skipIf(!KEY)("live memo pipeline: dynamic fan-out, tools, mid-run kill, quality checks", { timeout: 600_000 }, async () => {
  const deps1 = makeDeps();
  const worker1 = new LocalWorkerRuntime(deps1, { concurrency: 3 });
  worker1.start();
  const runId = await startRun(deps1, {
    agent: "memo",
    input: "State of decarbonized freight in 2026: what should a logistics fund know this quarter?",
  });

  // Abandon mid-research: once >=2 research-wave tasks have a completed call.
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const streams = await taskStreams(runId);
    const researchDone = [...streams.entries()]
      .filter(([id]) => id.startsWith("w1"))
      .filter(([, ev]) => ev.some((e) => e.type === "LlmCallCompleted")).length;
    if (researchDone >= 2) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await worker1.stop();
  expect((await store.getRun(runId))!.status).not.toBe("completed");

  // Lose the queue too, recover on a fresh stack.
  await pool.query(`TRUNCATE toren_control.queue_messages`);
  const deps2 = makeDeps();
  await sweep(deps2);
  const worker2 = new LocalWorkerRuntime(deps2, { concurrency: 3 });
  worker2.start();
  try {
    const done = Date.now() + 300_000;
    while (Date.now() < done) {
      if ((await store.getRun(runId))!.status === "completed") break;
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    await worker2.stop();
  }

  const run = await store.getRun(runId);
  expect(run!.status).toBe("completed");
  const memo = String(run!.output);

  // Quality signals: substantial, structured, on-topic.
  expect(memo.length).toBeGreaterThan(600);
  expect(memo.toLowerCase()).toMatch(/freight|logistics|decarboni/);

  // Durability invariants across both stacks.
  let calls = 0, toolCalls = 0, inTok = 0, outTok = 0;
  for (const [taskId, events] of await taskStreams(runId)) {
    const started = events.filter((e) => e.type === "LlmCallStarted");
    const distinct = new Set(started.map((e) => String(e.payload.stepId)));
    expect(started.length, `task ${taskId}: re-issued a completed call`).toBe(distinct.size);
    calls += started.length;
    toolCalls += events.filter((e) => e.type === "ToolCallCompleted").length;
    for (const e of events.filter((x) => x.type === "LlmCallCompleted")) {
      const u = e.payload.usage as { inputTokens: number; outputTokens: number } | undefined;
      inTok += u?.inputTokens ?? 0;
      outTok += u?.outputTokens ?? 0;
    }
  }
  expect(toolCalls).toBeGreaterThanOrEqual(2); // researchers really used the tool
  console.log(`LIVE MEMO (${memo.length} chars):\n${memo}`);
  console.log(`LIVE STATS: ${calls} model calls (each paid once), ${toolCalls} tool calls, ${inTok} in / ${outTok} out tokens`);
});
