# Deploying Toren

The runtime's requirements are deliberately tiny: **a container and Postgres.** Everything else (the queue, the console, the channels, the sandbox) lives inside that. So deployment is a ladder, and every rung runs the identical runtime:

| Tier | What it is | For |
| --- | --- | --- |
| **Local** | `toren dev` on your machine, Postgres in docker | Developing agents; the [quickstart](/quickstart) |
| **[Docker Compose](/deploy/compose)** | One compose file, any box | Self-hosting: a VPS, a homelab, Fly, K8s |
| **[AWS reference architecture](/guides/deploy-aws)** | One Terraform module in your account | Production: autoscaling, HTTPS, Secrets Manager, SQS |

The same agent directory moves up the ladder unchanged: develop locally, self-host on a box, graduate to the AWS module when you want managed Postgres, queue-backed workers, and a load balancer. Durability is identical at every tier because it lives in the event log, not the infrastructure.

Start with compose if you just want Toren running somewhere today. Reach for the AWS module when you want a production posture in your own account; it is a reference architecture: read it, fork it, or use it as-is.

## One container or several

`toren dev` serves every agent in every `--dir`: one container runs the whole fleet, one version by construction, one API and console. That is the right default, with one deliberate exception.

**The container is the trust boundary.** Env vars are per-process, so every agent in a container resolves the same variable name to the same value. When two agents must hold *different* credentials for the same thing — a CFO agent whose `SQL_DATABASE_URL` maps to a role that reads finance, a CMO agent whose maps to one that reads marketing — give them separate containers. The database role does the enforcing (the prompt asks nicely, the grant actually refuses); the separate container is what lets each agent carry its own credential. This is the same line the rest of the industry draws: Airflow directs teams needing real separation to separate environments, and Dagster ships a process per code location as its default topology.

Multiple Toren containers share one Postgres safely: queue messages are labeled by agent and each fleet claims only its own. Two rules when you run several:

- **Pin all containers to the same exact Toren version** (`"0.1.9"`, not `"^0.1.9"`) and upgrade them in the same deploy. They share `toren_control`, which migrates at boot; additive migrations make small drift survivable, but version skew is not a state to live in. The runtime watches for it: every worker signs into `toren_control.workers` with its version, and when two versions are live against one database it says so in the log (once on transition, again every few minutes while it lasts) and in `GET /healthz` under `workers`. Skew during a rolling deploy appears and clears on its own; skew that persists means a deployment missed its upgrade.
- Split by **trust domain**, not by agent count. Agents that share credentials and blast radius belong in one container, however many there are.

## Postgres requirements (any tier)

Toren brings its own schemas; you bring a database and a role.

- **Privileges:** the role needs `CONNECT` on the database and `CREATE` (Toren creates `toren_control` plus one `agent_<name>` schema per crew; `CREATE SCHEMA IF NOT EXISTS` checks the privilege even when the schema already exists, so `CREATE` is required either way). Your own schemas are never touched.
- **Where things live:** runs and events are per-agent, in `agent_<name>.runs` / `agent_<name>.events`; `toren_control.agents` maps agent names to schemas. Queue, schedules, files, and keys live in `toren_control`.
- **Managed Postgres over TLS (RDS and friends):** node's `pg` treats `sslmode=require` like full verification, and the RDS CA is not in node's trust store, so a plain connection string fails with `self-signed certificate in certificate chain`. Append `uselibpqcompat=true&sslmode=require` to `DATABASE_URL`, or point `NODE_EXTRA_CA_CERTS` at the [RDS CA bundle](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html).

## When a run looks stuck

A run whose dependency is failing (a bad model key, an unreachable API) keeps retrying with exponential backoff; that is durability working, and the reason is recorded as it happens: `toren jobs show <runId>` and the console show the latest error while the run retries, and it clears on recovery. To give up on its behalf, `toren jobs cancel <runId>` (or `POST /runs/:id/cancel` against a remote deployment) retires the run; every queued retry becomes a no-op. Bad model credentials never get that far: the workers make one cheap authenticated call per provider at startup and refuse to start with a broken key (`TOREN_SKIP_PREFLIGHT=1` skips, for air-gapped starts).
