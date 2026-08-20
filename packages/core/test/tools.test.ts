import { expect, test } from "vitest";
import { z } from "zod";
import { defineTool, toolSpecs } from "../src/tools.js";

test("defineTool produces a provider-ready spec and executable handler", async () => {
  const echo = defineTool({
    name: "echo",
    description: "Echo the input back.",
    input: z.object({ text: z.string() }),
    effects: "none",
    idempotency: "keyed",
    approval: "never",
    handler: async (args) => `echo:${args.text}`,
  });
  const [spec] = toolSpecs([echo]);
  expect(spec!.name).toBe("echo");
  expect(spec!.inputSchema).toMatchObject({ type: "object" });
  expect(await echo.handler({ text: "hi" }, { runId: "r", taskId: "t", env: {} })).toBe("echo:hi");
});
