import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createPool, tx, migrateControl, provisionAgent,
  PgStateStore, PgQueue, PgLeases, MockProvider, LocalWorkerRuntime,
  type AgentSpec, type TickDeps, type WorkflowFn,
} from "@toren-run/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp.js";

const pool = createPool();
const SCHEMA = "agent_mcptest";
let deps: TickDeps;
let worker: LocalWorkerRuntime;
let client: Client;

const spec: AgentSpec = { model: "mock/m", system: "s", tools: [], maxTokens: 50, maxSteps: 3 };
const weekly: WorkflowFn = async () => "42 pages";

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "mcptest"); });
  await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.blobs, ${SCHEMA}.runs CASCADE`);
  await pool.query(`TRUNCATE toren_control.queue_messages, toren_control.dead_letters`);
  deps = {
    store: new PgStateStore(pool, SCHEMA), queue: new PgQueue(pool), leases: new PgLeases(pool, SCHEMA),
    provider: new MockProvider([]), agents: { main: spec },
    workflows: { main: weekly, "weekly-report": weekly },
  };
  worker = new LocalWorkerRuntime({ mcptest: deps }, { concurrency: 2 });
  worker.start();

  const server = buildMcpServer({ mcptest: deps }, { defaultAgent: "mcptest", info: { crews: { mcptest: { processes: ["main", "weekly-report"] } } } });
  const pair = InMemoryTransport.createLinkedPair();
  const clientTransport = pair[0]!;
  const serverTransport = pair[1]!;
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
});
afterAll(async () => { await worker.stop(); await pool.end(); });

const textOf = (r: unknown) => JSON.parse((((r as { content: { text: string }[] }).content)[0]!).text);

test("the toolbox is the durable-run surface", async () => {
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(tools).toEqual(["cancel_run", "list_agents", "list_runs", "resolve_approval", "run_status", "start_run"]);
});

test("a coding agent starts a named process, watches it settle, and reads the cost", { timeout: 20_000 }, async () => {
  const agents = textOf(await client.callTool({ name: "list_agents", arguments: {} }));
  expect(agents.crews.mcptest.processes).toContain("weekly-report");

  const started = textOf(await client.callTool({ name: "start_run", arguments: { process: "weekly-report", input: "acme" } }));
  expect(started.run_id).toMatch(/^[0-9a-f-]{36}$/);

  await worker.drain(15_000);
  const status = textOf(await client.callTool({ name: "run_status", arguments: { run_id: started.run_id } }));
  expect(status.status).toBe("completed");
  expect(status.output).toBe("42 pages");
  expect(status.usage.totalCalls).toBe(0); // workflow completes without model calls

  const listed = textOf(await client.callTool({ name: "list_runs", arguments: {} }));
  expect(listed.runs.some((r: { runId: string }) => r.runId === started.run_id)).toBe(true);
});

test("cancel_run retires a run through MCP", async () => {
  const started = textOf(await client.callTool({ name: "start_run", arguments: { input: "doomed" } }));
  const cancelled = textOf(await client.callTool({ name: "cancel_run", arguments: { run_id: started.run_id } }));
  expect(cancelled.cancelled).toBe(true);
});

test("an unknown process errors helpfully instead of crashing the session", async () => {
  const r = await client.callTool({ name: "start_run", arguments: { process: "nope", input: "x" } });
  expect(r.isError).toBe(true);
  expect(String((r.content as { text: string }[])[0]!.text)).toMatch(/no process "nope"/);
});

test("the HTTP transport serves MCP behind the deployment's bearer auth", async () => {
  const { createApiServer } = await import("../src/api.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const server = createApiServer({ mcptest: deps }, { token: "mcp-test-token", agent: "mcptest" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    const good = new Client({ name: "http-test", version: "0" });
    await good.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: "Bearer mcp-test-token" } },
    }));
    expect((await good.listTools()).tools.length).toBe(6);
    await good.close();

    const bad = new Client({ name: "bad", version: "0" });
    await expect(bad.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))).rejects.toThrow(/401|Unauthorized|HTTP/i);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
