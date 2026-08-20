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
try {
  await main(process.argv);
} catch (err) {
  console.error(`toren: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
