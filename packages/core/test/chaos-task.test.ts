import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type pg from "pg";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";
import { MockProvider } from "../src/providers/mock.js";
import { defineTool } from "../src/tools.js";
import { runTaskLoop, type TaskLoopArgs } from "../src/loop.js";

const pool = createPool();
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

const SCRIPT = () => [
  { content: [{ type: "toolUse" as const, id: "tu1", name: "lookup", input: { q: "toren" } }], stopReason: "toolUse" as const },
  { content: [{ type: "text" as const, text: "done" }], stopReason: "endTurn" as const },
];

/** Counts appends; optionally throws AFTER the k-th successful append lands. */
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

function argsFor(store: PgStateStore, provider: MockProvider, runId: string): TaskLoopArgs {
  return {
    store, provider, runId, taskId: "t1",
    agent: { model: "mock/m", system: "You are a test agent.", tools: [lookup], maxTokens: 1000, maxSteps: 20 },
    input: "find the fact",
  };
}

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "chaostest"); });
});
afterAll(async () => { await pool.end(); });

test("kill after every append point: resume never re-pays a completed LLM call", async () => {
  // Baseline: learn the append count and expected output.
  toolRuns = 0;
  const baselineStore = new CrashingStore(pool, "agent_chaostest");
  const baselineRun = randomUUID();
  await baselineStore.createRun({ runId: baselineRun, agent: "chaostest" });
  const baselineProvider = new MockProvider(SCRIPT());
  const baseline = await runTaskLoop(argsFor(baselineStore, baselineProvider, baselineRun));
  expect(baseline.status).toBe("completed");
  if (baseline.status === "completed") expect(baseline.output).toBe("done");
  const N = baselineStore.appends;
  expect(N).toBeGreaterThanOrEqual(6);

  for (let k = 1; k <= N; k++) {
    toolRuns = 0;
    const runId = randomUUID();
    const crashing = new CrashingStore(pool, "agent_chaostest", k);
    await crashing.createRun({ runId, agent: "chaostest" });

    const first = new MockProvider(SCRIPT());
    let crashed = false;
    try {
      const r = await runTaskLoop(argsFor(crashing, first, runId));
      // crash after the final append can still surface as a normal return
      expect(r.status).toBe("completed");
    } catch (e) {
      expect((e as Error).message).toBe("SimulatedCrash");
      crashed = true;
    }

    // Resume on a healthy store. The provider plays the REMAINING script: a
    // correctly-replaying loop asks only for steps the first attempt never consumed.
    const healthy = new PgStateStore(pool, "agent_chaostest");
    const second = new MockProvider(SCRIPT().slice(first.calls));
    const resumed = await runTaskLoop(argsFor(healthy, second, runId));

    expect(resumed.status, `kill point ${k}/${N} (crashed=${crashed})`).toBe("completed");
    if (resumed.status === "completed") expect(resumed.output).toBe("done");
    // THE invariant: across both attempts, each LLM step was paid for exactly once.
    expect(first.calls + second.calls, `provider calls at kill point ${k}/${N}`).toBe(2);
    // The keyed tool executed exactly once across both attempts.
    expect(toolRuns, `tool runs at kill point ${k}/${N}`).toBe(1);
  }
});
