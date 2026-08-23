import { afterAll, beforeAll, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import {
  createPool, tx, migrateControl, provisionAgent,
  PgStateStore, PgQueue, PgLeases,
  LocalWorkerRuntime, MockProvider, defineTool,
  type AgentSpec, type ModelProvider, type ModelRequest, type ModelResponse, type TickDeps, type WorkflowFn,
} from "@toren-run/core";
import { createApiServer } from "../src/api.js";

const pool = createPool();
const SCHEMA = "agent_apitest";
const TOKEN = "test-token-123";
let store: PgStateStore;
let base: string;
let server: ReturnType<typeof createApiServer>;
let worker: LocalWorkerRuntime;

class EchoAll implements ModelProvider {
  async complete(req: ModelRequest): Promise<ModelResponse> {
    const first = req.messages[0]!.content.find((b) => b.type === "text");
    const input = first && first.type === "text" ? first.text : "";
    return { content: [{ type: "text", text: `out(${input})` }], stopReason: "endTurn", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const gated = defineTool({
  name: "publish", description: "Publish result.", input: z.object({ text: z.string() }),
  effects: "external", idempotency: "keyed", approval: "always",
  handler: async ({ text }) => `published:${text}`,
});

const plainAgent: AgentSpec = { model: "mock/m", system: "s", tools: [], maxTokens: 100, maxSteps: 5 };
const gatedAgent: AgentSpec = { model: "mock/m", system: "s", tools: [gated], maxTokens: 100, maxSteps: 8 };

const wf: WorkflowFn = async (ctx) => {
  const w = await ctx.wave("work", [ctx.task(ctx.input.startsWith("gate:") ? "publisher" : "echoer", ctx.input)]);
  return w.results[0]!.output ?? "";
};

function providerFor(): ModelProvider {
  // gated tasks get a scripted tool call then finish; others echo
  const gatedScript = new MockProvider([
    { content: [{ type: "toolUse", id: "tu1", name: "publish", input: { text: "hello" } }], stopReason: "toolUse" },
    { content: [{ type: "text", text: "published fine" }], stopReason: "endTurn" },
  ]);
  const echo = new EchoAll();
  return {
    complete: (req) => {
      const sys = req.system ?? "";
      void sys;
      const first = req.messages[0]!.content.find((b) => b.type === "text");
      const input = first && first.type === "text" ? first.text : "";
      return input.startsWith("gate:") || req.tools.length > 0 ? gatedScript.complete(req) : echo.complete(req);
    },
  };
}

async function api(method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "apitest"); });
  store = new PgStateStore(pool, SCHEMA);
  await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.blobs, ${SCHEMA}.runs CASCADE`);
  await pool.query(`TRUNCATE toren_control.queue_messages, toren_control.dead_letters`);
  const deps: TickDeps = {
    store, queue: new PgQueue(pool), leases: new PgLeases(pool, SCHEMA),
    provider: providerFor(),
    agents: { main: plainAgent, echoer: plainAgent, publisher: gatedAgent },
    workflows: { main: wf, "weekly-report": async () => "ran weekly" },
  };
  worker = new LocalWorkerRuntime(deps, { concurrency: 2 });
  worker.start();
  server = createApiServer(deps, { token: TOKEN, agent: "apitest" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await worker.stop();
  await new Promise((r) => server.close(r));
  await pool.end();
});

test("healthz is open; everything else requires the bearer token", async () => {
  expect((await api("GET", "/healthz", undefined, null)).status).toBe(200);
  expect((await api("GET", "/runs", undefined, null)).status).toBe(401);
  expect((await api("GET", "/runs", undefined, "wrong")).status).toBe(401);
  expect((await api("GET", "/nope")).status).toBe(404);
});

test("POST /runs triggers a run; GET /runs/:id shows completion and output", async () => {
  const post = await api("POST", "/runs", { input: "solar" });
  expect(post.status).toBe(202);
  const runId = post.json.runId as string;

  await worker.drain(15_000);
  const got = await api("GET", `/runs/${runId}`);
  expect(got.status).toBe(200);
  expect(got.json.status).toBe("completed");
  expect(got.json.run.output).toBe("out(solar)");
  expect(got.json.waves).toEqual([{ name: "work", tasks: 1, settled: 1, done: true }]);

  const list = await api("GET", "/runs");
  expect(list.json.runs.some((r: any) => r.runId === runId)).toBe(true);
});

test("approval round-trip entirely over HTTP", async () => {
  const post = await api("POST", "/runs", { input: "gate:report" });
  const runId = post.json.runId as string;
  await worker.drain(15_000);

  const parked = await api("GET", `/runs/${runId}`);
  expect(parked.json.status).toBe("waiting_approval");
  expect(parked.json.approvals.length).toBe(1);
  const { taskId, stepId } = parked.json.approvals[0];

  const approve = await api("POST", `/runs/${runId}/approvals`, { taskId, stepId, granted: true });
  expect(approve.status).toBe(200);
  await worker.drain(15_000);

  const done = await api("GET", `/runs/${runId}`);
  expect(done.json.status).toBe("completed");
  expect(done.json.run.output).toBe("published fine");
});

test("events endpoint returns the full transcript", async () => {
  const post = await api("POST", "/runs", { input: "freight" });
  await worker.drain(15_000);
  const ev = await api("GET", `/runs/${post.json.runId}/events`);
  expect(ev.status).toBe(200);
  expect(ev.json.run.some((e: any) => e.type === "RunCompleted")).toBe(true);
  const taskStreams = Object.values(ev.json.tasks) as any[];
  expect(taskStreams.length).toBe(1);
  expect(taskStreams[0].some((e: any) => e.type === "LlmCallCompleted")).toBe(true);
});

test("input validation: bad bodies are 400, unknown run 404", async () => {
  expect((await api("POST", "/runs", { nope: 1 })).status).toBe(400);
  expect((await api("POST", "/runs", { input: "x", agent: "other" })).status).toBe(400);
  expect((await api("GET", "/runs/00000000-0000-0000-0000-000000000000")).status).toBe(404);
  expect((await api("POST", "/runs/00000000-0000-0000-0000-000000000000/approvals", { taskId: "t", stepId: "s" })).status).toBe(404);
});

test("client SDK sessions: start, reply, close — the toren chat wire path", async () => {
  const { TorenClient } = await import("@toren-run/client");
  const client = new TorenClient({ url: base, token: TOKEN });
  const { runId } = await client.startSession({ message: "hi from the terminal", channel: "cli" });

  let s = await client.getSession(runId);
  const deadline = Date.now() + 15_000;
  while (s.state === "working" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    s = await client.getSession(runId);
  }
  expect(s.state).toBe("awaiting_input");
  expect(s.transcript[0]!.text).toBe("hi from the terminal");
  expect(s.transcript[1]!.role).toBe("assistant");

  await client.sendSessionMessage(runId, { message: "", close: true });
  const sessions = await client.listSessions();
  expect(sessions.some((x) => x.runId === runId)).toBe(true);
});

test("POST /runs with a process routes to that workflow; unknown process is a 400", async () => {
  const ok = await api("POST", "/runs", { input: "go", process: "weekly-report" });
  expect(ok.status).toBe(202);
  expect(ok.json.process).toBe("weekly-report");
  await worker.drain(15_000);
  const got = await api("GET", `/runs/${ok.json.runId}`);
  expect(got.json.status).toBe("completed");
  expect(got.json.run.output).toBe("ran weekly");

  const bad = await api("POST", "/runs", { input: "go", process: "nope" });
  expect(bad.status).toBe(400);
  expect(bad.json.error).toMatch(/no process "nope"/);
});

test("POST /runs/:id/cancel retires a run; unknown id is 404", async () => {
  const post = await api("POST", "/runs", { input: "doomed" });
  const runId = post.json.runId as string;
  const cancel = await api("POST", `/runs/${runId}/cancel`);
  expect(cancel.status).toBe(200);
  expect(cancel.json.cancelled).toBe(true);
  const got = await api("GET", `/runs/${runId}`);
  expect(got.json.run.status).toBe("cancelled");
  expect((await api("POST", "/runs/00000000-0000-4000-8000-00000000dead/cancel")).status).toBe(404);
});

test("SSE tail streams the run's events and closes on settle", async () => {
  const post = await api("POST", "/runs", { input: "tail me", process: "weekly-report" });
  await worker.drain(15_000);
  const { TorenClient } = await import("@toren-run/client");
  const client = new TorenClient({ url: base, token: TOKEN });
  const types: string[] = [];
  await client.tailRun(post.json.runId as string, (e) => types.push(e.type));
  expect(types).toContain("RunCreated");
  expect(types).toContain("RunCompleted");
});
