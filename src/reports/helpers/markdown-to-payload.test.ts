import { describe, expect, it } from "vitest";

import { markdownToPayload } from "./markdown-to-payload.js";

describe("markdownToPayload", () => {
  it("extracts the H1 as title and the following line as subtitle", () => {
    const p = markdownToPayload("# Weekly Brief\n\n_How the week went._\n\n## Wins\n\n- shipped X");
    expect(p.title).toBe("Weekly Brief");
    expect(p.subtitle).toBe("How the week went.");
    expect(p.sections[0].heading).toBe("Wins");
    expect(p.sections[0].bullets).toEqual(["shipped X"]);
  });

  it("parses a GFM table into a structured ReportTable", () => {
    const md = [
      "# T",
      "## Status",
      "| Component | State |",
      "| --- | --- |",
      "| API | OK |",
      "| DB | DOWN |",
    ].join("\n");
    const p = markdownToPayload(md);
    const table = p.sections.find((s) => s.table)?.table;
    expect(table?.columns).toEqual(["Component", "State"]);
    expect(table?.rows).toEqual([
      ["API", "OK"],
      ["DB", "DOWN"],
    ]);
  });

  it("captures fenced code blocks as section.code", () => {
    const p = markdownToPayload("# T\n## Logs\n```\nline1\nline2\n```\n");
    expect(p.sections.find((s) => s.code)?.code).toBe("line1\nline2");
  });

  it("strips inline markdown markers the template would render literally", () => {
    const p = markdownToPayload(
      "# T\n## S\nThis is **bold**, _italic_, `code`, and a [link](http://x).",
    );
    const body = p.sections[0].body ?? "";
    expect(body).toContain("bold");
    expect(body).toContain("italic");
    expect(body).toContain("link");
    expect(body).not.toContain("**");
    expect(body).not.toContain("`");
    expect(body).not.toContain("](");
  });

  it("honors overrides over parsed values", () => {
    const p = markdownToPayload("# Parsed Title\n\nbody", {
      title: "Override Title",
      eyebrow: "InfiniBot · Oversight",
      footer: "weekly_brief",
      theme: "black-gold",
    });
    expect(p.title).toBe("Override Title");
    expect(p.eyebrow).toBe("InfiniBot · Oversight");
    expect(p.footer).toBe("weekly_brief");
    expect(p.theme).toBe("black-gold");
  });

  it("always returns a renderable payload (title + at least one section) for plain text", () => {
    const p = markdownToPayload("just some loose text with no headings");
    expect(p.title.length).toBeGreaterThan(0);
    expect(p.sections.length).toBeGreaterThanOrEqual(1);
    expect(p.sections[0].body).toContain("loose text");
  });
});
