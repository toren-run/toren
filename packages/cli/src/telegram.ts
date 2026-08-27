import { randomBytes } from "node:crypto";
import type pg from "pg";
import {
  getSession, listPendingApprovals, resolveApproval, sendSessionMessage, SessionBusyError, startSession,
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

/** Telegram rejects sendMessage over 4096 chars; stay under with headroom. */
const MAX_MESSAGE_CHARS = 4000;

export class TelegramApiError extends Error {
  constructor(message: string, readonly code: number) { super(message); }
  /** 4xx minus rate limiting: retrying the identical payload can never succeed. */
  get permanent(): boolean { return this.code >= 400 && this.code < 500 && this.code !== 429; }
}

/** Split at the last newline before the limit, else the last space, else hard. */
export function splitMessage(text: string, limit = MAX_MESSAGE_CHARS): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const at = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const cut = at > limit / 2 ? at : limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  parts.push(rest);
  return parts;
}

interface TgUpdate {
  update_id: number;
  message?: { message_id: number; from?: { id: number }; chat?: { id: number; type?: string }; text?: string };
}

export interface TelegramChannelOpts {
  botToken: string;
  /** Scopes pairing, bindings, and poll state. "default" = the shared fleet bot; dedicated bots use "agent:<name>" so token rotation never orphans pairings. */
  botKey?: string;
  byAgent: Record<string, TickDeps>;
  defaultAgent: string;
  pool: pg.Pool;
  allowedUsers?: Set<number>;
  fetchImpl?: typeof fetch;
  /** getUpdates long-poll horizon; 0 makes tests snappy. */
  pollTimeoutSec?: number;
  deliverMs?: number;
  /** Where operational lines go (elections, poll failures, heartbeats). Default: stderr — a silent death mode is worse than a noisy log. */
  log?: (line: string) => void;
  /** Heartbeat interval for the "poller alive" line; default 5 minutes. */
  heartbeatMs?: number;
}

/** Live health of one bot's channel, exposed via /healthz. A dead poller must be distinguishable from a quiet one. */
export interface TelegramChannelStatus {
  botKey: string;
  elected: boolean;
  polling: boolean;
  lastPollOkAt: string | null;
  lastUpdateId: number;
  lastError: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
}

export class TelegramChannel {
  private stopped = false;
  private client: PoolClient | null = null;
  private loops: Promise<void>[] = [];
  private readonly botKey: string;
  private readonly log: (line: string) => void;
  private st: TelegramChannelStatus;
  /** Approval prompts already sent, keyed runId:stepId. In-memory: a restarted poller re-prompts once, which doubles as a reminder. */
  private deliveredApprovals = new Set<string>();
  constructor(private opts: TelegramChannelOpts) {
    this.botKey = opts.botKey ?? "default";
    this.log = opts.log ?? ((line) => console.error(line));
    this.st = { botKey: this.botKey, elected: false, polling: false, lastPollOkAt: null, lastUpdateId: 0, lastError: null, lastErrorAt: null, consecutiveFailures: 0 };
  }

  status(): TelegramChannelStatus { return { ...this.st }; }

  private noteError(where: string, e: unknown): void {
    // The bot token lives in every API URL; error strings from the fetch stack
    // must never carry it into logs or /healthz (the same class of leak as a
    // pinned API token in the boot banner).
    const raw = `${where}: ${e instanceof Error ? e.message : String(e)}`;
    const msg = raw.split(this.opts.botToken).join("<bot-token>");
    // Log on transition into failure, not on every retry — and never silently.
    if (this.st.consecutiveFailures === 0) this.log(`toren telegram[${this.botKey}]: ${msg} (retrying)`);
    this.st.lastError = msg;
    this.st.lastErrorAt = new Date().toISOString();
    this.st.consecutiveFailures++;
  }

  private noteOk(): void {
    if (this.st.consecutiveFailures > 0) this.log(`toren telegram[${this.botKey}]: recovered after ${this.st.consecutiveFailures} failed attempts`);
    this.st.consecutiveFailures = 0;
    this.st.lastPollOkAt = new Date().toISOString();
  }

  /** int4 for the two-arg advisory lock: one poller election per bot, not per deployment. */
  private lockArg(): number {
    let h = 0;
    for (const c of this.botKey) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
    return h;
  }

