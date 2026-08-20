import { isInvalidation, type RecordedEvent } from "./events.js";

/** Events whose effects survive all StreamInvalidated markers, in order. */
export function effectiveEvents(events: RecordedEvent[]): RecordedEvent[] {
  const cuts = events.filter(isInvalidation).map((m) => ({ from: m.payload.fromSeq, at: m.seq }));
  return events.filter(
    (e) => !isInvalidation(e) && !cuts.some((c) => e.seq >= c.from && e.seq < c.at),
  );
}
