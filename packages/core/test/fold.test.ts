import { expect, test } from "vitest";
import { effectiveEvents } from "../src/fold.js";
import { ev, type RecordedEvent } from "../src/events.js";

const rec = (seq: number, type: Parameters<typeof ev>[0], payload: Record<string, unknown> = {}): RecordedEvent =>
  ({ ...ev(type, payload), seq, recordedAt: new Date(0) });

test("no markers: identity", () => {
  const events = [rec(1, "TaskStarted"), rec(2, "LlmCallCompleted")];
  expect(effectiveEvents(events).map((e) => e.seq)).toEqual([1, 2]);
});

test("a marker discards [fromSeq, markerSeq) and itself", () => {
  const events = [
    rec(1, "TaskStarted"),
    rec(2, "LlmCallCompleted"),
    rec(3, "ToolCallCompleted"),
    rec(4, "StreamInvalidated", { fromSeq: 2, reason: "prompt edit" }),
    rec(5, "LlmCallCompleted"),
  ];
  expect(effectiveEvents(events).map((e) => e.seq)).toEqual([1, 5]);
});

test("markers compose: a later marker can cut re-recorded work", () => {
  const events = [
    rec(1, "TaskStarted"),
    rec(2, "LlmCallCompleted"),
    rec(3, "StreamInvalidated", { fromSeq: 2, reason: "edit A" }),
    rec(4, "LlmCallCompleted"),
    rec(5, "StreamInvalidated", { fromSeq: 4, reason: "edit B" }),
    rec(6, "LlmCallCompleted"),
  ];
  expect(effectiveEvents(events).map((e) => e.seq)).toEqual([1, 6]);
});
