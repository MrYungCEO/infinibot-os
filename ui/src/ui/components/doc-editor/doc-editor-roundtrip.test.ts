import { parseHTML } from "linkedom";
import { beforeAll, describe, expect, it } from "vitest";
import { editorHtmlToMarkdown, htmlStringToMarkdown } from "./html-to-md.js";
import {
  highlightCode,
  markdownToEditorHtml,
  sanitizeEditorHtml,
  setSanitizerWindow,
} from "./md-to-html.js";

// ── linkedom window + the few DOM APIs DOMPurify needs ────────────────────
const { window: win, document: doc } = parseHTML("<!doctype html><html><head></head><body></body></html>");
const w = win as any;
w.NodeFilter ??= {
  SHOW_ALL: 0xffffffff, SHOW_ELEMENT: 1, SHOW_ATTRIBUTE: 2, SHOW_TEXT: 4, SHOW_CDATA_SECTION: 8,
  SHOW_PROCESSING_INSTRUCTION: 64, SHOW_COMMENT: 128, SHOW_DOCUMENT: 256,
  FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3,
};
{
  // linkedom's DOMParser does not wrap fragments in <html><body>.
  const proto = w.DOMParser.prototype;
  const orig = proto.parseFromString;
  proto.parseFromString = function (s: string, type: string) {
    const src = /^\s*<(!doctype|html)/i.test(s) ? s : `<!doctype html><html><head></head><body>${s}</body></html>`;
    return orig.call(this, src, type);
  };
  Object.defineProperty(w.document, "implementation", {
    configurable: true,
    value: {
      createHTMLDocument: () =>
        new w.DOMParser().parseFromString("<!doctype html><html><head></head><body></body></html>", "text/html"),
    },
  });
}

beforeAll(() => {
  setSanitizerWindow(win);
});

function toDom(html: string): Element {
  const el = doc.createElement("div");
  el.innerHTML = html;
  return el;
}

function roundtrip(md: string): string {
  return editorHtmlToMarkdown(toDom(markdownToEditorHtml(md)));
}

/** md → rich → md is a fixed point after one normalization pass. */
function expectFixedPoint(md: string, expected?: string): string {
  const once = roundtrip(md);
  const twice = roundtrip(once);
  expect(twice).toBe(once);
  if (expected !== undefined) expect(once).toBe(expected);
  return once;
}

/** Exact round trip (already-normalized input). */
function expectExact(md: string) {
  expectFixedPoint(md, md.endsWith("\n") ? md : md + "\n");
}

