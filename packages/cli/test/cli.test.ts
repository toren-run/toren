import { afterAll, beforeAll, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createPool } from "@toren/core";
import { loadAgentDir } from "../src/loader.js";
import { cmdInit, cmdJobsList, cmdRun, type CmdIO } from "../src/commands.js";

const EXAMPLE = resolve(__dirname, "../../../examples/research-crew");
const pool = createPool();

function captureIO(): { io: CmdIO; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l) => lines.push(l) }, lines };
}

beforeAll(async () => {
  await pool.query(`TRUNCATE toren_control.queue_messages, toren_control.dead_letters`);
  await pool.query(`DROP SCHEMA IF EXISTS agent_research_crew CASCADE`);
});
afterAll(async () => { await pool.end(); });

test("loadAgentDir loads the example agent", async () => {
  const loaded = await loadAgentDir(EXAMPLE);
  expect(loaded.name).toBe("research_crew");
  expect(Object.keys(loaded.agents).sort()).toEqual(["main", "researcher", "writer"]);
  expect(loaded.agents.main!.tools.map((t) => t.name)).toEqual(["search_web"]);
  expect(loaded.agents.main!.system).toContain("research-crew");
  expect(typeof loaded.workflows.research_crew).toBe("function");
});

test("toren run drives the example agent offline to completion", async () => {
  const { io, lines } = captureIO();
  const settled = await cmdRun(EXAMPLE, { input: JSON.stringify(["solar", "freight"]) }, io);
  expect(settled.status).toBe("completed");
  if (settled.status === "completed") {
    expect(settled.output).toBe("echo(echo(solar) | echo(freight))");
  }
  expect(lines.some((l) => l.includes("completed"))).toBe(true);

  const list = captureIO();
  await cmdJobsList(EXAMPLE, {}, list.io);
  expect(list.lines.some((l) => l.includes(settled.runId) && l.includes("completed"))).toBe(true);
});

test("toren init scaffolds the template", async () => {
  const parent = mkdtempSync(join(tmpdir(), "toren-init-"));
  const prev = process.cwd();
  process.chdir(parent);
  try {
    const { io } = captureIO();
    const dir = await cmdInit("my-agent", io);
    for (const f of ["agent.yaml", "instructions.md", "workflow.ts", "tools/search-web.ts", "subagents/researcher/agent.yaml", "subagents/writer/agent.yaml"]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toContain("mock/echo");
  } finally {
    process.chdir(prev);
  }
});
