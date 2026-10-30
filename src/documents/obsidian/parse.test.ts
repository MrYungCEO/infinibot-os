import { describe, expect, it } from "vitest";
import {
  dailyNoteDate,
  frontmatterAliases,
  frontmatterProperties,
  frontmatterTags,
  parseFrontmatter,
  parseInlineTags,
  parseLocalMdLinks,
  parseTasks,
  parseWikiLinks,
  stripTitleHeading,
} from "./parse.js";

describe("obsidian parse", () => {
  it("parses YAML frontmatter into data + body", () => {
    const fm = parseFrontmatter(
      "---\ntags: [a, B]\naliases: x, y\ncreated: 2026-09-01\nn: 3\n---\nBody\n",
    );
    expect(fm.body).toBe("Body\n");
    expect(frontmatterTags(fm.data)).toEqual(["a", "b"]);
    expect(frontmatterAliases(fm.data)).toEqual(["x", "y"]);
    expect(frontmatterProperties(fm.data)).toEqual({ created: "2026-09-01", n: 3 });
  });

  it("keeps the body when frontmatter is invalid or absent", () => {
    expect(parseFrontmatter("no fm").body).toBe("no fm");
    const bad = parseFrontmatter("---\n: : bad: [\n---\nBody");
    expect(bad.invalid).toBe(true);
    expect(bad.body).toBe("Body");
  });

  it("parses wikilinks, aliases, headings and embeds; ignores code", () => {
    const md =
      "See [[Folder/Note#Head|Alias]] and ![[img.png|300]] `[[code]]`\n```\n[[fenced]]\n```\n[[Plain]]";
    const links = parseWikiLinks(md);
    expect(links.map((l) => [l.target, l.fragment, l.alias, l.embed])).toEqual([
      ["Folder/Note", "Head", "Alias", false],
      ["img.png", null, "300", true],
      ["Plain", null, null, false],
    ]);
    expect(md.slice(links[0]!.start, links[0]!.end)).toBe("[[Folder/Note#Head|Alias]]");
  });

  it("finds relative markdown links only", () => {
    const links = parseLocalMdLinks(
      "[a](Note.md) [b](https://x.y) ![c](img/x.png) [d](#h) [e](doc:abc)",
    );
    expect(links.map((l) => [l.href, l.embed])).toEqual([
      ["Note.md", false],
      ["img/x.png", true],
    ]);
  });

  it("extracts inline tags but not headings, numbers, code or url fragments", () => {
    const tags = parseInlineTags(
      "# Heading\nText #Work and #nested/tag-x, #123 `#code` http://x.y/#frag",
    );
    expect(tags).toEqual(["work", "nested/tag-x"]);
  });

  it("parses tasks with state and due dates, skipping cancelled", () => {
    const tasks = parseTasks(
      "- [ ] Call bank 📅 2026-10-15 #finance\n* [x] Done thing\n- [-] cancelled\n- [ ] Ship [due:: 2026-12-01]\n```\n- [ ] in code\n```",
    );
    expect(tasks).toEqual([
      { text: "Call bank #finance", done: false, due: "2026-10-15", line: 1, tags: ["finance"] },
      { text: "Done thing", done: true, due: null, line: 2, tags: [] },
      { text: "Ship", done: false, due: "2026-12-01", line: 4, tags: [] },
    ]);
  });

  it("detects daily notes and strips a duplicate title heading", () => {
    expect(dailyNoteDate("2026-10-07")).toBe("2026-10-07");
    expect(dailyNoteDate("Meeting 2026-10-07")).toBeNull();
    expect(stripTitleHeading("# Home\n\nHi", "Home")).toBe("Hi");
    expect(stripTitleHeading("# Other\nHi", "Home")).toBe("# Other\nHi");
  });
});