describe("doc-editor round-trip: individual constructs", () => {
  it("headings (ATX)", () => expectExact("# One\n\n## Two\n\n### Three\n"));
  it("setext headings normalize to ATX", () => expectFixedPoint("Title\n=====\n\nSub\n---\n", "# Title\n\n## Sub\n"));
  it("paragraphs + soft breaks reflow", () => expectFixedPoint("one\ntwo\n\nthree\n", "one two\n\nthree\n"));
  it("hard break", () => expectExact("line one\\\nline two\n"));
  it("bold / italic / strike / code", () => expectExact("**b** *i* ~~s~~ `c` and ***bi***\n"));
  it("nested marks", () => expectExact("**bold *and italic* inside**\n"));
  it("underline + highlight", () => expectExact("<u>under</u> and ==highlight== and ==**bold mark**==\n"));
  it("links with titles", () => expectExact('[label](https://example.com/a?b=1) and [t](https://x.io "Title")\n'));
  it("autolinks", () => expectFixedPoint("see https://example.com/path and <mailto:a@b.co>\n"));
  it("wiki links", () => expectExact("See [[Project Plan]] and [[Roadmap 2026|the roadmap]].\n"));
  it("doc links", () => expectExact("Open [the spec](doc:abc123-def) now.\n"));
  it("bullet list, `*` normalizes to `-`", () => expectFixedPoint("* a\n* b\n", "- a\n- b\n"));
  it("numbered list renumbers", () => expectFixedPoint("1. a\n1. b\n1. c\n", "1. a\n2. b\n3. c\n"));
  it("nested lists 3 levels", () =>
    expectExact("- one\n  - two\n    - three\n    - three b\n  - two b\n- one b\n"));
  it("ordered list with nested bullets", () => expectExact("1. first\n   - sub a\n   - sub b\n2. second\n"));
  it("checklist", () => expectExact("- [ ] todo\n- [x] done\n  - [ ] nested todo\n"));
  it("quote", () => expectExact("> quoted text\n>\n> second para\n"));
  it("callout with multiple paragraphs", () =>
    expectExact("> [!WARNING]\n> First paragraph with **bold**.\n>\n> Second paragraph.\n>\n> - a list\n> - inside\n"));
  it("callout kinds + emoji lead", () => {
    for (const k of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) {
      expectExact(`> [!${k}]\n> 💡 body for ${k.toLowerCase()}\n`);
    }
  });
  it("toggle with list + code inside", () =>
    expectExact(
      "<details><summary>Click **me**</summary>\n\n- item one\n- item two\n\n```ts\nconst x: number = 1;\n```\n\n</details>\n",
    ));
  it("nested toggle", () =>
    expectExact("<details><summary>Outer</summary>\n\n<details><summary>Inner</summary>\n\nDeep.\n\n</details>\n\n</details>\n"));
  it("code block with language + blank lines", () =>
    expectExact("```python\ndef f(x):\n\n    return x * 2  # double\n```\n"));
  it("code block containing backtick fences", () => expectExact("````md\n```js\nx\n```\n````\n"));
  it("table with pipes and inline code", () =>
    expectExact("| Name | Value |\n| --- | :---: |\n| a \\| b | `x \\| y` |\n| [[Doc\\|label]] | **bold** |\n".replace(/\| --- \| :---: \|/, "| --- | :---: |")));
  it("divider", () => expectExact("above\n\n---\n\nbelow\n"));
  it("image", () => expectExact('![alt text](/api/documents/assets/abc.png) ![b](https://x.io/i.png "cap")\n'));
  it("embed iframe", () => expectExact('<iframe src="https://www.youtube.com/embed/xyz"></iframe>\n'));
  it("video + audio", () =>
    expectExact('<video src="/api/documents/assets/v.mp4" controls></video>\n\n<audio src="https://x.io/a.mp3" controls></audio>\n'));
  it("file attachment", () => expectExact("[📎 report.pdf](/api/documents/assets/9f.pdf)\n"));
  it("math inline + block", () =>
    expectExact("Euler: $e^{i\\pi} + 1 = 0$ inline.\n\n$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$\n"));
  it("dollar signs that are not math", () => expectFixedPoint("It costs $5 and $10.\n"));
  it("frontmatter preserved verbatim", () =>
    expectExact("---\ntitle: Hello\ntags: [a, b]\nnested:\n  key: v\n---\n\n# Body\n"));
  it("escapes special characters", () => {
    const md = expectFixedPoint("a \\*not bold\\* \\# and 1\\. x \\[x\\] \\<u> 5 \\= 5\n");
    expect(md).toContain("\\*not bold\\*");
  });
  it("tricky plain text survives rich → md → rich unchanged", () => {
    const samples = [
      "snake_case_name and _leading", "a*b*c", "C:\\Users\\me\\file", "2 * 3 = 6", "x == y", "~tilde~",
      "price: $5", "$5 and $10", "<div> literal", "&amp; literal", "[[not a link]]", "back`tick`",
      "# hash", "- dash", "1. one", "> gt", "+ plus", "---", "===", "| pipe |", "![not](img)",
      "emoji 🚀 ok", "trailing backslash \\", "==not mark==", "**stars**", "<u>tag</u>",
    ];
    for (const text of samples) {
      const p = doc.createElement("p");
      p.textContent = text;
      const root = doc.createElement("div");
      root.appendChild(p);
      const md = editorHtmlToMarkdown(root);
      const back = toDom(markdownToEditorHtml(md));
      expect(back.textContent, `sample ${JSON.stringify(text)} → ${JSON.stringify(md)}`).toBe(text);
      expect(roundtrip(md)).toBe(md);
    }
  });
  it("line-start markdown lookalikes stay text", () => {
    const html = "<p># not heading</p><p>- not list</p><p>1. not numbered</p><p>&gt; not quote</p>";
    const md = editorHtmlToMarkdown(toDom(html));
    expect(markdownToEditorHtml(md)).toBe(
      "<p># not heading</p><p>- not list</p><p>1. not numbered</p><p>&gt; not quote</p>",
    );
  });
});

