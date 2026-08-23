import type { PgStateStore } from "./store.js";
import type { RecordedEvent, StreamId } from "./events.js";

/**
 * Incremental follow of a run's event streams, for `toren jobs tail` and the
 * SSE endpoint. The cursor is per-stream last-seen seq; callers poll and get
 * only what landed since. Streams are append-only, so this is exact, not
 * best-effort.
 */

export type TailCursor = Partial<Record<string, number>>;

export interface TailedEvent extends RecordedEvent {
  streamId: StreamId;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export async function followRun(
  store: PgStateStore,
  runId: string,
  cursor: TailCursor,
): Promise<{ events: TailedEvent[]; done: boolean }> {
  const events: TailedEvent[] = [];

  const pull = async (streamId: StreamId) => {
    const after = cursor[streamId] ?? 0;
    for (const e of await store.read(runId, streamId)) {
      if (e.seq <= after) continue;
      events.push({ ...e, streamId });
      cursor[streamId] = e.seq;
    }
  };

  await pull("run");
  // Task streams come from every wave ever planned; the run stream is truth.
  const taskIds = new Set<string>();
  for (const e of await store.read(runId, "run")) {
    if (e.type !== "WavePlanned") continue;
    for (const t of e.payload.tasks as { taskId: string }[]) taskIds.add(t.taskId);
  }
  for (const taskId of taskIds) await pull(`task:${taskId}`);

  events.sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
  const run = await store.getRun(runId);
  return { events, done: !run || TERMINAL.has(run.status) };
}
