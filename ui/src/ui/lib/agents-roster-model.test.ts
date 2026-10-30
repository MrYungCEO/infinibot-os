import { describe, expect, it } from "vitest";
import {
  activityScore,
  agentIdFromSessionKey,
  backendSpendRows,
  buildEdges,
  buildRoster,
  classifyAgent,
  clusterFor,
  computeAgentStats,
  computeKpis,
  deriveLiveState,
  deriveVirtualCoders,
  filterRoster,
  fmtPct,
  fmtUsd,
  mergeRuns,
  monogram,
  normalizeHistoryEntry,
  normalizeLiveRun,
  normalizeVerificationRecord,
  sortRoster,
  spendByAgent,
  startOfLocalDay,
  summarizeGroups,
  type RosterAgentInput,
  type RunLite,
} from "./agents-roster-model";

const NOW = new Date(2026, 8, 30, 15, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function run(p: Partial<RunLite> & { runId: string }): RunLite {
  const startedAt = "startedAt" in p ? p.startedAt! : NOW - HOUR;
  const endedAt = "endedAt" in p ? p.endedAt! : NOW - HOUR / 2;
  return {
    durationMs: startedAt !== null && endedAt !== null ? endedAt - startedAt : null,
    label: p.runId,
    task: "",
    agentId: "main",
    requesterAgentId: "main",
    backend: null,
    model: null,
    state: "verified",
    startedAt: NOW - HOUR,
    endedAt: NOW - HOUR / 2,
    source: "verification",
    ...p,
  };
}

const ROSTER: RosterAgentInput[] = [
  { id: "main", name: "INFINI", type: "native", model: "default", seedVersion: "agency-v12", subagents: ["head-of-dev", "cmo"] },
  { id: "head-of-dev", name: "HEAD-OF-DEV", type: "native", model: "default", seedVersion: "agency-v12" },
  { id: "cmo", name: "CMO", type: "native", model: "default", plugin: "content-studio", seedVersion: "content-studio:1" },
  { id: "scout", name: "SCOUT", type: "native", model: "default", plugin: "business-agency" },
  { id: "coder-codex", name: "CODEX", type: "cli", model: "", cliCommand: "codex", seedVersion: "agency-v12" },
  { id: "my-helper", name: "Helper", type: "native", model: "openai/gpt-5" },
];

describe("session keys and small helpers", () => {
  it("parses agent ids from session keys", () => {
    expect(agentIdFromSessionKey("agent:main:subagent:abc")).toBe("main");
    expect(agentIdFromSessionKey("agent:cmo:main")).toBe("cmo");
    expect(agentIdFromSessionKey("discord:group:req")).toBeNull();
    expect(agentIdFromSessionKey(undefined)).toBeNull();
  });
  it("builds monograms and formats", () => {
    expect(monogram("HEAD-OF-DEV")).toBe("HO");
    expect(monogram("Infinitrade Analyst")).toBe("IA");
    expect(monogram("CMO")).toBe("CM");
    expect(fmtPct(null)).toBe("—");
    expect(fmtPct(0.666)).toBe("67%");
    expect(fmtUsd(null)).toBe("—");
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(1.234)).toBe("$1.23");
  });
});

