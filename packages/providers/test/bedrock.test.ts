import { expect, test } from "vitest";
import { fromConverseResponse, toConverseParams } from "../src/bedrock.js";

test("toConverseParams maps the transcript, tools, and system onto the Converse shape", () => {
  const p = toConverseParams({
    model: "bedrock/us.anthropic.claude-opus-5-v1:0", system: "be helpful", maxTokens: 500,
    tools: [{ name: "lookup", description: "d", inputSchema: { type: "object" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "checking" }, { type: "toolUse", id: "t1", name: "lookup", input: { q: 1 } }] },
      { role: "user", content: [{ type: "toolResult", toolUseId: "t1", content: "42" }] },
    ],
  });
  expect(p.modelId).toBe("us.anthropic.claude-opus-5-v1:0");
  expect(p.system).toEqual([{ text: "be helpful" }]);
  expect(p.inferenceConfig).toEqual({ maxTokens: 500 });
  expect(p.toolConfig!.tools).toEqual([{ toolSpec: { name: "lookup", description: "d", inputSchema: { json: { type: "object" } } } }]);
  expect(p.messages![1]!.content).toEqual([{ text: "checking" }, { toolUse: { toolUseId: "t1", name: "lookup", input: { q: 1 } } }]);
  expect(p.messages![2]!.content).toEqual([{ toolResult: { toolUseId: "t1", content: [{ text: "42" }] } }]);
});

test("an errored tool result carries error status", () => {
  const p = toConverseParams({
    model: "bedrock/m", system: "", maxTokens: 10, tools: [],
    messages: [{ role: "user", content: [{ type: "toolResult", toolUseId: "t1", content: "boom", isError: true }] }],
  });
  expect(p.messages![0]!.content).toEqual([{ toolResult: { toolUseId: "t1", content: [{ text: "boom" }], status: "error" } }]);
});

test("fromConverseResponse maps content, stop reasons, and usage", () => {
  const r = fromConverseResponse({
    stopReason: "tool_use",
    output: { message: { role: "assistant", content: [{ text: "on it" }, { toolUse: { toolUseId: "t9", name: "lookup", input: { q: 2 } } }] } },
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
  } as never);
  expect(r.content).toEqual([{ type: "text", text: "on it" }, { type: "toolUse", id: "t9", name: "lookup", input: { q: 2 } }]);
  expect(r.stopReason).toBe("toolUse");
  expect(r.usage).toEqual({ inputTokens: 11, outputTokens: 7 });

  const cut = fromConverseResponse({ stopReason: "max_tokens", output: { message: { role: "assistant", content: [] } }, usage: { inputTokens: 1, outputTokens: 1 } } as never);
  expect(cut.stopReason).toBe("maxTokens");
  const filtered = fromConverseResponse({ stopReason: "content_filtered", output: { message: { role: "assistant", content: [] } }, usage: {} } as never);
  expect(filtered.stopReason).toBe("refusal");
});
