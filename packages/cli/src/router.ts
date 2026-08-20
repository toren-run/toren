import { EchoProvider, type ModelProvider, type ModelRequest, type ModelResponse } from "@toren-run/core";
import { AnthropicProvider } from "@toren-run/providers";

/**
 * Routes each request by its model prefix, so different (sub)agents in one
 * run can use different providers. `mock/*` runs fully offline.
 */
export class RouterProvider implements ModelProvider {
  readonly echo = new EchoProvider();
  private anthropic?: AnthropicProvider;

  async complete(req: ModelRequest): Promise<ModelResponse> {
    if (req.model.startsWith("mock/")) return this.echo.complete(req);
    if (req.model.startsWith("anthropic/")) {
      this.anthropic ??= new AnthropicProvider();
      return this.anthropic.complete(req);
    }
    throw new Error(`unknown model provider in "${req.model}" (expected mock/... or anthropic/...)`);
  }
}
