import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createApiKey, createSchedule, deleteSchedule, effectiveEvents, foldRunStream, listApiKeys,
  listPendingApprovals, listSchedules, resolveApproval, revokeApiKey, setScheduleEnabled,
  startRun, sweep, sweepSchedules,
} from "@toren-run/core";
import { loadAgentDir, loadProject } from "./loader.js";
import { buildFleetRuntime, buildRuntime, driveRun, type SettledRun } from "./runtime.js";
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
  io.out(`created ${name}/. Next:
  cd ${name}
  npm install
  docker compose up -d db
  npx toren run . --input '"hello"'     # one durable run
  npx toren dev                          # workers + web console`);
  return dir;
}

export async function cmdRun(dir: string, opts: { input: string; json?: boolean; detach?: boolean; databaseUrl?: string }, io: CmdIO = stdoutIO): Promise<(SettledRun | { status: "detached" }) & { runId: string }> {
  const loaded = await loadAgentDir(dir);
  const rt = await buildRuntime(loaded, opts.databaseUrl);
  try {
    const runId = await startRun(rt.deps, { agent: loaded.name, input: opts.input });
    io.out(`run ${runId}  agent ${loaded.name}  started`);
    if (opts.detach) {
      io.out(opts.json ? JSON.stringify({ runId, status: "detached" }) : `detached; workers will pick it up. Check: toren jobs show ${runId}`);
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

/** Sanitized crew structure — env NAMES and prompt sizes, never values or bodies. */
function crewInfo(loaded: { name: string; agents: Record<string, import("@toren-run/core").AgentSpec> }) {
  return {
    name: loaded.name,
    agents: Object.fromEntries(Object.entries(loaded.agents).map(([ref, a]) => [ref, {
      model: a.model,
      maxTokens: a.maxTokens,
      maxSteps: a.maxSteps,
      systemChars: a.system?.length ?? 0,
      env: Object.keys((a as { env?: Record<string, string> }).env ?? {}),
      tools: a.tools.map((t) => ({
        name: t.name, description: t.description,
        effects: (t as { effects?: string }).effects ?? "read",
        approval: (t as { approval?: string }).approval ?? "never",
      })),
    }])),
  };
}

/** Long-running fleet daemon (the docker-image entrypoint): every agent in every --dir. */
export async function cmdDev(dirs: string | string[], opts: { databaseUrl?: string; sweepMs?: number; apiPort?: number } = {}, io: CmdIO = stdoutIO): Promise<never> {
  const project = await loadProject(Array.isArray(dirs) ? dirs : [dirs]);
  const rt = await buildFleetRuntime(project, opts.databaseUrl);
  const names = Object.keys(rt.byAgent);
  const { LocalWorkerRuntime } = await import("@toren-run/core");
  const worker = new LocalWorkerRuntime(rt.byAgent, { concurrency: 4 });
  worker.start();
  io.out(`toren dev: serving ${names.length === 1 ? `agent "${names[0]}"` : `${names.length} agents (${names.join(", ")})`}. Workers + guardians up; Ctrl+C to stop.`);

  // No configured token → mint an ephemeral one so the API + console work out
  // of the box. It rotates every restart; set TOREN_API_TOKEN to pin it.
  const configured = process.env.TOREN_API_TOKEN;
  const token = configured ?? (await import("node:crypto")).randomBytes(24).toString("hex");
  if (token) {
    const { createApiServer } = await import("./api.js");
    const port = opts.apiPort ?? 7433;
    let consoleDir: string | undefined;
    try {
      consoleDir = (await import("@toren-run/console")).distDir;
    } catch { /* console package not installed — API only */ }
    const agentInfo = {
      default: names[0]!,
      crews: Object.fromEntries(Object.entries(rt.crews).map(([name, loaded]) => [name, crewInfo(loaded)])),
    };
    const apiServer = createApiServer(rt.byAgent, { token, agent: names[0]!, pool: rt.pool, consoleDir, agentInfo });
    await new Promise<void>((r) => apiServer.listen(port, r));
    io.out(`toren api: http://0.0.0.0:${port} (bearer auth; POST /runs, GET /runs/:id, POST /runs/:id/approvals)`);
    if (consoleDir) io.out(`toren console: http://localhost:${port}/console/#token=${token}`);
    if (!configured) io.out(`toren: using an ephemeral API token (rotates on restart); set TOREN_API_TOKEN to pin one`);
  }
  let telegram: { stop(): Promise<void> } | undefined;
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const { TelegramChannel } = await import("./telegram.js");
    const allowedUsers = new Set(
      (process.env.TELEGRAM_ALLOWED_USERS ?? "").split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite),
    );
    const tg = new TelegramChannel({
      botToken: process.env.TELEGRAM_BOT_TOKEN, byAgent: rt.byAgent, defaultAgent: names[0]!, pool: rt.pool, allowedUsers,
    });
    tg.start();
    telegram = tg;
    io.out("toren telegram: channel up (deny-by-default; pair via invite code or TELEGRAM_ALLOWED_USERS)");
  }
  const interval = setInterval(() => {
    for (const [name, deps] of Object.entries(rt.byAgent)) void sweep(deps, name).catch(() => { /* transient DB error — next tick retries */ });
    void sweepSchedules(rt.pool, rt.byAgent).catch(() => { /* transient DB error — next tick retries */ });
  }, opts.sweepMs ?? 5_000);
  await new Promise<void>((resolveExit) => {
    const stop = () => {
      clearInterval(interval);
      void (telegram?.stop() ?? Promise.resolve()).then(() => worker.stop()).then(() => rt.close()).then(() => resolveExit());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  process.exit(0);
}

export async function cmdChat(dir: string, opts: { agent?: string; session?: string; databaseUrl?: string }, io: CmdIO = stdoutIO): Promise<void> {
  const project = await loadProject([dir]);
  const rt = await buildFleetRuntime(project, opts.databaseUrl);
  const names = Object.keys(rt.byAgent);
  const agent = opts.agent ?? names[0]!;
  const deps = rt.byAgent[agent];
  if (!deps) throw new Error(`no agent "${agent}" here; agents: ${names.join(", ")}`);
  const core = await import("@toren-run/core");
  const worker = new core.LocalWorkerRuntime(rt.byAgent, { concurrency: 2 });
  worker.start();
  const { runChatLoop } = await import("./chat.js");
  try {
    await runChatLoop({
      agentName: agent,
      start: (m) => core.startSession(deps, { agent, message: m, channel: "cli" }),
      send: (id, m, close) => core.sendSessionMessage(deps, id, { text: m, channel: "cli", close }),
      get: (id) => core.getSession(deps.store, id),
    }, { sessionId: opts.session }, io);
  } finally {
    await worker.stop();
    await rt.close();
  }
}

export async function cmdTelegramInvite(dir: string, opts: { databaseUrl?: string }, io: CmdIO = stdoutIO): Promise<void> {
  const loaded = await loadAgentDir(dir);
  const rt = await buildRuntime(loaded, opts.databaseUrl);
  try {
    const { createTelegramInvite } = await import("./telegram.js");
    const code = await createTelegramInvite(rt.pool);
    io.out(`one-time pairing code: ${code}`);
    io.out("send it to the bot in a direct message; it pairs the sender and then burns");
  } finally {
    await rt.close();
  }
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

export async function cmdScheduleCreate(
  dir: string,
  opts: { cron: string; input: string; agent?: string; name?: string; tz?: string; databaseUrl?: string },
  io: CmdIO = stdoutIO,
): Promise<void> {
  const loaded = await loadAgentDir(dir);
  const rt = await buildRuntime(loaded, opts.databaseUrl);
  try {
    const s = await createSchedule(rt.pool, {
      agent: opts.agent ?? loaded.name,
      name: opts.name ?? `${opts.cron}`,
      cron: opts.cron,
      input: opts.input,
      tz: opts.tz,
    });
    io.out(`created schedule ${s.id}  ${s.agent}  "${s.cron}" (${s.tz})  next fire ${s.nextFireAt.toISOString()}`);
  } finally {
    await rt.close();
  }
}

export async function cmdScheduleList(dir: string, opts: { json?: boolean; databaseUrl?: string }, io: CmdIO = stdoutIO): Promise<void> {
  const loaded = await loadAgentDir(dir);
  const rt = await buildRuntime(loaded, opts.databaseUrl);
  try {
    const schedules = await listSchedules(rt.pool);
    if (opts.json) {
      io.out(JSON.stringify({ schedules }));
      return;
    }
    for (const s of schedules) {
      io.out(`${s.id}  ${s.agent}  "${s.cron}" (${s.tz})  ${s.enabled ? `next ${s.nextFireAt.toISOString()}` : "paused"}  ${s.name}`);
    }
  } finally {
    await rt.close();
  }
}

export async function cmdScheduleSet(dir: string, id: string, action: "pause" | "resume" | "rm", opts: { databaseUrl?: string }, io: CmdIO = stdoutIO): Promise<void> {
  const loaded = await loadAgentDir(dir);
  const rt = await buildRuntime(loaded, opts.databaseUrl);
  try {
    const ok = action === "rm" ? await deleteSchedule(rt.pool, id) : await setScheduleEnabled(rt.pool, id, action === "resume");
    if (!ok) throw new Error(`no schedule with id ${id}`);
    io.out(`${action === "rm" ? "deleted" : action === "pause" ? "paused" : "resumed"} ${id}`);
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
