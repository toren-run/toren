import { afterAll, beforeAll, expect, test } from "vitest";
import { createPool, tx } from "../src/db.js";
import { migrateControl } from "../src/migrate.js";
import { createApiKey, listApiKeys, revokeApiKey, verifyApiKey } from "../src/apiKeys.js";

const pool = createPool();

beforeAll(async () => {
  await tx(pool, async (c) => { await migrateControl(c); });
  await pool.query(`TRUNCATE toren_control.api_keys`);
});
afterAll(async () => { await pool.end(); });

test("create returns the secret once; record never contains it", async () => {
  const created = await createApiKey(pool, "console");
  expect(created.secret).toMatch(/^trn_[0-9a-f]{40}$/);
  expect(created.prefix).toBe(created.secret.slice(0, 12));
  expect(created.name).toBe("console");
  expect(created.revokedAt).toBeNull();

  const listed = await listApiKeys(pool);
  expect(listed.length).toBe(1);
  expect(JSON.stringify(listed)).not.toContain(created.secret.slice(12));
});

test("verify accepts the live secret, tracks last use, rejects garbage", async () => {
  const created = await createApiKey(pool, "worker");
  const hit = await verifyApiKey(pool, created.secret);
  expect(hit).toEqual({ id: created.id, name: "worker" });

  const after = (await listApiKeys(pool)).find((k) => k.id === created.id)!;
  expect(after.lastUsedAt).not.toBeNull();

  expect(await verifyApiKey(pool, "trn_" + "0".repeat(40))).toBeNull();
  expect(await verifyApiKey(pool, "")).toBeNull();
});

test("revoke kills the key exactly once; revoked keys stop verifying", async () => {
  const created = await createApiKey(pool, "old-ci");
  expect(await revokeApiKey(pool, created.id)).toBe(true);
  expect(await revokeApiKey(pool, created.id)).toBe(false);
  expect(await verifyApiKey(pool, created.secret)).toBeNull();

  const rec = (await listApiKeys(pool)).find((k) => k.id === created.id)!;
  expect(rec.revokedAt).not.toBeNull();
});

test("empty names are rejected", async () => {
  await expect(createApiKey(pool, "  ")).rejects.toThrow(/non-empty/);
});
