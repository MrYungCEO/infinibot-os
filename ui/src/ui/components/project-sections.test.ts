import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { organizeReports, reportTypeLabel } from "./report-associations";
import { AUTO_COLLAPSE_OVER, relationsOpenFor } from "./project-relations";

const DAY = 86_400_000;
const r = (id: string, title: string, at: number, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  kind: "custom",
  status: "ready",
  category: null as string | null,
  createdAt: at,
  renderedAt: at,
  filePath: `/x/${id}.pdf`,
  fileSize: 1024,
  summaryText: null as string | null,
  ...extra,
});

describe("organizeReports", () => {
  const now = Date.UTC(2026, 9, 13);
  const list = [
    r("a", "Alpha audit", now - 40 * DAY, { category: "Security" }),
    r("b", "Bravo brief", now - 1 * DAY, { kind: "daily_operational" }),
    r("c", "Charlie check", now - 70 * DAY, { category: "Security" }),
  ];

  it("sorts newest first by default and groups by month", () => {
    const groups = organizeReports(list, {});
    expect(groups.flatMap((g) => g.items.map((i) => i.id))).toEqual(["b", "a", "c"]);
    expect(groups.length).toBe(3);
  });

  it("supports oldest-first and title sorts in a single group", () => {
    expect(organizeReports(list, { sort: "oldest", groupBy: "none" })[0].items.map((i) => i.id)).toEqual(["c", "a", "b"]);
    expect(organizeReports(list, { sort: "title", groupBy: "none" })[0].items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("groups by type biggest-first, preferring the category over the kind", () => {
    const groups = organizeReports(list, { groupBy: "type" });
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ["Security", 2],
      ["Daily operational", 1],
    ]);
  });

  it("filters by query across title, kind and category; empty list → no groups", () => {
    expect(organizeReports(list, { query: "bravo", groupBy: "none" })[0].items.map((i) => i.id)).toEqual(["b"]);
    expect(organizeReports(list, { query: "zzz" })).toEqual([]);
    expect(organizeReports([], { groupBy: "none" })).toEqual([]);
  });

  it("labels types readably", () => {
    expect(reportTypeLabel({ kind: "weekly_strategic" })).toBe("Weekly strategic");
    expect(reportTypeLabel({ kind: "x", category: "agent-output" })).toBe("Agent output");
  });
});

describe("relationsOpenFor", () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    (globalThis as any).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => (store[k] = v),
    };
  });
  afterEach(() => delete (globalThis as any).localStorage);

  it("starts collapsed only when there are more than the threshold", () => {
    expect(relationsOpenFor("project:p1", AUTO_COLLAPSE_OVER)).toBe(true);
    expect(relationsOpenFor("project:p1", AUTO_COLLAPSE_OVER + 1)).toBe(false);
  });

  it("remembers the user's choice per project", () => {
    store["ib.projectRelations.open"] = JSON.stringify({ "project:p1": true, "project:p2": false });
    expect(relationsOpenFor("project:p1", 100)).toBe(true);
    expect(relationsOpenFor("project:p2", 2)).toBe(false);
    expect(relationsOpenFor("project:p3", 100)).toBe(false);
  });
});
