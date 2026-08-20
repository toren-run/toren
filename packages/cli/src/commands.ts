import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createApiKey, effectiveEvents, foldRunStream, listApiKeys, listPendingApprovals,
  resolveApproval, revokeApiKey, startRun, sweep,
} from "@toren/core";
import { loadAgentDir } from "./loader.js";
import { buildRuntime, driveRun, type SettledRun } from "./runtime.js";
import { TEMPLATE_FILES } from "./template.js";

export interface CmdIO { out: (line: string) => void }
const stdoutIO: CmdIO = { out: (l) => console.log(l) };

export async function cmdInit(name: string, io: CmdIO = stdoutIO): Promise<string> {
  const dir = join(process.cwd(), name);
  if (existsSync(dir)) throw new Error(`${dir} already exists`);
  for (const [rel, content] of Object.entries(TEMPLATE_FILES(name))) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  io.out(`created ${name}/ — run it with: toren run ${name} --input '"hello"'`);
  return dir;
}

export async function cmdRun(dir: string, opts: { input: string; json?: boolean; detach?: boolean; databaseUrl?: string }, io: CmdIO = stdoutIO): Promise<(SettledRun | { status: "detached" }) & { runId: string }> {
  const loaded = await loadAgentDir(dir);
  const rt = await buildRuntime(loaded, opts.databaseUrl);
  try {
    const runId = await startRun(rt.deps, { agent: loaded.name, input: opts.input });
    io.out(`run ${runId}  agent ${loaded.name}  started`);
    if (opts.detach) {
      io.out(opts.json ? JSON.stringify({ runId, status: "detached" }) : `detached — workers will pick it up; check: toren jobs show ${runId}`);
      return { runId, status: "detached" };
    }
    const settled = await driveRun(rt, runId);
    if (opts.json) {
      io.out(JSON.stringify({ runId, ...settled }));
    } else if (settled.status === "completed") {
      io.out(`run ${runId}  completed`);
      io.out(settled.output);
    } else if (settled.status === "failed") {
      io.out(`run ${runId}  FAILED: ${settled.error}`);
    } else {
      io.out(`run ${runId}  waiting for approval:`);
      for (const a of settled.approvals) {
        io.out(`  toren jobs approve ${a.runId} ${a.taskId} ${a.stepId}   # ${a.tool} ${JSON.stringify(a.args)}`);
      }
    }
    return { runId, ...settled };
  } finally {
    await rt.close();
  }
}

