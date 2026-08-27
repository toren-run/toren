import pg from "pg";
import { z } from "zod";
import { defineTool, type ToolDefAny } from "./tools.js";

/**
 * Built-in tools: declared by name in agent.yaml (`builtin_tools: [web_search]`),
 * no handler to write. Each carries the env it needs; the loader folds that into
 * the agent's required env so a missing key fails fast at startup, not mid-run.
 */

const webSearch = defineTool({
  name: "web_search",
  description:
    "Search the live web. Returns JSON with a short answer (when available) and the top results as {title, url, snippet}.",
  input: z.object({
    query: z.string().describe("what to search for"),
    max_results: z.number().int().min(1).max(10).default(5),
  }),
  effects: "none",
  idempotency: "keyed",
  approval: "never",
  handler: async ({ query, max_results }, ctx) => {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ctx.env.TAVILY_API_KEY}`,
      },
      body: JSON.stringify({ query, max_results, include_answer: "basic" }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`web_search: tavily returned HTTP ${res.status}${detail ? ` (${detail})` : ""}`);
    }
    const body = (await res.json()) as {
      answer?: string;
      results?: { title?: string; url?: string; content?: string }[];
    };
    return JSON.stringify({
      answer: body.answer,
      results: (body.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
    });
  },
});

const readAttachment = defineTool({
  name: "read_attachment",
  description:
    "Read one page of an attached file. Attachments are listed in the conversation with their file_id and page count; call again with the next page number to keep reading.",
  input: z.object({
    file_id: z.string().describe("from the attachment list"),
    page: z.number().int().min(1).default(1),
  }),
  effects: "none",
  idempotency: "keyed",
  approval: "never",
  handler: async ({ file_id, page }, ctx) => {
    if (!ctx.files) throw new Error("read_file: this deployment has no file store configured");
    const f = await ctx.files.get(file_id);
    if (!f) return JSON.stringify({ error: `no file with id ${file_id}; check the attachment list` });
    const text = f.pages[page - 1];
    if (text === undefined) {
      return JSON.stringify({ error: `page ${page} is out of range`, name: f.name, pages: f.pages.length });
    }
    return JSON.stringify({ name: f.name, page, of: f.pages.length, text });
  },
});

const BASH_OUTPUT_CAP = 8_000; // chars kept from each of head and tail per stream

function capOutput(s: string): string {
  if (s.length <= BASH_OUTPUT_CAP * 2) return s;
  return `${s.slice(0, BASH_OUTPUT_CAP)}\n[... ${s.length - BASH_OUTPUT_CAP * 2} chars elided ...]\n${s.slice(-BASH_OUTPUT_CAP)}`;
}

function needSandbox(ctx: { sandbox?: import("./tools.js").SandboxExec }): import("./tools.js").SandboxExec {
  if (!ctx.sandbox) throw new Error("this deployment has no sandbox backend configured (is docker available?)");
  return ctx.sandbox;
}

/** Workspace file tools, pi-style: models edit reliably with exact strings, not sed. */
const wsReadFile = defineTool({
  name: "read_file",
  description: "Read a file from the workspace. Returns the content with 1-indexed line numbers.",
  input: z.object({
    path: z.string().describe("workspace-relative path"),
    offset: z.number().int().min(1).default(1).describe("first line to read"),
    limit: z.number().int().min(1).max(2000).default(500),
  }),
  effects: "sandbox",
  idempotency: "keyed",
  approval: "never",
  handler: async ({ path, offset, limit }, ctx) => {
    const content = await needSandbox(ctx).readFile(path);
    const lines = content.split("\n");
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join("\n");
    return JSON.stringify({ path, lines: lines.length, from: offset, text: capOutput(numbered) });
  },
});

const wsWriteFile = defineTool({
  name: "write_file",
  description: "Create or overwrite a file in the workspace.",
  input: z.object({ path: z.string(), content: z.string() }),
  effects: "sandbox",
  idempotency: "keyed",
  approval: "never",
  handler: async ({ path, content }, ctx) => {
    await needSandbox(ctx).writeFile(path, content);
    return JSON.stringify({ path, bytes: Buffer.byteLength(content) });
  },
});

const wsEditFile = defineTool({
  name: "edit_file",
  description:
    "Replace an exact string in a workspace file. old_string must appear exactly once unless replace_all is set; include enough surrounding context to make it unique.",
  input: z.object({
    path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().default(false),
  }),
  effects: "sandbox",
  idempotency: "keyed",
  approval: "never",
  handler: async ({ path, old_string, new_string, replace_all }, ctx) => {
    const sandbox = needSandbox(ctx);
    const content = await sandbox.readFile(path);
    const count = content.split(old_string).length - 1;
    if (count === 0) return JSON.stringify({ error: "old_string not found", path });
    if (count > 1 && !replace_all) return JSON.stringify({ error: `old_string appears ${count} times; add context or set replace_all`, path });
    const next = replace_all ? content.split(old_string).join(new_string) : content.replace(old_string, new_string);
    await sandbox.writeFile(path, next);
    return JSON.stringify({ path, replacements: replace_all ? count : 1 });
  },
});

const bash = defineTool({
  name: "bash",
  description:
    "Run a shell command in this run's persistent workspace. The workspace survives crashes and restarts; " +
    "files you create stay for later commands. Commands run in a sandbox container with no credentials.",
  input: z.object({
    command: z.string().describe("the shell command"),
    timeout_seconds: z.number().int().min(1).max(600).default(120),
  }),
  effects: "sandbox",
  idempotency: "keyed",
  approval: "always",
  handler: async ({ command, timeout_seconds }, ctx) => {
    if (!ctx.sandbox) throw new Error("bash: this deployment has no sandbox backend configured (is docker available?)");
    const r = await ctx.sandbox.exec(command, { timeoutMs: timeout_seconds * 1000 });
    return JSON.stringify({ exit_code: r.exitCode, stdout: capOutput(r.stdout), stderr: capOutput(r.stderr) });
  },
});

// ---- send_to_channel: hand a workspace file to the human on the run's chat
// channel. Without it, models with a sandbox write files and then fabricate
// download links, because there is no sanctioned way out (field report
// 2026-08-27). Photos and documents are inferred by extension; the runtime's
// channel delivery loop does the actual upload.

const PHOTO_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const MAX_CHANNEL_FILE_B64 = 15_000_000; // ~11MB decoded; telegram documents cap at 50MB but exec output shouldn't carry that

const sendToChannel = defineTool({
  name: "send_to_channel",
  description:
    "Send a file from this run's workspace to the person you are talking to on the chat channel (as a photo for images, " +
    "a document otherwise). Use this to deliver reports, charts, or any file you created — never write download links, they do not work.",
  input: z.object({
    path: z.string().describe("path of the file in the workspace"),
    caption: z.string().max(1000).optional().describe("short caption shown with the file"),
  }),
  effects: "external",
  idempotency: "keyed",
  approval: "never",
  handler: async ({ path, caption }, ctx) => {
    if (!ctx.channels) throw new Error("send_to_channel: this run has no channel delivery configured");
    if (!ctx.sandbox) throw new Error("send_to_channel: no sandbox workspace to read files from");
    const r = await ctx.sandbox.exec(`base64 < ${JSON.stringify(path)}`, { timeoutMs: 60_000 });
    if (r.exitCode !== 0) throw new Error(`send_to_channel: cannot read ${path}: ${r.stderr.trim() || "no such file"}`);
    const dataBase64 = r.stdout.replace(/\s+/g, "");
    if (!dataBase64) throw new Error(`send_to_channel: ${path} is empty`);
    if (dataBase64.length > MAX_CHANNEL_FILE_B64) throw new Error(`send_to_channel: ${path} is too large (limit ~11MB)`);
    const name = path.split("/").at(-1)!;
    const ext = name.split(".").at(-1)?.toLowerCase() ?? "";
    const kind = PHOTO_EXT.has(ext) ? ("photo" as const) : ("document" as const);
    const res = await ctx.channels.send({ name, dataBase64, caption, kind });
    if (res === "no-channel") {
      throw new Error("send_to_channel: this run is not bound to a chat channel (it was not started from one), so there is nobody to deliver to");
    }
    return `queued ${name} (${kind}) for delivery to the bound chat`;
  },
});

// ---- sql_query: read-only database access as a tool.
// Defense in depth on top of the STRONGLY RECOMMENDED read-only DB role:
// only a single SELECT/WITH runs, forbidden keywords are rejected, stacked
// statements are blocked, the result is row-capped, and a statement timeout
// bounds a heavy query. Pools are cached per connection string.
const sqlPools = new Map<string, pg.Pool>();
function sqlPool(url: string): pg.Pool {
  let p = sqlPools.get(url);
  if (!p) { p = new pg.Pool({ connectionString: url, max: 2, statement_timeout: 10_000, query_timeout: 12_000 }); sqlPools.set(url, p); }
  return p;
}
const SELECT_ONLY = /^\s*(with[\s\S]+\bselect\b|select)\b/i;
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|merge|vacuum|reindex|comment|do|set|begin|commit)\b/i;

const sqlQuery = defineTool({
  name: "sql_query",
  description:
    "Run a READ-ONLY SQL query (a single SELECT) against the configured database and get the rows back as JSON. Use standard SQL; results are capped.",
  input: z.object({
    query: z.string().describe("a single read-only SELECT statement"),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  effects: "none",
  idempotency: "keyed",
  approval: "never",
  handler: async ({ query, limit }, ctx) => {
    const url = ctx.env.SQL_DATABASE_URL;
    if (!url) throw new Error("sql_query: SQL_DATABASE_URL is not configured for this agent");
    const q = query.trim().replace(/;\s*$/, "");
    if (q.includes(";")) return JSON.stringify({ error: "only one statement is allowed (no ';')" });
    if (!SELECT_ONLY.test(q)) return JSON.stringify({ error: "only a read-only SELECT (or WITH ... SELECT) is allowed" });
    if (FORBIDDEN.test(q)) return JSON.stringify({ error: "the query contains a forbidden (write/DDL) keyword; this tool is read-only" });
    try {
      // Wrap so a missing LIMIT can never return an unbounded result set.
      const res = await sqlPool(url).query(`SELECT * FROM (${q}) AS _toren_q LIMIT ${limit}`);
      const out = JSON.stringify({ rowCount: res.rowCount, truncated: (res.rowCount ?? 0) >= limit, rows: res.rows });
      return out.length > 24_000 ? JSON.stringify({ rowCount: res.rowCount, note: "result too large; add columns/filters or a smaller limit", rows: res.rows.slice(0, 10) }) : out;
    } catch (e) {
      return JSON.stringify({ error: `query failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  },
});

