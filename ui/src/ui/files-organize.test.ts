import { describe, expect, it } from "vitest";
import {
  type BrowserItem,
  DEFAULT_PREFS,
  dateBucket,
  displayName,
  enrichmentFromSidecar,
  filterBrowserItems,
  groupBrowserItems,
  kindOfName,
  loadOrganizePrefs,
  parseEntityGroups,
  parseFileAnalysis,
  projectIdFromPath,
  saveOrganizePrefs,
  sortBrowserItems,
} from "./files-organize";

const NOW = new Date(2026, 9, 15, 15, 0, 0).getTime(); // Thu 15 Oct 2026

function item(p: Partial<BrowserItem> & { name: string }): BrowserItem {
  return {
    key: p.path ?? p.name,
    path: p.name,
    isDirectory: false,
    size: 1,
    modified: NOW,
    kind: kindOfName(p.name, p.isDirectory),
    ext: "",
    status: "none",
    folder: "",
    secure: false,
    ...p,
  };
}

describe("classification", () => {
  it("maps names to kinds", () => {
    expect(kindOfName("a.PNG")).toBe("image");
    expect(kindOfName("clip.mov")).toBe("video");
    expect(kindOfName("report.pdf")).toBe("document");
    expect(kindOfName("x.bin")).toBe("other");
    expect(kindOfName("dir", true)).toBe("folder");
  });
  it("finds project ids in paths and shortens hash names", () => {
    expect(projectIdFromPath("projects/226f-abc/x.png")).toBe("226f-abc");
    expect(projectIdFromPath("covers/project/p1/x.png")).toBe("p1");
    expect(projectIdFromPath("issues/x/y.png")).toBeUndefined();
    expect(displayName(`${"a".repeat(64)}.PNG`)).toBe("aaaaaaaa….png");
    expect(displayName("notes.md")).toBe("notes.md");
  });
});

describe("grouping", () => {
  const items = [
    item({ name: "a.png", modified: NOW - 1000, status: "done" }),
    item({ name: "b.mp4", modified: NOW - 3 * 86_400_000, status: "pending" }),
    item({ name: "c.pdf", modified: new Date(2026, 9, 2).getTime(), status: "failed", projectId: "p1" }),
    item({ name: "d.bin", modified: new Date(2025, 1, 1).getTime(), projectId: "p1" }),
    item({ name: "dir", isDirectory: true, kind: "folder" }),
  ];

  it("groups by type in a fixed order", () => {
    const g = groupBrowserItems(items, "type");
    expect(g.map((x) => x.label)).toEqual(["Folders", "Images", "Videos", "Documents", "Other"]);
  });

  it("groups by date buckets", () => {
    expect(dateBucket(NOW - 1000, NOW).label).toBe("Today");
    expect(dateBucket(NOW - 3 * 86_400_000, NOW).label).toBe("This week");
    expect(dateBucket(new Date(2026, 9, 2).getTime(), NOW).label).toBe("This month");
    expect(dateBucket(new Date(2025, 1, 1).getTime(), NOW).label).toBe("Older");
    const g = groupBrowserItems(items, "date", { now: NOW });
    expect(g.map((x) => [x.label, x.items.length])).toEqual([
      ["Today", 2],
      ["This week", 1],
      ["This month", 1],
      ["Older", 1],
    ]);
  });

  it("groups by status, project and tag", () => {
    expect(groupBrowserItems(items, "status").map((x) => x.label)).toEqual(["Folders", "Analysed", "In progress", "Failed", "Not analysed"]);
    const proj = groupBrowserItems(items, "project", { projectNames: new Map([["p1", "Launch"]]) });
    expect(proj[0]).toMatchObject({ label: "Launch" });
    expect(proj[0].items).toHaveLength(2);
    expect(proj.at(-1)?.label).toBe("No project");
    const enrich = new Map([
      ["a.png", { entities: ["Acme", "Ada"], findings: 0 }],
      ["c.pdf", { entities: ["Acme"], findings: 2 }],
    ]);
    const tags = groupBrowserItems(items, "tag", { enrich });
    expect(tags.map((t) => t.label)).toEqual(["Folders", "Acme", "Ada", "Untagged"]);
    expect(tags[1].items.map((i) => i.name)).toEqual(["a.png", "c.pdf"]);
    expect(tags.find((t) => t.label === "Untagged")?.items).toHaveLength(2);
  });

  it("filters by type, status and has-findings; sorts folders first", () => {
    expect(filterBrowserItems(items, { types: ["image", "video"], statuses: [], hasFindings: false }).map((i) => i.name)).toEqual(["a.png", "b.mp4"]);
    expect(filterBrowserItems(items, { types: [], statuses: ["failed"], hasFindings: false }).map((i) => i.name)).toEqual(["c.pdf"]);
    const enrich = new Map([["c.pdf", { entities: [], findings: 2 }]]);
    expect(filterBrowserItems(items, { types: [], statuses: [], hasFindings: true }, enrich).map((i) => i.name)).toEqual(["c.pdf"]);
    expect(sortBrowserItems(items, "size", false)[0].name).toBe("dir");
    expect(sortBrowserItems(items, "modified", false)[1].name).toBe("a.png");
  });
});

