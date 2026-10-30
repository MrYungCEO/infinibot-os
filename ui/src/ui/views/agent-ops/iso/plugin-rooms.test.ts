import { describe, expect, it } from "vitest";

import {
  CORE_GRID,
  RESERVED_RECTS,
  ROOM_TILES,
  THEME_DECOR,
  decorForRoom,
  districtConduits,
  districtSlots,
  loopLines,
  planDistrict,
  rectsOverlap,
  resolveRoomAccent,
  roomSpecFromPlugin,
  roomSpecsFromPluginList,
  type PluginRoomSource,
  type PluginRoomSpec,
  type RoomTheme,
} from "./plugin-rooms";

const THEMES = Object.keys(THEME_DECOR) as RoomTheme[];

function plugin(id: string, extra: Partial<PluginRoomSource> = {}, mapRoom: Record<string, unknown> | null = {}): PluginRoomSource {
  return {
    id,
    name: id.replace(/-/g, " "),
    status: "loaded",
    manifestVersion: 2,
    contributes: {
      pages: [{ tab: id, route: `/${id}` }],
      nav: [{ tab: id }],
      ...(mapRoom ? { mapRoom: { title: id, theme: "generic", size: "M", placement: "auto", ...mapRoom } } : {}),
    },
    appearance: { monogram: id.slice(0, 2).toUpperCase() },
    ...extra,
  };
}

function specs(n: number, size: "S" | "M" | "L" | "mix" = "M"): PluginRoomSpec[] {
  const items: PluginRoomSource[] = [];
  for (let i = 0; i < n; i++) {
    const sz = size === "mix" ? (["S", "M", "L"] as const)[i % 3] : size;
    items.push(plugin(`plugin-${String(i).padStart(2, "0")}`, {}, { size: sz, theme: THEMES[i % THEMES.length] }));
  }
  return roomSpecsFromPluginList(items);
}

describe("roomSpecFromPlugin", () => {
  it("builds a spec from a loaded v2 plugin with a mapRoom", () => {
    const s = roomSpecFromPlugin(
      plugin("infinitrade", { name: "Infinitrade", appearance: { monogram: "IT" } }, { title: "Infinitrade Floor", theme: "trading-floor", size: "L", placement: "south" }),
    );
    expect(s).toMatchObject({
      id: "plugin:infinitrade",
      pluginId: "infinitrade",
      title: "Infinitrade Floor",
      theme: "trading-floor",
      size: "L",
      placement: "south",
      monogram: "IT",
      openTab: "infinitrade",
      routes: ["/infinitrade"],
    });
    expect(s!.decor.some((d) => d.t === "tickerBoard")).toBe(true);
    expect(s!.subtitle).toBe("plugin · trading floor");
  });

  it("opens the plugin's root page even when the nav lists a sub-page first (Infinitrade)", () => {
    const s = roomSpecFromPlugin(
      plugin("infinitrade", {
        contributes: {
          nav: [{ tab: "infinitrade-knowledge" }, { tab: "infinitrade" }],
          pages: [{ tab: "infinitrade-knowledge", route: "/infinitrade/knowledge" }, { tab: "infinitrade", route: "/infinitrade" }],
          mapRoom: { theme: "trading-floor" },
        },
      }),
    )!;
    expect(s.openTab).toBe("infinitrade");
    const noRoot = roomSpecFromPlugin(
      plugin("content-studio", {
        contributes: { nav: [{ tab: "content-intel" }, { tab: "content-pages" }], pages: [{ tab: "content-pages", route: "/content-pages" }, { tab: "content-intel", route: "/content-intel" }], mapRoom: {} },
      }),
    )!;
    expect(noRoot.openTab).toBe("content-intel"); // shortest nav route wins ties by nav order
  });

  it("skips plugins that are not loaded, v1, without a room, or with the room switched off", () => {
    expect(roomSpecFromPlugin(plugin("a", { status: "disabled" }))).toBeNull();
    expect(roomSpecFromPlugin(plugin("b", { manifestVersion: 1 }))).toBeNull();
    expect(roomSpecFromPlugin(plugin("c", {}, null))).toBeNull();
    expect(roomSpecFromPlugin(plugin("d", { disabledContributions: ["mapRoom:d"] }))).toBeNull();
    expect(roomSpecFromPlugin(plugin("e", { disabledContributions: ["mapRoom:other"] }))).not.toBeNull();
  });

  it("falls back to generic/M/auto and a derived monogram for unknown values", () => {
    const s = roomSpecFromPlugin(plugin("weird", { name: "Weird Thing", appearance: undefined }, { theme: "castle", size: "XL", placement: "up" }))!;
    expect(s.theme).toBe("generic");
    expect(s.size).toBe("M");
    expect(s.placement).toBe("auto");
    expect(s.monogram).toBe("WT");
  });

  it("uses the declared accent (hex or token) else the theme accent", () => {
    expect(resolveRoomAccent("dojo", "#ff8800")).toBe(0xff8800);
    expect(resolveRoomAccent("dojo", "token:info")).toBe(0x38bdf8);
    expect(resolveRoomAccent("dojo", "token:nope")).toBe(resolveRoomAccent("dojo"));
    const accents = new Set(THEMES.map((t) => resolveRoomAccent(t)));
    expect(accents.size).toBe(THEMES.length); // every theme is visually distinct
  });

  it("sorts specs by plugin id and de-duplicates", () => {
    const list = roomSpecsFromPluginList([plugin("zeta"), plugin("alpha"), plugin("alpha")]);
    expect(list.map((s) => s.pluginId)).toEqual(["alpha", "zeta"]);
  });
});