describe("run normalisation + merge", () => {
  it("normalises a verification record", () => {
    const r = normalizeVerificationRecord({
      runId: "r1",
      label: "Fix bug",
      childSessionKey: "agent:main:subagent:x",
      requesterSessionKey: "agent:cmo:main",
      backend: "codex",
      state: "verified",
      startedAt: 10,
      terminalAt: 20,
      review: { reasons: ["ok", 3] },
    })!;
    expect(r).toMatchObject({ agentId: "main", requesterAgentId: "cmo", backend: "codex", state: "verified", endedAt: 20 });
    expect(r.reasons).toEqual(["ok"]);
    expect(r.durationMs).toBeNull();
    const withAttempts = normalizeVerificationRecord({
      runId: "r2",
      state: "verified",
      startedAt: 0,
      terminalAt: 10 * DAY, // decided days later
      attempts: [{ startedAt: 0, endedAt: 60_000 }, { startedAt: 100_000, endedAt: 130_000 }, { startedAt: 200_000, endedAt: null }],
    })!;
    expect(withAttempts.durationMs).toBe(90_000);
    const swept = normalizeVerificationRecord({
      runId: "r3",
      state: "failed",
      attempts: [
        { startedAt: 0, endedAt: 4 * DAY, kind: "failed" }, // marked failed by a sweep days later
        { startedAt: 5 * DAY, endedAt: 5 * DAY + 60_000, kind: "interrupted" },
        { startedAt: 6 * DAY, endedAt: 6 * DAY + 30_000, kind: "failed" },
      ],
    })!;
    expect(swept.durationMs).toBe(30_000);
    expect(computeAgentStats([withAttempts], NOW).avgDurationMs).toBe(90_000);
    expect(normalizeVerificationRecord({})).toBeNull();
    expect(normalizeVerificationRecord({ runId: "x", state: "bogus" })!.state).toBe("running");
  });
  it("normalises history + live rows", () => {
    expect(normalizeHistoryEntry({ runId: "h", status: "complete", endedAt: 5 })!.state).toBe("complete");
    expect(normalizeHistoryEntry({ runId: "h", status: "timeout", endedAt: 5 })!.state).toBe("timeout");
    expect(normalizeHistoryEntry({ runId: "h", status: "error", error: "boom", endedAt: 5 })!.reasons).toEqual(["boom"]);
    const live = normalizeLiveRun({ runId: "l", sessionKey: "agent:qa:subagent:1", status: "working", progress: 40, createdAt: 3 })!;
    expect(live).toMatchObject({ agentId: "qa", state: "running", progress: 40, startedAt: 3 });
    expect(normalizeLiveRun({ runId: "l2", status: "completed", endedAt: 9 })!.state).toBe("complete");
  });
  it("prefers verification verdicts and keeps live progress", () => {
    const v = [run({ runId: "a", state: "running", progress: undefined })];
    const live = [run({ runId: "a", source: "live", state: "running", progress: 55, lastActivity: "editing", requesterAgentId: null })];
    const hist = [run({ runId: "b", source: "history", state: "complete" })];
    const merged = mergeRuns(v, hist, live);
    expect(merged).toHaveLength(2);
    const a = merged.find((r) => r.runId === "a")!;
    expect(a.source).toBe("verification");
    expect(a.progress).toBe(55);
    expect(a.lastActivity).toBe("editing");
    expect(a.requesterAgentId).toBe("main");
  });
});

describe("grouping (incl. plugin agents)", () => {
  it("classifies core, plugin, cli and gateway agents", () => {
    expect(classifyAgent(ROSTER[0]).kind).toBe("core");
    expect(classifyAgent(ROSTER[2])).toEqual({ kind: "plugin", key: "plugin:content-studio", label: "Content Studio" });
    expect(classifyAgent(ROSTER[3]).key).toBe("plugin:business-agency");
    expect(classifyAgent(ROSTER[4]).kind).toBe("cli");
    expect(classifyAgent(ROSTER[5]).kind).toBe("gateway");
  });
  it("clusters by plugin pack first, then department", () => {
    expect(clusterFor(ROSTER[2], { id: "cmo", department: "marketing" }).key).toBe("plugin:content-studio");
    expect(clusterFor(ROSTER[1], { id: "head-of-dev", department: "engineering" })).toEqual({ key: "team:engineering", label: "Engineering" });
    expect(clusterFor(ROSTER[5]).key).toBe("gateway");
  });
  it("derives virtual CLI coders only for backends without a configured CLI agent", () => {
    const runs = [run({ runId: "1", backend: "codex" }), run({ runId: "2", backend: "claude-code" }), run({ runId: "3", backend: "claude-code" })];
    const v = deriveVirtualCoders(ROSTER, runs);
    expect(v.map((x) => x.id)).toEqual(["cli:claude-code"]);
    expect(v[0].name).toBe("Claude Code");
  });
  it("summarises groups in rail order with plugin packs listed separately", () => {
    const views = buildRoster({ agents: ROSTER, runs: [], now: NOW });
    const groups = summarizeGroups(views);
    expect(groups.map((g) => g.key)).toEqual(["core", "plugin:business-agency", "plugin:content-studio", "cli", "gateway"]);
    expect(groups.find((g) => g.key === "core")!.count).toBe(2);
  });
});

