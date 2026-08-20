/** Files written by `toren init <name>`. Runs offline via the mock provider. */
export const TEMPLATE_FILES = (name: string): Record<string, string> => ({
  "agent.yaml": `name: ${name}
model: mock/echo          # swap to anthropic/claude-opus-5 when you add a key
maxTokens: 16000
limits:
  maxStepsPerTask: 50
`,
  "instructions.md": `You are ${name}, a helpful agent. Answer directly and concisely.
`,
  "workflow.ts": `import type { WorkflowCtx } from "@toren/core";

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
  "tools/search-web.ts": `import { defineTool } from "@toren/core";
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
