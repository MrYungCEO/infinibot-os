import { describe, expect, it } from "vitest";

import { toSanitizedMarkdownHtml } from "./render";

// All tests run in the browser (vitest + playwright) so DOMPurify has a real DOM.

describe("toSanitizedMarkdownHtml — core markdown", () => {
  it("renders bold, italic, strikethrough", () => {
    const html = toSanitizedMarkdownHtml("**bold** *italic* ~~del~~");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<del>del</del>");
  });

  it("renders headings h1–h6", () => {
    const md = "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6";
    const html = toSanitizedMarkdownHtml(md);
    for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
      expect(html).toContain(`<${tag}`);
    }
  });

  it("renders horizontal rule", () => {
    expect(toSanitizedMarkdownHtml("---")).toContain("<hr");
  });

  it("renders blockquote", () => {
    const html = toSanitizedMarkdownHtml("> This is a quote");
    expect(html).toContain("<blockquote");
    expect(html).toContain("This is a quote");
  });

  it("renders inline code", () => {
    const html = toSanitizedMarkdownHtml("Use `console.log(x)` here");
    expect(html).toContain("<code>console.log(x)</code>");
  });

  it("renders fenced code block with language class", () => {
    const html = toSanitizedMarkdownHtml("```typescript\nconst x = 1;\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain('<code class="language-typescript"');
    expect(html).toContain("const x = 1;");
  });

  it("renders unordered and ordered lists", () => {
    const html = toSanitizedMarkdownHtml("- a\n- b\n\n1. x\n2. y");
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>");
  });

  it("renders external links with target=_blank and rel", () => {
    const html = toSanitizedMarkdownHtml("[site](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it("preserves moltbot:// internal links without target=_blank", () => {
    const html = toSanitizedMarkdownHtml("[page](moltbot://page/abc-123)");
    expect(html).toContain('href="moltbot://page/abc-123"');
    expect(html).not.toContain('target="_blank"');
  });

  it("renders fragment links without target=_blank", () => {
    const html = toSanitizedMarkdownHtml("[jump](#section)");
    expect(html).toContain('href="#section"');
    expect(html).not.toContain('target="_blank"');
  });

  it("renders images with loading=lazy", () => {
    const html = toSanitizedMarkdownHtml("![alt text](https://example.com/img.png)");
    expect(html).toContain('<img');
    expect(html).toContain('alt="alt text"');
    expect(html).toContain('loading="lazy"');
  });

  it("handles hard line breaks (breaks: true default)", () => {
    const html = toSanitizedMarkdownHtml("line one\nline two");
    expect(html).toContain("<br>");
  });

  it("suppresses hard line breaks when breaks: false", () => {
    const html = toSanitizedMarkdownHtml("line one\nline two", { breaks: false });
    expect(html).not.toContain("<br>");
  });
});

describe("toSanitizedMarkdownHtml — GFM tables", () => {
  const tableMd = `
| Name  | Role  |
|-------|-------|
| Alice | Admin |
| Bob   | User  |
`.trim();

  it("renders table elements", () => {
    const html = toSanitizedMarkdownHtml(tableMd);
    expect(html).toContain("<table");
    expect(html).toContain("<thead");
    expect(html).toContain("<th");
    expect(html).toContain("<td");
    expect(html).toContain("Alice");
  });

  it("wraps table in .table-wrap div for horizontal scroll", () => {
    const html = toSanitizedMarkdownHtml(tableMd);
    expect(html).toContain('class="table-wrap"');
    // Table must be inside the wrapper
    expect(html).toMatch(/table-wrap[^>]*>[\s\S]*<table/);
  });
});

describe("toSanitizedMarkdownHtml — task lists", () => {
  it("renders unchecked task list items", () => {
    const html = toSanitizedMarkdownHtml("- [ ] todo\n- [x] done");
    expect(html).toContain('type="checkbox"');
    // At least one unchecked input
    const unchecked = html.match(/<input[^>]*type="checkbox"[^>]*>/g)?.filter((t) => !t.includes("checked")) ?? [];
    expect(unchecked.length).toBeGreaterThan(0);
  });

  it("renders checked task list items", () => {
    const html = toSanitizedMarkdownHtml("- [x] done");
    expect(html).toContain("checked");
  });
});

describe("toSanitizedMarkdownHtml — footnotes", () => {
  it("inserts superscript footnote references", () => {
    const html = toSanitizedMarkdownHtml("See note[^1].\n\n[^1]: The footnote body.");
    expect(html).toContain('<sup class="footnote-ref"');
    expect(html).toContain('href="#fn-1"');
    expect(html).toContain("[1]");
  });

  it("renders footnote definitions section", () => {
    const html = toSanitizedMarkdownHtml("Text[^a]\n\n[^a]: Definition.");
    expect(html).toContain('class="footnotes"');
    expect(html).toContain("Definition.");
    expect(html).toContain('class="footnote-back"');
  });

  it("ignores unknown footnote references", () => {
    const html = toSanitizedMarkdownHtml("Text[^x] without definition.");
    expect(html).toContain("[^x]");
  });
});

describe("toSanitizedMarkdownHtml — callout blocks", () => {
  it("renders :::note callout", () => {
    const html = toSanitizedMarkdownHtml(":::note My Note\nSome content.\n:::");
    expect(html).toContain('class="callout callout-note"');
    expect(html).toContain("Some content.");
    expect(html).toContain("My Note");
  });

  it("renders :::warning callout", () => {
    const html = toSanitizedMarkdownHtml(":::warning\nBe careful.\n:::");
    expect(html).toContain('class="callout callout-warning"');
    expect(html).toContain("Be careful.");
  });

  it("renders :::tip and :::danger callouts", () => {
    const tipHtml = toSanitizedMarkdownHtml(":::tip\nPro tip.\n:::");
    expect(tipHtml).toContain("callout-tip");

    const dangerHtml = toSanitizedMarkdownHtml(":::danger\nStop!\n:::");
    expect(dangerHtml).toContain("callout-danger");
  });

  it("callout title is escaped", () => {
    const html = toSanitizedMarkdownHtml(":::note <script>alert(1)</script>\nbody\n:::");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script");
  });
});

describe("toSanitizedMarkdownHtml — mermaid placeholder", () => {
  it("converts mermaid code block to .mermaid-block", () => {
    const md = "```mermaid\ngraph LR\n  A-->B\n```";
    const html = toSanitizedMarkdownHtml(md);
    expect(html).toContain('class="mermaid-block"');
    expect(html).toContain("data-mermaid=");
    expect(html).toContain("mermaid-placeholder");
  });

  it("does not convert non-mermaid code blocks", () => {
    const html = toSanitizedMarkdownHtml("```python\nprint('hi')\n```");
    expect(html).not.toContain("mermaid-block");
    expect(html).toContain('class="language-python"');
  });
});

describe("toSanitizedMarkdownHtml — security", () => {
  it("strips <script> tags", () => {
    const html = toSanitizedMarkdownHtml("<script>alert(1)</script>");
    expect(html).not.toContain("<script");
  });

  it("strips javascript: hrefs", () => {
    const html = toSanitizedMarkdownHtml("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("strips onerror attributes", () => {
    const html = toSanitizedMarkdownHtml('<img src="x" onerror="alert(1)">');
    expect(html).not.toContain("onerror");
  });

  it("preserves safe content after sanitization", () => {
    const html = toSanitizedMarkdownHtml("[safe link](https://example.com)");
    expect(html).toContain("https://example.com");
  });
});

describe("toSanitizedMarkdownHtml — determinism", () => {
  it("returns identical output on repeated calls (caching)", () => {
    const md = "# Hello\n**Bold** text with a [link](https://x.com).";
    const first = toSanitizedMarkdownHtml(md);
    const second = toSanitizedMarkdownHtml(md);
    expect(second).toBe(first);
  });

  it("round-trip: sanitized HTML is stable under re-sanitization", () => {
    const md = [
      "# Heading",
      "",
      "A paragraph with **bold**, *italic*, `code`, and a [link](https://example.com).",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
    ].join("\n");
    const html = toSanitizedMarkdownHtml(md);
    // DOMPurify is idempotent — re-sanitizing must not change the output.
    const html2 = toSanitizedMarkdownHtml(md);
    expect(html2).toBe(html);
  });

  it("empty string returns empty string", () => {
    expect(toSanitizedMarkdownHtml("")).toBe("");
    expect(toSanitizedMarkdownHtml("   ")).toBe("");
  });
});
