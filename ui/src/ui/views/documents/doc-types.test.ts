import { describe, expect, it } from "vitest";

import { icons } from "../../icons";
import {
  TYPE_ICON_CHOICES,
  assignableTypes,
  categoryRows,
  clientLibrary,
  creatableTypes,
  docTypeOf,
  fallbackTypes,
  matchesQuery,
  moveInOrder,
  newTitleFor,
  sidebarTypeRows,
  typeMeta,
} from "./doc-types";
import type { DocSummary } from "./model";

const node = (p: Partial<DocSummary>): DocSummary =>
  ({ id: "x", kind: "doc", title: "x", parentId: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...p }) as DocSummary;

describe("documents type registry (client)", () => {
  it("every built-in and offered icon exists in the app icon set (no emoji)", () => {
    for (const t of fallbackTypes()) expect(icons).toHaveProperty(t.icon);
    for (const name of TYPE_ICON_CHOICES) expect(icons).toHaveProperty(name);
  });

  it("New menu offers creatable types (Idea yes, Report no); the editor chip only documents-backed types", () => {
    const types = fallbackTypes();
    const creatable = creatableTypes(types).map((t) => t.id);
    expect(creatable).toContain("idea");
    expect(creatable).toContain("meeting");
    expect(creatable).not.toContain("report");
    const assignable = assignableTypes(types).map((t) => t.id);
    expect(assignable).not.toContain("idea");
    expect(assignable).not.toContain("report");
    expect(assignable).toContain("note");
  });

  it("hidden/archived types leave the pickers but stay in the sidebar while they hold items", () => {
    const types = fallbackTypes().map((t) => (t.id === "plan" ? { ...t, hidden: true } : t));
    expect(creatableTypes(types).some((t) => t.id === "plan")).toBe(false);
    expect(sidebarTypeRows(types, {}).some((r) => r.type.id === "plan")).toBe(false);
    expect(sidebarTypeRows(types, { plan: 2 }).find((r) => r.type.id === "plan")?.count).toBe(2);
  });

  it("unknown type ids render with a neutral fallback", () => {
    expect(typeMeta(fallbackTypes(), "c-gone")).toMatchObject({ id: "c-gone", label: "gone", icon: "fileText" });
  });

  it("untyped docs are typed with the shared inference; stored types win", () => {
    const types = fallbackTypes();
    expect(docTypeOf(node({ title: "COO Standup — Monday" }), types)).toBe("meeting");
    expect(docTypeOf(node({ title: "COO Standup — Monday", type: "note" }), types)).toBe("note");
    expect(docTypeOf(node({ kind: "folder", title: "Plans" }), types)).toBeNull();
  });

  it("fallback library merges docs and ideas (ideas visible in All and under Idea)", () => {
    const types = fallbackTypes();
    const lib = clientLibrary(
      [node({ id: "d1", title: "Roadmap 2027" }), node({ id: "f1", kind: "folder", title: "Work" }), node({ id: "d2", title: "Old", deletedAt: "2026-10-02" })],
      [{ id: "i1", title: "Voice CRM", body: "", tags: [], status: "new", createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" }],
      types,
    );
    expect(lib.items.map((i) => [i.id, i.type])).toEqual([
      ["i1", "idea"],
      ["d1", "plan"],
    ]);
    expect(lib.counts.byType).toEqual({ idea: 1, plan: 1 });
    expect(clientLibrary([], [{ id: "i1", title: "a", body: "", tags: [], status: "new", createdAt: "", updatedAt: "" }], types, { type: "idea" }).total).toBe(1);
  });

  it("helpers: query match, category rows, reorder, default titles", () => {
    expect(matchesQuery({ id: "a", source: "idea", type: "idea", title: "Voice CRM", tags: ["sales"], updatedAt: "" }, "crm sales")).toBe(true);
    expect(matchesQuery({ id: "a", source: "idea", type: "idea", title: "Voice CRM", updatedAt: "" }, "crm billing")).toBe(false);
    expect(categoryRows({ b: 1, a: 3, c: 1 }).map((r) => r.category)).toEqual(["a", "b", "c"]);
    expect(moveInOrder(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
    expect(moveInOrder(["a", "b"], "a", -1)).toEqual(["a", "b"]);
    const meeting = fallbackTypes().find((t) => t.id === "meeting")!;
    expect(newTitleFor(meeting, new Date("2026-10-14T09:00:00Z"))).toBe("Meeting · 2026-10-14");
    expect(newTitleFor(fallbackTypes().find((t) => t.id === "sop")!)).toBe("Untitled sop");
  });
});