const BIG = `---
title: Launch plan
owner: ceo
---

# Launch plan

Intro with **bold**, *italic*, ~~strike~~, \`code\`, <u>under</u>, ==mark== and $x^2$ math.
Links: [site](https://infinibot.ai), [[Roadmap]], [[Pricing Page|pricing]], [spec](doc:doc_42).

## Checklist

- [x] Write copy
- [ ] Record video
  - [ ] Script
  - [x] Storyboard

## Steps

1. Plan
2. Build
   1. Backend
   2. UI
3. Ship

> A plain quote.

> [!TIP]
> 💡 Ship small, ship often.
>
> Second paragraph of the tip.

> [!CAUTION]
> Do not deploy on Fridays.

<details><summary>Implementation notes</summary>

- uses \`marked\`
- round-trips

\`\`\`ts
export function hello(name: string): string {
  return \`hi \${name}\`; // greet
}
\`\`\`

</details>

| Feature | Status | Notes |
| :--- | :---: | ---: |
| Editor | done | \`a \\| b\` |
| Import | wip | [[Notion import]] |

---

![diagram](/api/documents/assets/1a2b.png)

<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>

<video src="/api/documents/assets/demo.mp4" controls></video>

[📎 deck.pdf](/api/documents/assets/deck.pdf)

$$
E = mc^2
$$

Final paragraph.
`;

describe("doc-editor round-trip: combined fixture", () => {
  it("big document is a fixed point", () => {
    const once = expectFixedPoint(BIG);
    // Only normalization differences are allowed: soft break reflow.
    expect(once).toBe(BIG.replace("math.\nLinks:", "math. Links:"));
  });
});

describe("sanitizer", () => {
  it("strips script tags and javascript: links", () => {
    const html = markdownToEditorHtml(
      '[x](javascript:alert(1)) <script>alert(1)</script> <img src=x onerror="alert(1)">\n\n<div onclick="evil()">hi</div>',
    );
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onerror|onclick/i);
  });
  it("only https iframes are framed, always sandboxed", () => {
    const ok = markdownToEditorHtml('<iframe src="https://example.com/e"></iframe>');
    expect(ok).toMatch(/<iframe[^>]+sandbox="allow-scripts allow-same-origin allow-popups"/);
    const bad = markdownToEditorHtml('<iframe src="javascript:alert(1)"></iframe>');
    expect(bad).not.toMatch(/javascript:/i);
    const raw = sanitizeEditorHtml('<iframe src="http://insecure.test/x"></iframe>');
    expect(raw).not.toMatch(/src=/);
  });
  it("keeps doc: links and data attributes", () => {
    const html = markdownToEditorHtml("[a](doc:123) [[W]]");
    expect(html).toContain('href="doc:123"');
    expect(html).toContain('data-wiki="W"');
  });
});

describe("highlightCode", () => {
  it("wraps tokens without changing text", () => {
    const code = 'const s = "hi"; // note\nlet n = 42;';
    const html = highlightCode(code, "ts");
    expect(html).toContain('<span class="tok-kw">const</span>');
    expect(html).toContain('<span class="tok-str">&quot;hi&quot;</span>');
    expect(html).toContain('<span class="tok-com">// note</span>');
    expect(html).toContain('<span class="tok-num">42</span>');
    expect(toDom(html).textContent).toBe(code);
  });
  it("covers the supported languages", () => {
    const samples: Record<string, string> = {
      py: "def f():\n    return 'x'  # c",
      json: '{"a": 1, "b": true}',
      bash: 'echo "$HOME" # c',
      css: ".a { color: #fff; margin: 4px; }",
      html: '<div class="x">hi</div><!-- c -->',
      sql: "SELECT * FROM t WHERE id = 1 -- c",
      go: 'func main() { fmt.Println("x") }',
      rust: 'fn main() { println!("x"); }',
      zig: "const x = 1; // generic",
    };
    for (const [lang, code] of Object.entries(samples)) {
      const html = highlightCode(code, lang);
      expect(html).toContain("tok-");
      expect(toDom(html).textContent).toBe(code);
    }
  });
});

