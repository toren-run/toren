#!/usr/bin/env node
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { main } = await jiti.import("../src/main.ts");
try {
  await main(process.argv);
} catch (err) {
  console.error(`toren: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
