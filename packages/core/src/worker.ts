import { randomUUID } from "node:crypto";
import { InvalidationStormError, runTaskLoop, TaskLeaseLostError } from "./loop.js";
import { findTaskSpec, tick, type TickDeps } from "./orchestrator.js";
import type { Delivery } from "./queue.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff for task retries: 0.2s doubling per attempt, capped at 60s. */
export const retryDelaySeconds = (attempt: number): number => Math.min(60, 0.2 * 2 ** Math.max(0, attempt - 1));

export interface WorkerOpts { concurrency?: number; visibilitySeconds?: number; pollMs?: number }

/**
 * Local worker runtime: in-process pollers over the orchestrator and task
 * queues (local binding). One instance serves one agent or a whole
 * fleet — construct with a single TickDeps or a Record keyed by agent name;
 * messages carry the agent and are routed to that agent's deps (store,
 * leases, and specs are per-agent; the queue tables are shared).
 */
export class LocalWorkerRuntime {
  private stopped = false;
  private loops: Promise<void>[] = [];
  private inFlight = 0;
  private readonly opts: Required<WorkerOpts>;
  private readonly byAgent: Map<string, TickDeps>;
  /** Single-agent construction routes every message here, agent label or not. */
  private readonly sole: TickDeps | null;
  /** Any entry — used for the shared queue (polling, acking, depth). */
  private readonly shared: TickDeps;

  constructor(deps: TickDeps | Record<string, TickDeps>, opts: WorkerOpts = {}) {
    this.opts = { concurrency: opts.concurrency ?? 2, visibilitySeconds: opts.visibilitySeconds ?? 60, pollMs: opts.pollMs ?? 20 };
    if ("store" in deps) {
      // Legacy single-deps form: unscoped — claims and serves everything.
      this.sole = deps as TickDeps;
      this.byAgent = new Map();
      this.shared = this.sole;
    } else {
      // Fleet form — ALWAYS scoped to its agents, even a fleet of one, so
      // separate fleets can share a queue table without stealing hints.
      const entries = Object.entries(deps);
      if (entries.length === 0) throw new Error("worker needs at least one agent's deps");
      this.byAgent = new Map(entries);
      this.sole = null;
      this.shared = entries[0]![1];
    }
  }

  private depsFor(agent: string | undefined): TickDeps | null {
    if (this.sole) return this.sole;
    if (agent && this.byAgent.has(agent)) return this.byAgent.get(agent)!;
    // Unlabeled (pre-fleet) messages: a fleet of one can safely own them.
    if (!agent && this.byAgent.size === 1) return this.shared;
    return null; // unknown agent, or unlabeled on a multi-crew fleet — stale hint
  }

  /** Fleet workers claim only their own agents' messages; sole workers claim everything (legacy). */
  private get agentScope(): string[] | undefined {
    return this.sole ? undefined : [...this.byAgent.keys()];
  }

