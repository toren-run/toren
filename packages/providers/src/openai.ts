import { createRequire } from "node:module";
import type OpenAI from "openai";
import type {
  ChatMessage, ContentBlock, ModelProvider, ModelRequest, ModelResponse, StopReason,
} from "@toren-run/core";

// Lazy SDK load, mirroring anthropic.ts: a deployment that never routes an
// openai/ model never parses this SDK.
const requireCjs = createRequire(import.meta.url);
type OpenAICtor = new () => OpenAI;
let sdk: OpenAICtor | undefined;
function loadSdk(): OpenAICtor {
  if (!sdk) {
    const mod = requireCjs("openai") as { default?: OpenAICtor; OpenAI?: OpenAICtor };
    sdk = mod.default ?? mod.OpenAI;
    if (!sdk) throw new Error("openai resolved without its client class — reinstall dependencies");
  }
  return sdk;
}

type SdkMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * OpenAI's transcript shape differs from toren's normalized one in two ways:
 * tool results are standalone `role:"tool"` messages (not user-content blocks),
 * and tool-call arguments travel as JSON strings. The mapper flattens each
 * normalized message into however many SDK messages that requires, preserving
 * order (tool results must directly follow the assistant's tool_calls).
 */
function toSdkMessages(messages: ChatMessage[]): SdkMessage[] {
  const out: SdkMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("");
      const calls = m.content.filter((b): b is Extract<ContentBlock, { type: "toolUse" }> => b.type === "toolUse");
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      });
      continue;
    }
    // user message: emit tool results first (they answer the preceding
    // assistant tool_calls), then any plain text as a user message.
    let text = "";
    for (const b of m.content) {
      if (b.type === "toolResult") {
        out.push({
          role: "tool",
          tool_call_id: b.toolUseId,
          content: b.isError ? `ERROR: ${b.content}` : b.content,
        });
      } else if (b.type === "text") {
        text += b.text;
      }
    }
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

export function toOpenAIParams(req: ModelRequest): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  return {
    model: req.model.replace(/^openai\//, ""),
    max_completion_tokens: req.maxTokens,
    // gpt-5.6+ reject tools via chat/completions unless reasoning_effort is set.
    ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort as OpenAI.Chat.Completions.ChatCompletionCreateParams["reasoning_effort"] } : {}),
    messages: [
      ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
      ...toSdkMessages(req.messages),
    ],
    ...(req.tools.length
      ? {
          tools: req.tools.map((t) => ({
            type: "function" as const,
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
        }
      : {}),
  };
}

const STOP_MAP: Record<string, StopReason> = {
  stop: "endTurn",
  tool_calls: "toolUse",
  length: "maxTokens",
  content_filter: "refusal",
  function_call: "toolUse",
};

export function fromOpenAIResponse(completion: OpenAI.Chat.Completions.ChatCompletion): ModelResponse {
  const choice = completion.choices[0];
  if (!choice) throw new Error("openai returned no choices");
  const content: ContentBlock[] = [];
  if (choice.message.content) content.push({ type: "text", text: choice.message.content });
  for (const tc of choice.message.tool_calls ?? []) {
    if (tc.type !== "function") continue;
    let input: unknown = {};
    try {
      input = JSON.parse(tc.function.arguments || "{}");
    } catch {
      input = { _raw: tc.function.arguments };
    }
    content.push({ type: "toolUse", id: tc.id, name: tc.function.name, input });
  }
  return {
    content,
    stopReason: STOP_MAP[choice.finish_reason ?? "stop"] ?? "endTurn",
    usage: {
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * OpenAI adapter over toren's normalized model interface.
 * Credentials resolve from the environment (OPENAI_API_KEY);
 * the SDK's built-in retries handle 429/5xx.
 */
export class OpenAIProvider implements ModelProvider {
  private client: OpenAI;
  constructor(client?: OpenAI) {
    this.client = client ?? new (loadSdk())();
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const response = await this.client.chat.completions.create(toOpenAIParams(req));
    return fromOpenAIResponse(response);
  }
}
