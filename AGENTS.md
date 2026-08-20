# AGENTS.md

Toren: an open-source durable agent runtime — TypeScript, pnpm monorepo, Node 22, Postgres 16. Everything durable is an append-only event log; correctness under crashes is the product. Read `docs/concepts/durability.md` and `docs/concepts/architecture.md` before touching core semantics.

## Commands

```bash
docker compose up -d db --wait     # dev Postgres (localhost:5433) — required by most tests
pnpm install                       # workspace install
pnpm typecheck                     # tsc over all packages (tsconfig.typecheck.json)
pnpm test                          # full suite (~15s; live tests self-skip without keys)
pnpm test packages/core/test/loop.test.ts        # single file
ANTHROPIC_API_KEY=... pnpm test packages/cli/test/live-e2e.test.ts   # live (costs cents)
node packages/cli/bin/toren.js run examples/research-crew --input '["a","b"]'  # real CLI, offline
```

## Layout

- `packages/core` — event log, loop, orchestrator, worker, guardians, approvals. **Depends on nothing environment-specific.** All durability logic lives here.
- `packages/providers` — model adapters (Anthropic). `packages/adapters-aws` — SQS. `packages/cli` — `toren` bin, loader, deploy. `packages/client` — TypeScript SDK. `packages/console` — the web console `toren dev` serves at /console (Preact + esbuild, static). `examples/research-crew` — canonical offline agent. `infra/terraform-aws` — the AWS module.
- Developer docs under `docs/` (VitePress; `pnpm docs:dev`).

## Hard rules — do not break these

- **Never weaken a durability invariant.** The chaos suites (`chaos-task`, `chaos-run`) kill the stack after every DB write and assert each model call is paid exactly once. If your change makes them flaky, the change is wrong, not the test.
- **Digest stability is billing-critical.** `canonicalDigest` inputs (request canonicalization in `loop.ts`, wave plans in `workflow.ts`) must be byte-stable across versions — any change silently invalidates every in-flight run's replay and re-bills users. Treat as a breaking change requiring explicit sign-off.
- **Single-writer discipline:** only a lease holder appends to a stream; every append passes `expectedSeq`. Never write around `PgStateStore.append`.
- **Queue messages are hints, never truth.** Any handler must be a harmless no-op on duplicate or stale delivery.
- **Workflow-visible behavior must be deterministic on replay** — no `Date.now()`/`Math.random()`/I-O in orchestrator or workflow paths; recorded side effects only.
- **No cloud emulation** (no LocalStack). Adapters implement interfaces; AWS behavior is tested with fakes + creds-gated live tests.
- `@toren/core` gets no new runtime dependencies without strong justification (only pg, zod, zod-to-json-schema, @opentelemetry/api today).

## Conventions

- TDD: failing test → implementation → green → commit. One commit per component; imperative messages (`feat(core): ...`).
- Tests: Vitest, `fileParallelism: false` (suites share the `toren_control` queue tables — don't re-enable). Per-suite schemas (`agent_<name>test`) truncated in `beforeAll`.
- Match existing style; no comments explaining what changed or why a change is correct.
- Never commit secrets or `.env` files.
- pnpm 11 blocks dependency build scripts: new build-script deps need an `allowBuilds` entry in `pnpm-workspace.yaml`.

## Gotchas

- `toren init`-scaffolded dirs outside the repo can't resolve `@toren/core` (unpublished) — test loaders against `examples/research-crew`.
- The OTel tracer resolves per call on purpose (hosts register SDKs late) — don't hoist `trace.getTracer` to module scope.
- SQS delays cap at 900s; `ctx.sleep` re-derives remaining delay on wake, so clamping is chaining — don't add chaining logic.
- Parked tasks (unresolved approvals) are excluded from wave re-dispatch — re-nudging them is an infinite loop (see `orchestrator.ts` absorb step).
