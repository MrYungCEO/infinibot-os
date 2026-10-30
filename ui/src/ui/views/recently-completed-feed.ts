/**
 * Recently Completed Kanban Tasks Feed
 *
 * Shared Lit functional component used in three mount-points:
 *   - "projects": the kanban gallery page (open by default)
 *   - "activity": the activity side panel (collapsed by default)
 *   - "dashboard": agent-activity dashboard (body only, embedded in iad-oversight-card)
 *
 * Collapse state is persisted per mount-point to localStorage so each
 * surface can be independently opened/closed across page refreshes.
 *
 * Realtime: subscribes to the `kanban:task:completed` gateway event and
 * slides new entries in at the top. Throttles animation bursts.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import { getReviewBadgeByLabel } from "./oversight/index";
import { managedInterval, type SchedulerHandle } from "../perf/visibility-scheduler";

// ── Types ─────────────────────────────────────────────────────

export type RecentlyCompletedEntry = {
  taskId: string;
  projectId: string | null;
  projectName: string;
  title: string;
  assignee?: string;
  priority?: string;
  completedAt: number;
  durationMs: number;
  description?: string;
  status?: "success" | "error";
  /** Federation node display name this task completed on. */
  node?: string;
  /** Stable federation node id (matches `federationNodes[].id`). */
  nodeId?: string;
  /** True when the entry came from a remote federation peer. */
  remote?: boolean;
};

export type RCFDensity = "compact" | "comfortable";

/** Stable per-node hue, mirroring the agent-activity card badge so the
 *  same federation peer shows the same colour across both feeds. */
