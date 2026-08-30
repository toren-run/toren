import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolSpec } from "./model.js";

export type ToolEffects = "external" | "sandbox" | "none";
/**
 * Background processes: spawn one of the agent's named processes as a durable
 * run and inspect it. Wired by the runtime (like the sandbox); a watcher
 * recorded at spawn time wakes the parent session when the child settles.
 */
export interface ProcessesCtx {
  /** Process names this agent serves (the workflows map's keys). */
  names: string[];
  defaultProcess?: string;
  start(req: { process: string; input: string; parentRunId: string; parentTaskId: string; toolUseId: string }): Promise<{ runId: string; started: boolean }>;
  status(runId: string): Promise<null | {
    runId: string; process: string; status: string; output?: string; error?: string;
    waves: { name: string; tasks: number; settled: number; done: boolean }[];
  }>;
}

/** Cross-agent calls (beta): delegate to a consenting peer agent. Consent is mutual and resolved by the runtime; the callee answers with its own privileges and shares only its output. */
export interface AgentCallsCtx {
  /** Peers this agent may call — the intersection of its can_call and their accept_from. */
  callable: string[];
  call(req: { agent: string; input: string; process?: string; parentRunId: string; parentTaskId: string; toolUseId: string }): Promise<{ runId: string; agent: string; started: boolean }>;
  status(runId: string): Promise<null | {
    runId: string; agent: string; process: string; status: string; output?: string; error?: string;
  }>;
}

export interface ToolCtx {
  runId: string;
  taskId: string;
  /** The model's tool-use block id — stable across replays; key derived side effects on it. */
  toolUseId: string;
  /** Env values declared in agent.yaml `env:` — never raw process.env. */
  env: Record<string, string>;
  /** Attached-file access for the read_file builtin; wired by the runtime. */
  files?: { get(id: string): Promise<{ id: string; name: string; pages: string[] } | null> };
  /** Durable per-run workspace execution for the bash builtin; wired by the runtime. */
  sandbox?: SandboxExec;
  /** Background named-process runs for the run_process/check_run builtins; wired by the runtime. */
  processes?: ProcessesCtx;
  /** Cross-agent delegation (beta); wired by the fleet runtime when consent edges exist. */
  agentCalls?: AgentCallsCtx;
  /** Outbound file delivery to the run's bound chat channel (send_to_channel builtin); wired by the runtime. */
  channels?: {
    send(file: { name: string; dataBase64: string; caption?: string; kind: "photo" | "document" }): Promise<"queued" | "no-channel">;
  };
}

/** Per-run channel delivery, wired by the runtime for the send_to_channel builtin. */
export interface ChannelDeliveryProvider {
  forRun(runId: string): NonNullable<ToolCtx["channels"]>;
}

/** One run's sandbox: commands and file operations against a persistent workspace. */
export interface SandboxExec {
  exec(command: string, opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** Cheap park: preserve the workspace, stop paying for compute. Reconnected on next use. */
  pause?(): Promise<void>;
  /** Terminal cleanup: destroy the workspace and forget it. */
  dispose?(): Promise<void>;
}

/** Constructs per-run sandbox handles; implemented by the CLI runtime (docker locally). */
export interface SandboxProvider {
  forRun(runId: string): SandboxExec;
}

export interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  input: S;
  effects: ToolEffects;
  idempotency: "keyed" | "none";
  approval: "never" | "always" | ((args: z.infer<S>) => boolean);
  handler: (args: z.infer<S>, ctx: ToolCtx) => Promise<string>;
}

/** Type-erased tool shape — what registries, the loop, and AgentSpec consume. */
export interface ToolDefAny {
  name: string;
  description: string;
  input: z.ZodTypeAny;
  effects: ToolEffects;
  idempotency: "keyed" | "none";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  approval: "never" | "always" | ((args: any) => boolean);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any, ctx: ToolCtx) => Promise<string>;
}

export function defineTool<S extends z.ZodTypeAny>(def: ToolDef<S>): ToolDefAny {
  return def as unknown as ToolDefAny;
}

export function toolSpecs(tools: ToolDefAny[]): ToolSpec[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.input, { target: "jsonSchema7" }) as Record<string, unknown>,
  }));
}

export function needsApproval(t: ToolDefAny, args: unknown): boolean {
  return t.approval === "always" || (typeof t.approval === "function" && t.approval(args));
}
