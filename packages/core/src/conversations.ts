import { effectiveEvents } from "./fold.js";
import { ev } from "./events.js";
import { startRun, type TickDeps } from "./orchestrator.js";
import type { PgStateStore } from "./store.js";

/**
 * Sessions: turn-based conversations as durable runs. A session is a run in
 * mode "session" whose root task alternates agent turns and user turns on one
 * event stream — the transcript IS the log, so a resumed session replays every
 * prior turn for free and survives anything mid-sentence.
 *
 * Turn-taking is strict: a message is accepted only while the session awaits
 * input. That keeps the stream single-writer (the worker owns it mid-turn)
 * and matches the product model — you talk, the agent works, it answers.
 */

/** The default workflow plans exactly one task; sessions ride it. */
const SESSION_TASK = "w0t0";

export type SessionState = "working" | "awaiting_input" | "completed" | "failed" | "cancelled";

export interface SessionTurn {
  role: "user" | "assistant";
  text: string;
  channel?: string;
  seq: number;
}

export class SessionBusyError extends Error {
  constructor() { super("the agent is mid-turn — wait for it to finish before sending"); }
}

export async function startSession(
  deps: TickDeps,
  req: { agent: string; message: string; channel?: string },
): Promise<string> {
  return startRun(deps, { agent: req.agent, input: req.message, mode: "session", channel: req.channel });
}

async function foldSession(store: PgStateStore, runId: string) {
  const run = await store.getRun(runId);
  if (!run || run.mode !== "session") return null;
  const eff = effectiveEvents(await store.read(runId, `task:${SESSION_TASK}`));
  let lastInputSeq = 0, lastUserSeq = 0;
  for (const e of eff) {
    if (e.type === "InputRequested") lastInputSeq = e.seq;
    else if (e.type === "UserMessage") lastUserSeq = e.seq;
  }
  const awaiting = lastInputSeq > 0 && lastUserSeq < lastInputSeq;
  const head = eff.at(-1)?.seq ?? 0;
  return { run, eff, awaiting, head };
}

export async function getSession(store: PgStateStore, runId: string): Promise<{
  runId: string; agent: string; state: SessionState; transcript: SessionTurn[];
} | null> {
  const s = await foldSession(store, runId);
  if (!s) return null;
  const transcript: SessionTurn[] = [];
  const input = typeof s.run.input === "string" ? s.run.input : JSON.stringify(s.run.input);
  transcript.push({ role: "user", text: input, seq: 0 });
  for (const e of s.eff) {
    if (e.type === "InputRequested") {
      transcript.push({ role: "assistant", text: String(e.payload.text ?? ""), seq: e.seq });
    } else if (e.type === "UserMessage" && !e.payload.close) {
      transcript.push({ role: "user", text: String(e.payload.text ?? ""), channel: e.payload.channel as string | undefined, seq: e.seq });
    } else if (e.type === "TaskCompleted") {
      // The closing assistant text is already in the last InputRequested.
    }
  }
  const state: SessionState =
    s.run.status === "completed" || s.run.status === "failed" || s.run.status === "cancelled"
      ? (s.run.status as SessionState)
      : s.awaiting ? "awaiting_input" : "working";
  return { runId, agent: s.run.agent, state, transcript };
}

/**
 * Appends the user's turn and wakes the worker. Rejects while the agent is
 * mid-turn (strict turn-taking; the caller shows "agent is working").
 */
export async function sendSessionMessage(
  deps: TickDeps,
  runId: string,
  req: { text: string; channel?: string; close?: boolean },
): Promise<void> {
  const s = await foldSession(deps.store, runId);
  if (!s) throw new Error(`no session ${runId}`);
  if (s.run.status === "completed" || s.run.status === "failed" || s.run.status === "cancelled") {
    throw new Error(`session is ${s.run.status}`);
  }
  if (!s.awaiting) throw new SessionBusyError();

  const r = await deps.store.append(runId, `task:${SESSION_TASK}`, s.head, [
    ev("UserMessage", { text: req.text, channel: req.channel, ...(req.close ? { close: true } : {}) }),
  ]);
  if (!r.ok) throw new SessionBusyError(); // a worker touched the stream since we looked

  await deps.queue.send("tasks-short", {
    kind: "task", runId, taskId: SESSION_TASK, agent: s.run.agent,
    dedupeKey: `msg-${runId}-${r.lastSeq}`,
  });
}

export async function listSessions(store: PgStateStore, limit = 50): Promise<{
  runId: string; agent: string; status: string; createdAt: Date;
}[]> {
  const runs = await store.listRuns(limit * 2);
  return runs.filter((r) => r.mode === "session").slice(0, limit);
}