describe("stats from verdicts and runs", () => {
  const runs: RunLite[] = [
    run({ runId: "v1", state: "verified", startedAt: NOW - HOUR, endedAt: NOW - HOUR + 60_000 }),
    run({ runId: "v2", state: "accepted", startedAt: NOW - 2 * HOUR, endedAt: NOW - 2 * HOUR + 180_000 }),
    run({ runId: "u1", state: "unverified", startedAt: NOW - 3 * HOUR, endedAt: NOW - 3 * HOUR + 120_000 }),
    run({ runId: "f1", state: "failed", startedAt: NOW - 2 * DAY, endedAt: NOW - 2 * DAY + 60_000 }),
    run({ runId: "c1", state: "complete", source: "history", startedAt: NOW - 3 * DAY, endedAt: NOW - 3 * DAY + 60_000 }),
    run({ runId: "r1", state: "running", startedAt: NOW - 5 * 60_000, endedAt: null }),
    run({ runId: "old", state: "verified", startedAt: NOW - 20 * DAY, endedAt: NOW - 20 * DAY + 1 }),
  ];
  it("computes success rate only from judged runs", () => {
    const s = computeAgentStats(runs, NOW);
    // judged: v1, v2, u1, f1, old = 5; verified+accepted = 3
    expect(s.judged).toBe(5);
    expect(s.successRate).toBeCloseTo(3 / 5);
    expect(s.verified).toBe(3);
    expect(s.unverified).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.running).toBe(1);
    expect(s.currentRun?.runId).toBe("r1");
  });
  it("counts runs today / 7d and buckets by day", () => {
    const s = computeAgentStats(runs, NOW);
    expect(s.runsToday).toBe(4); // v1 v2 u1 r1
    expect(s.runs7d).toBe(6);
    expect(s.runsByDay).toHaveLength(14);
    expect(s.runsByDay[13]).toBe(4);
    expect(s.runsByDay[11]).toBe(1);
    expect(s.runsByDay.reduce((a, b) => a + b, 0)).toBe(6); // "old" is outside the window
  });
  it("averages duration over ended runs and tracks the last verdict", () => {
    const s = computeAgentStats(runs, NOW);
    expect(s.avgDurationMs).toBeCloseTo((60_000 + 180_000 + 120_000 + 60_000 + 60_000 + 1) / 6);
    expect(s.lastVerdict).toBe("verified");
  });
  it("returns null rates with no data (never fabricated)", () => {
    const s = computeAgentStats([], NOW);
    expect(s.successRate).toBeNull();
    expect(s.avgDurationMs).toBeNull();
    expect(s.lastActiveAt).toBeNull();
  });
});

describe("live state", () => {
  const empty = computeAgentStats([], NOW);
  it("orders disabled > working > blocked/error > idle", () => {
    expect(deriveLiveState({ isDisabled: true, activeSessions: 3 }, empty, NOW)).toBe("disabled");
    expect(deriveLiveState({ activeSessions: 1 }, empty, NOW)).toBe("working");
    expect(deriveLiveState({ lastSessionAt: NOW - 30_000 }, empty, NOW)).toBe("working");
    const blocked = computeAgentStats([run({ runId: "b", state: "needs_input", endedAt: NOW - HOUR })], NOW);
    expect(deriveLiveState({}, blocked, NOW)).toBe("blocked");
    const failed = computeAgentStats([run({ runId: "f", state: "failed", endedAt: NOW - HOUR })], NOW);
    expect(deriveLiveState({}, failed, NOW)).toBe("error");
    const oldFail = computeAgentStats([run({ runId: "f", state: "failed", startedAt: NOW - 3 * DAY, endedAt: NOW - 3 * DAY })], NOW);
    expect(deriveLiveState({}, oldFail, NOW)).toBe("idle");
  });
});

