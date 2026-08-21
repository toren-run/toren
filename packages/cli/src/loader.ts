import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import { parse as parseYaml } from "yaml";
import { BUILTIN_TOOL_ENV, BUILTIN_TOOLS, type AgentSpec, type ToolDefAny, type WorkflowFn } from "@toren-run/core";

const jiti = createJiti(import.meta.url);

export interface LoadedAgent {
  /** Sanitized name — doubles as the schema/agent key. */
  name: string;
  dir: string;
  agents: Record<string, AgentSpec>;
  workflows: Record<string, WorkflowFn>;
}

interface AgentYaml {
  name?: string;
  model?: string;
  maxTokens?: number;
  limits?: { maxStepsPerTask?: number };
  env?: { required?: string[]; optional?: Record<string, string> };
  /** Built-in tools by name, e.g. [web_search]. Their required env folds into env.required. */
  builtin_tools?: string[];
}

/** Resolve a declared env block against process.env. Values never get logged. */
function resolveEnv(decl: AgentYaml["env"], where: string, missing: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, fallback] of Object.entries(decl?.optional ?? {})) {
    out[name] = process.env[name] ?? String(fallback);
  }
  for (const name of decl?.required ?? []) {
    const v = process.env[name];
    if (v === undefined || v === "") missing.push(`${name} (${where})`);
    else out[name] = v;
  }
  return out;
}

export function sanitizeName(raw: string): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z]+/, "");
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(s)) throw new Error(`cannot derive a valid agent name from "${raw}"`);
  return s;
}

async function loadAgentSpec(dir: string, where: string, missing: string[]): Promise<{ spec: AgentSpec; yaml: AgentYaml }> {
  const yamlPath = join(dir, "agent.yaml");
  const yaml = (existsSync(yamlPath) ? parseYaml(readFileSync(yamlPath, "utf8")) : {}) as AgentYaml;
  const instructionsPath = join(dir, "instructions.md");
  const system = existsSync(instructionsPath) ? readFileSync(instructionsPath, "utf8").trim() : "You are a helpful agent.";

  const tools: ToolDefAny[] = [];
  const toolsDir = join(dir, "tools");
  if (existsSync(toolsDir)) {
    for (const f of readdirSync(toolsDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js")).sort()) {
      const mod = await jiti.import<{ default?: ToolDefAny }>(join(toolsDir, f));
      const tool = mod.default;
      if (!tool || typeof tool.handler !== "function") throw new Error(`${join(toolsDir, f)}: expected a defineTool(...) default export`);
      tools.push(tool);
    }
  }

  for (const name of yaml.builtin_tools ?? []) {
    const builtin = BUILTIN_TOOLS[name];
    if (!builtin) throw new Error(`${where}: unknown builtin tool "${name}" (available: ${Object.keys(BUILTIN_TOOLS).join(", ")})`);
    if (tools.some((t) => t.name === builtin.name)) throw new Error(`${where}: builtin "${name}" collides with a tool of the same name in tools/`);
    tools.push(builtin);
  }
  const builtinEnv = (yaml.builtin_tools ?? []).flatMap((name) => BUILTIN_TOOL_ENV[name] ?? []);
  const env = {
    required: [...new Set([...(yaml.env?.required ?? []), ...builtinEnv])],
    optional: yaml.env?.optional,
  };

  return {
    yaml,
    spec: {
      model: yaml.model ?? "mock/echo",
      system,
      tools,
      maxTokens: yaml.maxTokens ?? 16_000,
      maxSteps: yaml.limits?.maxStepsPerTask ?? 50,
      env: resolveEnv(env, where, missing),
    },
  };
}

/** Load a filesystem-first agent directory. */
export async function loadAgentDir(dirRaw: string): Promise<LoadedAgent> {
  const dir = resolve(dirRaw);
  if (!existsSync(join(dir, "agent.yaml"))) throw new Error(`${dir} has no agent.yaml — not an agent directory`);

  const missing: string[] = [];
  const root = await loadAgentSpec(dir, "agent.yaml", missing);
  const name = sanitizeName(root.yaml.name ?? dir.split("/").at(-1)!);

  const agents: Record<string, AgentSpec> = { main: root.spec };
  const subagentsDir = join(dir, "subagents");
  if (existsSync(subagentsDir)) {
    for (const ref of readdirSync(subagentsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
      agents[ref] = (await loadAgentSpec(join(subagentsDir, ref), `subagents/${ref}/agent.yaml`, missing)).spec;
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `missing required env for this agent:\n  ${missing.join("\n  ")}\nSet the variable(s) in your environment (locally: .env; AWS: Secrets Manager via agent_env_secret_arns).`,
    );
  }

  let workflow: WorkflowFn;
  const workflowPath = join(dir, "workflow.ts");
  if (existsSync(workflowPath)) {
    const mod = await jiti.import<{ default?: WorkflowFn }>(workflowPath);
    if (typeof mod.default !== "function") throw new Error(`${workflowPath}: expected a default-exported workflow function`);
    workflow = mod.default;
  } else {
    workflow = async (ctx) => {
      const w = await ctx.wave("main", [ctx.task("main", ctx.input)]);
      return w.results[0]?.output ?? "";
    };
  }

  return { name, dir, agents, workflows: { [name]: workflow } };
}

export interface LoadedProject {
  /** Every crew served by this deployment, keyed by agent name. */
  crews: Record<string, LoadedAgent>;
}

/**
 * Load a project of process agents. Each dir may be a single agent directory
 * (has agent.yaml) or a folder of agent directories — both shapes load, so
 * `toren dev` serves one crew or a whole fleet with the same flag.
 */
export async function loadProject(dirsRaw: string[]): Promise<LoadedProject> {
  const crews: Record<string, LoadedAgent> = {};
  const add = async (dir: string) => {
    const loaded = await loadAgentDir(dir);
    if (crews[loaded.name]) throw new Error(`two agent directories resolve to the same name "${loaded.name}" (${crews[loaded.name]!.dir} and ${loaded.dir})`);
    crews[loaded.name] = loaded;
  };
  for (const dirRaw of dirsRaw) {
    const dir = resolve(dirRaw);
    if (existsSync(join(dir, "agent.yaml"))) {
      await add(dir);
      continue;
    }
    const children = existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "agent.yaml")))
          .map((d) => join(dir, d.name))
      : [];
    if (children.length === 0) throw new Error(`${dir} is neither an agent directory (agent.yaml) nor a folder containing agent directories`);
    for (const child of children) await add(child);
  }
  if (Object.keys(crews).length === 0) throw new Error("no agents found");
  return { crews };
}
