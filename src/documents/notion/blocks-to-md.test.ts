import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectBlockAssets,
  notionBlocksToMarkdown,
  richTextToMarkdown,
  type BlocksToMdContext,
  type NotionBlock,
  type NotionRichText,
} from "./blocks-to-md.js";

const FIXTURES = path.join(import.meta.dirname, "__fixtures__");
const KNOWN = "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa";

const ctx: BlocksToMdContext = {
  resolveAsset: (u) =>
    u.startsWith("https://s3.example/")
      ? `/api/documents/assets/${u.split("/").pop()!.split("?")[0]}`
      : u,
  resolvePage: (id) => (id.replace(/-/g, "") === KNOWN ? "known-doc" : null),
  titleOf: (id) => (id.replace(/-/g, "") === KNOWN ? "Known" : undefined),
};

const t = (
  content: string,
  ann: NotionRichText["annotations"] = {},
  link?: string,
): NotionRichText => ({
  type: "text",
  text: { content, link: link ? { url: link } : null },
  annotations: ann,
  plain_text: content,
  href: link ?? null,
});

const EXPECTED_ALL = `# Title

## Section

<details><summary>### Folded</summary>

Hidden text

</details>

plain **bold** *ital* ~~gone~~ \`code\` <u>under</u> ==hot== [link](https://example.com) $E=mc^2$ 2026-09-01 → 2026-09-03 @Ada [Known](doc:known-doc) costs \\$5 \\* 2

- one
  - one.a
- two

1. first
2. second
  1. nested

- [x] done
- [ ] todo

<details><summary>More</summary>

Inside toggle

</details>

> Quoted

> [!CAUTION]
> ⚠️ Careful

> [!NOTE]
> 💡 FYI

\`\`\`javascript
const a = 1;

console.log(a);
\`\`\`

*example*

---

![Chart](/api/documents/assets/chart.png)

<iframe src="https://www.youtube.com/embed/abc123"></iframe>

<audio src="/api/documents/assets/talk.mp3" controls></audio>

[📎 report.docx](/api/documents/assets/report.docx)

[📎 spec.pdf](https://example.com/spec.pdf)

[A post](https://example.com/post)

[https://github.com/x/y](https://github.com/x/y)

<iframe src="https://www.figma.com/file/abc"></iframe>

$$
\\int_0^1 x\\,dx
$$

| Key | Value |
| --- | --- |
| a\\|b | 1 |

|   |   |
| --- | --- |
| x | y |

Left

Right

Synced

[Known](doc:known-doc)

**Unknown DB**

[Known](doc:known-doc)
`;

