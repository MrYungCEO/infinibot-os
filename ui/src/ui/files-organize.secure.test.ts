import { describe, expect, it } from "vitest";
import {
  type BrowserItem,
  buildCollectionTree,
  cleanTag,
  collectionSubtree,
  groupBrowserItems,
  itemLabel,
  kindOfName,
  tagSuggestions,
} from "./files-organize";

function sec(p: Partial<BrowserItem> & { name: string }): BrowserItem {
  return { key: p.name, path: null, isDirectory: false, size: 1, modified: 1, kind: kindOfName(p.name), ext: "", status: "done", folder: "", secure: true, ...p };
}

describe("secure collections tree", () => {
  const cols = [
    { id: "b", name: "Bank", parentId: null, count: 2 },
    { id: "a", name: "Admin", parentId: null, count: 1 },
    { id: "a1", name: "Leases", parentId: "a", count: 3 },
    { id: "a11", name: "2025", parentId: "a1", count: 4 },
    { id: "x", name: "Orphan", parentId: "gone", count: 0 },
  ];
  it("orders depth-first by name with rolled-up totals", () => {
    const t = buildCollectionTree(cols);
    expect(t.map((n) => `${n.depth}:${n.name}`)).toEqual(["0:Admin", "1:Leases", "2:2025", "0:Bank", "0:Orphan"]);
    expect(t.find((n) => n.id === "a")).toMatchObject({ total: 8, hasChildren: true });
    expect(t.find((n) => n.id === "a11")).toMatchObject({ total: 4, hasChildren: false });
  });
  it("finds a subtree (no drop into self or a child)", () => {
    expect([...collectionSubtree(cols, "a")].sort()).toEqual(["a", "a1", "a11"]);
  });
});

describe("secure grouping", () => {
  const items = [
    sec({ name: "a.png", folder: "Legal / Contracts", tags: ["urgent", "case-42"], projectId: "p1" }),
    sec({ name: "b.pdf", folder: "", tags: ["case-42"] }),
    sec({ name: "c.pdf", folder: "Legal / Contracts", tags: [] }),
  ];
  it("groups by collection with an Unfiled bucket", () => {
    const g = groupBrowserItems(items, "folder");
    expect(g.map((x) => [x.label, x.items.length])).toEqual([["Unfiled", 1], ["Legal / Contracts", 2]]);
  });
  it("groups by the user's own tags", () => {
    const g = groupBrowserItems(items, "tag", { tagSource: "user" });
    expect(g.map((x) => [x.label, x.items.length])).toEqual([["case-42", 2], ["urgent", 1], ["Untagged", 1]]);
  });
  it("groups by project with names", () => {
    const g = groupBrowserItems(items, "project", { projectNames: new Map([["p1", "Case files"]]) });
    expect(g.map((x) => x.label)).toEqual(["Case files", "No project"]);
  });
});

describe("tags + labels", () => {
  it("suggests prefix matches first and skips tags already set", () => {
    expect(tagSuggestions(["Receipts", "tax", "Taxes 2025", "contract"], "ta", ["tax"])).toEqual(["Taxes 2025"]);
    expect(tagSuggestions(["alpha", "beta"], "et")).toEqual(["beta"]);
    expect(tagSuggestions(["a", "b"], "", ["a"])).toEqual(["b"]);
  });
  it("cleans tags like the gateway", () => {
    expect(cleanTag("  #Case   42 ")).toBe("Case 42");
  });
  it("prefers the user's display name", () => {
    expect(itemLabel({ name: "x.png", label: "Passport scan" })).toBe("Passport scan");
    expect(itemLabel({ name: "x.png", label: "  " })).toBe("x.png");
  });
});
