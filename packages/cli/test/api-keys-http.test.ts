import { afterAll, beforeAll, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import {
  createPool, tx, migrateControl, provisionAgent,
  PgStateStore, PgQueue, PgLeases, MockProvider,
  type AgentSpec, type TickDeps, type WorkflowFn,
} from "@toren/core";
import { createApiServer } from "../src/api.js";

const pool = createPool();
const SCHEMA = "agent_keystest";
const ADMIN = "admin-token-xyz";
let base: string;
let server: ReturnType<typeof createApiServer>;

const agent: AgentSpec = { model: "mock/m", system: "s", tools: [], maxTokens: 50, maxSteps: 3 };
const wf: WorkflowFn = async () => "";

const call = async (method: string, path: string, token: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "keystest"); });
  await pool.query(`TRUNCATE toren_control.api_keys`);
  const deps: TickDeps = {
    store: new PgStateStore(pool, SCHEMA), queue: new PgQueue(pool), leases: new PgLeases(pool, SCHEMA),
    provider: new MockProvider([]), agents: { a: agent }, workflows: { keys: wf },
  };
  server = createApiServer(deps, { token: ADMIN, agent: "keys", pool });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

test("admin mints a key; the key works for runs but not for key management", async () => {
  const created = await call("POST", "/keys", ADMIN, { name: "console" });
  expect(created.status).toBe(201);
  const secret = created.body.key.secret as string;
  expect(secret).toMatch(/^trn_/);

  // issued key can read runs
  expect((await call("GET", "/runs", secret)).status).toBe(200);
  // …but cannot touch key management
  expect((await call("GET", "/keys", secret)).status).toBe(403);
  expect((await call("POST", "/keys", secret, { name: "sneaky" })).status).toBe(403);

  // list never exposes secrets
  const listed = await call("GET", "/keys", ADMIN);
  expect(listed.status).toBe(200);
  expect(JSON.stringify(listed.body)).not.toContain(secret.slice(12));
});

test("revoked keys stop working immediately; admin token is unaffected", async () => {
  const { body } = await call("POST", "/keys", ADMIN, { name: "temp" });
  const { id, secret } = body.key;

  expect((await call("GET", "/runs", secret)).status).toBe(200);
  expect((await call("DELETE", `/keys/${id}`, ADMIN)).status).toBe(200);
  expect((await call("GET", "/runs", secret)).status).toBe(401);
  expect((await call("DELETE", `/keys/${id}`, ADMIN)).status).toBe(404);
  expect((await call("DELETE", "/keys/not-a-uuid", ADMIN)).status).toBe(404);
  expect((await call("GET", "/runs", ADMIN)).status).toBe(200);
});

test("garbage bearer tokens still 401", async () => {
  expect((await call("GET", "/runs", "trn_deadbeef")).status).toBe(401);
  expect((await call("GET", "/runs", "")).status).toBe(401);
});
