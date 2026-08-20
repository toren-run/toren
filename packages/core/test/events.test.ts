import { expect, test } from "vitest";
import { ev, isInvalidation } from "../src/events.js";

test("ev stamps payload version 1", () => {
  expect(ev("TaskStarted", { attempt: 1 }).payload).toEqual({ v: 1, attempt: 1 });
});

test("isInvalidation requires a numeric fromSeq", () => {
  const good = { ...ev("StreamInvalidated", { fromSeq: 3, reason: "edit" }), seq: 9, recordedAt: new Date() };
  const bad = { ...ev("StreamInvalidated", { reason: "edit" }), seq: 9, recordedAt: new Date() };
  expect(isInvalidation(good)).toBe(true);
  expect(isInvalidation(bad)).toBe(false);
});
