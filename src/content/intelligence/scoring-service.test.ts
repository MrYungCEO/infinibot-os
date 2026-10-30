/**
 * Scoring service — unit tests for JSON parse + tier mapping + validation.
 *
 * No live API calls. All fixtures are inline.
 */

import { describe, it, expect } from "vitest";
import { extractScoreJson, validateScore, tierFromScore } from "./scoring-service.js";

// ═══════════════════════════════════════════════════════════════════
// TIER MAPPING
// ═══════════════════════════════════════════════════════════════════

describe("tierFromScore", () => {
  it("maps 9.0+ to S", () => {
    expect(tierFromScore(9.0)).toBe("S");
    expect(tierFromScore(9.5)).toBe("S");
    expect(tierFromScore(10.0)).toBe("S");
  });

  it("maps 7.0-8.9 to A", () => {
    expect(tierFromScore(7.0)).toBe("A");
    expect(tierFromScore(7.5)).toBe("A");
    expect(tierFromScore(8.9)).toBe("A");
  });

  it("maps 5.0-6.9 to B", () => {
    expect(tierFromScore(5.0)).toBe("B");
    expect(tierFromScore(5.5)).toBe("B");
    expect(tierFromScore(6.9)).toBe("B");
  });

  it("maps <5.0 to C", () => {
    expect(tierFromScore(4.9)).toBe("C");
    expect(tierFromScore(1.0)).toBe("C");
    expect(tierFromScore(0.0)).toBe("C");
  });

  it("boundary: 8.99 is A, 9.0 is S", () => {
    expect(tierFromScore(8.99)).toBe("A");
    expect(tierFromScore(9.0)).toBe("S");
  });

  it("boundary: 6.99 is B, 7.0 is A", () => {
    expect(tierFromScore(6.99)).toBe("B");
    expect(tierFromScore(7.0)).toBe("A");
  });

  it("boundary: 4.99 is C, 5.0 is B", () => {
    expect(tierFromScore(4.99)).toBe("C");
    expect(tierFromScore(5.0)).toBe("B");
  });
});

// ═══════════════════════════════════════════════════════════════════
// JSON EXTRACTION
// ═══════════════════════════════════════════════════════════════════

