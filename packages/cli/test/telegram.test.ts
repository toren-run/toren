import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createPool, tx, migrateControl, provisionAgent,
  PgStateStore, PgQueue, PgLeases, LocalWorkerRuntime,
  type AgentSpec, type ModelProvider, type ModelRequest, type ModelResponse, type TickDeps, type WorkflowFn,
} from "@toren-run/core";
import { createTelegramInvite, splitMessage, TelegramChannel } from "../src/telegram.js";

const pool = createPool();
const SCHEMA = "agent_tgtest";
const ALICE = 1001; // allowlisted
const MALLORY = 4004; // stranger

class LastEcho implements ModelProvider {
  async complete(req: ModelRequest): Promise<ModelResponse> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const t = lastUser?.content.find((b) => b.type === "text");
    const text = t && t.type === "text" ? t.text : "?";
    return { content: [{ type: "text", text: `re:${text}` }], stopReason: "endTurn", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

/** In-memory Telegram: getUpdates drains a queue, outbound calls are recorded. */
class FakeTelegram {
  private updates: unknown[] = [];
  private nextId = 1;
  sent: { chat_id: number; text: string }[] = [];
  actions = 0;

  message(from: number, text: string): void {
    this.updates.push({ update_id: this.nextId++, message: { message_id: this.nextId, from: { id: from }, chat: { id: from, type: "private" }, text } });
  }

  docs: { chat_id: string; method: string; file_name: string; caption: string | null }[] = [];

  fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = String(url).split("/").at(-1)!;
    if (method === "sendDocument" || method === "sendPhoto") {
      const form = init?.body as FormData;
      const field = method === "sendPhoto" ? "photo" : "document";
      const blob = form.get(field) as File | null;
      this.docs.push({ chat_id: String(form.get("chat_id")), method, file_name: blob?.name ?? "?", caption: form.get("caption") as string | null });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 0 } }), { headers: { "content-type": "application/json" } });
    }
    const params = init?.body ? JSON.parse(String(init.body)) : {};
    let result: unknown = true;
    if (method === "getUpdates") {
      result = this.updates.filter((u: any) => u.update_id >= (params.offset ?? 0));
    } else if (method === "sendMessage") {
      // Mirror the real API: hard 400 on oversized texts.
      if (String(params.text).length > 4096) {
        return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message is too long" }), { headers: { "content-type": "application/json" } });
      }
      // Deterministic permanent refusal, for the poison-pill path.
      if (String(params.text).includes("POISON400")) {
        return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: rejected" }), { headers: { "content-type": "application/json" } });
      }
      this.sent.push({ chat_id: params.chat_id, text: params.text });
      result = { message_id: 0 };
    } else if (method === "sendChatAction") {
      this.actions++;
    }
    return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  async waitFor(pred: () => boolean, ms = 15_000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > ms) throw new Error(`timed out; sent so far: ${JSON.stringify(this.sent)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

const spec: AgentSpec = { model: "mock/m", system: "sys", tools: [], maxTokens: 100, maxSteps: 2 };
const wf: WorkflowFn = async (ctx) => {
  const w = await ctx.wave("main", [ctx.task("main", ctx.input)]);
  return w.results[0]?.output ?? "";
};

let deps: TickDeps;
let worker: LocalWorkerRuntime;
let channel: TelegramChannel;
let tg: FakeTelegram;

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "tgtest"); });
  await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.blobs, ${SCHEMA}.runs CASCADE`);
  await pool.query("TRUNCATE toren_control.queue_messages, toren_control.telegram_users, toren_control.telegram_invites, toren_control.telegram_bindings, toren_control.telegram_state, toren_control.telegram_poll_state");
  deps = {
    store: new PgStateStore(pool, SCHEMA), queue: new PgQueue(pool), leases: new PgLeases(pool, SCHEMA),
    provider: new LastEcho(), agents: { main: spec }, workflows: { main: wf },
  };
  worker = new LocalWorkerRuntime({ helper: deps }, { concurrency: 1 });
  worker.start();
  tg = new FakeTelegram();
  channel = new TelegramChannel({
    botToken: "test", byAgent: { helper: deps }, defaultAgent: "helper", pool,
    allowedUsers: new Set([ALICE]), fetchImpl: tg.fetch, pollTimeoutSec: 0, deliverMs: 150,
  });
  channel.start();
});

afterAll(async () => {
  await channel.stop();
  await worker.stop();
  await pool.end();
});

