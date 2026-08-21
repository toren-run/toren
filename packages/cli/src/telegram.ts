import { randomBytes } from "node:crypto";
import type pg from "pg";
import {
  getSession, sendSessionMessage, SessionBusyError, startSession,
  type TickDeps,
} from "@toren-run/core";

/**
 * Telegram channel: a bot DM is a session. Deny-by-default — a stranger who
 * finds the bot gets nothing until they present a one-time pairing code
 * (`toren channels telegram invite`) or their numeric ID is listed in
 * TELEGRAM_ALLOWED_USERS.
 *
 * One poller per deployment: Telegram allows a single getUpdates consumer,
 * so workers race for a Postgres advisory lock and only the winner polls.
 * Inbound updates are deduped through toren_control.telegram_state, and
 * outbound delivery marks progress with a CAS on last_delivered_seq — a
 * crashed worker's successor picks up exactly where it left off.
 */

type PoolClient = pg.PoolClient;

const LOCK_KEY = 0x746f7267; // "torg" — the telegram poller election lock

interface TgUpdate {
  update_id: number;
  message?: { message_id: number; from?: { id: number }; chat?: { id: number; type?: string }; text?: string };
}

export interface TelegramChannelOpts {
  botToken: string;
  byAgent: Record<string, TickDeps>;
  defaultAgent: string;
  pool: pg.Pool;
  allowedUsers?: Set<number>;
  fetchImpl?: typeof fetch;
  /** getUpdates long-poll horizon; 0 makes tests snappy. */
  pollTimeoutSec?: number;
  deliverMs?: number;
}

export class TelegramChannel {
  private stopped = false;
  private client: PoolClient | null = null;
  private loops: Promise<void>[] = [];
  constructor(private opts: TelegramChannelOpts) {}

  start(): void {
    this.loops = [this.runElected().catch(() => { /* stop() mid-flight */ })];
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(this.loops);
    if (this.client) {
      await this.client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
      this.client.release();
      this.client = null;
    }
  }

