# @toren-run/client

Typed, zero-dependency client for a [Toren](https://toren.run) deployment's HTTP API. Trigger durable agent runs, poll them, resolve approvals, upload files, and hold sessions, from any Node or edge runtime with global `fetch`.

```ts
import { TorenClient } from "@toren-run/client";

const client = new TorenClient({ url: "https://agents.example.com", token: process.env.TOREN_API_TOKEN! });
const { runId } = await client.startRun({ input: JSON.stringify(["solar shipping"]), process: "weekly-report" });
const done = await client.waitForRun(runId);
console.log(done.run.output);
```

The full surface (runs, sessions, approvals, files, errors) is half a page: [toren.run/docs/reference/client](https://toren.run/docs/reference/client). Apache-2.0.
