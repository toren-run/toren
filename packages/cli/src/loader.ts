import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import { parse as parseYaml } from "yaml";
import { BUILTIN_TOOL_ENV, BUILTIN_TOOLS, SANDBOX_TOOLKIT, type AgentSpec, type ToolDefAny, type WorkflowFn } from "@toren-run/core";

const jiti = createJiti(import.meta.url);

export interface LoadedAgent {
  /** Sanitized name — doubles as the schema/agent key. */
  name: string;
  dir: string;
  agents: Record<string, AgentSpec>;
  /** Named processes, keyed by process name ("main" is the single/default workflow). */
  workflows: Record<string, WorkflowFn>;
  /** Process used when a trigger names none; undefined when ambiguous (several processes, no main, none declared). */
  defaultProcess?: string;
  /** Env var name holding this agent's dedicated Telegram bot token (agent.yaml telegram.bot_token_env). Resolved where the bot starts, so other commands work without it set. */
  telegramBotTokenEnv?: string;
  /** Beta — peers this agent's yaml asks to call; the fleet runtime intersects with each peer's acceptFrom. */
  canCall?: string[];
  /** Beta — peers this agent consents to answer. */
  acceptFrom?: string[];
  /** agent.yaml telegram.groups: "observe" — group traffic recorded, never answered. */
  telegramGroupsMode?: "observe";
  /** agent.yaml telegram.observe.updates, validated. */
  telegramObserveUpdates?: ("message" | "edited_message" | "my_chat_member")[];
  /** Non-fatal loader findings worth an operator's eyes; printed at dev boot. */
  warnings?: string[];
  /** Root agent's sandbox settings with granted env resolved to values. */
  sandbox?: { image?: string; network?: boolean; env?: Record<string, string> };
}

interface AgentYaml {
  name?: string;
  model?: string;
  maxTokens?: number;
  limits?: { maxStepsPerTask?: number; maxAttemptsPerTask?: number; maxWallClockMin?: number };
  /** For OpenAI reasoning models: "none" | "low" | "medium" | "high". gpt-5.6+ need it to use tools. */
  reasoning_effort?: string;
  contextWindow?: number;
  env?: {
    required?: string[];
    optional?: Record<string, string>;
    /** Beta — per-agent env binding: logical name → the process env var it reads from. Lets two co-located agents give the same logical key (SQL_DATABASE_URL) different values (CMO_SQL_DATABASE_URL vs CFO_SQL_DATABASE_URL). Tools keep their logical names. */
    bind?: Record<string, string>;
  };
  /** Built-in tools by name, e.g. [web_search]. Their required env folds into env.required. */
  builtin_tools?: string[];
  /** `true` (or a settings block) gives the agent a computer: bash + read_file/write_file/edit_file on a durable workspace. */
  sandbox?: boolean | { image?: string; network?: boolean; approval?: "always" | "never"; env?: string[] };
  /** Process run when a trigger names none. Defaults to "main", or the sole process. */
  default_process?: string;
  /** Beta — cross-agent calls: peers this agent may call, and peers it will answer. Both sides must declare for a call to connect. */
  agents?: { can_call?: string[]; accept_from?: string[] };
  /** Dedicated Telegram bot for this agent: the env var NAME holding its token. Without it the agent rides the shared TELEGRAM_BOT_TOKEN fleet bot. */
  telegram?: {
    bot_token_env?: string;
    /** "observe": record group traffic to toren_control.telegram_observations, never reply there. DMs still converse. */
    groups?: "observe";
    /** Update kinds an observing bot records (default ["message"]): message, edited_message, my_chat_member. */
    observe?: { updates?: string[] };
  };
}

function sandboxConfig(yaml: AgentYaml): { image?: string; network?: boolean; approval?: "always" | "never"; env?: string[] } | null {
  if (yaml.sandbox === undefined || yaml.sandbox === false) return null;
  return yaml.sandbox === true ? {} : yaml.sandbox;
}

/** Resolve a declared env block against process.env. Values never get logged.
 * env.bind redirects a logical name to a different process variable — the
 * tool keeps reading ctx.env.SQL_DATABASE_URL, the deployment decides which
 * physical variable that is for THIS agent. Same pattern as telegram.bot_token_env. */
