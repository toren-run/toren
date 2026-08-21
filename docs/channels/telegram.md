# Telegram

A bot DM becomes a session. Create a bot with Telegram's @BotFather (it takes a minute and hands you a token), then set `TELEGRAM_BOT_TOKEN` on the workers and the channel comes up with them:

```bash
# local
TELEGRAM_BOT_TOKEN=123456:ABC... toren dev --dir examples

# AWS: deploy-aws reads the same variable and stores it in Secrets Manager
TELEGRAM_BOT_TOKEN=123456:ABC... toren deploy-aws --region eu-central-1 --yes
```

## Who can talk to it

Nobody, until you say so. The bot is deny-by-default: a stranger who finds it gets a polite refusal, whatever they send. Two ways in:

1. **Pairing codes.** Mint a one-time code and hand it to the person:

   ```bash
   toren channels telegram invite
   ```

   They DM the code to the bot, the code burns, and they are paired from then on. On a deployment, mint codes through the API instead: `POST /channels/telegram/invites` with the admin token.

2. **Allowlist.** Set `TELEGRAM_ALLOWED_USERS` to comma-separated numeric Telegram user IDs. Those users are always in, no code needed.

## Talking

Just send a message: it continues your open conversation, or starts one with the default agent. The bot shows a typing indicator while the agent works.

| Command | What it does |
| --- | --- |
| `/new [agent]` | Start a fresh conversation, optionally with a named agent |
| `/agent` | List the deployment's agents and who you are talking to |
| `/end` | Close the open conversation |

## Durability, same as everywhere else

The channel runs inside the workers, and any worker can host it: they race for a Postgres advisory lock and exactly one polls Telegram at a time. If that worker dies, another takes over within seconds. Inbound updates are deduplicated through the database, and outbound replies advance a delivered-cursor with a compare-and-swap, so a crash mid-delivery never double-sends a turn and never drops one. Your chat survives deploys, worker kills, and everything else the runtime survives, because it is the runtime.
