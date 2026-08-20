import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { z } from "zod";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgStateStore } from "../src/store.js";
import { MockProvider } from "../src/providers/mock.js";
import { defineTool } from "../src/tools.js";
import { runTaskLoop } from "../src/loop.js";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();

const pool = createPool();
let store: PgStateStore;

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "oteltest"); });
  store = new PgStateStore(pool, "agent_oteltest");
});
afterAll(async () => {
  await pool.end();
  await provider.shutdown();
});

test("task, llm, and tool spans are emitted for live work", async () => {
  const lookup = defineTool({
    name: "lookup", description: "look", input: z.object({ q: z.string() }),
    effects: "external", idempotency: "keyed", approval: "never",
    handler: async ({ q }) => `fact:${q}`,
  });
  const runId = randomUUID();
  await store.createRun({ runId, agent: "oteltest" });
  await runTaskLoop({
    store,
    provider: new MockProvider([
      { content: [{ type: "toolUse", id: "tu1", name: "lookup", input: { q: "x" } }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "done" }], stopReason: "endTurn" },
    ]),
    runId, taskId: "t1",
    agent: { model: "mock/m", system: "s", tools: [lookup], maxTokens: 100, maxSteps: 10 },
    input: "go",
  });

  const names = exporter.getFinishedSpans().map((s) => s.name);
  expect(names).toContain("toren.task");
  expect(names.filter((n) => n === "toren.llm").length).toBe(2);
  expect(names).toContain("toren.tool");
  const llm = exporter.getFinishedSpans().find((s) => s.name === "toren.llm")!;
  expect(llm.attributes["gen_ai.request.model"]).toBe("mock/m");
});
