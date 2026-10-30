import { describe, expect, it } from "vitest";

import { normalizeCoderModelOverride } from "./model-normalization.js";

describe("normalizeCoderModelOverride", () => {
  it.each(["codex", "claude", "claude-code", "opencode", "gemini", "default"])(
    "treats backend/tool name %s as a request for the configured default",
    (requested) => {
      const result = normalizeCoderModelOverride(requested, "codex");
      expect(result.model).toBeUndefined();
      expect(result.warning).toContain(`"${requested}"`);
      expect(result.warning).toContain("configured default model");
    },
  );

  it("normalizes whitespace and case before recognizing backend names", () => {
    expect(normalizeCoderModelOverride("  CoDeX  ", "codex").model).toBeUndefined();
  });

  it("preserves a real backend model override", () => {
    expect(normalizeCoderModelOverride("gpt-5.6-sol", "codex")).toEqual({
      model: "gpt-5.6-sol",
    });
  });
});
