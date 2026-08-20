import { afterEach, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAgentDir } from "../src/loader.js";

function makeAgent(envBlock: string): string {
  const dir = mkdtempSync(join(tmpdir(), "toren-env-"));
  writeFileSync(join(dir, "agent.yaml"), `name: envtest\nmodel: mock/echo\n${envBlock}`);
  writeFileSync(join(dir, "instructions.md"), "test agent\n");
  mkdirSync(join(dir, "subagents/worker"), { recursive: true });
  writeFileSync(join(dir, "subagents/worker/agent.yaml"), "name: worker\nmodel: mock/echo\nenv:\n  required: [WORKER_KEY]\n");
  return dir;
}

afterEach(() => {
  delete process.env.TOREN_TEST_API_KEY;
  delete process.env.WORKER_KEY;
  delete process.env.TOREN_TEST_REGION;
});

test("missing required env fails fast, listing every missing name with its agent", async () => {
  const dir = makeAgent("env:\n  required: [TOREN_TEST_API_KEY]\n");
  await expect(loadAgentDir(dir)).rejects.toThrow(/TOREN_TEST_API_KEY \(agent.yaml\)[\s\S]*WORKER_KEY \(subagents\/worker\/agent.yaml\)/);
});

test("declared env resolves onto specs; optional defaults apply; values reach ctx.env shape", async () => {
  process.env.TOREN_TEST_API_KEY = "sk-123";
  process.env.WORKER_KEY = "wk-456";
  const dir = makeAgent("env:\n  required: [TOREN_TEST_API_KEY]\n  optional:\n    TOREN_TEST_REGION: eu\n");
  const loaded = await loadAgentDir(dir);
  expect(loaded.agents.main!.env).toEqual({ TOREN_TEST_API_KEY: "sk-123", TOREN_TEST_REGION: "eu" });
  expect(loaded.agents.worker!.env).toEqual({ WORKER_KEY: "wk-456" });

  process.env.TOREN_TEST_REGION = "us";
  const reloaded = await loadAgentDir(dir);
  expect(reloaded.agents.main!.env!.TOREN_TEST_REGION).toBe("us"); // env beats default
});

test("agents without an env block get an empty declared env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "toren-env-"));
  writeFileSync(join(dir, "agent.yaml"), "name: bare\nmodel: mock/echo\n");
  writeFileSync(join(dir, "instructions.md"), "x\n");
  const loaded = await loadAgentDir(dir);
  expect(loaded.agents.main!.env).toEqual({});
});
