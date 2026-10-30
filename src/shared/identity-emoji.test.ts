import { describe, expect, it } from "vitest";
import { isIdentityTemplateHint, sanitizeIdentityEmoji } from "./identity-emoji.js";

describe("sanitizeIdentityEmoji", () => {
  it("keeps :shortcode: only when the caller allows it", () => {
    expect(sanitizeIdentityEmoji(":robot:", { allowShortcode: true })).toBe(":robot:");
    expect(sanitizeIdentityEmoji("(your signature)", { allowShortcode: true })).toBeUndefined();
  });

  it("accepts short emoji / glyphs", () => {
    for (const ok of ["🔭", "✍️", "👩‍💻", "🏳️‍🌈", "🇺🇸", "◆", "⚡", "1️⃣", " 🦞 "]) {
      expect(sanitizeIdentityEmoji(ok)).toBe(ok.trim());
    }
  });

  it("rejects template placeholders and prose", () => {
    for (const bad of [
      "(your signature — pick one that feels right)",
      "your signature - pick one that feels right",
      "(pick something you like)",
      "robot",
      "A",
      "🔭 scout",
      "🔭 (telescope)",
      "12",
      "🔭🔭🔭🔭🔭",
      "",
      "   ",
    ]) {
      expect(sanitizeIdentityEmoji(bad)).toBeUndefined();
    }
    expect(sanitizeIdentityEmoji(undefined)).toBeUndefined();
    expect(sanitizeIdentityEmoji(":robot:")).toBeUndefined();
    expect(sanitizeIdentityEmoji(42)).toBeUndefined();
  });
});

describe("isIdentityTemplateHint", () => {
  it("flags parenthesised template prompts only", () => {
    expect(
      isIdentityTemplateHint("(AI? robot? familiar? ghost in the machine? something weirder?)"),
    ).toBe(true);
    expect(isIdentityTemplateHint("*(to be decided)*")).toBe(true);
    expect(isIdentityTemplateHint("Research familiar (curious)")).toBe(false);
    expect(isIdentityTemplateHint(undefined)).toBe(false);
  });
});
