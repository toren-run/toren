import { build } from "esbuild";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";

mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/app.jsx"],
  bundle: true,
  minify: true,
  format: "esm",
  jsx: "automatic",
  jsxImportSource: "preact",
  outfile: "dist/app.js",
});

cpSync("src/index.html", "dist/index.html");
cpSync("src/app.css", "dist/app.css");

// Tiny runtime entry so the CLI can locate the static files:
//   const { distDir } = await import("@toren/console")
writeFileSync(
  "dist/serve.js",
  `import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
export const distDir = dirname(fileURLToPath(import.meta.url));
`,
);
console.log("console built -> dist/");