describe("decorForRoom", () => {
  it("scales the 8×8 reference to the room size and keeps props inside", () => {
    for (const theme of THEMES) {
      for (const size of ["S", "M", "L"] as const) {
        const tiles = ROOM_TILES[size];
        for (const d of decorForRoom(theme, size)) {
          expect(d.c, `${theme}/${size}/${d.t}`).toBeGreaterThan(0);
          expect(d.r, `${theme}/${size}/${d.t}`).toBeGreaterThan(0);
          expect(d.c, `${theme}/${size}/${d.t}`).toBeLessThan(tiles);
          expect(d.r, `${theme}/${size}/${d.t}`).toBeLessThan(tiles);
        }
      }
    }
  });

  it("lays out an explicit prop list instead of the theme set", () => {
    const d = decorForRoom("fleet", "M", ["desk", "safe"]);
    expect(d.map((x) => x.t)).toEqual(["desk", "safe"]);
  });
});

describe("districtSlots", () => {
  it("ring 1 has 12 slots and every slot clears the core", () => {
    const slots = districtSlots(1);
    expect(slots).toHaveLength(12);
    for (const s of slots) {
      expect(rectsOverlap({ c: s.c, r: s.r, w: 8, h: 8 }, { c: 0, r: 0, w: CORE_GRID, h: CORE_GRID })).toBe(false);
    }
    expect(slots[0].side).toBe("south"); // nearest the Gateway Concourse first
    expect(slots.map((s) => s.index)).toEqual([...slots.keys()]);
  });

  it("ring 2 adds 20 more slots that never overlap ring 1", () => {
    const all = districtSlots(2);
    expect(all).toHaveLength(32);
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j];
        expect(rectsOverlap({ c: a.c, r: a.r, w: 8, h: 8 }, { c: b.c, r: b.r, w: 8, h: 8 }), `${i}/${j}`).toBe(false);
      }
  });
});

