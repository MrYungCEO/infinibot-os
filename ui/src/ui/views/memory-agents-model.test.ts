import { describe, expect, it } from "vitest";

import { contentTabFor, matchRoute, resolveSubView, subViewsForHost } from "../navigation";
import {
  cellIntensity,
  domainMaxima,
  filterRoster,
  fleetSummary,
  formatAgo,
  formatCount,
  freshness,
  isRelevantEvent,
  mergeSources,
  shortModel,
  sortRoster,
  sortSources,
  type AgentKnowledgeProfile,
  type KnowledgeProfileResult,
  type KnowledgeSource,
} from "./memory-agents-model";

const NOW = 1_800_000_000_000;

function agent(id: string, over: Partial<AgentKnowledgeProfile> & { status?: string; last?: number | null; running?: number; unknown?: string[] } = {}): AgentKnowledgeProfile {
  return {
    id,
    name: over.name ?? id,
    isDefault: over.isDefault ?? false,
    department: over.department,
    matrix: over.matrix ?? {},
    capabilities: { model: { primary: `anthropic/${id}-model`, fallbacks: [] }, tools: { unknownAllowEntries: over.unknown ?? [] } },
    identity: { persona: {} },
    activity: { status: over.status ?? "idle", lastActiveAt: over.last ?? null, runningNow: over.running ?? 0 },
  } as unknown as AgentKnowledgeProfile;
}

describe("Memory host navigation", () => {
  it("Agents is the first (default) sub-tab, backed by the memory tab", () => {
    expect(subViewsForHost("memory").map((v) => v.id)).toEqual(["agents", "memory", "graph"]);
    expect(resolveSubView("memory", undefined)?.id).toBe("agents");
    expect(resolveSubView("memory", "memory")?.id).toBe("memory");
    expect(contentTabFor("memory", "agents")).toBe("memory");
    expect(matchRoute("/memory")).toEqual({ tab: "memory" });
    expect(matchRoute("/knowledge-graph")).toEqual({ tab: "memory", view: "graph" });
  });
});

describe("memory-agents model", () => {
  it("sorts running first, then recency, default on ties", () => {
    const list = [
      agent("a", { status: "idle", last: NOW - 5000 }),
      agent("b", { status: "running", last: NOW - 100000 }),
      agent("c", { status: "active", last: NOW - 10 }),
      agent("d", { status: "dormant", isDefault: true }),
      agent("e", { status: "dormant" }),
    ];
    expect(sortRoster(list).map((a) => a.id)).toEqual(["b", "c", "a", "d", "e"]);
  });

  it("filters by id, name, department or model", () => {
    const list = [agent("cmo", { name: "Chief Marketing", department: "Content" }), agent("coder")];
    expect(filterRoster(list, "market").map((a) => a.id)).toEqual(["cmo"]);
    expect(filterRoster(list, "content").map((a) => a.id)).toEqual(["cmo"]);
    expect(filterRoster(list, "coder-model").map((a) => a.id)).toEqual(["coder"]);
    expect(filterRoster(list, "  ")).toHaveLength(2);
  });

  it("shades matrix cells relative to the best agent per domain", () => {
    const result = {
      domains: ["Web", "Voice"],
      agents: [agent("a", { matrix: { Web: 2, Voice: 0 } }), agent("b", { matrix: { Web: 8 } })],
    } as unknown as KnowledgeProfileResult;
    const max = domainMaxima(result);
    expect(max).toEqual({ Web: 8, Voice: 0 });
    expect(cellIntensity(8, max.Web)).toBe(1);
    expect(cellIntensity(2, max.Web)).toBe(0.25);
    expect(cellIntensity(1, 100)).toBe(0.18); // floor keeps non-zero visible
    expect(cellIntensity(0, max.Voice)).toBe(0);
  });

  it("puts reachable sources first, then bigger ones", () => {
    const s = (id: string, reachable: boolean, count: number | null) => ({ id, reachable, count }) as KnowledgeSource;
    expect(sortSources([s("a", false, 900), s("b", true, 1), s("c", true, null), s("d", true, 50)]).map((x) => x.id)).toEqual([
      "d",
      "b",
      "c",
      "a",
    ]);
  });

  it("joins per-agent source state with the shared definitions", () => {
    const merged = mergeSources(
      [{ id: "notes", label: "Notes", description: "Shared notes", via: ["notes"], tab: "notes", note: "static" }],
      [
        { id: "notes", status: "ok", count: 3, lastUpdatedAt: null, reachable: true, grantedBy: ["notes"] },
        { id: "future", status: "ok", count: null, lastUpdatedAt: null, reachable: false, grantedBy: [] },
      ],
    );
    expect(merged[0]).toMatchObject({ label: "Notes", tab: "notes", count: 3, reachable: true, defNote: "static" });
    expect(merged[0].note).toBeUndefined();
    expect(merged[1]).toMatchObject({ label: "future", via: [], reachable: false });
  });

  it("summarises the fleet", () => {
    const result = {
      agents: [agent("a", { status: "running", running: 2 }), agent("b", { status: "active", unknown: ["web"] }), agent("c")],
    } as unknown as KnowledgeProfileResult;
    expect(fleetSummary(result)).toEqual({ agents: 3, running: 1, activeToday: 2, subagentsRunning: 2, misconfigured: 1 });
    expect(fleetSummary(null).agents).toBe(0);
  });

  it("formats numbers, times and models", () => {
    expect(formatCount(null)).toBe("—");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(4219)).toBe("4.2k");
    expect(formatCount(71286)).toBe("71k");
    expect(formatCount(4_708_357)).toBe("4.7M");
    expect(formatAgo(null, NOW)).toBe("never");
    expect(formatAgo(NOW - 10_000, NOW)).toBe("just now");
    expect(formatAgo(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(formatAgo(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(formatAgo(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");
    expect(freshness(NOW - 60_000, NOW)).toBe("live");
    expect(freshness(NOW - 86_400_000, NOW)).toBe("fresh");
    expect(freshness(NOW - 30 * 86_400_000, NOW)).toBe("stale");
    expect(freshness(null, NOW)).toBe("cold");
    expect(shortModel("ollama-cloud/gpt-oss:120b")).toBe("gpt-oss:120b");
    expect(shortModel(null)).toBe("default model");
  });

  it("refreshes on agent/session/knowledge events only", () => {
    for (const e of ["agent", "chat", "notes:changed", "kanban:changed", "subagent.complete", "sessions.changed", "agents.updated"])
      expect(isRelevantEvent(e), e).toBe(true);
    for (const e of ["health", "heartbeat", "tick", "voice.level"]) expect(isRelevantEvent(e), e).toBe(false);
  });
});