  async api<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`https://api.telegram.org/bot${this.opts.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!body.ok) throw new Error(`telegram ${method}: ${body.description ?? res.status}`);
    return body.result as T;
  }

  private async runElected(): Promise<void> {
    while (!this.stopped) {
      const client = await this.opts.pool.connect();
      const r = await client.query<{ won: boolean }>("SELECT pg_try_advisory_lock($1) AS won", [LOCK_KEY]);
      if (!r.rows[0]?.won) {
        client.release();
        await sleep(10_000, () => this.stopped);
        continue;
      }
      this.client = client;
      await Promise.allSettled([this.inboundLoop(), this.deliveryLoop()]);
      return;
    }
  }

  private async inboundLoop(): Promise<void> {
    let offset = 0;
    const { rows } = await this.opts.pool.query<{ last_update_id: string }>(
      "SELECT last_update_id FROM toren_control.telegram_state WHERE id = 1",
    );
    let lastSeen = rows[0] ? Number(rows[0].last_update_id) : 0;
    while (!this.stopped) {
      try {
        const updates = await this.api<TgUpdate[]>("getUpdates", {
          offset, timeout: this.opts.pollTimeoutSec ?? 25,
        });
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          if (u.update_id <= lastSeen) continue; // redelivered after a crash
          if (u.message) await this.handleMessage(u.message).catch(() => { /* one bad update never stalls the loop */ });
          lastSeen = u.update_id;
          await this.opts.pool.query(
            `INSERT INTO toren_control.telegram_state (id, last_update_id) VALUES (1, $1)
             ON CONFLICT (id) DO UPDATE SET last_update_id = GREATEST(toren_control.telegram_state.last_update_id, $1)`,
            [lastSeen],
          );
        }
        if (updates.length === 0 && (this.opts.pollTimeoutSec ?? 25) === 0) await sleep(150, () => this.stopped);
      } catch {
        await sleep(3_000, () => this.stopped);
      }
    }
  }

  private async handleMessage(msg: NonNullable<TgUpdate["message"]>): Promise<void> {
    const from = msg.from?.id, chat = msg.chat?.id;
    const text = (msg.text ?? "").trim();
    if (!from || !chat || !text) return;
    const say = (t: string) => this.api("sendMessage", { chat_id: chat, text: t });

    if (!(await this.isAllowed(from))) {
      const redeemed = await this.opts.pool.query(
        "UPDATE toren_control.telegram_invites SET used_by = $2 WHERE code = $1 AND used_by IS NULL RETURNING code",
        [text, from],
      );
      if (redeemed.rowCount) {
        await this.opts.pool.query(
          "INSERT INTO toren_control.telegram_users (user_id, via_code) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [from, text],
        );
        await say("You're paired. Say anything to start a conversation, or /agent to pick who you talk to.");
      } else {
        await say("This bot is private. Send a one-time invite code to pair (ask the operator to run: toren channels telegram invite).");
      }
      return;
    }

    if (text.startsWith("/")) return this.handleCommand(chat, text, say);

    const agents = Object.keys(this.opts.byAgent);
    const b = (await this.getBinding(chat)) ?? { agent: this.opts.defaultAgent, runId: null as string | null, lastSeq: 0 };
    if (!this.opts.byAgent[b.agent]) b.agent = this.opts.defaultAgent;
    const deps = this.opts.byAgent[b.agent]!;

    if (!b.runId) {
      const runId = await startSession(deps, { agent: b.agent, message: text, channel: "telegram" });
      await this.putBinding(chat, b.agent, runId);
      await this.typing(chat);
      return;
    }
    try {
      await sendSessionMessage(deps, b.runId, { text, channel: "telegram" });
      await this.typing(chat);
    } catch (e) {
      if (e instanceof SessionBusyError) {
        await say("Still working on your last message. One moment.");
        return;
      }
      // Session ended underneath the chat — start fresh with this message.
      const runId = await startSession(deps, { agent: b.agent, message: text, channel: "telegram" });
      await this.putBinding(chat, b.agent, runId);
      await this.typing(chat);
      void agents;
    }
  }

  private async handleCommand(chat: number, text: string, say: (t: string) => Promise<unknown>): Promise<void> {
    const [cmd, arg] = text.split(/\s+/, 2);
    const agents = Object.keys(this.opts.byAgent);
    const b = await this.getBinding(chat);

    if (cmd === "/start" || cmd === "/help") {
      await say(
        "Toren: durable agents in your own cloud.\n\n" +
        "Just talk: any message continues your open conversation (or starts one).\n" +
        "/new [agent] starts a fresh conversation\n" +
        "/agent shows the agents and who you are talking to\n" +
        "/end closes the open conversation",
      );
      return;
    }
    if (cmd === "/agent" || cmd === "/agents") {
      const current = b?.agent ?? this.opts.defaultAgent;
      await say(`Agents here: ${agents.join(", ")}.\nYou're talking to: ${current}.\nSwitch with /new <agent>.`);
      return;
    }
    if (cmd === "/new") {
      const agent = arg?.trim() || b?.agent || this.opts.defaultAgent;
      if (!this.opts.byAgent[agent]) {
        await say(`No agent named "${agent}". This deployment serves: ${agents.join(", ")}.`);
        return;
      }
      await this.closeQuietly(b);
      await this.putBinding(chat, agent, null);
      await say(`Fresh conversation with ${agent}. Say something.`);
      return;
    }
    if (cmd === "/end") {
      if (!b?.runId) {
        await say("No open conversation. Say anything to start one.");
        return;
      }
      try {
        await sendSessionMessage(this.opts.byAgent[b.agent]!, b.runId, { text: "", close: true });
        await this.putBinding(chat, b.agent, null);
        await say("Conversation closed. Say anything to start a new one.");
      } catch (e) {
        if (e instanceof SessionBusyError) await say("The agent is mid-reply. Try /end again once it answers.");
        else {
          await this.putBinding(chat, b.agent, null); // already terminal
          await say("Conversation closed. Say anything to start a new one.");
        }
      }
      return;
    }
    await say(`Unknown command ${cmd}. Try /help.`);
  }

  /** Best-effort close when /new abandons an open session; mid-turn just orphans it. */
  private async closeQuietly(b: { agent: string; runId: string | null } | null): Promise<void> {
    if (!b?.runId || !this.opts.byAgent[b.agent]) return;
    await sendSessionMessage(this.opts.byAgent[b.agent]!, b.runId, { text: "", close: true }).catch(() => {});
  }

  private async deliveryLoop(): Promise<void> {
    while (!this.stopped) {
      await sleep(this.opts.deliverMs ?? 2_500, () => this.stopped);
      const { rows } = await this.opts.pool.query<{ chat_id: string; agent: string; run_id: string; last_delivered_seq: number }>(
        "SELECT chat_id, agent, run_id, last_delivered_seq FROM toren_control.telegram_bindings WHERE run_id IS NOT NULL",
      );
      for (const row of rows) {
        try {
          await this.deliverOne(Number(row.chat_id), row.agent, row.run_id, row.last_delivered_seq);
        } catch { /* next tick retries */ }
      }
    }
  }

  private async deliverOne(chat: number, agent: string, runId: string, lastSeq: number): Promise<void> {
    const deps = this.opts.byAgent[agent];
    if (!deps) return;
    const s = await getSession(deps.store, runId);
    if (!s) return;
    let prev = lastSeq;
    for (const t of s.transcript) {
      if (t.role !== "assistant" || t.seq <= prev) continue;
      await this.api("sendMessage", { chat_id: chat, text: t.text || "…" });
      const r = await this.opts.pool.query(
        "UPDATE toren_control.telegram_bindings SET last_delivered_seq = $1, updated_at = now() WHERE chat_id = $2 AND last_delivered_seq = $3",
        [t.seq, chat, prev],
      );
      if (!r.rowCount) return; // someone else moved the cursor — defer to them
      prev = t.seq;
    }
    if (s.state === "working") await this.typing(chat).catch(() => {});
    if (s.state === "failed") {
      await this.api("sendMessage", { chat_id: chat, text: "The agent hit an error and this conversation ended. Say anything to start fresh." });
      await this.opts.pool.query("UPDATE toren_control.telegram_bindings SET run_id = NULL, updated_at = now() WHERE chat_id = $1 AND run_id = $2", [chat, runId]);
    } else if (s.state === "completed" || s.state === "cancelled") {
      await this.opts.pool.query("UPDATE toren_control.telegram_bindings SET run_id = NULL, updated_at = now() WHERE chat_id = $1 AND run_id = $2", [chat, runId]);
    }
  }

  private typing(chat: number): Promise<unknown> {
    return this.api("sendChatAction", { chat_id: chat, action: "typing" });
  }

  private async isAllowed(userId: number): Promise<boolean> {
    if (this.opts.allowedUsers?.has(userId)) return true;
    const { rowCount } = await this.opts.pool.query("SELECT 1 FROM toren_control.telegram_users WHERE user_id = $1", [userId]);
    return (rowCount ?? 0) > 0;
  }

  private async getBinding(chat: number): Promise<{ agent: string; runId: string | null; lastSeq: number } | null> {
    const { rows } = await this.opts.pool.query<{ agent: string; run_id: string | null; last_delivered_seq: number }>(
      "SELECT agent, run_id, last_delivered_seq FROM toren_control.telegram_bindings WHERE chat_id = $1",
      [chat],
    );
    return rows[0] ? { agent: rows[0].agent, runId: rows[0].run_id, lastSeq: rows[0].last_delivered_seq } : null;
  }

  private async putBinding(chat: number, agent: string, runId: string | null): Promise<void> {
    await this.opts.pool.query(
      `INSERT INTO toren_control.telegram_bindings (chat_id, agent, run_id, last_delivered_seq)
       VALUES ($1, $2, $3, 0)
       ON CONFLICT (chat_id) DO UPDATE SET agent = $2, run_id = $3, last_delivered_seq = 0, updated_at = now()`,
      [chat, agent, runId],
    );
  }
}

export async function createTelegramInvite(pool: pg.Pool): Promise<string> {
  const code = randomBytes(4).toString("hex");
  await pool.query("INSERT INTO toren_control.telegram_invites (code) VALUES ($1)", [code]);
  return code;
}

function sleep(ms: number, cancelled: () => boolean): Promise<void> {
  return new Promise((r) => {
    const step = Math.min(ms, 200);
    let waited = 0;
    const t = setInterval(() => {
      waited += step;
      if (waited >= ms || cancelled()) { clearInterval(t); r(); }
    }, step);
  });
}
