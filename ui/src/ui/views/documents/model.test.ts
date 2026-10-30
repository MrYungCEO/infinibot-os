import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  buildTreeIndex,
  formatProp,
  isInside,
  previewKind,
  sortRows,
  tableColumns,
  type DocSummary,
} from "./model";

const n = (id: string, kind: DocSummary["kind"], parentId: string | null, extra: Partial<DocSummary> = {}): DocSummary => ({
  id,
  kind,
  title: extra.title ?? id,
  parentId,
  updatedAt: extra.updatedAt ?? "2026-01-01T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z",
  ...extra,
});

describe("documents tree model", () => {
  const nodes = [
    n("b-doc", "doc", null, { sortOrder: 2 }),
    n("a-folder", "folder", null, { sortOrder: 3 }),
    n("child", "doc", "a-folder", { sortOrder: 1 }),
    n("sub", "folder", "a-folder", { sortOrder: 2 }),
    n("deep", "doc", "sub"),
    n("orphan", "doc", "missing-parent"),
  ];

  it("puts folders first and surfaces orphans at the root", () => {
    const idx = buildTreeIndex(nodes);
    expect(idx.children.get(null)!.map((x) => x.id)).toEqual(["a-folder", "b-doc", "orphan"]);
    expect(idx.children.get("a-folder")!.map((x) => x.id)).toEqual(["sub", "child"]);
  });

  it("computes ancestors and containment for drag-drop guards", () => {
    const idx = buildTreeIndex(nodes);
    expect(ancestorsOf(idx, "deep")).toEqual(["a-folder", "sub"]);
    expect(isInside(idx, "a-folder", "sub")).toBe(true);
    expect(isInside(idx, "sub", "a-folder")).toBe(false);
    expect(isInside(idx, "a-folder", null)).toBe(false);
  });

  it("sorts by name and updated", () => {
    const rows = [n("x", "doc", null, { title: "Item 10" }), n("y", "doc", null, { title: "Item 9", updatedAt: "2026-05-01T00:00:00Z" })];
    expect(buildTreeIndex(rows, "name").children.get(null)!.map((r) => r.title)).toEqual(["Item 9", "Item 10"]);
    expect(buildTreeIndex(rows, "updated").children.get(null)![0]!.id).toBe("y");
  });
});

describe("database folder table", () => {
  it("uses the folder schema (minus title) or the union of row property keys", () => {
    const folder = n("db", "folder", null, {
      schema: [
        { key: "Name", name: "Name", type: "title" },
        { key: "Status", name: "Status", type: "status" },
      ],
    });
    expect(tableColumns(folder, []).map((c) => c.key)).toEqual(["Status"]);
    const rows = [n("r1", "doc", "f", { properties: { A: 1 } }), n("r2", "doc", "f", { properties: { B: "x" } })];
    expect(tableColumns(undefined, rows).map((c) => c.key)).toEqual(["A", "B"]);
  });

  it("formats values and sorts rows by a property", () => {
    expect(formatProp(["a", "b"])).toBe("a, b");
    expect(formatProp(true)).toBe("✓");
    expect(formatProp(null)).toBe("");
    const rows = [n("1", "doc", null, { properties: { P: 10 } }), n("2", "doc", null, { properties: { P: 9 } })];
    expect(sortRows(rows, "P", "asc").map((r) => r.id)).toEqual(["2", "1"]);
    expect(sortRows(rows, "P", "desc").map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("picks preview kinds from mime", () => {
    const f = (mime: string, extractStatus: "ok" | "none" = "none") => ({ name: "f", mime, size: 1, ext: ".x", extractStatus });
    expect(previewKind(f("application/pdf"))).toBe("pdf");
    expect(previewKind(f("image/png"))).toBe("image");
    expect(previewKind(f("video/mp4"))).toBe("video");
    expect(previewKind(f("audio/mpeg"))).toBe("audio");
    expect(previewKind(f("application/vnd.ms-excel", "ok"))).toBe("text");
    expect(previewKind(f("application/zip"))).toBe("none");
  });
});

describe("doc relation refs", () => {
  it("formats doc:<id> refs as titles and lists their ids", async () => {
    const { docRefIds, formatProp: fp } = await import("./model.js");
    const titles: Record<string, string> = { "a-1": "Alpha", "b-2": "Beta" };
    expect(fp(["doc:a-1", "doc:b-2", "plain"], (id) => titles[id])).toBe("Alpha, Beta, plain");
    expect(fp("doc:zz", (id) => titles[id])).toBe("doc:zz");
    expect(fp("doc:a-1")).toBe("doc:a-1");
    expect(docRefIds(["doc:a-1", "x", "doc:b-2"])).toEqual(["a-1", "b-2"]);
    expect(docRefIds(null)).toEqual([]);
  });
});
