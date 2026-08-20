# Approvals

*How-to — put a human between an agent and anything irreversible.*

Mark a tool `approval: "always"` (see [Defining agents](defining-agents.md)). When the model calls it, the run **parks** — durably, at zero compute — until someone decides:

```bash
toren jobs list --dir my-crew
#  r_9f2c1a  my-crew  waiting_approval  (send_report)

toren jobs show r_9f2c1a --dir my-crew
#  pending approval: send_report {"to":"board@fund.com"}
#  → toren jobs approve r_9f2c1a w1t0 s4

toren jobs approve r_9f2c1a w1t0 s4                     # or:
toren jobs approve r_9f2c1a w1t0 s4 --deny --comment "wrong list"
```

Approve → the tool executes exactly once with the originally recorded arguments and the run continues. Deny → the model receives your comment as a tool error and decides how to proceed (typically it adapts or reports back).

Because parking is durable, an approval can arrive seconds or days later — nothing polls, nothing bills, and the run survives restarts while it waits. Programmatic equivalents: `listPendingApprovals()` / `resolveApproval()` in `@toren/core`.
