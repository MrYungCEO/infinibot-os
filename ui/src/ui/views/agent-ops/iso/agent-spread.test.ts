import { describe, expect, it } from "vitest";
import {
  DOMAIN_SECTOR,
  SpreadPlanner,
  classifyAgentDomain,
  computeWorkSlots,
  minPairDistance,
  relaxPoints,
  separationOffsets,
  softCapacity,
  type SpreadAgentInput,
  type SpreadSectorDef,
} from "./agent-spread";

// Mirrors SECTORS in sector-layout.ts (kept local: that module pulls in Pixi).
const SECTORS: SpreadSectorDef[] = [
  { id: "observatory", c: 0, r: 0, w: 8, h: 8 },
  { id: "mission-control", c: 8, r: 0, w: 8, h: 8 },
  { id: "comms-deck", c: 16, r: 0, w: 8, h: 8 },
  { id: "agent-quarters", c: 0, r: 8, w: 8, h: 8 },
  { id: "command-atrium", c: 8, r: 8, w: 8, h: 8 },
  { id: "broadcast-studio", c: 16, r: 8, w: 8, h: 4 },
  { id: "the-vault", c: 16, r: 12, w: 8, h: 4 },
  { id: "engineering-bay", c: 0, r: 16, w: 8, h: 8 },
  { id: "gateway-concourse", c: 8, r: 16, w: 8, h: 8 },
  { id: "canvas-atrium", c: 16, r: 16, w: 8, h: 8 },
];

const agent = (key: string, extra: Partial<SpreadAgentInput> = {}): SpreadAgentInput => ({ key, ...extra });

describe("classifyAgentDomain", () => {
  const now = 100_000;
  it("maps task labels to domains", () => {
    expect(classifyAgentDomain(agent("a", { label: "Fix login bug" }), now)).toBe("code");
    expect(classifyAgentDomain(agent("a", { label: "Research competitor pricing" }), now)).toBe("research");
    expect(classifyAgentDomain(agent("a", { label: "Plan Q4 roadmap" }), now)).toBe("planning");
    expect(classifyAgentDomain(agent("a", { label: "Reply to Telegram inbox" }), now)).toBe("comms");
    expect(classifyAgentDomain(agent("a", { label: "Render promo video" }), now)).toBe("media");
    expect(classifyAgentDomain(agent("a", { label: "Update docs" }), now)).toBe("files");
    expect(classifyAgentDomain(agent("a", { label: "Design landing hero" }), now)).toBe("design");
    expect(classifyAgentDomain(agent("a", { label: "Orchestrate the fleet" }), now)).toBe("orchestration");
  });
  it("prefers a recent tool call over the label, and ignores stale ones", () => {
    const a = agent("a", { label: "Fix login bug", toolKind: "web_fetch", toolAt: now - 1000 });
    expect(classifyAgentDomain(a, now)).toBe("research");
    expect(classifyAgentDomain({ ...a, toolAt: now - 60_000 }, now)).toBe("code");
  });
  it("treats file tools as coding for coder CLI runs", () => {
    expect(classifyAgentDomain(agent("a", { toolKind: "read", toolAt: now, backend: "codex" }), now)).toBe("code");
    expect(classifyAgentDomain(agent("a", { toolKind: "read", toolAt: now }), now)).toBe("files");
  });
  it("falls back to agent id, then coder backend, then null", () => {
    expect(classifyAgentDomain(agent("a", { agentId: "scout" }), now)).toBe("research");
    expect(classifyAgentDomain(agent("a", { backend: "gemini", label: "run 7" }), now)).toBe("code");
    expect(classifyAgentDomain(agent("a", { label: "zzz" }), now)).toBeNull();
  });
});

