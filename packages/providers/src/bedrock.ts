import { createRequire } from "node:module";
import type { BedrockRuntimeClient, ConverseCommandInput, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type {
  ChatMessage, ContentBlock, ModelProvider, ModelRequest, ModelResponse, StopReason,
} from "@toren-run/core";

// Lazy SDK load, same pattern as the other providers: a deployment that never
// routes a bedrock/ model never parses the AWS SDK. Auth is the standard AWS
// credential chain (env, profile, IAM role) — no API key exists; that IS the
// enterprise story. Region: AWS_REGION.
const requireCjs = createRequire(import.meta.url);
type Sdk = { BedrockRuntimeClient: new (cfg?: object) => BedrockRuntimeClient; ConverseCommand: new (input: ConverseCommandInput) => object };
let sdk: Sdk | undefined;
function loadSdk(): Sdk {
  sdk ??= requireCjs("@aws-sdk/client-bedrock-runtime") as Sdk;
  return sdk;
}

type ConverseContent = NonNullable<NonNullable<ConverseCommandInput["messages"]>[number]["content"]>[number];

function toConverseContent(m: ChatMessage): ConverseContent[] {
  const out: ConverseContent[] = [];
  for (const b of m.content) {
    if (b.type === "text") out.push({ text: b.text });
    else if (b.type === "toolUse") out.push({ toolUse: { toolUseId: b.id, name: b.name, input: b.input as never } });
    else if (b.type === "toolResult") out.push({ toolResult: { toolUseId: b.toolUseId, content: [{ text: b.content }], ...(b.isError ? { status: "error" as const } : {}) } });
  }
  return out;
}

export function toConverseParams(req: ModelRequest): ConverseCommandInput {
  return {
    modelId: req.model.replace(/^bedrock\//, ""),
    ...(req.system ? { system: [{ text: req.system }] } : {}),
    inferenceConfig: { maxTokens: req.maxTokens },
    messages: req.messages.map((m) => ({ role: m.role, content: toConverseContent(m) })),
    ...(req.tools.length
      ? { toolConfig: { tools: req.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema as never } } })) } }
      : {}),
  };
}

const STOP_MAP: Record<string, StopReason> = {
  end_turn: "endTurn",
  stop_sequence: "endTurn",
  tool_use: "toolUse",
  max_tokens: "maxTokens",
  content_filtered: "refusal",
  guardrail_intervened: "refusal",
};

export function fromConverseResponse(res: ConverseCommandOutput): ModelResponse {
  const content: ContentBlock[] = [];
  for (const b of res.output?.message?.content ?? []) {
    if ("text" in b && b.text != null) content.push({ type: "text", text: b.text });
    else if ("toolUse" in b && b.toolUse) content.push({ type: "toolUse", id: b.toolUse.toolUseId ?? "", name: b.toolUse.name ?? "", input: b.toolUse.input ?? {} });
  }
  return {
    content,
    stopReason: STOP_MAP[res.stopReason ?? "end_turn"] ?? "endTurn",
    usage: { inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0 },
  };
}

/**
 * Bedrock adapter over toren's normalized model interface, via the Converse
 * API (one wire shape for every Bedrock model that supports tools).
 * Credentials resolve from the AWS chain; the SDK's own retry logic handles
 * throttling.
 */
export class BedrockProvider implements ModelProvider {
  private client: BedrockRuntimeClient;
  constructor(client?: BedrockRuntimeClient) {
    this.client = client ?? new (loadSdk().BedrockRuntimeClient)();
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const { ConverseCommand } = loadSdk();
    const response = (await this.client.send(new ConverseCommand(toConverseParams(req)) as never)) as ConverseCommandOutput;
    return fromConverseResponse(response);
  }
}
