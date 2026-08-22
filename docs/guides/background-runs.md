# Background runs from chat

*How-to: ask for a job in conversation, keep chatting, get messaged when it's done.*

A session can trigger one of its agent's [named processes](/reference/workflow-api) as a background run. The conversation continues immediately; the process executes durably on the workers; and when it settles, the agent messages you **in the same conversation, on whatever channel you're on** — Telegram, console, CLI, or the HTTP API.

```yaml
# reporter/agent.yaml
name: reporter
model: anthropic/claude-opus-5
builtin_tools: [run_process, check_run]
```

```
you>      run the weekly report for acme
reporter> Started it — I'll message you when it lands.
          … you close the laptop; the run fans out its waves on the workers …
reporter> Your weekly report is ready: 42 pages, revenue up 8%.
```

Two builtins make this work:

- **`run_process`** starts a named process from the agent's `workflows/` directory as a plain durable run. The loader tells the model which processes exist (they're appended to the tool's description), so "run the weekly report" needs no ceremony.
- **`check_run`** reports a background run's status and per-wave progress straight from its event log — "how's the report going?" gets a real answer, not a guess.

## The wake

When `run_process` starts a child, it records a **watcher** (child → conversation) in Postgres. The workers' guardian sweep — the same ~5s loop that fires [schedules](scheduling.md) — notices the child settle and delivers the result into the session as a message (`channel: "watcher"`). The agent reads it and replies to you like any other turn, so every channel delivers it with zero channel-specific code.

Turn-taking stays strict: if the agent is mid-turn when the child settles, the wake simply lands on a later sweep. Nothing ever barges into a turn.

## Effectively-once, like everything else

The child's run id derives deterministically from the spawning tool call, which is itself recorded in the event log. Kill the worker between "child started" and "result recorded" and the replay re-runs the tool — which finds the child already exists and returns the same id. One request, one run, no duplicates; the same discipline as [scheduling](scheduling.md)'s fire records.

## Scope (v0)

A session spawns processes of **its own agent**. A batch workflow may also call `run_process`; it just doesn't get woken — `check_run` is its pull path. Cancel-from-chat rides the `jobs cancel` roadmap item.