describe("roster, attribution, KPIs and edges", () => {
  const runs: RunLite[] = [
    run({ runId: "a", agentId: "main", requesterAgentId: "main", backend: "codex", state: "verified" }),
    run({ runId: "b", agentId: "main", requesterAgentId: "main", backend: "claude-code", state: "failed" }),
    run({ runId: "c", agentId: "head-of-dev", requesterAgentId: "main", state: "running", endedAt: null }),
    run({ runId: "d", agentId: "cmo", requesterAgentId: "cmo", state: "verified", startedAt: NOW - 3 * DAY, endedAt: NOW - 3 * DAY }),
  ];
  const views = buildRoster({
    agents: ROSTER.map((a) => ({ ...a, activeSessionCount: 0, sessionCount: 0 })),
    runs,
    spendToday: [
      { key: "agent:main:main", tokens: 100, costUsd: 0.5, requests: 2 },
      { key: "agent:main:subagent:1", tokens: 50, costUsd: 0.25, requests: 1 },
      { key: "discord:group:x", tokens: 999, costUsd: 9, requests: 9 },
    ],
    profiles: [{ id: "main", description: "Chief of staff · routes work", department: "leadership" }],
    now: NOW,
  });
  const byId = new Map(views.map((v) => [v.id, v]));

  it("adds a virtual coder for claude-code and attributes executor runs to CLI agents", () => {
    expect(byId.has("cli:claude-code")).toBe(true);
    expect(byId.get("cli:claude-code")!.stats.runsTotal).toBe(1);
    expect(byId.get("coder-codex")!.stats.runsTotal).toBe(1);
    expect(byId.get("main")!.stats.runsTotal).toBe(2);
    expect(byId.get("head-of-dev")!.state).toBe("working");
  });
  it("uses the profile description head as the role", () => {
    expect(byId.get("main")!.role).toBe("Chief of staff");
    expect(byId.get("main")!.cluster.label).toBe("Leadership");
  });
  it("falls back to per-backend spend for CLI coders", () => {
    const rows = backendSpendRows([{ agentBackend: "codex", tokensIn: 10, tokensOut: 5, costUsd: 0.2, requests: 1 }, { tokensIn: 1 }]);
    expect(rows).toEqual([{ key: "codex", tokens: 15, costUsd: 0.2, requests: 1 }]);
    const v = buildRoster({ agents: ROSTER, runs, spendByBackend: rows, now: NOW });
    expect(v.find((x) => x.id === "coder-codex")!.spendToday).toMatchObject({ costUsd: 0.2 });
    expect(v.find((x) => x.id === "my-helper")!.spendToday).toBeNull();
  });
  it("sums spend per agent from session-keyed credits", () => {
    expect(byId.get("main")!.spendToday).toMatchObject({ tokens: 150, costUsd: 0.75, requests: 3 });
    expect(byId.get("cmo")!.spendToday).toBeNull();
    expect(spendByAgent([{ key: "x", tokens: 1, costUsd: 1, requests: 1 }]).size).toBe(0);
  });
  it("computes KPIs from distinct runs", () => {
    const k = computeKpis(views, runs, NOW, { costUsd: 1.5, tokens: 1000 });
    expect(k.activeNow).toBe(1);
    expect(k.runsToday).toBe(3);
    expect(k.judgedToday).toBe(2);
    expect(k.verifiedPct).toBeCloseTo(0.5);
    expect(k.spendToday).toBe(1.5);
    expect(computeKpis(views, [], NOW).verifiedPct).toBeNull();
    expect(computeKpis(views, [], NOW).spendToday).toBeNull();
  });
  it("builds delegation edges from runs and config", () => {
    const edges = buildEdges(views, runs, NOW);
    const key = (e: { from: string; to: string }) => `${e.from}→${e.to}`;
    const keys = edges.map(key);
    expect(keys).toContain("main→coder-codex");
    expect(keys).toContain("main→cli:claude-code");
    expect(keys).toContain("main→head-of-dev");
    const hod = edges.find((e) => key(e) === "main→head-of-dev")!;
    expect(hod.kind).toBe("delegation");
    expect(hod.recent).toBe(true);
    const cfg = edges.find((e) => key(e) === "main→cmo")!;
    expect(cfg.kind).toBe("can-delegate");
    expect(cfg.weight).toBe(0);
    // No self-edges for cmo's self-requested run.
    expect(keys).not.toContain("cmo→cmo");
  });
  it("filters and sorts the roster", () => {
    expect(filterRoster(views, { group: "kind:plugin", state: "all", query: "" }).map((v) => v.id).sort()).toEqual(["cmo", "scout"]);
    expect(filterRoster(views, { group: "all", state: "working", query: "" }).map((v) => v.id)).toEqual(["head-of-dev"]);
    expect(filterRoster(views, { group: "all", state: "all", query: "content studio" }).map((v) => v.id)).toEqual(["cmo"]);
    expect(sortRoster(views)[0].id).toBe("head-of-dev");
    expect(activityScore(byId.get("head-of-dev")!)).toBeGreaterThan(activityScore(byId.get("scout")!));
  });
  it("uses local midnight for 'today'", () => {
    expect(new Date(startOfLocalDay(NOW)).getHours()).toBe(0);
  });
});
