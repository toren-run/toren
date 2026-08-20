# Deploy to AWS

*How-to — the same agent, in your account. Create everything from scratch, or connect Toren to the VPC and Postgres you already run.*

One Terraform module (`infra/terraform-aws`), two modes:

| You have | Set | Toren creates |
|---|---|---|
| Nothing — fresh account | *(defaults)* | VPC, SQS queues + DLQs, RDS Postgres, ECR, Secrets Manager entries, ALB, Fargate workers |
| A VPC (and maybe a Postgres, a load balancer) | `create_vpc=false`, `create_db=false`, `create_alb=false` — any combination | Only what you don't already have |

Either way it's your account and your data boundary — Toren has no access to anything.

## Mode 1 — create everything

```bash
toren deploy-aws --region eu-central-1 --plan-only    # preview every resource, creates nothing
toren deploy-aws --region eu-central-1 --yes          # terraform apply (billable resources!)
```

Then build and push the image to the ECR repo from the outputs (`docker build --platform linux/arm64`, `docker tag`, `docker push`), and the service pulls `:latest`. The apply prints the env lines (`TOREN_QUEUE=sqs` + queue URLs) for pointing a local CLI at the deployment.

`ANTHROPIC_API_KEY` in your environment at deploy time is stored in Secrets Manager and injected into the workers — it never lands in Terraform state variables or the image.

## Mode 2 — connect to what you already run

Each `create_*` switch replaces a group of resources with references to yours:

**Existing VPC** — workers and (if created) the DB land in your private subnets:

```hcl
create_vpc         = false
vpc_id             = "vpc-0abc..."
private_subnet_ids = ["subnet-...", "subnet-..."]
public_subnet_ids  = ["subnet-...", "subnet-..."]   # only needed when create_alb = true
```

The workers only need outbound internet (NAT or equivalent) from those subnets to reach the model API.

**Existing Postgres** — the common case: your agents' tools already query a business database, and Toren's event log can live next to it:

```hcl
create_db    = false
database_url = "postgres://toren:...@your-db.internal:5432/toren?sslmode=no-verify"
```

- Toren keeps strictly to its own schemas (`toren_control` + one per agent) — it never touches your tables. A **dedicated database on your existing instance** (`CREATE DATABASE toren`) is the recommended layout: clean permissions, trivially removable.
- Allow the worker security group (output `worker_security_group_id`) on `:5432` in your database's security group.
- Include the `sslmode` your server needs — RDS Postgres 15+ forces SSL, so `?sslmode=no-verify` at minimum.
- Sizing: the event log writes on every agent step, so load is proportional to agent activity, not user traffic. On a busy shared instance, watch write IOPS.
- Multiple Toren deployments can share one Postgres safely: queue messages are labeled by agent and each worker fleet claims only its own agents' messages, so independently scaled fleets never steal each other's work.

**Existing ingress** — skip the ALB and front the workers (`:7433`, plain HTTP, bearer auth) with whatever you already run, or keep the API VPC-internal:

```hcl
create_alb = false
```

## Worker auto-scaling (optional)

Fixed `worker_count` is the default. To scale on load instead:

```hcl
enable_autoscaling     = true
autoscaling_min        = 1
autoscaling_max        = 8
autoscaling_cpu_target = 60   # average CPU % the scaler holds
```

Parked runs cost nothing regardless — approvals and timers hold no worker, so scale-in goes all the way down to `autoscaling_min` overnight.

## Triggering and observing runs

The public front door is the [HTTP API](http-api.md): `terraform output api_url` gives the endpoint, `api_token_secret_arn` names the Secrets Manager secret holding the bearer token. `POST /runs` to trigger, `GET /runs/:id` for status and output, `POST /runs/:id/approvals` to approve — no VPC access needed. (Direct CLI access against Postgres still works from inside the VPC.)

## Costs & teardown

Full greenfield stack: roughly $50–70/month while up (NAT gateway, `db.t4g.micro`, two 1vCPU Fargate tasks). Reusing your VPC and Postgres removes the NAT and RDS line items — the marginal cost is the Fargate tasks and pennies of SQS. Tear down with `terraform -chdir=infra/terraform-aws destroy` — with `create_*=false`, destroy only removes what Toren created; your VPC and database are never touched.

## Current limits (honest)

- All queues are served by the Fargate workers; the Lambda short-task binding from the spec is a planned optimization.
- Images are pulled as `:latest` — pin digests yourself if you need immutable deploys.
- The worker exits if Postgres is unreachable at startup and relies on ECS to restart it; connect-retry with backoff is planned.
