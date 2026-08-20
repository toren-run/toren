# CLI reference

All commands take `--json` for machine-readable output where applicable. `DATABASE_URL` selects the Postgres instance (default `postgres://toren:toren@localhost:5433/toren`); `TOREN_QUEUE=sqs` + `TOREN_SQS_URL_*` select the SQS queue adapter.

| Command | What it does |
|---|---|
| `toren init <name>` | Scaffold a filesystem agent (runs offline via `mock/echo`) |
| `toren run <dir> --input <str> [--json] [--detach] [--env <name>]` | Start a run and drive it to completion or an approval park (`--detach`: start it and exit; workers pick it up) |
| `toren dev [--dir <dir>] [--api-port <p>]` | Long-running workers + guardians daemon (the container entrypoint); serves the [HTTP API](../guides/http-api.md) when `TOREN_API_TOKEN` is set |
| `toren jobs list [--dir] [--json]` | All runs with status, including `waiting_approval` |
| `toren jobs show <runId> [--dir] [--json]` | Status, per-wave progress, pending approvals, output |
| `toren jobs approve <runId> <taskId> <stepId> [--deny] [--comment <t>]` | Resolve a parked approval and drive the run onward |
| `toren deploy-aws --region <r> [--plan-only \| --yes] [--image] [--agent-dir] [--module-dir]` | Terraform the AWS stack; refuses to apply without `--yes` |

All run/jobs commands take `--env <name>` (profiles from `.toren/environments.json` — see the [environments guide](../guides/environments.md)). Known gaps (roadmap): `toren jobs tail` (live event stream), `toren schedule` (cron triggers), `toren jobs cancel`.
