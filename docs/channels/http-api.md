# HTTP API

Anything that can POST JSON can hold a conversation. Start a session:

```bash
curl -X POST "$TOREN_URL/sessions" \
  -H "Authorization: Bearer $TOREN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent": "research_crew", "message": "Hi! What can you do?"}'
```

The response is `{"runId": "...", "agent": "research_crew"}`. The body also accepts `channel` (a free-form label like `"cli"` or `"telegram"` that tags each turn in the transcript) — on session start and on every message. Read the transcript and state with `GET /sessions/:id`; the state is `working`, `awaiting_input`, `completed`, `failed`, or `cancelled`. Send the next turn:

```bash
curl -X POST "$TOREN_URL/sessions/$RUN_ID/messages" \
  -H "Authorization: Bearer $TOREN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Tell me more."}'
```

Turn-taking is strict: sending while the agent is mid-turn returns `409`, so wait for `awaiting_input`. Pass `{"close": true}` to end the session. `GET /sessions` lists recent conversations across every channel.

The typed client wraps all of this:

```ts
import { TorenClient } from "@toren-run/client";

const client = new TorenClient({ url: process.env.TOREN_URL, token: process.env.TOREN_TOKEN });
const { runId } = await client.startSession({ agent: "research_crew", message: "Hi!" });
const session = await client.getSession(runId);          // state + transcript
await client.sendSessionMessage(runId, { message: "Tell me more." });
```

Sessions are one corner of the API; runs, approvals, schedules, and keys are covered in the [HTTP API guide](/guides/http-api).