test("stranger is denied; invite code pairs exactly once", async () => {
  tg.message(MALLORY, "hello?");
  await tg.waitFor(() => tg.sent.some((m) => m.chat_id === MALLORY && m.text.includes("private")));

  const code = await createTelegramInvite(pool);
  tg.message(MALLORY, code);
  await tg.waitFor(() => tg.sent.some((m) => m.chat_id === MALLORY && m.text.includes("paired")));

  // the code burns: a second redemption attempt is a plain denied message
  const before = tg.sent.length;
  tg.message(9999, code);
  await tg.waitFor(() => tg.sent.length > before);
  expect(tg.sent.at(-1)!.text).toContain("private");
});

test("allowlisted user converses: reply delivered exactly once, /end closes", async () => {
  tg.message(ALICE, "what is toren");
  await tg.waitFor(() => tg.sent.some((m) => m.chat_id === ALICE && m.text === "re:what is toren"));

  tg.message(ALICE, "second turn");
  await tg.waitFor(() => tg.sent.some((m) => m.chat_id === ALICE && m.text === "re:second turn"));

  // exactly-once delivery per assistant turn
  expect(tg.sent.filter((m) => m.text === "re:what is toren").length).toBe(1);
  expect(tg.sent.filter((m) => m.text === "re:second turn").length).toBe(1);

  tg.message(ALICE, "/end");
  await tg.waitFor(() => tg.sent.some((m) => m.chat_id === ALICE && m.text.includes("closed")));
  const { rows } = await pool.query("SELECT run_id FROM toren_control.telegram_bindings WHERE chat_id = $1", [ALICE]);
  expect(rows[0].run_id).toBeNull();
});

test("/new starts fresh and /agent reports the roster", async () => {
  tg.message(ALICE, "/agent");
  await tg.waitFor(() => tg.sent.some((m) => m.chat_id === ALICE && m.text.includes("helper")));

  tg.message(ALICE, "/new helper");
  await tg.waitFor(() => tg.sent.some((m) => m.chat_id === ALICE && m.text.includes("Fresh conversation")));

  tg.message(ALICE, "round two");
  await tg.waitFor(() => tg.sent.some((m) => m.chat_id === ALICE && m.text === "re:round two"));
});

test("a failing poller is loud and self-healing: status exposed, transition logged, loop survives", async () => {
  const lines: string[] = [];
  let failing = true;
  const flaky = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (failing && String(url).includes("getUpdates")) throw new Error("ECONNRESET");
    return tg.fetch(url, init);
  }) as typeof fetch;
  const ch = new TelegramChannel({
    botToken: "flaky", byAgent: { helper: deps }, defaultAgent: "helper", pool,
    fetchImpl: flaky, pollTimeoutSec: 0, deliverMs: 60_000, botKey: "agent:flaky",
    log: (l) => lines.push(l), heartbeatMs: 50,
  });
  ch.start();
  try {
    await tg.waitFor(() => ch.status().consecutiveFailures >= 1, 10_000);
    const st = ch.status();
    expect(st.lastError).toContain("ECONNRESET");
    expect(st.lastErrorAt).not.toBeNull();
    expect(lines.some((l) => l.includes("ECONNRESET"))).toBe(true);
    expect(lines.some((l) => l.includes("elected poller"))).toBe(true);

    // recovery: the loop never died, so clearing the fault heals it
    failing = false;
    await tg.waitFor(() => ch.status().consecutiveFailures === 0, 15_000);
    expect(lines.some((l) => l.includes("recovered"))).toBe(true);
    await tg.waitFor(() => lines.some((l) => l.includes("poller alive")), 10_000);
  } finally {
    await ch.stop();
  }
});

