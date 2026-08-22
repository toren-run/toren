# HTTP API

*How-to: trigger runs and read results from anywhere, no VPC access needed.*

`toren dev` serves the API (port 7433 by default; `--api-port` to change), with a pinned `TOREN_API_TOKEN` or an ephemeral one it mints and prints. On AWS the load balancer fronts it, `terraform output api_url`, token in Secrets Manager (`api_token_secret_arn`). The API covers every agent the deployment serves.

All endpoints except `/healthz` require `Authorization: Bearer <token>`, either the deployment's admin token (`TOREN_API_TOKEN`, created by the Terraform module) or an issued API key (below). Key management itself accepts only the admin token.

## Trigger a run

```bash
curl -s -X POST "$API/runs" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"input": "[\"solar shipping\",\"battery freight\"]"}'
# → 202 {"runId":"...","agent":"research_crew"}
```

A deployment serves a fleet of process agents; `"agent"` in the body picks which one (omitted = the default). `"process"` picks a [named process](../reference/workflow-api.md) of that agent (omitted = its `default_process`, or `main`); the 202 echoes which one ran. Unknown agent or process names get a 400 listing what exists. `GET /runs` returns every agent's runs, each row labeled with its agent and process.

## Check status, get the result

```bash
curl -s "$API/runs/$RUN_ID" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "status": "completed",                  // or running | waiting_approval | failed
  "run": { "output": "…", "agent": "research_crew", "...": "..." },
  "waves": [ { "name": "research", "tasks": 2, "settled": 2, "done": true } ],
  "approvals": []
}
```

`GET /runs` lists everything; `GET /runs/:id/events` returns the full transcript, every recorded model call, tool call, and token count, straight from the event log.

## Approve or deny a parked run

When `status` is `waiting_approval`, the `approvals` array carries the coordinates:

```bash
curl -s -X POST "$API/runs/$RUN_ID/approvals" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"taskId":"w1t0","stepId":"s4","granted":true,"comment":"ship it"}'
```

The run wakes, executes the tool exactly once, and continues.

## Manage API keys

Issue named, individually revocable keys instead of sharing the admin token:

```bash
curl -s -X POST "$API/keys" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" -d '{"name":"ci-pipeline"}'
# → { "key": { "id": "…", "name": "ci-pipeline", "prefix": "trn_ab12cd34", "secret": "trn_…" } }
```

The `secret` appears in that response exactly once, only its SHA-256 hash is stored. `GET /keys` lists keys (never secrets); `DELETE /keys/:id` revokes immediately. Issued keys can trigger and inspect runs and resolve approvals, but cannot mint or revoke keys. The same operations exist on the CLI: `toren keys create|list|revoke`.

## Schedules

Standing configuration, admin-token only (like `/keys`): `GET /schedules`, `POST /schedules` (`{cron, input, agent?, process?, name?, tz?}`), `DELETE /schedules/:id`, `POST /schedules/:id/pause|resume`. Firing semantics, exactly-once, crash-safe, catch-up on downtime, are in the [scheduling guide](scheduling.md).

## Notes

- Responses are plain JSON; poll `GET /runs/:id` for progress (SSE streaming is roadmap).
- On AWS the API is HTTPS out of the box (CloudFront fronts the stack, `terraform output api_url`); custom domains are a two-CNAME exercise, see [HTTPS & custom domains](deploy-aws.md#https--custom-domains).
- The API only calls the same core functions the CLI uses; durability semantics are identical however a run is triggered.
