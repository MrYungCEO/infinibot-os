import { describe, expect, it } from "vitest";
import { InfinibotSchema } from "./zod-schema.js";

// The web setup wizard (ui/src/ui/views/setup-wizard.ts) patches these shapes
// via config.patch; they must pass the strict schema or the step fails.
describe("setup wizard config patches validate", () => {
  it.each([
    [
      "provider",
      { agents: { defaults: { model: { primary: "openrouter/anthropic/claude-sonnet-4-5" } } } },
    ],
    [
      "integrations",
      {
        notion: { apiKey: "secret_x" },
        tools: { web: { search: { apiKey: "brv" } } },
        coder: { backend: "opencode" },
      },
    ],
    ["federation", { federation: { mode: "master" } }],
  ])("%s patch", (_name, patch) => {
    expect(InfinibotSchema.safeParse(patch).success).toBe(true);
  });

  it("rejects the old root providers/defaultModel patch", () => {
    expect(
      InfinibotSchema.safeParse({
        providers: { openai: { apiKey: "x" } },
        defaultModel: "openai/gpt-4o",
      }).success,
    ).toBe(false);
  });
});
