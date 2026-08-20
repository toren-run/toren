import { expect, test } from "vitest";
import { MockProvider } from "../src/providers/mock.js";
import type { ModelRequest } from "../src/model.js";

test("plays scripted responses in order and counts calls", async () => {
  const p = new MockProvider([
    { content: [{ type: "text", text: "one" }], stopReason: "endTurn" },
    { content: [{ type: "text", text: "two" }], stopReason: "endTurn" },
  ]);
  const req: ModelRequest = { model: "mock/m", system: "", messages: [], tools: [], maxTokens: 100 };
  expect((await p.complete(req)).content[0]).toEqual({ type: "text", text: "one" });
  expect((await p.complete(req)).content[0]).toEqual({ type: "text", text: "two" });
  expect(p.calls).toBe(2);
  await expect(p.complete(req)).rejects.toThrow(/script exhausted/);
});
