import { beforeAll, afterAll, expect, test } from "vitest";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";
import { ev } from "../src/events.js";
import {
  InvalidationStormError, INVALIDATION_STORM_LIMIT, runTaskLoop, type AgentSpec,
} from "../src/loop.js";
import type { ModelProvider, ModelResponse } from "../src/model.js";

const pool = createPool();
const SCHEMA = "agent_guardtest";
let store: PgStateStore;

class FinalAnswer implements ModelProvider {
  calls = 0;
  async complete(): Promise<ModelResponse> {
    this.calls += 1;
    return { content: [{ type: "text", text: "done" }], stopReason: "endTurn", usage: { inputTokens: 5, outputTokens: 5 } };
  }
}

const agent: AgentSpec = { model: "mock/m", system: "sys", tools: [], maxTokens: 100, maxSteps: 5 };

let seq = 0;
async function stagedRun(): Promise<string> {
  const runId = `00000000-0000-4000-a000-${String(++seq).padStart(12, "0")}`;
  await store.createRun({ runId, agent: "guardtest", input: "go" });
  // A recorded call whose digest can never match the live request, plus a
  // history of invalidations: the mixed-version war signature.
  await store.append(runId, "task:t1", 0, [
    ev("TaskStarted", { attempt: 1 }),
    ev("LlmCallStarted", { stepId: "s2", requestDigest: "bogus-from-other-version", model: "mock/m" }),
  ]);
  let head = 2;
  for (let i = 0; i < INVALIDATION_STORM_LIMIT; i++) {
    const r = await store.append(runId, "task:t1", head, [ev("StreamInvalidated", { fromSeq: 9999, reason: "request digest mismatch (prompt or code changed)" })]);
    if (!r.ok) throw new Error("staging failed");
    head = r.lastSeq;
  }
  return runId;
}

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "guardtest"); });
  await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.blobs, ${SCHEMA}.runs CASCADE`);
  store = new PgStateStore(pool, SCHEMA);
});
afterAll(async () => { await pool.end(); });

test("a stream with a fresh invalidation storm defers instead of invalidating again", async () => {
  const runId = await stagedRun();
  const provider = new FinalAnswer();
  await expect(
    runTaskLoop({ store, provider, runId, taskId: "t1", agent, input: "go" }),
  ).rejects.toThrow(InvalidationStormError);
  // Deferring pays nothing and writes no new invalidation.
  expect(provider.calls).toBe(0);
  const raw = await store.read(runId, "task:t1");
  expect(raw.filter((e) => e.type === "StreamInvalidated").length).toBe(INVALIDATION_STORM_LIMIT);
});

test("aged invalidations do not trip the guard: the mismatch re-derives normally", async () => {
  const runId = await stagedRun();
  await pool.query(
    `UPDATE ${SCHEMA}.events SET recorded_at = now() - interval '30 minutes' WHERE run_id = $1 AND type = 'StreamInvalidated'`,
    [runId],
  );
  const provider = new FinalAnswer();
  const r = await runTaskLoop({ store, provider, runId, taskId: "t1", agent, input: "go" });
  expect(r.status).toBe("completed");
  expect(provider.calls).toBe(1);
  const raw = await store.read(runId, "task:t1");
  expect(raw.filter((e) => e.type === "StreamInvalidated").length).toBe(INVALIDATION_STORM_LIMIT + 1);
});
