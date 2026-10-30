import { describe, expect, it } from "vitest";
import { PROVIDER_LOGO_MARKS } from "../lib/provider-logos.data";
import { providerLetters, providerLogoId, providerLogoMark } from "../lib/provider-logos";
import { BRAIN_PROVIDERS } from "../lib/brain-providers";

describe("provider logos", () => {
  it("resolves every id the pickers use", () => {
    for (const [id, want] of [
      ["anthropic", "claude"],
      ["claude-code", "claude"],
      ["codex", "codex"],
      ["codex-cli", "openai"],
      ["openai", "openai"],
      ["google", "gemini"],
      ["gemini-cli", "gemini"],
      ["xai", "grok"],
      ["grok-cli", "grok"],
      ["opencode", "opencode"],
      ["ollama-cloud", "ollama"],
      ["moonshot", "kimi"],
      ["kinglyvault", "kv"],
    ]) {
      expect(providerLogoId(id)).toBe(want);
    }
  });

  it("has a mark for every brain provider in the catalogue", () => {
    expect(BRAIN_PROVIDERS.filter((p) => !providerLogoMark(p.id)).map((p) => p.id)).toEqual([]);
  });

  it("marks are self-contained vectors", () => {
    for (const mark of Object.values(PROVIDER_LOGO_MARKS)) {
      expect(mark.viewBox).toMatch(/^[\d. ]+$/);
      expect(mark.body.strings.join("")).not.toMatch(/<image|href=|https?:\/\/(?!www\.w3\.org)/);
    }
  });

  it("falls back to letters for unknown providers", () => {
    expect(providerLogoMark("acme-ai")).toBeNull();
    expect(providerLetters("Acme AI", "acme-ai")).toBe("AA");
    expect(providerLetters("Nebius (EU)")).toBe("Ne");
    expect(providerLetters("", "foo")).toBe("Fo");
    expect(providerLetters("", "")).toBe("?");
  });
});
