# Channels

A channel is any surface where a person talks to your agents. Under every channel sits the same thing: a [durable session](/guides/sessions) whose transcript is the event log. Start a conversation in one place and it is visible everywhere, tagged with the channel each message arrived from. A session parked between turns costs nothing, and a deploy or worker kill mid-reply resumes the turn without re-paying the model call.

| Channel | Status | What it looks like |
| --- | --- | --- |
| [Console](/channels/console) | shipped | Chat in the deployment's web console |
| [CLI](/channels/cli) | shipped | `toren chat` in your terminal |
| [HTTP API](/channels/http-api) | shipped | `POST /sessions` from anything that speaks JSON |
| [Telegram](/channels/telegram) | shipped | Each agent its own bot; DMs, deny-by-default |
| [MCP](/channels/mcp) | coming soon | Your agents as tools inside Claude, Cursor, and friends |
| [WhatsApp](/channels/whatsapp) | coming soon | Same model as Telegram |

Because channels share one session protocol, adding a new one never touches the runtime: a channel translates between its surface and three operations (start a session, send a turn, read the transcript). That is the entire contract.
