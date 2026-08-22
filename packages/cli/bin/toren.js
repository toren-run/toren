#!/usr/bin/env node
// In-repo checkouts (src present) always run the TypeScript source via jiti —
// a stale dist must never shadow fresh source. Published installs ship dist
// only, so they take the compiled path.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

let main;
if (existsSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)))) {
  const { createJiti } = await import("jiti");
  ({ main } = await createJiti(import.meta.url).import("../src/main.ts"));
} else {
  ({ main } = await import("../dist/main.js"));
}
// pg wraps connection failures in an AggregateError whose own message is
// empty; unwrap it so the most common first-run failure names its fix.
function describe(err) {
  const first = err instanceof AggregateError && err.errors.length > 0 ? err.errors[0] : (err?.cause ?? err);
  const code = first?.code ?? err?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT") {
    return `cannot reach Postgres (${code}). Start the local database with "docker compose up -d db", or point DATABASE_URL at yours (default: postgres://toren:toren@localhost:5433/toren).`;
  }
  const msg = (first instanceof Error ? first.message : "") || (err instanceof Error ? err.message : String(err));
  return msg || `unexpected ${err?.constructor?.name ?? "error"}${code ? ` (${code})` : ""}`;
}

try {
  await main(process.argv);
} catch (err) {
  console.error(`toren: ${describe(err)}`);
  process.exit(1);
}
