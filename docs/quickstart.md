# Toren Quickstart

*From zero to a durable multi-agent run — locally with one dependency, then the identical agent in your own AWS account.*

> Everything below runs today, offline out of the box — and the AWS path has survived a live kill test on a real account (worker killed mid-run, resumed, zero tokens re-paid).

---

## 1. Install & scaffold

```bash
npx toren init research-crew
cd research-crew
```

You get a filesystem-first agent — files, not framework config:

```
research-crew/
  agent.yaml            # model, limits, budget caps
  instructions.md       # the system prompt
  workflow.ts           # how work fans out (waves)
  tools/
    search-web.ts
    send-report.ts
  subagents/
    researcher/         # a nested agent, same layout
    writer/
```

## 2. Define a tool

Tools are plain TypeScript with three durability attributes — what the tool touches (`effects`), whether retries are safe (`idempotency`), and whether a human must sign off (`approval`):

```ts
// tools/send-report.ts
import { defineTool } from "@toren/core";
import { z } from "zod";

export default defineTool({
  name: "send_report",
  description: "Email the finished report.",
  input: z.object({ to: z.string(), body: z.string() }),
  effects: "external",      // recorded once; never re-executed on resume
  idempotency: "keyed",     // retries carry the same idempotency key
  approval: "always",       // run parks (zero compute) until a human approves
  handler: async ({ to, body }) => {
    /* your send logic */
    return `sent to ${to}`;
  },
});
```

Need an API key in a tool? Declare it — toren validates at startup and hands it to handlers as `ctx.env`, never storing it:

```yaml
# agent.yaml
env:
  required: [SERP_API_KEY]
```

## 3. Define the workflow

The workflow is a short, deterministic script. Parallelism comes from **waves** — dispatch a batch of agent tasks, get their results, decide what's next:

```ts
// workflow.ts
import type { WorkflowCtx } from "@toren/core";

export default async function (ctx: WorkflowCtx) {
  const topics = JSON.parse(ctx.input) as string[];

  // Wave 1: N researchers in parallel
  const research = await ctx.wave(
    "research",
    topics.map((t) => ctx.task("researcher", t)),
    { onTaskFailure: "collect" },   // failures are reported, not fatal
  );

  // Plain code between waves — filter, branch, iterate
  const found = research.results.filter((r) => r.status === "completed");

  // Wave 2: one writer over the combined findings
  const summary = await ctx.wave("summarize", [
    ctx.task("writer", found.map((r) => r.output).join("\n")),
  ]);

  return summary.results[0].output ?? "";
}
```

## 4. Run it locally

The whole local stack is Postgres. Nothing else.

```bash
docker compose up -d        # postgres + toren (orchestrator + workers)
toren run research-crew --input '["solar shipping","battery freight"]'
```

```
run r_9f2c1a  wave research   dispatched 2 tasks
run r_9f2c1a  wave research   settled  2/2 completed
run r_9f2c1a  wave summarize  dispatched 1 task
run r_9f2c1a  completed       "Solar-assisted shipping is..."
```

Programmatic equivalent (works today):

```ts
import { LocalWorkerRuntime, startRun } from "@toren/core";

const runId = await startRun(deps, { agent: "research-crew", input: JSON.stringify(topics) });
new LocalWorkerRuntime(deps).start();   // pollers for orchestration + tasks
```

## 5. The part that feels like magic

Kill the process mid-run. Hard.

```bash
toren run research-crew --input '[...]' &
sleep 10 && kill -9 %1        # murder it mid-wave
toren dev                      # bring the stack back
```

The run resumes at the exact step it died on. Every completed model call is **replayed from the event log, not re-executed** — a resumed run re-pays zero tokens for finished work. This isn't best-effort: the test suite kills the stack after *every single write point* in a run and asserts each LLM step was paid for exactly once.

Edit a prompt mid-flight? Only the steps your edit actually affects re-run; everything unchanged stays cached (each recorded step carries a digest of its exact request, verified on replay).

## 6. Approvals

When the writer tries `send_report`, the run parks — durably, at **zero compute**. No worker polling, no idle container.

```bash
toren jobs list
#  r_9f2c1a  research-crew  waiting_approval  (send_report)

toren jobs show r_9f2c1a
#  pending approval: send_report {"to":"board@fund.com"}  → toren jobs approve r_9f2c1a w1t0 s14

toren jobs approve r_9f2c1a w1t0 s14     # or: --deny --comment "wrong list"
```

The run wakes, executes the tool once, and continues.

## 7. Watch it in the console

With `TOREN_API_TOKEN` set, `toren dev` prints a pre-authenticated link to the built-in web console:

```
toren console: http://localhost:7433/console/#token=…
```

Live runs, full event timelines (every model call with its token usage), one-click approve/deny on parked runs, and API-key management. Try the kill test again with the run's timeline open — you can watch it survive.

Serving more than one agent is the same command: `toren dev --dir crews/` loads every agent directory in the folder (or repeat `--dir`), each crew with its own isolated event log. The console shows the whole fleet.

## 8. Trigger it from anywhere

`toren dev` serves an HTTP API (bearer-token auth) — and `@toren/client` wraps it, typed:

```ts
import { TorenClient } from "@toren/client";

const toren = new TorenClient({ url: process.env.TOREN_URL!, token: process.env.TOREN_TOKEN! });
const { runId } = await toren.startRun({ input: JSON.stringify(topics) });
const run = await toren.waitForRun(runId);          // terminal — or parked on an approval
if (run.status === "waiting_approval") await toren.approve(runId, { ...run.approvals[0], granted: true });
```

Name your deployments once in `.toren/environments.json`, then every command targets any of them:

```bash
toren run . --input '"hello"' --env staging     # → env: staging (http://…)  — via the API
toren jobs list --env prod
```

## 9. Same agent, your AWS account

```bash
toren deploy-aws --region eu-central-1 --plan-only   # preview everything it would create
toren deploy-aws --region eu-central-1 --yes         # terraform apply into YOUR account
```

Locally: Postgres does queue + state + log. In AWS: SQS + Lambda/Fargate + RDS — bound behind the same four interfaces, in your VPC, inside your data boundary. The orchestrator binary is byte-identical in both.

---

**Where it stands:** steps 1–8 run today and are chaos- and live-tested (HTTP API, typed SDK, console, environment profiles included). Step 9 is live-validated too: the Terraform module has been applied to real AWS accounts — greenfield and into an existing VPC — and passed the full kill test there: a Fargate worker killed mid-run on real Anthropic billing, resumed by a replacement task, **zero duplicate paid calls** in the event-log audit.
