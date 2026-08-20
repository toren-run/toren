import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { createPool, tx } from "../src/db.js";
import { migrateControl, provisionAgent } from "../src/migrate.js";
import { PgBlobs } from "../src/blobs.js";

const pool = createPool();
let blobs: PgBlobs;

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); await provisionAgent(c, "btest"); });
  blobs = new PgBlobs(pool, "agent_btest");
});
afterAll(async () => { await pool.end(); });

test("put then get round-trips bytes; put is idempotent per key", async () => {
  const runId = randomUUID();
  const data = Buffer.from("workspace-snapshot-bytes");
  const ref = await blobs.put(runId, "snapshots/wave-1.tar.zst", data);
  expect(ref).toEqual({ runId, key: "snapshots/wave-1.tar.zst" });
  await blobs.put(runId, "snapshots/wave-1.tar.zst", data); // idempotent overwrite, same content
  expect((await blobs.get(ref))!.equals(data)).toBe(true);
});

test("get of a missing blob returns null", async () => {
  expect(await blobs.get({ runId: randomUUID(), key: "nope" })).toBeNull();
});
