# AWS reference architecture

*The production posture, in your account: autoscaling workers, RDS, SQS, Secrets Manager, HTTPS via CloudFront. Create everything from scratch, or connect Toren to the VPC and Postgres you already run.*

This is a reference architecture, not the only way to run Toren: the runtime itself needs just a container and Postgres, and the [Docker Compose tier](/deploy/compose) self-hosts it anywhere. Use this module when you want the managed-AWS posture; read it, fork it, or use it as-is. Run with `--plan-only` first: it shows every resource before anything is created, and account-specific obstacles (quotas, permission boundaries) surface there rather than mid-apply.

One Terraform module (`infra/terraform-aws`), two modes:

| You have | Set | Toren creates |
|---|---|---|
| Nothing (fresh account) | *(defaults)* | VPC, SQS queues + DLQs, RDS Postgres, ECR, Secrets Manager entries, ALB, Fargate workers |
| A VPC (and maybe a Postgres, a load balancer) | `create_vpc=false`, `create_db=false`, `create_alb=false`, any combination | Only what you don't already have |

Either way it's your account and your data boundary. Toren has no access to anything.

## Mode 1: create everything

```bash
toren deploy-aws --region eu-central-1 --plan-only                      # preview, creates nothing
toren deploy-aws --region eu-central-1 --image-context . --yes          # the whole pipeline
```

With `--image-context`, one command does the full deployment in the right order: the ECR repo is created first (targeted apply), your agent image is built for `linux/arm64` (matching the Fargate runtime platform) and **tagged with your git SHA, never `:latest`**. Docker logs into ECR via the AWS SDK (no `get-login-password` incantation), the image is pushed, and the final apply pins that exact tag into the task definition, which is what rolls the service. Every deploy is a rollback-able version by construction. `toren init` scaffolds the Dockerfile this builds.

Prefer to manage images yourself? Skip `--image-context`, push to the ECR repo from the outputs manually, and pass `--image <uri:tag>`. Either way the apply prints the env lines (`TOREN_QUEUE=sqs` + queue URLs) for pointing a local CLI at the deployment.

`ANTHROPIC_API_KEY` in your environment at deploy time is stored in Secrets Manager and injected into the workers, it never lands in the image. Like any Terraform-managed secret it does appear in your local state file, so protect the state (or skip the variable and wire the key through `agent_env_secret_arns` instead, that path never touches state).

Injection is least-privilege: the ECS execution role can read exactly the listed secret ARNs and nothing else, values land as env vars at container start, and the task role the agent code runs under has no Secrets Manager permissions at all. Running agents cannot read secrets beyond what was injected.

## Mode 2: connect to what you already run

Each `create_*` switch replaces a group of resources with references to yours:

**Existing VPC**: workers and (if created) the DB land in your private subnets:

```hcl
create_vpc         = false
vpc_id             = "vpc-0abc..."
private_subnet_ids = ["subnet-...", "subnet-..."]
public_subnet_ids  = ["subnet-...", "subnet-..."]   # only needed when create_alb = true
```

The workers only need outbound internet (NAT or equivalent) from those subnets to reach the model API.

**Existing Postgres**, the common case, where your agents' tools already query a business database, and Toren's event log can live next to it:

```hcl
create_db    = false
database_url = "postgres://toren:...@your-db.internal:5432/toren?sslmode=no-verify"
```

- Toren keeps strictly to its own schemas (`toren_control` + one per agent); it never touches your tables. A **dedicated database on your existing instance** (`CREATE DATABASE toren`) is the recommended layout: clean permissions, trivially removable.
- Allow the worker security group (output `worker_security_group_id`) on `:5432` in your database's security group.
- Include the `sslmode` your server needs, RDS Postgres 15+ forces SSL, so `?sslmode=no-verify` at minimum.
- Sizing: the event log writes on every agent step, so load is proportional to agent activity, not user traffic. On a busy shared instance, watch write IOPS.
- Multiple Toren deployments can share one Postgres safely: queue messages are labeled by agent and each worker fleet claims only its own agents' messages, so independently scaled fleets never steal each other's work.

**Existing ingress**: skip the ALB and front the workers (`:7433`, plain HTTP, bearer auth) with whatever you already run, or keep the API VPC-internal:

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

Parked runs cost nothing regardless (approvals and timers hold no worker), so scale-in goes all the way down to `autoscaling_min` overnight.

## HTTPS & custom domains

