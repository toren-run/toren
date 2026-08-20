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
    workflows: { [agentName]: wf },
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

test("a fleet worker acks-and-skips hints for agents it does not serve", async () => {
  const a = crewDeps("agent_fleeta", "fleeta", "alpha");
  const worker = new LocalWorkerRuntime({ fleeta: a, fleetb: crewDeps("agent_fleetb", "fleetb", "beta") }, { concurrency: 1 });
  worker.start();
  try {
    await a.queue.send("orchestrator", { kind: "tick", runId: "00000000-0000-0000-0000-000000000000", agent: "ghost-crew", dedupeKey: "foreign-1" });
    await worker.drain(10_000); // would time out (nack loop) if the foreign hint weren't acked
    expect(await a.queue.depth()).toBe(0);
  } finally {
    await worker.stop();
  }
});
