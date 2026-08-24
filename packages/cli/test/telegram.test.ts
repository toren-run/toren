import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createPool, tx, migrateControl, provisionAgent,
  PgStateStore, PgQueue, PgLeases, LocalWorkerRuntime,
  type AgentSpec, type ModelProvider, type ModelRequest, type ModelResponse, type TickDeps, type WorkflowFn,
} from "@toren-run/core";
import { createTelegramInvite, TelegramChannel } from "../src/telegram.js";

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

  fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = String(url).split("/").at(-1)!;
    const params = init?.body ? JSON.parse(String(init.body)) : {};
    let result: unknown = true;
    if (method === "getUpdates") {
      result = this.updates.filter((u: any) => u.update_id >= (params.offset ?? 0));
    } else if (method === "sendMessage") {
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
