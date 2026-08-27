# Durability & replay

*Explanation, why a toren run survives anything, and why resumes are free.*

## The event log is the state

A run has no in-memory state worth protecting. Everything that happens (every model call, tool call, wave decision, approval, timer) is appended to an event log in Postgres *the moment it completes*. The run's state is always a pure function (a "fold") of that log. Kill any process at any moment; nothing is lost, because nothing lived only in the process.

## Token replay: resumes never re-pay

When a run resumes, toren walks the log. Every model call that already has a recorded response is **replayed from the log**, the provider is not contacted, no tokens are spent. Only the first unrecorded step actually executes. A 40-call run that dies on call 35 resumes for the price of one call, not thirty-five.

Every recorded call also stores a **fingerprint (digest) of the exact request that produced it**. On replay, toren re-derives the request and compares fingerprints. Match → recorded answer is consumed, free. Mismatch (you edited a prompt or tool mid-flight) → that step and everything after it re-runs fresh, and a `StreamInvalidated` marker records the cut. You never replay a stale answer to a changed question, and you never re-pay for an unchanged one.

## Execution guarantees, honestly stated

| Operation | Execution | Why |
|---|---|---|
| Model call | at-least-once, *practically once* | the crash window is one network call wide; recorded calls never re-execute |
| Tool with `idempotency: "keyed"` | effectively once | retries and resumes carry the same idempotency key; your tool or downstream dedupes |
| Tool without a key | at-least-once | the crash window can double-execute, mark side-effectful tools keyed |

## Single-writer, enforced twice

Each event stream has one writer at a time, enforced by **leases with fencing epochs** (makes concurrent writers rare) and **conditional append**: every write names the sequence number it expects (makes concurrent writers harmless: a zombie process that outlived its lease gets a conflict, not a forked history). Queue messages are therefore only *hints*; duplicates no-op and losses are healed by the guardians re-nudging stalled runs.

## Parking: zero-compute waiting

A run waiting for a human approval, a timer, or (roadmap) the next conversation message holds **no** resources, no process, no poll loop, no container. It is rows in Postgres until an event wakes it.

## Context compaction: an event in the log

An agent that works for days outgrows its model's context window. Toren compacts in two recorded tiers, both driven by the provider's own reported token usage against the agent's `contextWindow` (defaulted per provider, settable in `agent.yaml`):

1. At about half the window, old tool results are replaced with restorable stubs. The stub names the tool, the full output stays in the event log, and the agent can simply call the tool again if it needs the data. No model call, and the freshest results always stay verbatim.
2. Near the top of the window, older history folds into a structured summary. The summarization call is recorded like any other model call, so it is paid exactly once, and the fold itself lands as a `ContextCompacted` event carrying the summary by value.

Because both tiers are events, prompt assembly stays a pure function of the log: a compacted, killed, and resumed agent recalls the same summary, verified by digest, without paying for it twice. Session transcripts are untouched, since they fold from turn events, not from the model's message array. A compaction kill matrix in CI crashes the stack after every write across the fold and asserts exactly that.

## Editing a workflow mid-run: surgical invalidation, worked example

Replay is only sound while the code and the log agree, and code changes. Every recorded step carries a canonical digest of its inputs; on resume, the first step whose digest no longer matches what the code would do *now* invalidates the log from that point forward. Everything before it replays free, everything after recomputes. Concretely:

Say a research crew ran this workflow and was killed after the research wave settled:

```ts
export default async function (ctx: WorkflowCtx) {
  const research = await ctx.wave("research", [
    ctx.task("researcher", "postgres durability"),
    ctx.task("researcher", "event sourcing"),
  ]);
  const summary = await ctx.wave("summarize", [
    ctx.task("writer", research.results.map((r) => r.output).join(" | ")),
  ]);
  return summary.results[0]?.output ?? "";
}
```

**Edit 1 — change the writer's input** (say, add a preamble to the joined string). Resume: both research tasks replay from the log, free, byte-identical. The summarize wave's digest no longer matches (its task input changed), so it invalidates and the writer runs live, once. You pay for exactly one new model call: the one whose inputs you actually changed.

**Edit 2 — append a third research topic.** Resume: the wave's plan digest changes, so the wave re-plans. But tasks keep positional identities (`w0t0`, `w0t1`, …), and each task records into its own stream: the two original tasks land on the same identities with the same inputs, so their streams replay free, and only the new topic executes live. The wave settles with two replayed results and one paid one, then summarize recomputes because its input now includes the third output. The flip side of positional identity: *inserting* the topic at the front instead of appending shifts every task's position, and shifted tasks recompute. Append is cheap; reorder is a rewrite.

**Edit 3 — rename a variable, extract a helper, reformat.** Resume: digests are computed from *canonical inputs* (task names, input strings, tool args), not source text. Nothing invalidates; the run replays and continues as if the code never changed. This is why digest canonicalization is treated as a compatibility contract in [versioning](/reference/versioning): the boundary between "refactor" and "meaningful change" decides what you re-pay for.

The failure mode this prevents: silently splicing new logic onto old state. An edit that *would* change a recorded step's meaning always surfaces as recomputation, never as a run that half-believes the old code and half-believes the new.

## How we know it works

Two chaos suites run in CI: they kill the entire stack after **every single database write** in a run (task-level and full multi-wave), then recover on a fresh stack and assert the run completes with identical output and every model call paid exactly once. The same invariant is verified live against real Anthropic billing in the key-gated live tests.
