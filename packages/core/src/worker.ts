import { randomUUID } from "node:crypto";
import { runTaskLoop, TaskLeaseLostError } from "./loop.js";
import { findTaskSpec, tick, type TickDeps } from "./orchestrator.js";
import type { Delivery } from "./queue.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface WorkerOpts { concurrency?: number; visibilitySeconds?: number; pollMs?: number }

/**
 * Local worker runtime: in-process pollers over the orchestrator and task
 * queues (spec §4.2 local binding). One instance serves both roles.
 */
export class LocalWorkerRuntime {
  private stopped = false;
  private loops: Promise<void>[] = [];
  private inFlight = 0;
  private readonly opts: Required<WorkerOpts>;

  constructor(private deps: TickDeps, opts: WorkerOpts = {}) {
    this.opts = { concurrency: opts.concurrency ?? 2, visibilitySeconds: opts.visibilitySeconds ?? 60, pollMs: opts.pollMs ?? 20 };
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
      const busy = this.inFlight > 0 || (await this.deps.queue.depth()) > 0;
      quiet = busy ? 0 : quiet + 1;
      if (quiet >= 5) return;
      await sleep(this.opts.pollMs);
    }
    throw new Error(`drain timed out after ${timeoutMs}ms`);
  }

  private async pollLoop(owner: string): Promise<void> {
    while (!this.stopped) {
      const d =
        (await this.deps.queue.receive("orchestrator", { max: 1, visibilitySeconds: this.opts.visibilitySeconds }))[0] ??
        (await this.deps.queue.receive("tasks-short", { max: 1, visibilitySeconds: this.opts.visibilitySeconds }))[0];
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
    try {
      if (msg.kind === "tick") {
        await tick(this.deps, msg.runId);
        await this.deps.queue.ack(d);
        return;
      }
      // task message
      const taskId = msg.taskId!;
      const streamId = `task:${taskId}` as const;
      const lease = await this.deps.leases.acquire(msg.runId, streamId, owner, this.opts.visibilitySeconds);
      if (!lease) {
        await this.deps.queue.ack(d); // someone else owns it; message was a hint
        return;
      }
      try {
        const spec = await findTaskSpec(this.deps.store, msg.runId, taskId);
        if (!spec) {
          await this.deps.queue.ack(d); // stale hint for an invalidated plan
          return;
        }
        const agent = this.deps.agents[spec.agentRef];
        if (!agent) throw new Error(`no agent registered for ref ${spec.agentRef}`);
        await runTaskLoop({
          store: this.deps.store, provider: this.deps.provider,
          runId: msg.runId, taskId, agent, input: spec.input,
        });
        await this.deps.queue.ack(d);
        // Nudge the orchestrator to absorb the terminal/parked state (spec §5.1).
        await this.deps.queue.send("orchestrator", { kind: "tick", runId: msg.runId, dedupeKey: `settle-${msg.runId}-${taskId}` });
      } finally {
        await this.deps.leases.release(lease);
      }
    } catch (e) {
      if (e instanceof TaskLeaseLostError) {
        await this.deps.queue.ack(d);
        return;
      }
      await this.deps.queue.nack(d, { delaySeconds: 0.2 });
    }
  }
}
