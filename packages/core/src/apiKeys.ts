import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";

/**
 * Deployment API keys. Secrets are shown once at
 * creation and stored only as SHA-256 hashes; verification is a hash lookup,
 * so the raw secret never touches a comparison the caller can time.
 */

export interface ApiKeyRecord {
  id: string;
  name: string;
  /** First characters of the secret, for display ("trn_ab12cd34…"). */
  prefix: string;
  createdAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

export interface CreatedApiKey extends ApiKeyRecord {
  /** The full secret — returned exactly once, never stored. */
  secret: string;
}

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

const rowToRecord = (r: Record<string, unknown>): ApiKeyRecord => ({
  id: String(r.id),
  name: String(r.name),
  prefix: String(r.prefix),
  createdAt: r.created_at as Date,
  revokedAt: (r.revoked_at as Date | null) ?? null,
  lastUsedAt: (r.last_used_at as Date | null) ?? null,
});

export async function createApiKey(pool: pg.Pool, name: string): Promise<CreatedApiKey> {
  if (!name.trim()) throw new Error("api key name must be non-empty");
  const secret = `trn_${randomBytes(20).toString("hex")}`;
  const prefix = secret.slice(0, 12);
  const id = randomUUID();
  const res = await pool.query(
    `INSERT INTO toren_control.api_keys (id, name, key_hash, prefix) VALUES ($1, $2, $3, $4)
     RETURNING id, name, prefix, created_at, revoked_at, last_used_at`,
    [id, name.trim(), hash(secret), prefix],
  );
  return { ...rowToRecord(res.rows[0]), secret };
}

/** Returns the key's identity if the secret matches an unrevoked key, else null. */
export async function verifyApiKey(pool: pg.Pool, secret: string): Promise<{ id: string; name: string } | null> {
  if (!secret) return null;
  const res = await pool.query(
    `UPDATE toren_control.api_keys SET last_used_at = now()
     WHERE key_hash = $1 AND revoked_at IS NULL
     RETURNING id, name`,
    [hash(secret)],
  );
  const row = res.rows[0];
  return row ? { id: String(row.id), name: String(row.name) } : null;
}

/** Revokes a key. Returns false if the key doesn't exist or was already revoked. */
export async function revokeApiKey(pool: pg.Pool, id: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE toren_control.api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function listApiKeys(pool: pg.Pool): Promise<ApiKeyRecord[]> {
  const res = await pool.query(
    `SELECT id, name, prefix, created_at, revoked_at, last_used_at
     FROM toren_control.api_keys ORDER BY created_at DESC`,
  );
  return res.rows.map(rowToRecord);
}
