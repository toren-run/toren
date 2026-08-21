# Sessions & channels

A session is a conversation with an agent that survives anything. Under the hood it is a durable run in session mode: the transcript is the event log, every turn is replay-verified, and a session that sits idle for a week costs nothing while it waits. When you send the next message, the worker folds the whole conversation back from Postgres and continues exactly where it left off.

Three properties fall out of the event-sourced core, for free:

- **Parked turns cost zero compute.** Between your message and the next, no process is running and no tokens are burning. The conversation is just rows in Postgres.
- **A resumed session never re-pays a turn.** Kill the worker mid-reply and the successor replays the transcript from the log; completed model calls are never re-billed.
- **Turn-taking is strict.** A message is accepted only while the agent is waiting for input. Mid-turn, the stream has exactly one writer (the worker), so there is no race between your text and the agent's.

Sessions always talk to the crew's root agent. If the crew has a custom batch workflow (one that parses structured input, fans out waves, and so on), a conversation never touches it: chat goes to the agent, jobs go to the workflow.

## Starting a session

Over HTTP:

```bash
curl -X POST "$TOREN_URL/sessions" \
  -H "Authorization: Bearer $TOREN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent": "research_crew", "message": "Hi! What can you do?"}'
```

The response is `{"runId": "...", "agent": "research_crew"}`. Poll `GET /sessions/:id` for the transcript and state (`working`, `awaiting_input`, `completed`, `failed`), and send the next turn with:

```bash
curl -X POST "$TOREN_URL/sessions/$RUN_ID/messages" \
  -H "Authorization: Bearer $TOREN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Tell me more."}'
```

Sending while the agent is mid-turn returns `409`; wait for `awaiting_input`. Pass `{"close": true}` to end the session, which completes the run.

## Channels

A channel is any surface that speaks the session protocol. They all share one transcript per session, and each message records which channel it arrived from.

**Console.** The deployment console has a Sessions page: start a conversation with any agent, watch it think, and close it when you are done. Open conversations live here, not in the Runs table.

**HTTP API.** The endpoints above. Anything that can POST JSON can hold a conversation with your agents.

**Telegram.** A bot DM becomes a session. See below.

## The Telegram channel

Set `TELEGRAM_BOT_TOKEN` on the workers and the channel comes up with them. Create the bot itself with Telegram's @BotFather (takes a minute; it gives you the token).

```bash
# local
TELEGRAM_BOT_TOKEN=123456:ABC... toren dev --dir examples

# AWS: the deploy reads the same variables and stores the token in Secrets Manager
TELEGRAM_BOT_TOKEN=123456:ABC... toren deploy-aws --region eu-central-1 --yes
```

### Who can talk to it

Nobody, until you say so. The bot is deny-by-default: a stranger who finds it gets a polite refusal, whatever they send. There are two ways in:

1. **Pairing codes.** Mint a one-time code and hand it to the person:

   ```bash
   toren channels telegram invite
   ```

   They DM the code to the bot, the code burns, and they are paired from then on.

2. **Allowlist.** Set `TELEGRAM_ALLOWED_USERS` to comma-separated numeric Telegram user IDs. Those users are always in, no code needed.

### Talking

Just send a message: it continues your open conversation, or starts one with the default agent. The bot shows a typing indicator while the agent works.

| Command | What it does |
| --- | --- |
| `/new [agent]` | Start a fresh conversation, optionally with a named agent |
| `/agent` | List the deployment's agents and who you are talking to |
| `/end` | Close the open conversation |

### Durability, same as everywhere else

The channel runs inside the workers, and any worker can host it: they race for a Postgres advisory lock and exactly one polls Telegram at a time. If that worker dies, another takes over within seconds. Inbound updates are deduplicated through the database, and outbound replies advance a delivered-cursor with a compare-and-swap, so a crash mid-delivery never double-sends a turn and never drops one. Your chat survives deploys, worker kills, and everything else the runtime survives, because it is the runtime.
