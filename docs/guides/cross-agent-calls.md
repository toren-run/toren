# Cross-agent calls <Badge type="warning" text="beta" />

*One agent delegates a request to another. The peer answers with its own tools and privileges, and shares only the answer.*

> **Beta.** Shipped and tested, but the config keys and tool shape may still change based on feedback. Pin your Toren version if you build on it, and tell us what breaks.

## The idea

An agent's **subagents** share its trust domain — same schema, same env, same owner. A **peer call** crosses trust domains: the CMO agent can ask the CFO agent for August's spend, and the CFO answers using its own database roles and tools — the CMO receives the number, never the access. Subagents extend an agent's hands; peer calls extend its reach.

Calls are **delegation, not conversation**: a request goes over, a durable run executes on the peer, the answer comes back. The caller's conversation continues while the peer works, and the reply lands as a message when it's done — the same spawn-and-wake machinery behind [background runs](background-runs.md), pointed across agents.

## Consent is mutual, deny by default

Both sides declare the edge in their `agent.yaml`; a call connects only where the declarations meet:

```yaml
# cmo/agent.yaml
agents:
  can_call: [cfo]        # grants this agent's model the call_agent tool

# cfo/agent.yaml
agents:
  accept_from: [cmo]     # consents to answer the cmo
```

One-sided declarations do nothing. The caller listing a peer hands its model the capability; the peer listing the caller agrees to serve it. Consent gates *initiating* a call — the peer replying, or the answer flowing back, needs no reverse edge, the same way answering a phone call needs no permission to dial.

Edges resolve at fleet startup (`toren dev` serving both directories) and are enforced again on every call, so editing one yaml can never widen access that the other side didn't grant.

## What the model sees

Declaring `can_call` gives the root agent two tools:

- **`call_agent`** — `{agent, input}`: starts a durable run on the peer. The peer sees *only the input text*, none of the caller's conversation. Returns immediately with the run id; the answer arrives in the caller's conversation as a `[reply from <agent>]` message when the peer finishes.
- **`check_run`** — polls a call's status and output on demand, same as for background runs.

Calling is effectively-once: the child run's id derives from the tool-use id, so a crash-window replay finds the run already exists instead of asking the peer twice.

## What the operator sees

The peer's run is an ordinary run **in the peer's schema**: it shows up in `toren jobs list`, its event log is complete, its cost roll-up is separate, and its `channel` column records who called (`agent:cmo`). Auditing "who asked whom for what, and what it cost" is reading two event logs — no side channel exists.

Nothing changes for the API, SDK, or CLI: you talk to one agent, and any cross-agent fan-out happens server-side under the consent rules. `POST /runs` on the CMO can transitively produce a CFO run; both are visible through every existing surface.

## Boundaries that hold

- The peer executes under **its own** env, database roles, sandbox, and approval gates. A gated tool on the callee still parks for approval, exactly as if a human had asked.
- The caller gets the peer's **output only** (capped, like any run output).
- No fleet, no calls: a single-agent runtime has no peers, and `call_agent` says so instead of failing mysteriously.

## Consolidating containers to enable calls

`call_agent` connects agents served by **one deployment** (`toren dev --dir a --dir b`). If your agents currently run as separate containers for credential isolation — each with its own `SQL_DATABASE_URL` pointing at its own database role — consolidation used to collapse that boundary, because env vars are process-wide. `env.bind` restores it:

```yaml
# cmo/agent.yaml                      # cfo/agent.yaml
env:                                  env:
  required: [SQL_DATABASE_URL]         required: [SQL_DATABASE_URL]
  bind:                                bind:
    SQL_DATABASE_URL: CMO_DB_URL         SQL_DATABASE_URL: CFO_DB_URL
```

Tools keep reading their logical name (`ctx.env.SQL_DATABASE_URL`); each agent resolves it from its own physical variable, so the finance/marketing wall survives co-location. Version skew across the old split is a non-issue after consolidation by construction — one container, one version.

## Beta limits (honest)

- **Notify-later only.** The caller's turn ends after placing the call; the answer arrives as the next message. A blocking wait-in-turn variant is planned.
- **Loop guards are fixed constants for now.** A call chain deeper than 4 hops is refused (two agents ping-ponging get told to answer with what they have), and one run may place at most 25 calls. Crash replays of an accepted call are exempt — the guards bound decisions, never recovery. If a real workflow hits either limit, tell us; they'll become configurable.
- Consent names agents, not processes: a callable peer's processes are all callable. Process-level grants may come later if needed.
