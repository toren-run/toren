import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolSpec } from "./model.js";

export type ToolEffects = "external" | "sandbox" | "none";
export interface ToolCtx {
  runId: string;
  taskId: string;
  /** Env values declared in agent.yaml `env:` — never raw process.env. */
  env: Record<string, string>;
  /** Attached-file access for the read_file builtin; wired by the runtime. */
  files?: { get(id: string): Promise<{ id: string; name: string; pages: string[] } | null> };
  /** Durable per-run workspace execution for the bash builtin; wired by the runtime. */
  sandbox?: SandboxExec;
}

/** One run's sandbox: commands and file operations against a persistent workspace. */
export interface SandboxExec {
  exec(command: string, opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
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