describe("SpreadPlanner", () => {
  it("sends each agent to its domain sector with distinct slots", () => {
    const p = new SpreadPlanner({ sectors: SECTORS });
    const out = p.update(
      [
        agent("code1", { label: "Fix bug" }),
        agent("code2", { label: "Refactor auth" }),
        agent("res", { label: "Research pricing" }),
        agent("plan", { label: "Plan sprint" }),
        agent("design", { label: "Design logo" }),
      ],
      0,
    );
    expect(out.get("code1")!.sectorId).toBe(DOMAIN_SECTOR.code);
    expect(out.get("code2")!.sectorId).toBe(DOMAIN_SECTOR.code);
    expect(out.get("code1")!.slot).not.toBe(out.get("code2")!.slot);
    expect(out.get("res")!.sectorId).toBe("observatory");
    expect(out.get("plan")!.sectorId).toBe("mission-control");
    expect(out.get("design")!.sectorId).toBe("canvas-atrium");
  });

  it("never puts agents on the concourse (rest area)", () => {
    const p = new SpreadPlanner({ sectors: SECTORS });
    const agents = Array.from({ length: 30 }, (_, i) => agent(`a${i}`));
    const out = p.update(agents, 0);
    for (const a of out.values()) expect(a.sectorId).not.toBe("gateway-concourse");
  });

  it("overflows past soft capacity to the nearest sector with room", () => {
    const p = new SpreadPlanner({ sectors: SECTORS });
    const cap = softCapacity(SECTORS.find((s) => s.id === "engineering-bay")!);
    expect(cap).toBe(4);
    const coders = Array.from({ length: 9 }, (_, i) => agent(`c${i}`, { label: "Fix bug", backend: "claude-code" }));
    const out = p.update(coders, 0);
    const loads = p.loads();
    expect(loads.get("engineering-bay")).toBe(4);
    // Neighbours of Engineering Bay (tile-centre distance 8): Agent Quarters + Concourse(excluded).
    expect(loads.get("agent-quarters")).toBe(4);
    // The 9th goes to the next nearest sector with room — not a full one.
    for (const [id, n] of loads) expect(n).toBeLessThanOrEqual(softCapacity(SECTORS.find((s) => s.id === id)!));
    expect([...out.values()].filter((a) => a.sectorId === "engineering-bay").length).toBe(4);
  });

  it("spreads unclassified agents across many sectors instead of one", () => {
    const p = new SpreadPlanner({ sectors: SECTORS });
    const out = p.update(Array.from({ length: 12 }, (_, i) => agent(`run-${i}`)), 0);
    const used = new Set([...out.values()].map((a) => a.sectorId));
    expect(used.size).toBeGreaterThanOrEqual(6);
  });

  it("is deterministic for the same input regardless of order", () => {
    const list = Array.from({ length: 14 }, (_, i) => agent(`k${i}`, { label: i % 2 ? "Fix bug" : "" }));
    const a = new SpreadPlanner({ sectors: SECTORS }).update(list, 0);
    const b = new SpreadPlanner({ sectors: SECTORS }).update([...list].reverse(), 0);
    for (const [k, v] of a) expect(b.get(k)).toEqual(v);
  });

  it("hysteresis: a brief tool detour does not move the agent", () => {
    const p = new SpreadPlanner({ sectors: SECTORS, dwellMs: 8000, minStayMs: 6000 });
    p.update([agent("x", { label: "Fix bug", backend: "codex" })], 0);
    expect(p.get("x")!.sectorId).toBe("engineering-bay");
    // Research tool fires at t=10s, then coding again at t=12s.
    p.update([agent("x", { label: "Fix bug", backend: "codex", toolKind: "web_fetch", toolAt: 10_000 })], 10_000);
    p.update([agent("x", { label: "Fix bug", backend: "codex", toolKind: "web_fetch", toolAt: 10_000 })], 14_000);
    expect(p.get("x")!.sectorId).toBe("engineering-bay");
    p.update([agent("x", { label: "Fix bug", backend: "codex", toolKind: "bash", toolAt: 16_000 })], 16_000);
    p.update([agent("x", { label: "Fix bug", backend: "codex", toolKind: "web_fetch", toolAt: 17_000 })], 17_000);
    p.update([agent("x", { label: "Fix bug", backend: "codex", toolKind: "web_fetch", toolAt: 17_000 })], 20_000);
    expect(p.get("x")!.sectorId).toBe("engineering-bay"); // pending restarted at 17s
  });

  it("hysteresis: a sustained change of work moves the agent after the dwell", () => {
    const p = new SpreadPlanner({ sectors: SECTORS, dwellMs: 8000, minStayMs: 6000 });
    p.update([agent("x", { label: "Fix bug", backend: "codex" })], 0);
    const web = (t: number) => agent("x", { label: "Fix bug", backend: "codex", toolKind: "web_search", toolAt: t });
    p.update([web(10_000)], 10_000);
    p.update([web(15_000)], 15_000);
    expect(p.get("x")!.sectorId).toBe("engineering-bay");
    p.update([web(18_500)], 18_500);
    expect(p.get("x")!.sectorId).toBe("observatory");
  });

  it("hysteresis: does not move into a full sector", () => {
    const p = new SpreadPlanner({ sectors: SECTORS, dwellMs: 1000, minStayMs: 0 });
    const researchers = Array.from({ length: 4 }, (_, i) => agent(`r${i}`, { label: "Research pricing" }));
    p.update([...researchers, agent("x", { label: "Fix bug" })], 0);
    const web = agent("x", { label: "Fix bug", toolKind: "web_fetch", toolAt: 5000 });
    p.update([...researchers, web], 5000);
    p.update([...researchers, { ...web, toolAt: 7000 }], 7000);
    expect(p.get("x")!.sectorId).toBe("engineering-bay");
    expect(p.loads().get("observatory")).toBe(4);
  });

  it("frees slots when agents leave and reuses them", () => {
    const p = new SpreadPlanner({ sectors: SECTORS });
    p.update([agent("a", { label: "Fix bug" }), agent("b", { label: "Fix bug" })], 0);
    const slotA = p.get("a")!.slot;
    p.update([agent("b", { label: "Fix bug" })], 1000);
    expect(p.get("a")).toBeUndefined();
    p.update([agent("b", { label: "Fix bug" }), agent("c", { label: "Fix bug" })], 2000);
    expect(p.get("c")!.slot).toBe(slotA);
  });
});

