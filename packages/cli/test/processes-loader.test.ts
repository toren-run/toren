import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadAgentDir } from "../src/loader.js";

function agentDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "toren-proc-"));
  writeFileSync(join(dir, "agent.yaml"), files["agent.yaml"] ?? "name: proc\nmodel: mock/echo\n");
  writeFileSync(join(dir, "instructions.md"), "x\n");
  for (const [rel, content] of Object.entries(files)) {
    if (rel === "agent.yaml") continue;
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}
const wf = (out: string) => `export default async () => ${JSON.stringify(out)};\n`;

test("workflows/ directory: one file per process, filename is the name", async () => {
  const dir = agentDir({ "workflows/daily-digest.ts": wf("d"), "workflows/weekly-report.ts": wf("w") });
  const loaded = await loadAgentDir(dir);
  expect(Object.keys(loaded.workflows).sort()).toEqual(["daily-digest", "weekly-report"]);
  expect(loaded.defaultProcess).toBeUndefined(); // two processes, none named main, none declared
});

test("default_process picks the default and must exist", async () => {
  const yaml = "name: proc\nmodel: mock/echo\ndefault_process: weekly-report\n";
  const dir = agentDir({ "agent.yaml": yaml, "workflows/daily-digest.ts": wf("d"), "workflows/weekly-report.ts": wf("w") });
  expect((await loadAgentDir(dir)).defaultProcess).toBe("weekly-report");

  const bad = agentDir({ "agent.yaml": "name: proc\nmodel: mock/echo\ndefault_process: nope\n", "workflows/daily-digest.ts": wf("d") });
  await expect(loadAgentDir(bad)).rejects.toThrow(/default_process "nope"/);
});

test("a lone workflow.ts is the single process main; none at all is an implicit main", async () => {
  const one = await loadAgentDir(agentDir({ "workflow.ts": wf("solo") }));
  expect(Object.keys(one.workflows)).toEqual(["main"]);
  expect(one.defaultProcess).toBe("main");

  const none = await loadAgentDir(agentDir({}));
  expect(Object.keys(none.workflows)).toEqual(["main"]);
  expect(none.defaultProcess).toBe("main");
});

test("a sole named process is the default even without main", async () => {
  const loaded = await loadAgentDir(agentDir({ "workflows/daily-digest.ts": wf("d") }));
  expect(loaded.defaultProcess).toBe("daily-digest");
});

test("workflow.ts alongside workflows/ is rejected", async () => {
  const dir = agentDir({ "workflow.ts": wf("a"), "workflows/daily-digest.ts": wf("d") });
  await expect(loadAgentDir(dir)).rejects.toThrow(/both workflow.ts and workflows\//);
});

test("invalid process filenames are rejected", async () => {
  const dir = agentDir({ "workflows/Daily Digest.ts": wf("d") });
  await expect(loadAgentDir(dir)).rejects.toThrow(/not a valid process name/);
});

test("run_process's description gains the agent's actual processes; the shared builtin stays untouched", async () => {
  const yaml = "name: proc\nmodel: mock/echo\nbuiltin_tools: [run_process, check_run]\ndefault_process: daily-digest\n";
  const dir = agentDir({ "agent.yaml": yaml, "workflows/daily-digest.ts": wf("d"), "workflows/weekly-report.ts": wf("w") });
  const loaded = await loadAgentDir(dir);
  const tool = loaded.agents.main!.tools.find((t) => t.name === "run_process")!;
  expect(tool.description).toContain("Available processes: daily-digest, weekly-report (default: daily-digest)");

  const { BUILTIN_TOOLS } = await import("@toren-run/core");
  expect(BUILTIN_TOOLS.run_process!.description).not.toContain("Available processes");
});
