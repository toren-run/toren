# Database (read-only)

Give an agent read-only access to a database in one line:

```yaml
name: db_assistant
model: anthropic/claude-sonnet-5
builtin_tools: [sql_query]
```

Set `SQL_DATABASE_URL` to the database's connection string and the agent gets a `sql_query` tool: it writes a `SELECT`, runs it, and gets rows back as JSON. People ask questions in plain language; the agent translates them to SQL and answers. This is the shape behind an "ask my database" assistant, for example over [Telegram](/channels/telegram).

## Safety

The tool is read-only by construction, with defense in depth:

- **Use a read-only database role.** This is the real boundary and it is strongly recommended: point `SQL_DATABASE_URL` at a user with `SELECT`-only grants, so a write is impossible at the database, not just discouraged at the tool.
- **Two roles, always.** The runtime's `DATABASE_URL` role needs `CREATE` (it owns its own schemas); the agent's `SQL_DATABASE_URL` role must never have it. Separate roles mean a prompt-injected query cannot exceed grants the tool's role does not hold, whatever the query says.
- On top of that, the tool accepts only a single `SELECT` (or `WITH ... SELECT`), rejects write and DDL keywords, blocks stacked statements, caps returned rows, and applies a statement timeout so one heavy query cannot strain the database.

Because query results become model context, the rows the agent reads are sent to your model provider. For sensitive data, use a provider or region you are comfortable with (Toren is model-agnostic), and scope the read-only role to only the tables the agent should see.

## Data residency

The database stays wherever you run it. Deploy Toren into [your own cloud](/deploy/) and the connection never leaves your account; `SQL_DATABASE_URL` rides Secrets Manager on AWS, like the model keys. Nothing about the data touches Toren's own storage beyond the transient run transcript in the event log.
