# Web search

A built-in, Tavily-backed search tool. Declare it in `agent.yaml`, set `TAVILY_API_KEY`, and your agents search the live web with no handler to write:

```yaml
name: researcher
model: anthropic/claude-sonnet-5
builtin_tools: [web_search]
```

That is the whole setup. The loader folds `TAVILY_API_KEY` into the agent's required env, so a missing key fails fast at startup with a clear message instead of dying mid-run. Locally the key comes from your environment or `.env`; on AWS, `deploy-aws` reads `TAVILY_API_KEY` and stores it in Secrets Manager like the model keys.

The agent sees a `web_search` tool taking `{query, max_results}` and gets back JSON: a short answer when Tavily can produce one, plus the top results as `{title, url, snippet}`.

## Durability

Searches are recorded in the event log with keyed idempotency, like every tool call. A crashed and resumed run replays the recorded results instead of re-searching: no double spend on your Tavily quota, and the agent reasons over the same facts before and after a resume, so replay verification holds.

## Bring your own instead

`web_search` is a convenience, not a lock-in. A different provider is a normal [`defineTool()`](/tools/defining-tools) in your agent's `tools/` directory; if you name it `web_search` while the builtin is declared, the loader refuses at startup rather than letting two tools collide.

Get a key at [tavily.com](https://tavily.com); the free tier is plenty for development.
