import { afterAll, beforeAll, expect, test } from "vitest";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";
import { ev } from "../src/events.js";
import { runUsage } from "../src/usage.js";

const pool = createPool();
const SCHEMA = "agent_usagetest";
const store = new PgStateStore(pool, SCHEMA);
const RUN = "0000a0b0-0000-4000-8000-000000000001";

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "usagetest"); });
  await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.runs CASCADE`);
  await store.createRun({ runId: RUN, agent: "usagetest", input: "go" });
  await store.append(RUN, "run", 0, [
    ev("RunCreated", { agent: "usagetest", input: "go" }),
    ev("WavePlanned", { waveId: "w0", name: "main", tasks: [{ taskId: "w0t0", agentRef: "main", input: "go" }] }),
  ]);
  await store.append(RUN, "task:w0t0", 0, [
    ev("TaskStarted", { attempt: 1 }),
    ev("LlmCallStarted", { stepId: "s1", requestDigest: "d1", model: "openai/gpt-4o" }),
    ev("LlmCallCompleted", { stepId: "s1", response: {}, usage: { inputTokens: 1_000_000, outputTokens: 0 } }),
    ev("TaskStarted", { attempt: 2 }), // a crash: this attempt replays s1 from the log
    ev("LlmCallStarted", { stepId: "s2", requestDigest: "d2", model: "openai/gpt-4o" }),
    ev("LlmCallCompleted", { stepId: "s2", response: {}, usage: { inputTokens: 0, outputTokens: 500_000 } }),
  ]);
});
afterAll(async () => { await pool.end(); });

test("runUsage tallies tokens, dollars, and what the resume did not re-pay", async () => {
  const u = await runUsage(store, RUN);
  expect(u.totalCalls).toBe(2);
  expect(u.models["openai/gpt-4o"]).toEqual({ calls: 2, inputTokens: 1_000_000, outputTokens: 500_000 });
  // gpt-4o: $2.50/MTok in, $10/MTok out
  expect(u.estCostUsd).toBeCloseTo(2.5 + 5.0, 5);
  expect(u.replayedCalls).toBe(1);
  expect(u.replaySavingsUsd).toBeCloseTo(2.5, 5);
});

test("unknown models report tokens without inventing dollars; TOREN_MODEL_PRICES fills them in", async () => {
  const RUN2 = "0000a0b0-0000-4000-8000-000000000002";
  await store.createRun({ runId: RUN2, agent: "usagetest", input: "x" });
  await store.append(RUN2, "run", 0, [ev("WavePlanned", { waveId: "w0", name: "main", tasks: [{ taskId: "w0t0", agentRef: "main", input: "x" }] })]);
  await store.append(RUN2, "task:w0t0", 0, [
    ev("TaskStarted", { attempt: 1 }),
    ev("LlmCallStarted", { stepId: "s1", requestDigest: "d", model: "openai/gpt-9-hypothetical" }),
    ev("LlmCallCompleted", { stepId: "s1", response: {}, usage: { inputTokens: 2_000_000, outputTokens: 0 } }),
  ]);
  const bare = await runUsage(store, RUN2);
  expect(bare.estCostUsd).toBeUndefined();
  expect(bare.models["openai/gpt-9-hypothetical"]!.inputTokens).toBe(2_000_000);

  process.env.TOREN_MODEL_PRICES = JSON.stringify({ "openai/gpt-9-hypothetical": { in: 3, out: 12 } });
  try {
    const priced = await runUsage(store, RUN2);
    expect(priced.estCostUsd).toBeCloseTo(6.0, 5);
  } finally {
    delete process.env.TOREN_MODEL_PRICES;
  }
});
