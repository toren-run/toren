# CLI reference

All commands take `--json` for machine-readable output where applicable. `DATABASE_URL` selects the Postgres instance (default `postgres://toren:toren@localhost:5433/toren`); `TOREN_QUEUE=sqs` selects the SQS queue adapter, which needs all three queue URLs (`TOREN_SQS_URL_ORCHESTRATOR`, `TOREN_SQS_URL_TASKS_SHORT`, `TOREN_SQS_URL_TASKS_LONG`) plus `AWS_REGION`; the Terraform module prints them. `TOREN_SANDBOX` (`auto`|`docker`|`e2b`|`none`) picks the [sandbox](../tools/sandbox.md) backend, with `E2B_API_KEY` for the cloud one.

| Command | What it does |
|---|---|
| `toren init <name>` | Scaffold a filesystem agent (runs offline via `mock/echo`) |
| `toren run <dir> --input <str> [--process <name>] [--file <path>]… [--json] [--detach] [--env <name>]` | Start a run and drive it to completion or an approval park (`--process`: pick a named process from `workflows/`; `--file`: attach a local pdf/docx/xlsx/text, repeatable; `--detach`: start it and exit; workers pick it up) |
| `toren dev [--dir <dir>]… [--api-port <p>]` | Serve a fleet: workers + guardians for every agent in every `--dir` (repeatable; a folder of agent dirs loads them all). Always serves the [HTTP API](../guides/http-api.md) and the web console at `/console`; an ephemeral token is minted and printed unless `TOREN_API_TOKEN` pins one |
| `toren chat [dir] [--agent <name>] [--session <runId>] [--file <path>]… [--env <name>]` | Talk to an agent from the terminal: a durable [session](../guides/sessions.md). `/end` closes; Ctrl+C leaves it open; `--session` resumes; `--file` attaches to the first message |
| `toren channels telegram invite [--dir]` | Mint a one-time pairing code for the deny-by-default [Telegram channel](../channels/telegram.md) |
| `toren jobs list [--dir] [--json]` | All runs with status, including `waiting_approval` |
| `toren jobs show <runId> [--dir] [--json]` | Status, per-wave progress, pending approvals, output |
| `toren jobs approve <runId> <taskId> <stepId> [--deny] [--comment <t>]` | Resolve a parked approval and drive the run onward |
| `toren schedule create --cron <expr> --input <str> [--process <name>] [--dir <dir>] [--agent <name>] [--name] [--tz]` | Cron-triggered runs, fired by the workers exactly once, crash-safe; `--process` fires a named process. `--dir` is the agent directory the schedule is validated against (default `.`); `--agent` overrides the *target* agent name when scheduling for another crew in the fleet (see the [scheduling guide](../guides/scheduling.md)) |
| `toren schedule list [--json]` · `pause <id>` · `resume <id>` · `rm <id>` | Manage schedules; resume recomputes the next fire from now |
| `toren keys create <name> [--dir]` | Issue an API key for the deployment (secret shown once, stored hashed) |
| `toren keys list [--dir] [--json]` | List keys, id, prefix, name, active/revoked; never secrets |
| `toren keys revoke <id> [--dir]` | Revoke a key immediately |
| `toren deploy-aws --region <r> [--plan-only \| --yes] [--profile] [--state-bucket <b>] [--state-key <k>] [--image-context <dir> \| --image <uri>] [--agent-dir] [--module-dir]` | Terraform the AWS stack; refuses to apply without `--yes`. `--state-bucket` sets up remote S3 state (auto-created, versioned, locked; `--state-key` names the state object, default `toren/terraform.tfstate`). `--image-context` builds the agent image (arm64, git-SHA tag), pushes to ECR, and deploys with the tag pinned |

All run/jobs commands take `--env <name>` (profiles from `.toren/environments.json`, see the [environments guide](../guides/environments.md)). Known gaps (roadmap): `toren jobs tail` (live event stream), `toren jobs cancel`.
