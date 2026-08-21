# Workflows & waves

*How-to: orchestrate parallel agents and multi-step pipelines.*

A workflow is a default-exported async function. It runs under record/replay: on every scheduler tick it re-executes from the top, and everything already done returns instantly from the event log. Parallelism comes from **waves**:

```ts
import type { WorkflowCtx } from "@toren-run/core";

export default async function (ctx: WorkflowCtx) {
  // one planner task; its output drives the next wave (the planner pattern)
  const plan = await ctx.wave("plan", [ctx.task("planner", ctx.input)]);
  const topics = parseLines(plan.results[0].output ?? "");

  // dynamic fan-out, N researchers decided at runtime by the model's plan
  const research = await ctx.wave(
    "research",
    topics.map((t) => ctx.task("researcher", t)),
    { onTaskFailure: "collect" },          // failures reported, not fatal ("fail" = default)
  );

  const ok = research.results.filter((r) => r.status === "completed");
  const memo = await ctx.wave("memo", [ctx.task("writer", ok.map((r) => r.output).join("\n"))]);
  return memo.results[0].output ?? "";
}
```

## The rules (there are only three)

Workflow code re-executes on resume, so between `await`s it must be deterministic:

1. No ambient time or randomness, use `await ctx.now()` / `await ctx.random()` (recorded once, replayed forever).
2. No I/O in workflow code, effects belong in tools, inside tasks.
3. Sleep with `await ctx.sleep(ms)`, the run parks at zero compute and wakes itself.

Plain computation (parsing, filtering, branching, loops) is fine and encouraged, that's what makes waves more expressive than a static DAG.

## Editing mid-flight

Change a wave's inputs or an agent's prompt while runs are in flight: only the steps your edit actually affects re-run; everything unchanged stays cached. See [Durability](../concepts/durability.md).

## Results & coverage

`ctx.wave` returns results in planned order, each `{ taskId, status, output?, error? }`. With `"collect"`, your code decides what a partial wave means, a run that stops early reports *declared* gaps, never a silent success.
