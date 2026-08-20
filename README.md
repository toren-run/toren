# Toren

**Toren runs agents that work for days — and survive anything.**

Toren is an open-source runtime for **process-shaped agents**: work measured in hours and days, not seconds. Agents run as durable processes on an append-only Postgres event log — they survive crashes, deploys, restarts, and a literal `kill -9`, and they run in **your** cloud.

- **A resumed run never re-pays for a completed model call.** Every LLM and tool call is recorded the moment it completes; on resume, finished steps replay from the log instead of the provider. Crash-tested with a kill matrix that murders the process after every single database write and asserts exactly-once billing.
- **Zero-compute parking.** Approvals, timers, and long waits hold no worker, no container, no poll loop. A run waiting three days for a human costs nothing.
- **One dependency locally, your AWS in production.** The whole runtime needs nothing but Postgres. The same agent deploys to Fargate + SQS + RDS with one Terraform module — into a fresh VPC or the one you already have.
- **Two-layer execution.** Agentic task loops (the model owns control flow) composed by deterministic workflows with parallel waves, record/replay, and surgical invalidation on edits.

**Website:** [toren.run](https://toren.run) · **Docs:** [toren.run/docs](https://toren.run/docs)

## Quickstart

```bash
npx toren init my-crew
cd my-crew
docker compose up -d db
npx toren dev
```

Then trigger a run and kill the worker mid-flight — watch it resume without re-paying a token. The full walkthrough is in the [quickstart](https://toren.run/docs/quickstart).

## From source

```bash
pnpm install
docker compose up -d db
pnpm test          # 68 tests, including the crash kill-matrices
```

The monorepo: [`packages/core`](packages/core) (event log, replay, leases, workflows), [`packages/cli`](packages/cli) (`toren` command + HTTP API), [`packages/client`](packages/client) (TypeScript SDK), [`infra/terraform-aws`](infra/terraform-aws) (AWS deployment, greenfield or bring-your-own VPC/Postgres), [`examples/`](examples), and [`docs/`](docs).

## Deploy to AWS

```bash
toren deploy-aws --region eu-central-1 --plan-only
```

One Terraform module; every part is optional — reuse your existing VPC, Postgres, and load balancer, or let it create everything. See [Deploy to AWS](https://toren.run/docs/guides/deploy-aws).

## License

[Apache-2.0](LICENSE). The runtime, CLI, SDK, and deployment tooling are open source — forever.
