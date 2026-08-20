import { afterAll, beforeAll, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import {
  createPool, tx, migrateControl, provisionAgent,
  PgStateStore, PgQueue, PgLeases, LocalWorkerRuntime,
  MockProvider, defineTool,
  type AgentSpec, type TickDeps, type WorkflowFn, type ModelProvider, type ModelRequest, type ModelResponse,
} from "@toren-run/core";
import { createApiServer } from "toren";
import { TorenApiError, TorenClient } from "../src/index.js";

const pool = createPool();
const SCHEMA = "agent_clienttest";
const TOKEN = "test-token-123";
let store: PgStateStore;
let worker: LocalWorkerRuntime;
let client: TorenClient;
let server: ReturnType<typeof createApiServer>;

class KeyedProvider implements ModelProvider {
  async complete(req: ModelRequest): Promise<ModelResponse> {
    const first = req.messages[0]!.content.find((b) => b.type === "text");
    const input = first && first.type === "text" ? first.text : "?";
    return { content: [{ type: "text", text: `out(${input})` }], stopReason: "endTurn", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const gated = defineTool({
  name: "send_report", description: "send", input: z.object({ to: z.string() }),
  effects: "external", idempotency: "keyed", approval: "always",
  handler: async ({ to }) => `sent to ${to}`,
});

const plainWf: WorkflowFn = async (ctx) => {
  const w = await ctx.wave("solo", [ctx.task("plain", ctx.input)]);
  return w.results[0]!.output ?? "";
};

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "clienttest"); });
  store = new PgStateStore(pool, SCHEMA);
  await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.blobs, ${SCHEMA}.runs CASCADE`);
  await pool.query(`TRUNCATE toren_control.queue_messages, toren_control.dead_letters`);

  const plain: AgentSpec = { model: "mock/m", system: "s", tools: [], maxTokens: 100, maxSteps: 5 };
  const sender: AgentSpec = { ...plain, tools: [gated] };
  const gatedProvider = new MockProvider([
    { content: [{ type: "toolUse", id: "tu1", name: "send_report", input: { to: "board" } }], stopReason: "toolUse" },
    { content: [{ type: "text", text: "report away" }], stopReason: "endTurn" },
  ]);
  // route by agentRef via task input prefix: plain tasks use KeyedProvider; gated wf uses MockProvider.
  const provider: ModelProvider = {
    complete: (req) =>
      (req.tools.length > 0 ? gatedProvider : new KeyedProvider()).complete(req),
  };
  const gatedWf: WorkflowFn = async (ctx) => {
    const w = await ctx.wave("send", [ctx.task("sender", "go")]);
    return w.results[0]!.output ?? "";
  };
  const deps: TickDeps = {
    store, queue: new PgQueue(pool), leases: new PgLeases(pool, SCHEMA),
    provider,
    agents: { plain, sender },
    workflows: { clienttest: plainWf, gatedwf: gatedWf },
  };
  // API serves one agent name; use "clienttest" for POST /runs. The gated flow
  // is exercised through the approval endpoints on a run started directly.
  server = createApiServer(deps, { token: TOKEN, agent: "clienttest" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  client = new TorenClient({ url: `http://127.0.0.1:${port}`, token: TOKEN });
  worker = new LocalWorkerRuntime(deps, { concurrency: 2 });
  worker.start();
  (globalThis as Record<string, unknown>).__deps = deps;
});

afterAll(async () => {
  await worker.stop();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});

test("wrong token → TorenApiError 401; health is open", async () => {
  const bad = new TorenClient({ url: client["base" as never] as unknown as string, token: "nope" });
  await expect(bad.listRuns()).rejects.toMatchObject({ status: 401 });
  expect(await client.health()).toBe(true);
});

test("startRun → waitForRun → completed with output; events readable", async () => {
  const { runId } = await client.startRun({ input: "hello" });
  const detail = await client.waitForRun(runId, { timeoutMs: 20_000 });
  expect(detail.status).toBe("completed");
  expect(detail.run.output).toBe("out(hello)");
  expect(detail.waves).toEqual([{ name: "solo", tasks: 1, settled: 1, done: true }]);

  const events = await client.getEvents(runId);
  expect(events.run.some((e) => e.type === "RunCompleted")).toBe(true);
  expect(Object.keys(events.tasks)).toEqual(["w0t0"]);

  const list = await client.listRuns();
  expect(list.some((r) => r.runId === runId && r.status === "completed")).toBe(true);
});

test("gated run parks; approve via client resumes to completion", async () => {
  const deps = (globalThis as Record<string, unknown>).__deps as TickDeps;
  const { startRun } = await import("@toren-run/core");
  const runId = await startRun(deps, { agent: "gatedwf", input: "go" });

  const parked = await client.waitForRun(runId, { timeoutMs: 20_000 });
  expect(parked.status).toBe("waiting_approval");
  expect(parked.approvals.length).toBe(1);

  await client.approve(runId, { ...parked.approvals[0]!, granted: true });
  // after approval the run resumes; wait until fully completed
  const deadline = Date.now() + 20_000;
  let final = await client.getRun(runId);
  while (final.status !== "completed" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    final = await client.getRun(runId);
  }
  expect(final.status).toBe("completed");
  expect(final.run.output).toBe("report away");
});

test("errors carry status codes", async () => {
  await expect(client.getRun("does-not-exist")).rejects.toBeInstanceOf(TorenApiError);
  await expect(client.getRun("does-not-exist")).rejects.toMatchObject({ status: 404 });
});
