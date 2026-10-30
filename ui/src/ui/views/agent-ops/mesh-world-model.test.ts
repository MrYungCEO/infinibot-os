import { describe, expect, it } from "vitest";
import type { MeshAgent, MeshNode } from "./activity-map";
import { MAX_RESTING_COMPLETED } from "./resting-completed";
import { BED_SLOTS, DISTRICT_PLANS, MeshWorldModel, agentActivity, agentVisualState, deskSeats, propsFor, type MeshWorldEvent } from "./mesh-world-model";
import { SECTORS } from "./iso/sector-defs";

const local: MeshNode = { id: "local", name: "Local", role: "hub", status: "online", agentCount: 0 };
const sat: MeshNode = { id: "sat-1", name: "Laptop", role: "satellite", status: "online", agentCount: 0 };

function agent(i: number, patch: Partial<MeshAgent> = {}): MeshAgent {
  return {
    sessionKey: `agent:main:s${i}`,
    agentId: "main",
    label: `Agent ${i}`,
    nodeId: "local",
    status: "working",
    progress: 0.3,
    ...patch,
  };
}

const plugins = [
  {
    id: "flypic",
    name: "FlyPic",
    status: "loaded",
    enabled: true,
    manifestVersion: 2,
    contributes: { pages: [{ tab: "flypic", route: "/flypic" }], tools: ["flypic_generate_image"], mapRoom: { theme: "media-studio" } },
  },
  {
    id: "robovoice",
    name: "Robovoice",
    status: "loaded",
    enabled: true,
    manifestVersion: 2,
    contributes: { pages: [{ tab: "robovoice", route: "/robovoice" }], tools: ["robovoice_call"], mapRoom: { theme: "voice-studio" } },
  },
];

function model(now = { t: 1_000_000 }) {
  const m = new MeshWorldModel(() => now.t);
  return { m, now };
}

describe("agentVisualState", () => {
  it("maps gateway statuses onto the five visual states", () => {
    expect(agentVisualState("working")).toBe("working");
    expect(agentVisualState("starting")).toBe("working");
    expect(agentVisualState("blocked")).toBe("waiting");
    expect(agentVisualState("failed")).toBe("error");
    expect(agentVisualState("completed")).toBe("done");
    expect(agentVisualState("idle")).toBe("idle");
    expect(agentVisualState(undefined)).toBe("idle");
  });
});

