import { afterAll, beforeAll, expect, test } from "vitest";
import { createPool, tx, migrateControl, provisionAgent, PgStateStore, type TickDeps } from "@toren-run/core";
import { sweepSandboxes } from "../src/sandbox-reaper.js";

const pool = createPool();
const SCHEMA = "agent_reaptest";

const DONE = "00000000-0000-4000-b000-00000000d0de";
const LIVE = "00000000-0000-4000-b000-000000001i7e".replace("i", "1");
const GONE_OLD = "00000000-0000-4000-b000-00000000901d";
const GONE_NEW = "00000000-0000-4000-b000-000000009new".replace("new", "e33");

let deps: TickDeps;

/** Fake docker CLI: a mutable container set, recorded removals. */
function fakeDocker(containers: Map<string, string>) {
  const removed: string[] = [];
  const docker = async (args: string[]): Promise<string> => {
    if (args[0] === "ps") return [...containers.keys()].join("\n");
    if (args[0] === "inspect") return containers.get(args.at(-1)!) ?? (() => { throw new Error("no such container"); })();
    if (args[0] === "rm") { removed.push(args.at(-1)!); containers.delete(args.at(-1)!); return ""; }
    throw new Error(`unexpected docker ${args[0]}`);
  };
  return { docker, removed };
}

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "reaptest"); });
  await pool.query(`TRUNCATE ${SCHEMA}.events, ${SCHEMA}.streams, ${SCHEMA}.leases, ${SCHEMA}.blobs, ${SCHEMA}.runs CASCADE`);
  await pool.query("DELETE FROM toren_control.sandboxes");
  const store = new PgStateStore(pool, SCHEMA);
  deps = { store } as TickDeps;
  await store.createRun({ runId: DONE, agent: "reaptest", input: "x" });
  await store.updateRun(DONE, { status: "completed" });
  await store.createRun({ runId: LIVE, agent: "reaptest", input: "x" });
  await store.updateRun(LIVE, { status: "running" });
});

afterAll(async () => {
  await pool.end();
});

test("reaps terminal and aged-unknown containers, spares live and fresh-unknown ones", async () => {
  const old = new Date(Date.now() - 48 * 3600_000).toISOString();
  const fresh = new Date().toISOString();
  const containers = new Map<string, string>([
    [`toren-sbx-${DONE}`, fresh],      // run completed → reap regardless of age
    [`toren-sbx-${LIVE}`, old],        // run live → never
    [`toren-sbx-${GONE_OLD}`, old],    // unknown run, 48h old → reap
    [`toren-sbx-${GONE_NEW}`, fresh],  // unknown run, fresh → maybe another deployment's — spare
  ]);
  const { docker, removed } = fakeDocker(containers);
  const lines: string[] = [];
  await sweepSandboxes(pool, { reaptest: deps }, { docker, log: (l) => lines.push(l) });

  expect(removed.sort()).toEqual([`toren-sbx-${DONE}`, `toren-sbx-${GONE_OLD}`].sort());
  expect(containers.has(`toren-sbx-${LIVE}`)).toBe(true);
  expect(containers.has(`toren-sbx-${GONE_NEW}`)).toBe(true);
  expect(lines.length).toBe(2);
});

test("docker being absent is silent and e2b rows for finished runs are cleared", async () => {
  await pool.query(
    "INSERT INTO toren_control.sandboxes (run_id, provider, sandbox_id) VALUES ($1, 'e2b', 'sb1'), ($2, 'e2b', 'sb2') ON CONFLICT (run_id) DO NOTHING",
    [DONE, LIVE],
  );
  const noDocker = async () => { throw new Error("docker: command not found"); };
  await sweepSandboxes(pool, { reaptest: deps }, { docker: noDocker });

  const { rows } = await pool.query("SELECT run_id FROM toren_control.sandboxes WHERE provider = 'e2b' ORDER BY run_id");
  expect(rows.map((r: { run_id: string }) => r.run_id)).toEqual([LIVE]);
});
