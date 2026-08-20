#!/usr/bin/env node
// Published installs run the compiled dist; in-repo (no dist) falls back to
// loading the TypeScript source through jiti.
let main;
try {
  ({ main } = await import("../dist/main.js"));
} catch (err) {
  if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
  const { createJiti } = await import("jiti");
  ({ main } = await createJiti(import.meta.url).import("../src/main.ts"));
}
try {
  await main(process.argv);
} catch (err) {
  console.error(`toren: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
