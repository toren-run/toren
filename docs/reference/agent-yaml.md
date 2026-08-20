# agent.yaml reference

```yaml
name: research_crew        # lowercase [a-z][a-z0-9_]*; becomes the schema/agent key
model: anthropic/claude-opus-5   # provider/model; mock/echo runs offline
maxTokens: 16000           # per model call (default 16000)
limits:
  maxStepsPerTask: 50      # hard cap on loop steps per task (default 50)
```

- Every field is optional except that the file must exist at the agent root (`subagents/*/agent.yaml` may omit anything — defaults apply).
- `instructions.md` beside it is the system prompt; missing → a generic default.
- Model routing is by prefix: `mock/` (offline echo), `anthropic/` (needs `ANTHROPIC_API_KEY`). Subagents may each use different models.

Planned keys (planned, not yet implemented — will fail silently today, don't set them): `fallbacks`, `runtime: short|long`, `sandbox.image`, `sandbox.snapshotEvery`, `limits.maxWaves`, `limits.maxWallClockMin`, `limits.maxBudgetUsd`.