  start(): void {
    this.loops = [this.runElected().catch(() => { /* stop() mid-flight */ })];
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(this.loops);
    if (this.client) {
      await this.client.query("SELECT pg_advisory_unlock($1, $2)", [LOCK_KEY, this.lockArg()]).catch(() => {});
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
    const body = (await res.json()) as { ok: boolean; result?: T; description?: string; error_code?: number };
    if (!body.ok) throw new TelegramApiError(`telegram ${method}: ${body.description ?? res.status}`, body.error_code ?? res.status);
    return body.result as T;
  }

  /**
   * sendMessage that can always deliver: Telegram rejects texts over 4096
   * chars, so long turns are split at line/word boundaries. A response the API
   * still permanently refuses (a 4xx that isn't rate limiting) is replaced by
   * a short notice — one bad message must never wedge the chat's cursor.
   */
  private async sendText(chat: number, text: string): Promise<void> {
    for (const part of splitMessage(text)) {
      try {
        await this.api("sendMessage", { chat_id: chat, text: part });
      } catch (e) {
        if (!(e instanceof TelegramApiError) || !e.permanent) throw e;
        this.noteError("sendMessage (permanent, message replaced by notice)", e);
        await this.api("sendMessage", { chat_id: chat, text: "(a reply could not be delivered to Telegram; it is still in the run log — toren jobs show)" }).catch(() => {});
      }
    }
  }

  private async runElected(): Promise<void> {
    // Nothing in here may exit silently: a channel that dies while the
    // process stays RUNNING is indistinguishable from a quiet day (field
    // report 2026-08-25). Every failure path logs and retries.
    while (!this.stopped) {
      let client: PoolClient;
      try {
        client = await this.opts.pool.connect();
      } catch (e) {
        this.noteError("db connect", e);
        await sleep(5_000, () => this.stopped);
        continue;
      }
      try {
        const r = await client.query<{ won: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS won", [LOCK_KEY, this.lockArg()]);
        if (!r.rows[0]?.won) {
          client.release();
          await sleep(10_000, () => this.stopped);
          continue;
        }
      } catch (e) {
        client.release();
        this.noteError("lock election", e);
        await sleep(5_000, () => this.stopped);
        continue;
      }
      this.client = client;
      this.st.elected = true;
      this.log(`toren telegram[${this.botKey}]: elected poller`);
      await Promise.allSettled([this.inboundLoop(), this.deliveryLoop()]);
      this.st.elected = false;
      this.st.polling = false;
      if (!this.stopped) this.log(`toren telegram[${this.botKey}]: loops exited unexpectedly; re-electing`);
    }
  }

  private async inboundLoop(): Promise<void> {
    let offset = 0;
    let lastSeen = -1; // resolved inside the loop so a boot-time DB blip retries instead of killing the loop for the process's lifetime
    let lastHeartbeat = Date.now();
    const heartbeatMs = this.opts.heartbeatMs ?? 300_000;
    this.st.polling = true;
    while (!this.stopped) {
      try {
        if (lastSeen < 0) {
          const { rows } = await this.opts.pool.query<{ last_update_id: string }>(
            "SELECT last_update_id FROM toren_control.telegram_poll_state WHERE bot_key = $1", [this.botKey],
          );
          lastSeen = rows[0] ? Number(rows[0].last_update_id) : 0;
          this.st.lastUpdateId = lastSeen;
        }
        const updates = await this.api<TgUpdate[]>("getUpdates", {
          offset, timeout: this.opts.pollTimeoutSec ?? 25,
        });
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          if (u.update_id <= lastSeen) continue; // redelivered after a crash
          if (u.message) await this.handleMessage(u.message).catch(() => { /* one bad update never stalls the loop */ });
          lastSeen = u.update_id;
          this.st.lastUpdateId = lastSeen;
          await this.opts.pool.query(
            `INSERT INTO toren_control.telegram_poll_state (bot_key, last_update_id) VALUES ($1, $2)
             ON CONFLICT (bot_key) DO UPDATE SET last_update_id = GREATEST(toren_control.telegram_poll_state.last_update_id, $2)`,
            [this.botKey, lastSeen],
          );
        }
        this.noteOk();
        if (Date.now() - lastHeartbeat >= heartbeatMs) {
          lastHeartbeat = Date.now();
          this.log(`toren telegram[${this.botKey}]: poller alive, offset ${this.st.lastUpdateId}`);
        }
        if (updates.length === 0 && (this.opts.pollTimeoutSec ?? 25) === 0) await sleep(150, () => this.stopped);
      } catch (e) {
        this.noteError("poll", e);
        if (Date.now() - lastHeartbeat >= heartbeatMs) {
          lastHeartbeat = Date.now();
          this.log(`toren telegram[${this.botKey}]: poller FAILING for ${this.st.consecutiveFailures} attempts, last error ${this.st.lastError}`);
        }
        await sleep(3_000, () => this.stopped);
      }
    }
  }

  private async handleMessage(msg: NonNullable<TgUpdate["message"]>): Promise<void> {
    const from = msg.from?.id, chat = msg.chat?.id;
    const text = (msg.text ?? "").trim();
    if (!from || !chat || !text) return;
    const say = (t: string) => this.sendText(chat, t);

    if (!(await this.isAllowed(from))) {
      const redeemed = await this.opts.pool.query(
        "UPDATE toren_control.telegram_invites SET used_by = $2 WHERE code = $1 AND bot_key = $3 AND used_by IS NULL RETURNING code",
        [text, from, this.botKey],
      );
      if (redeemed.rowCount) {
        await this.opts.pool.query(
          "INSERT INTO toren_control.telegram_users (bot_key, user_id, via_code) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
          [this.botKey, from, text],
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
        "/approve or /deny answers a pending approval\n" +
        "/end closes the open conversation",
      );
      return;
    }
    if (cmd === "/approve" || cmd === "/deny") {
      if (!b?.runId) {
        await say("No open conversation, so nothing to approve.");
        return;
      }
      const deps = this.opts.byAgent[b.agent]!;
      const pending = await listPendingApprovals(deps.store, b.runId);
      const p = pending[0];
      if (!p) {
        await say("Nothing is waiting for approval.");
        return;
      }
      const comment = text.slice(cmd.length).trim() || undefined;
      await resolveApproval(deps, {
        runId: p.runId, taskId: p.taskId, stepId: p.stepId, agent: b.agent,
        granted: cmd === "/approve", by: "telegram", comment,
      });
      this.deliveredApprovals.delete(`${p.runId}:${p.stepId}`);
      await say(cmd === "/approve" ? "Approved. The agent continues." : "Denied. The agent will be told.");
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
      try {
        const { rows } = await this.opts.pool.query<{ chat_id: string; agent: string; run_id: string; last_delivered_seq: number }>(
          "SELECT chat_id, agent, run_id, last_delivered_seq FROM toren_control.telegram_bindings WHERE bot_key = $1 AND run_id IS NOT NULL", [this.botKey],
        );
        for (const row of rows) {
          try {
            await this.deliverOne(Number(row.chat_id), row.agent, row.run_id, row.last_delivered_seq);
          } catch { /* next tick retries */ }
        }
      } catch (e) {
        this.noteError("delivery scan", e); // a DB blip must never end the loop for the process's lifetime
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
      await this.sendText(chat, t.text || "…");
      const r = await this.opts.pool.query(
        "UPDATE toren_control.telegram_bindings SET last_delivered_seq = $1, updated_at = now() WHERE bot_key = $4 AND chat_id = $2 AND last_delivered_seq = $3",
        [t.seq, chat, prev, this.botKey],
      );
      if (!r.rowCount) return; // someone else moved the cursor — defer to them
      prev = t.seq;
    }
    await this.deliverOutbox(chat, runId, deps).catch((e) => this.noteError("outbox delivery", e));
    if (s.state === "working") {
      // A gated tool call parks the run; without this, the chat shows a typing
      // indicator forever (field report 2026-08-27). Surface each pending
      // approval once; /approve and /deny answer it.
      const pending = await listPendingApprovals(deps.store, runId).catch(() => []);
      for (const p of pending) {
        const key = `${p.runId}:${p.stepId}`;
        if (this.deliveredApprovals.has(key)) continue;
        const args = JSON.stringify(p.args ?? {});
        await this.sendText(chat, `Approval needed. The agent wants to run:\n${p.tool}: ${args.length > 500 ? args.slice(0, 500) + "…" : args}\n\nReply /approve or /deny (optionally with a comment).`);
        this.deliveredApprovals.add(key);
      }
      if (pending.length === 0) await this.typing(chat).catch(() => {});
    }
    if (s.state === "failed") {
      await this.api("sendMessage", { chat_id: chat, text: "The agent hit an error and this conversation ended. Say anything to start fresh." });
      await this.opts.pool.query("UPDATE toren_control.telegram_bindings SET run_id = NULL, updated_at = now() WHERE bot_key = $3 AND chat_id = $1 AND run_id = $2", [chat, runId, this.botKey]);
    } else if (s.state === "completed" || s.state === "cancelled") {
      await this.opts.pool.query("UPDATE toren_control.telegram_bindings SET run_id = NULL, updated_at = now() WHERE bot_key = $3 AND chat_id = $1 AND run_id = $2", [chat, runId, this.botKey]);
    }
  }

  /**
   * Upload files the run queued via the send_to_channel builtin. Claim is a
   * conditional UPDATE on delivered_at, so a crash mid-upload re-sends (at
   * least once — the alternative silently loses the CEO's report) and two
   * pollers never double-claim.
   */
  private async deliverOutbox(chat: number, runId: string, deps: TickDeps): Promise<void> {
    const { rows } = await this.opts.pool.query<{ id: string; kind: string; file_id: string; caption: string | null }>(
      "SELECT id, kind, file_id, caption FROM toren_control.channel_outbox WHERE run_id = $1 AND delivered_at IS NULL ORDER BY id",
      [runId],
    );
    for (const row of rows) {
      const file = await deps.files?.getData(row.file_id);
      if (!file) {
        await this.opts.pool.query("UPDATE toren_control.channel_outbox SET delivered_at = now() WHERE id = $1", [row.id]);
        continue; // file vanished — nothing to send, never wedge the outbox
      }
      const method = row.kind === "photo" ? "sendPhoto" : "sendDocument";
      const field = row.kind === "photo" ? "photo" : "document";
      const form = new FormData();
      form.append("chat_id", String(chat));
      if (row.caption) form.append("caption", row.caption.slice(0, 1000));
      form.append(field, new Blob([new Uint8Array(file.data)]), file.name);
      const f = this.opts.fetchImpl ?? fetch;
      const res = await f(`https://api.telegram.org/bot${this.opts.botToken}/${method}`, { method: "POST", body: form });
      const body = (await res.json()) as { ok: boolean; description?: string; error_code?: number };
      if (!body.ok) {
        const err = new TelegramApiError(`telegram ${method}: ${body.description ?? res.status}`, body.error_code ?? res.status);
        if (!err.permanent) throw err; // transient — next delivery tick retries
        this.noteError(`${method} (permanent, file dropped)`, err);
        await this.api("sendMessage", { chat_id: chat, text: `(a file could not be delivered: ${file.name}. it is still in the run's file store)` }).catch(() => {});
      }
      await this.opts.pool.query("UPDATE toren_control.channel_outbox SET delivered_at = now() WHERE id = $1 AND delivered_at IS NULL", [row.id]);
    }
  }

  private typing(chat: number): Promise<unknown> {
    return this.api("sendChatAction", { chat_id: chat, action: "typing" });
  }

  private async isAllowed(userId: number): Promise<boolean> {
    if (this.opts.allowedUsers?.has(userId)) return true;
    const { rowCount } = await this.opts.pool.query("SELECT 1 FROM toren_control.telegram_users WHERE bot_key = $1 AND user_id = $2", [this.botKey, userId]);
    return (rowCount ?? 0) > 0;
  }

  private async getBinding(chat: number): Promise<{ agent: string; runId: string | null; lastSeq: number } | null> {
    const { rows } = await this.opts.pool.query<{ agent: string; run_id: string | null; last_delivered_seq: number }>(
      "SELECT agent, run_id, last_delivered_seq FROM toren_control.telegram_bindings WHERE bot_key = $1 AND chat_id = $2",
      [this.botKey, chat],
    );
    return rows[0] ? { agent: rows[0].agent, runId: rows[0].run_id, lastSeq: rows[0].last_delivered_seq } : null;
  }

  private async putBinding(chat: number, agent: string, runId: string | null): Promise<void> {
    await this.opts.pool.query(
      `INSERT INTO toren_control.telegram_bindings (bot_key, chat_id, agent, run_id, last_delivered_seq)
       VALUES ($4, $1, $2, $3, 0)
       ON CONFLICT (bot_key, chat_id) DO UPDATE SET agent = $2, run_id = $3, last_delivered_seq = 0, updated_at = now()`,
      [chat, agent, runId, this.botKey],
    );
  }
}

export async function createTelegramInvite(pool: pg.Pool, botKey = "default"): Promise<string> {
  const code = randomBytes(4).toString("hex");
  await pool.query("INSERT INTO toren_control.telegram_invites (code, bot_key) VALUES ($1, $2)", [code, botKey]);
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