describe("prefs", () => {
  it("round-trips and sanitises per lane", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(loadOrganizePrefs("normal", store)).toEqual(DEFAULT_PREFS);
    saveOrganizePrefs("normal", { ...DEFAULT_PREFS, groupBy: "date", view: "gallery" }, store);
    expect(loadOrganizePrefs("normal", store)).toMatchObject({ groupBy: "date", view: "gallery" });
    expect(loadOrganizePrefs("secure", store).scope).toBe("all");
    mem.set("ib.files.organize.v1:normal", JSON.stringify({ groupBy: "bogus", view: "list" }));
    expect(loadOrganizePrefs("normal", store)).toMatchObject({ groupBy: "none", view: "list" });
  });
});

describe("analysis parsing", () => {
  const description = [
    "## Summary",
    'This image is an infographic titled "10 CORE BUSINESS OBJECTS". It lists ten components. Each has a purpose. It is styled in navy.',
    "## Text",
    "# 10 CORE BUSINESS OBJECTS",
    "| # | OBJECT |",
    "| :--- | :--- |",
    "| 1 | CLIENTS |",
    "Visit https://example.com or mail ops@example.com — total $1,200.00",
    "## Key entities",
    "- **Roles:** CEO, Founder",
  ].join("\n");

  it("builds a styled model from a sidecar description", () => {
    const p = parseFileAnalysis({
      name: `${"b".repeat(64)}.png`,
      description,
      markdown: "",
      entities: ["**Roles:** CEO, Founder, Operations.", "**Business Objects:** Clients / Companies, Risks", "Jennifer Aston"],
      confidence: 0.978,
    });
    expect(p.title).toBe("10 CORE BUSINESS OBJECTS");
    expect(p.summary).toBe('This image is an infographic titled "10 CORE BUSINESS OBJECTS". It lists ten components.');
    expect(p.entityGroups.map((g) => [g.label, g.icon, g.items.length])).toEqual([
      ["Roles", "person", 3],
      ["Business Objects", "briefcase", 2],
      ["Mentions", "tag", 1],
    ]);
    const texts = p.findings.map((f) => f.text);
    expect(texts).toContain("Each has a purpose.");
    expect(texts).toContain("Contains a table");
    expect(texts).toContain("Links to https://example.com");
    expect(texts).toContain("Email ops@example.com");
    expect(texts).toContain("Amount $1,200.00");
    expect(p.meters).toEqual([{ label: "Text recognition", value: 0.978 }]);
    expect(p.text).toContain("CLIENTS");
    expect(p.tags).toContain("Table");
  });

  it("degrades for plain text and uses analyzer findings + confidence", () => {
    const p = parseFileAnalysis({
      name: "site-walk.mp4",
      description: "A short walk through a dig site. Tools are visible.",
      analyses: [
        {
          id: "a1",
          analyzer: "video-analyst",
          agentId: "archaeologist",
          summary: "Stratigraphy visible",
          findings: [{ title: "Pottery shard at 00:12", severity: "high", at: 12 }],
          data: { agentName: "Archaeologist", confidence: 0.82 },
        },
      ],
    });
    expect(p.title).toBe("site walk");
    expect(p.summary).toBe("A short walk through a dig site. Tools are visible.");
    expect(p.findings[0]).toMatchObject({ icon: "alert", text: "Pottery shard at 00:12", at: 12 });
    expect(p.meters).toEqual([{ label: "Archaeologist", value: 0.82 }]);
  });

  it("keeps amounts intact when picking summary sentences", () => {
    const p = parseFileAnalysis({
      name: "inv.png",
      description: "## Summary\nAn invoice from Acme Ltd. It totals $1,240.00 and is due Nov 1. Paid by card.",
      markdown: "Total $1,240.00 and again $1,240.00",
    });
    expect(p.summary).toBe("An invoice from Acme Ltd. It totals $1,240.00 and is due Nov 1.");
    expect(p.findings.map((f) => f.text)).toContain("Paid by card.");
    expect(p.findings.map((f) => f.text)).toContain("Amount $1,240.00");
  });

  it("synthesises a clean summary for text-only PDFs instead of dumping OCR", () => {
    const p = parseFileAnalysis({
      name: "invite.pdf",
      pageCount: 12,
      summary: "C 米8 FREEDOMAIN'TFREE ## Page 2 in association w",
      markdown: "## Page 1\nC 米8 FREEDOMAIN'TFREE CULTURE 班.相\nYou are warmly invited to the annual Freedom Culture gala in association with our partners. Doors open at seven.",
    });
    expect(p.summary).toBe("A 12-page PDF with 26 words of readable text. Includes: “You are warmly invited to the annual Freedom Culture gala in association with our partners.”");
  });

  it("titles hash-named documents from their first heading line", () => {
    const p = parseFileAnalysis({ name: `${"c".repeat(64)}.pdf`, markdown: "## Page 1\nINVOICE\nBill to: Acme Ltd" });
    expect(p.title).toBe("INVOICE");
    expect(parseFileAnalysis({ name: "report.pdf", markdown: "INVOICE" }).title).toBe("report");
  });

  it("parses entity lines and enrichment", () => {
    expect(parseEntityGroups(["https://x.com/a", "$40 fee", "**Dates**: 12 May 2026; 2027"])).toEqual([
      { label: "Links & contacts", icon: "link", items: ["https://x.com/a"] },
      { label: "Amounts", icon: "dollarSign", items: ["$40 fee"] },
      { label: "Dates", icon: "calendar", items: ["12 May 2026", "2027"] },
    ]);
    expect(enrichmentFromSidecar({ entities: ["**People:** Ada, Bob"], analyses: [{ id: "x", analyzer: "v", summary: "", data: { moments: [1, 2] } }] })).toEqual({
      entities: ["Ada", "Bob"],
      findings: 2,
    });
  });
});
