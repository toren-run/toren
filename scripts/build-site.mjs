// Assemble the deployable toren.run bundle: landing page + built docs + the
// llms.txt corpus + the themed 404. Run `pnpm docs:build` first (or let this
// script do it). Deploy the output dir with `vercel deploy --prod`.
// Usage: node scripts/build-site.mjs <outDir> [--skip-docs-build]
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [outDir, flag] = process.argv.slice(2);
if (!outDir) { console.error("usage: build-site.mjs <outDir> [--skip-docs-build]"); process.exit(1); }

if (flag !== "--skip-docs-build") {
  execSync("pnpm docs:build", { cwd: root, stdio: "inherit" });
}

const dist = join(root, "docs/.vitepress/dist");
if (!existsSync(dist)) { console.error(`no docs build at ${dist} — run pnpm docs:build`); process.exit(1); }

// Preserve the Vercel project link across rebuilds: without it, a deploy
// from this directory silently creates a brand-new project.
const linkDir = join(outDir, ".vercel");
const savedLink = existsSync(linkDir) ? join(outDir, "..", ".vercel-link-backup") : null;
if (savedLink) { rmSync(savedLink, { recursive: true, force: true }); cpSync(linkDir, savedLink, { recursive: true }); }
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, "docs"), { recursive: true });
if (savedLink) { cpSync(savedLink, linkDir, { recursive: true }); rmSync(savedLink, { recursive: true, force: true }); }
cpSync(join(root, "site"), outDir, { recursive: true });
cpSync(dist, join(outDir, "docs"), { recursive: true });
// The themed 404 at the bundle root: Vercel serves /404.html for any miss;
// its asset urls are absolute under /docs/, so it renders fine from the root.
cpSync(join(dist, "404.html"), join(outDir, "404.html"));
execSync(`node ${join(root, "scripts/gen-llms.mjs")} ${join(root, "docs")} ${outDir}`, { stdio: "inherit" });
console.log(`site bundle ready at ${outDir}`);
