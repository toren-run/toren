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
