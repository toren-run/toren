# Client SDK reference

`@toren-run/client` — a typed, zero-dependency client for the [HTTP API](../guides/http-api.md) (global `fetch`; inject your own via config for tests). Response shapes mirror the server exactly; the API tests exercise both sides against each other.

```ts
import { TorenClient } from "@toren-run/client";
const client = new TorenClient({ url: "https://agents.example.com", token: process.env.TOREN_API_TOKEN! });
```

`TorenClientConfig`: `{ url: string; token: string; fetch?: typeof fetch }`.

## Runs

| Method | Semantics |
|---|---|
| `startRun({ input, agent?, process?, files? })` | `POST /runs` → `{ runId }`. `process` selects a [named process](workflow-api.md); `files` are ids from `uploadFile` |
| `getRun(runId)` | → `RunDetail`: `{ run, status, waves, approvals }`; `status` surfaces parking as `"waiting_approval"` |
| `waitForRun(runId, { timeoutMs?, pollMs? })` | Polls until terminal or parked on approval — the remote equivalent of the CLI's drive loop. Defaults: 120s timeout, 300ms poll; throws `TorenApiError(408)` on timeout |
| `listRuns()` | → `RunSummary[]` (the newest runs across every crew) |
| `getEvents(runId)` | → the full event transcript: `{ run: events[], tasks: { taskId: events[] } }` |
| `approve(runId, { taskId, stepId, granted, comment? })` | Resolve a parked [approval](../guides/approvals.md) |
| `uploadFile({ name, data })` | `POST /files` → `{ fileId, … }`; pass `data` as `Uint8Array` or base64 string |

## Sessions

| Method | Semantics |
|---|---|
| `startSession({ message, agent?, channel?, files? })` | Open a durable conversation → `{ runId, agent }` |
| `getSession(runId)` | → `{ runId, agent, state, transcript }`; states: `working`, `awaiting_input`, `completed`, `failed`, `cancelled` |
| `sendSessionMessage(runId, { message, channel?, close?, files? })` | Send the next turn; throws `TorenApiError(409)` while the agent is mid-turn (strict turn-taking); `{ close: true }` ends the session |
| `listSessions()` | Recent conversations across every channel |

## Health and errors

`health()` → `boolean` (the unauthenticated `/healthz`). Every other failure throws `TorenApiError` with a `.status` — `401` bad token, `409` mid-turn, `404` unknown run, `400` with the server's message (e.g. an unknown agent or process, listing what exists).
