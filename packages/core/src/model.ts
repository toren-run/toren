export interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "toolUse"; id: string; name: string; input: unknown }
  | { type: "toolResult"; toolUseId: string; content: string; isError?: boolean };

export interface ChatMessage { role: "user" | "assistant"; content: ContentBlock[] }

export interface ModelRequest {
  model: string;                       // "anthropic/claude-opus-5"
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  /** OpenAI reasoning models: "none" | "low" | "medium" | "high". Absent keeps old request digests byte-identical. */
  reasoningEffort?: string;
}

export type StopReason = "endTurn" | "toolUse" | "maxTokens" | "refusal";

export interface ModelResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ModelProvider {
  complete(req: ModelRequest): Promise<ModelResponse>;
}
