import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import {
  SQSClient, CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import type { QueueName } from "@toren-run/core";
import { SqsQueue } from "../src/sqs.js";

/**
 * Live SQS contract test (needs AWS credentials + region in env). Creates
 * uniquely-named temp queues, runs the queue contract, deletes them.
 */
const CREDS = !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE);
const client = CREDS ? new SQSClient({}) : null;
const suffix = randomUUID().slice(0, 8);
const urls = {} as Record<QueueName, string>;
const names: QueueName[] = ["orchestrator", "tasks-short", "tasks-long"];

beforeAll(async () => {
  if (!client) return;
  for (const n of names) {
    const r = await client.send(new CreateQueueCommand({ QueueName: `toren-test-${suffix}-${n}` }));
    urls[n] = r.QueueUrl!;
  }
}, 60_000);

afterAll(async () => {
  if (!client) return;
  for (const n of names) {
    if (urls[n]) await client.send(new DeleteQueueCommand({ QueueUrl: urls[n] }));
  }
});

test.skipIf(!CREDS)("live contract: send/receive/ack/nack semantics on real SQS", { timeout: 120_000 }, async () => {
  const q = new SqsQueue({ urls, client: client as never });
  const msg = { kind: "task" as const, runId: "r-live", taskId: "t1", dedupeKey: "k-live" };

  await q.send("tasks-short", msg);
  // SQS is eventually consistent on receive — poll briefly.
  let d;
  for (let i = 0; i < 20 && !d; i++) {
    [d] = await q.receive("tasks-short", { max: 1, visibilitySeconds: 5 });
    if (!d) await new Promise((r) => setTimeout(r, 500));
  }
  expect(d, "message not received within 10s").toBeDefined();
  expect(d!.message).toEqual(msg);

  // In-flight: a second receive sees nothing while visibility holds.
  expect(await q.receive("tasks-short", { max: 1, visibilitySeconds: 5 })).toEqual([]);

  // nack with no delay → redelivered with attempt bump.
  await q.nack(d!, { delaySeconds: 0 });
  let d2;
  for (let i = 0; i < 20 && !d2; i++) {
    [d2] = await q.receive("tasks-short", { max: 1, visibilitySeconds: 5 });
    if (!d2) await new Promise((r) => setTimeout(r, 500));
  }
  expect(d2!.attempt).toBeGreaterThanOrEqual(2);

  // ack deletes for good.
  await q.ack(d2!);
  await new Promise((r) => setTimeout(r, 1000));
  const attrs = await (client as SQSClient).send(new GetQueueAttributesCommand({
    QueueUrl: urls["tasks-short"],
    AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
  }));
  const remaining = Number(attrs.Attributes?.ApproximateNumberOfMessages ?? 0)
    + Number(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
  expect(remaining).toBe(0);

  // delayed send stays invisible initially.
  await q.send("orchestrator", { kind: "tick", runId: "r-live", dedupeKey: "k2" }, { delaySeconds: 60 });
  expect(await q.receive("orchestrator", { max: 1, visibilitySeconds: 5 })).toEqual([]);
});
