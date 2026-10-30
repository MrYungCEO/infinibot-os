import { describe, expect, it } from "vitest";

import { buildNetworkGraph } from "./graph.js";
import { ME_ID, type Connection, type Contact } from "./types.js";
import {
  computeWarmScore,
  normalizeWarmOverride,
  WARM_BANDS,
  WARM_WEIGHTS,
  warmBand,
  warmTrend,
  type WarmSignals,
} from "./warm.js";

const cold: WarmSignals = {
  staleDays: null,
  connections: [],
  interactions: 0,
  openOpportunities: 0,
  linkedObjects: 0,
};

describe("computeWarmScore", () => {
  it("weights add up to 100", () => {
    expect(Object.values(WARM_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("a never-touched, unconnected person is 0; everything maxed is 100", () => {
    expect(computeWarmScore(cold).score).toBe(0);
    const hot = computeWarmScore({
      staleDays: 0,
      connections: [{ strength: 5, status: "Active", direction: "mutual" }],
      interactions: 20,
      openOpportunities: 5,
      linkedObjects: 9,
    });
    expect(hot).toMatchObject({ score: 100, computed: 100, overridden: false });
    expect(hot.breakdown).toEqual(WARM_WEIGHTS);
  });

  it("recency halves every 45 days", () => {
    const at = (d: number) => computeWarmScore({ ...cold, staleDays: d }).breakdown.recency;
    expect(at(0)).toBe(35);
    expect(at(45)).toBe(17.5);
    expect(at(90)).toBe(8.8);
    expect(at(-3)).toBe(35); // future-dated (scheduled) touch counts as fresh
  });

  it("strength uses the best live tie; strained counts half, ended not at all", () => {
    const s = (connections: WarmSignals["connections"]) =>
      computeWarmScore({ ...cold, connections }).breakdown;
    expect(s([{ strength: 1, status: "Active", direction: "mutual" }]).strength).toBe(0);
    expect(s([{ strength: 5, status: "Strained", direction: "mutual" }]).strength).toBe(10);
    expect(s([{ strength: 5, status: "Ended", direction: "mutual" }])).toMatchObject({
      strength: 0,
      reciprocity: 0,
    });
    expect(
      s([
        { strength: 2, status: "Active", direction: "forward" },
        { strength: 4, status: "Active", direction: "forward" },
      ]),
    ).toMatchObject({ strength: 15, reciprocity: 2.5 });
  });

  it("frequency, opportunities and links cap out", () => {
    const b = computeWarmScore({
      ...cold,
      interactions: 4,
      openOpportunities: 1,
      linkedObjects: 10,
    }).breakdown;
    expect(b).toMatchObject({ frequency: 7.5, opportunities: 5, links: 10 });
  });

  it("owner override wins but the computed score is kept", () => {
    const r = computeWarmScore({ ...cold, staleDays: 0 }, 88);
    expect(r).toMatchObject({ score: 88, computed: 35, overridden: true });
    expect(computeWarmScore(cold, null).overridden).toBe(false);
    expect(normalizeWarmOverride("120")).toBe(100);
    expect(normalizeWarmOverride(-4)).toBe(0);
    expect(normalizeWarmOverride("")).toBeNull();
    expect(normalizeWarmOverride("abc")).toBeNull();
  });
});

describe("warm bands + trend", () => {
  it("assigns ring bands at 70 / 45 / 20", () => {
    expect(WARM_BANDS.map((b) => b.id)).toEqual(["inner", "active", "warmable", "dormant"]);
    expect(warmBand(100)).toBe("inner");
    expect(warmBand(70)).toBe("inner");
    expect(warmBand(69)).toBe("active");
    expect(warmBand(45)).toBe("active");
    expect(warmBand(44)).toBe("warmable");
    expect(warmBand(20)).toBe("warmable");
    expect(warmBand(19)).toBe("dormant");
    expect(warmBand(0)).toBe("dormant");
    expect(warmBand(Number.NaN)).toBe("dormant");
  });

  it("trend needs a ±5 move", () => {
    expect(warmTrend(60, 50)).toBe("warming");
    expect(warmTrend(40, 50)).toBe("cooling");
    expect(warmTrend(52, 50)).toBe("steady");
    expect(warmTrend(52, null)).toBe("new");
  });
});

describe("graph integration", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  const contact = (id: string, extra: Partial<Contact> = {}): Contact =>
    ({
      id,
      name: id,
      org: "",
      role: "",
      contactType: "other",
      tags: [],
      channels: {},
      notes: "",
      status: "Active",
      owner: "me",
      priority: "P2",
      nextAction: "",
      nextActionOwner: "",
      nextActionDate: "",
      lastTouchDate: "",
      clientId: "",
      hubContactId: "",
      warmOverride: null,
      createdAt: now,
      updatedAt: now,
      ...extra,
    }) as Contact;
  const cx = (id: string, fromId: string, toId: string, extra: Partial<Connection> = {}) =>
    ({
      id,
      fromId,
      toId,
      relationshipType: "colleague",
      strength: 3,
      direction: "mutual",
      values: [],
      lastTouchDate: "",
      status: "Active",
      notes: "",
      owner: "me",
      createdAt: now,
      updatedAt: now,
      ...extra,
    }) as Connection;

  it("puts every node in a band from real signals, with stats per band", () => {
    const g = buildNetworkGraph({
      now,
      contacts: [
        contact("hot", { lastTouchDate: "2026-10-25" }),
        contact("mid", { lastTouchDate: "2026-10-10" }),
        contact("cool", { lastTouchDate: "2026-07-01" }),
        contact("pinned", { warmOverride: 90 }),
      ],
      connections: [
        cx("c1", ME_ID, "hot", { strength: 5 }),
        cx("c2", ME_ID, "mid", { strength: 4 }),
        cx("c3", ME_ID, "cool", { strength: 2, direction: "forward" }),
      ],
      opportunities: [{ id: "o1", name: "Deal", stage: "Proposal", estimatedValue: 1000 }],
      links: [{ kind: "contact", fromId: "hot", opportunityId: "o1" }],
      clients: new Map(),
      activity: new Map([
        ["hot", 6],
        ["c1", 2],
      ]),
      linkCounts: new Map([["hot", 3]]),
    });
    const by = new Map(g.nodes.map((n) => [n.id, n]));
    expect(by.get("hot")).toMatchObject({ warmBand: "inner", linkedObjects: 3 });
    expect(by.get("hot")!.warmScore).toBeGreaterThanOrEqual(70);
    expect(by.get("mid")!.warmBand).toBe("active");
    expect(by.get("cool")!.warmBand).toBe("dormant");
    expect(by.get("pinned")).toMatchObject({
      warmScore: 90,
      warmBand: "inner",
      warmOverridden: true,
      warmComputed: 0,
    });
    expect(g.stats.bands).toEqual({ inner: 2, active: 1, warmable: 0, dormant: 1 });
    expect(g.stats.avgWarm).toBe(
      Math.round(g.nodes.reduce((s, n) => s + n.warmScore, 0) / g.nodes.length),
    );
  });
});
