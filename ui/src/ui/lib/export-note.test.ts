import { describe, expect, it } from "vitest";
import {
  noteToMarkdown,
  noteToHtml,
  safeFilename,
} from "./export-note";

describe("safeFilename", () => {
  it("lowercases and hyphenates the title", () => {
    expect(safeFilename("My Awesome Note", "md")).toBe("my-awesome-note.md");
  });

  it("strips special characters", () => {
    expect(safeFilename("Hello, World! #2024", "html")).toBe("hello-world-2024.html");
  });

  it("falls back to untitled for empty input", () => {
    expect(safeFilename("", "txt")).toBe("untitled.txt");
  });

  it("truncates long titles to 80 chars", () => {
    const long = "a".repeat(120);
    const result = safeFilename(long, "md");
    expect(result.length).toBeLessThanOrEqual(85);
    expect(result).toMatch(/^a+\.md$/);
  });
});

describe("noteToMarkdown", () => {
  const body = "Hello **world**\n\n- Item A\n- Item B";

  it("includes the title as H1", () => {
    const md = noteToMarkdown("Test Note", body);
    expect(md).toContain("# Test Note");
  });

  it("includes body markdown verbatim", () => {
    const md = noteToMarkdown("Test Note", body);
    expect(md).toContain("Hello **world**");
    expect(md).toContain("- Item A");
  });

  it("includes description when provided", () => {
    const md = noteToMarkdown("Test", body, { description: "A test note" });
    expect(md).toContain("> A test note");
  });

  it("includes tags and category line", () => {
    const md = noteToMarkdown("Test", body, {
      tags: ["dev", "docs"],
      category: "engineering",
    });
    expect(md).toContain("**Category:** engineering");
    expect(md).toContain("**Tags:** dev, docs");
  });

  it("includes updated date line", () => {
    const md = noteToMarkdown("Test", body, { updatedAt: "2024-01-15T10:00:00Z" });
    expect(md).toContain("2024");
  });

  it("uses Untitled when name is empty", () => {
    const md = noteToMarkdown("", body);
    expect(md).toContain("# Untitled");
  });
});

describe("noteToHtml (light checks — empty body avoids DOMPurify)", () => {
  it("produces a full HTML document with title", () => {
    const html = noteToHtml("Test Note", "", "clean");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>Test Note</title>");
    expect(html).toContain("<h1 class=\"ex-title\">Test Note</h1>");
  });

  it("applies the correct style class to the article", () => {
    expect(noteToHtml("Test", "", "clean")).toContain("ex-clean");
    expect(noteToHtml("Test", "", "dark")).toContain("ex-dark");
    expect(noteToHtml("Test", "", "proposal")).toContain("ex-proposal");
    expect(noteToHtml("Test", "", "compact")).toContain("ex-compact");
  });
});
