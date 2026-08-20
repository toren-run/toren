import { expect, test } from "vitest";
import {
  SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand,
  ChangeMessageVisibilityCommand, GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { SqsQueue, type SqsClientLike } from "../src/sqs.js";

class FakeClient implements SqsClientLike {
  sent: { name: string; input: Record<string, unknown> }[] = [];
  responses: unknown[] = [];
  async send(command: unknown): Promise<never> {
    const c = command as { constructor: { name: string }; input: Record<string, unknown> };
    this.sent.push({ name: c.constructor.name, input: c.input });
    return (this.responses.shift() ?? {}) as never;
  }
}

const URLS = {
  orchestrator: "https://sqs.test/q-orch",
  "tasks-short": "https://sqs.test/q-short",
  "tasks-long": "https://sqs.test/q-long",
} as const;

function make(): { q: SqsQueue; client: FakeClient } {
  const client = new FakeClient();
  return { q: new SqsQueue({ urls: URLS, client }), client };
}

const MSG = { kind: "tick" as const, runId: "r1", dedupeKey: "k1" };

test("send maps to SendMessage with JSON body and clamped delay", async () => {
  const { q, client } = make();
  await q.send("orchestrator", MSG, { delaySeconds: 5000 });
  expect(client.sent[0]!.name).toBe(SendMessageCommand.name);
  expect(client.sent[0]!.input).toMatchObject({
    QueueUrl: URLS.orchestrator,
    DelaySeconds: 900, // clamped to the SQS cap; ctx.sleep re-derives the rest
  });
  expect(JSON.parse(String(client.sent[0]!.input.MessageBody))).toEqual(MSG);
});

test("receive maps Messages to Deliveries with attempt from ApproximateReceiveCount", async () => {
  const { q, client } = make();
  client.responses.push({
    Messages: [{ Body: JSON.stringify(MSG), ReceiptHandle: "rh-1", Attributes: { ApproximateReceiveCount: "3" } }],
  });
  const [d] = await q.receive("tasks-short", { max: 5, visibilitySeconds: 30 });
  expect(client.sent[0]!.name).toBe(ReceiveMessageCommand.name);
  expect(client.sent[0]!.input).toMatchObject({ QueueUrl: URLS["tasks-short"], VisibilityTimeout: 30, MaxNumberOfMessages: 5 });
  expect(d!.message).toEqual(MSG);
  expect(d!.attempt).toBe(3);
  expect(d!.receipt).toBe("tasks-short::rh-1");
});

test("ack deletes with the right queue url and handle; nack re-delays; extend bumps visibility", async () => {
  const { q, client } = make();
  const d = { message: MSG, receipt: "tasks-long::rh-9", attempt: 1 };
  await q.ack(d);
  await q.nack(d, { delaySeconds: 7 });
  await q.extend(d, 120);
  expect(client.sent.map((s) => s.name)).toEqual([
    DeleteMessageCommand.name, ChangeMessageVisibilityCommand.name, ChangeMessageVisibilityCommand.name,
  ]);
  expect(client.sent[0]!.input).toMatchObject({ QueueUrl: URLS["tasks-long"], ReceiptHandle: "rh-9" });
  expect(client.sent[1]!.input).toMatchObject({ VisibilityTimeout: 7 });
  expect(client.sent[2]!.input).toMatchObject({ VisibilityTimeout: 120 });
});

test("depth sums visible and in-flight across all queues", async () => {
  const { q, client } = make();
  client.responses.push(
    { Attributes: { ApproximateNumberOfMessages: "2", ApproximateNumberOfMessagesNotVisible: "1" } },
    { Attributes: { ApproximateNumberOfMessages: "0", ApproximateNumberOfMessagesNotVisible: "4" } },
    { Attributes: { ApproximateNumberOfMessages: "1", ApproximateNumberOfMessagesNotVisible: "0" } },
  );
  expect(await q.depth()).toBe(8);
  expect(client.sent.every((s) => s.name === GetQueueAttributesCommand.name)).toBe(true);
});

test("unknown queue name throws instead of hitting AWS", async () => {
  const q = new SqsQueue({ urls: { orchestrator: "u" } as never, client: new FakeClient() });
  await expect(q.send("tasks-short", MSG)).rejects.toThrow(/no SQS url/);
});
