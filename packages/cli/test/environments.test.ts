import { afterAll, beforeAll, afterEach, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import {
  createPool, tx, migrateControl, provisionAgent,
  PgStateStore, PgQueue, PgLeases, LocalWorkerRuntime,
  type AgentSpec, type TickDeps, type WorkflowFn, type ModelProvider, type ModelRequest, type ModelResponse,
} from "@toren-run/core";
import { createApiServer } from "../src/api.js";
import { loadEnvironments, resolveEnvProfile } from "../src/environments.js";
import { remoteJobsList, remoteRun } from "../src/remote.js";
import type { CmdIO } from "../src/commands.js";

const pool = createPool();
const SCHEMA = "agent_envprofile";
const TOKEN = "envprofile-token";
let worker: LocalWorkerRuntime;
let server: ReturnType<typeof createApiServer>;
let apiUrl: string;

class EchoP implements ModelProvider {
  async complete(req: ModelRequest): Promise<ModelResponse> {
    const first = req.messages[0]!.content.find((b) => b.type === "text");
    return { content: [{ type: "text", text: `out(${first && first.type === "text" ? first.text : ""})` }], stopReason: "endTurn", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

function agentDirWithProfile(profile: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "toren-envp-"));
  mkdirSync(join(dir, ".toren"));
  writeFileSync(join(dir, ".toren", "environments.json"), JSON.stringify(profile));
  return dir;
}

function capture(): { io: CmdIO; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l) => lines.push(l) }, lines };
}

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "envprofile"); });
  const store = new PgStateStore(pool, SCHEMA);
  await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.blobs, ${SCHEMA}.runs CASCADE`);
  await pool.query(`TRUNCATE toren_control.queue_messages, toren_control.dead_letters`);
  const wf: WorkflowFn = async (ctx) => {
    const w = await ctx.wave("solo", [ctx.task("plain", ctx.input)]);
    return w.results[0]!.output ?? "";
  };
  const plain: AgentSpec = { model: "mock/m", system: "s", tools: [], maxTokens: 100, maxSteps: 5 };
  const deps: TickDeps = {
    store, queue: new PgQueue(pool), leases: new PgLeases(pool, SCHEMA),
    provider: new EchoP(), agents: { plain }, workflows: { main: wf },
  };
  server = createApiServer(deps, { token: TOKEN, agent: "envprofile" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  worker = new LocalWorkerRuntime(deps, { concurrency: 2 });
  worker.start();
});
afterAll(async () => {
  await worker.stop();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});
afterEach(() => { delete process.env.STAGE_TOKEN; });

test("profile resolution: implicit local, unknown env, api needs its token", () => {
  const dir = agentDirWithProfile({ stage: { api: "http://x", tokenEnv: "STAGE_TOKEN" } });
  expect(resolveEnvProfile(undefined, dir)).toMatchObject({ name: "local", kind: "db" });
  expect(() => resolveEnvProfile("prod", dir)).toThrow(/unknown environment "prod"/);
  expect(() => resolveEnvProfile("stage", dir)).toThrow(/STAGE_TOKEN/);
  process.env.STAGE_TOKEN = "t";
  expect(resolveEnvProfile("stage", dir)).toMatchObject({ kind: "api", url: "http://x", token: "t" });
  expect(loadEnvironments(mkdtempSync(join(tmpdir(), "toren-none-")))).toEqual({});
});

test("remote run via profile: completes through the API and prints the env header", async () => {
  const dir = agentDirWithProfile({ stage: { api: apiUrl, tokenEnv: "STAGE_TOKEN" } });
  process.env.STAGE_TOKEN = TOKEN;
  const profile = resolveEnvProfile("stage", dir);
  if (profile.kind !== "api") throw new Error("expected api profile");

  const { io, lines } = capture();
  await remoteRun(profile, { input: "hello" }, io);
  expect(lines[0]).toContain("→ env: stage");
  expect(lines.some((l) => l.includes("completed"))).toBe(true);
  expect(lines.at(-1)).toBe("out(hello)");

  const list = capture();
  await remoteJobsList(profile, {}, list.io);
  expect(list.lines.some((l) => l.includes("completed"))).toBe(true);
});
