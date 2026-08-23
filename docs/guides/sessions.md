# Sessions

A session is a conversation with an agent that survives anything. Under the hood it is a durable run in session mode: the transcript is the event log, every turn is replay-verified, and a session that sits idle for a week costs nothing while it waits. When the next message arrives, the worker folds the whole conversation back from Postgres and continues exactly where it left off.

Three properties fall out of the event-sourced core, for free:

- **Parked turns cost zero compute.** Between your message and the next, no process is running and no tokens are burning. The conversation is just rows in Postgres.
- **A resumed session never re-pays a turn.** Kill the worker mid-reply and the successor replays the transcript from the log; completed model calls are never re-billed.
- **Turn-taking is strict.** A message is accepted only while the agent is waiting for input. Mid-turn, the stream has exactly one writer (the worker), so there is no race between your text and the agent's.

Sessions always talk to the crew's root agent. If the crew has a custom batch workflow (one that parses structured input, fans out waves, and so on), a conversation never touches it: chat goes to the agent, jobs go to the workflow. The bridge between the two is [background runs](background-runs.md): with the `run_process` builtin the conversation can trigger a named workflow as a durable run and get messaged when it settles.

## Where you talk

Every surface is a [channel](/channels/) over the same session protocol: the [console](/channels/console), the [CLI](/channels/cli) (`toren chat`), the [HTTP API](/channels/http-api), and [Telegram](/channels/telegram), with WhatsApp on the way. Background runs are also drivable from [MCP clients](/channels/mcp) like Claude Code and Cursor. A conversation started in one is visible in all of them, each message tagged with the channel it arrived from.

## Lifecycle

A session is `working` while the agent owns the turn, `awaiting_input` while you do, and `completed` once closed. Closing is explicit (`/end` in chat channels, `{"close": true}` over HTTP); until then the conversation stays open indefinitely at zero cost. Each turn gets a fresh step budget, so long conversations never starve against `maxSteps`.
