import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cmdRun, cmdScheduleCreate } from "../src/commands.js";

const silent = { out: () => {} };

function multiAgent(): string {
  const dir = mkdtempSync(join(tmpdir(), "toren-proc-e2e-"));
  writeFileSync(join(dir, "agent.yaml"), "name: procdemo\nmodel: mock/echo\n");
  writeFileSync(join(dir, "instructions.md"), "x\n");
  mkdirSync(join(dir, "workflows"));
  writeFileSync(join(dir, "workflows/daily-digest.ts"), 'export default async () => "ran daily";\n');
  writeFileSync(join(dir, "workflows/weekly-report.ts"), 'export default async () => "ran weekly";\n');
  return dir;
}

test("toren run --process executes the named workflow end to end", async () => {
  const dir = multiAgent();
  const res = await cmdRun(dir, { input: '"go"', process: "weekly-report" }, silent);
  expect(res.status).toBe("completed");
  expect((res as { output?: string }).output).toBe("ran weekly");
});

test("a wrong process name fails fast, listing what exists", async () => {
  const dir = multiAgent();
  await expect(cmdRun(dir, { input: '"go"', process: "nope" }, silent))
    .rejects.toThrow(/no process "nope" for procdemo/);
});

test("schedule create validates the process against the loaded agent", async () => {
  const dir = multiAgent();
  await expect(cmdScheduleCreate(dir, { cron: "0 9 * * 1", input: '"go"', process: "nope" }, silent))
    .rejects.toThrow(/has no process "nope"/);
});
