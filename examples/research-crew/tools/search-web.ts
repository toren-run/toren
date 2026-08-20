import { defineTool } from "@toren/core";
import { z } from "zod";

export default defineTool({
  name: "search_web",
  description: "Search the web and return the top result.",
  input: z.object({ query: z.string() }),
  effects: "external",
  idempotency: "keyed",
  approval: "never",
  handler: async ({ query }) => `(stub) top result for: ${query}`,
});
