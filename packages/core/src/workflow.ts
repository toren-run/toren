import { canonicalDigest } from "./digest.js";
import { ev, type NewEvent, type RecordedEvent } from "./events.js";
import type { PgStateStore } from "./store.js";
import type { QueueMessage, QueueName } from "./queue.js";

export interface TaskSpec { agentRef: string; input: string }
export interface TaskOutcome { taskId: string; status: "completed" | "failed"; output?: string; error?: string }
export interface WaveResult { name: string; results: TaskOutcome[] }
export interface WaveOpts { onTaskFailure?: "fail" | "collect" }

export interface WorkflowCtx {
  input: string;
  task(agentRef: string, input: string): TaskSpec;
  wave(name: string, tasks: TaskSpec[], opts?: WaveOpts): Promise<WaveResult>;
  now(): Promise<number>;
  random(): Promise<number>;
  sleep(ms: number): Promise<void>;
}
export type WorkflowFn = (ctx: WorkflowCtx) => Promise<string>;

export class WorkflowBlocked extends Error {
  constructor(public reason: string) { super(`workflow blocked: ${reason}`); }
}
export class WaveFailedError extends Error {}
export class RunLeaseLostError extends Error {}

export interface WaveState {
  seq: number;
  waveId: string;
  index: number;
  name: string;
  tasks: { taskId: string; agentRef: string; input: string }[];
  planDigest: string;
  dispatched: boolean;
  settledTasks: Map<string, TaskOutcome>;
  settled: boolean;
}
export interface TimerState { seq: number; timerId: string; fireAt: number; fired: boolean }

export interface RunStreamState {
  sideEffects: RecordedEvent[];
  waves: WaveState[];
  timers: TimerState[];
  started: boolean;
  terminal?: { status: "completed" | "failed" | "cancelled"; output?: string; error?: string };
}

export function foldRunStream(eff: RecordedEvent[]): RunStreamState {
  const state: RunStreamState = { sideEffects: [], waves: [], timers: [], started: false };
  for (const e of eff) {
    switch (e.type) {
      case "RunStarted": state.started = true; break;
      case "SideEffectRecorded": state.sideEffects.push(e); break;
      case "WavePlanned":
        state.waves.push({
          seq: e.seq,
          waveId: String(e.payload.waveId),
          index: Number(e.payload.index),
          name: String(e.payload.name),
          tasks: e.payload.tasks as WaveState["tasks"],
          planDigest: String(e.payload.planDigest),
          dispatched: false,
          settledTasks: new Map(),
          settled: false,
        });
        break;
      case "WaveDispatched": {
        const w = state.waves.find((x) => x.waveId === e.payload.waveId);
        if (w) w.dispatched = true;
        break;
      }
      case "WaveTaskSettled": {
        const w = state.waves.find((x) => x.waveId === e.payload.waveId);
        if (w) {
          w.settledTasks.set(String(e.payload.taskId), {
            taskId: String(e.payload.taskId),
            status: e.payload.status as "completed" | "failed",
            output: e.payload.output as string | undefined,
            error: e.payload.error as string | undefined,
          });
        }
        break;
      }
      case "WaveSettled": {
        const w = state.waves.find((x) => x.waveId === e.payload.waveId);
        if (w) w.settled = true;
        break;
      }
      case "TimerSet":
        state.timers.push({ seq: e.seq, timerId: String(e.payload.timerId), fireAt: Number(e.payload.fireAt), fired: false });
        break;
      case "TimerFired": {
        const t = state.timers.find((x) => x.timerId === e.payload.timerId);
        if (t) t.fired = true;
        break;
      }
      case "RunCompleted": state.terminal = { status: "completed", output: e.payload.output as string | undefined }; break;
      case "RunFailed": state.terminal = { status: "failed", error: e.payload.error as string | undefined }; break;
      case "RunCancelled": state.terminal = { status: "cancelled" }; break;
      default: break;
    }
  }
  return state;
}

export interface PendingDispatch { queue: QueueName; msg: QueueMessage; delaySeconds?: number }

export interface RunSession {
  store: PgStateStore;
  runId: string;
  input: string;
  head: number;
  folded: RunStreamState;
  seCursor: number;
  waveCursor: number;
  timerCursor: number;
  invalidated: boolean;
  pendingDispatch: PendingDispatch[];
  /** Tasks parked on an unresolved approval — never re-nudged by ticks. */
  parkedTasks: Set<string>;
}

export function makeSession(store: PgStateStore, runId: string, input: string, raw: RecordedEvent[], eff: RecordedEvent[], parkedTasks: Set<string> = new Set()): RunSession {
  return {
    store, runId, input,
    head: raw.at(-1)?.seq ?? 0,
    folded: foldRunStream(eff),
    seCursor: 0, waveCursor: 0, timerCursor: 0,
    invalidated: false,
    pendingDispatch: [],
    parkedTasks,
  };
}