describe("MeshWorldModel", () => {
  it("drops agents whose node is unknown, like ActivityMap.addAgent", () => {
    const { m } = model();
    m.apply([{ kind: "agent.spawn", agent: agent(1) }]);
    expect(m.counts().agents).toBe(0);
    m.apply([{ kind: "node.upsert", node: local }, { kind: "agent.spawn", agent: agent(1) }]);
    expect(m.counts().agents).toBe(1);
  });

  it("keeps finished runs resting and evicts the oldest past MAX_RESTING_COMPLETED", () => {
    const { m, now } = model();
    const evs: MeshWorldEvent[] = [{ kind: "node.upsert", node: local }];
    for (let i = 0; i < MAX_RESTING_COMPLETED + 3; i++) evs.push({ kind: "agent.spawn", agent: agent(i) });
    m.apply(evs);
    for (let i = 0; i < MAX_RESTING_COMPLETED + 3; i++) {
      now.t += 10;
      m.apply([{ kind: "agent.complete", sessionKey: agent(i).sessionKey, success: i % 2 === 0 }]);
    }
    const c = m.counts();
    expect(c.agents).toBe(MAX_RESTING_COMPLETED);
    expect(c.resting).toBe(MAX_RESTING_COMPLETED);
    // Oldest three departed.
    expect(m.agents.has(agent(0).sessionKey)).toBe(false);
    expect(m.agents.has(agent(MAX_RESTING_COMPLETED + 2).sessionKey)).toBe(true);
  });

  it("agent.leave and node.remove take agents off the map", () => {
    const { m } = model();
    m.apply([
      { kind: "node.upsert", node: local },
      { kind: "node.upsert", node: sat },
      { kind: "agent.spawn", agent: agent(1) },
      { kind: "agent.spawn", agent: agent(2, { nodeId: "sat-1" }) },
    ]);
    expect(m.counts().agents).toBe(2);
    m.apply([{ kind: "agent.leave", sessionKey: agent(1).sessionKey }]);
    m.apply([{ kind: "node.remove", nodeId: "sat-1" }]);
    expect(m.counts().agents).toBe(0);
    expect(m.counts().nodes).toBe(1);
  });

  it("lays out every agent once: desks for working, beds for finished, islands for remote", () => {
    const { m } = model();
    const evs: MeshWorldEvent[] = [
      { kind: "node.upsert", node: local },
      { kind: "node.upsert", node: sat },
    ];
    for (let i = 0; i < 100; i++) evs.push({ kind: "agent.spawn", agent: agent(i, { nodeId: i % 10 === 0 ? "sat-1" : "local" }) });
    m.apply(evs);
    m.apply([{ kind: "agent.complete", sessionKey: agent(1).sessionKey, success: true }]);
    const l = m.layout();
    expect(l.agents).toHaveLength(100);
    expect(new Set(l.agents.map((a) => a.key)).size).toBe(100);
    const done = l.agents.find((a) => a.key === agent(1).sessionKey)!;
    expect(done.where).toBe("bed");
    expect(done.state).toBe("done");
    expect(done).toMatchObject(BED_SLOTS[0]);
    expect(l.agents.filter((a) => a.where === "island")).toHaveLength(10);
    expect(l.zones.some((z) => z.id === "node:sat-1" && z.kind === "island")).toBe(true);
    for (const a of l.agents) {
      expect(Number.isFinite(a.c)).toBe(true);
      expect(Number.isFinite(a.r)).toBe(true);
    }
    // Zone occupancy sums to the agent count.
    expect(l.zones.reduce((s, z) => s + z.occupants, 0)).toBe(100);
  });

  it("routes an agent using a plugin's tool into that plugin's room", () => {
    const { m } = model();
    m.setPluginItems(plugins);
    expect(m.counts().plugins).toBe(2);
    m.apply([{ kind: "node.upsert", node: local }, { kind: "agent.spawn", agent: agent(1) }]);
    m.apply([{ kind: "agent.tool", sessionKey: agent(1).sessionKey, tool: { kind: "flypic_generate_image", label: "FlyPic: hero" } }]);
    const l = m.layout();
    const a = l.agents[0];
    expect(a.zoneId).toBe("plugin:flypic");
    const room = l.zones.find((z) => z.id === "plugin:flypic")!;
    expect(room.kind).toBe("plugin");
    expect(a.c).toBeGreaterThanOrEqual(room.c);
    expect(a.c).toBeLessThanOrEqual(room.c + room.w);
    expect(l.links.some((k) => k.zoneId === "plugin:flypic" && k.kind === "conduit")).toBe(true);
  });

  it("plugin rooms are sticky across plugin list refreshes", () => {
    const { m } = model();
    m.setPluginItems(plugins);
    const before = m.layout().zones.find((z) => z.id === "plugin:robovoice")!;
    m.setPluginItems([...plugins].reverse());
    const after = m.layout().zones.find((z) => z.id === "plugin:robovoice")!;
    expect({ c: after.c, r: after.r }).toEqual({ c: before.c, r: before.r });
  });

  it("records effects for spawn / tool / message / complete and serves them incrementally", () => {
    const { m } = model();
    m.apply([{ kind: "node.upsert", node: local }, { kind: "agent.spawn", agent: agent(1) }]);
    const first = m.effectsSince(0);
    expect(first.map((e) => e.kind)).toEqual(["spawn"]);
    m.apply([
      { kind: "agent.tool", sessionKey: agent(1).sessionKey, tool: { kind: "bash", label: "Bash: ls" } },
      { kind: "agent.message", from: agent(1).sessionKey, to: "agent:main:main", type: "request" },
      { kind: "agent.complete", sessionKey: agent(1).sessionKey, success: true },
    ]);
    expect(m.effectsSince(first[0].id).map((e) => e.kind)).toEqual(["tool", "message", "complete"]);
  });

  it("loadSnapshot reproduces the same counts and layout as the event path", () => {
    const { m } = model();
    const agents = Array.from({ length: 50 }, (_, i) => agent(i, { status: i % 7 === 0 ? "completed" : "working", endedAt: i }));
    m.apply([{ kind: "node.upsert", node: local }, ...agents.map((a) => ({ kind: "agent.spawn", agent: a }) as MeshWorldEvent)]);
    m.setPluginItems(plugins);
    const { m: m2 } = model();
    m2.loadSnapshot({ nodes: [local], agents, plugins });
    expect(m2.counts()).toEqual(m.counts());
    const k1 = m.layout().agents.map((a) => `${a.key}@${a.zoneId}`).sort();
    const k2 = m2.layout().agents.map((a) => `${a.key}@${a.zoneId}`).sort();
    expect(k2).toEqual(k1);
  });

  it("notifies subscribers and bumps the version on change", () => {
    const { m } = model();
    let calls = 0;
    const off = m.subscribe(() => calls++);
    const v = m.version;
    m.apply([{ kind: "node.upsert", node: local }]);
    off();
    m.apply([{ kind: "node.upsert", node: sat }]);
    expect(calls).toBe(1);
    expect(m.version).toBe(v + 2);
  });
});