**Out of the box you already have HTTPS.** The stack fronts the load balancer with CloudFront, whose `*.cloudfront.net` domain ships with a trusted certificate, so `terraform output api_url` gives you an `https://…cloudfront.net` URL that every browser accepts on the first click. That one URL is the front door for *everything*: the web console (`…/console`), the HTTP API, the TypeScript SDK (`new TorenClient({ url })`), and `.toren/environments.json` profiles. The CDN is a pure pass-through (caching disabled, all methods and auth headers forwarded); it exists for its certificate, not for caching. Turn it off with `create_cdn = false` if you bring your own ingress.

**Connecting your own domain** (say, `agents.yourco.com`): pick one of two paths:

*Path A: through the built-in CDN (recommended).*

1. Request a free ACM certificate for `agents.yourco.com`, **in `us-east-1`**, regardless of your stack's region (CloudFront requirement): `aws acm request-certificate --domain-name agents.yourco.com --validation-method DNS --region us-east-1`
2. ACM gives you one validation CNAME; add it at your DNS provider; the cert issues in minutes.
3. Apply with the cert attached: `cdn_aliases = ["agents.yourco.com"]` and `cdn_certificate_arn = "<the us-east-1 cert arn>"`.
4. Add the routing CNAME: `agents.yourco.com → <terraform output cdn_domain>`.

Done: `https://agents.yourco.com/console` and the same host for the API and SDK.

*Path B: directly on the ALB, no CDN.* set `create_cdn = false` and `acm_certificate_arn` to a certificate **in the stack's own region**; the module's HTTPS `:443` listener activates automatically. CNAME your domain to `terraform output alb_dns`. Choose this when you already run a CDN or WAF of your own in front.

Hardening note (roadmap): with the CDN in place, edge→ALB traffic inside AWS is plain HTTP and the ALB remains directly reachable; locking the ALB to CloudFront-only requests is a planned option.

## Triggering and observing runs

The public front door is the [HTTP API](http-api.md): `terraform output api_url` gives the endpoint, `api_token_secret_arn` names the Secrets Manager secret holding the bearer token. `POST /runs` to trigger, `GET /runs/:id` for status and output, `POST /runs/:id/approvals` to approve, no VPC access needed. (Direct CLI access against Postgres still works from inside the VPC.)

## Production checklist

The quickstart flow keeps Terraform state on your machine, fine for a rehearsal, wrong for anything that outlives your laptop. Before a real deployment:

**1. Remote state (do this first).** One flag does everything:

```bash
toren deploy-aws --region eu-central-1 --profile yourco \
  --state-bucket yourco-toren-tfstate --plan-only
```

If the bucket doesn't exist, Toren creates it (versioned, all public access blocked), wires the S3 backend with native state locking (no DynamoDB table needed), and migrates any existing local state in automatically. Without `--state-bucket` the CLI warns that state is local, fine for a rehearsal, wrong for anything that outlives your laptop.

Driving Terraform by hand instead? The same setup manually: versioned S3 bucket, a multi-line `backend.tf` with `terraform { backend "s3" {} }`, and `envs/backend.hcl.example` as your `-backend-config` (the module ships inside the `toren-run` npm package under `terraform-aws/`).

**2. HTTPS.** Already on by default via the CloudFront front (`api_url` is `https://`). For a branded domain, follow [HTTPS & custom domains](#https--custom-domains).

**3. Pin the image.** `--image-context` does this automatically (git-SHA tags). If you manage images yourself, deploy `image = "<ecr>:<git-sha>"`, never `:latest`, so a rollback is a one-variable change.

**4. Secrets via ARN references.** Use `agent_env_secret_arns` for anything sensitive rather than the `anthropic_api_key` convenience variable, ARN references never touch Terraform state.

**5. Issue API keys per consumer** (`toren keys create ci-pipeline`) instead of sharing the admin token; the admin token stays in the operator's hands only.

**6. Size the database for agent activity.** The event log writes on every step; `db.t4g.micro` is a pilot size, not a production one, if agents run continuously.

## Costs & teardown

Full greenfield stack: roughly $50–70/month while up (NAT gateway, `db.t4g.micro`, two 1vCPU Fargate tasks). Reusing your VPC and Postgres removes the NAT and RDS line items, the marginal cost is the Fargate tasks and pennies of SQS. Tear down with `terraform -chdir=infra/terraform-aws destroy`, with `create_*=false`, destroy only removes what Toren created; your VPC and database are never touched.

## Current limits (honest)

- All queues are served by the Fargate workers; the Lambda short-task binding from the spec is a planned optimization.
- Images are pulled as `:latest`, pin digests yourself if you need immutable deploys.
- The worker exits if Postgres is unreachable at startup and relies on ECS to restart it; connect-retry with backoff is planned.
