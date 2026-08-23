# MCP <Badge type="warning" text="coming soon" />

Toren will serve your agents over the Model Context Protocol, so Claude, Cursor, and any other MCP client can start sessions with them as tools. Your deployed crew becomes something a coding assistant can delegate to: "ask research_crew about X" from inside another AI's context, with the conversation durable on your infrastructure like every other channel.

The shape, following the same channel contract: an MCP server endpoint on the workers exposing one tool per agent plus session continuation, authenticated with the deployment's API keys.

This is distinct from MCP as a tool source (your agents calling out to MCP servers for search, databases, and so on), which is on the roadmap as part of [tools](/tools/defining-tools).

Watch the [repo](https://github.com/toren-run/toren) for progress.
