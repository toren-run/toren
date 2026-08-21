import { afterEach, expect, test, vi } from "vitest";
import { BUILTIN_TOOL_ENV, BUILTIN_TOOLS } from "../src/builtins.js";

const ctx = { runId: "r", taskId: "t", env: { TAVILY_API_KEY: "tvly-test-key" } };

afterEach(() => vi.unstubAllGlobals());

test("web_search: calls tavily with bearer auth, returns compact JSON", async () => {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe("https://api.tavily.com/search");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tvly-test-key");
    const body = JSON.parse(String(init?.body));
    expect(body.query).toBe("weather in SF");
    expect(body.max_results).toBe(3);
    return new Response(JSON.stringify({
      answer: "Sunny, 21C.",
      results: [{ title: "SF Weather", url: "https://example.com/sf", content: "Sunny today", score: 0.9, extra: "dropped" }],
    }), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);

  const out = JSON.parse(await BUILTIN_TOOLS.web_search!.handler({ query: "weather in SF", max_results: 3 }, ctx));
  expect(out.answer).toBe("Sunny, 21C.");
  expect(out.results).toEqual([{ title: "SF Weather", url: "https://example.com/sf", snippet: "Sunny today" }]);
  expect(fetchMock).toHaveBeenCalledOnce();
});

test("web_search: API failure surfaces status without leaking the key", async () => {
  vi.stubGlobal("fetch", async () => new Response("bad key", { status: 401 }));
  await expect(
    BUILTIN_TOOLS.web_search!.handler({ query: "x", max_results: 5 }, ctx),
  ).rejects.toThrow(/HTTP 401/);
  await expect(
    BUILTIN_TOOLS.web_search!.handler({ query: "x", max_results: 5 }, ctx),
  ).rejects.not.toThrow(/tvly-test-key/);
});

test("every builtin declares its env", () => {
  for (const name of Object.keys(BUILTIN_TOOLS)) expect(BUILTIN_TOOL_ENV[name]).toBeDefined();
});
