import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import type { Delivery, QueueAdapter, QueueMessage, QueueName } from "@toren/core";

/** Minimal client surface, so tests can inject a fake. */
export interface SqsClientLike {
  send(command: unknown): Promise<never>;
}

export interface SqsQueueConfig {
  urls: Record<QueueName, string>;
  client?: SqsClientLike;
  region?: string;
}

const MAX_SQS_DELAY = 900; // SQS cap; ctx.sleep re-derives the remainder on wake, so clamping is chaining.

/**
 * SQS binding of the queue seam. Dead-lettering is the queues'
 * redrive policy (Terraform), not adapter code; `maxAttempts` on send is
 * therefore ignored here. Receipts encode `queueName::receiptHandle`.
 */
export class SqsQueue implements QueueAdapter {
  private client: SqsClientLike;
  constructor(private cfg: SqsQueueConfig) {
    this.client = cfg.client ?? (new SQSClient({ region: cfg.region }) as unknown as SqsClientLike);
  }

  private url(queue: QueueName): string {
    const u = this.cfg.urls[queue];
    if (!u) throw new Error(`no SQS url configured for queue "${queue}"`);
    return u;
  }

  private parseReceipt(receipt: string | number): { url: string; handle: string } {
    const [queue, ...rest] = String(receipt).split("::");
    return { url: this.url(queue as QueueName), handle: rest.join("::") };
  }

  async send(queue: QueueName, msg: QueueMessage, opts?: { delaySeconds?: number; maxAttempts?: number }): Promise<void> {
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.url(queue),
      MessageBody: JSON.stringify(msg),
      DelaySeconds: Math.min(MAX_SQS_DELAY, Math.ceil(opts?.delaySeconds ?? 0)),
    }));
  }

  // opts.agents is accepted but not filterable server-side on SQS — each stack
  // has its own queues, and workers ack-and-skip foreign hints regardless.
  async receive(queue: QueueName, opts: { max: number; visibilitySeconds: number; agents?: string[] }): Promise<Delivery[]> {
    const r = (await this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.url(queue),
      MaxNumberOfMessages: Math.min(10, opts.max),
      VisibilityTimeout: Math.ceil(opts.visibilitySeconds),
      WaitTimeSeconds: 0,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    }))) as { Messages?: { Body?: string; ReceiptHandle?: string; Attributes?: Record<string, string> }[] };
    return (r.Messages ?? []).map((m) => ({
      message: JSON.parse(m.Body ?? "{}") as QueueMessage,
      receipt: `${queue}::${m.ReceiptHandle}`,
      attempt: Number(m.Attributes?.ApproximateReceiveCount ?? 1),
    }));
  }

  async extend(d: Delivery, visibilitySeconds: number): Promise<void> {
    const { url, handle } = this.parseReceipt(d.receipt);
    await this.client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: url, ReceiptHandle: handle, VisibilityTimeout: Math.ceil(visibilitySeconds),
    }));
  }

  async ack(d: Delivery): Promise<void> {
    const { url, handle } = this.parseReceipt(d.receipt);
    await this.client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: handle }));
  }

  async nack(d: Delivery, opts?: { delaySeconds?: number }): Promise<void> {
    const { url, handle } = this.parseReceipt(d.receipt);
    await this.client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: url, ReceiptHandle: handle,
      VisibilityTimeout: Math.min(MAX_SQS_DELAY, Math.ceil(opts?.delaySeconds ?? 0)),
    }));
  }

  async depth(_opts?: { agents?: string[] }): Promise<number> {
    let total = 0;
    for (const queue of Object.keys(this.cfg.urls) as QueueName[]) {
      const r = (await this.client.send(new GetQueueAttributesCommand({
        QueueUrl: this.url(queue),
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
      }))) as { Attributes?: Record<string, string> };
      total += Number(r.Attributes?.ApproximateNumberOfMessages ?? 0)
        + Number(r.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
    }
    return total;
  }
}
