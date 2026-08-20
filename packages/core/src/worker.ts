import { randomUUID } from "node:crypto";
import { runTaskLoop, TaskLeaseLostError } from "./loop.js";
import { findTaskSpec, tick, type TickDeps } from "./orchestrator.js";
import type { Delivery } from "./queue.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface WorkerOpts { concurrency?: number; visibilitySeconds?: number; pollMs?: number }

/**
 * Local worker runtime: in-process pollers over the orchestrator and task
 * queues (spec §4.2 local binding). One instance serves one agent or a whole
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
      this.sole = deps as TickDeps;
      this.byAgent = new Map();
      this.shared = this.sole;
    } else {
      const entries = Object.entries(deps);
      if (entries.length === 0) throw new Error("worker needs at least one agent's deps");
      this.byAgent = new Map(entries);
      this.sole = entries.length === 1 ? entries[0]![1] : null;
      this.shared = entries[0]![1];
    }
  }

  private depsFor(agent: string | undefined): TickDeps | null {
    if (this.sole) return this.sole;
    if (agent && this.byAgent.has(agent)) return this.byAgent.get(agent)!;
    return null; // unknown/unlabeled message on a fleet worker — stale hint
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
      const busy = this.inFlight > 0 || (await this.shared.queue.depth()) > 0;
      quiet = busy ? 0 : quiet + 1;
      if (quiet >= 5) return;
      await sleep(this.opts.pollMs);
    }
    throw new Error(`drain timed out after ${timeoutMs}ms`);
  }

  private async pollLoop(owner: string): Promise<void> {
    while (!this.stopped) {
      const d =
        (await this.shared.queue.receive("orchestrator", { max: 1, visibilitySeconds: this.opts.visibilitySeconds }))[0] ??
        (await this.shared.queue.receive("tasks-short", { max: 1, visibilitySeconds: this.opts.visibilitySeconds }))[0];
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
        await runTaskLoop({
          store: deps.store, provider: deps.provider,
          runId: msg.runId, taskId, agent, input: spec.input,
        });
        await this.shared.queue.ack(d);
        // Nudge the orchestrator to absorb the terminal/parked state (spec §5.1).
        await this.shared.queue.send("orchestrator", { kind: "tick", runId: msg.runId, agent: msg.agent, dedupeKey: `settle-${msg.runId}-${taskId}` });
      } finally {
        await deps.leases.release(lease);
      }
    } catch (e) {
      if (e instanceof TaskLeaseLostError) {
        await this.shared.queue.ack(d);
        return;
      }
      await this.shared.queue.nack(d, { delaySeconds: 0.2 });
    }
  }
}
