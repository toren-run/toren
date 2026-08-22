# Workflow API reference

A workflow is a default-exported `(ctx: WorkflowCtx) => Promise<string>`.

**Where it lives:** a lone `workflow.ts` at the agent root is the agent's single process, named `main`. An agent with several jobs uses a `workflows/` directory instead: one file per **named process** (`workflows/daily-digest.ts`, `workflows/weekly-report.ts`; filename → process name, lowercase letters, digits, `_`, `-`). Having both `workflow.ts` and `workflows/` is a startup error; move the lone file into the directory. Triggers select one by name: `toren run --process`, `toren schedule create --process`, `POST /runs {process}`, and, from a conversation, the `run_process` builtin ([background runs](../guides/background-runs.md)). `default_process` in [agent.yaml](agent-yaml.md) picks the one used when a trigger names none. Sessions never select a process; a chat always converses with the root agent directly.

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

**Imports and installs:** the CLI transpiles your agent's TypeScript itself, so `import type { WorkflowCtx } from "@toren-run/core"` needs nothing installed. Only *value* imports (e.g. `defineTool` in `tools/`) need `@toren-run/core` resolvable from the agent directory, which the `toren init` template's `npm install` provides. A workflow-only agent runs with zero installs beyond the CLI.

**Input convention:** `ctx.input` is the trigger's input string, verbatim. The convention throughout is to JSON-encode it (`--input '"hello"'`, `--input '["a","b"]'`) and `JSON.parse(ctx.input)` in the workflow; a bare unquoted string works but leaves you guessing about quoting at the shell.

## Semantics to rely on

- The workflow function re-executes on every tick; recorded effects return instantly. Code between `await`s must be deterministic (no `Date.now()`, no I/O), use the ctx equivalents.
- Wave plans carry a request digest; editing the workflow mid-flight invalidates exactly the affected waves (`StreamInvalidated`), nothing else.
- One wave `await` at a time, parallelism lives *inside* a wave, not across `Promise.all` of ctx calls (v0 rule).
- Throwing any error fails the run with `workflow error: <message>`; a wave failing under `"fail"` policy does the same with per-task detail.

Programmatic host API (no CLI): `startRun(deps, {agent, input, process?})`, `tick(deps, runId)`, `LocalWorkerRuntime`, `sweep(deps)`, `listPendingApprovals`, `resolveApproval`, see `@toren-run/core` exports until the typedoc reference exists.
