# Sandbox

One line gives your agent a computer:

```yaml
name: builder
model: anthropic/claude-sonnet-5
sandbox: true
```

That grants the toolkit: **`bash`**, plus **`read_file`**, **`write_file`**, and **`edit_file`** operating on a durable per-run workspace. The agent can clone repos, install packages, run scripts, and edit code, in conversation or in an autonomous run. Structured file tools exist because models edit reliably with exact strings and fumble sed quoting; bash covers everything else (`ls`, `grep`, `npm install`).

## Using it

Talk to a sandbox agent and it works in the workspace as it goes:

```bash
toren chat coder --agent coder
# you> clone github.com/me/repo, run the tests, and tell me what fails
```

Or hand it an autonomous job:

```bash
toren run coder --input "Add input validation to src/api.ts, run the tests, and report."
```

Same over the API (`POST /runs` or `POST /sessions` with the sandbox agent) and from Telegram. The workspace is the agent's; you never touch it directly.

Tuned:

```yaml
sandbox:
  image: node:22-slim        # docker image (local) or E2B template (cloud); default has node, python, git
  network: false             # egress from the sandbox (default: none)
  approval: always           # a human approves each bash command (default) or "never"
  env: [MY_APP_DB_URL]       # exactly which of YOUR variables the sandbox may see
```

`image` is interpreted by the backend: a docker image tag for the local backend, an [E2B template](https://e2b.dev/docs) name for the cloud one. Omit it for a sensible default (node, python, git preinstalled).

## The trust model

Deny-by-default, like everything in Toren:

- **No secrets** reach the sandbox except the names you grant under `sandbox.env`. The runtime's own credentials (its database, model keys, API token) never enter it.
- **No network** unless `network: true`.
- **Every bash command waits for human approval** until you set `approval: never`. Workspace file reads and edits are always free: their blast radius is the workspace itself.
- Paths are workspace-relative; escapes are refused.

## The durable workspace

Each run gets one workspace. Commands and file operations are recorded in the event log like every other tool call, so a killed and resumed run replays its recorded outputs and continues in the same workspace rather than starting the whole run over. Locally the workspace lives on your disk (under `~/.toren/sandboxes`, or `TOREN_SANDBOX_ROOT`) and survives restarts by construction; on the E2B backend the sandbox is reconnected by its recorded id. A session with a sandbox keeps its workspace across turns: chat with your agent today, come back in three days, the files are still there.

**Honest guarantee.** The event log is the source of truth; the workspace is restored best-effort. A completed command replays its recorded output for free. But a command interrupted mid-execution (recorded as started, not yet completed) is re-run on resume, so `bash` side effects are **at-least-once**, not exactly-once. Idempotent work (writing a file, `git checkout`) is safe; a non-idempotent command (`git push`, `curl -X POST`, an append) could apply twice across a crash. Gate those behind `approval` or make them idempotent.

## Where it runs: choosing a backend

`agent.yaml` says *what* the sandbox can do; the operator picks *where* it runs with the `TOREN_SANDBOX` environment variable, the same way `TOREN_QUEUE` picks the queue:

| `TOREN_SANDBOX` | Backend | Needs |
| --- | --- | --- |
| `auto` (default) | E2B if `E2B_API_KEY` is set, else local docker | one of the two below |
| `docker` | local docker container per run | a running docker daemon |
| `e2b` | E2B cloud microVM per run | `E2B_API_KEY` |
| `none` | disabled | sandbox agents fail fast |

Whatever the choice, the agent's tools and behavior are identical; only the execution substrate changes. A wrong or unavailable choice fails fast at startup with a message naming the fix.

**Local docker** starts a container over a bind-mounted workspace (sub-second on a pulled image). Good for development; docker is already part of the quickstart.

**E2B** runs each run's workspace in a Firecracker microVM and is the backend for cloud deployments, where docker is unavailable. Each run's sandbox id is recorded durably, so a worker that dies mid-run is replaced by one that reconnects to the *same* sandbox (same disk) rather than starting over. Get a key at [e2b.dev](https://e2b.dev); the free tier covers development. On AWS, `deploy-aws` reads `E2B_API_KEY` and stores it in Secrets Manager like the model keys.

The [Docker Compose tier](/deploy/compose) uses `e2b` (its default `auto` resolves to E2B when you set `E2B_API_KEY`); local docker sandboxes are intentionally not run from inside the compose worker container.
