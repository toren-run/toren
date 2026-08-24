# Telegram

A bot DM becomes a session. Create a bot with Telegram's @BotFather (it takes a minute and hands you a token), then set `TELEGRAM_BOT_TOKEN` on the workers and the channel comes up with them:

```bash
# local
TELEGRAM_BOT_TOKEN=123456:ABC... toren dev --dir examples

# AWS: deploy-aws reads the same variable and stores it in Secrets Manager
TELEGRAM_BOT_TOKEN=123456:ABC... toren deploy-aws --region eu-central-1 --yes
```

## One bot or one per agent

`TELEGRAM_BOT_TOKEN` is the **shared bot**: one DM reaches every agent in the deployment, and `/new <agent>` switches between them. That is the right default for a fleet you operate yourself.

An agent can also get its **own bot**, with its own name, avatar, and audience. Create a second bot with @BotFather and declare its token variable in that agent's `agent.yaml`:

```yaml
telegram:
  bot_token_env: REPORTER_BOT_TOKEN
```

Set `REPORTER_BOT_TOKEN` on the workers and `toren dev` starts a dedicated channel next to the shared one. A dedicated bot sees exactly one agent, so `/new` needs no argument and `/agent` has a one-line answer. Use it when an agent has its own users: the pilot's on-call bot, a reporting bot for a customer, a personal assistant that should not expose the rest of the fleet.

The modes mix freely: run only the shared bot, only dedicated ones, or both at once. Every isolation boundary is per bot:

- **Pairing is per bot.** Being paired with the shared bot grants nothing on a dedicated one, and vice versa. Mint codes for a dedicated bot with `toren channels telegram invite --agent <name>`.
- **Conversations are per bot.** The same person talking to two bots holds two independent sessions.
- **`TELEGRAM_ALLOWED_USERS` applies to all bots** — it is the operator's own allowlist, not an audience boundary. Use pairing codes to give different people different bots.

Bot identity is stored by agent name, not by token, so rotating a leaked token (via @BotFather) keeps every pairing and open conversation intact: swap the env value and restart.

On AWS, `deploy-aws` handles `TELEGRAM_BOT_TOKEN` itself; dedicated bot tokens are your own env vars, so wire them like any other secret, through `agent_env_secret_arns` ([AWS guide](../guides/deploy-aws.md)).

## Who can talk to it

Nobody, until you say so. The bot is deny-by-default: a stranger who finds it gets a polite refusal, whatever they send. Two ways in:

1. **Pairing codes.** Mint a one-time code and hand it to the person:

   ```bash
   toren channels telegram invite                    # for the shared bot
   toren channels telegram invite --agent reporter   # for an agent's dedicated bot
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

The channel runs inside the workers, and any worker can host it: they race for a Postgres advisory lock (one election per bot) and exactly one worker polls each bot at a time. If that worker dies, another takes over within seconds. Inbound updates are deduplicated through the database, and outbound replies advance a delivered-cursor with a compare-and-swap, so a crash mid-delivery never double-sends a turn and never drops one. Your chat survives deploys, worker kills, and everything else the runtime survives, because it is the runtime.
