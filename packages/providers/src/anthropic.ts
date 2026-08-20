import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatMessage, ContentBlock, ModelProvider, ModelRequest, ModelResponse, StopReason,
} from "@toren-run/core";

type SdkMessageParam = Anthropic.Messages.MessageParam;
type SdkContentBlockParam = Exclude<SdkMessageParam["content"], string>[number];

function toSdkBlock(b: ContentBlock): SdkContentBlockParam {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "toolUse":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "toolResult":
      return { type: "tool_result", tool_use_id: b.toolUseId, content: b.content, ...(b.isError ? { is_error: true } : {}) };
  }
}

function toSdkMessage(m: ChatMessage): SdkMessageParam {
  return { role: m.role, content: m.content.map(toSdkBlock) };
}

export function toAnthropicParams(req: ModelRequest): Anthropic.Messages.MessageCreateParamsNonStreaming {
  return {
    model: req.model.replace(/^anthropic\//, ""),
    max_tokens: req.maxTokens,
    ...(req.system ? { system: req.system } : {}),
    messages: req.messages.map(toSdkMessage),
    ...(req.tools.length
      ? {
          tools: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
          })),
        }
      : {}),
  };
}

const STOP_MAP: Record<string, StopReason> = {
  end_turn: "endTurn",
  tool_use: "toolUse",
  max_tokens: "maxTokens",
  refusal: "refusal",
  stop_sequence: "endTurn",
  pause_turn: "endTurn",
};

export function fromAnthropicResponse(msg: Anthropic.Messages.Message): ModelResponse {
  const content: ContentBlock[] = [];
  for (const block of msg.content) {
    if (block.type === "text") content.push({ type: "text", text: block.text });
    else if (block.type === "tool_use") content.push({ type: "toolUse", id: block.id, name: block.name, input: block.input });
    // thinking and other model-internal blocks are not part of toren's normalized
    // transcript in v0; the recorded response is the durable artifact.
  }
  return {
    content,
    stopReason: STOP_MAP[msg.stop_reason ?? "end_turn"] ?? "endTurn",
    usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
  };
}

/**
 * Anthropic adapter over toren's normalized model interface.
 * Credentials resolve from the environment (ANTHROPIC_API_KEY / auth profile);
 * the SDK's built-in retries handle 429/5xx.
 */
export class AnthropicProvider implements ModelProvider {
  private client: Anthropic;
  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const response = await this.client.messages.create(toAnthropicParams(req));
    return fromAnthropicResponse(response);
  }
}
