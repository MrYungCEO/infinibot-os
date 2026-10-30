import { afterEach, describe, expect, it } from "vitest";

import {
  colorFor,
  computeOrbits,
  DEFAULT_KINDS,
  hash01,
  hierarchyRadius,
  loadPositions,
  savePositions,
  KIND_SHAPE,
  SHAPE,
  HEALTH_COLOR,
  healthOf,
  loadEnabledHealth,
  loadEnabledKinds,
  openTargetFor,
  orbitFor,
  placeLabels,
  saveEnabledKinds,
} from "./knowledge-graph-model";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

describe("filter persistence", () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("defaults leave tasks, rows and sessions off", () => {
    const kinds = loadEnabledKinds();
    expect(kinds.has("project")).toBe(true);
    expect(kinds.has("client")).toBe(true);
    for (const heavy of ["task", "row", "session"] as const) expect(kinds.has(heavy)).toBe(false);
    expect([...kinds].sort()).toEqual([...DEFAULT_KINDS].sort());
    expect(loadEnabledHealth().has("done")).toBe(false);
  });

  it("round-trips a toggle and ignores junk", () => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
    saveEnabledKinds(new Set(["project", "task"]));
    expect([...loadEnabledKinds()].sort()).toEqual(["project", "task"]);
    globalThis.localStorage.setItem("infinibot.kg.kinds.v2", "{not json");
    expect(loadEnabledKinds().has("task")).toBe(false);
  });

  it("turns newly-introduced default kinds on once for legacy stored sets", () => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
    globalThis.localStorage.setItem("infinibot.kg.kinds.v2", JSON.stringify(["project", "note"]));
    const first = loadEnabledKinds();
    expect(first.has("file")).toBe(true);
    expect(first.has("topic")).toBe(false);
    // The user then hides files: that choice sticks.
    first.delete("file");
    saveEnabledKinds(first);
    expect(loadEnabledKinds().has("file")).toBe(false);
  });

  it("survives a throwing storage", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("quota");
      },
    };
    expect(() => saveEnabledKinds(new Set(["task"]))).not.toThrow();
    expect(loadEnabledKinds().has("project")).toBe(true);
  });
});

describe("status + layout helpers", () => {
  it("paints projects by health and falls back to backlog", () => {
    expect(colorFor("project", { health: "blocked" })).toBe(HEALTH_COLOR.blocked);
    expect(healthOf({ health: "nonsense" })).toBe("backlog");
    expect(colorFor("note")).not.toBe(HEALTH_COLOR.backlog);
  });

  it("orbits nest open → backlog → done → strays", () => {
    const o = computeOrbits({ open: 10, backlog: 100, done: 20 });
    expect(o.open).toBeLessThan(o.backlog);
    expect(o.backlog).toBeLessThan(o.done);
    expect(o.done).toBeLessThan(o.stray);
    expect(orbitFor("at_risk", o)).toBe(o.open);
    expect(orbitFor("backlog", o)).toBe(o.backlog);
  });
});

describe("openTargetFor", () => {
  it("deep-links projects/clients/notes to their entity pages", () => {
    const t = openTargetFor({ id: "project:abc-123", kind: "project", label: "RoboPark" });
    expect(t).toEqual({ type: "path", path: expect.stringMatching(/^\/projects\/robopark.*abc-123$/) });
    const c = openTargetFor({ id: "client:c1", kind: "client", label: "Example Client" }, "/ui");
    expect(c?.type === "path" && c.path.startsWith("/ui/clients/")).toBe(true);
  });

  it("routes register objects to their tabs and runs to the agent focus modal", () => {
    expect(openTargetFor({ id: "decision:d", kind: "decision", label: "x" })).toEqual({
      type: "path",
      path: "/decisions",
    });
    expect(
      openTargetFor({ id: "run:r1", kind: "run", label: "x", meta: { runId: "r1" } }),
    ).toEqual({ type: "agent-focus", detail: { runId: "r1" } });
    expect(openTargetFor({ id: "user:u", kind: "user", label: "x" })).toBeNull();
  });
});

