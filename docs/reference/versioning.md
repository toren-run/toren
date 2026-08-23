# Versioning & compatibility

Toren is pre-1.0 and says so; this page is the contract that makes upgrading boring anyway.

## The promise, by version part

All six packages (`toren-run`, `@toren-run/core`, `@toren-run/client`, `@toren-run/providers`, `@toren-run/adapters-aws`, `@toren-run/console`) version in lockstep and release together.

- **Patch (0.1.1 → 0.1.2):** never breaks anything. No schema changes, no API changes, no digest changes. Upgrade blind.
- **Minor (0.1.x → 0.2.0):** may add: schema columns and tables (always idempotently, see below), CLI flags, HTTP fields, agent.yaml keys. Existing agent directories, API calls, and databases keep working unchanged. Anything removed or renamed gets called out in the release notes with the old form still accepted for one more minor.
- **Major (1.0.0 and beyond):** the only place a breaking change may live, and release notes lead with it.

## The database migrates itself

There is no migration tool and no migration step. Every worker start runs idempotent DDL: `CREATE TABLE IF NOT EXISTS` plus `ALTER TABLE ADD COLUMN IF NOT EXISTS`, with new columns carrying defaults that make old rows valid (when the `process` column arrived, every existing run became `process = 'main'`). Upgrading is: install the new version, restart. Migrations are additive only; nothing is dropped or rewritten.

**Rollbacks are safe** for the same reason: an older version ignores columns it does not know, so stepping back a release leaves your data intact. The only one-way door would be a destructive migration, and those do not happen below a major.

## In-flight runs survive upgrades

A run that is mid-flight when you deploy resumes under the new code and replays its completed steps from the event log without re-paying them. A deploy is one of the crashes the runtime is built to shrug off. Two mechanisms guard the edges:

- **Digest stability is billing-critical and treated as such.** Each recorded model call carries a digest of its exact request; replay verifies it. The inputs to that digest are byte-stable across versions by hard rule, because changing them would silently invalidate every in-flight run's replay and re-bill users. A change that must alter digests is a breaking change, ships in a major, and is called out as exactly that.
- **Honest invalidation, surgically.** If new code genuinely changes what a step would do (you edited a prompt, or a major changed semantics), the digest mismatch invalidates only the affected suffix, records `StreamInvalidated`, and re-runs just that. Finished work before the change stays paid-for-once.
- **Rolling deploys are fine.** If old and new workers briefly overlap and disagree about a stream, the invalidation-storm guard backs the losers off past the deploy's drain window instead of letting versions fight.

## How to upgrade, per tier

- **Local / npm:** the scaffold pins `"toren-run": "^0.1.0"`, so `npm update` picks up patches and minors; restart `toren dev`.
- **Docker Compose:** pull or rebuild the image, `docker compose up -d`. The new worker migrates the schema on boot.
- **AWS:** the documented promote pattern: build the image once with an immutable git-SHA tag, pin that tag in tfvars, `toren deploy-aws`. Never point production at `:latest`.

## What this page does not promise yet

Pre-1.0, the API surface is still allowed to move at minors (with the one-minor deprecation grace above). The TypeScript host API (`startRun`, `TickDeps`, `LocalWorkerRuntime`) is the least settled surface; the CLI, agent.yaml, the HTTP API, and the event log format are the most settled. When 1.0 lands, everything on this page hardens into semver proper.