/** Long-running worker + guardians daemon (the docker-image entrypoint). */
export async function cmdDev(dir: string, opts: { databaseUrl?: string; sweepMs?: number; apiPort?: number } = {}, io: CmdIO = stdoutIO): Promise<never> {
  const loaded = await loadAgentDir(dir);
  const rt = await buildRuntime(loaded, opts.databaseUrl);
  const { LocalWorkerRuntime } = await import("@toren/core");
  const worker = new LocalWorkerRuntime(rt.deps, { concurrency: 4 });
  worker.start();
  io.out(`toren dev: serving agent "${loaded.name}" (workers + guardians). Ctrl+C to stop.`);

  const token = process.env.TOREN_API_TOKEN;
  if (token) {
    const { createApiServer } = await import("./api.js");
    const port = opts.apiPort ?? 7433;
    const apiServer = createApiServer(rt.deps, { token, agent: loaded.name, pool: rt.pool });
    await new Promise<void>((r) => apiServer.listen(port, r));
    io.out(`toren api: http://0.0.0.0:${port} (bearer auth; POST /runs, GET /runs/:id, POST /runs/:id/approvals)`);
  } else if (opts.apiPort !== undefined) {
    throw new Error("--api-port requires TOREN_API_TOKEN to be set");
  }
  const interval = setInterval(() => void sweep(rt.deps), opts.sweepMs ?? 5_000);
  await new Promise<void>((resolveExit) => {
    const stop = () => {
      clearInterval(interval);
      void worker.stop().then(() => rt.close()).then(() => resolveExit());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  process.exit(0);
}

export async function cmdKeysCreate(dir: string, name: string, opts: { databaseUrl?: string }, io: CmdIO = stdoutIO): Promise<void> {
  const loaded = await loadAgentDir(dir);
  const rt = await buildRuntime(loaded, opts.databaseUrl);
  try {
    const key = await createApiKey(rt.pool, name);
    io.out(`created key ${key.id}  ${key.name}`);
    io.out(`secret (shown once, store it now): ${key.secret}`);
  } finally {
    await rt.close();
  }
}

export async function cmdKeysList(dir: string, opts: { json?: boolean; databaseUrl?: string }, io: CmdIO = stdoutIO): Promise<void> {
  const loaded = await loadAgentDir(dir);
  const rt = await buildRuntime(loaded, opts.databaseUrl);
  try {
    const keys = await listApiKeys(rt.pool);
    if (opts.json) {
      io.out(JSON.stringify({ keys }));
      return;
    }
    for (const k of keys) {
      io.out(`${k.id}  ${k.prefix}…  ${k.name}  ${k.revokedAt ? "revoked" : "active"}`);
    }
  } finally {
    await rt.close();
  }
}

export async function cmdKeysRevoke(dir: string, id: string, opts: { databaseUrl?: string }, io: CmdIO = stdoutIO): Promise<void> {
  const loaded = await loadAgentDir(dir);
  const rt = await buildRuntime(loaded, opts.databaseUrl);
  try {
    if (!(await revokeApiKey(rt.pool, id))) throw new Error(`no active key with id ${id}`);
    io.out(`revoked ${id}`);
  } finally {
    await rt.close();
  }
}

export async function cmdJobsList(dir: string, opts: { json?: boolean; databaseUrl?: string }, io: CmdIO = stdoutIO): Promise<void> {
  const loaded = await loadAgentDir(dir);
  const rt = await buildRuntime(loaded, opts.databaseUrl);
  try {
    const runs = await rt.deps.store.listRuns();
    const approvals = await listPendingApprovals(rt.deps.store);
    if (opts.json) {
      io.out(JSON.stringify({ runs, approvals }));
      return;
    }
    for (const r of runs) {
      const waiting = approvals.filter((a) => a.runId === r.runId);
      const status = waiting.length > 0 ? "waiting_approval" : r.status;
      io.out(`${r.runId}  ${r.agent}  ${status}${waiting.length ? `  (${waiting.map((w) => w.tool).join(", ")})` : ""}`);
    }
  } finally {
    await rt.close();
  }
}

export async function cmdJobsShow(dir: string, runId: string, opts: { json?: boolean; databaseUrl?: string }, io: CmdIO = stdoutIO): Promise<void> {
  const loaded = await loadAgentDir(dir);
  const rt = await buildRuntime(loaded, opts.databaseUrl);
  try {
    const run = await rt.deps.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    const folded = foldRunStream(effectiveEvents(await rt.deps.store.read(runId, "run")));
    const waves = folded.waves.map((w) => ({
      name: w.name,
      tasks: w.tasks.length,
      settled: w.settledTasks.size,
      done: w.settled,
    }));
    const approvals = await listPendingApprovals(rt.deps.store, runId);
    if (opts.json) {
      io.out(JSON.stringify({ run, waves, approvals }));
      return;
    }
    io.out(`${run.runId}  ${run.agent}  ${run.status}`);
    for (const w of waves) io.out(`  wave ${w.name}: ${w.settled}/${w.tasks} settled${w.done ? " ✓" : ""}`);
    for (const a of approvals) io.out(`  pending approval: ${a.tool} ${JSON.stringify(a.args)}  → toren jobs approve ${a.runId} ${a.taskId} ${a.stepId}`);
    if (run.status === "completed") io.out(`  output: ${String(run.output)}`);
  } finally {
    await rt.close();
  }
}

export async function cmdJobsApprove(
  dir: string, runId: string, taskId: string, stepId: string,
  opts: { deny?: boolean; comment?: string; json?: boolean; databaseUrl?: string },
  io: CmdIO = stdoutIO,
): Promise<SettledRun> {
  const loaded = await loadAgentDir(dir);
  const rt = await buildRuntime(loaded, opts.databaseUrl);
  try {
    await resolveApproval(rt.deps, {
      runId, taskId, stepId,
      granted: !opts.deny,
      by: process.env.USER ?? "operator",
      comment: opts.comment,
    });
    await sweep(rt.deps);
    const settled = await driveRun(rt, runId);
    if (opts.json) io.out(JSON.stringify({ runId, ...settled }));
    else io.out(settled.status === "completed" ? `run ${runId}  completed\n${settled.output}` : `run ${runId}  ${settled.status}`);
    return settled;
  } finally {
    await rt.close();
  }
}
