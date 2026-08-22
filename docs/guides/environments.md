# Environments

*How-to: local, staging, and production without footguns.*

**The model: one environment = one fully separate stack.** Local is docker compose; staging and prod are two independent applies of the same Terraform module (`envs/staging.tfvars`, `envs/prod.tfvars`, see the examples in `infra/terraform-aws/envs/`) with their own VPC, database, queues, and API tokens. Nothing is ever shared between environments.

## Profiles: pointing the CLI at the right one

`.toren/environments.json` in your agent directory (tokens referenced by env-var name, never stored):

```jsonc
{
  "local":   {},                                              // db-backed: the default local Postgres
  "shared":  { "databaseUrl": "postgres://…:5433/toren" },    // db-backed: a different Postgres
  "staging": { "api": "http://toren-staging-…elb.amazonaws.com", "tokenEnv": "TOREN_STAGING_TOKEN" },
  "prod":    { "api": "https://agents.example.com" }          // tokenEnv defaults to TOREN_API_TOKEN
}
```

A profile is **db-backed** (empty, or `databaseUrl`) or **api-backed** (`api` + the env-var *name* holding its bearer token; `tokenEnv` defaults to `TOREN_API_TOKEN`).

```bash
toren run . --input '"hello"' --env staging     # goes through the deployment's HTTP API
toren jobs list --env prod                      # prints "→ env: prod (…)" first, always
toren jobs approve 7f3a2c10-9b1e-4f6a-8c2d-5e9012ab34cd w1t0 s4 --env staging
```

Local profiles talk to Postgres directly and drive runs in-process; API profiles start the run remotely and poll, the deployment's own workers execute it. Three command groups are db-backed only — `keys`, `schedule`, and `channels telegram invite` refuse API profiles; against a remote deployment use their [HTTP API](http-api.md) equivalents instead.

## Per-environment secrets

Declare what an agent needs in `agent.yaml` (`env: { required: [...] }`, see [Defining agents](defining-agents.md)); supply values per environment: locally via `.env`, in AWS via the `agent_env_secret_arns` map (env-var name → Secrets Manager ARN), so staging keys and prod keys never meet. Toren stores no secret values anywhere.

## Promotion

Build the image once, push with an immutable tag (git SHA), pin that tag in staging's tfvars, validate, then promote the *same digest* into prod's tfvars. Never point production at `:latest`.
