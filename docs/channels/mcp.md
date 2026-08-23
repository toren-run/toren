# MCP

*Drive durable runs from the coding agent you already use.*

Toren is an MCP server. Any MCP client can start a background run, watch it settle, read its cost, and approve its gated steps — while the run itself survives crashes, deploys, and the client disconnecting entirely. Close your editor mid-run; the run does not care.

Two transports, same tools:

## Local (stdio): zero setup, no auth

`toren mcp` serves the current agent directory over stdio, with workers running inside — the client spawns it, runs execute, done. Postgres is the only requirement (`docker compose up -d db`).

**Claude Code:**

```bash
claude mcp add toren -- npx toren mcp --dir /path/to/my-crew
```

**Any other MCP client** (Cursor, Windsurf, VS Code, or your own): register a stdio server with command `npx`, args `["toren", "mcp", "--dir", "/path/to/my-crew"]`. For Cursor and Windsurf that's an entry in `mcp.json`; consult your client's MCP docs for where it lives.

## Remote (HTTP): your deployment, your tokens

Every Toren deployment already serves MCP at `POST /mcp` — same server, same port, same bearer auth as the rest of the [HTTP API](/guides/http-api). Mint a revocable key, then point the client at it:

```bash
toren keys create my-editor
```

**Claude Code:**

```bash
claude mcp add toren --transport http https://your-deployment.example.com/mcp -H "Authorization: Bearer trn_..."
```

**Any header-capable MCP client**: transport `http` (Streamable HTTP), URL `https://your-deployment/mcp`, header `Authorization: Bearer <key>`. Cursor, Windsurf, and VS Code all support this.

**claude.ai / ChatGPT web connectors** are the one exception: they require OAuth for remote servers, which Toren does not speak yet (roadmap). Use Claude Code or another header-capable client against remote deployments in the meantime.

## The tools

| Tool | What it does |
|---|---|
| `list_agents` | What the deployment serves: agents, named processes, models, tools |
| `start_run` | Start a durable run of a named process; returns the run id immediately |
| `run_status` | State, wave progress, pending approvals, recorded errors, cost roll-up, output |
| `list_runs` | Newest runs with status |
| `cancel_run` | Retire a stuck run; queued retries become no-ops |
| `resolve_approval` | Approve or deny a parked gated tool call; the run wakes |

The demo this enables: tell Claude Code "kick off the overnight migration and check it after lunch." It starts the run, the run outlives the conversation, and any client — or the console, or `toren jobs tail` — picks it up later. Durability is what makes an agent-triggered run worth triggering.
