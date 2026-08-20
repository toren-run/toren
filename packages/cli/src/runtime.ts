import {
  createPool, migrateControl, provisionAgent, tx,
  PgStateStore, PgQueue, PgLeases,
  LocalWorkerRuntime, listPendingApprovals,
  type QueueAdapter, type TickDeps,
} from "@toren-run/core";
import { SqsQueue } from "@toren-run/adapters-aws";
import { RouterProvider } from "./router.js";
import type { LoadedAgent, LoadedProject } from "./loader.js";

/**
 * Queue selection: Postgres by default; SQS when TOREN_QUEUE=sqs
 * with the three queue URLs in env — how the Fargate worker is configured.
 */
export function selectQueue(pool: ReturnType<typeof createPool>, env: NodeJS.ProcessEnv = process.env): QueueAdapter {
  if (env.TOREN_QUEUE === "sqs") {
    const urls = {
      orchestrator: env.TOREN_SQS_URL_ORCHESTRATOR,
      "tasks-short": env.TOREN_SQS_URL_TASKS_SHORT,
      "tasks-long": env.TOREN_SQS_URL_TASKS_LONG,
    };
    for (const [name, url] of Object.entries(urls)) {
      if (!url) throw new Error(`TOREN_QUEUE=sqs but no url for "${name}" (set TOREN_SQS_URL_*)`);
    }
    return new SqsQueue({ urls: urls as Record<keyof typeof urls, string>, region: env.AWS_REGION });
  }
  return new PgQueue(pool);
}

export interface Runtime {
  pool: ReturnType<typeof createPool>;
  deps: TickDeps;
  schema: string;
  close(): Promise<void>;
}

export async function buildRuntime(loaded: LoadedAgent, databaseUrl?: string): Promise<Runtime> {
  const pool = createPool(databaseUrl);
  await tx(pool, async (c) => {
    await migrateControl(c);
    await provisionAgent(c, loaded.name);
  });
  const schema = `agent_${loaded.name}`;
  const deps: TickDeps = {
    store: new PgStateStore(pool, schema),
    queue: selectQueue(pool),
    leases: new PgLeases(pool, schema),
    provider: new RouterProvider(),
    agents: loaded.agents,
    workflows: loaded.workflows,
  };
  return { pool, deps, schema, close: () => pool.end() };
}

export interface FleetRuntime {
  pool: ReturnType<typeof createPool>;
  /** Per-crew deps, keyed by agent name — feed directly to LocalWorkerRuntime. */
  byAgent: Record<string, TickDeps>;
  crews: Record<string, LoadedAgent>;
  close(): Promise<void>;
}

export async function buildFleetRuntime(project: LoadedProject, databaseUrl?: string): Promise<FleetRuntime> {
  const pool = createPool(databaseUrl);
  await tx(pool, async (c) => {
    await migrateControl(c);
    for (const name of Object.keys(project.crews)) await provisionAgent(c, name);
  });
  const queue = selectQueue(pool);
  const byAgent: Record<string, TickDeps> = {};
  for (const [name, loaded] of Object.entries(project.crews)) {
    const schema = `agent_${name}`;
    byAgent[name] = {
      store: new PgStateStore(pool, schema),
      queue,
      leases: new PgLeases(pool, schema),
      provider: new RouterProvider(),
      agents: loaded.agents,
      workflows: loaded.workflows,
    };
  }
  return { pool, byAgent, crews: project.crews, close: () => pool.end() };
}

export type SettledRun =
  | { status: "completed"; output: string }
  | { status: "failed"; error: string }
  | { status: "waiting_approval"; approvals: Awaited<ReturnType<typeof listPendingApprovals>> };

/**
 * Drive one run with an in-process worker until it is terminal or parked on
 * approvals (parked = queue idle + pending approval → return, leave state).
 */
export async function driveRun(rt: Runtime, runId: string, timeoutMs = 120_000): Promise<SettledRun> {
  const worker = new LocalWorkerRuntime(rt.deps, { concurrency: 2 });
  worker.start();
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await worker.drain(timeoutMs);
      const run = await rt.deps.store.getRun(runId);
      if (run?.status === "completed") return { status: "completed", output: String(run.output ?? "") };
      if (run?.status === "failed") return { status: "failed", error: String(run.error ?? "") };
      const approvals = await listPendingApprovals(rt.deps.store, runId);
      if (approvals.length > 0) return { status: "waiting_approval", approvals };
      // Not terminal, not parked: a delayed message (timer) is pending. Wait a beat.
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`run ${runId} did not settle within ${timeoutMs}ms`);
  } finally {
    await worker.stop();
  }
}
