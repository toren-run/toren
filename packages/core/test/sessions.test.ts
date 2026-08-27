import { afterAll, beforeAll, expect, test } from "vitest";
import type pg from "pg";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";
import { PgQueue } from "../src/queue.js";
import { PgLeases } from "../src/leases.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../src/model.js";
import type { AgentSpec } from "../src/loop.js";
import type { TickDeps } from "../src/orchestrator.js";
import { LocalWorkerRuntime } from "../src/worker.js";
import { sweep } from "../src/guardians.js";
import {
  getSession, listSessions, SessionBusyError, sendSessionMessage, startSession,
} from "../src/conversations.js";
import type { WorkflowFn } from "../src/workflow.js";

const pool = createPool();
const SCHEMA = "agent_sesstest";

/** Replies deterministically to the LAST user message; counts paid calls per reply key. */
class TurnProvider implements ModelProvider {
  calls = new Map<string, number>();
  constructor(private script: Record<string, string>) {}
  async complete(req: ModelRequest): Promise<ModelResponse> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content.find((b) => b.type === "text");
    const key = text && text.type === "text" ? text.text : "?";
    this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
    const reply = this.script[key] ?? `echo(${key})`;
    return { content: [{ type: "text", text: reply }], stopReason: "endTurn", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const spec: AgentSpec = { model: "mock/m", system: "sys", tools: [], maxTokens: 100, maxSteps: 2 };
const wf: WorkflowFn = async (ctx) => {
  const w = await ctx.wave("main", [ctx.task("main", ctx.input)]);
  return w.results[0]?.output ?? "";
};

function makeDeps(store: PgStateStore, provider: ModelProvider): TickDeps {
  return { store, queue: new PgQueue(pool), leases: new PgLeases(pool, SCHEMA), provider, agents: { main: spec }, workflows: { main: wf } };
}

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "sesstest"); });
  await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.blobs, ${SCHEMA}.runs CASCADE`);
  await pool.query(`TRUNCATE toren_control.queue_messages, toren_control.dead_letters`);
});
afterAll(async () => { await pool.end(); });

test("multi-turn session: parks per turn at zero compute, transcript folds, close completes the run", async () => {
  const provider = new TurnProvider({
    "hi": "Hello! What do you need?",
    "what is toren": "A durable agent runtime.",
  });
  const deps = makeDeps(new PgStateStore(pool, SCHEMA), provider);
  const worker = new LocalWorkerRuntime({ sess: deps }, { concurrency: 1 });
  worker.start();
  try {
    const runId = await startSession(deps, { agent: "sess", message: "hi" });
    await worker.drain(15_000);

    let s = (await getSession(deps.store, runId))!;
    expect(s.state).toBe("awaiting_input");
    expect(s.transcript.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(s.transcript[1]!.text).toBe("Hello! What do you need?");

    await sendSessionMessage(deps, runId, { text: "what is toren", channel: "api" });
    await worker.drain(15_000);

    s = (await getSession(deps.store, runId))!;
    expect(s.state).toBe("awaiting_input");
    expect(s.transcript.map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(s.transcript[2]!.channel).toBe("api");
    expect(s.transcript[3]!.text).toBe("A durable agent runtime.");

    await sendSessionMessage(deps, runId, { text: "", close: true });
    await worker.drain(15_000);

    s = (await getSession(deps.store, runId))!;
    expect(s.state).toBe("completed");
    expect((await deps.store.getRun(runId))!.status).toBe("completed");
    // exactly-once billing per turn
    expect(provider.calls.get("hi")).toBe(1);
    expect(provider.calls.get("what is toren")).toBe(1);
    // sessions listable
    expect((await listSessions(deps.store)).some((r) => r.runId === runId)).toBe(true);
  } finally {
    await worker.stop();
  }
});

test("strict turn-taking: a second message while the agent owes no reply is rejected", async () => {
  const provider = new TurnProvider({ "start": "ok — thinking done" });
  const deps = makeDeps(new PgStateStore(pool, SCHEMA), provider);
  const worker = new LocalWorkerRuntime({ sess: deps }, { concurrency: 1 });
  worker.start();
  try {
    const runId = await startSession(deps, { agent: "sess", message: "start" });
    await worker.drain(15_000);
    await sendSessionMessage(deps, runId, { text: "first" });
    // Agent hasn't produced its next InputRequested yet — the floor is not ours.
    await expect(sendSessionMessage(deps, runId, { text: "second" })).rejects.toThrow(SessionBusyError);
  } finally {
    await worker.stop();
  }
});

test("per-turn step budget: a 4-turn conversation passes with maxSteps 2", async () => {
  const provider = new TurnProvider({});
  const deps = makeDeps(new PgStateStore(pool, SCHEMA), provider);
  const worker = new LocalWorkerRuntime({ sess: deps }, { concurrency: 1 });
  worker.start();
  try {
    const runId = await startSession(deps, { agent: "sess", message: "t1" });
    await worker.drain(15_000);
    for (const msg of ["t2", "t3", "t4"]) {
      await sendSessionMessage(deps, runId, { text: msg });
      await worker.drain(15_000);
    }
    const s = (await getSession(deps.store, runId))!;
    expect(s.state).toBe("awaiting_input");
    expect(s.transcript.filter((t) => t.role === "assistant").length).toBe(4);
  } finally {
    await worker.stop();
  }
});

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

test("session kill matrix: crash after every write across a 2-turn conversation — every turn paid once, transcript intact", { timeout: 300_000 }, async () => {
  const SCRIPT: [string, { close?: boolean }][] = [["turn-two", {}], ["", { close: true }]];

  async function drive(deps: TickDeps, existingRunId?: string): Promise<string> {
    // Resumable driver: starts (or adopts) the session and pushes the script
    // forward whenever the agent yields the floor.
    const worker = new LocalWorkerRuntime({ sess: deps }, { concurrency: 1 });
    worker.start();
    try {
      const runId = existingRunId ?? (await startSession(deps, { agent: "sess", message: "turn-one" }));
      for (let i = 0; i < 25; i++) {
        await worker.drain(15_000);
        const s = await getSession(deps.store, runId);
        if (!s) throw new Error("session vanished");
        if (s.state === "completed") return runId;
        if (s.state === "failed") throw new Error("session failed");
        if (s.state === "awaiting_input") {
          const userTurns = s.transcript.filter((t) => t.role === "user").length;
          const next = SCRIPT[userTurns - 1];
          if (!next) throw new Error("script exhausted but session not complete");
          await sendSessionMessage(deps, runId, { text: next[0], ...next[1] });
        }
      }
      throw new Error("conversation did not complete");
    } finally {
      await worker.stop();
    }
  }

  // Baseline: count appends across one full clean conversation.
  await pool.query(`TRUNCATE toren_control.queue_messages`);
  const baseStore = new CrashingStore(pool, SCHEMA);
  const baseProvider = new TurnProvider({});
  await drive(makeDeps(baseStore, baseProvider));
  const N = baseStore.appends;
  expect(N).toBeGreaterThanOrEqual(8);
  expect(baseProvider.calls.get("turn-one")).toBe(1);
  expect(baseProvider.calls.get("turn-two")).toBe(1);

  for (let k = 1; k <= N; k++) {
    await pool.query(`TRUNCATE toren_control.queue_messages`);
    const provider = new TurnProvider({}); // shared across crash + recovery
    let runId: string | undefined;
    try {
      runId = await drive(makeDeps(new CrashingStore(pool, SCHEMA, k), provider));
    } catch {
      /* crashed mid-conversation — recover below */
    }
    await pool.query(`TRUNCATE toren_control.queue_messages`);
    const healthy = makeDeps(new PgStateStore(pool, SCHEMA), provider);
    await sweep(healthy, "sess");
    if (!runId) {
      const open = await healthy.store.listNonTerminalRuns();
      runId = open.at(-1); // the crashed conversation (if the run was created at all)
    }
    if (runId) {
      await drive(healthy, runId);
      const s = (await getSession(healthy.store, runId))!;
      expect(s.state, `kill point ${k}/${N}`).toBe("completed");
      expect(s.transcript.filter((t) => t.role === "assistant").length, `kill point ${k}/${N}`).toBe(2);
    }
    // THE invariant: no turn's model call is ever paid twice.
    for (const turn of ["turn-one", "turn-two"]) {
      expect(provider.calls.get(turn) ?? 0, `paid calls for "${turn}" at kill point ${k}/${N}`).toBeLessThanOrEqual(1);
    }
    if (runId) {
      expect(provider.calls.get("turn-one"), `kill point ${k}`).toBe(1);
      expect(provider.calls.get("turn-two"), `kill point ${k}`).toBe(1);
    }
  }
});

test("sessions bypass a crew's custom workflow: chatting with a JSON-parsing batch crew works", async () => {
  const explosive: WorkflowFn = async (ctx) => {
    JSON.parse(ctx.input); // batch contract: input must be JSON — a chat "hi" would explode
    return "batch";
  };
  const provider = new TurnProvider({ "hi": "hello from the root agent" });
  const deps = { ...makeDeps(new PgStateStore(pool, SCHEMA), provider), workflows: { main: explosive } };
  const worker = new LocalWorkerRuntime({ sess: deps }, { concurrency: 1 });
  worker.start();
  try {
    const runId = await startSession(deps, { agent: "sess", message: "hi" });
    await worker.drain(15_000);
    const s = (await getSession(deps.store, runId))!;
    expect(s.state).toBe("awaiting_input");
    expect(s.transcript[1]!.text).toBe("hello from the root agent");
  } finally {
    await worker.stop();
  }
});

test("maxAttemptsPerTask counts faults, not conversation turns: a capped session survives past the cap", { timeout: 30_000 }, async () => {
  // field report 2026-08-27: maxAttemptsPerTask: 5 silently killed every
  // conversation at turn 6, because turns counted as attempts.
  const provider = new TurnProvider({});
  const deps = makeDeps(new PgStateStore(pool, SCHEMA), provider);
  (deps.agents.main as AgentSpec) = { ...spec, maxTaskAttempts: 3 };
  const worker = new LocalWorkerRuntime({ sess: deps }, { concurrency: 1 });
  worker.start();
  try {
    const runId = await startSession(deps, { agent: "sess", message: "turn 1" });
    await worker.drain(15_000);
    for (let i = 2; i <= 6; i++) {
      await sendSessionMessage(deps, runId, { text: `turn ${i}`, channel: "api" });
      await worker.drain(15_000);
    }
    const s = (await getSession(deps.store, runId))!;
    expect(s.state).toBe("awaiting_input"); // alive well past maxTaskAttempts turns
    expect(s.transcript.filter((t) => t.role === "assistant").length).toBe(6);
    expect((await deps.store.getRun(runId))!.status).not.toBe("failed");
  } finally {
    await worker.stop();
  }
});
