import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  createApiKey, createPool, effectiveEvents, foldRunStream, listApiKeys,
  listPendingApprovals, resolveApproval, revokeApiKey, startRun, verifyApiKey,
  type TickDeps,
} from "@toren/core";

/**
 * The intake API (spec §19 seed): trigger runs, read status/results/events,
 * resolve approvals. One agent per deployment (v0). Bearer-token auth;
 * /healthz is open for load-balancer checks.
 */
export interface ApiConfig {
  /** Admin (bootstrap) token: full access, including key management. */
  token: string;
  /** The loaded agent name — POST /runs targets it. */
  agent: string;
  /**
   * Pool for issued-key auth and /keys management. Without it the server
   * accepts only the admin token (pre-key deployments keep working).
   */
  pool?: ReturnType<typeof createPool>;
}

type Principal = { kind: "admin" } | { kind: "key"; id: string; name: string };

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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { status: 400 });
  }
}

export function createApiServer(deps: TickDeps, cfg: ApiConfig): Server {
  if (!cfg.token) throw new Error("api token must be non-empty (set TOREN_API_TOKEN)");

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://local");
      const parts = url.pathname.split("/").filter(Boolean);

      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
      const principal = await authenticate(req, cfg);
      if (!principal) return send(res, 401, { error: "missing or invalid bearer token" });

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

      // POST /runs
      if (req.method === "POST" && parts.length === 1 && parts[0] === "runs") {
        const body = await readJson(req);
        if (typeof body.input !== "string") return send(res, 400, { error: "body must be {input: string}" });
        if (body.agent !== undefined && body.agent !== cfg.agent) {
          return send(res, 400, { error: `this deployment serves agent "${cfg.agent}"` });
        }
        const runId = await startRun(deps, { agent: cfg.agent, input: body.input });
        return send(res, 202, { runId });
      }

      // GET /runs
      if (req.method === "GET" && parts.length === 1 && parts[0] === "runs") {
        return send(res, 200, { runs: await deps.store.listRuns() });
      }

      if (parts.length >= 2 && parts[0] === "runs") {
        const runId = parts[1]!;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
          return send(res, 404, { error: `run ${runId} not found` });
        }
        const run = await deps.store.getRun(runId);
        if (!run) return send(res, 404, { error: `run ${runId} not found` });

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
