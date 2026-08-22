# Toren documentation

*Toren is the open-source runtime for long-running, durable agents, in your own cloud.*

The docs follow [Diátaxis](https://diataxis.fr/): learn by doing → solve a task → look something up → understand why.

## Start here

| I want to… | Go to |
|---|---|
| See it work in 10 minutes | [Quickstart](quickstart.md) |
| Define my own agent, tools, subagents | [Defining agents](guides/defining-agents.md) |
| Orchestrate parallel work and iteration | [Workflows & waves](guides/workflows-and-waves.md) |
| Gate dangerous actions behind a human | [Approvals](guides/approvals.md) |
| Run agents on a cron schedule | [Scheduling](guides/scheduling.md) |
| Trigger runs over HTTP from anywhere | [HTTP API](guides/http-api.md) |
| Deploy into my AWS account | [Deploy to AWS](guides/deploy-aws.md) |
| Trace and monitor runs | [Observability](guides/observability.md) |
| Look up a command or config key | [CLI](reference/cli.md) · [agent.yaml](reference/agent-yaml.md) · [Workflow API](reference/workflow-api.md) · [Event catalog](reference/events.md) |
| Understand how durability actually works | [Durability & replay](concepts/durability.md) |
| Understand the system's shape | [Architecture](concepts/architecture.md) |

The design rationale behind these guarantees is summarized in [Durability & replay](concepts/durability.md) and [Architecture](concepts/architecture.md).

## Honest status of these docs

| Area | Status |
|---|---|
| Quickstart, guides, concepts, CLI/config reference | ✅ written, matches shipped code |
| TypeScript API reference (`@toren-run/core` symbols) | ❌ gap, needs typedoc generation |
| HTTP intake API (runs, status, events, approvals) | ✅ shipped, see the [guide](guides/http-api.md); sessions shipped too, SSE still on the roadmap |
| Troubleshooting / FAQ | ❌ gap, collect from first external users |
| Versioning & compatibility policy | ❌ gap, needed before first public release |
| Examples gallery beyond research-crew | ❌ gap |
| [Client SDK](reference/client.md) (`@toren-run/client`), env declarations, environment profiles | ✅ shipped |
