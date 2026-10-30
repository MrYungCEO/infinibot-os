import { describe, expect, it } from "vitest";
import {
  capToolResultText,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  resolveToolResultMaxChars,
} from "./tool-result-cap.js";

describe("resolveToolResultMaxChars", () => {
  it("keeps the 60k default for large or unknown windows", () => {
    expect(resolveToolResultMaxChars(undefined)).toBe(DEFAULT_MAX_TOOL_RESULT_CHARS);
    expect(resolveToolResultMaxChars(128_000)).toBe(DEFAULT_MAX_TOOL_RESULT_CHARS);
    expect(resolveToolResultMaxChars(1_000_000)).toBe(DEFAULT_MAX_TOOL_RESULT_CHARS);
  });

  it("shrinks for a 32k local Ollama window so one result can't overflow it", () => {
    const cap = resolveToolResultMaxChars(32_768);
    expect(cap).toBe(26_214);
    // ~6.5k tokens: with the CMO's ~22k-token prompt the turn stays under 32k.
    expect(cap / 4).toBeLessThan(32_768 - 22_000);
  });

  it("never goes below 8k chars", () => {
    expect(resolveToolResultMaxChars(4_096)).toBe(8_000);
  });

  it("truncates with a note at the resolved cap", () => {
    const cap = resolveToolResultMaxChars(32_768);
    const out = capToolResultText(
      { content: [{ type: "text", text: "x".repeat(100_000) }] },
      cap,
      "kanban",
    ) as { content: Array<{ text: string }> };
    expect(out.content[0].text.length).toBeLessThan(cap + 400);
    expect(out.content[0].text).toMatch(/kanban output truncated/);
  });
});
