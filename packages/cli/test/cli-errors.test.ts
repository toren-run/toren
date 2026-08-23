import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

test("an unreachable database produces an actionable error, never a blank one", () => {
  let stderr = "";
  try {
    execFileSync("node", ["packages/cli/bin/toren.js", "jobs", "list", "--dir", "examples/research-crew"], {
      cwd: root, stdio: "pipe", timeout: 30_000,
      env: { ...process.env, DATABASE_URL: "postgres://toren:toren@localhost:59999/toren" },
    });
    throw new Error("expected the command to fail");
  } catch (e) {
    stderr = String((e as { stderr?: Buffer }).stderr ?? "");
  }
  expect(stderr).toMatch(/cannot reach Postgres/);
  expect(stderr).toMatch(/docker compose up -d db/);
  expect(stderr).toMatch(/DATABASE_URL/);
});

test("preflight targets only the provider prefixes agents actually use; mock never counts", async () => {
  const { usedProviderPrefixes } = await import("../src/runtime.js");
  expect(usedProviderPrefixes({ a: { model: "mock/echo" }, b: { model: "mock/slow" } })).toEqual([]);
  expect(usedProviderPrefixes({ a: { model: "mock/echo" }, b: { model: "anthropic/claude-opus-5" }, c: { model: "openai/gpt-4o" } }).sort())
    .toEqual(["anthropic", "openai"]);
});