  start(): void {
    for (let i = 0; i < this.opts.concurrency; i++) this.loops.push(this.pollLoop(`worker-${i}-${randomUUID()}`));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.loops);
    this.loops = [];
  }

  /** Test helper: run until both queues stay empty and nothing is in flight. */
  async drain(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let quiet = 0;
    while (Date.now() < deadline) {
      const busy = this.inFlight > 0 || (await this.shared.queue.depth({ agents: this.agentScope })) > 0;
      quiet = busy ? 0 : quiet + 1;
      if (quiet >= 5) return;
      await sleep(this.opts.pollMs);
    }
    throw new Error(`drain timed out after ${timeoutMs}ms`);
  }

  private async pollLoop(owner: string): Promise<void> {
    let errorStreak = 0;
    while (!this.stopped) {
      let d: Delivery | undefined;
      try {
        d =
          (await this.shared.queue.receive("orchestrator", { max: 1, visibilitySeconds: this.opts.visibilitySeconds, agents: this.agentScope }))[0] ??
          (await this.shared.queue.receive("tasks-short", { max: 1, visibilitySeconds: this.opts.visibilitySeconds, agents: this.agentScope }))[0];
        errorStreak = 0;
      } catch {
        // Transient infrastructure error (DB restart, network blip). Back off
        // and keep polling — an uncaught throw here would kill this loop for
        // good and leave a worker that looks healthy but processes nothing.
        errorStreak = Math.min(errorStreak + 1, 6);
        await sleep(Math.min(this.opts.pollMs * 2 ** errorStreak, 30_000));
        continue;
      }
      if (!d) {
        await sleep(this.opts.pollMs);
        continue;
      }
      this.inFlight += 1;
      try {
        await this.handle(d, owner);
      } finally {
        this.inFlight -= 1;
      }
    }
  }

  private async handle(d: Delivery, owner: string): Promise<void> {
    const msg = d.message;
    const deps = this.depsFor(msg.agent);
    if (!deps) {
      // A hint for an agent this worker doesn't serve. Messages are hints,
      // never truth — the owning worker's guardians re-derive the work.
      await this.shared.queue.ack(d);
      return;
    }
    try {
      if (msg.kind === "tick") {
        await tick(deps, msg.runId);
        await this.shared.queue.ack(d);
        return;
      }
      // task message
      const taskId = msg.taskId!;
      const streamId = `task:${taskId}` as const;
      const lease = await deps.leases.acquire(msg.runId, streamId, owner, this.opts.visibilitySeconds);
      if (!lease) {
        await this.shared.queue.ack(d); // someone else owns it; message was a hint
        return;
      }
      try {
        const spec = await findTaskSpec(deps.store, msg.runId, taskId);
        if (!spec) {
          await this.shared.queue.ack(d); // stale hint for an invalidated plan
          return;
        }
        const agent = deps.agents[spec.agentRef];
        if (!agent) throw new Error(`no agent registered for ref ${spec.agentRef}`);
        const run = await deps.store.getRun(msg.runId);
        if (!run || run.status === "cancelled" || run.status === "completed" || run.status === "failed") {
          // A hint for a retired run: messages are never truth.
          await this.shared.queue.ack(d);
          return;
        }
        await runTaskLoop({
          store: deps.store, provider: deps.provider,
          runId: msg.runId, taskId, agent, input: spec.input, files: deps.files,
          sandbox: deps.sandbox?.forRun(msg.runId),
          processes: deps.processes,
          channels: deps.channels?.forRun(msg.runId),
          sessionMode: run?.mode === "session",
        });
        await this.shared.queue.ack(d);
        // Nudge the orchestrator to absorb the terminal/parked state.
        await this.shared.queue.send("orchestrator", { kind: "tick", runId: msg.runId, agent: msg.agent, dedupeKey: `settle-${msg.runId}-${taskId}` });
      } finally {
        await deps.leases.release(lease);
      }
    } catch (e) {
      try {
        if (e instanceof TaskLeaseLostError) {
          await this.shared.queue.ack(d);
          return;
        }
        if (e instanceof InvalidationStormError) {
          // Mixed worker versions are fighting over this stream. Back off well past
          // a deploy's drain window so the surviving version picks it up.
          await this.shared.queue.nack(d, { delaySeconds: 20 });
          return;
        }
        // An outside dependency failed (a provider, a tool, the network). The
        // retry is durability doing its job; the reason must not vanish into
        // it. Record it on the run so jobs/console answer "why is it stuck"
        // while the retries continue; a later success clears it.
        try {
          const reason = e instanceof Error ? e.message : String(e);
          await deps.store.updateRun(msg.runId, {
            error: `${reason}${msg.taskId ? ` (task ${msg.taskId}, attempt ${d.attempt})` : ""}`,
          });
        } catch { /* the store may be the thing that failed */ }
        await this.shared.queue.nack(d, { delaySeconds: retryDelaySeconds(d.attempt) });
      } catch {
        // Queue unreachable too: do nothing. The visibility timeout redelivers
        // the message; hints are never truth, so losing an ack costs a retry.
      }
    }
  }
}
