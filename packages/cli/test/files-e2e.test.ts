import { afterAll, beforeAll, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import {
  createPool, tx, migrateControl, provisionAgent,
  PgStateStore, PgQueue, PgLeases, PgFiles, LocalWorkerRuntime, BUILTIN_TOOLS,
  type AgentSpec, type ModelProvider, type ModelRequest, type ModelResponse, type TickDeps, type WorkflowFn,
} from "@toren-run/core";
import { createApiServer } from "../src/api.js";

const pool = createPool();
const SCHEMA = "agent_filestest";
const TOKEN = "files-token";
let base: string;
let server: ReturnType<typeof createApiServer>;
let worker: LocalWorkerRuntime;

/** Reads the attached file (id parsed from the manifest), then answers with its text. */
class ReadFileFlow implements ModelProvider {
  async complete(req: ModelRequest): Promise<ModelResponse> {
    const last = req.messages.at(-1)!;
    const toolResult = last.content.find((b) => b.type === "toolResult");
    if (toolResult && toolResult.type === "toolResult") {
      return {
        content: [{ type: "text", text: `READ:${String(toolResult.content)}` }],
        stopReason: "endTurn", usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    const text = req.messages[0]!.content.find((b) => b.type === "text");
    const m = text && text.type === "text" ? text.text.match(/file_id: ([0-9a-f]+)/) : null;
    return {
      content: [{ type: "toolUse", id: "fu1", name: "read_file", input: { file_id: m?.[1] ?? "missing", page: 1 } }],
      stopReason: "toolUse", usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

const reader: AgentSpec = { model: "mock/m", system: "s", tools: [BUILTIN_TOOLS.read_file!], maxTokens: 200, maxSteps: 5 };
const wf: WorkflowFn = async (ctx) => {
  const w = await ctx.wave("main", [ctx.task("main", ctx.input)]);
  return w.results[0]?.output ?? "";
};

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "filestest"); });
  await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.blobs, ${SCHEMA}.runs CASCADE`);
  await pool.query(`TRUNCATE toren_control.queue_messages, toren_control.files`);
  const deps: TickDeps = {
    store: new PgStateStore(pool, SCHEMA), queue: new PgQueue(pool), leases: new PgLeases(pool, SCHEMA),
    provider: new ReadFileFlow(), agents: { main: reader }, workflows: { filestest: wf },
    files: new PgFiles(pool),
  };
  worker = new LocalWorkerRuntime({ filestest: deps }, { concurrency: 1 });
  worker.start();
  server = createApiServer({ filestest: deps }, { token: TOKEN, agent: "filestest", pool });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await worker.stop();
  await new Promise((r) => server.close(r));
  await pool.end();
});

test("upload, attach to a session, agent reads the file through read_file", async () => {
  const content = "Quarterly revenue was 4.2M with a 31 percent margin.";
  const up = await api("POST", "/files", { name: "report.txt", content_base64: Buffer.from(content).toString("base64") });
  expect(up.status).toBe(201);
  expect(up.json.pages).toBe(1);

  const start = await api("POST", "/sessions", { message: "What does the report say?", files: [up.json.fileId] });
  expect(start.status).toBe(202);
  const runId = start.json.runId;

  await worker.drain(15_000);
  const s = await api("GET", `/sessions/${runId}`);
  expect(s.json.state).toBe("awaiting_input");
  // The manifest reached the transcript, and the reply carries the file's text.
  expect(s.json.transcript[0].text).toContain("report.txt");
  expect(s.json.transcript.at(-1).text).toContain("4.2M");
});

test("bad attachments fail fast with useful errors", async () => {
  const missing = await api("POST", "/sessions", { message: "hi", files: ["deadbeef00000000"] });
  expect(missing.status).toBe(400);
  expect(missing.json.error).toContain("no uploaded file");

  const junk = await api("POST", "/files", { name: "x.bin", content_base64: Buffer.from([1, 2, 3, 250, 251, 252, 253, 254, 255, 0, 128, 129, 190, 200, 210]).toString("base64") });
  expect(junk.status).toBe(400);
  expect(junk.json.error).toContain("supported");
});
