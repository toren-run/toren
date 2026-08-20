import { expect, test } from "vitest";
import { canonicalDigest } from "../src/digest.js";

test("digest is stable across key order", () => {
  expect(canonicalDigest({ a: 1, b: [{ x: 1, y: 2 }] }))
    .toBe(canonicalDigest({ b: [{ y: 2, x: 1 }], a: 1 }));
});

test("digest differs on value change", () => {
  expect(canonicalDigest({ a: 1 })).not.toBe(canonicalDigest({ a: 2 }));
});
