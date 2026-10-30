/**
 * Unit tests for the kanban-tool parent project helpers.
 *
 * These tests exercise the pure normalization + token-overlap functions that
 * drive findOrCreateProject without making any Notion or SQLite calls.
 */
import { describe, expect, it } from "vitest";

// ── Duplicated helpers (same logic as kanban-tool.ts) ────────────────────────
// We re-implement the pure functions here to keep the tests self-contained and
// avoid importing kanban-tool.ts (which has side effects on import: module-
// level Notion config reads, SQLite opens, etc.).

function normalizeTitle(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(input: string): Set<string> {
  const stop = new Set([
    "a",
    "an",
    "the",
    "and",
    "or",
    "to",
    "for",
    "of",
    "in",
    "on",
    "with",
    "by",
    "is",
    "are",
    "be",
    "this",
    "that",
    "it",
    "as",
    "at",
    "from",
  ]);
  return new Set(
    normalizeTitle(input)
      .split(" ")
      .filter((w) => w.length > 2 && !stop.has(w)),
  );
}

function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const tok of a) if (b.has(tok)) intersection++;
  const denom = Math.min(a.size, b.size);
  return denom === 0 ? 0 : intersection / denom;
}

/** Step-0 parent-prefix detection — mirrors kanban-tool.ts logic */
function detectImpliedParent(
  hint: string,
  projects: { id: string; name: string }[],
): string | null {
  const normalizedHint = normalizeTitle(hint);
  let impliedParentId: string | null = null;
  let impliedParentNameLen = 0;
  for (const p of projects) {
    const pNorm = normalizeTitle(p.name);
    if (
      pNorm.length > 0 &&
      pNorm !== normalizedHint &&
      normalizedHint.startsWith(pNorm + " ") &&
      pNorm.length > impliedParentNameLen
    ) {
      impliedParentId = p.id;
      impliedParentNameLen = pNorm.length;
    }
  }
  return impliedParentId;
}

/** Derive parent hint from workdir basename — mirrors claude-coder-tool.ts logic */
function parentHintFromWorkdir(workdir: string, projectHint: string): string | undefined {
  const base = workdir.split(/[/\\]/).filter(Boolean).pop() ?? "";
  const stripped = base
    .replace(/-?(fresh|v\d+|prod|local|dev|staging|main|test|new|beta|alpha)$/i, "")
    .replace(/[-_]/g, " ")
    .trim();
  if (stripped && stripped.toLowerCase() !== projectHint.toLowerCase()) {
    return stripped;
  }
  return undefined;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("normalizeTitle", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeTitle("InfiniBot: Hardware HUD!")).toBe("infinibot hardware hud");
  });
  it("collapses whitespace", () => {
    expect(normalizeTitle("  hello   world  ")).toBe("hello world");
  });
});

describe("tokenOverlap", () => {
  it("returns 1 for identical token sets", () => {
    const a = tokenize("InfiniBot hardware dashboard");
    expect(tokenOverlap(a, a)).toBe(1);
  });
  it("returns 0 for disjoint sets", () => {
    expect(tokenOverlap(tokenize("alpha beta"), tokenize("gamma delta"))).toBe(0);
  });
  it("returns ratio based on smaller set", () => {
    // "infinibot" vs "infinibot hardware hud" — 1 common / min(1,2) = 1
    const a = tokenize("InfiniBot");
    const b = tokenize("InfiniBot hardware hud");
    expect(tokenOverlap(a, b)).toBe(1);
  });
});

describe("detectImpliedParent (step 0 prefix detection)", () => {
  const projects = [
    { id: "p1", name: "InfiniBot" },
    { id: "p2", name: "Lead Generation" },
    { id: "p3", name: "InfiniBot Hardware" },
  ];

  it("detects single-word parent prefix", () => {
    expect(detectImpliedParent("InfiniBot hardware HUD", projects)).toBe("p3");
  });

  it("falls back to shorter parent when longer one doesn't match", () => {
    expect(detectImpliedParent("InfiniBot voice chat", projects)).toBe("p1");
  });

  it("returns null for an exact match (no implied sub-project)", () => {
    expect(detectImpliedParent("InfiniBot", projects)).toBeNull();
  });

  it("returns null when no prefix matches", () => {
    expect(detectImpliedParent("totally unrelated project", projects)).toBeNull();
  });

  it("detects multi-word parent prefix", () => {
    expect(detectImpliedParent("Lead Generation Phase 2", projects)).toBe("p2");
  });
});

describe("parentHintFromWorkdir", () => {
  it("strips -fresh suffix", () => {
    expect(parentHintFromWorkdir("/home/user/InfiniBot-fresh", "hardware HUD")).toBe("InfiniBot");
  });
  it("strips -v2 suffix", () => {
    expect(parentHintFromWorkdir("/home/user/myapp-v2", "dashboard")).toBe("myapp");
  });
  it("strips -prod suffix", () => {
    expect(parentHintFromWorkdir("/home/user/myapp-prod", "deployment fix")).toBe("myapp");
  });
  it("returns undefined when basename matches projectHint", () => {
    expect(parentHintFromWorkdir("/home/user/InfiniBot", "InfiniBot")).toBeUndefined();
  });
  it("converts underscores/hyphens to spaces", () => {
    expect(parentHintFromWorkdir("/projects/my_cool_app", "feature work")).toBe("my cool app");
  });
});
