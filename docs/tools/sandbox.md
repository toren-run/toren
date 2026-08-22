# Sandbox

One line gives your agent a computer:

```yaml
name: builder
model: anthropic/claude-sonnet-5
sandbox: true
```

That grants the toolkit: **`bash`**, plus **`read_file`**, **`write_file`**, and **`edit_file`** operating on a durable per-run workspace. The agent can clone repos, install packages, run scripts, and edit code, in conversation or in an autonomous run. Structured file tools exist because models edit reliably with exact strings and fumble sed quoting; bash covers everything else (`ls`, `grep`, `npm install`).

Tuned:

```yaml
sandbox:
  image: node:22-slim        # what's installed on the agent's computer
  network: false             # egress from the sandbox (default: none)
  approval: always           # a human approves each bash command (default) or "never"
  env: [MY_APP_DB_URL]       # exactly which of YOUR variables the sandbox may see
```

## The trust model

Deny-by-default, like everything in Toren:

- **No secrets** reach the sandbox except the names you grant under `sandbox.env`. The runtime's own credentials (its database, model keys, API token) never enter it.
- **No network** unless `network: true`.
- **Every bash command waits for human approval** until you set `approval: never`. Workspace file reads and edits are always free: their blast radius is the workspace itself.
- Paths are workspace-relative; escapes are refused.

## The durable workspace

Each run gets one workspace. Commands and file operations are recorded in the event log like every other tool call, so a killed and resumed run replays its recorded outputs without re-executing anything, and continues in the same workspace. Locally the workspace lives on your disk (under `~/.toren/sandboxes`, or `TOREN_SANDBOX_ROOT`) and survives restarts by construction. A session with a sandbox keeps its workspace across turns: chat with your agent today, come back in three days, the files are still there.

## Where it runs

Locally, each run's sandbox is a docker container over a bind-mounted workspace; container start is sub-second on a pulled image. Docker is already part of the quickstart, and an agent declaring `sandbox` fails fast at startup when docker is missing.

On AWS <Badge type="warning" text="coming soon" />: each run will get its own dedicated sandbox task (VM-grade isolation, zero secrets, spawned on demand and gone when the run ends), with the workspace snapshotted into blob storage through the event log, so a run resumes with the same disk on any worker, hash-verified. Until that ships, deploying a sandbox-declaring agent to AWS fails at startup with a clear error.
