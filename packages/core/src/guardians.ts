import type { TickDeps } from "./orchestrator.js";

/**
 * The guardians: one scheduled pass that re-nudges every
 * non-terminal run. Covers lost queue messages (reconciler role) and runs
 * whose workers died mid-flight (watchdog role — expired leases simply stop
 * blocking the next tick). Ticks are cheap no-ops when nothing changed, so
 * the sweep needs no per-run state.
 */
export async function sweep(deps: Pick<TickDeps, "store" | "queue">, agent?: string): Promise<number> {
  const runs = await deps.store.listNonTerminalRuns();
  for (const runId of runs) {
    await deps.queue.send("orchestrator", { kind: "tick", runId, agent, dedupeKey: `sweep-${runId}` });
  }
  return runs.length;
}
