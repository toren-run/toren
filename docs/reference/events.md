# Event catalog reference

Every run is two-plus append-only streams in the agent's schema: `run` (written by the orchestrator holding the run lease) and `task:<taskId>` (written by that task's lease holder). Sequence numbers are per-stream and gapless; every append is a compare-and-append.

## `run` stream

| Event | Meaning |
|---|---|
| `RunCreated` / `RunStarted` | Run exists / first tick began |
| `SideEffectRecorded` | `ctx.now()` / `ctx.random()` value, recorded once |
| `TimerSet` / `TimerFired` | `ctx.sleep` began / wake consumed |
| `WavePlanned` | Wave dispatched: tasks, inputs, and the plan digest |
| `WaveDispatched` | Task hints enqueued |
| `WaveTaskSettled` | One task's terminal outcome absorbed |
| `WaveSettled` | Settle policy met; coverage summary |
| `StreamInvalidated` | Verified replay diverged (workflow edit); effects from `fromSeq` re-derive |
| `RunCompleted` / `RunFailed` / `RunCancelled` | Terminal |

## `task:<id>` stream

| Event | Meaning |
|---|---|
| `TaskStarted` | Loop (re)entered — `attempt` counts retries |
| `LlmCallStarted` / `LlmCallCompleted` | Model request (with digest) / durable response + token usage |
| `ToolCallStarted` / `ToolCallCompleted` | Handler about to run (idempotency key recorded) / result |
| `ApprovalRequested` / `ApprovalResolved` | Task parked for a human / their decision |
| `StreamInvalidated` | Prompt/tool edit detected on replay; steps from `fromSeq` re-run |
| `TaskCompleted` / `TaskFailed` | Terminal for the task (`willRetry` marks retryable failures) |

Payloads are versioned JSONB (`{ v: 1, ... }`). The log is the source of truth; `runs` table columns (`status`, `output`, `error`) are rebuildable projections. Full semantics: [Durability](../concepts/durability.md).
