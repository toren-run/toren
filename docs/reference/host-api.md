# Host API reference

`@toren-run/core` as a library: embed the runtime in your own process instead of using the CLI. This is the surface the CLI itself is built on; everything here is exercised by the test suite. Pre-1.0 this is the least-settled surface (see [versioning](versioning.md)); the shapes below are current as of 0.1.3.

## The minimal embed

```ts
import {
  createPool, tx, migrateControl, provisionAgent,
  PgStateStore, PgQueue, PgLeases, EchoProvider,
  LocalWorkerRuntime, startRun, type TickDeps,
} from "@toren-run/core";

const pool = createPool();                       // reads DATABASE_URL; pg defaults otherwise
await tx(pool, async (c) => {
  await migrateControl(c);                       // toren_control schema, idempotent
  await provisionAgent(c, "myagent");            // agent_myagent schema, idempotent
});

const deps: TickDeps = {
  store: new PgStateStore(pool, "agent_myagent"),
  queue: new PgQueue(pool),                      // or SqsQueue from @toren-run/adapters-aws
  leases: new PgLeases(pool, "agent_myagent"),
  provider: new EchoProvider(),                  // anything implementing ModelProvider
  agents: { main: { model: "mock/echo", system: "be brief", tools: [], maxTokens: 1000, maxSteps: 10 } },
  workflows: {                                   // keyed by process name; "main" is the default
    main: async (ctx) => {
      const w = await ctx.wave("main", [ctx.task("main", ctx.input)]);
      return w.results[0]?.output ?? "";
    },
  },
};

const worker = new LocalWorkerRuntime({ myagent: deps }, { concurrency: 2 });
worker.start();
const runId = await startRun(deps, { agent: "myagent", input: "hello" });
```

## TickDeps

The one wiring object; everything takes it.

| Field | Type | Notes |
|---|---|---|
| `store` | `PgStateStore` | The event log + runs table for one agent schema |
| `queue` | `QueueAdapter` | `PgQueue` locally, `SqsQueue` on AWS; messages are hints, never truth |
| `leases` | `PgLeases` | Single-writer discipline per stream |
| `provider` | `ModelProvider` | `complete(req) => Promise<ModelResponse>`; bring your own or use `@toren-run/providers` |
| `agents` | `Record<ref, AgentSpec>` | `main` is the root; other refs are subagents addressed by `ctx.task(ref, …)` |
| `workflows` | `Record<process, WorkflowFn>` | Keyed by [process name](workflow-api.md) |
| `sandbox?` | `SandboxProvider` | Enables the bash/file builtins |
| `files?` | `PgFiles` | Enables `read_attachment` |
| `processes?` | `ProcessesCtx` | Enables `run_process`/`check_run` (`makeProcessesFacet(pool, name, deps)`) |

`AgentSpec`: `{ model, system, tools, maxTokens, maxSteps, reasoningEffort?, maxTaskAttempts?, contextWindow?, env?, outputSchema? }`.

## Runs

| Function | Semantics |
|---|---|
| `startRun(deps, { agent, input, process?, runId?, mode? })` | Create + enqueue a durable run; returns the runId. Pass `runId` for idempotent creation (the schedule and spawn paths do) |
| `tick(deps, runId)` | One orchestrator step: absorb settled tasks, advance the workflow, park or finish. Workers call this; you can too |
| `cancelRun(deps, runId, reason?)` | Retire a run; queued hints become no-ops |
| `runUsage(store, runId)` | Cost roll-up: models, tokens, dollars, replayed calls |
| `followRun(store, runId, cursor)` | Incremental event feed for tails/SSE |
| `listPendingApprovals(store, runId?)` / `resolveApproval(deps, …)` | The approval surface |

## Workers, guardians, schedules, sessions

- `new LocalWorkerRuntime(depsOrByAgent, { concurrency })` — in-process pollers for the orchestrator and task queues; `.start()`, `.stop()`, `.drain(ms)`. Pass a `Record<agentName, TickDeps>` to serve a fleet.
- `sweep(deps, agent?)` — the guardian: re-derives work for non-terminal runs so nothing is ever lost. Run it on an interval (the CLI uses ~5s).
- `sweepSchedules(pool, byAgent)` / `createSchedule(pool, …)` — exactly-once cron.
- `sweepWatchers(pool, byAgent)` — delivers spawn-arc wakes into sessions.
- `startSession(deps, { agent, message, channel? })`, `sendSessionMessage(deps, runId, { text, channel?, close? })`, `getSession(store, runId)` — the conversation surface.

## Tools

`defineTool({ name, description, input (zod), effects, idempotency, approval, handler })` — the handler receives `(parsedInput, ctx)` with `ctx: { runId, taskId, toolUseId, env, files?, sandbox?, processes? }`. `approval: "always"` parks the run at zero compute until a human resolves it.

## Rules the host must respect

- Never write around `PgStateStore.append`; only a lease holder appends, every append passes an expected seq.
- Workflow code between `await`s must be deterministic: use `ctx.now()` / `ctx.random()`, never `Date.now()`.
- Treat every queue message as a duplicate-safe hint.
- Anything that changes what a recorded request would look like invalidates in-flight replay honestly (`StreamInvalidated`) — that is a feature; do not fight it.
