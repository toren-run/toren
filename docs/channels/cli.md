# CLI

`toren chat` turns your terminal into a channel:

```bash
toren chat                       # chat with the default agent, local runtime
toren chat --agent support_bot   # pick an agent
toren chat --env prod            # chat with a deployment over its HTTP API
```

Type to talk. The agent's replies stream in as they land, `/end` closes the conversation, and Ctrl+C walks away without closing it. Because the session is durable, walking away costs nothing and loses nothing:

```bash
toren chat --session 1efff171-d77c-4d30-b7f7-b1057c8f82c7   # pick up where you left off
```

The resume line is printed whenever you leave a conversation open. The full transcript replays from the event log, then the prompt is yours again.

With `--env local` (the default) the CLI runs workers in-process against your database, so it works with nothing but Postgres up. With an API environment profile it speaks to a deployment through the same `/sessions` endpoints every other channel uses; see [Environments](/guides/environments) for profile setup.
