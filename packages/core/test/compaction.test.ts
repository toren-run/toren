import { beforeAll, afterAll, expect, test } from "vitest";
import type pg from "pg";
import { z } from "zod";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";
import { effectiveEvents } from "../src/fold.js";
import { ev } from "../src/events.js";
import { defineTool } from "../src/tools.js";
import {
  runTaskLoop, SUMMARIZE_SYSTEM,
  COMPACT_KEEP_RESULTS, COMPACT_KEEP_TAIL,
  type AgentSpec,
} from "../src/loop.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../src/model.js";

const pool = createPool();
const SCHEMA = "agent_compacttest";
let store: PgStateStore;

const lookup = defineTool({
  name: "lookup",
  description: "Look something up.",
  input: z.object({ q: z.string() }),
  effects: "none",
  idempotency: "keyed",
  approval: "never",
  handler: async ({ q }) => `${"R".repeat(880)} :: ${q}`,
});

const smallLookup = defineTool({ ...lookup, handler: async ({ q }: { q: string }) => `${"r".repeat(380)} :: ${q}` });

function agentSpec(over: Partial<AgentSpec>): AgentSpec {
  return { model: "mock/m", system: "sys", tools: [lookup], maxTokens: 500, maxSteps: 20, ...over };
}

/**
 * Scripted provider: N tool steps then a final answer. Usage is derived from the
 * actual request size (chars/3), like a real provider, so a fold genuinely
 * shrinks the reported context on the next call.
 */
class CompactProvider implements ModelProvider {
  requests: ModelRequest[] = [];
  summaryCalls = 0;
  constructor(private toolSteps: number) {}
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    if (req.system === SUMMARIZE_SYSTEM) {
      this.summaryCalls += 1;
      return {
        content: [{ type: "text", text: "SUMMARY: task is test; learned q-values; next step: finish." }],
        stopReason: "endTurn", usage: { inputTokens: 50, outputTokens: 30 },
      };
    }
    const n = this.requests.filter((r) => r.system !== SUMMARIZE_SYSTEM).length;
    const usage = { inputTokens: Math.ceil(JSON.stringify(req.messages).length / 3), outputTokens: 10 };
    if (n <= this.toolSteps) {
      return { content: [{ type: "toolUse", id: `tu${n}`, name: "lookup", input: { q: `q${n}` } }], stopReason: "toolUse", usage };
    }
    return { content: [{ type: "text", text: "final answer" }], stopReason: "endTurn", usage };
  }
}

class ThrowingProvider implements ModelProvider {
  async complete(): Promise<ModelResponse> { throw new Error("no model call allowed during pure replay"); }
}

class CrashingStore extends PgStateStore {
  public appends = 0;
  constructor(p: pg.Pool, schema: string, private crashAfter = Number.POSITIVE_INFINITY) { super(p, schema); }
  override async append(...a: Parameters<PgStateStore["append"]>): ReturnType<PgStateStore["append"]> {
    const r = await super.append(...a);
    if (r.ok && ++this.appends >= this.crashAfter) throw new Error("SimulatedCrash");
    return r;
  }
}

