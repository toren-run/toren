import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { AnthropicProvider, OpenAIProvider } from "../src/index.js";

const requireCjs = createRequire(import.meta.url);
const inCjsCache = (needle: string) => Object.keys(requireCjs.cache ?? {}).some((p) => p.includes(needle));

test("importing the package loads neither SDK; each loads on first construction, and only itself", () => {
  expect(inCjsCache("@anthropic-ai/sdk")).toBe(false);
  expect(inCjsCache("node_modules/openai/")).toBe(false);

  process.env.ANTHROPIC_API_KEY ??= "test-key";
  new AnthropicProvider();
  expect(inCjsCache("@anthropic-ai/sdk")).toBe(true);
  expect(inCjsCache("node_modules/openai/")).toBe(false); // the SDK you don't use is never parsed

  process.env.OPENAI_API_KEY ??= "test-key";
  new OpenAIProvider();
  expect(inCjsCache("node_modules/openai/")).toBe(true);
});

test("the bedrock SDK also loads only on first construction", async () => {
  expect(inCjsCache("client-bedrock-runtime")).toBe(false);
  const { BedrockProvider } = await import("../src/bedrock.js");
  expect(inCjsCache("client-bedrock-runtime")).toBe(false);
  new BedrockProvider();
  expect(inCjsCache("client-bedrock-runtime")).toBe(true);
});
