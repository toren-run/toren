import { afterAll, beforeAll, expect, test } from "vitest";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";
import { PgQueue } from "../src/queue.js";
import { PgLeases } from "../src/leases.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../src/model.js";
import type { AgentSpec } from "../src/loop.js";
import { startRun, type TickDeps } from "../src/orchestrator.js";
import { LocalWorkerRuntime } from "../src/worker.js";
import type { WorkflowFn } from "../src/workflow.js";

const pool = createPool();

class TaggedProvider implements ModelProvider {
  constructor(private tag: string) {}
  async complete(req: ModelRequest): Promise<ModelResponse> {
    const first = req.messages[0]!.content.find((b) => b.type === "text");
    const input = first && first.type === "text" ? first.text : "?";
    return { content: [{ type: "text", text: `${this.tag}(${input})` }], stopReason: "endTurn", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const spec: AgentSpec = { model: "mock/m", system: "s", tools: [], maxTokens: 50, maxSteps: 3 };
const wf: WorkflowFn = async (ctx) => {
  const w = await ctx.wave("work", [ctx.task("solo", ctx.input)]);
  return w.results[0]!.output ?? "";
};

function crewDeps(schema: string, agentName: string, tag: string): TickDeps {
  return {
    store: new PgStateStore(pool, schema),
    queue: new PgQueue(pool),
    leases: new PgLeases(pool, schema),
    provider: new TaggedProvider(tag), // distinct providers prove routing: crossed routing = wrong tag
    agents: { solo: spec },
    workflows: { main: wf },
  };
}

beforeAll(async () => {
  await tx(pool, async (c) => {
    await migrateControl(c);
    await provisionAgent(c, "fleeta");
    await provisionAgent(c, "fleetb");
  });
  for (const s of ["agent_fleeta", "agent_fleetb"]) {
    await pool.query(`TRUNCATE ${s}.events, ${s}.streams, ${s}.leases, ${s}.blobs, ${s}.runs CASCADE`);
  }
  await pool.query(`TRUNCATE toren_control.queue_messages, toren_control.dead_letters`);
});
afterAll(async () => { await pool.end(); });

test("one fleet worker serves two agents; runs route to the right store, specs, and provider", async () => {
  const a = crewDeps("agent_fleeta", "fleeta", "alpha");
  const b = crewDeps("agent_fleetb", "fleetb", "beta");
  const worker = new LocalWorkerRuntime({ fleeta: a, fleetb: b }, { concurrency: 2 });
  worker.start();
  try {
    const runA = await startRun(a, { agent: "fleeta", input: "job-a" });
    const runB = await startRun(b, { agent: "fleetb", input: "job-b" });
    await worker.drain(20_000);

    const doneA = await a.store.getRun(runA);
    const doneB = await b.store.getRun(runB);
    expect(doneA!.status).toBe("completed");
    expect(doneB!.status).toBe("completed");
    // Routing proof: each run was executed by its own crew's provider.
    expect(doneA!.output).toBe("alpha(job-a)");
    expect(doneB!.output).toBe("beta(job-b)");
    // Isolation proof: neither schema saw the other's run.
    expect(await a.store.getRun(runB)).toBeNull();
    expect(await b.store.getRun(runA)).toBeNull();
  } finally {
    await worker.stop();
  }
});

test("two separate worker processes share one database without stealing each other's messages", async () => {
  const a = crewDeps("agent_fleeta", "fleeta", "alpha");
  const b = crewDeps("agent_fleetb", "fleetb", "beta");
  // Simulates two independently deployed fleets: each worker serves ONE agent.
  const workerA = new LocalWorkerRuntime({ fleeta: a }, { concurrency: 1 });
  const workerB = new LocalWorkerRuntime({ fleetb: b }, { concurrency: 1 });

  // Phase 1: only A is up. B's run is started; A must not touch it.
  workerA.start();
  const runA = await startRun(a, { agent: "fleeta", input: "solo-a" });
  const runB = await startRun(b, { agent: "fleetb", input: "solo-b" });
  try {
    await workerA.drain(15_000); // scoped drain: returns even though B's message is still queued
    expect((await a.store.getRun(runA))!.status).toBe("completed");
    expect((await a.store.getRun(runA))!.output).toBe("alpha(solo-a)");
    // B's work is untouched and its hint is still there for the owning fleet.
    expect((await b.store.getRun(runB))!.status).not.toBe("completed");
    expect(await b.queue.depth({ agents: ["fleetb"] })).toBeGreaterThan(0);

    // Phase 2: B's fleet comes up and finds its message waiting.
    workerB.start();
    await workerB.drain(15_000);
    expect((await b.store.getRun(runB))!.status).toBe("completed");
    expect((await b.store.getRun(runB))!.output).toBe("beta(solo-b)");
  } finally {
    await workerA.stop();
    await workerB.stop();
  }
});

test("a fleet worker acks-and-skips unlabeled-for-others hints delivered to it (SQS-style adapters)", async () => {
  const a = crewDeps("agent_fleeta", "fleeta", "alpha");
  // Sole-deps worker claims everything (legacy mode) — including a message for
  // an agent it can't serve? No: sole mode routes all messages to its deps, so
  // this test uses the fleet map with a ghost agent label to hit the skip path.
  const worker = new LocalWorkerRuntime({ fleeta: a, fleetc: crewDeps("agent_fleeta", "fleetc", "gamma") }, { concurrency: 1 });
  worker.start();
  try {
    await a.queue.send("orchestrator", { kind: "tick", runId: "00000000-0000-0000-0000-000000000000", agent: "fleetc", dedupeKey: "ghost-1" });
    await worker.drain(10_000); // fleetc has no such run — tick is a no-op, message acked
    expect(await a.queue.depth({ agents: ["fleeta", "fleetc"] })).toBe(0);
  } finally {
    await worker.stop();
  }
});