function rcfNodeHue(nodeId: string): number {
  let h = 0;
  for (let i = 0; i < nodeId.length; i++) h = (Math.imul(31, h) + nodeId.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function renderRcfNodeChip(entry: RecentlyCompletedEntry) {
  const isRemote = Boolean(entry.remote);
  const name = entry.node ?? "";
  if (!isRemote && (!name || name === "local")) return nothing;
  const idForHue = entry.nodeId || name || "remote";
  const hue = rcfNodeHue(idForHue);
  return html`
    <span
      class="rcf-node-chip"
      title=${`Completed on ${name || idForHue}`}
      style="
        display:inline-flex; align-items:center; gap:3px;
        border:1px solid hsla(${hue}, 80%, 60%, 0.45);
        background:hsla(${hue}, 80%, 50%, 0.12);
        color:hsl(${hue}, 80%, 70%);
        font-size:9px; padding:1px 6px; font-weight:700;
        letter-spacing:0.08em; border-radius:3px; text-transform:uppercase;
      "
    >🛰 ${(name || idForHue).slice(0, 16)}</span>
  `;
}

// ── Storage keys ──────────────────────────────────────────────

const STORAGE_KEYS = {
  projects:  "ib.recentDone.projects.collapsed",
  activity:  "ib.recentDone.activity.collapsed",
  dashboard: "ib.recentDone.dashboard.collapsed",
} as const;

const DEFAULT_COLLAPSED: Record<keyof typeof STORAGE_KEYS, boolean> = {
  projects:  false,
  activity:  true,
  dashboard: false,
};

// ── Filter / sort state ───────────────────────────────────────

type DateFilter   = "all" | "today" | "week";
type StatusFilter = "all" | "success" | "error";
type SortMode     = "newest" | "oldest" | "duration" | "project";
type GroupMode    = "date" | "project" | "none";

let _dateFilter: DateFilter     = "all";
let _statusFilter: StatusFilter = "all";
let _sortMode: SortMode         = "newest";
let _groupMode: GroupMode       = "date";
let _searchQuery                = "";
let _selectedProjects           = new Set<string>();
let _pinnedIds                  = new Set<string>();
let _hiddenIds                  = new Set<string>();

// ── Module state ──────────────────────────────────────────────

let _entries: RecentlyCompletedEntry[]                       = [];
let _loading                                                 = false;
let _error: string | null                                    = null;
let _client: GatewayBrowserClient | null                     = null;
let _wsUnsub: (() => void) | null                            = null;
let _newEntryIds                                             = new Set<string>();
let _animationFlushTimer: ReturnType<typeof setTimeout> | null = null;
let _requestUpdate: (() => void) | null                      = null;
let _tickTimer: SchedulerHandle | null                      = null;
/**
 * When the last successful load finished (0 = never).
 *
 * `loadRecentlyCompleted` is called from inside `renderKanban`'s render path,
 * and it ends by calling `_rerender()`. Without a freshness gate that is a
 * self-sustaining render loop: render → fetch → rerender → render → fetch …
 * The `_loading` flag only collapses *concurrent* calls, not the next one, so
 * /projects re-fetched this feed (plus a `federation.nodes.list` fan-out to
 * every peer) forever while sitting idle. Callers that genuinely want fresh
 * data pass `force: true`.
 */
let _lastLoadedAt = 0;
/** How long a completed load is considered fresh enough to skip a refetch. */
const FEED_TTL_MS = 30_000;

// Lightweight change-subscriber channel. Surfaces that render OUTSIDE the main
// Lit app tree (e.g. the world-map pin board, which renders into an
// imperatively-mounted DOM node) can't rely on the shared `_requestUpdate`
// app re-render to refresh themselves. They register here and get pinged
// whenever the feed's data/animation state changes (load, WS push, tick).
const _changeListeners = new Set<() => void>();

/**
 * Subscribe to feed-state changes (new completions, animation flushes, ticks).
 * Returns an unsubscribe fn. Independent of the shared WS subscription, so
 * tearing this down does NOT affect the global `kanban:task:completed` stream.
 */
export function onRecentlyCompletedChange(cb: () => void): () => void {
  _changeListeners.add(cb);
  return () => { _changeListeners.delete(cb); };
}

function _rerender(): void {
  _requestUpdate?.();
  for (const cb of _changeListeners) {
    try { cb(); } catch (err) { console.error("[rcf] change listener failed", err); }
  }
}

function _startTicker(): void {
  if (_tickTimer !== null) return;
  _tickTimer = managedInterval(() => _rerender(), 30_000, { hiddenMs: 120_000 });
}

function retryLoad(): void {
  // Explicit user action — bypass the freshness gate.
  if (_client && _requestUpdate) void loadRecentlyCompleted(_client, _requestUpdate, { force: true });
}

// ── Collapse state ────────────────────────────────────────────

function isCollapsed(mount: keyof typeof STORAGE_KEYS): boolean {
  const stored = localStorage.getItem(STORAGE_KEYS[mount]);
  if (stored === null) return DEFAULT_COLLAPSED[mount];
  return stored === "1";
}

function setCollapsed(mount: keyof typeof STORAGE_KEYS, value: boolean): void {
  localStorage.setItem(STORAGE_KEYS[mount], value ? "1" : "0");
  _rerender();
}

// ── Data loading ──────────────────────────────────────────────

export async function loadRecentlyCompleted(
  client: GatewayBrowserClient,
  requestUpdate: () => void,
  opts?: { limit?: number; force?: boolean },
): Promise<void> {
  _client        = client;
  _requestUpdate = requestUpdate;
  _startTicker();
  if (_loading) return;
  // Freshness gate — see `_lastLoadedAt`. Render-path callers hit this and
  // return immediately instead of kicking off another fetch + re-render.
  if (!opts?.force && _lastLoadedAt && Date.now() - _lastLoadedAt < FEED_TTL_MS) return;
  _loading = true;
  _error   = null;
  _rerender();
  try {
    const limit = opts?.limit ?? 25;
    const localRes = await client.request("kanban.listRecentlyCompleted", { limit });
    const localEntries: RecentlyCompletedEntry[] =
      localRes && Array.isArray(localRes.entries) ? localRes.entries : [];

    // Cross-node aggregation: pull the same feed from every connected
    // federation peer and tag each row with its origin node so the
    // operator sees a unified mesh-wide "recently done" list. Best-effort
    // — peer failures don't break the local feed.
    const remoteEntries: RecentlyCompletedEntry[] = [];
    try {
      const peers = await fetchFederationPeersForFeed(client);
      const batches = await Promise.all(
        peers.map(async (peer) => {
          try {
            const r = (await client.request("federation.node.invoke", {
              nodeId: peer.id,
              method: "kanban.listRecentlyCompleted",
              params: { limit },
            })) as { status?: string; payload?: { entries?: RecentlyCompletedEntry[] } } | undefined;
            if (r?.status !== "ok" || !Array.isArray(r.payload?.entries)) return [];
            return r.payload!.entries!.map((e) => ({
              ...e,
              node: e.node ?? peer.name,
              nodeId: e.nodeId ?? peer.id,
              remote: true,
            }));
          } catch {
            return [];
          }
        }),
      );
      for (const batch of batches) remoteEntries.push(...batch);
    } catch {
      /* federation aggregation is optional */
    }

    _entries = dedupeByTaskId([...localEntries, ...remoteEntries]);
    _error = null;
  } catch (err) {
    _error = err instanceof Error ? err.message : String(err);
  } finally {
    _loading = false;
    _lastLoadedAt = Date.now();
    _rerender();
  }
}

/**
 * Resolve federation peers worth fanning the recently-completed feed
 * out to. Same shape as the agent-activity controller's helper but
 * inlined here so this feed stays import-light.
 */
async function fetchFederationPeersForFeed(
  client: GatewayBrowserClient,
): Promise<Array<{ id: string; name: string }>> {
  try {
    const r = (await client.request("federation.nodes.list", {})) as
      | { nodes?: Array<{ id: string; name?: string; isLocal?: boolean; status?: string }> }
      | undefined;
    return (r?.nodes ?? [])
      .filter((n) => !n.isLocal && n.status !== "offline" && typeof n.id === "string" && n.id)
      .map((n) => ({ id: n.id, name: n.name ?? n.id }));
  } catch {
    return [];
  }
}

// ── WS subscription ───────────────────────────────────────────

export function subscribeRecentCompleted(client: GatewayBrowserClient): void {
  if (_wsUnsub) return;
  _wsUnsub = client.subscribe((evt) => {
    if (evt.type !== "kanban:task:completed") return;
    const entry = evt.payload as RecentlyCompletedEntry;
    if (!entry?.taskId) return;

    _entries = [entry, ..._entries.filter((e) => e.taskId !== entry.taskId)].slice(0, 25);

    _newEntryIds.add(entry.taskId);
    if (_animationFlushTimer !== null) clearTimeout(_animationFlushTimer);
    _animationFlushTimer = setTimeout(() => {
      _newEntryIds.clear();
      _animationFlushTimer = null;
      _rerender();
    }, 700);

    _rerender();
  });
}

export function unsubscribeRecentCompleted(): void {
  _wsUnsub?.();
  _wsUnsub = null;
}

// ── Accessors ─────────────────────────────────────────────────

export function getRecentlyCompletedTodayCount(): number {
  const midnightToday = new Date();
  midnightToday.setHours(0, 0, 0, 0);
  const since = midnightToday.getTime();
  return _entries.filter((e) => e.completedAt >= since).length;
}

/** Return up to `limit` most-recent completed entries (defaults to all). */
export function getRecentlyCompletedEntries(limit?: number): RecentlyCompletedEntry[] {
  // Dedupe defensively at read time too: the WS push path stays clean by
  // taskId, but if a future code path appends to `_entries` without going
  // through dedupe (e.g. paginated load, optimistic insert), the grid panel
  // would render duplicate cards. Keeping it here makes that impossible.
  const unique = dedupeByTaskId(_entries);
  if (limit === undefined) return unique;
  return unique.slice(0, Math.max(0, limit));
}

function dedupeByTaskId(entries: RecentlyCompletedEntry[]): RecentlyCompletedEntry[] {
  const byId = new Map<string, RecentlyCompletedEntry>();
  for (const e of entries) {
    if (!e?.taskId) continue;
    const existing = byId.get(e.taskId);
    if (!existing || e.completedAt > existing.completedAt) {
      byId.set(e.taskId, e);
    }
  }
  return [...byId.values()].sort((a, b) => b.completedAt - a.completedAt);
}

// ── Filter + sort helpers ─────────────────────────────────────

function getDateBoundary(filter: DateFilter): number {
  if (filter === "all") return 0;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (filter === "today") return d.getTime();
  d.setDate(d.getDate() - 6);
  return d.getTime();
}

function applyFilters(entries: RecentlyCompletedEntry[]): RecentlyCompletedEntry[] {
  const since      = getDateBoundary(_dateFilter);
  const q          = _searchQuery.trim().toLowerCase();
  const projFilter = _selectedProjects.size > 0;

  let out = entries.filter((e) => {
    if (_hiddenIds.has(e.taskId))                                                                  return false;
    if (since > 0 && e.completedAt < since)                                                        return false;
    if (_statusFilter === "success" && e.status === "error")                                       return false;
    if (_statusFilter === "error"   && e.status !== "error")                                       return false;
    if (projFilter && !_selectedProjects.has(e.projectName))                                       return false;
    if (q && !e.title.toLowerCase().includes(q) && !e.projectName.toLowerCase().includes(q))       return false;
    return true;
  });

  out.sort((a, b) => {
    const ap = _pinnedIds.has(a.taskId) ? 1 : 0;
    const bp = _pinnedIds.has(b.taskId) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    switch (_sortMode) {
      case "oldest":   return a.completedAt - b.completedAt;
      case "duration": return b.durationMs  - a.durationMs;
      case "project":  return a.projectName.localeCompare(b.projectName);
      default:         return b.completedAt - a.completedAt;
    }
  });

  return out;
}

function allProjectNames(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of _entries) {
    if (!seen.has(e.projectName)) { seen.add(e.projectName); out.push(e.projectName); }
  }
  return out;
}

// ── Group helpers ─────────────────────────────────────────────

function dayLabel(ts: number): string {
  const d   = new Date(ts);
  const now = new Date();
  const mdn = (t: Date) => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const diff = mdn(now) - mdn(d);
  if (diff <= 0)          return "Today";
  if (diff <= 86_400_000) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

type Group = { label: string; entries: RecentlyCompletedEntry[] };

function groupEntries(entries: RecentlyCompletedEntry[]): Group[] {
  if (_groupMode === "none") return [{ label: "", entries }];
  const map = new Map<string, RecentlyCompletedEntry[]>();
  for (const e of entries) {
    const key = _groupMode === "date" ? dayLabel(e.completedAt) : e.projectName;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(e);
  }
  return [...map.entries()].map(([label, ents]) => ({ label, entries: ents }));
}

// ── Formatters ────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 5_000)      return "just now";
  if (diff < 60_000)     return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const d    = new Date(ts);
  const yday = new Date(); yday.setDate(yday.getDate() - 1); yday.setHours(0, 0, 0, 0);
  const dDay = new Date(d); dDay.setHours(0, 0, 0, 0);
  if (dDay.getTime() === yday.getTime()) {
    return `Yesterday ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  }
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h   = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

function entryStatusColor(entry: RecentlyCompletedEntry): string {
  return entry.status === "error" ? "#ef4444" : "#10b981";
}

function entryStatusLabel(entry: RecentlyCompletedEntry): string {
  return entry.status === "error" ? "FAILED" : "NOMINAL";
}

// ── SVG icons (inline, no emoji) ─────────────────────────────

const ICON_FOLDER   = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
const ICON_DOC      = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`;
const ICON_RERUN    = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;
const ICON_PIN      = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>`;
const ICON_HIDE     = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
const ICON_SEARCH   = html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
const ICON_SORT     = html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`;
const ICON_GROUP    = html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`;
const ICON_CHEVRON  = html`<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;
const ICON_CHECK    = html`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
const ICON_SPAWN    = html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`;
const ICON_ALERT    = html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

// ── Public API ────────────────────────────────────────────────

/**
 * Render just the list body — no card frame, no collapse toggle.
 * Used by the agent-activity dashboard (which provides its own iad-oversight-card chrome).
 */
export function renderRecentlyCompletedBody(
  onNavigateToTask?: (taskId: string, projectId: string | null) => void,
  density: RCFDensity = "compact",
): TemplateResult {
  return renderBody(onNavigateToTask, density);
}

/**
 * Render a bounded, chrome-less list of the most-recent completed entries
 * (newest first), reusing the exact same `renderCompactRow` the dashboard /
 * full feed use. No filter bar, no footer — just up to `limit` rows.
 *
 * Used by the masonry grid Activity panel's compact "Completed tasks" section
 * so it stays row-for-row identical to the standalone surfaces while sharing
 * the same module-singleton store (realtime sync, no separate fetch).
 */
export function renderRecentlyCompletedCompactList(
  limit: number,
  onNavigateToTask?: (taskId: string, projectId: string | null) => void,
): TemplateResult {
  if (_loading && _entries.length === 0) {
    return html`<div class="rcf-body">${renderSkeletonLoading("compact")}</div>`;
  }
  if (_error && _entries.length === 0) {
    return html`<div class="rcf-body">${renderErrorState(_error)}</div>`;
  }
  const rows = getRecentlyCompletedEntries(limit);
  if (rows.length === 0) {
    return renderEmptyState(onNavigateToTask);
  }
  return html`
    ${rcfStyles()}
    <div class="rcf-list rcf-list--compact">
      ${rows.map((entry) => renderCompactRow(entry, onNavigateToTask))}
    </div>
  `;
}

/**
 * Bounded, chrome-less *card* list — same `renderCardItem` (corner brackets,
 * status pill, project/duration chips, action row) the standalone Activity
 * page renders in comfortable density, capped at `limit` items. No filter
 * bar, no footer; callers supply their own section header.
 *
 * Used by the masonry grid Activity panel so its "Completed tasks" section
 * matches the full Activity page card-for-card.
 */
export function renderRecentlyCompletedCardList(
  limit: number,
  onNavigateToTask?: (taskId: string, projectId: string | null) => void,
): TemplateResult {
  if (_loading && _entries.length === 0) {
    return html`${rcfStyles()}<div class="rcf-body">${renderSkeletonLoading("comfortable")}</div>`;
  }
  if (_error && _entries.length === 0) {
    return html`${rcfStyles()}<div class="rcf-body">${renderErrorState(_error)}</div>`;
  }
  const rows = getRecentlyCompletedEntries(limit);
  if (rows.length === 0) {
    return html`${rcfStyles()}${renderEmptyState(onNavigateToTask)}`;
  }
  return html`
    ${rcfStyles()}
    <div class="rcf-list rcf-list--comfortable">
      ${rows.map((entry) => renderCardItem(entry, onNavigateToTask))}
    </div>
  `;
}

export function renderRecentlyCompletedFeed(opts: {
  mount: "projects" | "activity" | "dashboard";
  onNavigateToTask?: (taskId: string, projectId: string | null) => void;
  density?: RCFDensity;
}): TemplateResult {
  const { mount, onNavigateToTask, density = "comfortable" } = opts;
  const collapsed  = isCollapsed(mount);
  const todayCount = getRecentlyCompletedTodayCount();

  return html`
    <div class="rcf-root rcf-mount-${mount}" aria-label="Recently completed tasks">
      ${rcfStyles()}
      ${renderHeader(mount, collapsed, todayCount)}
      ${collapsed ? nothing : renderBody(onNavigateToTask, density)}
    </div>
  `;
}

// ── Internal render ───────────────────────────────────────────

function renderHeader(
  mount: keyof typeof STORAGE_KEYS,
  collapsed: boolean,
  todayCount: number,
): TemplateResult {
  return html`
    <div
      class="rcf-header"
      role="button"
      tabindex="0"
      aria-expanded="${!collapsed}"
      @click=${() => setCollapsed(mount, !collapsed)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setCollapsed(mount, !collapsed);
        }
      }}
    >
      <span class="rcf-header-icon">${ICON_CHECK}</span>
      <span class="rcf-header-title">Recently completed</span>
      ${todayCount > 0 ? html`
        <span class="rcf-count-chip">${todayCount} today</span>
      ` : nothing}
      ${_loading ? html`<span class="rcf-loading-dot" aria-label="Loading"></span>` : nothing}
      <span class="rcf-chevron" style="transform: rotate(${collapsed ? "0deg" : "180deg"})">
        ${ICON_CHEVRON}
      </span>
    </div>
  `;
}

function renderBody(
  onNavigateToTask: ((taskId: string, projectId: string | null) => void) | undefined,
  density: RCFDensity,
): TemplateResult {
  if (_loading && _entries.length === 0) {
    return html`<div class="rcf-body">${renderSkeletonLoading(density)}</div>`;
  }
  if (_error) {
    return html`<div class="rcf-body">${renderErrorState(_error)}</div>`;
  }

  const filtered = applyFilters(_entries);
  const groups   = groupEntries(filtered);

  return html`
    <div class="rcf-body">
      ${density === "comfortable" ? renderFilterBar() : renderCompactFilterRow()}
      ${filtered.length === 0
        ? renderEmptyState(onNavigateToTask)
        : html`
          <div class="rcf-list rcf-list--${density}">
            ${groups.map((g) => html`
              ${g.label ? renderGroupHeader(g.label) : nothing}
              ${g.entries.map((entry) =>
                density === "comfortable"
                  ? renderCardItem(entry, onNavigateToTask)
                  : renderCompactRow(entry, onNavigateToTask)
              )}
            `)}
          </div>
          <div class="rcf-footer">
            <button class="rcf-view-all" @click=${(e: Event) => {
              e.stopPropagation();
              onNavigateToTask?.("__view_all__", null);
            }}>
              View all completed →
            </button>
            <span class="rcf-footer-count">${filtered.length} shown</span>
          </div>
        `}
    </div>
  `;
}

// ── Filter bar (comfortable) ──────────────────────────────────

function renderFilterBar(): TemplateResult {
  const projects = allProjectNames();
  return html`
    <div class="rcf-filter-bar">
      <div class="rcf-filter-chips">
        ${(["all", "today", "week"] as const).map((f) => html`
          <button
            class="rcf-chip ${_dateFilter === f ? "rcf-chip--active" : ""}"
            @click=${() => { _dateFilter = f; _rerender(); }}
          >${f === "all" ? "All" : f === "today" ? "Today" : "This week"}</button>
        `)}
        <span class="rcf-filter-divider"></span>
        ${(["all", "success", "error"] as const).map((f) => html`
          <button
            class="rcf-chip ${_statusFilter === f ? "rcf-chip--active" : ""} ${f === "error" ? "rcf-chip--error" : f === "success" ? "rcf-chip--success" : ""}"
            @click=${() => { _statusFilter = f; _rerender(); }}
          >${f === "all" ? "Any status" : f === "success" ? "Success" : "Failed"}</button>
        `)}
      </div>
      <div class="rcf-filter-right">
        <div class="rcf-search-wrap">
          <span class="rcf-search-icon">${ICON_SEARCH}</span>
          <input
            class="rcf-search"
            type="search"
            placeholder="Search…"
            .value=${_searchQuery}
            @input=${(e: Event) => {
              _searchQuery = (e.target as HTMLInputElement).value;
              _rerender();
            }}
            aria-label="Search completed tasks"
          />
        </div>
        <div class="rcf-select-wrap">
          <span class="rcf-select-icon">${ICON_SORT}</span>
          <select
            class="rcf-select"
            @change=${(e: Event) => {
              _sortMode = (e.target as HTMLSelectElement).value as SortMode;
              _rerender();
            }}
            aria-label="Sort completed tasks"
          >
            <option value="newest"   ?selected=${_sortMode === "newest"}>Newest first</option>
            <option value="oldest"   ?selected=${_sortMode === "oldest"}>Oldest first</option>
            <option value="duration" ?selected=${_sortMode === "duration"}>Longest duration</option>
            <option value="project"  ?selected=${_sortMode === "project"}>Project A–Z</option>
          </select>
        </div>
        <button
          class="rcf-icon-btn ${_groupMode !== "none" ? "rcf-icon-btn--active" : ""}"
          title="Grouping: ${_groupMode}"
          @click=${() => {
            _groupMode = _groupMode === "date" ? "project" : _groupMode === "project" ? "none" : "date";
            _rerender();
          }}
          aria-label="Toggle grouping"
        >${ICON_GROUP}</button>
      </div>
    </div>
    ${projects.length > 1 ? html`
      <div class="rcf-project-filter">
        <details class="rcf-proj-dropdown">
          <summary class="rcf-proj-summary">
            ${ICON_FOLDER}
            <span>By project${_selectedProjects.size > 0 ? ` (${_selectedProjects.size})` : ""}</span>
            <span class="rcf-proj-chevron">${ICON_CHEVRON}</span>
          </summary>
          <div class="rcf-proj-menu">
            ${projects.map((name) => html`
              <label class="rcf-proj-option">
                <input
                  type="checkbox"
                  .checked=${_selectedProjects.has(name)}
                  @change=${(e: Event) => {
                    if ((e.target as HTMLInputElement).checked) _selectedProjects.add(name);
                    else _selectedProjects.delete(name);
                    _rerender();
                  }}
                />
                <span>${name}</span>
              </label>
            `)}
            ${_selectedProjects.size > 0 ? html`
              <button class="rcf-proj-clear" @click=${() => { _selectedProjects.clear(); _rerender(); }}>
                Clear all
              </button>
            ` : nothing}
          </div>
        </details>
      </div>
    ` : nothing}
  `;
}

// ── Compact filter row (dashboard / compact mode) ─────────────

function renderCompactFilterRow(): TemplateResult {
  return html`
    <div class="rcf-compact-filter">
      <div class="rcf-compact-chips">
        ${(["all", "today", "week"] as const).map((f) => html`
          <button
            class="rcf-chip rcf-chip--xs ${_dateFilter === f ? "rcf-chip--active" : ""}"
            @click=${() => { _dateFilter = f; _rerender(); }}
          >${f === "all" ? "All" : f === "today" ? "Today" : "Week"}</button>
        `)}
      </div>
      <div class="rcf-search-wrap rcf-search-wrap--xs">
        <span class="rcf-search-icon">${ICON_SEARCH}</span>
        <input
          class="rcf-search rcf-search--xs"
          type="search"
          placeholder="Filter…"
          .value=${_searchQuery}
          @input=${(e: Event) => {
            _searchQuery = (e.target as HTMLInputElement).value;
            _rerender();
          }}
          aria-label="Filter completed tasks"
        />
      </div>
    </div>
  `;
}

// ── Group header ──────────────────────────────────────────────

function renderGroupHeader(label: string): TemplateResult {
  return html`
    <div class="rcf-group-header">
      <span class="rcf-group-label">${label}</span>
      <span class="rcf-group-line" role="presentation"></span>
    </div>
  `;
}

// ── Card item (comfortable mode) ──────────────────────────────

function renderCardItem(
  entry: RecentlyCompletedEntry,
  onNavigate?: (taskId: string, projectId: string | null) => void,
): TemplateResult {
  const isNew    = _newEntryIds.has(entry.taskId);
  const isPinned = _pinnedIds.has(entry.taskId);
  const color    = entryStatusColor(entry);
  const label    = entryStatusLabel(entry);
  const dur      = formatDuration(entry.durationMs);

  return html`
    <div
      class="rcf-card ${isNew ? "rcf-card--new" : ""} ${isPinned ? "rcf-card--pinned" : ""}"
      style="--rcf-status-color:${color}"
      role="article"
    >
      <span class="rcf-corner rcf-tl" aria-hidden="true"></span>
      <span class="rcf-corner rcf-br" aria-hidden="true"></span>

      <div class="rcf-card-hdr">
        ${isPinned ? html`<span class="rcf-pin-dot" title="Pinned"></span>` : nothing}
        <button
          class="rcf-card-title-btn"
          @click=${() => onNavigate?.(entry.taskId, entry.projectId ?? null)}
        >
          <span class="rcf-card-check">${ICON_CHECK}</span>
          <span class="rcf-card-title">${entry.title}</span>
        </button>
        <span class="rcf-status-pill" style="color:${color};border-color:${color}33;background:${color}12;">
          ${label}
        </span>
        ${(() => {
          const rev = getReviewBadgeByLabel(entry.title);
          if (!rev) return nothing;
          return html`<a class="rcf-review-badge" @click=${(e: Event) => {
            e.stopPropagation();
            history.pushState({}, '', `/oversight#review-${rev.runId}`);
            window.dispatchEvent(new PopStateEvent('popstate'));
          }}>Review</a>`;
        })()}
      </div>

      ${entry.description ? html`<p class="rcf-card-desc">${entry.description}</p>` : nothing}

      <div class="rcf-card-ftr">
        <span class="rcf-project-chip" title="Project: ${entry.projectName}">${entry.projectName}</span>
        ${renderRcfNodeChip(entry)}
        ${entry.assignee ? html`<span class="rcf-assignee-chip">${entry.assignee}</span>` : nothing}
        <span class="rcf-card-spacer"></span>
        ${dur ? html`<span class="rcf-duration-pill">${dur}</span>` : nothing}
        <span class="rcf-time-ago" title="${new Date(entry.completedAt).toLocaleString()}">${timeAgo(entry.completedAt)}</span>
      </div>

      <div class="rcf-actions" role="group" aria-label="Task actions">
        <button class="rcf-action-btn" title="Open project"
          @click=${(e: Event) => { e.stopPropagation(); onNavigate?.("__project__", entry.projectId ?? null); }}>
          ${ICON_FOLDER}<span class="rcf-action-label">Open project</span>
        </button>
        <button class="rcf-action-btn" title="View transcript"
          @click=${(e: Event) => { e.stopPropagation(); onNavigate?.(entry.taskId, entry.projectId ?? null); }}>
          ${ICON_DOC}<span class="rcf-action-label">Transcript</span>
        </button>
        <button class="rcf-action-btn" title="Re-run"
          @click=${(e: Event) => { e.stopPropagation(); onNavigate?.(`__rerun__:${entry.taskId}`, entry.projectId ?? null); }}>
          ${ICON_RERUN}<span class="rcf-action-label">Re-run</span>
        </button>
        <button
          class="rcf-action-btn ${isPinned ? "rcf-action-btn--active" : ""}"
          title="${isPinned ? "Unpin" : "Pin to top"}"
          aria-pressed="${isPinned}"
          @click=${(e: Event) => {
            e.stopPropagation();
            if (isPinned) _pinnedIds.delete(entry.taskId); else _pinnedIds.add(entry.taskId);
            _rerender();
          }}>
          ${ICON_PIN}<span class="rcf-action-label">${isPinned ? "Unpin" : "Pin"}</span>
        </button>
        <button class="rcf-action-btn rcf-action-btn--danger" title="Hide from feed"
          @click=${(e: Event) => {
            e.stopPropagation();
            _hiddenIds.add(entry.taskId);
            _rerender();
          }}>
          ${ICON_HIDE}<span class="rcf-action-label">Hide</span>
        </button>
      </div>
    </div>
  `;
}

// ── Compact row (dashboard / compact mode) ────────────────────

function renderCompactRow(
  entry: RecentlyCompletedEntry,
  onNavigate?: (taskId: string, projectId: string | null) => void,
): TemplateResult {
  const isNew    = _newEntryIds.has(entry.taskId);
  const isPinned = _pinnedIds.has(entry.taskId);
  const color    = entryStatusColor(entry);
  const dur      = formatDuration(entry.durationMs);

  return html`
    <div
      class="rcf-row ${isNew ? "rcf-row--new" : ""} ${isPinned ? "rcf-row--pinned" : ""}"
      style="--rcf-status-color:${color}"
      title="${entry.description ?? entry.title}"
      @click=${() => onNavigate?.(entry.taskId, entry.projectId ?? null)}
      role="${onNavigate ? "button" : "listitem"}"
      tabindex="${onNavigate ? "0" : "-1"}"
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter" && onNavigate) {
          e.preventDefault();
          onNavigate(entry.taskId, entry.projectId ?? null);
        }
      }}
    >
      <span class="rcf-row-check" style="color:${color}">${ICON_CHECK}</span>
      <span class="rcf-row-title">${entry.title}</span>
      ${(() => {
        const rev = getReviewBadgeByLabel(entry.title);
        if (!rev) return nothing;
        return html`<a class="rcf-review-badge" @click=${(e: Event) => {
          e.stopPropagation();
          history.pushState({}, '', `/oversight#review-${rev.runId}`);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }}>Review</a>`;
      })()}
      <span class="rcf-project-chip">${entry.projectName}</span>
      ${renderRcfNodeChip(entry)}
      <span class="rcf-time-ago">${timeAgo(entry.completedAt)}</span>
      ${dur ? html`
        <span class="rcf-duration-pill" style="border-color:${color}33;color:${color};">${dur}</span>
      ` : nothing}
      <div class="rcf-row-actions">
        <button class="rcf-row-action-btn" title="${isPinned ? "Unpin" : "Pin"}"
          @click=${(e: Event) => {
            e.stopPropagation();
            if (isPinned) _pinnedIds.delete(entry.taskId); else _pinnedIds.add(entry.taskId);
            _rerender();
          }}>${ICON_PIN}</button>
        <button class="rcf-row-action-btn" title="Hide"
          @click=${(e: Event) => {
            e.stopPropagation();
            _hiddenIds.add(entry.taskId);
            _rerender();
          }}>${ICON_HIDE}</button>
      </div>
    </div>
  `;
}

// ── Empty state ───────────────────────────────────────────────

function renderEmptyState(
  onNavigate?: (taskId: string, projectId: string | null) => void,
): TemplateResult {
  const hasActiveFilters = _dateFilter !== "all" || _statusFilter !== "all" || _searchQuery !== "" || _selectedProjects.size > 0;

  if (hasActiveFilters) {
    return html`
      <div class="rcf-empty">
        <span class="rcf-empty-icon">
          ${ICON_SEARCH}
        </span>
        <p class="rcf-empty-text">No results match your filters.</p>
        <button class="rcf-empty-cta" @click=${() => {
          _dateFilter = "all"; _statusFilter = "all"; _searchQuery = ""; _selectedProjects.clear();
          _rerender();
        }}>Clear filters</button>
      </div>
    `;
  }

  return html`
    <div class="rcf-empty">
      <span class="rcf-empty-icon">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
      </span>
      <p class="rcf-empty-text">No completed work in the last 24h.</p>
      <p class="rcf-empty-sub">Spawn an agent to get started.</p>
      <button class="rcf-empty-cta" @click=${() => onNavigate?.("__spawn__", null)}>
        ${ICON_SPAWN} Spawn an agent
      </button>
    </div>
  `;
}

// ── Skeleton loading ──────────────────────────────────────────

function renderSkeletonLoading(density: RCFDensity): TemplateResult {
  const count = density === "comfortable" ? 3 : 5;
  return html`
    <div class="rcf-skeleton-list">
      ${Array.from({ length: count }, (_, i) => html`
        <div
          class="rcf-skeleton ${density === "comfortable" ? "rcf-skeleton--card" : "rcf-skeleton--row"}"
          style="animation-delay:${i * 0.08}s"
        >
          <div class="rcf-skel-line rcf-skel-title" style="width:${60 + (i % 3) * 12}%"></div>
          ${density === "comfortable" ? html`
            <div class="rcf-skel-line rcf-skel-desc" style="width:${40 + (i % 2) * 20}%"></div>
          ` : nothing}
          <div class="rcf-skel-row">
            <div class="rcf-skel-chip"></div>
            <div class="rcf-skel-chip" style="width:36px"></div>
          </div>
        </div>
      `)}
    </div>
  `;
}

// ── Error state ───────────────────────────────────────────────

function renderErrorState(error: string): TemplateResult {
  return html`
    <div class="rcf-error-card">
      <span class="rcf-error-icon">${ICON_ALERT}</span>
      <p class="rcf-error-msg">${error}</p>
      <button class="rcf-error-retry" @click=${() => retryLoad()}>Retry</button>
    </div>
  `;
}

// ── Styles ────────────────────────────────────────────────────
// The full selector set is inlined here (not just keyframes) because this
// feed is rendered inside <gpu-animation-panel> inside the masonry-grid
// shadow DOM — global layout.css selectors do not pierce the shadow root,
// so without this block the cards came out as bare grey buttons with no
// glass treatment in the grid activity panel.

function rcfStyles(): TemplateResult {
  return html`<style>
    @keyframes rcf-expand {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes rcf-card-new {
      from { opacity: 0; transform: translateY(-10px) scale(0.98); }
      to   { opacity: 1; transform: translateY(0)    scale(1); }
    }
    @keyframes rcf-highlight {
      0%   { background: color-mix(in srgb, var(--rcf-status-color, #10b981) 18%, transparent); }
      100% { background: transparent; }
    }
    @keyframes rcf-pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.3; }
    }
    @keyframes rcf-shimmer {
      0%   { background-position: -400% 0; }
      100% { background-position:  400% 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .rcf-row--new, .rcf-card--new { animation: none !important; }
      .rcf-body { animation: none !important; }
    }

    /* ── List ── */
    .rcf-list { display: flex; flex-direction: column; }
    .rcf-list--comfortable {
      gap: 8px;
      padding: 10px 12px;
      max-height: 520px;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.10) transparent;
    }
    .rcf-list--comfortable::-webkit-scrollbar { width: 4px; }
    .rcf-list--comfortable::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 2px; }

    /* ── Card item (glassmorphism) ── */
    .rcf-card {
      position: relative;
      background: linear-gradient(135deg, rgba(255,255,255,0.055) 0%, rgba(255,255,255,0.018) 100%);
      backdrop-filter: blur(20px) saturate(160%);
      -webkit-backdrop-filter: blur(20px) saturate(160%);
      border: 1px solid var(--g-border, rgba(255,255,255,0.10));
      border-radius: 8px;
      padding: 12px 14px 10px;
      overflow: visible;
      box-shadow:
        0 4px 20px rgba(0,0,0,0.32),
        inset 0 1px 0 rgba(255,255,255,0.09),
        inset 0 -1px 0 rgba(0,0,0,0.18);
      transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
    }
    .rcf-card:hover {
      transform: translateY(-2px);
      border-color: color-mix(in srgb, var(--rcf-status-color, #10b981) 38%, transparent);
      box-shadow:
        0 8px 32px rgba(0,0,0,0.42),
        0 0 18px color-mix(in srgb, var(--rcf-status-color, #10b981) 12%, transparent),
        inset 0 1px 0 rgba(255,255,255,0.13),
        inset 0 -1px 0 rgba(0,0,0,0.22);
    }
    .rcf-card--new { animation: rcf-card-new 0.35s ease-out; }
    .rcf-card--pinned { border-color: color-mix(in srgb, #22d3ee 30%, transparent); }

    .rcf-corner {
      position: absolute;
      width: 10px; height: 10px;
      pointer-events: none;
      z-index: 2;
    }
    .rcf-tl {
      top: -1px; left: -1px;
      border-top: 1.5px solid var(--rcf-status-color, #10b981);
      border-left: 1.5px solid var(--rcf-status-color, #10b981);
    }
    .rcf-br {
      bottom: -1px; right: -1px;
      border-bottom: 1.5px solid var(--rcf-status-color, #10b981);
      border-right: 1.5px solid var(--rcf-status-color, #10b981);
    }

    .rcf-card-hdr { display: flex; align-items: center; gap: 8px; }
    .rcf-pin-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: #22d3ee;
      box-shadow: 0 0 6px #22d3ee;
      flex-shrink: 0;
    }
    .rcf-card-title-btn {
      display: flex;
      align-items: center;
      gap: 7px;
      background: none;
      border: none;
      padding: 0;
      cursor: pointer;
      flex: 1;
      min-width: 0;
      text-align: left;
    }
    .rcf-card-check { color: var(--rcf-status-color, #10b981); display: flex; flex-shrink: 0; }
    .rcf-card-title {
      font-size: 0.88rem;
      font-weight: 600;
      color: var(--g-fg, rgba(245,245,244,0.95));
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      line-height: 1.3;
    }
    .rcf-card-title-btn:hover .rcf-card-title { color: #fff; }
    .rcf-review-badge {
      display: inline-flex; align-items: center;
      font-size: 0.57rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase;
      font-family: var(--g-mono-family, 'JetBrains Mono', monospace);
      color: #818cf8; background: rgba(129,140,248,0.12); border: 1px solid rgba(129,140,248,0.35);
      border-radius: 4px; padding: 2px 6px; text-decoration: none; flex-shrink: 0;
      cursor: pointer; transition: background 120ms, border-color 120ms;
    }
    .rcf-review-badge:hover {
      background: rgba(129,140,248,0.22); border-color: rgba(129,140,248,0.6);
    }
    .rcf-status-pill {
      font-size: 0.55rem;
      font-family: var(--g-mono-family, 'JetBrains Mono', 'SF Mono', monospace);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 4px;
      border: 1px solid;
      flex-shrink: 0;
      line-height: 1.5;
    }

    .rcf-card-desc {
      margin: 6px 0 0;
      font-size: 0.73rem;
      color: var(--g-fg-dim, rgba(245,245,244,0.55));
      line-height: 1.45;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    .rcf-card-ftr {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 8px;
      flex-wrap: wrap;
    }
    .rcf-card-spacer { flex: 1; }
    .rcf-assignee-chip {
      font-size: 0.62rem;
      padding: 1px 6px;
      border-radius: 4px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.10);
      color: var(--g-fg-dim, rgba(245,245,244,0.55));
      font-weight: 500;
    }

    /* ── Action row (glass buttons, status-tinted on hover) ── */
    .rcf-actions {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
      padding-top: 0;
      max-height: 0;
      overflow: hidden;
      opacity: 0;
      border-top: 0px solid transparent;
      transition: max-height 0.2s ease, opacity 0.2s ease, padding-top 0.2s ease, border-top-width 0.2s;
    }
    .rcf-card:hover .rcf-actions {
      max-height: 44px;
      opacity: 1;
      padding-top: 8px;
      border-top-width: 1px;
      border-top-color: var(--g-border, rgba(255,255,255,0.08));
    }
    .rcf-action-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 9px;
      border-radius: 6px;
      background: linear-gradient(135deg, rgba(255,255,255,0.045), rgba(255,255,255,0.015));
      backdrop-filter: blur(8px) saturate(140%);
      -webkit-backdrop-filter: blur(8px) saturate(140%);
      border: 1px solid rgba(255,255,255,0.10);
      color: var(--g-fg-dim, rgba(245,245,244,0.62));
      font-size: 0.65rem;
      font-weight: 500;
      letter-spacing: 0.02em;
      cursor: pointer;
      transition: color 0.12s, background 0.12s, border-color 0.12s, box-shadow 0.12s, transform 0.12s;
      white-space: nowrap;
      font-family: inherit;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.05);
    }
    .rcf-action-btn:hover {
      background: linear-gradient(135deg,
        color-mix(in srgb, var(--rcf-status-color, #10b981) 18%, rgba(255,255,255,0.06)),
        color-mix(in srgb, var(--rcf-status-color, #10b981) 6%, rgba(255,255,255,0.02)));
      border-color: color-mix(in srgb, var(--rcf-status-color, #10b981) 45%, transparent);
      color: #fff;
      transform: translateY(-1px);
      box-shadow:
        0 4px 12px color-mix(in srgb, var(--rcf-status-color, #10b981) 14%, transparent),
        inset 0 1px 0 rgba(255,255,255,0.10);
    }
    .rcf-action-btn:active { transform: translateY(0); }
    .rcf-action-btn--active {
      color: #22d3ee;
      border-color: rgba(34,211,238,0.38);
      background: linear-gradient(135deg, rgba(34,211,238,0.16), rgba(34,211,238,0.05));
      box-shadow: 0 0 12px rgba(34,211,238,0.18), inset 0 1px 0 rgba(255,255,255,0.10);
    }
    .rcf-action-btn--danger:hover {
      color: #fff;
      border-color: rgba(239,68,68,0.55);
      background: linear-gradient(135deg, rgba(239,68,68,0.20), rgba(239,68,68,0.06));
      box-shadow: 0 4px 12px rgba(239,68,68,0.20), inset 0 1px 0 rgba(255,255,255,0.10);
    }
    .rcf-action-label { font-size: 0.64rem; }

    /* ── Shared pills ── */
    .rcf-project-chip {
      font-size: 0.62rem;
      padding: 1px 6px;
      border-radius: 4px;
      background: color-mix(in srgb, #a855f7 12%, transparent);
      border: 1px solid color-mix(in srgb, #a855f7 28%, transparent);
      color: #a855f7;
      flex-shrink: 0;
      max-width: 100px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
      font-family: var(--g-mono-family, 'JetBrains Mono', monospace);
    }
    .rcf-time-ago {
      font-size: 0.63rem;
      color: var(--g-fg-dim, #71717a);
      flex-shrink: 0;
      min-width: 44px;
      text-align: right;
      font-family: var(--g-mono-family, 'JetBrains Mono', monospace);
    }
    .rcf-duration-pill {
      font-size: 0.60rem;
      padding: 1px 6px;
      border-radius: 999px;
      border: 1px solid;
      font-weight: 600;
      flex-shrink: 0;
      letter-spacing: 0.02em;
      font-family: var(--g-mono-family, 'JetBrains Mono', monospace);
      color: var(--rcf-status-color, #10b981);
      border-color: color-mix(in srgb, var(--rcf-status-color, #10b981) 35%, transparent);
      background: color-mix(in srgb, var(--rcf-status-color, #10b981) 10%, transparent);
    }
  </style>`;
}
