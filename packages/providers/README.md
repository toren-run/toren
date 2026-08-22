# @toren-run/providers

Model provider adapters for [Toren](https://toren.run): Anthropic and OpenAI, mapped onto the runtime's normalized transcript shape so every call lands in the durable event log the same way. Routing is by model prefix in `agent.yaml` (`anthropic/claude-opus-5`, `openai/gpt-4o`); each SDK loads lazily on first use, so a deployment that never routes a prefix never parses that SDK.

Installed automatically with the `toren-run` CLI. **Docs:** [toren.run/docs](https://toren.run/docs). Apache-2.0.
