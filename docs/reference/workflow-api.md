# Workflow API reference

A workflow is a default-exported `(ctx: WorkflowCtx) => Promise<string>`.

**Where it lives:** a lone `workflow.ts` at the agent root is the agent's single process, named `main`. An agent with several jobs uses a `workflows/` directory instead — one file per **named process** (`workflows/daily-digest.ts`, `workflows/weekly-report.ts`; filename → process name, lowercase letters, digits, `_`, `-`). Triggers select one by name: `toren run --process`, `toren schedule create --process`, `POST /runs {process}`, and — from a conversation — the `run_process` builtin ([background runs](../guides/background-runs.md)). `default_process` in [agent.yaml](agent-yaml.md) picks the one used when a trigger names none. Sessions never select a process — a chat always converses with the root agent directly.

## `WorkflowCtx`

| Member | Signature | Semantics |
|---|---|---|
| `input` | `string` | The run's input, verbatim |
| `task` | `(agentRef, input) => TaskSpec` | Describe one agent task (no side effect) |
| `wave` | `(name, TaskSpec[], opts?) => Promise<WaveResult>` | Dispatch a parallel batch; suspends the workflow until all tasks settle. `opts.onTaskFailure`: `"fail"` (default, any failure fails the run) or `"collect"` (failures appear in results) |
| `now` | `() => Promise<number>` | Recorded timestamp, stable across replays |
| `random` | `() => Promise<number>` | Recorded random, stable across replays |
| `sleep` | `(ms) => Promise<void>` | Durable timer; run parks at zero compute |

`WaveResult`: `{ name, results: TaskOutcome[] }` in planned order.
`TaskOutcome`: `{ taskId, status: "completed" | "failed", output?, error? }`.

## Semantics to rely on

- The workflow function re-executes on every tick; recorded effects return instantly. Code between `await`s must be deterministic (no `Date.now()`, no I/O), use the ctx equivalents.
- Wave plans carry a request digest; editing the workflow mid-flight invalidates exactly the affected waves (`StreamInvalidated`), nothing else.
- One wave `await` at a time, parallelism lives *inside* a wave, not across `Promise.all` of ctx calls (v0 rule).
- Throwing any error fails the run with `workflow error: <message>`; a wave failing under `"fail"` policy does the same with per-task detail.

Programmatic host API (no CLI): `startRun(deps, {agent, input, process?})`, `tick(deps, runId)`, `LocalWorkerRuntime`, `sweep(deps)`, `listPendingApprovals`, `resolveApproval`, see `@toren-run/core` exports until the typedoc reference exists.
