import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  fileManifest, PgFiles,
  createApiKey, createSchedule, deleteSchedule, effectiveEvents, foldRunStream, listApiKeys,
  listPendingApprovals, listSchedules, resolveApproval, revokeApiKey, setScheduleEnabled,
  cancelRun, followRun, runUsage, startRun, sweep, sweepSchedules, sweepWatchers,
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

/** Parse local files through the upload pipeline and return the manifest to append. */
export async function attachLocalFiles(
  pool: ConstructorParameters<typeof PgFiles>[0],
  agents: Record<string, import("@toren-run/core").AgentSpec>,
  paths: string[],
  io: CmdIO,
): Promise<string> {
  if (paths.length === 0) return "";
  const canRead = Object.values(agents).some((a) => a.tools.some((t) => t.name === "read_attachment"));
  if (!canRead) throw new Error('this agent cannot read files — add "builtin_tools: [read_attachment]" to its agent.yaml');
  const { readFileSync } = await import("node:fs");
  const { basename } = await import("node:path");
  const { parseFile } = await import("./files.js");
  const store = new PgFiles(pool);
  const stored = [];
  for (const p of paths) {
    const data = readFileSync(p);
    const parsed = await parseFile(basename(p), data);
    const f = await store.put({ name: basename(p), mediaType: parsed.mediaType, data, pages: parsed.pages });
    io.out(`attached ${f.name} (file_id ${f.id}, ${f.pages.length} page${f.pages.length === 1 ? "" : "s"})`);
    stored.push(f);
  }
  return fileManifest(stored);
}