describe("contenteditable + paste HTML → markdown", () => {
  it("stray divs and brs from contenteditable", () => {
    const md = editorHtmlToMarkdown(toDom("first line<div>second <b>bold</b></div><div><br></div><div>third<br></div>"));
    expect(md).toBe("first line\n\nsecond **bold**\n\nthird\n");
  });
  it("Google Docs clipboard HTML", () => {
    const gdocs =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-abc">' +
      '<h1 dir="ltr"><span style="font-size:20pt;font-weight:400">Meeting notes</span></h1>' +
      '<p dir="ltr"><span style="font-weight:400">Plain then </span><span style="font-weight:700">bold</span>' +
      '<span style="font-weight:400"> and </span><span style="font-style:italic">italic</span>' +
      '<span style="text-decoration:underline">under</span><span style="text-decoration:line-through"> gone</span></p>' +
      '<ul><li dir="ltr"><p dir="ltr"><span>Item one</span></p></li><li><p><span>Item two</span></p></li>' +
      '<ul><li><p><span>Nested</span></p></li></ul></ul>' +
      '<p><a href="https://example.com"><span style="color:#1155cc">a link</span></a></p>' +
      '<p><span style="background-color:#ffff00">yellow</span> <span style="font-family:\'Courier New\'">mono()</span></p>' +
      "</b><br>";
    const md = htmlStringToMarkdown(sanitizeEditorHtml(gdocs, { allowStyle: true }), doc as unknown as Document);
    expect(md).toBe(
      "# Meeting notes\n\nPlain then **bold** and *italic*<u>under</u> ~~gone~~\n\n- Item one\n- Item two\n  - Nested\n\n[a link](https://example.com)\n\n==yellow== `mono()`\n",
    );
    expect(roundtrip(md)).toBe(md);
  });
  it("Word / Notion style HTML", () => {
    const html =
      '<p class="MsoNormal"><b>Bold</b> <i>it</i><o:p></o:p></p>' +
      '<ul><li><input type="checkbox" checked> done thing</li><li><input type="checkbox"> open thing</li></ul>' +
      '<pre><code class="language-js">let a = 1;\n</code></pre>' +
      "<table><tr><td>h1</td><td>h2</td></tr><tr><td>a|b</td><td><p>x</p><p>y</p></td></tr></table>" +
      "<blockquote><p>q</p></blockquote>";
    const md = htmlStringToMarkdown(html, doc as unknown as Document);
    expect(md).toBe(
      "**Bold** *it*\n\n- [x] done thing\n- [ ] open thing\n\n```js\nlet a = 1;\n```\n\n| h1 | h2 |\n| --- | --- |\n| a\\|b | x<br>y |\n\n> q\n",
    );
    expect(roundtrip(md)).toBe(md);
  });
  it("merges adjacent identical marks", () => {
    expect(editorHtmlToMarkdown(toDom("<p><b>a</b><strong>b</strong> <i>c</i><em>d</em></p>"))).toBe("**ab** *cd*\n");
  });
  it("moves edge whitespace outside delimiters", () => {
    expect(editorHtmlToMarkdown(toDom("<p>x<b> bold </b>y</p>"))).toBe("x **bold** y\n");
  });
  it("ignores editor chrome (data-ui)", () => {
    const html = markdownToEditorHtml("> [!NOTE]\n> body\n");
    expect(html).toContain("callout-label");
    expect(editorHtmlToMarkdown(toDom(html))).toBe("> [!NOTE]\n> body\n");
  });
});

// ── Hosted cloud: stored asset images shown via ticketed URLs ─────────────
describe("document asset resolver (cloud)", () => {
  it("displays stored assets through the resolver but saves the stored path", async () => {
    const { setDocAssetResolver } = await import("./md-to-html.js");
    setDocAssetResolver((p) => `https://ib-gw-abc.fly.dev${p}?t=TICKET`);
    try {
      const md = "![chart](/api/documents/assets/0a1b2c.png)";
      const shown = markdownToEditorHtml(md);
      expect(shown).toContain('src="https://ib-gw-abc.fly.dev/api/documents/assets/0a1b2c.png?t=TICKET"');
      expect(shown).toContain('data-asset-src="/api/documents/assets/0a1b2c.png"');
      const saved = editorHtmlToMarkdown(toDom(shown));
      expect(saved.trim()).toBe(md);
      expect(saved).not.toContain("TICKET");
      expect(saved).not.toContain("fly.dev");
    } finally {
      setDocAssetResolver(null);
    }
  });

  it("leaves external images and same-origin installs untouched", () => {
    const ext = markdownToEditorHtml("![x](https://example.com/a.png)");
    expect(ext).toContain('src="https://example.com/a.png"');
    expect(ext).not.toContain("data-asset-src");
    const local = markdownToEditorHtml("![x](/api/documents/assets/f.png)");
    expect(local).toContain('src="/api/documents/assets/f.png"');
  });
});
