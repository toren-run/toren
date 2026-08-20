# Defining agents

*How-to — turn a directory of files into a runnable agent.*

An agent is a directory. No registration, no framework classes:

```
my-crew/
  agent.yaml            # identity + limits (see reference/agent-yaml.md)
  instructions.md       # the system prompt, plain markdown
  workflow.ts           # optional — how work fans out (see workflows guide)
  tools/                # optional — one defineTool() default export per file
  subagents/
    researcher/         # nested agent: own agent.yaml, instructions.md, tools/
    writer/
```

Scaffold one with `toren init my-crew` — the template runs offline on the mock provider.

## Tools

```ts
// tools/send-report.ts
import { defineTool } from "@toren/core";
import { z } from "zod";

export default defineTool({
  name: "send_report",
  description: "Email the finished report.",       // the model reads this — say when to use it
  input: z.object({ to: z.string(), body: z.string() }),
  effects: "external",      // recorded once; never re-executed on resume
  idempotency: "keyed",     // retries/resumes carry a stable idempotency key
  approval: "always",       // park the run until a human approves (or "never")
  handler: async ({ to, body }) => `sent to ${to}`,
});
```

The three durability attributes are the point: they tell toren what is safe to re-run, what must never run twice, and what needs a human. Mark anything side-effectful `keyed`.

## Subagents

Each `subagents/<ref>/` directory is a full agent (own model, prompt, tools). The workflow addresses them by directory name: `ctx.task("researcher", input)`. Different subagents can use different providers — `mock/echo` for tests, `anthropic/claude-opus-5` for production — routed per call by model prefix.

## Declared env

Declare what your tools need; toren validates at startup and fails fast with the full list of what's missing — instead of a run dying mid-wave:

```yaml
env:
  required: [SERP_API_KEY]
  optional: { REGION: "eu" }
```

Handlers receive the resolved values as `ctx.env.SERP_API_KEY` — never read raw `process.env` in a tool. Values come from your environment (locally `.env`; in AWS, Secrets Manager via `agent_env_secret_arns`) — toren never stores them. **Never pass secrets in a run's input:** inputs are recorded in the durable event log forever, by design.

## Models

Set `model:` in each `agent.yaml`. `mock/echo` runs offline; `anthropic/...` needs `ANTHROPIC_API_KEY` in the environment. Toren calls providers directly — no gateway in the middle.
