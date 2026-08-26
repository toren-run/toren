import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  cancelRun, followRun, listPendingApprovals, resolveApproval, runUsage, startRun,
  type TickDeps,
} from "@toren-run/core";

/**
 * The MCP serve channel: durable runs, drivable from the coding agents people
 * already use (Claude Code, Cursor, and any MCP client). Two transports share
 * this server: `toren mcp` speaks stdio locally with no auth, and the HTTP
 * API mounts it at POST /mcp behind the same bearer tokens as every other
 * route. Each tool is a thin wrapper over the host API; the durability
 * semantics are identical to the CLI and HTTP paths.
 */

export interface McpOpts {
  defaultAgent: string;
  /** Sanitized deployment structure (crewInfo shape) for list_agents. */
  info?: unknown;
}

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }], isError: true });

export function buildMcpServer(byAgent: Record<string, TickDeps>, opts: McpOpts): McpServer {
  const server = new McpServer({ name: "toren", version: "0.1.9" });
  const depsFor = (agent?: string) => {
    const name = agent ?? opts.defaultAgent;
    const deps = byAgent[name];
    if (!deps) throw new Error(`unknown agent "${name}" — this deployment serves: ${Object.keys(byAgent).join(", ")}`);
    return { name, deps };
  };
  const findRun = async (runId: string) => {
    for (const [agent, deps] of Object.entries(byAgent)) {
      const run = await deps.store.getRun(runId);
      if (run) return { agent, deps, run };
    }
    throw new Error(`run ${runId} not found`);
  };

  server.registerTool("list_agents", {
    description: "What this Toren deployment serves: agents, their named processes, models, and tools. Call this first to learn what you can start.",
    inputSchema: {},
  }, async () => json(opts.info ?? { agents: Object.keys(byAgent), default: opts.defaultAgent }));

  server.registerTool("start_run", {
    description: "Start a durable background run of an agent's named process. It executes on Toren's workers and survives crashes, deploys, and restarts; poll run_status for progress. Returns immediately with the run id.",
    inputSchema: {
      input: z.string().describe("the input handed to the run"),
      agent: z.string().optional().describe("agent name; defaults to the deployment's default"),
      process: z.string().optional().describe("named process to run; defaults to the agent's default"),
    },
  }, async ({ input, agent, process }) => {
    try {
      const { name, deps } = depsFor(agent);
      const runId = await startRun(deps, { agent: name, input, ...(process ? { process } : {}) });
      return json({ run_id: runId, agent: name, process: process ?? "main" });
    } catch (e) { return fail(e); }
  });

  server.registerTool("run_status", {
    description: "Status of a run: state, per-wave progress, pending approvals, recorded error while retrying, cost roll-up, and the output once it settles.",
    inputSchema: { run_id: z.string() },
  }, async ({ run_id }) => {
    try {
      const { deps, run } = await findRun(run_id);
      const approvals = await listPendingApprovals(deps.store, run_id);
      const cursor = {};
      const { events } = await followRun(deps.store, run_id, cursor);
      const waves = events.filter((e) => e.type === "WavePlanned").length;
      return json({
        run_id, agent: run.agent, process: run.process, status: approvals.length > 0 && run.status === "running" ? "waiting_approval" : run.status,
        ...(run.output != null ? { output: run.output } : {}), ...(run.error != null ? { error: run.error } : {}),
        waves, events: events.length, approvals,
        usage: await runUsage(deps.store, run_id),
      });
    } catch (e) { return fail(e); }
  });

  server.registerTool("list_runs", {
    description: "The newest runs on this deployment, with status and process names.",
    inputSchema: {},
  }, async () => {
    try {
      const all = (await Promise.all(Object.values(byAgent).map((d) => d.store.listRuns()))).flat();
      all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return json({ runs: all });
    } catch (e) { return fail(e); }
  });

  server.registerTool("cancel_run", {
    description: "Retire a run: retries stop and queued work for it becomes a no-op. Use when a run is stuck on a permanently broken dependency.",
    inputSchema: { run_id: z.string() },
  }, async ({ run_id }) => {
    try {
      const { deps } = await findRun(run_id);
      const ok = await cancelRun(deps, run_id, "cancelled via MCP");
      return json({ cancelled: ok });
    } catch (e) { return fail(e); }
  });

  server.registerTool("resolve_approval", {
    description: "Approve or deny a run parked on a gated tool call; the run wakes and continues. Coordinates come from run_status's approvals.",
    inputSchema: {
      run_id: z.string(), task_id: z.string(), step_id: z.string(),
      granted: z.boolean(), comment: z.string().optional(),
    },
  }, async ({ run_id, task_id, step_id, granted, comment }) => {
    try {
      const { deps } = await findRun(run_id);
      await resolveApproval(deps, { runId: run_id, taskId: task_id, stepId: step_id, granted, by: "mcp", comment });
      return json({ resolved: true, granted });
    } catch (e) { return fail(e); }
  });

  return server;
}
