# agent.yaml reference

```yaml
name: research_crew        # lowercase [a-z][a-z0-9_]*; becomes the schema/agent key
model: anthropic/claude-opus-5   # or openai/gpt-4o, mock/echo (offline). Prefix picks the provider
maxTokens: 16000           # per model call (default 16000)
limits:
  maxStepsPerTask: 50      # hard cap on loop steps per task (default 50)
contextWindow: 200000      # tokens; defaults per provider (anthropic 200k, openai 128k). Drives compaction
builtin_tools: [web_search]      # standalone tools; see the Tools docs
sandbox: true              # gives the agent a computer: bash + workspace file tools
env:
  required: [TICKETS_API_KEY]    # missing values fail fast at startup
  optional:
    REGION: "us-east-1"          # fallback used when unset
```

- Every field is optional except that the file must exist at the agent root (`subagents/*/agent.yaml` may omit anything, defaults apply).
- `instructions.md` beside it is the system prompt; missing → a generic default.
- Model routing is by prefix: `mock/` (offline echo), `anthropic/` (needs `ANTHROPIC_API_KEY`), `openai/` (needs `OPENAI_API_KEY`). Subagents may each use different models.
- `env` values reach tool handlers as `ctx.env`, never via raw `process.env`. A [builtin tool](../tools/defining-tools.md)'s required env (like `TAVILY_API_KEY` for `web_search`) folds into `env.required` automatically.

Planned keys (planned, not yet implemented, will fail silently today, don't set them): `fallbacks`, `runtime: short|long`, `sandbox.image`, `sandbox.snapshotEvery`, `limits.maxWaves`, `limits.maxWallClockMin`, `limits.maxBudgetUsd`.
