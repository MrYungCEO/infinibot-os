/**
 * Pure helpers for the Memory › Agents view (memory-agents.ts). No DOM, no
 * Lit — unit-tested in node.
 */

import type {
  AgentKnowledgeProfile,
  KnowledgeProfileResult,
  KnowledgeSource,
  KnowledgeSourceDef,
} from "../../../../src/agents/knowledge-profile/types.js";

export type { AgentKnowledgeProfile, KnowledgeProfileResult, KnowledgeSource, KnowledgeSourceDef };

/** A per-agent source row joined with its shared static definition. */
export type SourceView = KnowledgeSource & Omit<KnowledgeSourceDef, "id" | "note"> & { defNote?: string };

/** Join agent.knowledge[] with result.sourceDefs (unknown ids still render). */
export function mergeSources(defs: KnowledgeSourceDef[], sources: KnowledgeSource[]): SourceView[] {
  const byId = new Map(defs.map((d) => [d.id, d]));
  return sources.map((s) => {
    const def = byId.get(s.id);
    return {
      label: s.id,
      description: "",
      via: [],
      ...(def ? { ...def, note: undefined, defNote: def.note } : {}),
      ...s,
    };
  });
}

export const PROFILE_METHOD = "agents.knowledge.profile";

/** Poll cadence while the view is visible. */
export const POLL_MS = 15_000;
/** Coalesce bursts of gateway events into one refresh. */
export const EVENT_DEBOUNCE_MS = 2_500;

/**
 * Gateway events that can change what an agent knows / is doing. `agent` and
 * `chat` fire per token/tool while a run streams, hence the debounce.
 */
const RELEVANT_EVENTS = new Set([
  "agent",
  "chat",
  "presence",
  "notes:changed",
  "kanban:changed",
  "subagent.spawned",
  "subagent.complete",
  "subagent.checkpoint",
  "autonomous:task:update",
  "config.changed",
]);

export function isRelevantEvent(event: string): boolean {
  return RELEVANT_EVENTS.has(event) || event.startsWith("sessions.") || event.startsWith("agents.");
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatBytes(n: number): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatAgo(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "never";
  const d = Math.max(0, now - ms);
  if (d < 45_000) return "just now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  if (d < 30 * 86_400_000) return `${Math.round(d / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Freshness bucket for colour-coding a timestamp. */
export function freshness(ms: number | null | undefined, now = Date.now()): "live" | "fresh" | "stale" | "cold" {
  if (!ms) return "cold";
  const d = now - ms;
  if (d < 10 * 60_000) return "live";
  if (d < 7 * 86_400_000) return "fresh";
  if (d < 60 * 86_400_000) return "stale";
  return "cold";
}

/** "anthropic/claude-sonnet-5" → "claude-sonnet-5". */
export function shortModel(model: string | null | undefined): string {
  if (!model) return "default model";
  const i = model.indexOf("/");
  return i >= 0 ? model.slice(i + 1) : model;
}

const STATUS_RANK = { running: 0, active: 1, idle: 2, dormant: 3 } as const;

/** Running first, then most recently active, default agent first on ties. */
export function sortRoster(agents: AgentKnowledgeProfile[]): AgentKnowledgeProfile[] {
  return [...agents].sort(
    (a, b) =>
      STATUS_RANK[a.activity.status] - STATUS_RANK[b.activity.status] ||
      (b.activity.lastActiveAt ?? 0) - (a.activity.lastActiveAt ?? 0) ||
      Number(b.isDefault) - Number(a.isDefault) ||
      a.name.localeCompare(b.name),
  );
}

export function filterRoster(agents: AgentKnowledgeProfile[], query: string): AgentKnowledgeProfile[] {
  const q = query.trim().toLowerCase();
  if (!q) return agents;
  return agents.filter((a) =>
    [a.id, a.name, a.department, a.capabilities.model.primary, a.identity.persona.name]
      .filter(Boolean)
      .some((s) => String(s).toLowerCase().includes(q)),
  );
}

/** Max allowed tool count per domain across agents (for matrix shading). */
export function domainMaxima(result: KnowledgeProfileResult): Record<string, number> {
  const max: Record<string, number> = {};
  for (const d of result.domains) max[d] = 0;
  for (const a of result.agents)
    for (const [d, n] of Object.entries(a.matrix)) max[d] = Math.max(max[d] ?? 0, n);
  return max;
}

/** 0 … 1 intensity for a matrix cell (0 = no access). */
export function cellIntensity(value: number, max: number): number {
  if (!value || !max) return 0;
  return Math.max(0.18, Math.min(1, value / max));
}

/** Source ordering: reachable first, then by count. */
export function sortSources<T extends KnowledgeSource>(sources: T[]): T[] {
  return [...sources].sort(
    (a, b) => Number(b.reachable) - Number(a.reachable) || (b.count ?? -1) - (a.count ?? -1),
  );
}

export function statusLabel(status: string): string {
  switch (status) {
    case "ok":
      return "live";
    case "empty":
      return "empty";
    case "not-configured":
      return "not configured";
    case "offline":
      return "offline";
    case "error":
      return "error";
    default:
      return status;
  }
}

/** Headline stats for the page header. */
export function fleetSummary(result: KnowledgeProfileResult | null) {
  const agents = result?.agents ?? [];
  return {
    agents: agents.length,
    running: agents.filter((a) => a.activity.status === "running").length,
    activeToday: agents.filter((a) => a.activity.status === "running" || a.activity.status === "active").length,
    subagentsRunning: agents.reduce((n, a) => n + a.activity.runningNow, 0),
    misconfigured: agents.filter((a) => a.capabilities.tools.unknownAllowEntries.length > 0).length,
  };
}
