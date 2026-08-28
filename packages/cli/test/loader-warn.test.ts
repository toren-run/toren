import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentDir } from "../src/loader.js";

test("external + unkeyed + unapproved tool draws a load warning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "toren-warn-"));
  writeFileSync(join(dir, "agent.yaml"), "name: warntest\nmodel: mock/echo\n");
  mkdirSync(join(dir, "tools"));
  writeFileSync(join(dir, "tools", "fire.ts"), `
import { defineTool } from "@toren-run/core";
import { z } from "zod";
export default defineTool({
  name: "fire_webhook",
  description: "posts somewhere",
  input: z.object({ url: z.string() }),
  effects: "external",
  idempotency: "none",
  approval: "never",
  handler: async () => "ok",
});
`);
  const loaded = await loadAgentDir(dir);
  expect(loaded.warnings?.length).toBe(1);
  expect(loaded.warnings![0]).toContain("fire_webhook");
  expect(loaded.warnings![0]).toContain("twice");
});
