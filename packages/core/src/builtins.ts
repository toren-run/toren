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

export const BUILTIN_TOOLS: Record<string, ToolDefAny> = { web_search: webSearch, read_attachment: readAttachment, sql_query: sqlQuery, bash };

/** Env each builtin needs — folded into the agent's required env by the loader. */
export const BUILTIN_TOOL_ENV: Record<string, string[]> = { web_search: ["TAVILY_API_KEY"], read_attachment: [], sql_query: ["SQL_DATABASE_URL"], bash: [] };

/**
 * The toolkit `sandbox: true` grants: a computer for the agent. bash gates on
 * approval by default; workspace file operations are free (their blast radius
 * is the workspace itself).
 */
export const SANDBOX_TOOLKIT: ToolDefAny[] = [bash, wsReadFile, wsWriteFile, wsEditFile];
