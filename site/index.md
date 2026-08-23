# Toren: durable AI agent runtime

**Toren runs agents that work for days, do real work, and survive anything.**

The open-source runtime for long-running agents. A deploy, a crash, a literal `kill -9`: the run resumes where it died and **never re-pays for a completed model call**. In your cloud.

## What it is

Agents run as durable processes on an append-only Postgres event log. Every model call and tool call is recorded the moment it completes; on resume, finished steps replay from the log instead of the provider. A CI kill matrix crashes the stack after every single database write and asserts each model call is billed exactly once.

- One agent definition, every surface: run it, schedule it (exactly-once cron), talk to it (console, CLI, HTTP, Telegram), let a conversation launch its background processes.
- Zero-compute parking: approvals, timers, and multi-day waits hold no worker, no container, no poll loop.
- A durable computer: `sandbox: true` gives an agent bash and files on a workspace that survives worker death.
- One dependency locally (Postgres); your own AWS in production via one Terraform module. Apache-2.0.

## Start

```bash
npx toren-run@latest init my-crew
cd my-crew && npm install
docker compose up -d db
npx toren dev
```

## Links

- Docs: https://toren.run/docs/ (agent corpus: https://toren.run/llms-full.txt, index: https://toren.run/llms.txt)
- GitHub: https://github.com/toren-run/toren
- npm: https://www.npmjs.com/package/toren-run
- HTTP API spec: https://toren.run/openapi.json (the API is served by your own deployment, not by this site)
