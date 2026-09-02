import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";

const DOCS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SITE = "https://toren.run";
const DEFAULT_DESCRIPTION =
  "Toren is the open-source runtime for long-running, durable AI agents in your own cloud. A resumed run never re-pays for a completed model call.";

/** First real paragraph of a page (skips frontmatter, headings, the italic tagline, code, lists), trimmed to a meta-description length. */
function firstParagraph(markdown: string): string | undefined {
  const body = markdown.replace(/^---[\s\S]*?---\s*/, "");
  const blocks = body.split(/\n\s*\n/);
  for (const raw of blocks) {
    const b = raw.trim();
    if (!b || b.startsWith("#") || b.startsWith("```") || b.startsWith("|") || b.startsWith("-") || b.startsWith("*") || b.startsWith(">") || b.startsWith("<")) continue;
    const text = b.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
    if (text.length < 40) continue;
    return text.length > 158 ? `${text.slice(0, 155).replace(/\s+\S*$/, "")}…` : text;
  }
  return undefined;
}

/** The FAQ page is twelve H2 questions with direct answers: expose them as FAQPage schema for direct-answer extraction. */
function faqSchema(markdown: string): object | undefined {
  const qa: { q: string; a: string }[] = [];
  const parts = markdown.split(/^## /m).slice(1);
  for (const part of parts) {
    const [q, ...rest] = part.split("\n");
    const a = rest.join("\n").split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (q && a) qa.push({ q: q.trim(), a: a.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`]/g, "") });
  }
  if (!qa.length) return undefined;
  return {
    "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: qa.map(({ q, a }) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
  };
}

export default defineConfig({
  title: "Toren",
  description: DEFAULT_DESCRIPTION,
  base: "/docs/",
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: "https://toren.run/docs/" },
  transformPageData(pageData) {
    // One description per page, not one for all 38: the first paragraph is the honest one.
    if (!pageData.frontmatter.description) {
      try {
        const md = readFileSync(join(DOCS_DIR, pageData.relativePath), "utf8");
        const d = firstParagraph(md);
        if (d) pageData.description = d;
      } catch { /* keep the site default */ }
    }
  },
  transformHead({ pageData }) {
    const path = pageData.relativePath.replace(/(^|\/)index\.md$/, "$1").replace(/README\.md$/, "").replace(/\.md$/, "");
    const url = `${SITE}/docs/${path}`.replace(/\/$/, "") || `${SITE}/docs`;
    const title = pageData.title ? `${pageData.title} | Toren` : "Toren docs";
    const description = pageData.description || DEFAULT_DESCRIPTION;
    const head: [string, Record<string, string>, string?][] = [
      ["link", { rel: "canonical", href: url }],
      ["link", { rel: "alternate", type: "text/markdown", href: `${url}.md` }],
      ["meta", { property: "og:type", content: "article" }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { property: "og:image", content: `${SITE}/og.png` }],
      ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ];
    const article: Record<string, unknown> = {
      "@context": "https://schema.org", "@type": "TechArticle",
      headline: pageData.title, description, url,
      isPartOf: { "@type": "WebSite", name: "Toren", url: SITE },
      author: { "@type": "Organization", name: "Toren" },
      ...(pageData.lastUpdated ? { dateModified: new Date(pageData.lastUpdated).toISOString() } : {}),
    };
    head.push(["script", { type: "application/ld+json" }, JSON.stringify(article)]);
    if (pageData.relativePath === "faq.md") {
      try {
        const schema = faqSchema(readFileSync(join(DOCS_DIR, "faq.md"), "utf8"));
        if (schema) head.push(["script", { type: "application/ld+json" }, JSON.stringify(schema)]);
      } catch { /* no schema is better than a broken one */ }
    }
    return head;
  },
  // Code blocks stay structural-navy in both modes (like the site terminal),
  // so the highlight theme must be a dark one in both modes too.
  markdown: { theme: { light: "one-dark-pro", dark: "one-dark-pro" } },
  rewrites: { "README.md": "index.md" },
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/docs/toren-mark.svg" }],
    // Vercel Web Analytics — the landing page has this too; without it here, docs visits are invisible.
    ["script", { defer: "", src: "/_vercel/insights/script.js" }],
    ["link", {
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800;900&family=Source+Sans+3:ital,wght@0,400;0,600;1,400&family=JetBrains+Mono:wght@400;500;600&display=swap",
    }],
  ],
  themeConfig: {
    logo: "/toren-mark.svg",
    siteTitle: "TOREN",
    nav: [
      { text: "Quickstart", link: "/quickstart" },
      { text: "Website", link: "https://toren.run" },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/toren-run/toren" }],
    sidebar: [
      {
        text: "Start",
        items: [
          { text: "Overview", link: "/" },
          { text: "Quickstart", link: "/quickstart" },
          { text: "FAQ", link: "/faq" },
        ],
      },
      {
        text: "Guides",
        items: [
          { text: "Defining agents", link: "/guides/defining-agents" },
          { text: "Workflows & waves", link: "/guides/workflows-and-waves" },
          { text: "Approvals", link: "/guides/approvals" },
          { text: "Sessions", link: "/guides/sessions" },
          { text: "Background runs", link: "/guides/background-runs" },
          { text: "Cross-agent calls (beta)", link: "/guides/cross-agent-calls" },
          { text: "Scheduling", link: "/guides/scheduling" },
          { text: "HTTP API", link: "/guides/http-api" },
          { text: "Environments", link: "/guides/environments" },
          { text: "Observability", link: "/guides/observability" },
        ],
      },
      {
        text: "Deploy",
        items: [
          { text: "Overview", link: "/deploy/" },
          { text: "Docker Compose", link: "/deploy/compose" },
          { text: "AWS reference architecture", link: "/guides/deploy-aws" },
        ],
      },
      {
        text: "Channels",
        items: [
          { text: "Overview", link: "/channels/" },
          { text: "Console", link: "/channels/console" },
          { text: "CLI", link: "/channels/cli" },
          { text: "HTTP API", link: "/channels/http-api" },
          { text: "Telegram", link: "/channels/telegram" },
          { text: "MCP", link: "/channels/mcp" },
          { text: "WhatsApp (soon)", link: "/channels/whatsapp" },
        ],
      },
      {
        text: "Tools",
        items: [
          { text: "Defining tools", link: "/tools/defining-tools" },
          { text: "Sandbox", link: "/tools/sandbox" },
          { text: "Web search", link: "/tools/web-search" },
          { text: "Database", link: "/tools/database" },
          { text: "File parsing", link: "/tools/file-parsing" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "CLI", link: "/reference/cli" },
          { text: "agent.yaml", link: "/reference/agent-yaml" },
          { text: "Model providers", link: "/reference/providers" },
          { text: "Workflow API", link: "/reference/workflow-api" },
          { text: "Client SDK", link: "/reference/client" },
          { text: "Host API", link: "/reference/host-api" },
          { text: "Versioning", link: "/reference/versioning" },
          { text: "Event catalog", link: "/reference/events" },
        ],
      },
      {
        text: "Concepts",
        items: [
          { text: "Architecture", link: "/concepts/architecture" },
          { text: "Durability & replay", link: "/concepts/durability" },
        ],
      },
    ],
    search: { provider: "local" },
    outline: [2, 3],
  },
});