function resolveEnv(decl: AgentYaml["env"], where: string, missing: string[]): Record<string, string> {
  const phys = (name: string) => decl?.bind?.[name] ?? name;
  const out: Record<string, string> = {};
  for (const [name, fallback] of Object.entries(decl?.optional ?? {})) {
    out[name] = process.env[phys(name)] ?? String(fallback);
  }
  for (const name of decl?.required ?? []) {
    const v = process.env[phys(name)];
    if (v === undefined || v === "") missing.push(`${phys(name)}${phys(name) !== name ? ` (bound to ${name})` : ""} (${where})`);
    else out[name] = v;
  }
  for (const name of Object.keys(decl?.bind ?? {})) {
    if (!(decl?.required ?? []).includes(name) && !(name in (decl?.optional ?? {}))) {
      missing.push(`env.bind names "${name}" but it is not declared in env.required or env.optional (${where})`);
    }
  }
  return out;
}

export function sanitizeName(raw: string): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z]+/, "");
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(s)) throw new Error(`cannot derive a valid agent name from "${raw}"`);
  return s;
}

function processNameFromFile(file: string): string {
  const stem = file.replace(/\.(ts|js)$/, "");
  if (!/^[a-z][a-z0-9_-]{0,40}$/.test(stem)) {
    throw new Error(`workflow filename "${file}" is not a valid process name (lowercase letters, digits, "_", "-")`);
  }
  return stem;
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
    if (name === "bash") throw new Error(`${where}: declare "sandbox: true" instead of listing bash — it grants bash plus the workspace file tools`);
    const builtin = BUILTIN_TOOLS[name];
    if (!builtin) throw new Error(`${where}: unknown builtin tool "${name}" (available: ${Object.keys(BUILTIN_TOOLS).filter((n) => n !== "bash").join(", ")}; "sandbox: true" grants bash)`);
    if (tools.some((t) => t.name === builtin.name)) throw new Error(`${where}: builtin "${name}" collides with a tool of the same name in tools/`);
    tools.push(builtin);
  }
  const sandbox = sandboxConfig(yaml);
  if (sandbox) {
    for (const kit of SANDBOX_TOOLKIT) {
      if (tools.some((t) => t.name === kit.name)) throw new Error(`${where}: sandbox tool "${kit.name}" collides with a tool of the same name in tools/`);
      // bash approves-by-default; sandbox.approval: never relaxes it deliberately.
      if (kit.name === "bash" && sandbox.approval === "never") tools.push({ ...kit, approval: "never" });
      else tools.push(kit);
    }
  }
  const builtinEnv = (yaml.builtin_tools ?? []).flatMap((name) => BUILTIN_TOOL_ENV[name] ?? []);
  const env = {
    required: [...new Set([...(yaml.env?.required ?? []), ...builtinEnv, ...(sandbox?.env ?? [])])],
    optional: yaml.env?.optional,
    bind: yaml.env?.bind,
  };

  return {
    yaml,
    spec: {
      model: yaml.model ?? "mock/echo",
      system,
      tools,
      maxTokens: yaml.maxTokens ?? 16_000,
      maxSteps: yaml.limits?.maxStepsPerTask ?? 50,
      ...(yaml.limits?.maxAttemptsPerTask ? { maxTaskAttempts: yaml.limits.maxAttemptsPerTask } : {}),
      ...(yaml.limits?.maxWallClockMin ? { maxWallClockMin: yaml.limits.maxWallClockMin } : {}),
      ...(yaml.reasoning_effort ? { reasoningEffort: yaml.reasoning_effort } : {}),
      ...(yaml.contextWindow ? { contextWindow: yaml.contextWindow } : {}),
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

  let sandbox: LoadedAgent["sandbox"];
  const sandboxYaml = sandboxConfig(root.yaml);
  if (sandboxYaml || Object.values(agents).some((a) => a.tools.some((t) => t.name === "bash"))) {
    const grantedEnv: Record<string, string> = {};
    for (const name of sandboxYaml?.env ?? []) {
      const v = process.env[root.yaml.env?.bind?.[name] ?? name];
      if (v !== undefined && v !== "") grantedEnv[name] = v; // missing values already reported via env.required
    }
    sandbox = { image: sandboxYaml?.image, network: sandboxYaml?.network, env: grantedEnv };
  }

  let workflows: Record<string, WorkflowFn>;
  const workflowPath = join(dir, "workflow.ts");
  const workflowsDir = join(dir, "workflows");
  if (existsSync(workflowPath) && existsSync(workflowsDir)) {
    throw new Error(`${dir}: has both workflow.ts and workflows/ — move workflow.ts into workflows/`);
  }
  if (existsSync(workflowsDir)) {
    workflows = {};
    for (const f of readdirSync(workflowsDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js")).sort()) {
      const mod = await jiti.import<{ default?: WorkflowFn }>(join(workflowsDir, f));
      if (typeof mod.default !== "function") throw new Error(`${join(workflowsDir, f)}: expected a default-exported workflow function`);
      workflows[processNameFromFile(f)] = mod.default;
    }
    if (Object.keys(workflows).length === 0) throw new Error(`${workflowsDir} has no workflow files (*.ts / *.js)`);
  } else if (existsSync(workflowPath)) {
    const mod = await jiti.import<{ default?: WorkflowFn }>(workflowPath);
    if (typeof mod.default !== "function") throw new Error(`${workflowPath}: expected a default-exported workflow function`);
    workflows = { main: mod.default };
  } else {
    workflows = {
      main: async (ctx) => {
        const w = await ctx.wave("main", [ctx.task("main", ctx.input)]);
        return w.results[0]?.output ?? "";
      },
    };
  }

  const declared = root.yaml.default_process;
  if (declared && !workflows[declared]) {
    throw new Error(`agent.yaml default_process "${declared}" is not a process of this agent (has: ${Object.keys(workflows).join(", ")})`);
  }
  const processNames = Object.keys(workflows);
  const defaultProcess = declared ?? (workflows.main ? "main" : processNames.length === 1 ? processNames[0] : undefined);

  // Tell the model what it can actually spawn — clone, never mutate the shared builtin.
  const processLine = ` Available processes: ${processNames.join(", ")}${defaultProcess ? ` (default: ${defaultProcess})` : ""}.`;
  for (const spec of Object.values(agents)) {
    spec.tools = spec.tools.map((t) => (t.name === "run_process" ? { ...t, description: t.description + processLine } : t));
  }

  // Beta cross-agent calls: declaring can_call grants the tool to the ROOT
  // agent only (subagents delegate through their root). Which peers actually
  // answer is decided at fleet startup, where both yamls are visible.
  const canCall = root.yaml.agents?.can_call ?? [];
  if (canCall.length > 0 && !agents.main!.tools.some((t) => t.name === "call_agent")) {
    const callLine = ` This agent asks to call: ${canCall.join(", ")}.`;
    agents.main!.tools = [...agents.main!.tools, { ...BUILTIN_TOOLS.call_agent!, description: BUILTIN_TOOLS.call_agent!.description + callLine }];
    if (!agents.main!.tools.some((t) => t.name === "check_run")) {
      agents.main!.tools = [...agents.main!.tools, BUILTIN_TOOLS.check_run!];
    }
  }

  // The double-fire trap, surfaced at load: an external tool that is unkeyed
  // AND never gated is at-least-once with real side effects — legal, but it
  // should be a choice someone can point to, not a default nobody noticed.
  const warnings: string[] = [];
  for (const [agentRef, spec] of Object.entries(agents)) {
    for (const t of spec.tools) {
      if (t.effects === "external" && t.idempotency === "none" && t.approval === "never") {
        warnings.push(
          `${agentRef === "main" ? name : `${name}/${agentRef}`}: tool "${t.name}" is external, unkeyed, and unapproved — a crash mid-call can fire it twice on resume. Give it idempotency: "keyed", an approval gate, or accept at-least-once knowingly.`,
        );
      }
    }
  }

  const telegramBotTokenEnv = root.yaml.telegram?.bot_token_env;
  const telegramGroupsMode = root.yaml.telegram?.groups;
  if (telegramGroupsMode !== undefined && telegramGroupsMode !== "observe") {
    throw new Error(`agent.yaml telegram.groups: unknown mode "${String(telegramGroupsMode)}" (only "observe" is supported)`);
  }
  const OBSERVABLE = ["message", "edited_message", "my_chat_member"];
  const telegramObserveUpdates = root.yaml.telegram?.observe?.updates as ("message" | "edited_message" | "my_chat_member")[] | undefined;
  for (const kind of telegramObserveUpdates ?? []) {
    if (!OBSERVABLE.includes(kind)) throw new Error(`agent.yaml telegram.observe.updates: unknown kind "${String(kind)}" (known: ${OBSERVABLE.join(", ")})`);
  }

  return { name, dir, agents, workflows, ...(defaultProcess ? { defaultProcess } : {}), ...(canCall.length ? { canCall } : {}), ...(root.yaml.agents?.accept_from?.length ? { acceptFrom: root.yaml.agents.accept_from } : {}), ...(telegramBotTokenEnv ? { telegramBotTokenEnv } : {}), ...(telegramGroupsMode ? { telegramGroupsMode } : {}), ...(telegramObserveUpdates ? { telegramObserveUpdates } : {}), ...(warnings.length ? { warnings } : {}), ...(sandbox ? { sandbox } : {}) };
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