describe("planDistrict", () => {
  const checkNoOverlap = (rooms: Map<string, { c: number; r: number; w: number; h: number }>) => {
    const list = [...rooms.values()];
    const core = { c: 0, r: 0, w: CORE_GRID, h: CORE_GRID };
    for (let i = 0; i < list.length; i++) {
      expect(rectsOverlap(list[i], core), `room ${i} vs core`).toBe(false);
      for (const res of RESERVED_RECTS) expect(rectsOverlap(list[i], res), `room ${i} vs ${res.id}`).toBe(false);
      for (let j = i + 1; j < list.length; j++) expect(rectsOverlap(list[i], list[j]), `room ${i} vs ${j}`).toBe(false);
    }
  };

  it("places every room without overlap for 1…40 plugins of mixed sizes", () => {
    for (const n of [1, 2, 5, 11, 12, 13, 20, 32, 40]) {
      const plan = planDistrict(specs(n, "mix"));
      expect(plan.size, `n=${n}`).toBe(n);
      checkNoOverlap(plan);
    }
  });

  it("fits the 12 first-party plugins on ring 1, flanking the Executive Suite", () => {
    const plan = planDistrict(specs(12, "M"));
    expect([...plan.values()].every((r) => r.ring === 1)).toBe(true);
    const north = [...plan.values()].filter((r) => r.side === "north").map((r) => r.c).sort((a, b) => a - b);
    expect(north).toEqual([-11, -1.5, 17.5]); // exec suite sits between −1.5+8 and 17.5
    const south = [...plan.values()].filter((r) => r.side === "south").map((r) => r.c).sort((a, b) => a - b);
    expect(south).toEqual([2.5, 13.5, 27]); // symmetric interior about the core centre (12) + bottom vertex
    const perSide = ["north", "east", "south", "west"].map((side) => [...plan.values()].filter((r) => r.side === side).length);
    expect(perSide).toEqual([3, 3, 3, 3]);
    const plan13 = planDistrict(specs(13, "M"));
    expect([...plan13.values()].filter((r) => r.ring === 2)).toHaveLength(1);
  });

  it("is deterministic", () => {
    const a = planDistrict(specs(17, "mix"));
    const b = planDistrict(specs(17, "mix"));
    expect([...a.entries()].map(([k, v]) => [k, v.c, v.r, v.w])).toEqual([...b.entries()].map(([k, v]) => [k, v.c, v.r, v.w]));
    // Input order doesn't matter.
    const shuffled = [...specs(17, "mix")].reverse();
    const c = planDistrict(shuffled);
    expect([...c.entries()].map(([k, v]) => [k, v.c, v.r])).toEqual([...a.entries()].map(([k, v]) => [k, v.c, v.r]));
  });

  it("keeps existing rooms in place when a plugin is added or removed (sticky)", () => {
    const base = specs(8, "mix");
    const plan = planDistrict(base);
    const extra = roomSpecFromPlugin(plugin("aaa-new", {}, { size: "M" }))!; // sorts first
    const withExtra = planDistrict([...base, extra], plan);
    for (const [id, room] of plan) {
      expect(withExtra.get(id)).toMatchObject({ c: room.c, r: room.r, w: room.w });
    }
    expect(withExtra.has(extra.id)).toBe(true);
    checkNoOverlap(withExtra);
    const removed = planDistrict([...base, extra].filter((s) => s.pluginId !== "plugin-03"), withExtra);
    for (const [id, room] of withExtra) {
      if (id === "plugin:plugin-03") continue;
      expect(removed.get(id)).toMatchObject({ c: room.c, r: room.r });
    }
  });

  it("preferred sides are filled before fallbacks spill over (12 first-party rooms)", () => {
    const fp: Array<[string, "S" | "M" | "L", "north" | "east" | "south" | "west"]> = [
      ["business-agency", "L", "south"], ["canvas-library", "M", "north"], ["content-studio", "M", "east"], ["discipline", "S", "north"],
      ["flypic", "M", "west"], ["infinicode", "M", "east"], ["infinitrade", "L", "south"], ["omniclinic", "L", "west"],
      ["products", "M", "west"], ["robovoice", "M", "east"], ["solatrix", "M", "south"], ["whiteboard", "S", "north"],
    ];
    const list = fp.map(([id, size, placement]) => roomSpecFromPlugin(plugin(id, {}, { size, placement }))!);
    const plan = planDistrict(list);
    expect(plan.size).toBe(12);
    // Ring 1 has 3 slots per side and three plugins prefer each side, so every
    // preference is honoured with no spill-over.
    for (const [id, , placement] of fp) expect(plan.get(`plugin:${id}`)!.side, id).toBe(placement);
    const southC = [...plan.values()].filter((r) => r.side === "south").map((r) => r.spec.pluginId + "@" + r.slot.c);
    expect(southC).toContain("solatrix@27");
  });

  it("honours a preferred side when it has room", () => {
    const south = roomSpecFromPlugin(plugin("south-one", {}, { placement: "south" }))!;
    const north = roomSpecFromPlugin(plugin("north-one", {}, { placement: "north" }))!;
    const plan = planDistrict([south, north]);
    expect(plan.get(south.id)!.side).toBe("south");
    expect(plan.get(north.id)!.side).toBe("north");
  });

  it("L rooms overflow their slot but never each other", () => {
    const plan = planDistrict(specs(12, "L"));
    expect(plan.size).toBe(12);
    checkNoOverlap(plan);
    expect([...plan.values()].every((r) => r.w === 10)).toBe(true);
  });
});

describe("districtConduits", () => {
  it("draws one loop per ring, a stub per room and one trunk to the concourse", () => {
    const plan = planDistrict(specs(14, "M"));
    const segs = districtConduits(plan.values());
    const rings = Math.max(...[...plan.values()].map((r) => r.ring));
    expect(rings).toBe(2);
    expect(segs.filter((s) => s.kind === "loop")).toHaveLength(4 * rings);
    expect(segs.filter((s) => s.kind === "stub")).toHaveLength(14);
    expect(segs.filter((s) => s.kind === "spoke")).toHaveLength(4);
    expect(segs.filter((s) => s.kind === "trunk")).toHaveLength(1);
    // Every stub ends on its ring's loop line.
    for (const room of plan.values()) {
      const stub = segs.find((s) => s.kind === "stub" && s.roomId === room.spec.id)!;
      const { outer, inner } = loopLines(room.ring);
      const onLoop = [stub.b.c, stub.b.r].some((v) => v === outer || v === inner);
      expect(onLoop, room.spec.id).toBe(true);
    }
  });
});
