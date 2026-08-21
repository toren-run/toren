import { createHash } from "node:crypto";
import type pg from "pg";

/**
 * Deployment-wide file store: raw bytes plus parsed text, keyed by content
 * hash. Parsing happens once at upload; agents read the parsed pages through
 * the read_file builtin, and every read is recorded with keyed idempotency,
 * so replay never re-reads and a 200-page document never floods a context
 * window — the agent pages through it.
 */

export interface StoredFile {
  id: string;
  name: string;
  mediaType: string;
  bytes: number;
  pages: string[];
}

export class PgFiles {
  constructor(private pool: pg.Pool) {}

  async put(file: { name: string; mediaType: string; data: Buffer; pages: string[] }): Promise<StoredFile> {
    const id = createHash("sha256").update(file.data).digest("hex").slice(0, 16);
    await this.pool.query(
      `INSERT INTO toren_control.files (id, name, media_type, bytes, pages, data)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [id, file.name, file.mediaType, file.data.length, JSON.stringify(file.pages), file.data],
    );
    return { id, name: file.name, mediaType: file.mediaType, bytes: file.data.length, pages: file.pages };
  }

  async get(id: string): Promise<StoredFile | null> {
    const r = await this.pool.query(
      `SELECT id, name, media_type, bytes, pages FROM toren_control.files WHERE id = $1`,
      [id],
    );
    const row = r.rows[0];
    if (!row) return null;
    return { id: row.id, name: row.name, mediaType: row.media_type, bytes: row.bytes, pages: row.pages };
  }
}

/** The manifest line appended to a run input or session message for each attachment. */
export function fileManifest(files: StoredFile[]): string {
  if (files.length === 0) return "";
  const lines = files.map((f) => `- ${f.name} (file_id: ${f.id}, ${f.pages.length} page${f.pages.length === 1 ? "" : "s"})`);
  return `\n\n[Attached files:\n${lines.join("\n")}\nRead them with the read_file tool.]`;
}
