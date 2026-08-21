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

const readFile = defineTool({
  name: "read_file",
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

export const BUILTIN_TOOLS: Record<string, ToolDefAny> = { web_search: webSearch, read_file: readFile };

/** Env each builtin needs — folded into the agent's required env by the loader. */
export const BUILTIN_TOOL_ENV: Record<string, string[]> = { web_search: ["TAVILY_API_KEY"], read_file: [] };
