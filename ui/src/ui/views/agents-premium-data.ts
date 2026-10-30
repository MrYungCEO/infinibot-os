/**
 * Live data for the Agents page: loads the run/verdict/usage/profile sources
 * the roster model joins, keeps them fresh from gateway events plus a slow
 * poll, and keeps a short in-memory activity log per agent (for the Logs /
 * Overview tabs and constellation pulses).
 *
 * Read-only: every call here is a list/get/summary RPC.
 */

import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway";
import {
  agentIdFromSessionKey,
  backendSpendRows,
  mergeRuns,
  normalizeHistoryEntry,
  normalizeLiveRun,
  normalizeVerificationRecord,
  type AgentProfileLite,
  type RunLite,
  type SpendRow,
} from "../lib/agents-roster-model";

export interface ActivityEntry {
  ts: number;
  agentId: string;
  kind: "spawn" | "complete" | "error" | "tool" | "message" | "checkpoint" | "lifecycle";
  text: string;
  runId?: string;
}

export interface LiveRunDetail {
  runId: string;
  progress: number | null;
  lastActivity: string | null;
  checkpoint: string | null;
  updates: Array<{ ts: number; text: string }>;
}

type Source = "verification" | "history" | "live" | "profiles" | "spend";

export interface AgentsLiveState {
  loading: boolean;
  loadedAt: number | null;
  runs: RunLite[];
  liveDetails: Map<string, LiveRunDetail>;
  profiles: AgentProfileLite[];
  /** Full agents.knowledge.profile rows keyed by agent id (Memory / Channels / Tools tabs). */
  profileRaw: Map<string, Record<string, unknown>>;
  spendRows: SpendRow[];
  spendToday: { costUsd: number | null; tokens: number | null };
  spendWeek: SpendRow[];
  /** Spend per CLI backend (credits byBackend), today / last 7 days. */
  backendDay: SpendRow[];
  backendWeek: SpendRow[];
  /** Sources that failed on the last load (rendered as "unavailable", never faked). */
  sourceErrors: Partial<Record<Source, string>>;
  activity: ActivityEntry[];
}

export const agentsLive: AgentsLiveState = {
  loading: false,
  loadedAt: null,
  runs: [],
  liveDetails: new Map(),
  profiles: [],
  profileRaw: new Map(),
  spendRows: [],
  spendToday: { costUsd: null, tokens: null },
  spendWeek: [],
  backendDay: [],
  backendWeek: [],
  sourceErrors: {},
  activity: [],
};

const HISTORY_WINDOW_MS = 14 * 86_400_000;
const FAST_POLL_MS = 15_000;
const FULL_POLL_MS = 60_000;
const EVENT_DEBOUNCE_MS = 2_000;
const MAX_ACTIVITY = 400;

export type PulseFn = (from: string | null, to: string, kind: "message" | "spawn" | "complete") => void;

let pulseListener: PulseFn | null = null;
let onChange: (() => void) | null = null;
let unsub: (() => void) | null = null;
let fastTimer: ReturnType<typeof setInterval> | null = null;
let fullTimer: ReturnType<typeof setInterval> | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
let activeClient: GatewayBrowserClient | null = null;
let raw = { verification: [] as RunLite[], history: [] as RunLite[], live: [] as RunLite[] };
const lastPing = new Map<string, number>();