test("dedicated bots are isolated: pairing, invites, and bindings do not cross bot keys", async () => {
  const BOB = 2002;
  const tg2 = new FakeTelegram();
  const channel2 = new TelegramChannel({
    botToken: "test2", byAgent: { helper: deps }, defaultAgent: "helper", pool,
    fetchImpl: tg2.fetch, pollTimeoutSec: 0, deliverMs: 150, botKey: "agent:helper",
  });
  channel2.start();
  try {
    // A shared-bot invite does not open the dedicated bot
    const sharedCode = await createTelegramInvite(pool);
    tg2.message(BOB, sharedCode);
    await tg2.waitFor(() => tg2.sent.some((m) => m.chat_id === BOB && m.text.includes("private")));

    // The scoped invite does, and the pairing stays on the dedicated bot
    const code = await createTelegramInvite(pool, "agent:helper");
    tg2.message(BOB, code);
    await tg2.waitFor(() => tg2.sent.some((m) => m.chat_id === BOB && m.text.includes("paired")));
    tg2.message(BOB, "dedicated hello");
    await tg2.waitFor(() => tg2.sent.some((m) => m.chat_id === BOB && m.text === "re:dedicated hello"));

    // Bob is still a stranger to the shared bot
    tg.message(BOB, "shared hello");
    await tg.waitFor(() => tg.sent.some((m) => m.chat_id === BOB && m.text.includes("private")));
    expect(tg.sent.some((m) => m.text === "re:dedicated hello")).toBe(false);

    // Each bot keeps its own binding row for the same chat id
    const { rows } = await pool.query(
      "SELECT bot_key FROM toren_control.telegram_bindings WHERE chat_id = $1 ORDER BY bot_key", [BOB],
    );
    expect(rows.map((r: { bot_key: string }) => r.bot_key)).toEqual(["agent:helper"]);
  } finally {
    await channel2.stop();
  }
});

test("splitMessage: respects the limit, prefers line and word boundaries", () => {
  expect(splitMessage("short")).toEqual(["short"]);
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
  const parts = splitMessage(lines);
  expect(parts.length).toBeGreaterThan(1);
  for (const p of parts) expect(p.length).toBeLessThanOrEqual(4000);
  // content survives; a chunk boundary may swap one whitespace char
  const norm = (s: string) => s.replace(/\s+/g, " ");
  expect(norm(parts.join(" "))).toBe(norm(lines));
  // no boundaries at all: hard cut, nothing lost
  const wall = "a".repeat(9000);
  const hard = splitMessage(wall);
  expect(hard.map((p) => p.length)).toEqual([4000, 4000, 1000]);
});

test("a reply over telegram's 4096 limit is split, delivered, and never wedges the chat", async () => {
  const big = "b".repeat(5000);
  tg.message(ALICE, big);
  await tg.waitFor(() => tg.sent.filter((m) => m.chat_id === ALICE && m.text.startsWith("re:".slice(0, 1)) === false || true).length > 0 && tg.sent.some((m) => m.chat_id === ALICE && m.text.endsWith("b".repeat(50))));
  const chunks = tg.sent.filter((m) => m.chat_id === ALICE && m.text.includes("bbbb"));
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(4096);
  expect(chunks.map((c) => c.text).join("")).toBe(`re:${big}`);

  // the cursor advanced: the next turn still flows
  tg.message(ALICE, "still alive?");
  await tg.waitFor(() => tg.sent.some((m) => m.chat_id === ALICE && m.text === "re:still alive?"));
});

test("a permanently refused message becomes a notice instead of wedging the chat", async () => {
  tg.message(ALICE, "POISON400 hello");
  await tg.waitFor(() => tg.sent.some((m) => m.chat_id === ALICE && m.text.includes("could not be delivered")));

  tg.message(ALICE, "after poison");
  await tg.waitFor(() => tg.sent.some((m) => m.chat_id === ALICE && m.text === "re:after poison"));
});

