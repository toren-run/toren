/** Files written by `toren init <name>`. Runs offline via the mock provider. */
export const TEMPLATE_FILES = (name: string): Record<string, string> => ({
  "package.json": `{
  "name": "${name}",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "toren dev",
    "run": "toren run ."
  },
  "dependencies": {
    "toren-run": "^0.1.0",
    "@toren-run/core": "^0.1.0",
    "zod": "^3.23.0"
  }
}
`,
  "docker-compose.yml": `services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: toren
      POSTGRES_PASSWORD: toren
      POSTGRES_DB: toren
    ports:
      - "5433:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U toren"]
      interval: 2s
      timeout: 2s
      retries: 20
`,
  "README.md": `# ${name}

A Toren process agent — durable, crash-proof, in your own infrastructure.

\`\`\`bash
npm install                 # runtime + core
docker compose up -d db     # the only dependency: Postgres
npx toren run . --input '"hello"'
\`\`\`

Long-running mode with the web console (prints a pre-authenticated link):

\`\`\`bash
npx toren dev
\`\`\`

Try the kill test: start a run, \`kill -9\` the process mid-flight, run \`npx toren dev\` again — the run resumes and re-pays nothing for completed model calls.

- \`agent.yaml\` — model, limits, declared env
- \`instructions.md\` — the system prompt
- \`workflow.ts\` — how work fans out (waves)
- \`tools/\` — plain TypeScript tools with durability attributes
- \`subagents/\` — the crew

Swap \`model: mock/echo\` for \`anthropic/claude-sonnet-5\` (set ANTHROPIC_API_KEY) or \`openai/gpt-4o-mini\` (set OPENAI_API_KEY) to go live. Docs: https://toren.run/docs
`,
  ".gitignore": `node_modules/
.env
`,
  ".dockerignore": `node_modules/
.env
.git/
docker-compose.yml
`,
  "Dockerfile": `# Production image for this agent project — deploy it with:
#   toren deploy-aws --region <r> --state-bucket <b> --image-context . --yes
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 7433
CMD ["npx", "toren", "dev", "--dir", "."]
`,
  "agent.yaml": `name: ${name}
model: mock/echo          # or anthropic/claude-sonnet-5, openai/gpt-4o-mini — prefix picks the provider
maxTokens: 16000
limits:
  maxStepsPerTask: 50
`,
  "instructions.md": `You are ${name}, a helpful agent. Answer directly and concisely.
`,
  "workflow.ts": `import type { WorkflowCtx } from "@toren-run/core";

export default async function (ctx: WorkflowCtx) {
  // Wave 1: two researchers in parallel
  const research = await ctx.wave("research", [
    ctx.task("researcher", \`background on: \${ctx.input}\`),
    ctx.task("researcher", \`recent news on: \${ctx.input}\`),
  ]);

  // Wave 2: one writer over the combined findings
  const summary = await ctx.wave("summarize", [
    ctx.task("writer", research.results.map((r) => r.output).join("\\n")),
  ]);

  return summary.results[0]?.output ?? "";
}
`,
  "tools/search-web.ts": `import { defineTool } from "@toren-run/core";
import { z } from "zod";

export default defineTool({
  name: "search_web",
  description: "Search the web and return the top result.",
  input: z.object({ query: z.string() }),
  effects: "external",
  idempotency: "keyed",
  approval: "never",
  handler: async ({ query }) => \`(stub) top result for: \${query}\`,
});
`,
  "subagents/researcher/agent.yaml": `name: researcher
model: mock/echo
`,
  "subagents/researcher/instructions.md": `You research exactly the question you are given and report concise findings.
`,
  "subagents/writer/agent.yaml": `name: writer
model: mock/echo
`,
  "subagents/writer/instructions.md": `You combine findings into a short, clear summary.
`,
});
