import { describe, expect, it } from "vitest";

import { buildTaskContent, enrichTaskWithContent, inferComplexity } from "./content-builder.js";
import type { TaskSkillRef } from "./types.js";

describe("inferComplexity", () => {
  it("returns trivial for empty/short tasks", () => {
    expect(inferComplexity({ title: "fix typo" })).toBe("trivial");
  });

  it("returns simple when there's any description or a medium title", () => {
    expect(inferComplexity({ title: "wire up new button" })).toBe("simple");
    expect(inferComplexity({ title: "ok", description: "do the thing" })).toBe("simple");
  });

  it("returns standard for multi-line descriptions or many tags", () => {
    expect(
      inferComplexity({
        title: "ship feature x",
        description: "line one\nline two",
      }),
    ).toBe("standard");
    expect(
      inferComplexity({
        title: "ok",
        tags: ["a", "b", "c"],
      }),
    ).toBe("standard");
  });

  it("returns robust for long titles or rich signal", () => {
    expect(
      inferComplexity({
        title:
          "rebuild the autonomy orchestrator goal loop with retries persistence sub agents and tests",
      }),
    ).toBe("robust");
    expect(
      inferComplexity({
        title: "ok",
        tags: ["a", "b"],
        requiredTools: ["bash", "git"],
        requiredSpecialties: ["typescript"],
      }),
    ).toBe("robust");
  });
});

describe("buildTaskContent", () => {
  it("renders trivial as a single line", () => {
    const content = buildTaskContent({
      title: "fix typo",
      complexity: "trivial",
      what: "fixed README typo",
    });
    expect(content.split("\n").length).toBe(1);
    expect(content).toContain("fixed README typo");
  });

  it("renders simple as 2–4 lines without artifacts", () => {
    const content = buildTaskContent({
      title: "wire new button",
      complexity: "simple",
      what: "added click handler",
      where: "ui/src/foo.ts",
      artifacts: [{ label: "PR", url: "https://example.com" }],
    });
    expect(content.split("\n").length).toBeLessThanOrEqual(4);
    expect(content).toContain("added click handler");
    expect(content).toContain("Where: ui/src/foo.ts");
    expect(content).not.toContain("https://example.com"); // no artifacts in simple
  });

  it("renders standard with bulleted What/Where/Details", () => {
    const content = buildTaskContent({
      title: "ship feature x",
      complexity: "standard",
      what: "did the work",
      where: "src/foo.ts",
      details: "handled error path",
    });
    expect(content).toContain("**What:**");
    expect(content).toContain("**Where:**");
    expect(content).toContain("**Details:**");
    expect(content).not.toMatch(/^#\s/m); // no headings in standard
  });

  it("renders robust with headings, artifacts and no skill footer when absent", () => {
    const content = buildTaskContent({
      title: "big refactor",
      complexity: "robust",
      what: "rebuilt module",
      where: "src/big.ts",
      details: "all tests pass",
      artifacts: [{ label: "PR", url: "https://example.com/pr" }],
    });
    expect(content).toMatch(/^# big refactor/);
    expect(content).toContain("## What");
    expect(content).toContain("## Where");
    expect(content).toContain("## Details");
    expect(content).toContain("### Artifacts");
    expect(content).toContain("https://example.com/pr");
    expect(content).not.toContain("Skill generated:");
  });

  it("includes the skill footer only when skillRef is set", () => {
    const skillRef: TaskSkillRef = {
      id: "skill-big-refactor",
      name: "skill-big-refactor",
      path: "/tmp/skills/skill-big-refactor/SKILL.md",
      reason: "captured from robust task",
      createdAt: 1700000000000,
    };
    const without = buildTaskContent({
      title: "big refactor",
      complexity: "robust",
      what: "rebuilt module",
    });
    const withFooter = buildTaskContent({
      title: "big refactor",
      complexity: "robust",
      what: "rebuilt module",
      skillRef,
    });
    expect(without).not.toContain("Skill generated:");
    expect(withFooter).toContain("Skill generated:");
    expect(withFooter).toContain("skill-big-refactor");
    expect(withFooter).toContain("/tmp/skills/skill-big-refactor/SKILL.md");
  });

  it("falls back to a sensible body when called with bare title", () => {
    const content = buildTaskContent({ title: "do thing" });
    expect(content.length).toBeGreaterThan(0);
  });
});

describe("enrichTaskWithContent", () => {
  it("infers complexity and produces matching content", () => {
    const { content, complexity } = enrichTaskWithContent({ title: "fix typo" });
    expect(complexity).toBe("trivial");
    expect(content.length).toBeGreaterThan(0);
    expect(content.split("\n").length).toBe(1);
  });

  it("respects an explicit complexity override", () => {
    const { content, complexity } = enrichTaskWithContent({
      title: "fix typo",
      complexity: "robust",
      what: "did it",
    });
    expect(complexity).toBe("robust");
    expect(content).toMatch(/^# fix typo/);
  });
});
