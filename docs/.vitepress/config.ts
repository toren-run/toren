import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Toren",
  description:
    "Toren is the open-source runtime for long-running, durable AI agents in your own cloud. A resumed run never re-pays for a completed model call.",
  base: "/docs/",
  cleanUrls: true,
  sitemap: { hostname: "https://toren.run/docs/" },
  // Code blocks stay structural-navy in both modes (like the site terminal),
  // so the highlight theme must be a dark one in both modes too.
  markdown: { theme: { light: "one-dark-pro", dark: "one-dark-pro" } },
  rewrites: { "README.md": "index.md" },
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/docs/toren-mark.svg" }],
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