describe("extractScoreJson", () => {
  it("parses clean JSON", () => {
    const input =
      '{"hook":7.5,"value":8.0,"viral":6.0,"overall":7.2,"tier":"A","reason":"Good","idea_vs_execution":"Aligned"}';
    const result = extractScoreJson(input);
    expect(result).not.toBeNull();
    expect(result!["hook"]).toBe(7.5);
    expect(result!["tier"]).toBe("A");
  });

  it("strips markdown code fences", () => {
    const input =
      '```json\n{"hook":6.0,"value":7.0,"viral":5.0,"overall":6.2,"tier":"B","reason":"ok","idea_vs_execution":"idea>execution"}\n```';
    const result = extractScoreJson(input);
    expect(result).not.toBeNull();
    expect(result!["hook"]).toBe(6.0);
  });

  it("strips code fences without json label", () => {
    const input =
      '```\n{"hook":6.0,"value":7.0,"viral":5.0,"overall":6.2,"tier":"B","reason":"ok","idea_vs_execution":"ok"}\n```';
    const result = extractScoreJson(input);
    expect(result).not.toBeNull();
    expect(result!["value"]).toBe(7.0);
  });

  it("extracts JSON from surrounding prose", () => {
    const input =
      'Here is the analysis:\n{"hook":8.0,"value":9.0,"viral":7.5,"overall":8.2,"tier":"A","reason":"Strong","idea_vs_execution":"Execution>idea"}\nDone.';
    const result = extractScoreJson(input);
    expect(result).not.toBeNull();
    expect(result!["overall"]).toBe(8.2);
  });

  it("extracts JSON with nested whitespace and newlines", () => {
    const input =
      '{\n  "hook": 5.5,\n  "value": 6.0,\n  "viral": 4.0,\n  "overall": 5.2,\n  "tier": "B",\n  "reason": "Average reel",\n  "idea_vs_execution": "Aligned"\n}';
    const result = extractScoreJson(input);
    expect(result).not.toBeNull();
    expect(result!["viral"]).toBe(4.0);
  });

  it("returns null for empty string", () => {
    expect(extractScoreJson("")).toBeNull();
  });

  it("returns null for prose without JSON", () => {
    expect(extractScoreJson("This is just text with no JSON object.")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(extractScoreJson("{broken: json,}")).toBeNull();
  });

  it("handles trailing backticks after fences", () => {
    const input =
      '```json\n{"hook":9.0,"value":9.0,"viral":9.0,"overall":9.0,"tier":"S","reason":"Great","idea_vs_execution":"Aligned"}\n```\n`';
    const result = extractScoreJson(input);
    expect(result).not.toBeNull();
    expect(result!["tier"]).toBe("S");
  });

  it("handles string-encoded numbers (model returns '7.5' instead of 7.5)", () => {
    const input =
      '{"hook":"7.5","value":"8.0","viral":"6.0","overall":"7.2","tier":"A","reason":"ok","idea_vs_execution":"ok"}';
    const result = extractScoreJson(input);
    expect(result).not.toBeNull();
    // extractScoreJson just parses — validateScore handles the conversion
    expect(result!["hook"]).toBe("7.5");
  });
});

// ═══════════════════════════════════════════════════════════════════
// SCORE VALIDATION
// ═══════════════════════════════════════════════════════════════════

describe("validateScore", () => {
  const shortcode = "TEST123";

  it("validates a well-formed score dict", () => {
    const data = {
      hook: 7.5,
      value: 8.0,
      viral: 6.0,
      overall: 7.2,
      tier: "A",
      reason: "Strong hook but niche appeal limits virality.",
      idea_vs_execution: "Execution elevated a weak concept.",
    };
    const result = validateScore(data, shortcode);
    expect(result).not.toBeNull();
    expect(result!.shortcode).toBe("TEST123");
    expect(result!.hook).toBe(7.5);
    expect(result!.value).toBe(8.0);
    expect(result!.viral).toBe(6.0);
    expect(result!.overall).toBe(7.2);
    expect(result!.tier).toBe("A"); // 7.2 → A
    expect(result!.reason).toContain("Strong hook");
    expect(result!.idea_vs_execution).toContain("Execution");
  });

  it("always recomputes tier from overall (ignores model's tier)", () => {
    const data = {
      hook: 9.5,
      value: 9.0,
      viral: 9.5,
      overall: 9.4,
      tier: "C", // model said C but overall is 9.4 → should be S
      reason: "Great reel.",
      idea_vs_execution: "Aligned.",
    };
    const result = validateScore(data, shortcode);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe("S"); // recomputed, not trusted
  });

  it("clamps scores to 1-10 range", () => {
    const data = {
      hook: 15.0,
      value: -2.0,
      viral: 11.0,
      overall: 8.0,
      tier: "A",
      reason: "Test",
      idea_vs_execution: "Test",
    };
    const result = validateScore(data, shortcode);
    expect(result).not.toBeNull();
    expect(result!.hook).toBe(10.0); // clamped down
    expect(result!.value).toBe(1.0); // clamped up
    expect(result!.viral).toBe(10.0); // clamped down
    expect(result!.overall).toBe(8.0); // already in range
  });

  it("rounds to 1 decimal place", () => {
    const data = {
      hook: 7.567,
      value: 8.234,
      viral: 6.891,
      overall: 7.456,
      tier: "A",
      reason: "Test",
      idea_vs_execution: "Test",
    };
    const result = validateScore(data, shortcode);
    expect(result).not.toBeNull();
    expect(result!.hook).toBe(7.6);
    expect(result!.value).toBe(8.2);
    expect(result!.viral).toBe(6.9);
    expect(result!.overall).toBe(7.5);
  });

  it("parses string-encoded numbers (model returns '7.5' instead of 7.5)", () => {
    const data = {
      hook: "7.5",
      value: "8.0",
      viral: "6.0",
      overall: "7.2",
      tier: "A",
      reason: "ok",
      idea_vs_execution: "ok",
    };
    const result = validateScore(data, shortcode);
    expect(result).not.toBeNull();
    expect(result!.hook).toBe(7.5);
    expect(result!.value).toBe(8.0);
    expect(result!.overall).toBe(7.2);
  });

  it("returns null when required keys are missing", () => {
    const data = {
      hook: 7.5,
      value: 8.0,
      viral: 6.0,
      overall: 7.2,
      // missing tier, reason, idea_vs_execution
    };
    expect(validateScore(data, shortcode)).toBeNull();
  });

  it("returns null when score fields are non-numeric and unparseable", () => {
    const data = {
      hook: "excellent",
      value: 8.0,
      viral: 6.0,
      overall: 7.2,
      tier: "A",
      reason: "Test",
      idea_vs_execution: "Test",
    };
    expect(validateScore(data, shortcode)).toBeNull();
  });

  it("truncates reason and idea_vs_execution to 400 chars", () => {
    const longReason = "A".repeat(600);
    const longIve = "B".repeat(600);
    const data = {
      hook: 7.5,
      value: 8.0,
      viral: 6.0,
      overall: 7.2,
      tier: "A",
      reason: longReason,
      idea_vs_execution: longIve,
    };
    const result = validateScore(data, shortcode);
    expect(result).not.toBeNull();
    expect(result!.reason.length).toBe(400);
    expect(result!.idea_vs_execution.length).toBe(400);
  });

  it("handles null/undefined score fields gracefully", () => {
    const data = {
      hook: null,
      value: undefined,
      viral: 6.0,
      overall: 7.2,
      tier: "A",
      reason: "Test",
      idea_vs_execution: "Test",
    };
    expect(validateScore(data, shortcode)).toBeNull();
  });

  it("handles NaN string values", () => {
    const data = {
      hook: "NaN",
      value: "8.0",
      viral: "6.0",
      overall: "7.2",
      tier: "A",
      reason: "Test",
      idea_vs_execution: "Test",
    };
    expect(validateScore(data, shortcode)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// FIXTURE-BASED INTEGRATION: extract → validate pipeline
// ═══════════════════════════════════════════════════════════════════

describe("extract + validate pipeline (fixtures)", () => {
  const fixtures: Array<{
    name: string;
    raw: string;
    expectValid: boolean;
    expectedTier?: string;
  }> = [
    {
      name: "clean S-tier response",
      raw: `{"shortcode":"ABC1","hook":9.5,"value":9.0,"viral":9.5,"overall":9.4,"tier":"S","reason":"Viral hook with high value density.","idea_vs_execution":"Idea and execution aligned."}`,
      expectValid: true,
      expectedTier: "S",
    },
    {
      name: "A-tier with code fences",
      raw: '```json\n{"shortcode":"ABC2","hook":7.5,"value":8.0,"viral":6.0,"overall":7.2,"tier":"A","reason":"Strong hook but niche appeal limits virality.","idea_vs_execution":"Execution elevated a weak concept via authentic storytelling."}\n```',
      expectValid: true,
      expectedTier: "A",
    },
    {
      name: "B-tier with surrounding prose",
      raw: `Here is my analysis:\n{"shortcode":"ABC3","hook":5.5,"value":6.0,"viral":4.0,"overall":5.2,"tier":"B","reason":"Average content with room for improvement.","idea_vs_execution":"Idea outweighs execution."}\nDone.`,
      expectValid: true,
      expectedTier: "B",
    },
    {
      name: "C-tier with string numbers",
      raw: `{"shortcode":"ABC4","hook":"3.0","value":"4.0","viral":"2.0","overall":"3.0","tier":"C","reason":"Weak hook and low value.","idea_vs_execution":"Execution failed a decent idea."}`,
      expectValid: true,
      expectedTier: "C",
    },
    {
      name: "model gives wrong tier, we fix it",
      raw: `{"shortcode":"ABC5","hook":9.0,"value":9.0,"viral":9.0,"overall":9.0,"tier":"B","reason":"Great reel.","idea_vs_execution":"Aligned."}`,
      expectValid: true,
      expectedTier: "S", // 9.0 → S, not B
    },
    {
      name: "out of range scores get clamped",
      raw: `{"shortcode":"ABC6","hook":15.0,"value":-5.0,"viral":11.0,"overall":8.5,"tier":"A","reason":"Test.","idea_vs_execution":"Test."}`,
      expectValid: true,
      expectedTier: "A", // 8.5 → A
    },
    {
      name: "malformed JSON → null",
      raw: `This is not JSON at all.`,
      expectValid: false,
    },
    {
      name: "missing required keys → null",
      raw: `{"hook":7.5,"value":8.0}`,
      expectValid: false,
    },
  ];

  for (const fx of fixtures) {
    it(`fixture: ${fx.name}`, () => {
      const extracted = extractScoreJson(fx.raw);
      if (!fx.expectValid) {
        // Either extraction fails, or validation fails
        if (extracted) {
          const validated = validateScore(extracted, "FIXTURE");
          expect(validated).toBeNull();
        }
        return;
      }

      expect(extracted).not.toBeNull();
      const validated = validateScore(extracted!, "FIXTURE");
      expect(validated).not.toBeNull();
      expect(validated!.tier).toBe(fx.expectedTier);
    });
  }
});
