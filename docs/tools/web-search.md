# Web search <Badge type="warning" text="coming soon" />

A built-in, Tavily-backed search tool: declare it in `agent.yaml`, set `TAVILY_API_KEY`, and your agents can search the live web with no handler to write. Results will be recorded in the event log like any tool call, so a resumed run replays them instead of re-searching and answers stay reproducible.

Today you can wire the same thing yourself in a few lines:

```ts
// tools/web-search.ts
import { z } from "zod";
import { defineTool } from "@toren-run/core";

export default defineTool({
  name: "web_search",
  description: "Search the web and return the top results with snippets.",
  input: z.object({ query: z.string() }),
  effects: "none",
  idempotency: "keyed",
  approval: "never",
  handler: async ({ query }, ctx) => {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: ctx.env.TAVILY_API_KEY, query, max_results: 5 }),
    });
    return JSON.stringify(await res.json());
  },
});
```

Declare `TAVILY_API_KEY` under `env:` in `agent.yaml` and set it in your environment (locally `.env`; on AWS it rides Secrets Manager through `agent_env_secret_arns`).
