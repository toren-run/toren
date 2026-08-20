import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";
import { effectiveEvents } from "../src/fold.js";
import { createWorkflowCtx, makeSession, WorkflowBlocked, type RunSession } from "../src/workflow.js";

const pool = createPool();
let store: PgStateStore;

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "wftest"); });
  store = new PgStateStore(pool, "agent_wftest");
});
afterAll(async () => { await pool.end(); });

async function freshSession(runId: string): Promise<RunSession> {
  const raw = await store.read(runId, "run");
  return makeSession(store, runId, "in", raw, effectiveEvents(raw));
}

async function newRun(): Promise<string> {
  const runId = randomUUID();
  await store.createRun({ runId, agent: "wftest" });
  return runId;
}

test("now/random record once and replay stably", async () => {
  const runId = await newRun();
  const s1 = await freshSession(runId);
  const ctx1 = createWorkflowCtx(s1);
  const n1 = await ctx1.now();
  const r1 = await ctx1.random();

  const s2 = await freshSession(runId);
  const ctx2 = createWorkflowCtx(s2);
  expect(await ctx2.now()).toBe(n1);
  expect(await ctx2.random()).toBe(r1);
  // no new events on replay
  expect(s2.head).toBe(s1.head);
});

test("sleep(0) fires immediately; sleep(long) blocks with a delayed nudge", async () => {
  const runId = await newRun();
  const ctx = createWorkflowCtx(await freshSession(runId));
  await ctx.sleep(0); // TimerSet + TimerFired, no block

  const s = await freshSession(runId);
  const ctx2 = createWorkflowCtx(s);
  await ctx2.sleep(0); // replayed
  await expect(ctx2.sleep(60_000)).rejects.toThrow(WorkflowBlocked);
  expect(s.pendingDispatch.some((d) => d.msg.kind === "tick" && (d.delaySeconds ?? 0) > 0)).toBe(true);
});

test("wave plans, dispatches, blocks; settles from recorded outcomes; digest change invalidates", async () => {
  const runId = await newRun();
  const s1 = await freshSession(runId);
  const ctx1 = createWorkflowCtx(s1);
  await expect(ctx1.wave("research", [ctx1.task("researcher", "topicA")])).rejects.toThrow(WorkflowBlocked);
  expect(s1.pendingDispatch.filter((d) => d.msg.kind === "task").length).toBe(1);

  // simulate absorption of the task terminal
  const raw = await store.read(runId, "run");
  await store.append(runId, "run", raw.at(-1)!.seq, [
    { type: "WaveTaskSettled", payload: { v: 1, waveId: "w0", taskId: "w0t0", status: "completed", output: "found" } },
  ]);

  const s2 = await freshSession(runId);
  const ctx2 = createWorkflowCtx(s2);
  const result = await ctx2.wave("research", [ctx2.task("researcher", "topicA")]);
  expect(result.results).toEqual([{ taskId: "w0t0", status: "completed", output: "found", error: undefined }]);

  // changed plan → invalidation + fresh plan
  const s3 = await freshSession(runId);
  const ctx3 = createWorkflowCtx(s3);
  await expect(ctx3.wave("research", [ctx3.task("researcher", "DIFFERENT")])).rejects.toThrow(WorkflowBlocked);
  const events = await store.read(runId, "run");
  expect(events.some((e) => e.type === "StreamInvalidated")).toBe(true);
  expect(events.filter((e) => e.type === "WavePlanned").length).toBe(2);
});
