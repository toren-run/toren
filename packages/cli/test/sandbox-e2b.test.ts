import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createPool, tx, migrateControl, provisionAgent,
  BUILTIN_TOOLS, runTaskLoop,
  PgStateStore,
  type AgentSpec, type ModelProvider, type ModelRequest, type ModelResponse,
} from "@toren-run/core";
import { E2BSandboxProvider } from "../src/sandbox-e2b.js";

const KEY = process.env.E2B_API_KEY;
const pool = createPool();
const SCHEMA = "agent_e2btest";
let store: PgStateStore;
const created: string[] = [];

const bashNever = { ...BUILTIN_TOOLS.bash!, approval: "never" as const };
const agent: AgentSpec = { model: "mock/m", system: "s", tools: [bashNever], maxTokens: 300, maxSteps: 10 };

/** Write a file with bash, read it back, answer with its contents. */
class BashFlow implements ModelProvider {
  private n = 0;
  async complete(req: ModelRequest): Promise<ModelResponse> {
    const usage = { inputTokens: 1, outputTokens: 1 };
    this.n += 1;
    if (this.n === 1) return { content: [{ type: "toolUse", id: "b1", name: "bash", input: { command: "echo cloud-durable > note.txt" } }], stopReason: "toolUse", usage };
    if (this.n === 2) return { content: [{ type: "toolUse", id: "b2", name: "bash", input: { command: "cat note.txt" } }], stopReason: "toolUse", usage };
    const tr = req.messages.at(-1)!.content.find((b) => b.type === "toolResult");
    const parsed = tr && tr.type === "toolResult" ? JSON.parse(String(tr.content)) : {};
    return { content: [{ type: "text", text: `file says: ${String(parsed.stdout ?? "").trim()}` }], stopReason: "endTurn", usage };
  }
}

let seq = 0;
async function freshRun(): Promise<string> {
  const runId = `00000000-0000-4000-c000-${String(++seq).padStart(12, "0")}`;
  await store.createRun({ runId, agent: "e2btest", input: "go" });
  return runId;
}

describe.skipIf(!KEY)("E2B sandbox backend (needs E2B_API_KEY)", () => {
  beforeAll(async () => {
    await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "e2btest"); });
    await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.blobs, ${SCHEMA}.runs CASCADE`);
    await pool.query("DELETE FROM toren_control.sandboxes WHERE provider = 'e2b'");
    store = new PgStateStore(pool, SCHEMA);
  });

  afterAll(async () => {
    // Best-effort: kill any sandboxes this suite created.
    for (const runId of created) {
      const p = new E2BSandboxProvider(pool, { apiKey: KEY! }).forRun(runId);
      await p.dispose?.().catch(() => {});
    }
    await pool.end();
  }, 120_000);

  test("bash runs in an E2B sandbox and the workspace persists across calls", { timeout: 120_000 }, async () => {
    const runId = await freshRun(); created.push(runId);
    const provider = new E2BSandboxProvider(pool, { apiKey: KEY! });
    const r = await runTaskLoop({ store, provider: new BashFlow(), runId, taskId: "t1", agent, input: "go", sandbox: provider.forRun(runId) });
    expect(r.status).toBe("completed");
    expect(r.status === "completed" && r.output).toBe("file says: cloud-durable");
    // The sandbox id was recorded durably.
    const { rows } = await pool.query("SELECT sandbox_id FROM toren_control.sandboxes WHERE run_id = $1", [runId]);
    expect(rows[0]?.sandbox_id).toBeTruthy();
  });

  test("worker handoff: a fresh provider reconnects by recorded id and sees the same disk", { timeout: 120_000 }, async () => {
    const runId = await freshRun(); created.push(runId);
    // Worker A: create sandbox, write a file, pause it (park).
    const provA = new E2BSandboxProvider(pool, { apiKey: KEY! }).forRun(runId);
    await provA.writeFile("handoff.txt", "written by worker A");
    await provA.exec("echo 'and by bash' >> handoff.txt");
    await provA.pause?.();

    // Worker B (simulated): brand-new provider, same runId. It must reconnect
    // to the SAME sandbox via the recorded id, not create a second one.
    const provB = new E2BSandboxProvider(pool, { apiKey: KEY! }).forRun(runId);
    const seen = await provB.readFile("handoff.txt");
    expect(seen).toContain("written by worker A");
    expect(seen).toContain("and by bash");

    // Exactly one sandbox id recorded for this run — no divergent second sandbox.
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM toren_control.sandboxes WHERE run_id = $1", [runId]);
    expect(rows[0].n).toBe(1);
  });

  test("path escapes are refused", { timeout: 60_000 }, async () => {
    const runId = await freshRun(); created.push(runId);
    const p = new E2BSandboxProvider(pool, { apiKey: KEY! }).forRun(runId);
    await expect(p.readFile("../../etc/passwd")).rejects.toThrow(/escapes|workspace-relative/);
  });
});

describe.skipIf(KEY)("E2B backend (no key on this machine)", () => {
  test("suite skipped", () => { expect(true).toBe(true); });
});
