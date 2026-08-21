# Architecture

*Explanation, the shape of the system and why it's shaped that way.*

## Four primitives, one trick

Toren abstracts four primitives behind narrow interfaces and binds different adapters per environment, it never emulates one cloud on another:

| Primitive | Local | AWS |
|---|---|---|
| Queue | Postgres (`SKIP LOCKED`) | SQS |
| Worker runtime | in-process pollers | Fargate service |
| State store | Postgres | RDS (same code) |
| Orchestrator | **identical binary** | **identical binary** |

Locally, Postgres does triple duty: state, queue, and event log. The whole dev stack is one dependency. In AWS the same agent runs unchanged; only the bindings differ.

## Two layers of execution

- **Tasks** are agentic loops: the model owns control flow inside a task: call tools, react, iterate, up to step/budget caps. Task state is the fold of its event stream.
- **Workflows** own control flow *between* tasks: short deterministic TypeScript that dispatches **waves** (batches of parallel tasks), inspects results in plain code, and decides what's next. Workflow code re-executes on every tick; everything already done returns instantly from the log.

The skeleton is deterministic; the cells are agentic. Dynamic behavior comes from feeding one wave's model output into the next wave's plan (the planner pattern).

## The moving parts

```
CLI / code ──start──▶ run row + RunCreated ──tick msg──▶ QUEUE
                                                          │
        ┌── workers poll ─────────────────────────────────┤
        ▼                                                 ▼
   tick (orchestrator):                              task execution:
   lease run stream → absorb finished tasks          lease task stream →
   → advance workflow → dispatch next wave           fold → continue loop →
                                                     record every step
        └────────────── all state: Postgres event log ────┘

   guardians (periodic): re-nudge any non-terminal run and heal lost messages
```

## Why Postgres and not a workflow engine

Durable agent semantics need transactions and compare-and-swap appends (see [Durability](durability.md)); an event log in SQL additionally gives you a queryable audit trail, every prompt, response, and token count, which regulated buyers require and the future self-improvement loop feeds on. One boring database beats three exotic services.
