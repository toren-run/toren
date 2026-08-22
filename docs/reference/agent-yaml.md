# agent.yaml reference

```yaml
name: research_crew        # lowercase [a-z][a-z0-9_]*; becomes the schema/agent key
model: anthropic/claude-opus-5   # or openai/gpt-4o, mock/echo (offline). Prefix picks the provider
maxTokens: 16000           # per model call (default 16000)
limits:
  maxStepsPerTask: 50      # hard cap on loop steps per task (default 50)
contextWindow: 200000      # tokens; defaults per provider (anthropic 200k, openai 128k). Drives compaction
builtin_tools: [web_search]      # standalone tools; see the Tools docs
sandbox:                   # true, or a block: gives the agent a computer (bash + file tools)
  image: node:22-slim      # docker image (local backend) or E2B template (cloud backend)
  network: false           # egress from the sandbox (default: none)
  approval: always         # a human approves each bash command (default), or "never"
  env: [MY_APP_DB_URL]     # which of YOUR variables the sandbox may see (folds into env.required)
env:
  required: [TICKETS_API_KEY]    # missing values fail fast at startup
  optional:
    REGION: "us-east-1"          # fallback used when unset
```

- Every field is optional except that the file must exist at the agent root (`subagents/*/agent.yaml` may omit anything, defaults apply).
- `instructions.md` beside it is the system prompt; missing → a generic default.
- Model routing is by prefix: `mock/` (offline echo), `anthropic/` (needs `ANTHROPIC_API_KEY`), `openai/` (needs `OPENAI_API_KEY`). Subagents may each use different models.
- `env` values reach tool handlers as `ctx.env`, never via raw `process.env`. A [builtin tool](../tools/defining-tools.md)'s required env (like `TAVILY_API_KEY` for `web_search`) folds into `env.required` automatically.
- `sandbox: true` (or the block above) grants bash plus the workspace file tools; the operator picks the backend with `TOREN_SANDBOX` (docker or e2b). Full details in [Sandbox](../tools/sandbox.md).

Planned keys (planned, not yet implemented, will fail silently today, don't set them): `fallbacks`, `runtime: short|long`, `sandbox.snapshotEvery`, `limits.maxWaves`, `limits.maxWallClockMin`, `limits.maxBudgetUsd`.
