# @toren-run/core

The engine of [Toren](https://toren.run), the open-source runtime for long-running, durable AI agents. This package is the durability itself: the append-only Postgres event log, the agent task loop, the orchestrator with parallel waves, workers, leases, guardians, approvals, schedules, and sessions. A resumed run never re-pays for a completed model call; a CI kill matrix crashes the stack after every database write and asserts exactly-once billing.

Most people want the CLI instead: `npm install toren-run` gives you `toren init`, `toren dev`, the HTTP API, and the web console, all built on this package. Reach for `@toren-run/core` directly when you embed the runtime in your own host process: `startRun`, `tick`, `LocalWorkerRuntime`, `defineTool`, and friends.

Zero model SDKs in here. The core depends on `pg` and `zod`, nothing environment-specific; providers, queues, and sandboxes plug in behind interfaces.

**Docs:** [toren.run/docs](https://toren.run/docs) (durability and architecture live under Concepts). Apache-2.0.