// ---- run_process / check_run: the spawn arc. A conversation triggers a named
// process as a durable background run; a watcher wakes the session when it
// settles, so the agent messages the user in-channel without polling. The
// child runId derives from the tool-use id, so a crash-window re-run finds the
// run already exists — spawning is effectively-once.

const runProcess = defineTool({
  name: "run_process",
  description:
    "Start one of this agent's named processes as a background run. It executes durably on the workers while this conversation continues; a message lands in this conversation when it settles, and check_run polls it on demand.",
  input: z.object({
    process: z.string().describe("the process name to run"),
    input: z.string().describe("the input handed to the process run"),
  }),
  effects: "none",
  idempotency: "keyed",
  approval: "never",
  handler: async ({ process, input }, ctx) => {
    if (!ctx.processes) throw new Error("run_process: background processes are not wired in this deployment");
    const r = await ctx.processes.start({ process, input, parentRunId: ctx.runId, parentTaskId: ctx.taskId, toolUseId: ctx.toolUseId });
    return JSON.stringify({ run_id: r.runId, process, status: r.started ? "started" : "already_running" });
  },
});

const checkRun = defineTool({
  name: "check_run",
  description:
    "Check a background run started with run_process: status, per-wave progress from its event log, and the output once it finishes.",
  input: z.object({
    run_id: z.string().describe("from run_process"),
  }),
  effects: "none",
  idempotency: "keyed",
  approval: "never",
  handler: async ({ run_id }, ctx) => {
    if (!ctx.processes) throw new Error("check_run: background processes are not wired in this deployment");
    const s = await ctx.processes.status(run_id);
    if (!s) return JSON.stringify({ error: `no run ${run_id}` });
    return JSON.stringify({ run_id: s.runId, process: s.process, status: s.status, waves: s.waves, ...(s.output !== undefined ? { output: s.output } : {}), ...(s.error !== undefined ? { error: s.error } : {}) });
  },
});

export const BUILTIN_TOOLS: Record<string, ToolDefAny> = { web_search: webSearch, read_attachment: readAttachment, sql_query: sqlQuery, bash, run_process: runProcess, check_run: checkRun, send_to_channel: sendToChannel };

/** Env each builtin needs — folded into the agent's required env by the loader. */
export const BUILTIN_TOOL_ENV: Record<string, string[]> = { web_search: ["TAVILY_API_KEY"], read_attachment: [], sql_query: ["SQL_DATABASE_URL"], bash: [], run_process: [], check_run: [], send_to_channel: [] };

/**
 * The toolkit `sandbox: true` grants: a computer for the agent. bash gates on
 * approval by default; workspace file operations are free (their blast radius
 * is the workspace itself).
 */
export const SANDBOX_TOOLKIT: ToolDefAny[] = [bash, wsReadFile, wsWriteFile, wsEditFile, sendToChannel];
