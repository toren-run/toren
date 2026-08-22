import type { ModelProvider, ModelRequest, ModelResponse } from "../model.js";

/**
 * Deterministic offline provider for demos, scaffolds, and tests: replies
 * `echo(<first user text>)`. Lets `toren init` output run with zero API keys.
 * `mock/slow` is the same echo at three seconds per call, so the quickstart's
 * kill test has something to murder without an API key.
 */
const SLOW_CALL_MS = 3_000;

export class EchoProvider implements ModelProvider {
  calls = new Map<string, number>();

  async complete(req: ModelRequest): Promise<ModelResponse> {
    if (req.model.endsWith("/slow")) await new Promise((r) => setTimeout(r, SLOW_CALL_MS));
    const first = req.messages[0]?.content.find((b) => b.type === "text");
    const input = first && first.type === "text" ? first.text : "";
    this.calls.set(input, (this.calls.get(input) ?? 0) + 1);
    return {
      content: [{ type: "text", text: `echo(${input})` }],
      stopReason: "endTurn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}
