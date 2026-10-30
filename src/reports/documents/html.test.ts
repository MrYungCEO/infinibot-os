import { describe, expect, it } from "vitest";
import {
  esc,
  escMultiline,
  escProse,
  escUrl,
  isEmbeddableImage,
  safeColor,
  safeUrl,
} from "./html.js";

describe("esc", () => {
  it("neutralises tag and attribute breakouts", () => {
    expect(esc(`<script>alert(1)</script>`)).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(esc(`" onload="alert(1)`)).toBe("&quot; onload&#61;&quot;alert(1)");
    expect(esc(`' onmouseover='x`)).toBe("&#39; onmouseover&#61;&#39;x");
    // Backtick + equals are escaped too: old IE attribute parsing aside, this
    // makes unquoted-attribute contexts safe as well.
    expect(esc("a`b=c")).toBe("a&#96;b&#61;c");
  });

  it("escapes ampersands first so entities are not double-decoded", () => {
    expect(esc("Ampersand & <b>")).toBe("Ampersand &amp; &lt;b&gt;");
    expect(esc("&lt;")).toBe("&amp;lt;");
  });

  it("renders null/undefined as empty rather than the string 'null'", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
    expect(esc(0)).toBe("0");
  });
});

describe("escMultiline", () => {
  it("escapes first, then converts real newlines to breaks", () => {
    expect(escMultiline("a\nb")).toBe("a<br>b");
    expect(escMultiline("a\r\nb")).toBe("a<br>b");
    // A literal "<br>" typed by a user stays inert text.
    expect(escMultiline("<br>")).toBe("&lt;br&gt;");
  });
});

describe("escProse", () => {
  it("turns hyphen lines into a real list", () => {
    // People type bullet lists with hyphens; printing "- Weeks 1-2" verbatim in
    // a client-facing proposal reads as a bug.
    expect(escProse("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>");
    expect(escProse("* one\n• two")).toBe("<ul><li>one</li><li>two</li></ul>");
  });

  it("keeps mixed blocks as paragraphs", () => {
    expect(escProse("Intro line\n- not a pure list")).toBe(
      "<p>Intro line<br>- not a pure list</p>",
    );
  });

  it("separates paragraphs on blank lines and escapes each", () => {
    expect(escProse("a\n\n<b>")).toBe("<p>a</p><p>&lt;b&gt;</p>");
  });

  it("escapes bullet content", () => {
    expect(escProse("- <script>x</script>")).toBe(
      "<ul><li>&lt;script&gt;x&lt;/script&gt;</li></ul>",
    );
  });

  it("is empty for empty input", () => {
    expect(escProse("")).toBe("");
    expect(escProse(null)).toBe("");
  });
});

describe("escUrl", () => {
  it("leaves base64 padding and query strings intact", () => {
    // esc() would turn these "=" into "&#61;" — correct but unreadable, and it
    // makes the base64 in a rendered document ungreppable.
    expect(escUrl("data:image/png;base64,iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(escUrl("https://pay.example/i?id=42&ref=7")).toBe(
      "https://pay.example/i?id=42&amp;ref=7",
    );
  });

  it("still closes the attribute-escape holes", () => {
    expect(escUrl('https://x/"onload="y')).toBe("https://x/&quot;onload=&quot;y");
    expect(escUrl("https://x/<b>")).toBe("https://x/&lt;b&gt;");
  });
});

describe("safeColor", () => {
  it("accepts hex, rgb(a), hsl(a) and bare keywords", () => {
    expect(safeColor("#d4af37", "#000")).toBe("#d4af37");
    expect(safeColor("#FFF", "#000")).toBe("#FFF");
    expect(safeColor("rgb(10, 20, 30)", "#000")).toBe("rgb(10, 20, 30)");
    expect(safeColor("rgba(10,20,30,0.5)", "#000")).toBe("rgba(10,20,30,0.5)");
    expect(safeColor("hsl(30, 40%, 50%)", "#000")).toBe("hsl(30, 40%, 50%)");
    expect(safeColor("Rebeccapurple", "#000")).toBe("rebeccapurple");
  });

  it("rejects CSS breakouts and falls back", () => {
    // A branding_json value is attacker-influenceable; it must not be able to
    // close the declaration and open new rules.
    expect(safeColor("red; } body { background: url(https://evil/x) ", "#000")).toBe("#000");
    expect(safeColor("url(https://evil/x)", "#000")).toBe("#000");
    expect(safeColor("expression(alert(1))", "#000")).toBe("#000");
    expect(safeColor("#gggggg", "#000")).toBe("#000");
    expect(safeColor("", "#000")).toBe("#000");
    expect(safeColor(null, "#000")).toBe("#000");
    expect(safeColor(42, "#000")).toBe("#000");
  });

  it("rejects absurdly long values", () => {
    expect(safeColor(`#${"a".repeat(64)}`, "#000")).toBe("#000");
  });
});

describe("safeUrl / isEmbeddableImage", () => {
  it("passes data-image, http(s) and mailto", () => {
    expect(safeUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
    expect(safeUrl("https://pay.example/inv/1")).toBe("https://pay.example/inv/1");
    expect(safeUrl("mailto:a@b.example")).toBe("mailto:a@b.example");
  });

  it("drops script-bearing schemes", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeUrl("  ")).toBeNull();
  });

  it("only treats data: images as embeddable, so rendering stays offline", () => {
    expect(isEmbeddableImage("data:image/png;base64,AAAA")).toBe(true);
    expect(isEmbeddableImage("https://cdn.example/logo.png")).toBe(false);
    expect(isEmbeddableImage(null)).toBe(false);
  });
});
