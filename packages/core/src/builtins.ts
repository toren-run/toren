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

export const BUILTIN_TOOLS: Record<string, ToolDefAny> = { web_search: webSearch };

/** Env each builtin needs — folded into the agent's required env by the loader. */
export const BUILTIN_TOOL_ENV: Record<string, string[]> = { web_search: ["TAVILY_API_KEY"] };
