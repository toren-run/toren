# Defining tools

A tool is a typed function your agent can call. Drop one file per tool into the agent's `tools/` directory, each default-exporting a `defineTool()`:

```ts
// tools/search-tickets.ts
import { z } from "zod";
import { defineTool } from "@toren-run/core";

export default defineTool({
  name: "search_tickets",
  description: "Search the support ticket index by free text.",
  input: z.object({ query: z.string(), limit: z.number().default(10) }),
  effects: "none",
  idempotency: "keyed",
  approval: "never",
  handler: async ({ query, limit }, ctx) => {
    const res = await fetch(`https://tickets.internal/search?q=${encodeURIComponent(query)}&n=${limit}`, {
      headers: { authorization: `Bearer ${ctx.env.TICKETS_API_KEY}` },
    });
    return JSON.stringify(await res.json());
  },
});
```

Every field is part of the durability contract, not decoration:

- **`input`** is a Zod schema. The model's arguments are validated before your handler runs, and the schema becomes the JSON Schema the model sees.
- **`effects`** declares what the tool touches: `none` (pure lookup), `sandbox` (writes something recoverable), or `external` (emails, payments, anything the outside world sees). The runtime uses this to decide what is safe to replay.
- **`idempotency: "keyed"`** means the call is recorded in the event log under a deterministic key, so a crashed and resumed task never executes it twice. Use `"none"` only for pure reads where a duplicate call is harmless.
- **`approval`** gates the call on a human: `"never"`, `"always"`, or a predicate over the parsed args (`(args) => args.amount > 100`). A gated call parks the run at zero compute until someone approves it in the console, CLI, or API. See [Approvals](/guides/approvals).
- **`ctx.env`** holds the values your agent declared in `agent.yaml` under `env:`. Handlers never read raw `process.env`; declared variables are validated at startup and fail fast with the full missing list. Never pass secrets in a run's input, because inputs live in the event log forever by design.

The handler returns a string (JSON-encode structured results). Whatever it returns is recorded in the event log, so a resumed run replays the recorded result instead of calling the tool again.

## Built-in tools

Some tools are common enough to ship in the box. Declare them by name in `agent.yaml` and skip the handler:

```yaml
builtin_tools: [web_search]
```

- **[Web search](/tools/web-search)**: Tavily-backed live search. Needs `TAVILY_API_KEY`, which the loader folds into the agent's required env automatically.
- **[Database](/tools/database)** (`sql_query`): read-only SQL access to a database; needs `SQL_DATABASE_URL`.
- **[File parsing](/tools/file-parsing)** (`read_attachment`): paged access to attached files: PDF, docx, xlsx, and text formats, parsed once at upload.

The [sandbox](/tools/sandbox) is its own switch: `sandbox: true` grants bash plus the workspace file tools. A builtin whose name collides with one of your own tools is a startup error, never a silent override.
