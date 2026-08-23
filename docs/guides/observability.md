# Observability

*How-to: see what your agents are doing.*

## OpenTelemetry (built in, vendor-neutral)

Toren emits standard OTel spans for every orchestrator tick (`toren.run.tick`), task (`toren.task`), model call (`toren.llm`, with `gen_ai.request.model`), and tool call (`toren.tool`). There is no toren dashboard by design, register any OTel SDK/exporter in your process and the spans flow to whatever backend you already run:

```ts
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
// configure your exporter, then:
provider.register();   // toren picks it up automatically (tracer is resolved per call)
```

No SDK registered → spans are no-ops with zero overhead.

Any OTLP backend works, including the LLM-specific ones: point an OTLP exporter at **Langfuse**'s or **LangSmith**'s OpenTelemetry endpoint (each documents its OTLP URL and auth headers) and Toren's traces appear there, with `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` on every model-call span so their cost views populate. One deliberate boundary: prompts and responses are **not** span attributes. Payload content stays in your Postgres event log, so nothing sensitive rides to a third-party trace backend by default; the trace shows shape, timing, models, and spend, and the log holds the words.

## The event log is the deep trace

Every run's full history, prompts, responses, tool args/results, token usage, timings, is queryable SQL in the agent's schema. `toren jobs show <runId>` gives the summary; `store.read(runId, stream)` gives everything. This is the audit trail regulated deployments need, with no extra system.

## Gaps (planned)

Cost roll-ups per run/agent surfaced in the CLI; fleet dashboards and cross-run analytics are on the roadmap.
