# Contributing to Toren

Thanks for your interest! Toren is early — issues, bug reports, and docs fixes are the most valuable contributions right now.

## Development setup

```bash
pnpm install
docker compose up -d db --wait   # Postgres 16 on localhost:5433
pnpm test                        # full suite — must be green before and after your change
pnpm typecheck
```

`AGENTS.md` is the source of truth for the codebase's hard rules — the durability invariants, digest stability, and single-writer discipline. Changes that weaken the chaos kill-matrix tests are rejected on principle: those tests are the product.

## Pull requests

- One logical change per PR, with tests. A failing test that reproduces your bug is a great first commit.
- No new runtime dependencies in `@toren/core` without discussion in an issue first.
- Anything touching replay semantics (`canonicalDigest`, event ordering, lease/fencing) needs a linked issue describing the invariant impact before review.

## License

By contributing, you agree that your contributions are licensed under the [Apache-2.0 license](LICENSE).
