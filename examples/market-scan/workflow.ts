import type { WorkflowCtx } from "@toren-run/core";

// A broad large/mid-cap universe. Each ticker gets its own deep-dive analyst
// (real web research), then one synthesizer ranks the week's best ideas.
const UNIVERSE = [
  "NVDA", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA", "AMD",
  "AVGO", "NFLX", "CRM", "ORCL", "ADBE", "INTC", "QCOM", "PLTR",
  "SNOW", "UBER", "COIN", "SHOP", "PYPL", "DIS", "JPM", "XOM",
  "MU", "ARM", "SMCI", "DELL",
];

export default async function (ctx: WorkflowCtx) {
  const theme = ctx.input || "best stocks this week";

  const scan = await ctx.wave(
    "analyze",
    UNIVERSE.map((t) => ctx.task("analyst", JSON.stringify({ ticker: t, theme }))),
    { onTaskFailure: "collect" },
  );

  const analyses = scan.results
    .filter((r) => r.status === "completed")
    .map((r) => r.output)
    .join("\n\n----\n\n");

  const ranked = await ctx.wave("synthesize", [
    ctx.task("synthesizer", JSON.stringify({ theme, analyses })),
  ]);

  return ranked.results[0]?.output ?? "";
}
