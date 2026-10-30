/**
 * Recently-completed ring for the Agent Mesh map.
 *
 * Finished runs no longer vanish from the map: the newest MAX_RESTING_COMPLETED
 * of them stay parked on a Gateway Concourse bed (✓ done / ✕ failed). The data
 * bridge owns one of these rings so finished agents survive reconcile ticks
 * after they fall out of subagents.list's grace window, and persists it to
 * localStorage so a page reload repopulates the rest area.
 *
 * Pure (no DOM / Pixi) — storage is injected so it's unit-testable in node.
 */

import type { MeshAgent } from "./activity-map";

/** How many finished (completed + failed) agents stay resting on the map. */
export const MAX_RESTING_COMPLETED = 10;

export const RESTING_STORAGE_KEY = "infinibot.mesh.restingCompleted.v1";

export interface RestingEntry {
  sessionKey: string;
  agentId: string;
  label: string;
  nodeId: string;
  success: boolean;
  endedAt: number;
  coderBackend?: MeshAgent["coderBackend"];
  runId?: string;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function sanitize(raw: unknown): RestingEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.sessionKey !== "string" || !r.sessionKey) return null;
  const backend = r.coderBackend;
  return {
    sessionKey: r.sessionKey,
    agentId: typeof r.agentId === "string" && r.agentId ? r.agentId : "sub",
    label: typeof r.label === "string" && r.label ? r.label : r.sessionKey,
    nodeId: typeof r.nodeId === "string" && r.nodeId ? r.nodeId : "local",
    success: r.success !== false,
    endedAt: typeof r.endedAt === "number" && Number.isFinite(r.endedAt) ? r.endedAt : 0,
    coderBackend:
      backend === "claude-code" ||
      backend === "opencode" ||
      backend === "codex" ||
      backend === "gemini" ||
      backend === "grok"
        ? backend
        : undefined,
    runId: typeof r.runId === "string" && r.runId ? r.runId : undefined,
  };
}

/** Rebuild the resting MeshAgent for an entry (status completed / failed). */
export function restingAgentOf(e: RestingEntry): MeshAgent {
  const agent: MeshAgent = {
    sessionKey: e.sessionKey,
    agentId: e.agentId,
    label: e.label,
    nodeId: e.nodeId,
    status: e.success ? "completed" : "failed",
    progress: e.success ? 100 : 0,
  };
  if (e.coderBackend) agent.coderBackend = e.coderBackend;
  if (e.runId) agent.runId = e.runId;
  return agent;
}

export class RestingRing {
  /** Newest first. */
  private entries: RestingEntry[] = [];

  constructor(
    private readonly storage: StorageLike | null = defaultStorage(),
    private readonly cap = MAX_RESTING_COMPLETED,
  ) {
    this.load();
  }

  has(sessionKey: string): boolean {
    return this.entries.some((e) => e.sessionKey === sessionKey);
  }

  /** Newest first (copy). */
  list(): RestingEntry[] {
    return this.entries.slice();
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * Record a finished run at the front of the ring (re-finishing an entry moves
   * it to the front). Returns the session keys evicted off the tail — the
   * caller walks those off the map.
   */
  add(entry: RestingEntry): string[] {
    this.entries = this.entries.filter((e) => e.sessionKey !== entry.sessionKey);
    this.entries.unshift(entry);
    this.entries.sort((a, b) => b.endedAt - a.endedAt);
    const evicted = this.entries.splice(this.cap).map((e) => e.sessionKey);
    this.save();
    return evicted;
  }

  /** Drop a key (it went active again, or left). Returns true if it was resting. */
  remove(sessionKey: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.sessionKey !== sessionKey);
    if (this.entries.length === before) return false;
    this.save();
    return true;
  }

  private load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(RESTING_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const seen = new Set<string>();
      const out: RestingEntry[] = [];
      for (const item of parsed) {
        const e = sanitize(item);
        if (!e || seen.has(e.sessionKey)) continue;
        seen.add(e.sessionKey);
        out.push(e);
      }
      out.sort((a, b) => b.endedAt - a.endedAt);
      this.entries = out.slice(0, this.cap);
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(RESTING_STORAGE_KEY, JSON.stringify(this.entries));
    } catch {
      /* quota / privacy mode — resting set just won't survive reload */
    }
  }
}
