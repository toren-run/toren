import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { CmdIO } from "./commands.js";

/**
 * The terminal channel: an interactive durable session. The loop itself is
 * backend-agnostic — cmdChat drives it against the local runtime, remoteChat
 * against a deployment's HTTP API — so the terminal behaves exactly like the
 * console and Telegram: strict turns, transcript folded from the log, Ctrl+C
 * leaves the conversation open to resume later.
 */

export interface ChatBackend {
  agentName: string;
  start(message: string): Promise<string>;
  send(runId: string, message: string, close?: boolean): Promise<void>;
  get(runId: string): Promise<{ state: string; transcript: { role: string; text: string; seq: number }[] } | null>;
}

export async function runChatLoop(backend: ChatBackend, opts: { sessionId?: string }, io: CmdIO): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  let runId = opts.sessionId;
  let printed = -1;

  const printNew = (transcript: { role: string; text: string; seq: number }[]) => {
    for (const t of transcript) {
      if (t.seq <= printed) continue;
      io.out(t.role === "assistant" ? `${backend.agentName}> ${t.text}` : `you> ${t.text}`);
      printed = t.seq;
    }
  };

  // Background wakes (a spawned run settling) land while the user sits at the
  // prompt; poll so the agent's message prints live instead of on the next send.
  const watcher = setInterval(() => {
    if (!runId) return;
    void backend.get(runId).then((s) => {
      if (s) printNew(s.transcript.filter((t) => t.role === "assistant"));
    }).catch(() => { /* transient; next poll */ });
  }, 1_500);

  /** Wait out the agent's turn, printing replies as they land. */
  const drain = async (): Promise<string> => {
    for (;;) {
      const s = await backend.get(runId!);
      if (!s) throw new Error(`no session ${runId}`);
      printNew(s.transcript.filter((t) => t.role === "assistant"));
      if (s.state !== "working") return s.state;
      await new Promise((r) => setTimeout(r, 400));
    }
  };

  if (runId) {
    const s = await backend.get(runId);
    if (!s) throw new Error(`no session ${runId}`);
    printNew(s.transcript);
    if (s.state !== "awaiting_input" && s.state !== "working") {
      io.out(`that session is ${s.state}; start a new one by just running toren chat`);
      rl.close();
      return;
    }
  } else {
    io.out(`chatting with ${backend.agentName}. /end closes the conversation; Ctrl+C leaves it open to resume.`);
  }

  try {
    for (;;) {
      const line = (await rl.question("you> ")).trim();
      if (!line) continue;
      if (line === "/end") {
        if (runId) await backend.send(runId, "", true);
        io.out("conversation closed");
        return;
      }
      if (!runId) runId = await backend.start(line);
      else await backend.send(runId, line);
      const state = await drain();
      if (state !== "awaiting_input") {
        io.out(`session ${state}`);
        return;
      }
    }
  } catch (e) {
    // Ctrl+C / Ctrl+D closes readline mid-question; the session stays open.
    if (runId && e instanceof Error && /closed/i.test(e.message)) {
      io.out(`\nleft open — resume with: toren chat --session ${runId}`);
      return;
    }
    if (e instanceof Error && /closed/i.test(e.message)) return;
    throw e;
  } finally {
    clearInterval(watcher);
    rl.close();
  }
}
