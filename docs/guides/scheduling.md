# Scheduling

*How-to: cron-triggered runs that fire exactly once, even through crashes.*

```bash
toren schedule create --cron "0 9 * * 1-5" --input '["morning briefing"]' --name weekday-brief
toren schedule list
toren schedule pause <id>     # keeps the schedule, stops firing
toren schedule resume <id>    # recomputes the next fire from now, no catch-up burst
toren schedule rm <id>
```

Expressions are standard cron (five fields, or six with leading seconds), evaluated in the schedule's timezone (`--tz Europe/Berlin`; default UTC, DST transitions handled correctly). `--agent` targets any agent the deployment serves; the default is the `--dir` agent.

## Why it can't miss or double-fire

Schedules live in Postgres, not in any process. **No process ever holds a timer**, so nothing is lost when processes die. The workers' guardian sweep (every ~5s) fires whatever is due, in two crash-safe phases:

1. **Record the intent:** one transaction claims the due schedule (`FOR UPDATE SKIP LOCKED`), advances `next_fire_at`, and writes a *fire record* uniquely keyed by (schedule, scheduled moment) with a pre-assigned run id.
2. **Fulfill it, idempotently:** every unsettled fire record gets its run created (racing workers can't create two: the run id is fixed) and is marked settled.

A crash between any two writes is healed by the next sweep: fire records are truth, sweeps are just executors. It's the same hints-not-truth discipline as the rest of the runtime. This isn't asserted, it's tested: the schedule kill-matrix crashes the process after **every write point** in the fire path and proves each occurrence produced exactly one run.

**Downtime:** if all workers are down across fire times, the missed occurrences collapse into one catch-up run on revival, and the fire record keeps the originally scheduled time, so lateness is visible in the log, never silently swallowed. `next_fire_at` then advances to the next *future* occurrence.

## Console & API

The console's **Schedules** page (admin) lists every schedule with a live next-fire countdown, create form, and pause/resume/delete. Over HTTP (admin token only, like `/keys`): `GET/POST /schedules`, `DELETE /schedules/:id`, `POST /schedules/:id/pause|resume`.

Fleet-aware: each worker fires only schedules for agents it serves, so independently deployed fleets sharing one database never fire each other's schedules.
