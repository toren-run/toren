# Deploying Toren

The runtime's requirements are deliberately tiny: **a container and Postgres.** Everything else — the queue, the console, the channels, the sandbox — lives inside that. So deployment is a ladder, and every rung runs the identical runtime:

| Tier | What it is | For |
| --- | --- | --- |
| **Local** | `toren dev` on your machine, Postgres in docker | Developing agents; the [quickstart](/quickstart) |
| **[Docker Compose](/deploy/compose)** | One compose file, any box | Self-hosting: a VPS, a homelab, Fly, K8s |
| **[AWS reference architecture](/guides/deploy-aws)** | One Terraform module in your account | Production: autoscaling, HTTPS, Secrets Manager, SQS |

The same agent directory moves up the ladder unchanged: develop locally, self-host on a box, graduate to the AWS module when you want managed Postgres, queue-backed workers, and a load balancer. Durability is identical at every tier because it lives in the event log, not the infrastructure.

Start with compose if you just want Toren running somewhere today. Reach for the AWS module when you want a production posture in your own account; it is a reference architecture — read it, fork it, or use it as-is.
