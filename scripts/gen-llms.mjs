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

/** Title from the H1; blurb from the first real prose paragraph — never a line inside a code fence, never a
 * list item or a lead-in ending in a colon, and capped at a sentence boundary so an index entry stays an entry. */
function titleAndBlurb(src) {
  const lines = src.split("\n");
  let title = "", blurb = "", inFence = false;
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!title && t.startsWith("# ")) { title = t.slice(2).replace(/<[^>]+>/g, "").trim(); continue; }
    if (!title || blurb) continue;
    if (!t || t.startsWith("#") || t.startsWith(":::") || t.startsWith("<") || t.startsWith("|") || t.startsWith("- ") || t.startsWith("* ") || /^\d+\. /.test(t) || t.endsWith(":")) continue;
    let b = t.replace(/\*\*|__/g, "").replace(/^[*_]+|[*_]+$/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/`/g, "").trim();
    if (b.length > 180) {
      const cut = b.slice(0, 180);
      const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
      b = end > 60 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, "")}…`;
    }
    blurb = b;
  }
  return { title, blurb };
}

/** Vue components (<Badge>) mean nothing to a model reading raw markdown. */
function stripComponents(src) {
  return src.replace(/<Badge[^>]*>[\s\S]*?<\/Badge>/g, "").replace(/<Badge[^>]*\/>/g, "");
}

const files = walk(docsDir).sort();
const pages = files.map((f) => {
  const rel = relative(docsDir, f);
  const src = readFileSync(f, "utf8");
  return { rel, src, url: urlPath(rel), ...titleAndBlurb(src) };
});

// Group pages by top-level section (dir name; root files under "Overview").
const SECTION = { "": "Overview", channels: "Channels", tools: "Tools", guides: "Guides", concepts: "Concepts", compare: "Compare", reference: "Reference", deploy: "Deploy" };
const ORDER = ["Overview", "Guides", "Channels", "Tools", "Deploy", "Concepts", "Compare", "Reference"];
const groups = {};
for (const p of pages) {
  const top = p.rel.includes("/") ? p.rel.split("/")[0] : "";
  const g = SECTION[top] ?? top;
  (groups[g] ??= []).push(p);
}

// --- llms.txt: the index.
let index = `# Toren\n\n`;
index += `> Toren is an open-source, self-hosted durable agent runtime: long-running AI agents on a Postgres event log, in your own cloud. A resumed run never re-pays for a completed model call, and every run can be read afterwards: what it did, what it cost, why it stopped.\n\n`;
index += `Toren runs agents as durable, event-sourced processes on Postgres: work measured in hours and days that survives crashes, deploys, and kill -9. Agents can hold conversations (sessions), run autonomously (runs), call tools, delegate to consenting peer agents, and get a sandboxed computer. Deploy locally, on one box with Docker Compose, or into your own AWS account. Website: ${SITE}. Source (Apache-2.0): https://github.com/toren-run/toren.\n\n`;
index += `Where it sits: frameworks like LangGraph and CrewAI author agent logic and leave persistence, workers, and deployment to you; durable-execution engines like Temporal, Inngest, and Hatchet make arbitrary code crash-safe and leave the agent layer (model-call replay, compaction, sandboxes, approvals, channels, cost receipts) to you; hosted platforms like Claude Managed Agents and LangGraph Platform run on someone else's cloud; Golem is a durable agent runtime too, on WebAssembly. Toren is the runtime layer with the agent layer built in, on plain Node and your Postgres.\n\n`;
index += `## When to use Toren\n\n`;
index += `Reach for Toren when agent work is LONG (hours to days), EXPENSIVE (many model calls whose re-payment on a crash hurts), and UNATTENDED (no human watching who can just re-run): enrichment pipelines, scheduled reports, migrations, document processing, back-office automation, approval-gated actions. Skip it when runs finish in seconds and a retry is free. It is a runtime, not an agent framework: you bring the prompts and tools, Toren makes the execution durable. Everything self-hosts (Postgres locally, your own AWS in production); there is no hosted service, so the HTTP API lives at YOUR deployment's URL, never at toren.run. Quickstart: npx toren-run@latest init my-crew (offline, no API keys needed). Machine-readable API spec: https://toren.run/openapi.json.\n\n`;
for (const g of ORDER) {
  const list = groups[g];
  if (!list) continue;
  index += `## ${g}\n\n`;
  for (const p of list.sort((a, b) => a.url.localeCompare(b.url))) {
    if (!p.title) continue;
    // The docs root has no /docs.md; its raw markdown is served at /docs/README.md.
    const mdUrl = p.url === "/docs" ? `${SITE}/docs/README.md` : `${SITE}${p.url}.md`;
    index += `- [${p.title}](${mdUrl})${p.blurb ? `: ${p.blurb}` : ""}\n`;
  }
  index += `\n`;
}
mkdirSync(outRoot, { recursive: true });
writeFileSync(join(outRoot, "llms.txt"), index);

// --- llms-full.txt: every page inline, for one-fetch consumption.
let full = `# Toren documentation (full corpus)\n\n`;
for (const g of ORDER) {
  for (const p of (groups[g] ?? []).sort((a, b) => a.url.localeCompare(b.url))) {
    full += `\n\n---\n# ${SITE}${p.url}\n\n${stripComponents(p.src).trim()}\n`;
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
