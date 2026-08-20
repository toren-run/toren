# HTTP API

*How-to — trigger runs and read results from anywhere, no VPC access needed.*

`toren dev` serves the API whenever `TOREN_API_TOKEN` is set (port 7433 by default; `--api-port` to change). On AWS the load balancer fronts it — `terraform output api_url`, token in Secrets Manager (`api_token_secret_arn`). One agent per deployment (v0).

All endpoints except `/healthz` require `Authorization: Bearer <token>`.

## Trigger a run

```bash
curl -s -X POST "$API/runs" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"input": "[\"solar shipping\",\"battery freight\"]"}'
# → 202 {"runId":"..."}
```

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

`GET /runs` lists everything; `GET /runs/:id/events` returns the full transcript — every recorded model call, tool call, and token count, straight from the event log.

## Approve or deny a parked run

When `status` is `waiting_approval`, the `approvals` array carries the coordinates:

```bash
curl -s -X POST "$API/runs/$RUN_ID/approvals" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"taskId":"w1t0","stepId":"s4","granted":true,"comment":"ship it"}'
```

The run wakes, executes the tool exactly once, and continues.

## Notes

- Responses are plain JSON; poll `GET /runs/:id` for progress (SSE streaming is roadmap — spec §19).
- Without `acm_certificate_arn` the AWS listener is plain HTTP — fine for a pilot behind a strong token, but set a certificate for anything real.
- The API only calls the same core functions the CLI uses; durability semantics are identical however a run is triggered.
