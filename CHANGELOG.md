# Changelog

All notable changes, per the [versioning & compatibility contract](https://toren.run/docs/reference/versioning). GitHub Releases mirror this file.

## Unreleased

- `toren run --json` no longer prints a human-readable line before the JSON; piping to `jq` works.
- Per-agent bots are now the standard Telegram posture: docs lead with `telegram.bot_token_env`, `toren init` scaffolds it, and the all-agents `TELEGRAM_BOT_TOKEN` bot is reframed as the operator's fleet bot (its invites expose the whole roster — don't hand them to outsiders). No behavior change.

## 0.1.6 — 2026-08-24

- Per-agent Telegram bots: `telegram.bot_token_env` in agent.yaml gives an agent its own bot (name, avatar, audience) next to or instead of the shared `TELEGRAM_BOT_TOKEN` one. Pairing, conversations, and delivery cursors are isolated per bot; `toren channels telegram invite --agent <name>` and `POST /channels/telegram/invites {agent}` mint scoped codes. Existing shared-bot pairings migrate untouched, and bot identity is keyed by agent name so token rotation keeps every pairing.
- New docs page: Model providers (auth per prefix, reasoning models, Bedrock ids, `TOREN_MODEL_PRICES`).

## 0.1.5 — 2026-08-24

- Amazon Bedrock provider: `bedrock/<model-id>` routes through the Converse API. Auth is the AWS credential chain (no API key), region from `AWS_REGION`; the SDK loads lazily like the other providers. On AWS the worker role needs `bedrock:InvokeModel`.

## 0.1.4 — 2026-08-24

- MCP serve channel: Toren is an MCP server. `toren mcp` serves a project over stdio to local clients (Claude Code, Cursor; workers run inside); every deployment also serves Streamable HTTP at `POST /mcp` behind the existing bearer tokens. Six tools: list_agents, start_run, run_status, list_runs, cancel_run, resolve_approval.

## 0.1.3 — 2026-08-23

First release shaped by a production field report (Fargate + RDS + Telegram).

- `toren jobs cancel <runId>` and `POST /runs/:id/cancel`: retire a stuck run; queued retries become no-ops.
- Opt-in poison-pill: `limits.maxAttemptsPerTask` fails a task terminally after N attempts instead of retrying forever.
- `reasoning_effort:` in agent.yaml passes through to OpenAI; gpt-5.6-family models can use tools again.
- `toren jobs show` prints the run's recorded error, with a hint to cancel while it retries.
- Cost roll-ups: `jobs show` and `GET /runs/:id` report calls, tokens, estimated dollars, and what a resume replayed instead of re-buying (`TOREN_MODEL_PRICES` extends the price table).
- OpenAI `/v1/responses` support: real `reasoning_effort` routes there, so gpt-5.6-family models get reasoning AND tools together.
- `toren jobs tail <runId>` and `GET /runs/:id/events/stream` (SSE): follow a run live until it settles; `client.tailRun(runId, onEvent)` in the SDK; console run pages update live.
- TypeScript host API reference: embed the runtime without the CLI (docs/reference/host-api).
- Docs: two-database-roles security pattern; agent.yaml reference for the new keys.

## 0.1.2 — 2026-08-23

External failures became first-class.

- A failing dependency's error is recorded on the run while it retries and clears on recovery (was: invisible).
- Exponential backoff between task retries (0.2s doubling, 60s cap; was: flat 0.2s).
- Startup preflight: one free authenticated call per provider in use; a dead key refuses to start (`TOREN_SKIP_PREFLIGHT=1` skips).
- `gen_ai.usage.*` token counts on every model-call span, so Langfuse/LangSmith cost views populate.
- An unreachable Postgres names its fix instead of printing an empty error.
- `mock/slow`: the offline echo model at 3s per call, so the quickstart kill test is reproducible without API keys.
- xlsx became an optional peer dependency: fresh installs are audit-clean; spreadsheet users `npm install xlsx`.
- A README on every npm package page.

## 0.1.1 — 2026-08-22

First working release on npm (0.1.0's scoped packages were lost to a registry mishap; the version is burned).

- Named processes: a `workflows/` directory, one file per process; `default_process`; selected by `--process`, `POST /runs {process}`, and schedules.
- The spawn arc: `run_process` and `check_run` builtins; a conversation starts a background run and gets messaged when it settles.
- `sql_query` builtin: read-only database access.
- E2B cloud sandbox backend with durable reconnect by recorded id; `TOREN_SANDBOX` selects the backend.
- Provider SDKs load lazily; a prefix never routed is never parsed.
- Client SDK reference, `GET /agent` discovery endpoint, OpenAPI spec at toren.run/openapi.json.

## 0.1.0 — 2026-08-22

Initial publish: the durable core (event log, digest-verified replay, waves, approvals, exactly-once schedules, sessions on four channels, docker sandbox, compose + AWS Terraform deployment).
