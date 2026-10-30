/**
 * Spec-analysis extractor + synthesis + cost-gate regression tests.
 *
 * Locks in the fix for the "empty spec circular failure": a terse brief like
 * "Print the word OK and exit." must ALWAYS yield ≥1 testable criterion, and the
 * deterministic (no-LLM) path must never produce an empty, ungraded spec.
 */

import { describe, it, expect, vi } from "vitest";

// The verdict chain cascades gateway LLM → CLI coder (codex/claude/opencode on
// PATH, own auth) → local Ollama. On a developer machine those tiers are real
// and reachable, which makes this file slow and machine-dependent. These tests
// lock in the deterministic fallback, so every tier is reported as failed.
vi.mock("./spec-verdict.js", () => ({
  runTieredVerdict: vi.fn(async () => ({
    outcome: null,
    failures: [{ tier: "gateway", reason: "no credentials (test)" }],
  })),
}));
import {
  extractAcceptanceCriteria,
  synthesizeCriteriaHeuristic,
  analyzeSpecVsResult,
} from "./spec-analysis.js";

describe("extractAcceptanceCriteria", () => {
  it("pulls items out of an explicit Acceptance block", () => {
    const brief = [
      "Do the thing.",
      "",
      "Acceptance criteria:",
      "- The build passes",
      "- Tests are green",
    ].join("\n");
    const out = extractAcceptanceCriteria(brief);
    expect(out).toContain("The build passes");
    expect(out).toContain("Tests are green");
  });

  it("returns [] for a terse brief with no list/MUST/acceptance", () => {
    expect(extractAcceptanceCriteria("Print the word OK and exit.")).toEqual([]);
  });
});

describe("synthesizeCriteriaHeuristic", () => {
  it("maps 'print the word OK' → stdout-contains and 'exit' → exit-0", () => {
    const out = synthesizeCriteriaHeuristic("Print the word OK and exit.");
    expect(out).toContain('stdout contains "OK"');
    expect(out).toContain("process exits with code 0");
  });

  it("always yields ≥1 criterion for any non-empty brief", () => {
    for (const brief of [
      "Refactor the parser.",
      "Make it faster",
      "asdf qwer zxcv",
      "Update the README and add a changelog entry",
    ]) {
      expect(synthesizeCriteriaHeuristic(brief).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("returns [] only for a truly empty brief", () => {
    expect(synthesizeCriteriaHeuristic("   ")).toEqual([]);
  });
});

describe("analyzeSpecVsResult (deterministic / no API key)", () => {
  // No ANTHROPIC_API_KEY in the test env → the LLM pass throws and we fall back
  // to the deterministic seed criteria. This is the exact path that previously
  // produced "No explicit acceptance criteria extracted" + an empty spec.
  it("always returns ≥1 inferred criterion for a terse brief", async () => {
    const res = await analyzeSpecVsResult({
      brief: "Print the word OK and exit.",
      transcriptText: "assistant: OK\n",
      filesTouched: [],
      runId: "test-run-terse",
    });
    expect(res.criteria.length).toBeGreaterThanOrEqual(1);
    expect(res.criteriaInferred).toBe(true);
    expect(res.criteria.every((c) => c.inferred)).toBe(true);
    // Whether graded by the LLM or the deterministic heuristic, at least one
    // inferred criterion must concern the "OK" output (quote style may vary).
    expect(res.criteria.some((c) => /\bOK\b/.test(c.text))).toBe(true);
  });

  it("only an empty run (no brief, no transcript, no files) yields zero criteria", async () => {
    const res = await analyzeSpecVsResult({
      brief: "",
      transcriptText: "",
      filesTouched: [],
      runId: "test-run-empty",
    });
    expect(res.criteria.length).toBe(0);
    expect(res.summary).toMatch(/no observable output|empty/i);
  });

  it("preserves explicit criteria verbatim and marks them not-inferred", async () => {
    const res = await analyzeSpecVsResult({
      brief: "Acceptance:\n- The CLI prints a version string",
      transcriptText: "assistant: done",
      filesTouched: [{ path: "cli.ts", action: "edited" }],
      runId: "test-run-explicit",
    });
    expect(res.criteria.length).toBeGreaterThanOrEqual(1);
    expect(res.criteriaInferred).toBe(false);
    expect(res.criteria[0].text).toBe("The CLI prints a version string");
  });
});
