# FAQ

The questions people ask before trying Toren, answered straight.

## How is this different from Temporal or Inngest?

Temporal and Inngest are durable execution engines for arbitrary code, and they are excellent at it. Build an agent on one and you still write the agent layer yourself: the model-call loop, context compaction, tool sandboxing, human approvals, chat channels, cost accounting. Toren ships that whole stack as one runtime, with durable execution built in and specialized for this workload. The recorded unit is the model call, so a resumed run never re-pays for a completed one. If you already run Temporal and like it, building an agent layer on top is a reasonable project; Toren exists so it doesn't have to be yours.

## Why not LangGraph or CrewAI?

Those are frameworks. They give you a way to author agent logic inside your process and leave persistence, queues, workers, and deployment to you or to their hosted platform. Toren is the runtime underneath: workers, event log, leases, schedules, HTTP API, console, running on your own infrastructure. You can even keep your framework for authoring and still want a runtime under it; what you can't do is get durability from a library alone, because durability lives where the process dies.

## Why Postgres?

Because you already run it, and because one transactional store can hold everything: the event log, the queue, the leases, the schedules. There is no Redis, no Kafka, no separate scheduler to operate, and "back up the agents" means backing up a database you already back up. Toren keeps strictly to its own schemas, so it can live on the instance your tools already query. Details in [Architecture](concepts/architecture.md).

## What exactly happens on kill -9 in the middle of a model call?

Every completed step is an event in Postgres before the next one starts. If the model call finished before the kill, its full response is in the log; on resume the run replays it instantly and free. If the call was still in flight, there is nothing replayable (the provider holds no receipt), so the resumed run makes that call again, once. You can audit the arithmetic yourself: `toren jobs show` prints a cost roll-up that counts replayed calls exactly once. The CI [kill matrix](concepts/durability.md) kills the worker at every phase of a run and asserts the same result with no duplicate spend.

## How fast does a run recover after a worker dies?

Another worker takes over when the dead worker's lease expires, up to 60 seconds. The wait is deliberate fencing: a lease that expired early would risk two workers writing one run, and a minute of patience is cheaper than that. Runs parked on approvals or timers hold no worker and no lease, so parked time costs nothing.

## Can I use local models (Ollama, vLLM)?

Not yet. Toren routes `anthropic/`, `openai/`, and `bedrock/` today ([Model providers](reference/providers.md)). An OpenAI-compatible base URL override is on the roadmap, which would cover Ollama, vLLM, and most gateways. If that is what blocks you, open an issue and say so; loud demand moves it up the list.

## Is there a cloud version? How does this make money?

No cloud version exists today. The runtime is Apache-2.0 and complete: nothing held back, no telemetry, no account. A hosted tier and a bring-your-own-cloud tier are planned for teams that want the ops handled; the open-source runtime stays the foundation of both.

## Young project, one maintainer. Why should I trust it?

You shouldn't take it on faith, and the design assumes you won't. Your state is plain Postgres rows you can read with psql. The license is Apache-2.0. If the project disappeared tomorrow you would keep the code and the data, and the worst case is running a fork of software that already works. The kill-matrix CI is public, and the [versioning contract](reference/versioning.md) treats replay compatibility as a breaking-change boundary, because digest stability decides whether people re-pay for model calls. The gaps are real: the project is young and the maintainer count is one. The mitigations are the boring ones above.

## Do I need AWS?

No. Everything runs with `toren dev` on a laptop, with [Docker Compose](deploy/compose.md) on any box you own, or with the [AWS Terraform module](guides/deploy-aws.md) when you want the managed posture. AWS is one deployment target, never a requirement.

## What does event sourcing cost me in overhead?

The event log writes on every agent step, so database load scales with agent activity, not user traffic. A handful of agents run fine on the smallest Postgres you can rent; a busy fleet should watch write IOPS. In exchange, every run is inspectable after the fact (`toren jobs show`, `toren jobs tail`), and recovery needs no snapshots or checkpoints, because the log is the state.

## Can a human approve steps?

Yes ([Approvals](guides/approvals.md)). Sandbox commands default to requiring approval per command, and a run parked on an approval holds no worker while it waits. Approvals arrive through the CLI (`toren jobs approve`), the HTTP API (`POST /runs/:id/approvals`), or the [MCP channel](channels/mcp.md), so you can approve from Claude or any MCP client.

## Where does my data go?

Nowhere. State lives in your Postgres. Outbound traffic goes only to the model provider you configured, plus Telegram if you enable a bot. No telemetry, no phone-home.