describe("agentActivity", () => {
  const agent = { sessionKey: "a", label: "A", agentId: "a", nodeId: "local", status: "working" } as unknown as MeshAgent;
  const at = 1_000_000;
  it("maps resting / problem states straight from the visual state", () => {
    expect(agentActivity({ state: "error", agent }, at)).toBe("error");
    expect(agentActivity({ state: "done", agent }, at)).toBe("rest");
    expect(agentActivity({ state: "waiting", agent }, at)).toBe("wait");
    expect(agentActivity({ state: "idle", agent }, at)).toBe("idle");
  });
  it("working agents type, think or talk by their live tool", () => {
    const tool = (kind: string, ago = 0) => ({ kind, label: kind, at: at - ago });
    expect(agentActivity({ state: "working", agent, tool: tool("Bash") }, at)).toBe("type");
    expect(agentActivity({ state: "working", agent, tool: tool("Edit") }, at)).toBe("type");
    expect(agentActivity({ state: "working", agent, tool: tool("TodoWrite") }, at)).toBe("think");
    expect(agentActivity({ state: "working", agent, tool: tool("telegram_send") }, at)).toBe("talk");
    expect(agentActivity({ state: "working", agent, tool: tool("sessions_spawn") }, at)).toBe("talk");
    // Between tool calls (or the signal expired): thinking.
    expect(agentActivity({ state: "working", agent }, at)).toBe("think");
    expect(agentActivity({ state: "working", agent, tool: tool("Bash", 60_000) }, at)).toBe("think");
  });
});

describe("deskSeats", () => {
  it("every district has a few explicit workstations, seated inside the room and clear of its centerpiece", () => {
    for (const sec of SECTORS) {
      const seats = deskSeats("core", sec.w, sec.h, sec.id);
      expect(DISTRICT_PLANS[sec.id]).toBeTruthy();
      expect(seats.length).toBeGreaterThanOrEqual(2);
      expect(seats.length).toBeLessThanOrEqual(5);
      const blocks = propsFor("core", sec.w, sec.h, sec.id).filter((p) => p.t === "block");
      for (const s of seats) {
        expect(s.seat).not.toBeNull();
        expect(s.seat!.c).toBeGreaterThan(0.5);
        expect(s.seat!.r).toBeGreaterThan(0.5);
        expect(s.seat!.c).toBeLessThan(sec.w - 0.5);
        expect(s.seat!.r).toBeLessThan(sec.h - 0.5);
        for (const b of blocks) expect(Math.hypot(b.c - s.seat!.c, b.r - s.seat!.r)).toBeGreaterThan(0.3);
      }
    }
  });

  it("districts differ: no two share the same workstation layout", () => {
    const sigs = SECTORS.map((sec) => JSON.stringify(deskSeats("core", sec.w, sec.h, sec.id)));
    expect(new Set(sigs).size).toBe(SECTORS.length);
  });

  it("plugin rooms keep two or three workstations facing the building", () => {
    for (const w of [6, 8, 10]) {
      const seats = deskSeats("plugin", w, w);
      expect(seats.length).toBe(w >= 10 ? 3 : 2);
      for (const s of seats) expect(s.seat!.r).toBeGreaterThan(s.desk.r);
    }
  });
});
