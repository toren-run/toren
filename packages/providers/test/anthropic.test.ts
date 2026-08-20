import { expect, test } from "vitest";
import { toAnthropicParams, fromAnthropicResponse, AnthropicProvider } from "../src/anthropic.js";

test("maps normalized request to SDK params", () => {
  const p = toAnthropicParams({
    model: "anthropic/claude-opus-5",
    system: "sys",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "toolUse", id: "tu1", name: "f", input: { a: 1 } }] },
      { role: "user", content: [{ type: "toolResult", toolUseId: "tu1", content: "ok" }] },
    ],
    tools: [{ name: "f", description: "d", inputSchema: { type: "object" } }],
    maxTokens: 1000,
  });
  expect(p.model).toBe("claude-opus-5");
  expect(p.system).toBe("sys");
  expect(p.messages[1]!.content).toEqual([{ type: "tool_use", id: "tu1", name: "f", input: { a: 1 } }]);
  expect(p.messages[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "tu1", content: "ok" }]);
  expect(p.tools).toHaveLength(1);
});

test("maps refusal stop reason and usage", () => {
  const r = fromAnthropicResponse({
    content: [],
    stop_reason: "refusal",
    usage: { input_tokens: 7, output_tokens: 0 },
  } as never);
  expect(r.stopReason).toBe("refusal");
  expect(r.usage).toEqual({ inputTokens: 7, outputTokens: 0 });
});

test("maps tool_use response blocks", () => {
  const r = fromAnthropicResponse({
    content: [
      { type: "text", text: "calling" },
      { type: "tool_use", id: "tu2", name: "lookup", input: { q: "x" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 2 },
  } as never);
  expect(r.stopReason).toBe("toolUse");
  expect(r.content).toEqual([
    { type: "text", text: "calling" },
    { type: "toolUse", id: "tu2", name: "lookup", input: { q: "x" } },
  ]);
});

test.skipIf(!process.env.ANTHROPIC_API_KEY)("live smoke: one-line completion", async () => {
  const provider = new AnthropicProvider();
  const r = await provider.complete({
    model: "anthropic/claude-opus-5",
    system: "Reply with exactly one word.",
    messages: [{ role: "user", content: [{ type: "text", text: "Say OK." }] }],
    tools: [],
    maxTokens: 256,
  });
  expect(r.content.some((b) => b.type === "text" && b.text.length > 0)).toBe(true);
});
