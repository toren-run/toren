import { afterAll, beforeAll, expect, test } from "vitest";
import { createPool, tx, migrateControl } from "@toren-run/core";
import { WorkerRegistry } from "../src/worker-registry.js";

const pool = createPool();

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); });
  await pool.query("TRUNCATE toren_control.workers");
});

afterAll(async () => {
  await pool.end();
});

test("one version live: no skew, worker visible in status", async () => {
  const lines: string[] = [];
  const a = new WorkerRegistry(pool, "0.2.0", (l) => lines.push(l));
  const b = new WorkerRegistry(pool, "0.2.0", (l) => lines.push(l));
  await a.tick();
  await b.tick();
  await a.tick();
  const st = a.status();
  expect(st.versionSkew).toBe(false);
  expect(st.liveVersions).toEqual(["0.2.0"]);
  expect(st.liveWorkers.length).toBe(2);
  expect(lines).toEqual([]);
  await a.stop(); await b.stop();
});

test("two versions live: skew detected, logged on transition, cleared when the old worker leaves", async () => {
  const lines: string[] = [];
  const neu = new WorkerRegistry(pool, "0.2.1", (l) => lines.push(l));
  const old = new WorkerRegistry(pool, "0.2.0", (l) => lines.push(l));
  await old.tick();
  await neu.tick();
  expect(neu.status().versionSkew).toBe(true);
  expect(neu.status().liveVersions).toEqual(["0.2.0", "0.2.1"]);
  expect(lines.filter((l) => l.includes("version skew")).length).toBe(1);

  // repeated ticks inside the remind window do not re-log
  await neu.tick();
  await neu.tick();
  expect(lines.filter((l) => l.includes("version skew")).length).toBe(1);

  // the old worker signs out (clean shutdown) — skew clears and says so
  await old.stop();
  await neu.tick();
  expect(neu.status().versionSkew).toBe(false);
  expect(lines.some((l) => l.includes("skew cleared"))).toBe(true);
  await neu.stop();
});

test("a worker that stops signing in falls out of the live window", async () => {
  const w = new WorkerRegistry(pool, "0.2.2", () => {});
  await w.tick();
  // simulate a crashed worker: its row exists but last_seen_at is old
  await pool.query("UPDATE toren_control.workers SET last_seen_at = now() - interval '2 minutes' WHERE worker_id = $1", [w.workerId]);
  const observer = new WorkerRegistry(pool, "0.2.2", () => {});
  await observer.tick();
  expect(observer.status().liveWorkers.map((x) => x.workerId)).not.toContain(w.workerId);
  await w.stop(); await observer.stop();
});