describe("placeLabels", () => {
  it("accepts by priority order and rejects overlaps", () => {
    const accepted = placeLabels([
      { x: 0, y: 0, width: 100, height: 14 },
      { x: 50, y: 4, width: 100, height: 14 }, // overlaps #0
      { x: 0, y: 30, width: 100, height: 14 }, // clear below
      { x: 200, y: 0, width: 40, height: 14 },
    ]);
    expect(accepted).toEqual([0, 2, 3]);
  });

  it("respects the budget", () => {
    const cands = Array.from({ length: 50 }, (_, i) => ({ x: i * 200, y: 0, width: 50, height: 14 }));
    expect(placeLabels(cands, 48, 10)).toHaveLength(10);
  });
});

describe("hash01", () => {
  it("is deterministic per id", () => {
    expect(hash01("project:p")).toBe(hash01("project:p"));
    expect(hash01("project:p")).not.toBe(hash01("project:q"));
  });
});

describe("hierarchy sizing + type shapes", () => {
  it("orders size by hierarchy depth, not degree: parent > sub-project > leaf", () => {
    const parentMin = hierarchyRadius("project", 0, 0);
    const sub = hierarchyRadius("project", 1, 1); // a very busy sub-project
    const subsub = hierarchyRadius("project", 2, 1);
    expect(parentMin / sub).toBeGreaterThanOrEqual(2.5);
    expect(hierarchyRadius("project", 0, 1) / sub).toBeLessThanOrEqual(3);
    expect(sub).toBeGreaterThan(subsub);
    for (const leaf of ["task", "note", "report", "agent", "content", "issue"] as const) {
      expect(hierarchyRadius(leaf, 0, 1)).toBeLessThan(subsub);
    }
  });

  it("gives every kind an iconic shape and distinguishes the main types", () => {
    expect(KIND_SHAPE.project).toBe(SHAPE.gem);
    expect(KIND_SHAPE.task).toBe(SHAPE.block);
    expect(KIND_SHAPE.note).toBe(SHAPE.pages);
    expect(KIND_SHAPE.report).toBe(SHAPE.report);
    expect(KIND_SHAPE.agent).toBe(SHAPE.agent);
    expect(KIND_SHAPE.content).toBe(SHAPE.media);
    expect(KIND_SHAPE.person).toBe(SHAPE.person);
    expect(KIND_SHAPE.node).toBe(SHAPE.chip);
    const main = [KIND_SHAPE.project, KIND_SHAPE.task, KIND_SHAPE.note, KIND_SHAPE.report, KIND_SHAPE.agent];
    expect(new Set(main).size).toBe(main.length);
  });

  it("shape ids match the glow3d geometry table", async () => {
    const { NODE_SHAPES } = await import("../lib/glow3d/node-shapes");
    expect(NODE_SHAPES).toEqual(SHAPE);
  });
});

describe("saved positions migrate to 3D", () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("drops old flat (x/y) saves so they can't pin the galaxy to one plane", () => {
    const ls = memoryStorage();
    (globalThis as { localStorage?: Storage }).localStorage = ls;
    ls.setItem("infinibot.kg.pos.v1", JSON.stringify({ "project:a": [10, 20] }));
    ls.setItem("infinibot.kg.pos.v2", JSON.stringify({ "project:b": [1, 2, 3], "project:flat": [4, 5] }));
    const got = loadPositions();
    expect(ls.getItem("infinibot.kg.pos.v1")).toBeNull();
    expect(got.has("project:a")).toBe(false);
    expect(got.has("project:flat")).toBe(false);
    expect(got.get("project:b")).toEqual([1, 2, 3]);
  });

  it("saves x, y AND height relative to the centre", () => {
    const ls = memoryStorage();
    (globalThis as { localStorage?: Storage }).localStorage = ls;
    savePositions([{ id: "project:c", x: 110, y: 230, z: -42.4, anchor: true }], { cx: 100, cy: 200 });
    expect(JSON.parse(ls.getItem("infinibot.kg.pos.v2")!)).toEqual({ "project:c": [10, 30, -42] });
  });
});
