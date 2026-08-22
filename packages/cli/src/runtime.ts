import {
  PgFiles,
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

/**
 * Selects the sandbox backend for an agent that needs one. The operator
 * chooses with TOREN_SANDBOX (like TOREN_QUEUE picks the queue): "docker"
 * (local containers), "e2b" (cloud, needs E2B_API_KEY), "none" (disabled),
 * or "auto" (default: e2b when a key is set, else docker). agent.yaml governs
 * what the sandbox can do; this env var governs where it runs. Returns
 * undefined when the agent has no bash tool.
 */
async function makeSandboxProvider(
  pool: ReturnType<typeof createPool>,
  loaded: LoadedAgent,
): Promise<import("@toren-run/core").SandboxProvider | undefined> {
  const hasBash = Object.values(loaded.agents).some((a) => a.tools.some((t) => t.name === "bash"));
  if (!hasBash) return undefined;
  const sb = loaded.sandbox ?? {};

  const e2b = async () => {
    if (!process.env.E2B_API_KEY) throw new Error('sandbox backend "e2b" selected but E2B_API_KEY is not set');
    const { E2BSandboxProvider } = await import("./sandbox-e2b.js");
    return new E2BSandboxProvider(pool, { apiKey: process.env.E2B_API_KEY, network: sb.network, env: sb.env, template: sb.image });
  };
  const docker = async () => {
    const { dockerAvailable, DockerSandboxProvider } = await import("./sandbox.js");
    if (!(await dockerAvailable())) throw new Error('sandbox backend "docker" selected but docker is not available (is the daemon running?)');
    return new DockerSandboxProvider(sb);
  };

  const choice = (process.env.TOREN_SANDBOX ?? "auto").toLowerCase();
  switch (choice) {
    case "none":
      throw new Error('an agent declares "sandbox: true" but TOREN_SANDBOX=none disables the sandbox');
    case "e2b":
      return e2b();
    case "docker":
      return docker();
    case "auto": {
      if (process.env.E2B_API_KEY) return e2b();
      const { dockerAvailable } = await import("./sandbox.js");
      if (await dockerAvailable()) return docker();
      throw new Error('an agent declares "sandbox: true" but no backend is available — set E2B_API_KEY for the cloud sandbox, install docker for the local one, or set TOREN_SANDBOX explicitly (docker|e2b)');
    }
    default:
      throw new Error(`unknown TOREN_SANDBOX="${choice}" — use one of: auto, docker, e2b, none`);
  }
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
    files: new PgFiles(pool),
  };
  const sandbox = await makeSandboxProvider(pool, loaded);
  if (sandbox) deps.sandbox = sandbox;
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
  const files = new PgFiles(pool);
  const byAgent: Record<string, TickDeps> = {};
  for (const [name, loaded] of Object.entries(project.crews)) {
    const schema = `agent_${name}`;
    const sandbox = await makeSandboxProvider(pool, loaded);
    byAgent[name] = {
      store: new PgStateStore(pool, schema),
      queue,
      leases: new PgLeases(pool, schema),
      provider: new RouterProvider(),
      agents: loaded.agents,
      workflows: loaded.workflows,
      files,
      ...(sandbox ? { sandbox } : {}),
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
