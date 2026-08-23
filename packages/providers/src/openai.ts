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

// ---- /v1/responses: the API that allows reasoning AND tools together.
// gpt-5.6+ reject function tools on chat/completions unless reasoning is off,
// so a request with real reasoning effort routes here; everything else stays
// on the battle-tested chat/completions path. The digest covers toren's
// normalized request, not the wire shape, so routing changes nothing in-flight.

/** Real reasoning effort ("low"/"medium"/"high") needs /v1/responses; "none" or absent works on chat/completions. */
export function usesResponsesApi(req: Pick<ModelRequest, "reasoningEffort">): boolean {
  return Boolean(req.reasoningEffort && req.reasoningEffort !== "none");
}

export function toResponsesParams(req: ModelRequest): OpenAI.Responses.ResponseCreateParamsNonStreaming {
  const input: OpenAI.Responses.ResponseInputItem[] = [];
  for (const m of req.messages) {
    if (m.role === "assistant") {
      const text = m.content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("");
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } as never);
      for (const b of m.content) {
        if (b.type === "toolUse") input.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      }
      continue;
    }
    let text = "";
    for (const b of m.content) {
      if (b.type === "toolResult") input.push({ type: "function_call_output", call_id: b.toolUseId, output: b.isError ? `ERROR: ${b.content}` : b.content });
      else if (b.type === "text") text += b.text;
    }
    if (text) input.push({ role: "user", content: [{ type: "input_text", text }] });
  }
  return {
    model: req.model.replace(/^openai\//, ""),
    ...(req.system ? { instructions: req.system } : {}),
    max_output_tokens: req.maxTokens,
    reasoning: { effort: req.reasoningEffort as OpenAI.Reasoning["effort"] },
    input,
    ...(req.tools.length
      ? { tools: req.tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.inputSchema as Record<string, unknown>, strict: false })) }
      : {}),
  };
}

export function fromResponsesResponse(res: OpenAI.Responses.Response): ModelResponse {
  const content: ContentBlock[] = [];
  for (const item of res.output ?? []) {
    if (item.type === "message") {
      const text = item.content.filter((c): c is Extract<typeof c, { type: "output_text" }> => c.type === "output_text").map((c) => c.text).join("");
      if (text) content.push({ type: "text", text });
    } else if (item.type === "function_call") {
      let input: unknown = {};
      try { input = JSON.parse(item.arguments || "{}"); } catch { input = { _raw: item.arguments }; }
      content.push({ type: "toolUse", id: item.call_id, name: item.name, input });
    }
    // reasoning items are the model's private scratchpad: not transcript content.
  }
  const stopReason: StopReason = content.some((b) => b.type === "toolUse")
    ? "toolUse"
    : res.status === "incomplete" && res.incomplete_details?.reason === "max_output_tokens"
      ? "maxTokens"
      : res.status === "incomplete" && res.incomplete_details?.reason === "content_filter"
        ? "refusal"
        : "endTurn";
  return {
    content,
    stopReason,
    usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
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
    if (usesResponsesApi(req)) {
      return fromResponsesResponse(await this.client.responses.create(toResponsesParams(req)));
    }
    const response = await this.client.chat.completions.create(toOpenAIParams(req));
    return fromOpenAIResponse(response);
  }
}
