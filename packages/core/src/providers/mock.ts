import type { ModelProvider, ModelRequest, ModelResponse } from "../model.js";

type Scripted = Omit<ModelResponse, "usage"> & { usage?: ModelResponse["usage"] };

export class MockProvider implements ModelProvider {
  public calls = 0;
  private i = 0;
  constructor(private script: Scripted[]) {}

  async complete(_req: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    const next = this.script[this.i++];
    if (!next) throw new Error(`MockProvider script exhausted after ${this.script.length} responses`);
    return { usage: { inputTokens: 10, outputTokens: 10 }, ...next };
  }
}
