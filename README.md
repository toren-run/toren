# Toren

[![ci](https://github.com/toren-run/toren/actions/workflows/ci.yml/badge.svg)](https://github.com/toren-run/toren/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/toren-run)](https://www.npmjs.com/package/toren-run) [![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**Toren runs agents that work for days and survive anything.**

![kill -9 a crew mid-run, restart, it finishes: 13 tasks, exactly 13 model calls](https://toren.run/kill9.gif)

*A real recording (waits sped up): a 13-task crew, `kill -9` mid-run, a fresh worker resumes it. The receipt at the end: exactly 13 model calls, 4 replayed from the log, nothing re-paid.*

Toren is an open-source runtime for **process-shaped agents**: work measured in hours and days, not seconds. Agents run as durable processes on an append-only Postgres event log. They survive crashes, deploys, restarts, and a literal `kill -9`, and they run in **your** cloud.

- **A resumed run never re-pays for a completed model call.** Every LLM and tool call is recorded the moment it completes; on resume, finished steps replay from the log instead of the provider. Crash-tested with a kill matrix that murders the process after every single database write and asserts exactly-once billing.
- **One deployment, many process agents.** `toren dev --dir crews/` serves a whole fleet. Each agent crew gets its own isolated event-log schema, the API routes runs by agent, and the console shows every crew.
- **A built-in console.** `toren dev` serves a web console: live runs, full event timelines, one-click approvals, API-key management. It prints a pre-authenticated link at startup.
- **Zero-compute parking.** Approvals, timers, and long waits hold no worker, no container, no poll loop. A run waiting three days for a human costs nothing.
- **One dependency locally, your AWS in production.** The whole runtime needs nothing but Postgres. The same agent deploys to Fargate + SQS + RDS with one Terraform module, into a fresh VPC or the one you already have.
- **Two-layer execution.** Agentic task loops (the model owns control flow) composed by deterministic workflows with parallel waves, record/replay, and surgical invalidation on edits.

**Website:** [toren.run](https://toren.run) · **Docs:** [toren.run/docs](https://toren.run/docs)

## Quickstart

```bash
npx toren-run@latest init my-crew
cd my-crew
npm install
docker compose up -d db
npx toren dev
```

(The npm package is `toren-run`; the binary it installs is `toren`.)

Then trigger a run, kill the worker mid-flight, and watch it resume without re-paying a token. The full walkthrough is in the [quickstart](https://toren.run/docs/quickstart).

## From source

```bash
pnpm install
docker compose up -d db
pnpm test          # 94 tests, including the crash kill-matrices
```

The monorepo: [`packages/core`](packages/core) (event log, replay, leases, workflows), [`packages/cli`](packages/cli) (`toren` command + HTTP API), [`packages/client`](packages/client) (TypeScript SDK), [`packages/console`](packages/console) (built-in web console), [`infra/terraform-aws`](infra/terraform-aws) (AWS deployment, greenfield or bring-your-own VPC/Postgres), [`examples/`](examples), and [`docs/`](docs).

## Deploy to AWS

```bash
toren deploy-aws --region eu-central-1 --plan-only
```

One Terraform module; every part is optional: reuse your existing VPC, Postgres, and load balancer, or let it create everything. See [Deploy to AWS](https://toren.run/docs/guides/deploy-aws).

## License

[Apache-2.0](LICENSE). The runtime, CLI, SDK, and deployment tooling are open source, forever.
