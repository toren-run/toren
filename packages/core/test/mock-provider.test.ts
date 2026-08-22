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

test("mock/slow echoes like mock/echo but takes long enough to kill mid-run", async () => {
  const { EchoProvider } = await import("../src/providers/echo.js");
  const p = new EchoProvider();
  const req = { model: "mock/slow", system: "s", messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }], tools: [], maxTokens: 10 };
  const t0 = Date.now();
  const res = await p.complete(req);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(2500);
  expect(res.content[0]).toEqual({ type: "text", text: "echo(hi)" });
}, 10_000);
