import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cmdRun } from "../src/commands.js";

function hasDocker(): boolean {
  try {
    execFileSync("docker", ["version", "--format", "ok"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasDocker())("named processes × sandbox (lazy mount)", () => {
  const prior = process.env.TOREN_SANDBOX;
  beforeAll(() => { process.env.TOREN_SANDBOX = "docker"; });
  afterAll(() => {
    if (prior === undefined) delete process.env.TOREN_SANDBOX;
    else process.env.TOREN_SANDBOX = prior;
  });

  // The positive half (a process whose tasks call bash gets a workspace) is
  // bash-sandbox.test.ts; this pins the negative: same agent, no config change,
  // a process that never touches the sandbox costs no container.
  test("a process that never touches the sandbox spins no container", async () => {
    const dir = mkdtempSync(join(tmpdir(), "toren-proc-sbx-"));
    writeFileSync(join(dir, "agent.yaml"), "name: procsbx\nmodel: mock/echo\nsandbox: true\n");
    writeFileSync(join(dir, "instructions.md"), "x\n");
    mkdirSync(join(dir, "workflows"));
    writeFileSync(join(dir, "workflows/daily-digest.ts"), 'export default async () => "no computer needed";\n');
    writeFileSync(join(dir, "workflows/weekly-report.ts"), 'export default async (ctx) => { const w = await ctx.wave("main", [ctx.task("main", ctx.input)]); return w.results[0]?.output ?? ""; };\n');

    const res = await cmdRun(dir, { input: '"go"', process: "daily-digest" }, { out: () => {} });
    expect(res.status).toBe("completed");
    expect((res as { output?: string }).output).toBe("no computer needed");
    const ps = execFileSync("docker", ["ps", "-a", "--filter", `name=toren-sbx-${res.runId}`, "--format", "{{.Names}}"]).toString().trim();
    expect(ps).toBe("");
  });
});