export async function cmdRun(dir: string, opts: { input: string; process?: string; json?: boolean; detach?: boolean; databaseUrl?: string; files?: string[] }, io: CmdIO = stdoutIO): Promise<(SettledRun | { status: "detached" }) & { runId: string }> {
  const loaded = await loadAgentDir(dir);
  const rt = await buildRuntime(loaded, opts.databaseUrl);
  try {
    const manifest = await attachLocalFiles(rt.pool, loaded.agents, opts.files ?? [], io);
    const process = opts.process ?? loaded.defaultProcess;
    const runId = await startRun(rt.deps, { agent: loaded.name, input: opts.input + manifest, ...(process ? { process } : {}) });
    // --json consumers pipe this output; nothing but JSON may reach stdout.
    if (!opts.json) io.out(`run ${runId}  agent ${loaded.name}${process && process !== "main" ? `  process ${process}` : ""}  started`);
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
function crewInfo(loaded: { name: string; agents: Record<string, import("@toren-run/core").AgentSpec>; workflows: Record<string, unknown>; defaultProcess?: string }) {
  return {
    name: loaded.name,
    processes: Object.keys(loaded.workflows),
    ...(loaded.defaultProcess ? { defaultProcess: loaded.defaultProcess } : {}),
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

/**
 * MCP over stdio: a self-contained serving process for local MCP clients
 * (Claude Code, Cursor). Spawned by the client, no auth, no network; workers
 * and guardians run inside so started runs actually execute. stdout belongs
 * to the transport — anything human goes to stderr.
 */
export async function cmdMcp(dirs: string | string[], opts: { databaseUrl?: string } = {}): Promise<void> {
  const project = await loadProject(Array.isArray(dirs) ? dirs : [dirs]);
  const rt = await buildFleetRuntime(project, opts.databaseUrl);
  const { LocalWorkerRuntime } = await import("@toren-run/core");
  const worker = new LocalWorkerRuntime(rt.byAgent, { concurrency: 4 });
  worker.start();
  const sweeps = setInterval(() => {
    for (const [name, deps] of Object.entries(rt.byAgent)) void sweep(deps, name).catch(() => { /* next tick retries */ });
    void sweepSchedules(rt.pool, rt.byAgent).catch(() => { /* next tick retries */ });
    void sweepWatchers(rt.pool, rt.byAgent).catch(() => { /* next tick retries */ });
  }, 5_000);
  const names = Object.keys(rt.byAgent);
  const info = {
    default: names[0]!,
    crews: Object.fromEntries(Object.entries(rt.crews).map(([name, loaded]) => [name, crewInfo(loaded)])),
  };
  const { buildMcpServer } = await import("./mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const server = buildMcpServer(rt.byAgent, { defaultAgent: names[0]!, info });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`toren mcp: serving ${names.length === 1 ? `agent "${names[0]}"` : `${names.length} agents`} over stdio`);
  await new Promise<void>((resolve) => { transport.onclose = resolve; });
  clearInterval(sweeps);
  await worker.stop();
  await rt.close();
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

  // Channels register their live status here after the API server starts, so
  // /healthz can tell a dead poller from a quiet one (field report 2026-08-25).
  const channelHealth: Record<string, () => unknown> = {};

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
    const defaultProcess = Object.fromEntries(
      Object.entries(rt.crews).flatMap(([name, loaded]) => (loaded.defaultProcess ? [[name, loaded.defaultProcess]] : [])),
    );
    const apiServer = createApiServer(rt.byAgent, { token, agent: names[0]!, pool: rt.pool, consoleDir, agentInfo, defaultProcess, channelHealth });
    await new Promise<void>((r) => apiServer.listen(port, r));
    io.out(`toren api: http://0.0.0.0:${port} (bearer auth; POST /runs, GET /runs/:id, POST /runs/:id/approvals)`);
    if (consoleDir) io.out(`toren console: http://localhost:${port}/console/#token=${token}`);
    if (!configured) io.out(`toren: using an ephemeral API token (rotates on restart); set TOREN_API_TOKEN to pin one`);
  }
  const telegramChannels: { stop(): Promise<void> }[] = [];
  const dedicated = Object.entries(rt.crews).filter(([, loaded]) => loaded.telegramBotTokenEnv);
  if (process.env.TELEGRAM_BOT_TOKEN || dedicated.length) {
    const { TelegramChannel } = await import("./telegram.js");
    const allowedUsers = new Set(
      (process.env.TELEGRAM_ALLOWED_USERS ?? "").split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite),
    );
    if (process.env.TELEGRAM_BOT_TOKEN) {
      // The operator's fleet bot: reaches every agent, botKey "default" so pre-existing pairings keep working.
      const tg = new TelegramChannel({
        botToken: process.env.TELEGRAM_BOT_TOKEN, byAgent: rt.byAgent, defaultAgent: names[0]!, pool: rt.pool, allowedUsers, log: io.out,
      });
      tg.start();
      telegramChannels.push(tg);
      channelHealth["telegram:default"] = () => tg.status();
      io.out("toren telegram: fleet bot up — reaches every agent, treat its invites as operator access (deny-by-default)");
    }
    for (const [name, loaded] of dedicated) {
      const botToken = process.env[loaded.telegramBotTokenEnv!];
      if (!botToken) throw new Error(`agent ${name}: telegram.bot_token_env names ${loaded.telegramBotTokenEnv}, but it is not set in the environment`);
      // Dedicated bot: sees exactly one agent. botKey is the agent name, not the token,
      // so rotating a leaked token never orphans pairings or bindings.
      const tg = new TelegramChannel({
        botToken, byAgent: { [name]: rt.byAgent[name]! }, defaultAgent: name,
        pool: rt.pool, allowedUsers, botKey: `agent:${name}`, log: io.out,
      });
      tg.start();
      telegramChannels.push(tg);
      channelHealth[`telegram:agent:${name}`] = () => tg.status();
      io.out(`toren telegram: dedicated bot up for ${name} (pair via \`toren telegram invite --agent ${name}\`)`);
    }
  }
  const interval = setInterval(() => {
    for (const [name, deps] of Object.entries(rt.byAgent)) void sweep(deps, name).catch(() => { /* transient DB error — next tick retries */ });
    void sweepSchedules(rt.pool, rt.byAgent).catch(() => { /* transient DB error — next tick retries */ });
    void sweepWatchers(rt.pool, rt.byAgent).catch(() => { /* transient DB error — next tick retries */ });
  }, opts.sweepMs ?? 5_000);
  await new Promise<void>((resolveExit) => {
    const stop = () => {
      clearInterval(interval);
      void Promise.all(telegramChannels.map((t) => t.stop())).then(() => worker.stop()).then(() => rt.close()).then(() => resolveExit());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  process.exit(0);
}

export async function cmdChat(dir: string, opts: { agent?: string; session?: string; databaseUrl?: string; files?: string[] }, io: CmdIO = stdoutIO): Promise<void> {
  const project = await loadProject([dir]);
  const rt = await buildFleetRuntime(project, opts.databaseUrl);
  const names = Object.keys(rt.byAgent);
  const agent = opts.agent ?? names[0]!;
  const deps = rt.byAgent[agent];
  if (!deps) throw new Error(`no agent "${agent}" here; agents: ${names.join(", ")}`);
  const manifest = await attachLocalFiles(rt.pool, deps.agents, opts.files ?? [], io);
  const core = await import("@toren-run/core");
  const worker = new core.LocalWorkerRuntime(rt.byAgent, { concurrency: 2 });
  worker.start();
  // Background spawns settle into the conversation even while the user idles at the prompt.
  const watcherSweep = setInterval(() => {
    void core.sweepWatchers(rt.pool, rt.byAgent).catch(() => { /* transient DB error — next tick retries */ });
  }, 2_000);
  const { runChatLoop } = await import("./chat.js");
  try {
    await runChatLoop({
      agentName: agent,
      start: (m) => core.startSession(deps, { agent, message: m + manifest, channel: "cli" }),
      send: (id, m, close) => core.sendSessionMessage(deps, id, { text: m, channel: "cli", close }),
      get: (id) => core.getSession(deps.store, id),
    }, { sessionId: opts.session }, io);
  } finally {
    clearInterval(watcherSweep);
    await worker.stop();
    await rt.close();
  }
}

export async function cmdTelegramInvite(dir: string, opts: { databaseUrl?: string; agent?: string }, io: CmdIO = stdoutIO): Promise<void> {
  const loaded = await loadAgentDir(dir);
  if (opts.agent) {
    if (opts.agent !== loaded.name) throw new Error(`--agent ${opts.agent} does not match this directory's agent (${loaded.name})`);
    if (!loaded.telegramBotTokenEnv) throw new Error(`agent ${loaded.name} has no dedicated bot — declare telegram.bot_token_env in agent.yaml first`);
  }
  const rt = await buildRuntime(loaded, opts.databaseUrl);
  try {
    const { createTelegramInvite } = await import("./telegram.js");
    const code = await createTelegramInvite(rt.pool, opts.agent ? `agent:${opts.agent}` : "default");
    io.out(`one-time pairing code: ${code}${opts.agent ? ` (for ${opts.agent}'s dedicated bot)` : ""}`);
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
  opts: { cron: string; input: string; process?: string; agent?: string; name?: string; tz?: string; databaseUrl?: string },
  io: CmdIO = stdoutIO,
): Promise<void> {
  const loaded = await loadAgentDir(dir);
  const rt = await buildRuntime(loaded, opts.databaseUrl);
  try {
    const process = opts.process ?? loaded.defaultProcess ?? "main";
    if (!loaded.workflows[process]) {
      throw new Error(`agent ${loaded.name} has no process "${process}" (has: ${Object.keys(loaded.workflows).join(", ")})`);
    }
    const s = await createSchedule(rt.pool, {
      agent: opts.agent ?? loaded.name,
      name: opts.name ?? `${opts.cron}`,
      cron: opts.cron,
      input: opts.input,
      process,
      tz: opts.tz,
    });
    io.out(`created schedule ${s.id}  ${s.agent}  "${s.cron}" (${s.tz})${process !== "main" ? `  process ${process}` : ""}  next fire ${s.nextFireAt.toISOString()}`);
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
      io.out(`${s.id}  ${s.agent}${s.process !== "main" ? `  ${s.process}` : ""}  "${s.cron}" (${s.tz})  ${s.enabled ? `next ${s.nextFireAt.toISOString()}` : "paused"}  ${s.name}`);
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
      const process = r.process && r.process !== "main" ? `  ${r.process}` : "";
      io.out(`${r.runId}  ${r.agent}${process}  ${status}${waiting.length ? `  (${waiting.map((w) => w.tool).join(", ")})` : ""}`);
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
    const usage = await runUsage(rt.deps.store, runId);
    if (opts.json) {
      io.out(JSON.stringify({ run, waves, approvals, usage }));
      return;
    }
    io.out(`${run.runId}  ${run.agent}  ${run.status}`);
    for (const w of waves) io.out(`  wave ${w.name}: ${w.settled}/${w.tasks} settled${w.done ? " ✓" : ""}`);
    for (const a of approvals) io.out(`  pending approval: ${a.tool} ${JSON.stringify(a.args)}  → toren jobs approve ${a.runId} ${a.taskId} ${a.stepId}`);
    if (usage.totalCalls > 0) {
      const inTok = Object.values(usage.models).reduce((n, m) => n + m.inputTokens, 0);
      const outTok = Object.values(usage.models).reduce((n, m) => n + m.outputTokens, 0);
      const dollars = usage.estCostUsd !== undefined ? `  ~$${usage.estCostUsd.toFixed(4)}` : "";
      io.out(`  cost: ${usage.totalCalls} model calls  ${inTok} in / ${outTok} out tokens${dollars}`);
      if (usage.replayedCalls > 0) {
        const saved = usage.replaySavingsUsd !== undefined ? ` (~$${usage.replaySavingsUsd.toFixed(4)} not re-paid)` : "";
        io.out(`  resumes replayed ${usage.replayedCalls} completed call${usage.replayedCalls === 1 ? "" : "s"} from the log${saved}`);
      }
    }
    if (run.error != null) io.out(`  error: ${String(run.error)}${run.status === "running" ? "  (still retrying; toren jobs cancel to give up)" : ""}`);
    if (run.status === "completed") io.out(`  output: ${String(run.output)}`);
  } finally {
    await rt.close();
  }
}

/** One line per event, brief enough to watch live. */
export function tailLine(e: { streamId: string; seq: number; type: string; payload: Record<string, unknown>; recordedAt: Date | string }): string {
  const t = new Date(e.recordedAt).toISOString().slice(11, 19);
  const detail =
    e.type === "LlmCallStarted" ? String(e.payload.model ?? "")
    : e.type === "LlmCallCompleted" ? `${(e.payload.usage as { inputTokens?: number })?.inputTokens ?? 0} in / ${(e.payload.usage as { outputTokens?: number })?.outputTokens ?? 0} out`
    : e.type === "ToolCallStarted" ? String(e.payload.tool ?? "")
    : e.type === "TaskStarted" ? `attempt ${e.payload.attempt ?? 1}`
    : e.type === "TaskFailed" ? String(e.payload.error ?? "").slice(0, 120)
    : e.type === "RunCompleted" ? String(e.payload.output ?? "").slice(0, 120)
    : e.type === "RunFailed" ? String(e.payload.error ?? "").slice(0, 120)
    : e.type === "InputRequested" ? String(e.payload.text ?? "").slice(0, 120)
    : e.type === "UserMessage" ? String(e.payload.text ?? "").slice(0, 120)
    : e.type === "StreamInvalidated" ? String(e.payload.reason ?? "").slice(0, 120)
    : "";
  return `${t}  ${e.streamId}  ${e.type}${detail ? `  ${detail}` : ""}`;
}

export async function cmdJobsTail(dir: string, runId: string, opts: { databaseUrl?: string }, io: CmdIO = stdoutIO): Promise<void> {
  const loaded = await loadAgentDir(dir);
  const rt = await buildRuntime(loaded, opts.databaseUrl);
  try {
    if (!(await rt.deps.store.getRun(runId))) throw new Error(`run ${runId} not found`);
    const cursor: import("@toren-run/core").TailCursor = {};
    for (;;) {
      const { events, done } = await followRun(rt.deps.store, runId, cursor);
      for (const e of events) io.out(tailLine(e));
      if (done) {
        const run = await rt.deps.store.getRun(runId);
        io.out(`run ${runId}  ${run?.status ?? "gone"}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  } finally {
    await rt.close();
  }
}

export async function cmdJobsCancel(dir: string, runId: string, opts: { databaseUrl?: string }, io: CmdIO = stdoutIO): Promise<void> {
  const loaded = await loadAgentDir(dir);
  const rt = await buildRuntime(loaded, opts.databaseUrl);
  try {
    const ok = await cancelRun(rt.deps, runId, `cancelled by ${process.env.USER ?? "operator"}`);
    if (!ok) throw new Error(`run ${runId} is unknown or already terminal`);
    io.out(`run ${runId}  cancelled; queued retries become no-ops`);
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
