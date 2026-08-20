import { afterAll, expect, test } from "vitest";
import { createPool, PgQueue } from "@toren/core";
import { SqsQueue } from "@toren/adapters-aws";
import { selectQueue } from "../src/runtime.js";

const pool = createPool();
afterAll(async () => { await pool.end(); });

test("defaults to the Postgres queue", () => {
  expect(selectQueue(pool, {})).toBeInstanceOf(PgQueue);
});

test("TOREN_QUEUE=sqs selects SQS when all urls are present", () => {
  const q = selectQueue(pool, {
    TOREN_QUEUE: "sqs",
    TOREN_SQS_URL_ORCHESTRATOR: "https://sqs.test/a",
    TOREN_SQS_URL_TASKS_SHORT: "https://sqs.test/b",
    TOREN_SQS_URL_TASKS_LONG: "https://sqs.test/c",
  });
  expect(q).toBeInstanceOf(SqsQueue);
});

test("TOREN_QUEUE=sqs with a missing url fails loudly", () => {
  expect(() => selectQueue(pool, { TOREN_QUEUE: "sqs", TOREN_SQS_URL_ORCHESTRATOR: "u" })).toThrow(/no url/);
});
