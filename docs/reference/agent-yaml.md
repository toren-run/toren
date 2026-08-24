# agent.yaml reference

```yaml
name: research_crew        # lowercase [a-z][a-z0-9_]*; becomes the schema/agent key
model: anthropic/claude-opus-5   # or openai/gpt-4o, mock/echo (offline). Prefix picks the provider
maxTokens: 16000           # per model call (default 16000)
reasoning_effort: low      # OpenAI reasoning models: none|low|medium|high. gpt-5.6+ need it to use tools
limits:
  maxStepsPerTask: 50      # hard cap on loop steps per task (default 50)
  maxAttemptsPerTask: 20   # opt-in poison-pill: fail terminally after N attempts instead of retrying forever
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
default_process: daily-digest    # process run when a trigger names none (only useful with workflows/)
telegram:
  bot_token_env: REPORTER_BOT_TOKEN   # this agent gets its own Telegram bot; see Channels → Telegram
```

- Every field is optional except that the file must exist at the agent root (`subagents/*/agent.yaml` may omit anything, defaults apply).
- `instructions.md` beside it is the system prompt; missing → a generic default.
- Model routing is by prefix: `mock/` (offline echo), `anthropic/`, `openai/`, `bedrock/`. Subagents may each use different models, and SDKs load lazily. Auth, reasoning models, Bedrock ids, and pricing overrides: [Model providers](providers.md).
- `mock/echo` is fully offline and deterministic: it replies `echo(<the task's input>)` and never calls tools, useful for asserting orchestration without a model bill. `mock/slow` is the same echo at three seconds per call, slow enough to `kill -9` mid-run. Mock models get no default context window, so they never trigger compaction.
- `env` values reach tool handlers as `ctx.env`, never via raw `process.env`. A [builtin tool](../tools/defining-tools.md)'s required env (like `TAVILY_API_KEY` for `web_search`) folds into `env.required` automatically.
- `sandbox: true` (or the block above) grants bash plus the workspace file tools; the operator picks the backend with `TOREN_SANDBOX` (docker or e2b). Full details in [Sandbox](../tools/sandbox.md).
- `telegram.bot_token_env` names the env var holding a dedicated Telegram bot token for this agent (on top of, or instead of, the shared `TELEGRAM_BOT_TOKEN` bot). Details in [Telegram](../channels/telegram.md).
- An agent may define several **named processes**: a `workflows/` directory with one file per process (`workflows/daily-digest.ts`, `workflows/weekly-report.ts`), filename → process name. Triggers select one by name (`--process`, `POST /runs {process}`, `schedule create --process`); `default_process` picks the one used when a trigger names none; otherwise `main`, or the sole process. A lone `workflow.ts` (or none) is a single process named `main`, so existing agents are unchanged. See the [Workflow API](workflow-api.md).

Planned keys (planned, not yet implemented, will fail silently today, don't set them): `fallbacks`, `runtime: short|long`, `sandbox.snapshotEvery`, `limits.maxWaves`, `limits.maxWallClockMin`, `limits.maxBudgetUsd`.
