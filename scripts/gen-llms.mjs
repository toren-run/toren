// Generate agent-readable docs: llms.txt (index), llms-full.txt (full corpus),
// and raw per-page .md, following the llms.txt convention (llmstxt.org).
// Usage: node scripts/gen-llms.mjs <docsDir> <outRoot>
//   writes <outRoot>/llms.txt, <outRoot>/llms-full.txt, and copies each page
//   to <outRoot>/docs/<path>.md so an agent can fetch clean markdown.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";

const [docsDir, outRoot] = process.argv.slice(2);
if (!docsDir || !outRoot) { console.error("usage: gen-llms.mjs <docsDir> <outRoot>"); process.exit(1); }

const SITE = "https://toren.run";
const IGNORE_DIRS = new Set([".vitepress", "public"]);

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name)) out.push(...walk(join(dir, e.name))); }
    else if (e.name.endsWith(".md")) out.push(join(dir, e.name));
  }
  return out;
}

/** VitePress cleanUrls: strip .md, README -> index (the docs root). */
function urlPath(relPath) {
  let p = relPath.replace(/\.md$/, "");
  if (p === "README" || p.endsWith("/README")) p = p.replace(/README$/, "").replace(/\/$/, "");
  return `/docs${p ? "/" + p : ""}`;
}

function titleAndBlurb(src) {
  const lines = src.split("\n");
  let title = "", blurb = "";
  for (const l of lines) {
    const t = l.trim();
    if (!title && t.startsWith("# ")) { title = t.slice(2).trim(); continue; }
    if (title && !blurb && t && !t.startsWith("#")) {
      blurb = t.replace(/^[*_]+|[*_]+$/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
      break;
    }
  }
  return { title, blurb };
}

const files = walk(docsDir).sort();
const pages = files.map((f) => {
  const rel = relative(docsDir, f);
  const src = readFileSync(f, "utf8");
  return { rel, src, url: urlPath(rel), ...titleAndBlurb(src) };
});

// Group pages by top-level section (dir name; root files under "Overview").
const SECTION = { "": "Overview", channels: "Channels", tools: "Tools", guides: "Guides", concepts: "Concepts", reference: "Reference", deploy: "Deploy" };
const ORDER = ["Overview", "Guides", "Channels", "Tools", "Deploy", "Concepts", "Reference"];
const groups = {};
for (const p of pages) {
  const top = p.rel.includes("/") ? p.rel.split("/")[0] : "";
  const g = SECTION[top] ?? top;
  (groups[g] ??= []).push(p);
}

// --- llms.txt: the index.
let index = `# Toren\n\n`;
index += `> The open-source runtime for long-running, durable AI agents in your own cloud. A resumed run never re-pays for a completed model call.\n\n`;
index += `Toren runs agents as durable, event-sourced processes on Postgres: work measured in hours and days that survives crashes, deploys, and kill -9. Agents can hold conversations (sessions), run autonomously (runs), call tools, and get a sandboxed computer. Deploy locally, on one box, or into your own AWS account.\n\n`;
for (const g of ORDER) {
  const list = groups[g];
  if (!list) continue;
  index += `## ${g}\n\n`;
  for (const p of list.sort((a, b) => a.url.localeCompare(b.url))) {
    if (!p.title) continue;
    index += `- [${p.title}](${SITE}${p.url}.md)${p.blurb ? `: ${p.blurb}` : ""}\n`;
  }
  index += `\n`;
}
mkdirSync(outRoot, { recursive: true });
writeFileSync(join(outRoot, "llms.txt"), index);

// --- llms-full.txt: every page inline, for one-fetch consumption.
let full = `# Toren documentation (full corpus)\n\n`;
for (const g of ORDER) {
  for (const p of (groups[g] ?? []).sort((a, b) => a.url.localeCompare(b.url))) {
    full += `\n\n---\n# ${SITE}${p.url}\n\n${p.src.trim()}\n`;
  }
}
writeFileSync(join(outRoot, "llms-full.txt"), full);

// --- raw per-page .md, mirrored under <outRoot>/docs/.
for (const p of pages) {
  const dest = join(outRoot, "docs", p.rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, p.src);
}

console.log(`llms.txt (${pages.length} pages), llms-full.txt (${statSync(join(outRoot, "llms-full.txt")).size} bytes), and raw .md written to ${outRoot}`);