export function setPulseListener(fn: PulseFn | null) {
  pulseListener = fn;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function rebuildRuns() {
  agentsLive.runs = mergeRuns(raw.verification, raw.history, raw.live);
}

async function loadRuns(client: GatewayBrowserClient) {
  const since = Date.now() - HISTORY_WINDOW_MS;
  const [ver, hist, live] = await Promise.allSettled([
    client.request("verification.list", { limit: 500 }),
    client.request("subagents.history", { limit: 500, since }),
    client.request("subagents.list", { limit: 100, updatesTail: 5 }),
  ]);
  const errs = agentsLive.sourceErrors;
  if (ver.status === "fulfilled") {
    const recs = ((ver.value as { records?: unknown[] })?.records ?? []) as Record<string, unknown>[];
    raw.verification = recs.map(normalizeVerificationRecord).filter((r): r is RunLite => !!r);
    delete errs.verification;
  } else errs.verification = errMsg(ver.reason);
  if (hist.status === "fulfilled") {
    const rows = ((hist.value as { history?: unknown[] })?.history ?? []) as Record<string, unknown>[];
    raw.history = rows.map(normalizeHistoryEntry).filter((r): r is RunLite => !!r);
    delete errs.history;
  } else errs.history = errMsg(hist.reason);
  if (live.status === "fulfilled") {
    const rows = ((live.value as { subagents?: unknown[] })?.subagents ?? []) as Record<string, unknown>[];
    raw.live = rows.map(normalizeLiveRun).filter((r): r is RunLite => !!r);
    const details = new Map<string, LiveRunDetail>();
    for (const s of rows) {
      const runId = typeof s.runId === "string" ? s.runId : "";
      if (!runId) continue;
      const updates = Array.isArray(s.recentUpdates)
        ? (s.recentUpdates as Array<Record<string, unknown>>)
            .map((u) => ({
              ts: typeof u.ts === "number" ? u.ts : typeof u.timestamp === "number" ? u.timestamp : 0,
              text: String(u.message ?? u.text ?? u.summary ?? ""),
            }))
            .filter((u) => u.text)
        : [];
      const cp = s.currentCheckpoint as { name?: unknown; label?: unknown } | string | undefined;
      details.set(runId, {
        runId,
        progress: typeof s.progress === "number" ? s.progress : null,
        lastActivity: typeof s.lastActivity === "string" ? s.lastActivity : null,
        checkpoint: typeof cp === "string" ? cp : cp ? String(cp.name ?? cp.label ?? "") || null : null,
        updates,
      });
    }
    agentsLive.liveDetails = details;
    delete errs.live;
  } else errs.live = errMsg(live.reason);
  rebuildRuns();
}

async function loadSlow(client: GatewayBrowserClient) {
  const [prof, top, sum, week, sumWeek] = await Promise.allSettled([
    client.request("agents.knowledge.profile", {}),
    client.request("credits.top", { axis: "session_key", period: "day", limit: 100 }),
    client.request("credits.summary", { period: "day" }),
    client.request("credits.top", { axis: "session_key", period: "week", limit: 100 }),
    client.request("credits.summary", { period: "week" }),
  ]);
  const errs = agentsLive.sourceErrors;
  if (prof.status === "fulfilled") {
    const agents = ((prof.value as { agents?: unknown[] })?.agents ?? []) as Record<string, unknown>[];
    const map = new Map<string, Record<string, unknown>>();
    agentsLive.profiles = agents.map((a) => {
      map.set(String(a.id), a);
      const caps = (a.capabilities ?? {}) as { model?: { primary?: string | null }; backend?: { primary?: string } };
      const act = (a.activity ?? {}) as { lastActiveAt?: number | null };
      return {
        id: String(a.id),
        department: (a.department as string) ?? null,
        description: (a.description as string) ?? null,
        emoji: (a.emoji as string) ?? null,
        modelPrimary: caps.model?.primary ?? null,
        backendPrimary: caps.backend?.primary ?? null,
        lastActiveAt: typeof act.lastActiveAt === "number" ? act.lastActiveAt : null,
      };
    });
    agentsLive.profileRaw = map;
    delete errs.profiles;
  } else errs.profiles = errMsg(prof.reason);
  if (top.status === "fulfilled" && Array.isArray(top.value)) {
    agentsLive.spendRows = top.value as SpendRow[];
    delete errs.spend;
  } else if (top.status === "rejected") errs.spend = errMsg(top.reason);
  if (week.status === "fulfilled" && Array.isArray(week.value)) agentsLive.spendWeek = week.value as SpendRow[];
  if (sumWeek.status === "fulfilled" && sumWeek.value) {
    agentsLive.backendWeek = backendSpendRows((sumWeek.value as { byBackend?: [] }).byBackend);
  }
  if (sum.status === "fulfilled" && sum.value) {
    const s = sum.value as { totalCostUsd?: number; totalTokensIn?: number; totalTokensOut?: number; byBackend?: [] };
    agentsLive.backendDay = backendSpendRows(s.byBackend);
    agentsLive.spendToday = {
      costUsd: typeof s.totalCostUsd === "number" ? s.totalCostUsd : null,
      tokens:
        typeof s.totalTokensIn === "number" || typeof s.totalTokensOut === "number"
          ? (s.totalTokensIn ?? 0) + (s.totalTokensOut ?? 0)
          : null,
    };
  } else {
    agentsLive.spendToday = { costUsd: null, tokens: null };
  }
}

export async function loadAgentsLive(client: GatewayBrowserClient, opts: { full?: boolean } = {}) {
  agentsLive.loading = true;
  onChange?.();
  try {
    await Promise.all([loadRuns(client), opts.full !== false ? loadSlow(client) : Promise.resolve()]);
    agentsLive.loadedAt = Date.now();
  } finally {
    agentsLive.loading = false;
    onChange?.();
  }
}

function log(entry: ActivityEntry) {
  agentsLive.activity.unshift(entry);
  if (agentsLive.activity.length > MAX_ACTIVITY) agentsLive.activity.length = MAX_ACTIVITY;
}

function scheduleRefresh() {
  if (debounce || !activeClient) return;
  debounce = setTimeout(() => {
    debounce = null;
    if (activeClient) void loadAgentsLive(activeClient, { full: false });
  }, EVENT_DEBOUNCE_MS);
}

/** Visible for tests: fold one gateway event into the activity log + pulses. */
export function handleAgentsEvent(evt: GatewayEventFrame) {
  const p = (evt.payload ?? {}) as Record<string, unknown>;
  const now = Date.now();
  switch (evt.event) {
    case "subagent.spawned": {
      const child = agentIdFromSessionKey(p.sessionKey);
      const from = agentIdFromSessionKey(p.requesterSessionKey);
      const to = child ?? (typeof p.coderBackend === "string" ? `cli:${p.coderBackend}` : null);
      if (to) {
        log({ ts: now, agentId: to, kind: "spawn", text: `Spawned: ${String(p.label || p.task || p.runId || "run")}`, runId: String(p.runId ?? "") });
        pulseListener?.(from, to, "spawn");
      }
      scheduleRefresh();
      break;
    }
    case "subagent.complete":
    case "subagent.error":
    case "subagent.timeout": {
      const child = agentIdFromSessionKey(p.sessionKey);
      if (child) {
        const kind = evt.event === "subagent.complete" ? "complete" : "error";
        log({ ts: now, agentId: child, kind, text: `${evt.event.split(".")[1]}: ${String(p.label || p.runId || "run")}`, runId: String(p.runId ?? "") });
        pulseListener?.(null, child, "complete");
      }
      scheduleRefresh();
      break;
    }
    case "subagent.checkpoint": {
      const child = agentIdFromSessionKey(p.sessionKey);
      if (child) log({ ts: now, agentId: child, kind: "checkpoint", text: `Check-in: ${String(p.summary ?? "")}`, runId: String(p.runId ?? "") });
      break;
    }
    case "agent":
    case "chat": {
      const id = agentIdFromSessionKey(p.sessionKey);
      if (!id) break;
      const prev = lastPing.get(id) ?? 0;
      const data = (p.data ?? {}) as Record<string, unknown>;
      if (evt.event === "agent" && p.stream === "tool") {
        const name = String(data.name ?? data.tool ?? data.toolName ?? "tool");
        const phase = String(data.phase ?? "");
        if (phase !== "result" && phase !== "end") log({ ts: now, agentId: id, kind: "tool", text: `Tool: ${name}`, runId: String(p.runId ?? "") });
      } else if (evt.event === "agent" && p.stream === "lifecycle") {
        const phase = String(data.phase ?? data.state ?? "");
        if (phase) log({ ts: now, agentId: id, kind: "lifecycle", text: `Run ${phase}`, runId: String(p.runId ?? "") });
      } else if (evt.event === "chat" && (p.state === "final" || p.state === "error")) {
        log({ ts: now, agentId: id, kind: p.state === "error" ? "error" : "message", text: p.state === "error" ? "Reply failed" : "Replied" });
      }
      if (now - prev > 1500) {
        lastPing.set(id, now);
        pulseListener?.(null, id, "message");
      }
      break;
    }
    default:
      return;
  }
  onChange?.();
}

/** Start polling + event subscription (idempotent; re-binds on a new client). */
export function startAgentsLive(client: GatewayBrowserClient, changed: () => void) {
  onChange = changed;
  if (activeClient === client && unsub) return;
  stopAgentsLive();
  activeClient = client;
  raw = { verification: [], history: [], live: [] };
  unsub = client.subscribe((evt: GatewayEventFrame) => handleAgentsEvent(evt));
  void loadAgentsLive(client);
  fastTimer = setInterval(() => {
    if (!document.hidden && activeClient) void loadAgentsLive(activeClient, { full: false });
  }, FAST_POLL_MS);
  fullTimer = setInterval(() => {
    if (!document.hidden && activeClient) void loadSlow(activeClient).then(() => onChange?.());
  }, FULL_POLL_MS);
}

export function stopAgentsLive() {
  unsub?.();
  unsub = null;
  if (fastTimer) clearInterval(fastTimer);
  if (fullTimer) clearInterval(fullTimer);
  if (debounce) clearTimeout(debounce);
  fastTimer = fullTimer = debounce = null;
  activeClient = null;
}
