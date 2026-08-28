import { isInvalidation, type RecordedEvent } from "./events.js";

/**
 * Conversation facts are never voided by invalidation: what a person said
 * (UserMessage) and what the assistant told them (InputRequested) are history,
 * not replayable computation. A prompt deploy may force model calls to be
 * re-paid; it must never delete a conversation (field report 2026-08-28: daily
 * prompt deploys made every open session amnesiac).
 */
export const FACT_TYPES = new Set(["UserMessage", "InputRequested"]);

export type InvalidationCut = { from: number; at: number };

export function invalidationCuts(events: RecordedEvent[]): InvalidationCut[] {
  return events.filter(isInvalidation).map((m) => ({ from: Number(m.payload.fromSeq), at: m.seq }));
}

export function inCut(e: RecordedEvent, cuts: InvalidationCut[]): boolean {
  return cuts.some((c) => e.seq >= c.from && e.seq < c.at);
}

/** Events whose effects survive all StreamInvalidated markers, in order. Facts always survive. */
export function effectiveEvents(events: RecordedEvent[]): RecordedEvent[] {
  const cuts = invalidationCuts(events);
  return events.filter(
    (e) => !isInvalidation(e) && (FACT_TYPES.has(e.type) || !inCut(e, cuts)),
  );
}
