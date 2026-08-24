# Telegram

A bot DM becomes a session. The agent is the persona and the bot is its identity: its own name, avatar, and audience. Create a bot with Telegram's @BotFather (it takes a minute and hands you a token), declare the token's env var in the agent's `agent.yaml`:

```yaml
telegram:
  bot_token_env: REPORTER_BOT_TOKEN
```

then set that variable on the workers and the channel comes up with them:

```bash
REPORTER_BOT_TOKEN=123456:ABC... toren dev --dir .
```

Each agent that should be reachable on Telegram gets its own BotFather bot and its own `bot_token_env`. A bot sees exactly one agent and nothing else: someone you pair with the reporter bot cannot see, list, or reach the rest of the fleet. That is the shape for real audiences — an on-call bot, a reporting bot for a customer, a personal assistant.

## The fleet bot (operators only)

There is a second mode: set `TELEGRAM_BOT_TOKEN` on the workers (no agent.yaml needed) and you get one **fleet bot** that reaches *every* agent in the deployment — `/agent` lists the roster, `/new <agent>` switches. It is a switchboard for you, the operator.

**Do not hand fleet-bot invites to outsiders.** Anyone paired with it sees the full roster and can talk to any agent. Give people dedicated bots instead.

The modes mix freely: only dedicated bots, only the fleet bot, or both at once. Every isolation boundary is per bot:

- **Pairing is per bot.** Being paired with one bot grants nothing on another. Mint codes for a dedicated bot with `toren channels telegram invite --agent <name>`; a bare `invite` mints for the fleet bot.
- **Conversations are per bot.** The same person talking to two bots holds two independent sessions.
- **`TELEGRAM_ALLOWED_USERS` applies to all bots** — it is the operator's own allowlist, not an audience boundary. Use pairing codes to give different people different bots.

Bot identity is stored by agent name, not by token, so rotating a leaked token (via @BotFather) keeps every pairing and open conversation intact: swap the env value and restart.

On AWS, dedicated bot tokens are your own env vars: wire them like any other secret, through `agent_env_secret_arns` ([AWS guide](../guides/deploy-aws.md)). The fleet bot's `TELEGRAM_BOT_TOKEN` is handled by `deploy-aws` itself and stored in Secrets Manager.

## Who can talk to it

Nobody, until you say so. The bot is deny-by-default: a stranger who finds it gets a polite refusal, whatever they send. Two ways in:

1. **Pairing codes.** Mint a one-time code and hand it to the person:

   ```bash
   toren channels telegram invite --agent reporter   # for an agent's dedicated bot
   toren channels telegram invite                    # for the fleet bot
   ```

   They DM the code to the bot, the code burns, and they are paired from then on. On a deployment, mint codes through the API instead: `POST /channels/telegram/invites` with the admin token.

2. **Allowlist.** Set `TELEGRAM_ALLOWED_USERS` to comma-separated numeric Telegram user IDs. Those users are always in, no code needed.

## Talking

Just send a message: it continues your open conversation, or starts one. The bot shows a typing indicator while the agent works.

| Command | What it does |
| --- | --- |
| `/new [agent]` | Start a fresh conversation (`[agent]` only matters on the fleet bot) |
| `/agent` | Who you are talking to; on the fleet bot, the full roster |
| `/end` | Close the open conversation |

## Durability, same as everywhere else

The channel runs inside the workers, and any worker can host it: they race for a Postgres advisory lock (one election per bot) and exactly one worker polls each bot at a time. If that worker dies, another takes over within seconds. Inbound updates are deduplicated through the database, and outbound replies advance a delivered-cursor with a compare-and-swap, so a crash mid-delivery never double-sends a turn and never drops one. Your chat survives deploys, worker kills, and everything else the runtime survives, because it is the runtime.
