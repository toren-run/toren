# Model providers

The `model` key in `agent.yaml` routes by prefix. Each subagent may use a different model, so one crew can mix providers freely. The provider SDKs load lazily: a deployment that never routes a prefix never parses that SDK, and you install only the SDKs you use.

| Prefix | Provider | Auth | Example |
|---|---|---|---|
| `anthropic/` | Anthropic API | `ANTHROPIC_API_KEY` | `anthropic/claude-opus-5` |
| `openai/` | OpenAI API | `OPENAI_API_KEY` | `openai/gpt-5.6` |
| `bedrock/` | Amazon Bedrock | AWS credential chain (no key) | `bedrock/us.anthropic.claude-opus-5-v1:0` |
| `mock/` | Offline echo | none | `mock/echo` |

## Anthropic

```yaml
model: anthropic/claude-opus-5
```

Set `ANTHROPIC_API_KEY`. On AWS deployments the key is stored in Secrets Manager and injected into the workers (see the [AWS guide](../guides/deploy-aws.md)). Default context window 200k tokens, which drives [compaction](../concepts/durability.md).

## OpenAI

```yaml
model: openai/gpt-5.6
reasoning_effort: low   # none | low | medium | high
```

Set `OPENAI_API_KEY`. Reasoning models (gpt-5.6 and later) refuse tool calls without a `reasoning_effort`; when it is set, Toren routes the call through OpenAI's `/v1/responses` API, which those models require. `reasoning_effort: none` (or omitting the key) uses plain chat completions, right for the non-reasoning models. Default context window 128k tokens.

## Amazon Bedrock

```yaml
model: bedrock/us.anthropic.claude-opus-5-v1:0
```

The model id after the prefix is the Bedrock model or inference-profile id, passed through as-is. There is no API key: credentials resolve from the standard AWS chain (environment, profile, IAM role), which is the point — on an AWS deployment the worker's task role carries `bedrock:InvokeModel` and no secret exists anywhere. Region comes from `AWS_REGION`. Calls go through the Converse API, one wire shape for every Bedrock model that supports tools; throttling is retried by the AWS SDK itself.

Anthropic model ids on Bedrock get the 200k-token default context window; other models default to 128k. Set `contextWindow` explicitly for anything unusual.

## Mock (offline)

`mock/echo` replies `echo(<the task's input>)`, never calls tools, and costs nothing: it exists to assert orchestration without a model bill. `mock/slow` is the same echo at three seconds per call, slow enough to `kill -9` mid-run, which is exactly what the [kill tests](../concepts/durability.md) do. Mock models get no default context window, so they never trigger compaction.

## Costs

`toren jobs show <run-id>` prints a cost roll-up per run: tokens and dollars per model, with replayed calls counted once (a resumed run never re-pays for a completed model call, and the roll-up proves it). Prices for common models ship in the box; override or extend them with `TOREN_MODEL_PRICES`, a JSON object of USD per million tokens: `{"bedrock/us.anthropic.claude-opus-5-v1:0": {"in": 15, "out": 75}}`. Models with no price entry show tokens only.

## Planned

`fallbacks` (route to a second model when the first is down) is a planned key, not yet implemented; don't set it. Other gateways (Vertex, Azure OpenAI) follow the same adapter shape — the provider interface is one `complete(request)` method, and [PRs are welcome](https://github.com/toren-run/toren).