export function createWorkflowCtx(s: RunSession): WorkflowCtx {
  async function append(events: NewEvent[]): Promise<void> {
    const r = await s.store.append(s.runId, "run", s.head, events);
    if (!r.ok) throw new RunLeaseLostError(`run stream advanced concurrently (expected ${s.head}, actual ${r.actualSeq})`);
    s.head = r.lastSeq;
  }

  async function invalidateFrom(fromSeq: number, reason: string): Promise<void> {
    await append([ev("StreamInvalidated", { fromSeq, reason })]);
    s.invalidated = true; // all remaining recorded entries are void (consumption is seq-ordered)
  }

  async function sideEffect(kind: string, generate: () => number): Promise<number> {
    const rec = s.invalidated ? undefined : s.folded.sideEffects[s.seCursor];
    if (rec) {
      if (rec.payload.kind !== kind) {
        await invalidateFrom(rec.seq, `side effect kind changed (recorded ${String(rec.payload.kind)}, expected ${kind})`);
      } else {
        s.seCursor += 1;
        return Number(rec.payload.value);
      }
    }
    const value = generate();
    await append([ev("SideEffectRecorded", { stepId: `s${s.head + 1}`, kind, value })]);
    return value;
  }

  function enqueueTaskMessages(w: WaveState): void {
    for (const t of w.tasks) {
      if (!w.settledTasks.has(t.taskId) && !s.parkedTasks.has(t.taskId)) {
        s.pendingDispatch.push({ queue: "tasks-short", msg: { kind: "task", runId: s.runId, taskId: t.taskId, dedupeKey: `${s.runId}:${t.taskId}` } });
      }
    }
  }

  return {
    input: s.input,
    task: (agentRef, input) => ({ agentRef, input }),

    now: () => sideEffect("now", () => Date.now()),
    random: () => sideEffect("random", () => Math.random()),

    async sleep(ms: number): Promise<void> {
      const rec = s.invalidated ? undefined : s.folded.timers[s.timerCursor];
      if (rec) {
        s.timerCursor += 1;
        if (rec.fired) return;
        if (Date.now() >= rec.fireAt) {
          await append([ev("TimerFired", { timerId: rec.timerId })]);
          return;
        }
        s.pendingDispatch.push({
          queue: "orchestrator",
          msg: { kind: "tick", runId: s.runId, dedupeKey: `timer-${rec.timerId}` },
          delaySeconds: Math.max(0.05, (rec.fireAt - Date.now()) / 1000),
        });
        throw new WorkflowBlocked(`timer ${rec.timerId}`);
      }
      const base = await this.now();
      const fireAt = base + ms;
      const timerId = `tm${s.head + 1}`;
      await append([ev("TimerSet", { timerId, fireAt })]);
      if (Date.now() >= fireAt) {
        await append([ev("TimerFired", { timerId })]);
        return;
      }
      s.pendingDispatch.push({
        queue: "orchestrator",
        msg: { kind: "tick", runId: s.runId, dedupeKey: `timer-${timerId}` },
        delaySeconds: Math.max(0.05, ms / 1000),
      });
      throw new WorkflowBlocked(`timer ${timerId}`);
    },

    async wave(name: string, tasks: TaskSpec[], opts?: WaveOpts): Promise<WaveResult> {
      const planDigest = canonicalDigest({ name, tasks });
      let w = s.invalidated ? undefined : s.folded.waves[s.waveCursor];

      if (w && w.planDigest !== planDigest) {
        await invalidateFrom(w.seq, `wave plan changed (${name})`);
        w = undefined;
      }

      if (!w) {
        const index = s.waveCursor;
        const waveId = `w${index}`;
        w = {
          seq: s.head + 1, waveId, index, name,
          tasks: tasks.map((t, i) => ({ taskId: `${waveId}t${i}`, agentRef: t.agentRef, input: t.input })),
          planDigest, dispatched: false, settledTasks: new Map(), settled: false,
        };
        await append([ev("WavePlanned", { waveId, index, name, tasks: w.tasks, planDigest })]);
        await append([ev("WaveDispatched", { waveId })]);
        w.dispatched = true;
        // task hints are enqueued once below, by the unsettled branch
      }
      s.waveCursor += 1;

      const allSettled = w.tasks.every((t) => w.settledTasks.has(t.taskId));
      if (!allSettled) {
        // Messages are hints (spec §6.3): re-nudge outstanding tasks so a lost
        // dispatch self-heals on the next tick; duplicates no-op at the worker.
        enqueueTaskMessages(w);
        throw new WorkflowBlocked(`wave ${name} unsettled`);
      }

      const results = w.tasks.map((t) => w.settledTasks.get(t.taskId)!);
      if (!w.settled) {
        const coverage = {
          dispatched: w.tasks.length,
          completed: results.filter((r) => r.status === "completed").length,
          failed: results.filter((r) => r.status === "failed").length,
        };
        await append([ev("WaveSettled", { waveId: w.waveId, coverage })]);
        w.settled = true;
      }
      if ((opts?.onTaskFailure ?? "fail") === "fail" && results.some((r) => r.status === "failed")) {
        const failed = results.filter((r) => r.status === "failed").map((r) => `${r.taskId}: ${r.error ?? "unknown"}`);
        throw new WaveFailedError(`wave ${name} failed: ${failed.join("; ")}`);
      }
      return { name, results };
    },
  };
}
