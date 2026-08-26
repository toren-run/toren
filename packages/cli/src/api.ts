import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import {
  createApiKey, createPool, createSchedule, deleteSchedule, effectiveEvents, fileManifest, foldRunStream,
  cancelRun, followRun, runUsage, getSession, listApiKeys, listPendingApprovals, listSchedules, listSessions, PgFiles, resolveApproval,
  revokeApiKey, SessionBusyError, sendSessionMessage, setScheduleEnabled, startRun, startSession,
  verifyApiKey,
  type TickDeps,
} from "@toren-run/core";

/**
 * The intake API: trigger runs, read status/results/events, resolve
 * approvals — for every agent the deployment serves. Bearer-token auth;
 * /healthz is open for load-balancer checks.
 */
export interface ApiConfig {
  /** Admin (bootstrap) token: full access, including key management. */
  token: string;
  /** Default agent — POST /runs without an explicit agent targets it. */
  agent: string;
  /**
   * Pool for issued-key auth and /keys management. Without it the server
   * accepts only the admin token (pre-key deployments keep working).
   */
  pool?: ReturnType<typeof createPool>;
  /** Static dir of @toren-run/console — when set, the web console is served at /console. */
  consoleDir?: string;
  /** Sanitized structure of the served agent (models, tools, env names — never values). */
  agentInfo?: unknown;
  /** Per-agent default process (agent.yaml default_process) used when POST /runs names none. */
  defaultProcess?: Record<string, string>;
  /** Live channel health probes (e.g. Telegram pollers), included in /healthz so a dead poller is visible from outside. Mutable: channels register after the server starts. */
  channelHealth?: Record<string, () => unknown>;
  /** Fleet sign-in sheet probe: live workers and their versions, included in /healthz so version skew across containers is visible from outside. */
  workers?: () => unknown;
}

type Principal = { kind: "admin" } | { kind: "key"; id: string; name: string };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".map": "application/json",
};

/** Static console assets — auth-free (the app itself authenticates every API call). */
async function serveConsole(res: ServerResponse, pathname: string, dir: string): Promise<void> {
  const rel = pathname.replace(/^\/console\/?/, "") || "index.html";
  const file = normalize(join(dir, rel));
  if (!file.startsWith(resolve(dir))) { send(res, 404, { error: "not found" }); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-cache",
    });
    res.end(body);
  } catch {
    send(res, 404, { error: "not found" });
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

function presentedToken(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

async function authenticate(req: IncomingMessage, cfg: ApiConfig): Promise<Principal | null> {
  const presented = presentedToken(req);
  const a = Buffer.from(presented);
  const b = Buffer.from(cfg.token);
  if (a.length === b.length && timingSafeEqual(a, b)) return { kind: "admin" };
  if (cfg.pool) {
    const key = await verifyApiKey(cfg.pool, presented);
    if (key) return { kind: "key", id: key.id, name: key.name };
  }
  return null;
}

async function readJson(req: IncomingMessage, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { status: 400 });
  }
}