test("approval round-trip in chat: gated tool surfaces as a message, /approve resumes the run", { timeout: 30_000 }, async () => {
  const { defineTool, LocalWorkerRuntime: LWR } = await import("@toren-run/core");
  const { z } = await import("zod");
  const gated = defineTool({
    name: "send_report", description: "Send.", input: z.object({ to: z.string() }),
    effects: "external", idempotency: "keyed", approval: "always",
    handler: async ({ to }: { to: string }) => `sent to ${to}`,
  });
  let step = 0;
  const provider: ModelProvider = {
    async complete(): Promise<ModelResponse> {
      step += 1;
      if (step === 1) return { content: [{ type: "toolUse", id: "tu1", name: "send_report", input: { to: "boss" } }], stopReason: "toolUse", usage: { inputTokens: 1, outputTokens: 1 } };
      return { content: [{ type: "text", text: "report sent, done" }], stopReason: "endTurn", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const gspec: AgentSpec = { model: "mock/m", system: "sys", tools: [gated], maxTokens: 100, maxSteps: 6 };
  const deps2: TickDeps = {
    store: new PgStateStore(pool, SCHEMA), queue: new PgQueue(pool), leases: new PgLeases(pool, SCHEMA),
    provider, agents: { main: gspec }, workflows: { main: wf },
  };
  const worker2 = new LWR({ gatedbot: deps2 }, { concurrency: 1 });
  worker2.start();
  const tg3 = new FakeTelegram();
  const APPROVER = 7007;
  const ch3 = new TelegramChannel({
    botToken: "test3", byAgent: { gatedbot: deps2 }, defaultAgent: "gatedbot", pool,
    allowedUsers: new Set([APPROVER]), fetchImpl: tg3.fetch, pollTimeoutSec: 0, deliverMs: 150, botKey: "agent:gatedbot",
  });
  ch3.start();
  try {
    tg3.message(APPROVER, "send the report");
    await tg3.waitFor(() => tg3.sent.some((m) => m.chat_id === APPROVER && m.text.includes("Approval needed") && m.text.includes("send_report")), 20_000);

    tg3.message(APPROVER, "/approve");
    await tg3.waitFor(() => tg3.sent.some((m) => m.chat_id === APPROVER && m.text.includes("Approved")), 15_000);
    await tg3.waitFor(() => tg3.sent.some((m) => m.chat_id === APPROVER && m.text === "report sent, done"), 20_000);

    // the prompt was sent exactly once
    expect(tg3.sent.filter((m) => m.text.includes("Approval needed")).length).toBe(1);
  } finally {
    await ch3.stop();
    await worker2.stop();
  }
});

test("send_to_channel: a workspace file reaches the chat as an upload, never a fake link", { timeout: 30_000 }, async () => {
  const { LocalWorkerRuntime: LWR, PgFiles, BUILTIN_TOOLS } = await import("@toren-run/core");
  const { makeChannelDelivery } = await import("../src/runtime.js");
  const report = Buffer.from("quarterly numbers: up and to the right").toString("base64");
  const fakeSandbox = {
    forRun: () => ({
      exec: async (cmd: string) => cmd.includes("report.pdf")
        ? { stdout: report, stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "no such file", exitCode: 1 },
      readFile: async () => "", writeFile: async () => {},
    }),
  };
  let step = 0;
  const provider: ModelProvider = {
    async complete(): Promise<ModelResponse> {
      step += 1;
      if (step === 1) return { content: [{ type: "toolUse", id: "tu9", name: "send_to_channel", input: { path: "/workspace/report.pdf", caption: "the report" } }], stopReason: "toolUse", usage: { inputTokens: 1, outputTokens: 1 } };
      return { content: [{ type: "text", text: "sent, check the file above" }], stopReason: "endTurn", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const files = new PgFiles(pool);
  const fspec: AgentSpec = { model: "mock/m", system: "sys", tools: [BUILTIN_TOOLS.send_to_channel!], maxTokens: 100, maxSteps: 6 };
  const deps3: TickDeps = {
    store: new PgStateStore(pool, SCHEMA), queue: new PgQueue(pool), leases: new PgLeases(pool, SCHEMA),
    provider, agents: { main: fspec }, workflows: { main: wf },
    files, sandbox: fakeSandbox as never, channels: makeChannelDelivery(pool, files),
  };
  const worker3 = new LWR({ filebot: deps3 }, { concurrency: 1 });
  worker3.start();
  const tg4 = new FakeTelegram();
  const READER = 8008;
  const ch4 = new TelegramChannel({
    botToken: "test4", byAgent: { filebot: deps3 }, defaultAgent: "filebot", pool,
    allowedUsers: new Set([READER]), fetchImpl: tg4.fetch, pollTimeoutSec: 0, deliverMs: 150, botKey: "agent:filebot",
  });
  ch4.start();
  try {
    tg4.message(READER, "make me the report");
    await tg4.waitFor(() => tg4.docs.some((d) => d.file_name === "report.pdf" && d.chat_id === String(READER)), 20_000);
    expect(tg4.docs[0]!.method).toBe("sendDocument");
    expect(tg4.docs[0]!.caption).toBe("the report");
    await tg4.waitFor(() => tg4.sent.some((m) => m.chat_id === READER && m.text === "sent, check the file above"), 20_000);

    // outbox drained, delivered exactly once
    const { rows } = await pool.query("SELECT delivered_at FROM toren_control.channel_outbox");
    expect(rows.every((r: { delivered_at: unknown }) => r.delivered_at !== null)).toBe(true);
    expect(tg4.docs.length).toBe(1);
  } finally {
    await ch4.stop();
    await worker3.stop();
  }
});
