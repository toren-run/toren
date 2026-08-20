# Durability & replay

*Explanation — why a toren run survives anything, and why resumes are free.*

## The event log is the state

A run has no in-memory state worth protecting. Everything that happens — every model call, tool call, wave decision, approval, timer — is appended to an event log in Postgres *the moment it completes*. The run's state is always a pure function (a "fold") of that log. Kill any process at any moment; nothing is lost, because nothing lived only in the process.

## Token replay: resumes never re-pay

When a run resumes, toren walks the log. Every model call that already has a recorded response is **replayed from the log** — the provider is not contacted, no tokens are spent. Only the first unrecorded step actually executes. A 40-call run that dies on call 35 resumes for the price of one call, not thirty-five.

Every recorded call also stores a **fingerprint (digest) of the exact request that produced it**. On replay, toren re-derives the request and compares fingerprints. Match → recorded answer is consumed, free. Mismatch (you edited a prompt or tool mid-flight) → that step and everything after it re-runs fresh, and a `StreamInvalidated` marker records the cut. You never replay a stale answer to a changed question, and you never re-pay for an unchanged one.

## Execution guarantees, honestly stated

| Operation | Execution | Why |
|---|---|---|
| Model call | at-least-once, *practically once* | the crash window is one network call wide; recorded calls never re-execute |
| Tool with `idempotency: "keyed"` | effectively once | retries and resumes carry the same idempotency key; your tool or downstream dedupes |
| Tool without a key | at-least-once | the crash window can double-execute — mark side-effectful tools keyed |

## Single-writer, enforced twice

Each event stream has one writer at a time, enforced by **leases with fencing epochs** (makes concurrent writers rare) and **conditional append** — every write names the sequence number it expects (makes concurrent writers harmless: a zombie process that outlived its lease gets a conflict, not a forked history). Queue messages are therefore only *hints*; duplicates no-op and losses are healed by the guardians re-nudging stalled runs.

## Parking: zero-compute waiting

A run waiting for a human approval, a timer, or (roadmap) the next conversation message holds **no** resources — no process, no poll loop, no container. It is rows in Postgres until an event wakes it.

## How we know it works

Two chaos suites run in CI: they kill the entire stack after **every single database write** in a run — task-level and full multi-wave — then recover on a fresh stack and assert the run completes with identical output and every model call paid exactly once. The same invariant is verified live against real Anthropic billing in the key-gated live tests.