let seq = 0;
async function freshRun(): Promise<string> {
  const runId = `00000000-0000-4000-9000-${String(++seq).padStart(12, "0")}`;
  await store.createRun({ runId, agent: "compacttest", input: "start" });
  return runId;
}

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "compacttest"); });
  await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.blobs, ${SCHEMA}.runs CASCADE`);
  store = new PgStateStore(pool, SCHEMA);
});
afterAll(async () => { await pool.end(); });

test("elide tier: old tool results become stubs, recent ones stay, full results stay in the log", async () => {
  const runId = await freshRun();
  const provider = new CompactProvider(6);
  const agent = agentSpec({ contextWindow: 2600 });
  const r = await runTaskLoop({ store, provider, runId, taskId: "t1", agent, input: "start" });
  expect(r.status).toBe("completed");

  const eff = effectiveEvents(await store.read(runId, "task:t1"));
  const elides = eff.filter((e) => e.type === "ContextCompacted" && e.payload.kind === "elide");
  expect(elides.length).toBeGreaterThanOrEqual(1);
  expect(eff.some((e) => e.type === "ContextCompacted" && e.payload.kind === "summary")).toBe(false);

  // The last live request saw stubs for old results and verbatim recent ones.
  const last = provider.requests.at(-1)!;
  const results = last.messages.flatMap((m) => m.role === "user" ? m.content.filter((b) => b.type === "toolResult") : []);
  const stubbed = results.filter((b) => String(b.content).startsWith("[elided:"));
  const verbatim = results.filter((b) => String(b.content).includes("R".repeat(80)));
  expect(stubbed.length).toBeGreaterThanOrEqual(1);
  expect(verbatim.length).toBeGreaterThanOrEqual(COMPACT_KEEP_RESULTS);

  // The event log never loses the full results.
  const recorded = eff.filter((e) => e.type === "ToolCallCompleted");
  expect(recorded.every((e) => String(e.payload.result).length > 800)).toBe(true);
});

test("summary tier: history folds into a recorded summary; task still completes", async () => {
  const runId = await freshRun();
  const provider = new CompactProvider(6);
  const agent = agentSpec({ tools: [smallLookup], contextWindow: 1300 });
  const r = await runTaskLoop({ store, provider, runId, taskId: "t1", agent, input: "start" });
  expect(r.status).toBe("completed");
  expect(r.status === "completed" && r.output).toBe("final answer");
  expect(provider.summaryCalls).toBe(1);

  const eff = effectiveEvents(await store.read(runId, "task:t1"));
  const summaries = eff.filter((e) => e.type === "ContextCompacted" && e.payload.kind === "summary");
  expect(summaries.length).toBe(1);
  expect(String(summaries[0]!.payload.summary)).toContain("SUMMARY:");

  // Requests after the fold start from the summary message and keep the tail verbatim.
  const afterFold = provider.requests.filter((q) => q.system !== SUMMARIZE_SYSTEM).at(-1)!;
  const first = afterFold.messages[0]!;
  expect(first.role).toBe("user");
  expect(JSON.stringify(first.content)).toContain("SUMMARY:");
  expect(afterFold.messages.length).toBeLessThanOrEqual(COMPACT_KEEP_TAIL + 3);
});

test("digest stability: a compacted run replays to completion with zero model calls", async () => {
  const runId = await freshRun();
  const provider = new CompactProvider(6);
  const agent = agentSpec({ tools: [smallLookup], contextWindow: 1300 });
  expect((await runTaskLoop({ store, provider, runId, taskId: "t1", agent, input: "start" })).status).toBe("completed");

  const replayed = await runTaskLoop({ store, provider: new ThrowingProvider(), runId, taskId: "t1", agent, input: "start" });
  expect(replayed.status).toBe("completed");
  expect(replayed.status === "completed" && replayed.output).toBe("final answer");

  // Replay recorded nothing new that matters: still exactly one summary fold.
  const eff = effectiveEvents(await store.read(runId, "task:t1"));
  expect(eff.some((e) => e.type === "StreamInvalidated")).toBe(false);
  expect(eff.filter((e) => e.type === "ContextCompacted" && e.payload.kind === "summary").length).toBe(1);
});

test("kill matrix across the compaction boundary: crash after every write; summary paid at most once", { timeout: 300_000 }, async () => {
  const agent = agentSpec({ tools: [smallLookup], contextWindow: 1300 });
  
  // Baseline: count appends in a clean compacted run.
  const baseRun = await freshRun();
  const baseStore = new CrashingStore(pool, SCHEMA);
  await runTaskLoop({ store: baseStore, provider: new CompactProvider(6), runId: baseRun, taskId: "t1", agent, input: "start" });
  const N = baseStore.appends;
  expect(N).toBeGreaterThanOrEqual(15);

  for (let k = 1; k <= N; k++) {
    const runId = await freshRun();
    // One provider across crash and recovery: its script position advances only
    // on live calls, exactly like a real model bill.
    const provider = new CompactProvider(6);
    try {
      await runTaskLoop({ store: new CrashingStore(pool, SCHEMA, k), provider, runId, taskId: "t1", agent, input: "start" });
    } catch { /* crashed mid-task; recover below */ }
    const r = await runTaskLoop({ store, provider, runId, taskId: "t1", agent, input: "start" });
    expect(r.status, `kill point ${k}/${N}`).toBe("completed");
    expect(r.status === "completed" && r.output, `kill point ${k}/${N}`).toBe("final answer");
    expect(provider.summaryCalls, `summary paid ${provider.summaryCalls}x at kill point ${k}/${N}`).toBeLessThanOrEqual(1);
    const eff = effectiveEvents(await store.read(runId, "task:t1"));
    expect(eff.filter((e) => e.type === "ContextCompacted" && e.payload.kind === "summary").length, `kill point ${k}`).toBe(1);
  }
});

test("session compaction: transcript survives the fold untouched", async () => {
  const runId = `00000000-0000-4000-9000-${String(++seq).padStart(12, "0")}`;
  await store.createRun({ runId, agent: "compacttest", input: "turn 1", mode: "session" });

  // Every reply ends the turn; usage high enough that later turns trigger a fold.
  class SessionProvider implements ModelProvider {
    calls = 0; summaryCalls = 0;
    async complete(req: ModelRequest): Promise<ModelResponse> {
      if (req.system === SUMMARIZE_SYSTEM) {
        this.summaryCalls += 1;
        return { content: [{ type: "text", text: "SUMMARY: chat so far." }], stopReason: "endTurn", usage: { inputTokens: 40, outputTokens: 20 } };
      }
      this.calls += 1;
      return { content: [{ type: "text", text: `reply ${this.calls}` }], stopReason: "endTurn", usage: { inputTokens: 900, outputTokens: 10 } };
    }
  }
  const provider = new SessionProvider();
  const agent = agentSpec({ tools: [], contextWindow: 1000 });

  let r = await runTaskLoop({ store, provider, runId, taskId: "t1", agent, input: "turn 1", sessionMode: true });
  for (let turn = 2; turn <= 6; turn++) {
    expect(r.status).toBe("awaitingInput");
    const raw = await store.read(runId, "task:t1");
    await store.append(runId, "task:t1", raw.at(-1)!.seq, [ev("UserMessage", { text: `turn ${turn}` })]);
    r = await runTaskLoop({ store, provider, runId, taskId: "t1", agent, input: "turn 1", sessionMode: true });
  }
  expect(provider.summaryCalls).toBeGreaterThanOrEqual(1);

  // The transcript folds from events, not from the model's message array: intact.
  const eff = effectiveEvents(await store.read(runId, "task:t1"));
  const asks = eff.filter((e) => e.type === "InputRequested");
  const users = eff.filter((e) => e.type === "UserMessage");
  expect(asks.length).toBe(6);
  expect(users.length).toBe(5);
  expect(String(asks.at(-1)!.payload.text)).toBe("reply 6");
});
