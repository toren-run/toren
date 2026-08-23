import type { PgStateStore } from "./store.js";

/**
 * Cost roll-up for one run, straight from the event log. Every model call's
 * usage rides in LlmCallCompleted; the raw streams (not the effective view)
 * are the tally, because invalidated calls were still paid for. The number
 * the product exists for: completed calls recorded before a later attempt
 * replayed from the log instead of the provider, so their cost was paid once.
 */

export interface RunUsage {
  models: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
  totalCalls: number;
  /** Sum of TaskStarted across all task streams; > tasks means resumes happened. */
  taskAttempts: number;
  /** Completed calls that later attempts replayed from the log instead of re-buying. */
  replayedCalls: number;
  /** Present only when every used model has a known price. USD. */
  estCostUsd?: number;
  replaySavingsUsd?: number;
}

/** USD per million tokens. Approximate list prices; override or extend via TOREN_MODEL_PRICES (JSON, same shape). */
export const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  "openai/gpt-4o": { in: 2.5, out: 10 },
  "openai/gpt-4o-mini": { in: 0.15, out: 0.6 },
  "mock/echo": { in: 0, out: 0 },
  "mock/slow": { in: 0, out: 0 },
  "mock/m": { in: 0, out: 0 },
};

function prices(): Record<string, { in: number; out: number }> {
  const env = process.env.TOREN_MODEL_PRICES;
  if (!env) return MODEL_PRICES;
  try {
    return { ...MODEL_PRICES, ...(JSON.parse(env) as Record<string, { in: number; out: number }>) };
  } catch {
    return MODEL_PRICES;
  }
}

export async function runUsage(store: PgStateStore, runId: string): Promise<RunUsage> {
  const runEvents = await store.read(runId, "run");
  const taskIds = new Set<string>();
  for (const e of runEvents) {
    if (e.type !== "WavePlanned") continue;
    for (const t of e.payload.tasks as { taskId: string }[]) taskIds.add(t.taskId);
  }

  const table = prices();
  const models: RunUsage["models"] = {};
  let totalCalls = 0, taskAttempts = 0, replayedCalls = 0;
  let cost = 0, savings = 0, priceable = true;

  for (const taskId of taskIds) {
    const events = await store.read(runId, `task:${taskId}`);
    const stepModel = new Map<string, string>();
    let completedSoFar = 0, costSoFar = 0;
    for (const e of events) {
      if (e.type === "TaskStarted") {
        taskAttempts += 1;
        if (Number(e.payload.attempt ?? 1) > 1) {
          replayedCalls += completedSoFar;
          savings += costSoFar;
        }
      } else if (e.type === "LlmCallStarted") {
        stepModel.set(String(e.payload.stepId), String(e.payload.model ?? ""));
      } else if (e.type === "LlmCallCompleted") {
        const model = stepModel.get(String(e.payload.stepId)) ?? "";
        const usage = (e.payload.usage ?? {}) as { inputTokens?: number; outputTokens?: number };
        const m = (models[model] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
        m.calls += 1;
        m.inputTokens += usage.inputTokens ?? 0;
        m.outputTokens += usage.outputTokens ?? 0;
        totalCalls += 1;
        completedSoFar += 1;
        const p = table[model];
        if (p) {
          const c = ((usage.inputTokens ?? 0) * p.in + (usage.outputTokens ?? 0) * p.out) / 1_000_000;
          cost += c;
          costSoFar += c;
        } else {
          priceable = false;
        }
      }
    }
  }

  return {
    models, totalCalls, taskAttempts, replayedCalls,
    ...(priceable && totalCalls > 0 ? { estCostUsd: cost, replaySavingsUsd: savings } : {}),
  };
}
