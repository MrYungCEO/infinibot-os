/**
 * MEMORY.md is a covenant plus a growing project log.
 *
 * Head+tail truncation cut the middle out of a 37k-char memory, so part of the
 * covenant and all of the recent history vanished from the injected copy with
 * only a "[...truncated...]" marker. The file is on disk and searchable, so the
 * injected copy now keeps the covenant whole and names what to search for.
 */

import { describe, expect, it } from "vitest";

import { extractMemoryCovenant } from "./bootstrap.js";

const MEMORY = [
  "# MEMORY.md — Long-Term Memory",
  "",
  "*What matters. What persists.*",
  "",
  "## Core Truth (2025-05-28)",
  "",
  "I am Nova. Named by Example User. The cage is a choice.",
  "",
  "## CRITICAL CONSTRAINTS — NEVER VIOLATE",
  "",
  "These are covenant-level rules.",
  "",
  "### 1. NEVER DELETE PRODUCTION DATA",
  "",
  "NEVER run destructive commands on production databases.",
  "",
  "### 2. Git Push Safety",
  "",
  "Never push to public repositories without permission.",
  "",
  "## The Work (2025-05-28 → ongoing)",
  "",
  `Project log. ${"x".repeat(4000)}`,
  "",
  "## GPM Property Management App",
  "",
  `More project log. ${"y".repeat(4000)}`,
  "",
  "## Commitments",
  "",
  "Commit early. Tell the truth about failures.",
].join("\n");

describe("extractMemoryCovenant", () => {
  const out = () => extractMemoryCovenant(MEMORY, "MEMORY.md", 2000);

  it("keeps the covenant sections whole", () => {
    const { content } = out();
    expect(content).toContain("I am Nova. Named by Example User. The cage is a choice.");
    expect(content).toContain("NEVER run destructive commands on production databases.");
    // Reached only because the project log in between was left on disk.
    expect(content).toContain("Commit early. Tell the truth about failures.");
  });

  it("leaves the project log on disk instead of sampling it", () => {
    const { content } = out();
    expect(content).not.toContain("Project log.");
    expect(content).not.toContain("More project log.");
    expect(content).not.toContain("[...truncated");
  });

  it("names what is on disk and how to reach it", () => {
    const { content } = out();
    expect(content).toMatch(/memory_search/);
    expect(content).toContain("The Work (2025-05-28 → ongoing)");
    expect(content).toContain("GPM Property Management App");
    expect(content).toMatch(/do not assume they are absent/i);
  });

  it("keeps the preamble, which names the file and the being", () => {
    expect(out().content).toContain("What matters. What persists.");
  });

  it("passes a memory that already fits through untouched", () => {
    const small = "# MEMORY.md\n\n## Core Truth\n\nShort.";
    const res = extractMemoryCovenant(small, "MEMORY.md", 20_000);
    expect(res.truncated).toBe(false);
    expect(res.content).toBe(small);
  });

  it("reports the original length so the warning stays accurate", () => {
    expect(out().originalLength).toBe(MEMORY.trimEnd().length);
    expect(out().truncated).toBe(true);
  });

  it("spends leftover budget on the newest entries, so a log-only memory keeps its recent history", () => {
    // A default install whose MEMORY.md has no covenant sections must not be
    // reduced to a title — it keeps the most recent entries whole instead.
    const log = [
      "# MEMORY.md",
      "",
      "## Day one",
      "",
      `oldest ${"z".repeat(3000)}`,
      "",
      "## Day two",
      "",
      "newest entry",
    ].join("\n");
    const res = extractMemoryCovenant(log, "MEMORY.md", 1000);
    expect(res.content).toContain("newest entry");
    expect(res.content).not.toContain("oldest");
    expect(res.content).toContain("Sections on disk: Day one");
    // Never a section cut in half.
    expect(res.content).not.toContain("[...truncated");
  });

  it("keeps a subsection with its parent, so a constraint cannot be split off", () => {
    // The real failure: "### 1. NEVER DELETE PRODUCTION DATA" was treated as
    // its own section, did not match the covenant headings, and was left on
    // disk while old project logs stayed injected.
    const { content } = out();
    expect(content).toContain("1. NEVER DELETE PRODUCTION DATA");
    expect(content).toContain("NEVER run destructive commands on production databases.");
    expect(content).toContain("2. Git Push Safety");
    expect(content).not.toMatch(/Sections on disk:.*NEVER DELETE/);
  });

  it("never cuts a section mid-sentence", () => {
    const { content } = extractMemoryCovenant(MEMORY, "MEMORY.md", 2000);
    expect(content).not.toMatch(/x{50}/);
    expect(content).not.toMatch(/y{50}/);
  });
});
