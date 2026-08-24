import { EchoProvider, type ModelProvider, type ModelRequest, type ModelResponse } from "@toren-run/core";
import { AnthropicProvider, BedrockProvider, OpenAIProvider } from "@toren-run/providers";

/**
 * Routes each request by its model prefix, so different (sub)agents in one
 * run can use different providers. `mock/*` runs fully offline.
 */
export class RouterProvider implements ModelProvider {
  readonly echo = new EchoProvider();
  private anthropic?: AnthropicProvider;
  private openai?: OpenAIProvider;
  private bedrock?: BedrockProvider;

  async complete(req: ModelRequest): Promise<ModelResponse> {
    if (req.model.startsWith("mock/")) return this.echo.complete(req);
    if (req.model.startsWith("anthropic/")) {
      this.anthropic ??= new AnthropicProvider();
      return this.anthropic.complete(req);
    }
    if (req.model.startsWith("openai/")) {
      this.openai ??= new OpenAIProvider();
      return this.openai.complete(req);
    }
    if (req.model.startsWith("bedrock/")) {
      this.bedrock ??= new BedrockProvider();
      return this.bedrock.complete(req);
    }
    throw new Error(`unknown model provider in "${req.model}" (expected mock/..., anthropic/..., openai/..., or bedrock/...)`);
  }
}