describe("computeWorkSlots", () => {
  const decor = [
    { t: "desk", c: 2, r: 5.4 },
    { t: "holoTable", c: 2.6, r: 3.2 },
    { t: "telescope", c: 4.8, r: 1.8 },
    { t: "crate", c: 5.2, r: 6.2 },
  ];
  it("returns distinct slots inside the sector, clear of props", () => {
    const slots = computeWorkSlots({ w: 8, h: 8 }, decor);
    expect(slots.length).toBeGreaterThanOrEqual(6);
    for (const s of slots) {
      expect(s.c).toBeGreaterThan(0);
      expect(s.r).toBeGreaterThan(0);
      expect(s.c).toBeLessThan(8);
      expect(s.r).toBeLessThan(8);
    }
    for (let i = 0; i < slots.length; i++)
      for (let j = i + 1; j < slots.length; j++)
        expect(Math.hypot(slots[i].c - slots[j].c, slots[i].r - slots[j].r)).toBeGreaterThanOrEqual(1.35 - 1e-9);
  });
  it("fits in the short 8×4 sectors too", () => {
    expect(computeWorkSlots({ w: 8, h: 4 }, [{ t: "safe", c: 1.8, r: 2 }]).length).toBeGreaterThanOrEqual(2);
  });
});

describe("separation", () => {
  it("pushes a crowded cluster apart until nothing overlaps", () => {
    // 20 agents dropped in a 30×20px blob (worst case: everyone at one desk).
    const pts = Array.from({ length: 20 }, (_, i) => ({ x: (i * 37) % 30, y: (i * 53) % 20 }));
    pts.push({ x: 5, y: 5 }, { x: 5, y: 5 }); // exact duplicates
    const out = relaxPoints(pts, 28, 80);
    expect(minPairDistance(out)).toBeGreaterThanOrEqual(28 * 0.98);
  });
  it("leaves already-spaced points alone", () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }];
    const off = separationOffsets(pts, 28);
    for (const o of off) expect(o).toEqual({ x: 0, y: 0 });
  });
});