export function createApiServer(depsIn: TickDeps | Record<string, TickDeps>, cfg: ApiConfig): Server {
  if (!cfg.token) throw new Error("api token must be non-empty (set TOREN_API_TOKEN)");
  const byAgent: Record<string, TickDeps> =
    "store" in depsIn ? { [cfg.agent]: depsIn as TickDeps } : (depsIn as Record<string, TickDeps>);
  const agentNames = Object.keys(byAgent);
  if (agentNames.length === 0) throw new Error("api server needs at least one agent");
  const defaultAgent = byAgent[cfg.agent] ? cfg.agent : agentNames[0]!;

  /** Which crew owns this run? Probes each store — fleets are small. */
  const findRun = async (runId: string) => {
    for (const [agent, deps] of Object.entries(byAgent)) {
      const run = await deps.store.getRun(runId);
      if (run) return { agent, deps, run };
    }
    return null;
  };

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://local");
      const parts = url.pathname.split("/").filter(Boolean);

      if (req.method === "GET" && url.pathname === "/healthz") {
        const channels = Object.fromEntries(Object.entries(cfg.channelHealth ?? {}).map(([k, probe]) => {
          try { return [k, probe()]; } catch { return [k, { error: "probe failed" }]; }
        }));
        let workers: unknown;
        try { workers = cfg.workers?.(); } catch { workers = { error: "probe failed" }; }
        return send(res, 200, { ok: true, ...(Object.keys(channels).length ? { channels } : {}), ...(workers !== undefined ? { workers } : {}) });
      }
      if (req.method === "GET" && cfg.consoleDir && (url.pathname === "/console" || url.pathname.startsWith("/console/"))) {
        // The app's asset URLs are page-relative, so the page must live at
        // /console/ — without the slash the browser asks the API root for
        // app.js and renders nothing. Fragments (#token=…) survive redirects.
        if (url.pathname === "/console") {
          res.writeHead(302, { location: "/console/" });
          return res.end();
        }
        return serveConsole(res, url.pathname, cfg.consoleDir);
      }
      // A browser landing on the bare domain wants the console, not a 401.
      // API clients never GET / with an html Accept header, so this stays
      // out of their way.
      if (req.method === "GET" && cfg.consoleDir && url.pathname === "/" && (req.headers.accept ?? "").includes("text/html")) {
        res.writeHead(302, { location: "/console/" });
        return res.end();
      }
      const principal = await authenticate(req, cfg);
      if (!principal) return send(res, 401, { error: "missing or invalid bearer token" });

      // /mcp — the MCP serve channel over Streamable HTTP, behind the same
      // bearer tokens as everything else. Stateless: one server per request.
      if (parts.length === 1 && parts[0] === "mcp") {
        const { buildMcpServer } = await import("./mcp.js");
        const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server = buildMcpServer(byAgent, { defaultAgent, info: cfg.agentInfo });
        await server.connect(transport);
        res.on("close", () => { void transport.close(); void server.close(); });
        return transport.handleRequest(req, res);
      }

      // POST /files — upload a file; parsed to pages once, stored by content
      // hash. Attach the returned fileId to runs and session messages.
      if (req.method === "POST" && parts.length === 1 && parts[0] === "files") {
        if (!cfg.pool) return send(res, 501, { error: "file uploads unavailable (no database pool configured)" });
        const body = await readJson(req, 25_000_000);
        if (typeof body.name !== "string" || typeof body.content_base64 !== "string") {
          return send(res, 400, { error: "body must be {name: string, content_base64: string}" });
        }
        try {
          const data = Buffer.from(body.content_base64, "base64");
          const { parseFile } = await import("./files.js");
          const parsed = await parseFile(body.name, data);
          const stored = await new PgFiles(cfg.pool).put({ name: body.name, mediaType: parsed.mediaType, data, pages: parsed.pages });
          return send(res, 201, { fileId: stored.id, name: stored.name, mediaType: stored.mediaType, bytes: stored.bytes, pages: stored.pages.length });
        } catch (e) {
          return send(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // POST /channels/telegram/invites — admin-token only; mints a one-time
      // pairing code for the deny-by-default Telegram bot. Body {agent} targets
      // that agent's dedicated bot; no body targets the shared one.
      if (req.method === "POST" && parts[0] === "channels" && parts[1] === "telegram" && parts[2] === "invites") {
        if (principal.kind !== "admin") return send(res, 403, { error: "invite minting requires the admin token" });
        if (!cfg.pool) return send(res, 501, { error: "invite minting unavailable (no database pool configured)" });
        const body = (await readJson(req).catch(() => ({}))) as { agent?: string };
        if (body.agent && !byAgent[body.agent]) return send(res, 404, { error: `unknown agent: ${body.agent}` });
        const { createTelegramInvite } = await import("./telegram.js");
        const code = await createTelegramInvite(cfg.pool, body.agent ? `agent:${body.agent}` : "default");
        return send(res, 201, { code });
      }

      // /keys — admin-token only; issued keys cannot mint or revoke keys.
      if (parts[0] === "keys") {
        if (principal.kind !== "admin") return send(res, 403, { error: "key management requires the admin token" });
        if (!cfg.pool) return send(res, 501, { error: "key management unavailable (no database pool configured)" });
        if (req.method === "POST" && parts.length === 1) {
          const body = await readJson(req);
          if (typeof body.name !== "string" || !body.name.trim()) return send(res, 400, { error: "body must be {name: string}" });
          const created = await createApiKey(cfg.pool, body.name);
          return send(res, 201, { key: created }); // secret appears here exactly once
        }
        if (req.method === "GET" && parts.length === 1) {
          return send(res, 200, { keys: await listApiKeys(cfg.pool) });
        }
        if (req.method === "DELETE" && parts.length === 2) {
          const id = parts[1]!;
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
            return send(res, 404, { error: "no such active key" });
          }
          const revoked = await revokeApiKey(cfg.pool, id);
          return revoked ? send(res, 200, { revoked: true }) : send(res, 404, { error: "no such active key" });
        }
        return send(res, 404, { error: "not found" });
      }

      // /schedules — standing configuration: admin-token only, like /keys.
      if (parts[0] === "schedules") {
        if (principal.kind !== "admin") return send(res, 403, { error: "schedule management requires the admin token" });
        if (!cfg.pool) return send(res, 501, { error: "schedule management unavailable (no database pool configured)" });
        if (req.method === "GET" && parts.length === 1) {
          return send(res, 200, { schedules: await listSchedules(cfg.pool, agentNames) });
        }
        if (req.method === "POST" && parts.length === 1) {
          const body = await readJson(req);
          if (typeof body.cron !== "string" || typeof body.input !== "string") {
            return send(res, 400, { error: "body must be {cron, input, agent?, process?, name?, tz?}" });
          }
          const agent = typeof body.agent === "string" ? body.agent : defaultAgent;
          if (!byAgent[agent]) return send(res, 400, { error: `unknown agent "${agent}" — this deployment serves: ${agentNames.join(", ")}` });
          const proc = typeof body.process === "string" ? body.process : cfg.defaultProcess?.[agent];
          if (proc !== undefined && !byAgent[agent]!.workflows[proc]) {
            return send(res, 400, { error: `no process "${proc}" for agent "${agent}" (has: ${Object.keys(byAgent[agent]!.workflows).join(", ")})` });
          }
          try {
            const schedule = await createSchedule(cfg.pool, {
              agent, cron: body.cron, input: body.input,
              ...(proc ? { process: proc } : {}),
              name: typeof body.name === "string" ? body.name : body.cron,
              tz: typeof body.tz === "string" ? body.tz : undefined,
            });
            return send(res, 201, { schedule });
          } catch (e) {
            return send(res, 400, { error: e instanceof Error ? e.message : String(e) });
          }
        }
        const id = parts[1];
        if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
          return send(res, 404, { error: "no such schedule" });
        }
        if (req.method === "DELETE" && parts.length === 2 && id) {
          return (await deleteSchedule(cfg.pool, id)) ? send(res, 200, { deleted: true }) : send(res, 404, { error: "no such schedule" });
        }
        if (req.method === "POST" && parts.length === 3 && id && (parts[2] === "pause" || parts[2] === "resume")) {
          const ok = await setScheduleEnabled(cfg.pool, id, parts[2] === "resume");
          return ok ? send(res, 200, { enabled: parts[2] === "resume" }) : send(res, 404, { error: "no such schedule" });
        }
        return send(res, 404, { error: "not found" });
      }

      // GET /agent — what this deployment serves
      if (req.method === "GET" && parts.length === 1 && parts[0] === "agent") {
        return send(res, 200, { agent: cfg.agentInfo ?? { name: cfg.agent } });
      }

      // /sessions — turn-based conversations (any principal, like /runs)
      // Attachment ids on a run or message become a manifest appended to the
      // recorded text: transcript-visible, digest-stable, replay-safe.
      const resolveAttachments = async (deps: (typeof byAgent)[string], ids: unknown): Promise<{ manifest: string } | { error: string }> => {
        if (!Array.isArray(ids) || ids.length === 0) return { manifest: "" };
        if (!cfg.pool) return { error: "file attachments unavailable (no database pool configured)" };
        const store = new PgFiles(cfg.pool);
        const found = [];
        for (const id of ids.slice(0, 10)) {
          const f = await store.get(String(id));
          if (!f) return { error: `no uploaded file with id ${String(id)} — upload via POST /files first` };
          found.push(f);
        }
        const canRead = Object.values(deps.agents).some((a) => a.tools.some((t) => t.name === "read_attachment"));
        if (!canRead) return { error: 'this agent cannot read files — add "builtin_tools: [read_attachment]" to its agent.yaml' };
        return { manifest: fileManifest(found) };
      };

      if (parts[0] === "sessions") {
        if (req.method === "POST" && parts.length === 1) {
          const body = await readJson(req);
          if (typeof body.message !== "string" || !body.message.trim()) {
            return send(res, 400, { error: "body must be {message: string, agent?: string, channel?: string, files?: string[]}" });
          }
          const target = typeof body.agent === "string" ? body.agent : defaultAgent;
          const targetDeps = byAgent[target];
          if (!targetDeps) return send(res, 400, { error: `unknown agent "${target}" — this deployment serves: ${agentNames.join(", ")}` });
          const att = await resolveAttachments(targetDeps, body.files);
          if ("error" in att) return send(res, 400, { error: att.error });
          const runId = await startSession(targetDeps, { agent: target, message: body.message + att.manifest, channel: body.channel as string | undefined });
          return send(res, 202, { runId, agent: target });
        }
        if (req.method === "GET" && parts.length === 1) {
          const all = [];
          for (const deps of Object.values(byAgent)) all.push(...(await listSessions(deps.store)));
          all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          return send(res, 200, { sessions: all.slice(0, 50) });
        }
        const found = parts[1] ? await findRun(parts[1]) : null;
        if (!found) return send(res, 404, { error: "no such session" });
        if (req.method === "GET" && parts.length === 2) {
          const session = await getSession(found.deps.store, found.run.runId);
          return session ? send(res, 200, session) : send(res, 404, { error: "not a session" });
        }
        if (req.method === "POST" && parts.length === 3 && parts[2] === "messages") {
          const body = await readJson(req);
          if (typeof body.message !== "string" && body.close !== true) {
            return send(res, 400, { error: "body must be {message: string, channel?, close?, files?: string[]}" });
          }
          const att = await resolveAttachments(found.deps, body.files);
          if ("error" in att) return send(res, 400, { error: att.error });
          try {
            await sendSessionMessage(found.deps, found.run.runId, {
              text: (typeof body.message === "string" ? body.message : "") + att.manifest,
              channel: body.channel as string | undefined,
              close: body.close === true,
            });
            return send(res, 202, { accepted: true });
          } catch (e) {
            if (e instanceof SessionBusyError) return send(res, 409, { error: e.message });
            return send(res, 400, { error: e instanceof Error ? e.message : String(e) });
          }
        }
        return send(res, 404, { error: "not found" });
      }

      // POST /runs — routes by body.agent (defaults to the deployment's default agent)
      if (req.method === "POST" && parts.length === 1 && parts[0] === "runs") {
        const body = await readJson(req);
        if (typeof body.input !== "string") return send(res, 400, { error: "body must be {input: string, agent?: string, process?: string, files?: string[]}" });
        const target = typeof body.agent === "string" ? body.agent : defaultAgent;
        const targetDeps = byAgent[target];
        if (!targetDeps) {
          return send(res, 400, { error: `unknown agent "${target}" — this deployment serves: ${agentNames.join(", ")}` });
        }
        const proc = typeof body.process === "string" ? body.process : cfg.defaultProcess?.[target];
        if (proc !== undefined && !targetDeps.workflows[proc]) {
          return send(res, 400, { error: `no process "${proc}" for agent "${target}" (has: ${Object.keys(targetDeps.workflows).join(", ")})` });
        }
        const att = await resolveAttachments(targetDeps, body.files);
        if ("error" in att) return send(res, 400, { error: att.error });
        const runId = await startRun(targetDeps, { agent: target, input: body.input + att.manifest, ...(proc ? { process: proc } : {}) });
        return send(res, 202, { runId, agent: target, process: proc ?? "main" });
      }

      // GET /runs — every crew's runs, newest first
      if (req.method === "GET" && parts.length === 1 && parts[0] === "runs") {
        const all = (await Promise.all(Object.values(byAgent).map((d) => d.store.listRuns()))).flat();
        all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        return send(res, 200, { runs: all });
      }

      if (parts.length >= 2 && parts[0] === "runs") {
        const runId = parts[1]!;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
          return send(res, 404, { error: `run ${runId} not found` });
        }
        const hit = await findRun(runId);
        if (!hit) return send(res, 404, { error: `run ${runId} not found` });
        const { deps, run } = hit;

        // GET /runs/:id
        if (req.method === "GET" && parts.length === 2) {
          const folded = foldRunStream(effectiveEvents(await deps.store.read(runId, "run")));
          const approvals = await listPendingApprovals(deps.store, runId);
          return send(res, 200, {
            run,
            status: approvals.length > 0 && run.status === "running" ? "waiting_approval" : run.status,
            waves: folded.waves.map((w) => ({
              name: w.name, tasks: w.tasks.length, settled: w.settledTasks.size, done: w.settled,
            })),
            approvals,
            usage: await runUsage(deps.store, runId),
          });
        }

        // GET /runs/:id/events
        if (req.method === "GET" && parts.length === 3 && parts[2] === "events") {
          const runEvents = effectiveEvents(await deps.store.read(runId, "run"));
          const tasks: Record<string, unknown> = {};
          for (const e of runEvents.filter((x) => x.type === "WavePlanned")) {
            for (const t of e.payload.tasks as { taskId: string }[]) {
              tasks[t.taskId] = effectiveEvents(await deps.store.read(runId, `task:${t.taskId}`));
            }
          }
          return send(res, 200, { run: runEvents, tasks });
        }

        // GET /runs/:id/events/stream — SSE: every event as it lands, then done.
        if (req.method === "GET" && parts.length === 4 && parts[2] === "events" && parts[3] === "stream") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          res.write(":ok\n\n");
          const cursor: import("@toren-run/core").TailCursor = {};
          let open = true;
          req.on("close", () => { open = false; });
          while (open) {
            const { events, done } = await followRun(deps.store, runId, cursor);
            for (const e of events) {
              res.write(`id: ${e.streamId}:${e.seq}\ndata: ${JSON.stringify({ streamId: e.streamId, seq: e.seq, type: e.type, payload: e.payload, recordedAt: e.recordedAt })}\n\n`);
            }
            if (done) {
              res.write("event: done\ndata: {}\n\n");
              break;
            }
            res.write(":hb\n\n");
            await new Promise((r) => setTimeout(r, 700));
          }
          return res.end();
        }

        // POST /runs/:id/cancel — retire a run; retries stop, queued hints no-op
        if (req.method === "POST" && parts.length === 3 && parts[2] === "cancel") {
          const ok = await cancelRun(deps, runId, "cancelled via API");
          return ok ? send(res, 200, { cancelled: true }) : send(res, 404, { error: `run ${runId} is unknown or already terminal` });
        }

        // POST /runs/:id/approvals
        if (req.method === "POST" && parts.length === 3 && parts[2] === "approvals") {
          const body = await readJson(req);
          if (typeof body.taskId !== "string" || typeof body.stepId !== "string" || typeof body.granted !== "boolean") {
            return send(res, 400, { error: "body must be {taskId, stepId, granted, comment?}" });
          }
          await resolveApproval(deps, {
            runId, taskId: body.taskId, stepId: body.stepId,
            granted: body.granted, by: "api", comment: body.comment as string | undefined,
          });
          return send(res, 200, { ok: true });
        }
      }

      return send(res, 404, { error: "not found" });
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      send(res, status, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}
