import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type pg from "pg";
import {
  createPool, tx, migrateControl, provisionAgent,
  PgStateStore, BUILTIN_TOOLS, runTaskLoop,
  type AgentSpec, type ModelProvider, type ModelRequest, type ModelResponse, type SandboxExec,
} from "@toren-run/core";
import { DockerSandboxProvider } from "../src/sandbox.js";

function hasDocker(): boolean {
  try {
    execFileSync("docker", ["version", "--format", "ok"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const pool = createPool();
const SCHEMA = "agent_sbxtest";
let store: PgStateStore;
const ROOT = mkdtempSync(join(tmpdir(), "toren-sbx-test-"));
const startedRuns: string[] = [];

// bash with approval relaxed, as sandbox.approval: never would produce.
const bashNever = { ...BUILTIN_TOOLS.bash!, approval: "never" as const };
const agent: AgentSpec = { model: "mock/m", system: "s", tools: [bashNever], maxTokens: 300, maxSteps: 10 };

/** Scripted: write a file, read it back, then answer with the read result. */
class BashFlow implements ModelProvider {
  private n = 0;
  async complete(req: ModelRequest): Promise<ModelResponse> {
    const usage = { inputTokens: 1, outputTokens: 1 };
    this.n += 1;
    if (this.n === 1) {
      return { content: [{ type: "toolUse", id: "b1", name: "bash", input: { command: "echo durable disk > note.txt" } }], stopReason: "toolUse", usage };
    }
    if (this.n === 2) {
      return { content: [{ type: "toolUse", id: "b2", name: "bash", input: { command: "cat note.txt" } }], stopReason: "toolUse", usage };
    }
    const last = req.messages.at(-1)!;
    const tr = last.content.find((b) => b.type === "toolResult");
    const parsed = tr && tr.type === "toolResult" ? JSON.parse(String(tr.content)) : {};
    return { content: [{ type: "text", text: `file says: ${String(parsed.stdout ?? "").trim()}` }], stopReason: "endTurn", usage };
  }
}

class ThrowingSandbox implements SandboxExec {
  async exec(): Promise<never> { throw new Error("replay must never touch the sandbox"); }
  async readFile(): Promise<never> { throw new Error("replay must never touch the sandbox"); }
  async writeFile(): Promise<never> { throw new Error("replay must never touch the sandbox"); }
}
class ThrowingProvider implements ModelProvider {
  async complete(): Promise<never> { throw new Error("replay must never call the model"); }
}

let seq = 0;
async function freshRun(): Promise<string> {
  const runId = `00000000-0000-4000-b000-${String(++seq).padStart(12, "0")}`;
  await store.createRun({ runId, agent: "sbxtest", input: "go" });
  startedRuns.push(runId);
  return runId;
}

describe.skipIf(!hasDocker())("bash sandbox (docker)", () => {
  beforeAll(async () => {
    await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "sbxtest"); });
    await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.blobs, ${SCHEMA}.runs CASCADE`);
    store = new PgStateStore(pool, SCHEMA);
  });

  afterAll(async () => {
    for (const runId of startedRuns) {
      execFileSync("docker", ["rm", "-f", `toren-sbx-${runId}`], { stdio: "pipe" }).toString();
    }
    await pool.end();
  }, 60_000);

  test("commands run in a persistent workspace; files survive between calls", { timeout: 120_000 }, async () => {
    const runId = await freshRun();
    const provider = new DockerSandboxProvider({}, ROOT);
    const r = await runTaskLoop({ store, provider: new BashFlow(), runId, taskId: "t1", agent, input: "go", sandbox: provider.forRun(runId) });
    expect(r.status).toBe("completed");
    expect(r.status === "completed" && r.output).toBe("file says: durable disk");
  });

  test("replay is pure: neither the model nor the sandbox is touched", { timeout: 120_000 }, async () => {
    const runId = await freshRun();
    const provider = new DockerSandboxProvider({}, ROOT);
    expect((await runTaskLoop({ store, provider: new BashFlow(), runId, taskId: "t1", agent, input: "go", sandbox: provider.forRun(runId) })).status).toBe("completed");

    const replayed = await runTaskLoop({ store, provider: new ThrowingProvider(), runId, taskId: "t1", agent, input: "go", sandbox: new ThrowingSandbox() });
    expect(replayed.status).toBe("completed");
    expect(replayed.status === "completed" && replayed.output).toBe("file says: durable disk");
  });

  test("network is off by default; granted env reaches the sandbox", { timeout: 120_000 }, async () => {
    const runId = await freshRun();
    const provider = new DockerSandboxProvider({ env: { GRANTED_TOKEN: "s3cret-grant" } }, ROOT);
    const sbx = provider.forRun(runId);

    const env = await sbx.exec("echo $GRANTED_TOKEN; echo $AWS_CONTAINER_CREDENTIALS_RELATIVE_URI");
    expect(env.stdout).toContain("s3cret-grant");
    expect(env.stdout.trim().split("\n").length).toBe(1); // no AWS credential pointer

    const net = await sbx.exec("timeout 3 bash -lc 'echo x > /dev/tcp/1.1.1.1/443' 2>&1; echo rc=$?");
    expect(net.stdout).toContain("rc=1");
  });

  test("timeouts kill the command inside the container", { timeout: 120_000 }, async () => {
    const runId = await freshRun();
    const provider = new DockerSandboxProvider({}, ROOT);
    const r = await provider.forRun(runId).exec("sleep 30", { timeoutMs: 2_000 });
    expect(r.exitCode).toBe(124);
    expect(r.stderr).toContain("timed out");
  });

  test("kill matrix: crash after every write; the file work happens exactly once", { timeout: 300_000 }, async () => {
    class CrashingStore extends PgStateStore {
      public appends = 0;
      constructor(p: pg.Pool, schema: string, private crashAfter = Number.POSITIVE_INFINITY) { super(p, schema); }
      override async append(...a: Parameters<PgStateStore["append"]>): ReturnType<PgStateStore["append"]> {
        const r = await super.append(...a);
        if (r.ok && ++this.appends >= this.crashAfter) throw new Error("SimulatedCrash");
        return r;
      }
    }

    // Baseline append count.
    const base = await freshRun();
    const baseStore = new CrashingStore(pool, SCHEMA);
    const baseProvider = new DockerSandboxProvider({}, ROOT);
    await runTaskLoop({ store: baseStore, provider: new BashFlow(), runId: base, taskId: "t1", agent, input: "go", sandbox: baseProvider.forRun(base) });
    const N = baseStore.appends;
    expect(N).toBeGreaterThanOrEqual(8);

    for (let k = 1; k <= N; k++) {
      const runId = await freshRun();
      const provider = new BashFlow();
      const sbxProvider = new DockerSandboxProvider({}, ROOT);
      try {
        await runTaskLoop({ store: new CrashingStore(pool, SCHEMA, k), provider, runId, taskId: "t1", agent, input: "go", sandbox: sbxProvider.forRun(runId) });
      } catch { /* crashed mid-task; recover below */ }
      const r = await runTaskLoop({ store, provider, runId, taskId: "t1", agent, input: "go", sandbox: sbxProvider.forRun(runId) });
      expect(r.status, `kill point ${k}/${N}`).toBe("completed");
      expect(r.status === "completed" && r.output, `kill point ${k}/${N}`).toBe("file says: durable disk");
      // The append-only write ran at most once outside the documented
      // one-command at-least-once window: note.txt has exactly one line.
      const sbx = sbxProvider.forRun(runId);
      const wc = await sbx.exec("wc -l < note.txt");
      expect(Number(wc.stdout.trim()), `kill point ${k}/${N}`).toBe(1);
    }
  });
});

describe.skipIf(hasDocker())("bash sandbox (no docker on this machine)", () => {
  test("suite skipped", () => { expect(true).toBe(true); });
});

describe.skipIf(!hasDocker())("workspace file tools", () => {
  test("write, read with line numbers, exact-string edit", { timeout: 60_000 }, async () => {
    const { SANDBOX_TOOLKIT } = await import("@toren-run/core");
    const byName = Object.fromEntries(SANDBOX_TOOLKIT.map((t) => [t.name, t]));
    const provider = new DockerSandboxProvider({}, ROOT);
    const runId = `00000000-0000-4000-b000-${String(900 + seq++).padStart(12, "0")}`;
    startedRuns.push(runId);
    const ctx = { runId, taskId: "t", env: {}, sandbox: provider.forRun(runId) };

    await byName.write_file!.handler({ path: "src/app.ts", content: "const a = 1;\nconst b = 2;\n" }, ctx);
    const read = JSON.parse(await byName.read_file!.handler({ path: "src/app.ts", offset: 1, limit: 10 }, ctx));
    expect(read.text).toContain("1\tconst a = 1;");

    const edit = JSON.parse(await byName.edit_file!.handler({ path: "src/app.ts", old_string: "const b = 2;", new_string: "const b = 42;", replace_all: false }, ctx));
    expect(edit.replacements).toBe(1);

    // The edit is visible to bash inside the container: one shared workspace.
    const sbx = provider.forRun(runId);
    const cat = await sbx.exec("cat src/app.ts");
    expect(cat.stdout).toContain("const b = 42;");

    // Escapes are refused.
    await expect(byName.read_file!.handler({ path: "../outside.txt", offset: 1, limit: 10 }, ctx)).rejects.toThrow(/escapes/);
  });
});
