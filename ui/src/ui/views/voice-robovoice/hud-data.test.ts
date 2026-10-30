import { describe, expect, it } from "vitest";
import {
  askAboutProjectPrompt,
  callStatus,
  compactSpan,
  relTime,
  shapeAgents,
  shapeAttention,
  shapeCompletions,
  shapeSystem,
  shapeToday,
  uptimeText,
  type HudCallInput,
} from "./hud-data.js";

const NOW = new Date(2026, 9, 13, 12, 0, 0).getTime();

describe("formatting", () => {
  it("compactSpan / relTime", () => {
    expect(compactSpan(3_000)).toBe("now");
    expect(compactSpan(45_000)).toBe("45s");
    expect(compactSpan(12 * 60_000)).toBe("12m");
    expect(compactSpan(3 * 3_600_000)).toBe("3h");
    expect(compactSpan(3 * 86_400_000)).toBe("3d");
    expect(relTime(NOW + 2 * 3_600_000, NOW)).toBe("in 2h");
    expect(relTime(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(relTime(NOW, NOW)).toBe("now");
  });
  it("uptimeText", () => {
    expect(uptimeText(6015)).toBe("1h 40m");
    expect(uptimeText(59)).toBe("0m");
    expect(uptimeText(3 * 86400 + 7200)).toBe("3d 2h");
    expect(uptimeText(null)).toBe("—");
  });
});

describe("shapeAgents (subagents.list)", () => {
  const rows = {
    ok: true,
    subagents: [
      { runId: "a", sessionKey: "s:a", label: "Older worker", status: "working", progress: 40, createdAt: NOW - 600_000, lastActivity: { kind: "Bash", label: "Bash: pnpm build", at: NOW - 60_000, coderBackend: "claude-code" } },
      { runId: "b", sessionKey: "s:b", label: "Newer worker", status: "running", createdAt: NOW - 60_000, lastUpdateAt: NOW - 5_000 },
      { runId: "c", label: "Stuck", status: "blocked", createdAt: NOW - 900_000, lastUpdateAt: NOW - 800_000 },
      { runId: "d", label: "Done", status: "completed", endedAt: NOW - 1000 },
      { runId: "e", label: "Ended but status stale", status: "working", endedAt: NOW - 1000 },
      { label: "no run id", status: "working" },
    ],
  };
  it("keeps active runs only, blocked first then most recent activity", () => {
    const out = shapeAgents(rows);
    expect(out.map((a) => a.runId)).toEqual(["c", "b", "a"]);
    expect(out[0].status).toBe("blocked");
    expect(out[0].sessionKey).toBe("c"); // falls back to runId
    expect(out[2]).toMatchObject({ activity: "Bash: pnpm build", backend: "claude-code", progress: 40, startedAt: NOW - 600_000 });
  });
  it("tolerates bare arrays and garbage", () => {
    expect(shapeAgents([{ runId: "x", status: "starting" }])[0].status).toBe("starting");
    expect(shapeAgents(null)).toEqual([]);
    expect(shapeAgents({ items: "nope" })).toEqual([]);
  });
});

describe("shapeCompletions (verification.list)", () => {
  const raw = {
    records: [
      { runId: "r1", label: "Fix voice", state: "verified", terminalAt: NOW - 60_000, startedAt: NOW - 600_000, result: { summary: "Merged and deployed live." } },
      { runId: "r2", label: "Gateway change", state: "unverified", terminalAt: NOW - 120_000, result: { summary: "Done. Gateway restart pending to load the new handler." } },
      { runId: "r3", label: "Still running", state: "running", updatedAt: NOW },
      { runId: "r4", label: "Ancient", state: "failed", terminalAt: NOW - 3 * 86_400_000 },
    ],
  };
  it("returns recent terminal runs with verdict + deploy text, and the restart-pending subset", () => {
    const { recent, restartPending } = shapeCompletions(raw, NOW);
    expect(recent.map((r) => r.runId)).toEqual(["r1", "r2"]);
    expect(recent[0]).toMatchObject({ verdictText: "Verified", tone: "ok", deployText: "Live" });
    expect(recent[1]).toMatchObject({ verdictText: "Unverified", tone: "warn", deployText: "Restart pending" });
    expect(restartPending.map((r) => r.runId)).toEqual(["r2"]);
  });
  it("empty / malformed input", () => {
    expect(shapeCompletions(undefined, NOW)).toEqual({ recent: [], restartPending: [] });
  });
});

describe("shapeToday", () => {
  const iso = (h: number, m = 0) => new Date(2026, 9, 13, h, m).toISOString();
  it("merges remaining events, scheduled runs within 24h and proactive tasks", () => {
    const model = shapeToday({
      now: NOW,
      calendar: {
        events: [
          { id: "past", summary: "Standup", startIso: iso(9), endIso: iso(9, 30) },
          { id: "now", summary: "Design review", startIso: iso(11, 45), endIso: iso(12, 30) },
          { id: "later", summary: "Client call", startIso: iso(15), endIso: iso(16) },
          { id: "gone", summary: "Deleted", startIso: iso(16), deletedAtMs: 1 },
        ],
      },
      scheduled: {
        tasks: [
          { id: "st1", name: "Daily review", enabled: true, nextRunAt: NOW + 5 * 3_600_000, counts: { awaitingDecision: 7 } },
          { id: "st2", name: "Weekly", enabled: true, nextRunAt: NOW + 3 * 86_400_000, counts: { awaitingDecision: 2 } },
          { id: "st3", name: "Disabled", enabled: false, nextRunAt: NOW + 3_600_000 },
        ],
      },
      proactive: {
        active: { taskId: "t0", title: "Ship HUD", remainingMin: 18 },
        candidates: [
          { taskId: "t1", projectId: "p1", title: "Fix login", projectName: "Cloud", dueLabel: "overdue", priorityTag: "P0" },
          { taskId: "t2", title: "Write docs", reason: "drifting" },
        ],
        summary: { overdue: 1, p0Tasks: 2, openTasks: 40 },
      },
    });
    expect(model.items.map((i) => i.id)).toEqual(["focus:t0", "ev:now", "ev:later", "st:st1", "next:t1", "next:t2"]);
    expect(model.items[0].detail).toBe("focus block · 18m left");
    expect(model.items[1].when).toBe("NOW");
    expect(model.items[4]).toMatchObject({ when: "OVERDUE", tone: "bad", detail: "Cloud · P0" });
    expect(model.items[5].detail).toBe("drifting");
    expect(model).toMatchObject({ overdue: 1, p0: 2, openTasks: 40, awaitingDecision: 9 });
  });
  it("is empty without data", () => {
    expect(shapeToday({ now: NOW })).toEqual({ items: [], overdue: 0, p0: 0, openTasks: null, awaitingDecision: 0 });
  });
});

describe("shapeAttention (proactive.state)", () => {
  it("dedupes, drops healthy projects and sorts worst first", () => {
    const out = shapeAttention({
      driftRadar: [
        { projectId: "p1", name: "Mobile Studio", state: "drifting", driftScore: 100, daysSinceActivity: 117, progress: 0 },
      ],
      focused: [
        { projectId: "p1", name: "dup", state: "drifting" },
        { projectId: "p2", name: "On track", state: "ontrack" },
      ],
      extras: [
        { projectId: "p3", name: "Cloud release", state: "watch", driftScore: 70, daysSinceActivity: 5, topBlocker: "registry fallback" },
        { projectId: "p4", name: "Billing", state: "blocked", topBlocker: "waiting on Stripe" },
      ],
    });
    expect(out.map((p) => p.projectId)).toEqual(["p4", "p1", "p3"]);
    expect(out[0]).toMatchObject({ state: "blocked", tone: "bad", reason: "Next: waiting on Stripe" });
    expect(out[1]).toMatchObject({ reason: "No progress · idle 117d", tone: "warn" });
    expect(askAboutProjectPrompt(out[2])).toContain('"Cloud release"');
  });
});

describe("shapeSystem", () => {
  it("reads the local node meters, version and Notion state", () => {
    const sys = shapeSystem({
      connected: true,
      version: { info: { version: "2026.6.30", uptime: 6015, hostname: "box" } },
      hardware: {
        nodes: [
          { nodeId: "sat", nodeName: "Satellite", isLocal: false, online: false, snapshot: null },
          { nodeId: "m", nodeName: "Master", isLocal: true, online: true, snapshot: { cpu: { percent: 91.4 }, memory: { percent: 42 }, gpu: { utilizationPercent: 77 } } },
        ],
      },
      notion: { state: "ok", pending: 3, needsAttention: 0 },
    });
    expect(sys).toMatchObject({ version: "2026.6.30", uptime: "1h 40m", host: "Master", nodes: { online: 1, total: 2 } });
    expect(sys.meters).toEqual([
      { label: "CPU", pct: 91, tone: "bad" },
      { label: "RAM", pct: 42, tone: "ok" },
      { label: "GPU", pct: 77, tone: "warn" },
    ]);
    expect(sys.notion).toEqual({ state: "ok", text: "3 pending", tone: "warn" });
  });
  it("degrades without data", () => {
    const sys = shapeSystem({ connected: false });
    expect(sys).toMatchObject({ gateway: { ok: false }, version: null, meters: [], notion: null, uptime: "—" });
  });
});

describe("callStatus", () => {
  const base: HudCallInput = { phase: "idle", engine: "local", mode: null, agentName: "Infini", voiceRoute: "claude_code", muted: false, agentState: null, blockedReason: null, error: null };
  it("labels engine, route and state", () => {
    expect(callStatus(base)).toEqual({ label: "Ready", tone: "muted", engine: "Local voice", route: "Claude Code CLI" });
    expect(callStatus({ ...base, phase: "active", agentState: "thinking" }).label).toBe("Thinking");
    expect(callStatus({ ...base, phase: "active", muted: true, agentState: "speaking" }).label).toBe("Muted");
    expect(callStatus({ ...base, engine: "robovoice", mode: "cloud", phase: "connecting" })).toMatchObject({ label: "Connecting", engine: "Robovoice cloud", route: "Robovoice agent" });
    expect(callStatus({ ...base, blockedReason: "No credits" })).toMatchObject({ label: "Can't call", tone: "warn" });
    expect(callStatus({ ...base, phase: "failed" }).tone).toBe("bad");
  });
});
