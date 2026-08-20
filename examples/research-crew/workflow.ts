import type { WorkflowCtx } from "@toren-run/core";

export default async function (ctx: WorkflowCtx) {
  const topics = JSON.parse(ctx.input) as string[];

  const research = await ctx.wave(
    "research",
    topics.map((t) => ctx.task("researcher", t)),
    { onTaskFailure: "collect" },
  );

  const found = research.results.filter((r) => r.status === "completed");

  const summary = await ctx.wave("summarize", [
    ctx.task("writer", found.map((r) => r.output).join(" | ")),
  ]);

  return summary.results[0]?.output ?? "";
}
