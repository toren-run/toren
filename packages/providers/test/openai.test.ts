import { expect, test } from "vitest";
import { fromOpenAIResponse, OpenAIProvider, toOpenAIParams } from "../src/openai.js";

test("maps normalized request: system first, tool results become role:tool messages, args stringified", () => {
  const p = toOpenAIParams({
    model: "openai/gpt-4o-mini",
    system: "sys",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "toolUse", id: "call_1", name: "f", input: { a: 1 } }] },
      { role: "user", content: [{ type: "toolResult", toolUseId: "call_1", content: "ok" }, { type: "text", text: "continue" }] },
    ],
    tools: [{ name: "f", description: "d", inputSchema: { type: "object" } }],
    maxTokens: 500,
  });
  expect(p.model).toBe("gpt-4o-mini");
  expect(p.max_completion_tokens).toBe(500);
  expect(p.messages[0]).toEqual({ role: "system", content: "sys" });
  expect(p.messages[2]).toMatchObject({
    role: "assistant",
    tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: '{"a":1}' } }],
  });
  // tool result answers the call BEFORE the trailing user text
  expect(p.messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "ok" });
  expect(p.messages[4]).toEqual({ role: "user", content: "continue" });
  expect(p.tools?.[0]).toMatchObject({ type: "function", function: { name: "f" } });
});

test("maps error tool results and empty assistant text", () => {
  const p = toOpenAIParams({
    model: "openai/gpt-4o-mini", system: "",
    messages: [
      { role: "assistant", content: [{ type: "toolUse", id: "c1", name: "f", input: {} }] },
      { role: "user", content: [{ type: "toolResult", toolUseId: "c1", content: "boom", isError: true }] },
    ],
    tools: [], maxTokens: 10,
  });
  expect(p.messages[0]).toMatchObject({ role: "assistant", content: null });
  expect(p.messages[1]).toEqual({ role: "tool", tool_call_id: "c1", content: "ERROR: boom" });
});

test("maps response: tool_calls parse to toolUse, finish reasons and usage translate", () => {
  const r = fromOpenAIResponse({
    choices: [{
      message: {
        role: "assistant", content: "thinking done",
        tool_calls: [
          { id: "call_9", type: "function", function: { name: "search", arguments: '{"q":"x"}' } },
          { id: "call_bad", type: "function", function: { name: "search", arguments: "not json" } },
        ],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 12, completion_tokens: 7 },
  } as never);
  expect(r.content[0]).toEqual({ type: "text", text: "thinking done" });
  expect(r.content[1]).toEqual({ type: "toolUse", id: "call_9", name: "search", input: { q: "x" } });
  expect(r.content[2]).toMatchObject({ input: { _raw: "not json" } });
  expect(r.stopReason).toBe("toolUse");
  expect(r.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
});

test("maps length and content_filter finish reasons", () => {
  const mk = (finish: string) => fromOpenAIResponse({ choices: [{ message: { role: "assistant", content: "x" }, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1 } } as never);
  expect(mk("length").stopReason).toBe("maxTokens");
  expect(mk("content_filter").stopReason).toBe("refusal");
  expect(mk("stop").stopReason).toBe("endTurn");
});

test.skipIf(!process.env.OPENAI_API_KEY)("live: one real completion round-trips (costs a fraction of a cent)", async () => {
  const provider = new OpenAIProvider();
  const r = await provider.complete({
    model: "openai/gpt-4o-mini",
    system: "Answer with exactly one word.",
    messages: [{ role: "user", content: [{ type: "text", text: "What color is the sky on a clear day?" }] }],
    tools: [],
    maxTokens: 20,
  });
  expect(r.content[0]?.type).toBe("text");
  expect(r.usage.outputTokens).toBeGreaterThan(0);
}, 30_000);

test("reasoning_effort passes through when set and stays absent when not", () => {
  const base = { model: "openai/gpt-5.6-sol", system: "s", messages: [], tools: [], maxTokens: 10 };
  expect("reasoning_effort" in toOpenAIParams(base)).toBe(false);
  const withEffort = toOpenAIParams({ ...base, reasoningEffort: "none" });
  expect((withEffort as unknown as Record<string, unknown>).reasoning_effort).toBe("none");
});

// ---- /v1/responses routing: reasoning models keep both reasoning AND tools.

test("toResponsesParams maps the transcript, tools, and reasoning effort", async () => {
  const { toResponsesParams } = await import("../src/openai.js");
  const p = toResponsesParams({
    model: "openai/gpt-5.6-sol", system: "be helpful", maxTokens: 500, reasoningEffort: "medium",
    tools: [{ name: "lookup", description: "d", inputSchema: { type: "object" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "checking" }, { type: "toolUse", id: "c1", name: "lookup", input: { q: 1 } }] },
      { role: "user", content: [{ type: "toolResult", toolUseId: "c1", content: "42" }] },
    ],
  });
  expect(p.model).toBe("gpt-5.6-sol");
  expect(p.instructions).toBe("be helpful");
  expect(p.max_output_tokens).toBe(500);
  expect(p.reasoning).toEqual({ effort: "medium" });
  expect(p.tools).toEqual([{ type: "function", name: "lookup", description: "d", parameters: { type: "object" }, strict: false }]);
  const kinds = (p.input as { type?: string; role?: string }[]).map((i) => i.type ?? i.role);
  expect(kinds).toEqual(["user", "assistant", "function_call", "function_call_output"]);
});

test("fromResponsesResponse maps text, tool calls, usage, and stop reasons", async () => {
  const { fromResponsesResponse } = await import("../src/openai.js");
  const r = fromResponsesResponse({
    status: "completed",
    output: [
      { type: "reasoning", summary: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "on it" }] },
      { type: "function_call", call_id: "c9", name: "lookup", arguments: '{"q":2}' },
    ],
    usage: { input_tokens: 11, output_tokens: 7 },
  } as never);
  expect(r.content).toEqual([{ type: "text", text: "on it" }, { type: "toolUse", id: "c9", name: "lookup", input: { q: 2 } }]);
  expect(r.stopReason).toBe("toolUse");
  expect(r.usage).toEqual({ inputTokens: 11, outputTokens: 7 });

  const cut = fromResponsesResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: { input_tokens: 1, output_tokens: 1 } } as never);
  expect(cut.stopReason).toBe("maxTokens");
});

test("the provider routes by reasoning effort: real effort uses /v1/responses, none or absent stays on chat/completions", async () => {
  const { OpenAIProvider, usesResponsesApi } = await import("../src/openai.js");
  void OpenAIProvider;
  expect(usesResponsesApi({ reasoningEffort: "medium" } as never)).toBe(true);
  expect(usesResponsesApi({ reasoningEffort: "none" } as never)).toBe(false);
  expect(usesResponsesApi({} as never)).toBe(false);
});
