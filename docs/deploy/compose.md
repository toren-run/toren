# Docker Compose

The whole runtime on one box: Postgres plus the worker, one file, no cloud account. This is the recommended self-host path.

```bash
git clone https://github.com/toren-run/toren
cd toren
TOREN_API_TOKEN=$(openssl rand -hex 24) docker compose -f deploy/docker-compose.yml up -d
```

That's the entire install. The worker serves your agents, the HTTP API, and the web console on port `7433`; the queue runs on Postgres, so there is nothing else to operate. Check it:

```bash
curl -s localhost:7433/healthz
```

Open the console at `http://your-box:7433/console/#token=<your TOREN_API_TOKEN>`.

## Your agents

The stock file serves the example agents baked into the image. To serve your own, point the build at a directory of agent folders, or mount one and change the `command`:

```yaml
  toren:
    build:
      context: ..
    command: ["dev", "--dir", "/agents"]
    volumes:
      - ./my-agents:/agents
```

Set the model keys your agents need (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TAVILY_API_KEY` for web search) in the environment or a `.env` file next to the compose file. `TELEGRAM_BOT_TOKEN` brings the [Telegram channel](/channels/telegram) up with the workers.

## Sandbox agents on compose

Agents with `sandbox: true` are **not supported on this default tier**, on purpose. Running per-run sandbox containers from inside the worker container would require mounting the host docker socket, which is root-on-host equivalent and unsafe to ship as a default. Two supported paths for sandbox agents today: run them locally with `toren dev` against your own docker daemon, or on the [AWS tier](/guides/deploy-aws) with an E2B sandbox backend. A hardened rootless-docker compose profile is planned.

## Operating it

- **Updates**: `git pull && docker compose -f deploy/docker-compose.yml up -d --build`. Rolling a new version mid-run is safe: durability lives in the event log, and in-flight work resumes without re-paying model calls.
- **Backups**: Postgres is the only state. `pg_dump` the `toren` database and you hold every run, transcript, and schedule.
- **HTTPS**: put your usual reverse proxy (Caddy, nginx, Traefik) in front of port 7433.
- **Scale**: this tier is one box on purpose. When you outgrow it, the [AWS reference architecture](/guides/deploy-aws) has autoscaling workers, RDS, SQS, and CloudFront, and your agent directory moves unchanged.