describe("notionBlocksToMarkdown", () => {
  it("converts every supported block type (recorded fixture)", () => {
    const blocks = JSON.parse(
      fs.readFileSync(path.join(FIXTURES, "blocks-all.json"), "utf-8"),
    ) as NotionBlock[];
    expect(notionBlocksToMarkdown(blocks, ctx)).toBe(EXPECTED_ALL);
  });

  it("returns empty string for no content and omits toc/breadcrumb/unsupported", () => {
    const blocks: NotionBlock[] = [
      { id: "1", type: "table_of_contents", table_of_contents: {} },
      { id: "2", type: "breadcrumb", breadcrumb: {} },
      { id: "3", type: "unsupported", unsupported: {} },
    ];
    expect(notionBlocksToMarkdown(blocks, ctx)).toBe("");
  });

  it("escapes paragraph text that would parse as another block", () => {
    const blocks: NotionBlock[] = [
      { id: "1", type: "paragraph", paragraph: { rich_text: [t("# not a heading")] } },
      { id: "2", type: "paragraph", paragraph: { rich_text: [t("- not a list")] } },
      { id: "3", type: "paragraph", paragraph: { rich_text: [t("1. not numbered")] } },
    ];
    expect(notionBlocksToMarkdown(blocks, ctx)).toBe(
      "\\# not a heading\n\n\\- not a list\n\n1\\. not numbered\n",
    );
  });

  it("indents children of bullets and checklists by two spaces", () => {
    const blocks: NotionBlock[] = [
      {
        id: "1",
        type: "to_do",
        to_do: { rich_text: [t("parent")], checked: false },
        has_children: true,
        children: [
          { id: "2", type: "to_do", to_do: { rich_text: [t("child")], checked: true } },
          {
            id: "3",
            type: "bulleted_list_item",
            bulleted_list_item: { rich_text: [t("bullet")] },
            has_children: true,
            children: [
              {
                id: "4",
                type: "bulleted_list_item",
                bulleted_list_item: { rich_text: [t("deep")] },
              },
            ],
          },
        ],
      },
    ];
    expect(notionBlocksToMarkdown(blocks, ctx)).toBe(
      "- [ ] parent\n  - [x] child\n  - bullet\n    - deep\n",
    );
  });

  it("maps callout colors to callout kinds and nests children in the quote", () => {
    const callout = (color: string): NotionBlock => ({
      id: color,
      type: "callout",
      callout: { rich_text: [t("x")], color, icon: null },
    });
    const md = notionBlocksToMarkdown(
      [callout("green_background"), callout("yellow"), callout("purple_background")],
      ctx,
    );
    expect(md).toContain("> [!TIP]\n> x");
    expect(md).toContain("> [!WARNING]\n> x");
    expect(md).toContain("> [!IMPORTANT]\n> x");
    const nested = notionBlocksToMarkdown(
      [
        {
          id: "c",
          type: "callout",
          callout: {
            rich_text: [t("Head")],
            color: "blue_background",
            icon: { type: "emoji", emoji: "📌" },
          },
          has_children: true,
          children: [{ id: "p", type: "paragraph", paragraph: { rich_text: [t("Body")] } }],
        },
      ],
      ctx,
    );
    expect(nested).toBe("> [!NOTE]\n> 📌 Head\n>\n> Body\n");
  });

  it("uses a longer fence when code contains backticks and maps languages", () => {
    const md = notionBlocksToMarkdown(
      [
        {
          id: "1",
          type: "code",
          code: { rich_text: [t("```\ninner\n```")], language: "plain text" },
        },
      ],
      ctx,
    );
    expect(md).toBe("````\n```\ninner\n```\n````\n");
  });

  it("keeps bold-only table header row off when has_column_header is false", () => {
    const md = notionBlocksToMarkdown(
      [
        {
          id: "t",
          type: "table",
          table: { table_width: 1, has_column_header: false },
          children: [{ id: "r", type: "table_row", table_row: { cells: [[t("line1\nline2")]] } }],
        },
      ],
      ctx,
    );
    expect(md).toBe("|   |\n| --- |\n| line1<br>line2 |\n");
  });
});

describe("richTextToMarkdown", () => {
  it("merges adjacent runs with the same style and keeps spaces outside markers", () => {
    expect(
      richTextToMarkdown([t("bold ", { bold: true }), t("run", { bold: true }), t("!")], ctx),
    ).toBe("**bold run**!");
    expect(richTextToMarkdown([t("a "), t(" spaced ", { italic: true }), t("b")], ctx)).toBe(
      "a  *spaced* b",
    );
  });

  it("combines annotations and wraps the link outermost", () => {
    expect(
      richTextToMarkdown(
        [t("x", { bold: true, italic: true, color: "red_background" }, "https://e.com")],
        ctx,
      ),
    ).toBe("[==***x***==](https://e.com)");
  });

  it("resolves Notion-internal links to doc links, else to notion.so", () => {
    expect(richTextToMarkdown([t("known", {}, `/${KNOWN}`)], ctx)).toBe("[known](doc:known-doc)");
    expect(richTextToMarkdown([t("other", {}, "/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")], ctx)).toBe(
      "[other](https://www.notion.so/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)",
    );
  });

  it("wraps inline code containing backticks with a longer fence", () => {
    expect(richTextToMarkdown([t("a`b", { code: true })], ctx)).toBe("`` a`b ``");
  });

  it("escapes markup but leaves snake_case words alone", () => {
    expect(richTextToMarkdown([t("snake_case *star* [x] ~ _edge_ a==b")], ctx)).toBe(
      "snake_case \\*star\\* \\[x\\] \\~ \\_edge\\_ a\\=\\=b",
    );
  });
});

describe("collectBlockAssets", () => {
  it("finds hosted and external media in nested blocks", () => {
    const blocks = JSON.parse(
      fs.readFileSync(path.join(FIXTURES, "blocks-all.json"), "utf-8"),
    ) as NotionBlock[];
    const assets = collectBlockAssets(blocks);
    expect(assets.filter((a) => a.hosted).map((a) => a.name)).toEqual([
      "chart.png",
      "talk.mp3",
      "report.docx",
    ]);
    expect(assets.filter((a) => !a.hosted).map((a) => a.url)).toEqual([
      "https://www.youtube.com/watch?v=abc123",
      "https://example.com/spec.pdf",
    ]);
  });
});
