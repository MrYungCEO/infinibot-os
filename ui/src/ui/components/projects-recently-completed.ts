/**
 * Projects Page — Recently Completed Component
 *
 * Polished glass-card revamp of the recently-completed list shown on the
 * Projects (kanban gallery) page.  Separate from the activity-page feed
 * (recently-completed-feed.ts, owned by PID 1446263 — do not import from
 * or modify that file from here).
 *
 * Self-contained: maintains its own state, makes its own API call, and
 * subscribes to kanban:task:completed WS events independently.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";

// ── Types ──────────────────────────────────────────────────────────────────

export interface PrcEntry {
  taskId: string;
  projectId: string | null;
  projectName: string;
  title: string;
  assignee?: string;
  priority?: string;
  completedAt: number;
  durationMs: number;
  description?: string;
  status?: string;
}

type TimeFilter   = "all" | "today" | "week";
type SortOption   = "newest" | "oldest" | "longest" | "project";
type GroupMode    = "project" | "date" | "flat";
export type Density = "comfortable" | "compact";

// ── Module-level state (data) ──────────────────────────────────────────────

let _entries:         PrcEntry[]    = [];
let _loading          = false;
let _error:           string | null = null;
let _wsUnsub:         (() => void) | null = null;
let _newIds           = new Set<string>();
let _animFlushTimer:  ReturnType<typeof setTimeout> | null = null;
let _requestUpdate:   (() => void) | null = null;
let _tickerHandle:    number | null = null;
let _initialized      = false;

// ── Module-level state (UI) ────────────────────────────────────────────────

let _timeFilter:    TimeFilter  = "all";
let _sort:          SortOption  = "newest";
let _group:         GroupMode   = "project";
let _search         = "";
let _projectFilter  = new Set<string>();
let _agentFilter:   string | null = null;
let _pinnedIds      = new Set<string>();
let _expandedIds    = new Set<string>();

// ── Panel collapse state ────────────────────────────────────────────────────

const PANEL_STORAGE_KEY = "projects.recently_completed.expanded";
let _panelExpanded: boolean = (() => {
  try { return localStorage.getItem(PANEL_STORAGE_KEY) === "true"; } catch { return false; }
})();

function togglePanel(): void {
  _panelExpanded = !_panelExpanded;
  try { localStorage.setItem(PANEL_STORAGE_KEY, String(_panelExpanded)); } catch { /* noop */ }
  rerender();
}

// ── Internals ──────────────────────────────────────────────────────────────

function rerender(): void { _requestUpdate?.(); }

// ── Init / teardown ────────────────────────────────────────────────────────

export function initProjectsRecentlyCompleted(
  client: GatewayBrowserClient,
  requestUpdate: () => void,
): void {
  _requestUpdate = requestUpdate;

  if (!_initialized) {
    _initialized = true;
    _loading = true;
    rerender();

    void client.request("kanban.listRecentlyCompleted", { limit: 50 })
      .then((res: unknown) => {
        const r = res as { entries?: PrcEntry[] } | null;
        if (r && Array.isArray(r.entries)) _entries = r.entries;
        _error   = null;
      })
      .catch((err: unknown) => {
        _error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        _loading = false;
        rerender();
      });

    _wsUnsub = client.subscribe((evt: { type: string; payload?: unknown }) => {
      if (evt.type !== "kanban:task:completed") return;
      const entry = evt.payload as PrcEntry | null;
      if (!entry?.taskId) return;
      _entries = [entry, ..._entries.filter((e) => e.taskId !== entry.taskId)].slice(0, 50);
      _newIds.add(entry.taskId);
      if (_animFlushTimer !== null) clearTimeout(_animFlushTimer);
      _animFlushTimer = setTimeout(() => {
        _newIds.clear();
        _animFlushTimer = null;
        rerender();
      }, 800);
      rerender();
    });

    _tickerHandle = window.setInterval(() => rerender(), 30_000);
  }
}

export function teardownProjectsRecentlyCompleted(): void {
  _wsUnsub?.();
  _wsUnsub = null;
  if (_tickerHandle !== null) { window.clearInterval(_tickerHandle); _tickerHandle = null; }
  _initialized = false;
  _entries     = [];
  _loading     = false;
  _error       = null;
}

// ── Formatters ─────────────────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 5_000)        return "just now";
  if (d < 60_000)       return `${Math.floor(d / 1_000)}s ago`;
  if (d < 3_600_000)    return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000)   return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtDur(ms: number): string {
  if (!ms || ms <= 0) return "";
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function isToday(ts: number): boolean {
  const d = new Date(ts), n = new Date();
  return d.getDate() === n.getDate() && d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear();
}

function isThisWeek(ts: number): boolean { return Date.now() - ts < 7 * 86_400_000; }

function dateBucket(ts: number): string {
  if (isToday(ts)) return "Today";
  if (Date.now() - ts < 2 * 86_400_000) return "Yesterday";
  return new Date(ts).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

// ── Filter + sort + group ──────────────────────────────────────────────────

function applyFilters(entries: PrcEntry[]): PrcEntry[] {
  let out = [...entries];

  // Pinned entries always float to top
  const pinned   = out.filter((e) => _pinnedIds.has(e.taskId));
  const unpinned = out.filter((e) => !_pinnedIds.has(e.taskId));
  out = [...pinned, ...unpinned];

  if (_timeFilter === "today") out = out.filter((e) => isToday(e.completedAt));
  else if (_timeFilter === "week") out = out.filter((e) => isThisWeek(e.completedAt));

  if (_projectFilter.size > 0)
    out = out.filter((e) => _projectFilter.has(e.projectId ?? e.projectName));

  if (_agentFilter)
    out = out.filter((e) => e.assignee === _agentFilter);

  if (_search.trim()) {
    const q = _search.toLowerCase();
    out = out.filter((e) =>
      e.title.toLowerCase().includes(q) ||
      e.projectName.toLowerCase().includes(q) ||
      (e.description ?? "").toLowerCase().includes(q) ||
      (e.assignee ?? "").toLowerCase().includes(q),
    );
  }

  switch (_sort) {
    case "newest":  out.sort((a, b) => b.completedAt - a.completedAt); break;
    case "oldest":  out.sort((a, b) => a.completedAt - b.completedAt); break;
    case "longest": out.sort((a, b) => b.durationMs  - a.durationMs);  break;
    case "project": out.sort((a, b) => a.projectName.localeCompare(b.projectName)); break;
  }

  return out;
}

function groupEntries(entries: PrcEntry[]): Array<{ label: string; items: PrcEntry[] }> {
  if (_group === "flat") return [{ label: "", items: entries }];
  const map = new Map<string, PrcEntry[]>();
  for (const e of entries) {
    const key = _group === "project" ? (e.projectName || "No Project") : dateBucket(e.completedAt);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(e);
  }
  return Array.from(map.entries()).map(([label, items]) => ({ label, items }));
}

// ── Main export ────────────────────────────────────────────────────────────

export function renderProjectsRecentlyCompleted(opts: {
  density?: Density;
  onNavigateToTask?: (taskId: string, projectId: string | null) => void;
  onNavigateToProject?: (projectId: string) => void;
}): TemplateResult {
  const { density = "comfortable", onNavigateToTask, onNavigateToProject } = opts;

  const todayCount  = _entries.filter((e) => isToday(e.completedAt)).length;
  const weekCount   = _entries.filter((e) => isThisWeek(e.completedAt)).length;
  const totalCount  = _entries.length;

  const filtered = applyFilters(_entries);
  const groups   = groupEntries(filtered);

  const allProjects = [...new Map(_entries.map((e) => [e.projectId ?? e.projectName, e.projectName])).entries()];
  const allAgents   = [...new Set(_entries.map((e) => e.assignee).filter(Boolean))] as string[];

  return html`
    ${prcStyles()}
    <div class="prc-root" aria-label="Recently completed tasks">

      <!-- ── Collapsed header (always visible, 42px) ── -->
      <button
        class="prc-collapse-header"
        @click=${togglePanel}
        aria-expanded="${_panelExpanded}"
        title="${_panelExpanded ? "Collapse recently completed tasks" : "Expand recently completed tasks"}"
      >
        <span class="prc-topbar-icon" aria-hidden="true">✓</span>
        <span class="prc-topbar-title">Recently Completed</span>
        ${todayCount > 0 ? html`
          <span class="prc-count-badge">${todayCount} today</span>
        ` : nothing}
        ${weekCount > todayCount && weekCount > 0 ? html`
          <span class="prc-count-badge prc-count-badge--week">${weekCount} this week</span>
        ` : nothing}
        ${totalCount > 0 && todayCount === 0 ? html`
          <span class="prc-count-badge prc-count-badge--total">${totalCount}</span>
        ` : nothing}
        ${_loading ? html`<span class="prc-spinner" aria-label="Loading" role="status"></span>` : nothing}
        <span class="prc-chevron${_panelExpanded ? " prc-chevron--up" : ""}" aria-hidden="true">›</span>
      </button>

      <!-- ── Expandable panel body ── -->
      <div class="prc-panel-body${_panelExpanded ? " prc-panel-body--open" : ""}" aria-hidden="${!_panelExpanded}">
        ${_panelExpanded ? html`
          ${renderTopBar(todayCount, weekCount, allProjects, allAgents)}
          <div class="prc-body prc-body--scrollable">
            ${_loading && _entries.length === 0 ? renderSkeletons() : nothing}
            ${_error ? renderErrorCard() : nothing}
            ${!_loading && !_error && _entries.length === 0 ? renderEmpty() : nothing}
            ${!_error && filtered.length === 0 && _entries.length > 0 ? html`
              <div class="prc-no-match">No tasks match the current filters.
                <button class="prc-chip-clear" @click=${() => {
                  _timeFilter = "all"; _projectFilter = new Set(); _agentFilter = null; _search = ""; rerender();
                }}>Clear all</button>
              </div>
            ` : nothing}
            ${groups.map(({ label, items }) =>
              renderGroup(label, items, density, onNavigateToTask, onNavigateToProject)
            )}
          </div>
        ` : nothing}
      </div>

    </div>
  `;
}

// ── Top bar (header + filters + controls) ─────────────────────────────────

function renderTopBar(
  todayCount: number,
  weekCount: number,
  allProjects: [string, string][],
  allAgents: string[],
): TemplateResult {
  return html`
    <div class="prc-topbar">
      <div class="prc-topbar-left">
        <span class="prc-topbar-icon" aria-hidden="true">✓</span>
        <span class="prc-topbar-title">Recently Completed</span>
        ${todayCount > 0 ? html`
          <span class="prc-count-badge">${todayCount} today</span>
        ` : nothing}
        ${weekCount > todayCount && weekCount > 0 ? html`
          <span class="prc-count-badge prc-count-badge--week">${weekCount} this week</span>
        ` : nothing}
        ${_loading ? html`<span class="prc-spinner" aria-label="Loading" role="status"></span>` : nothing}
      </div>

      <div class="prc-topbar-right">
        <!-- Search -->
        <input
          class="prc-search"
          type="search"
          placeholder="Search tasks…"
          .value=${_search}
          @input=${(e: Event) => { _search = (e.target as HTMLInputElement).value; rerender(); }}
          aria-label="Search completed tasks"
        />

        <!-- Sort -->
        <select
          class="prc-sort-select"
          @change=${(e: Event) => { _sort = (e.target as HTMLSelectElement).value as SortOption; rerender(); }}
          aria-label="Sort order"
        >
          <option value="newest"  ?selected=${_sort === "newest"}>Newest first</option>
          <option value="oldest"  ?selected=${_sort === "oldest"}>Oldest first</option>
          <option value="longest" ?selected=${_sort === "longest"}>Longest</option>
          <option value="project" ?selected=${_sort === "project"}>Project A–Z</option>
        </select>

        <!-- Group toggle -->
        <div class="prc-group-toggle" role="group" aria-label="Group by">
          <button class="prc-gtbtn ${_group === "project" ? "active" : ""}"
            @click=${() => { _group = "project"; rerender(); }}>⬡ Project</button>
          <button class="prc-gtbtn ${_group === "date" ? "active" : ""}"
            @click=${() => { _group = "date"; rerender(); }}>📅 Date</button>
          <button class="prc-gtbtn ${_group === "flat" ? "active" : ""}"
            @click=${() => { _group = "flat"; rerender(); }}>≡ Flat</button>
        </div>
      </div>
    </div>

    <!-- Filter chips row -->
    ${renderFilterChips(allProjects, allAgents)}
  `;
}

function renderFilterChips(allProjects: [string, string][], allAgents: string[]): TemplateResult {
  if (allProjects.length === 0 && allAgents.length === 0) return html``;
  return html`
    <div class="prc-filters" role="group" aria-label="Filter completed tasks">
      <!-- Time chips -->
      <div class="prc-fgroup">
        ${(["all", "today", "week"] as TimeFilter[]).map((t) => html`
          <button class="prc-chip ${_timeFilter === t ? "active" : ""}"
            @click=${() => { _timeFilter = t; rerender(); }}>
            ${t === "all" ? "All time" : t === "today" ? "Today" : "This week"}
          </button>
        `)}
      </div>

      <!-- Project chips (up to 6) -->
      ${allProjects.length > 1 ? html`
        <div class="prc-fgroup">
          ${allProjects.slice(0, 6).map(([id, name]) => html`
            <button
              class="prc-chip prc-chip--project ${_projectFilter.has(id) ? "active" : ""}"
              @click=${() => {
                const s = new Set(_projectFilter);
                s.has(id) ? s.delete(id) : s.add(id);
                _projectFilter = s;
                rerender();
              }}
              title="Filter by project: ${name}"
            >${name.length > 14 ? name.slice(0, 12) + "…" : name}</button>
          `)}
        </div>
      ` : nothing}

      <!-- Agent chips (up to 4) -->
      ${allAgents.length > 1 ? html`
        <div class="prc-fgroup">
          <button class="prc-chip ${_agentFilter === null ? "active" : ""}"
            @click=${() => { _agentFilter = null; rerender(); }}>All agents</button>
          ${allAgents.slice(0, 4).map((a) => html`
            <button class="prc-chip prc-chip--agent ${_agentFilter === a ? "active" : ""}"
              @click=${() => { _agentFilter = _agentFilter === a ? null : a; rerender(); }}>
              ${a}
            </button>
          `)}
        </div>
      ` : nothing}
    </div>
  `;
}

// ── Group wrapper ──────────────────────────────────────────────────────────

function renderGroup(
  label: string,
  items: PrcEntry[],
  density: Density,
  onNavigateToTask?: (taskId: string, projectId: string | null) => void,
  onNavigateToProject?: (projectId: string) => void,
): TemplateResult {
  return html`
    <div class="prc-group">
      ${label ? html`<div class="prc-group-label">${label} <span class="prc-group-count">${items.length}</span></div>` : nothing}
      <div class="prc-cards ${density === "compact" ? "prc-cards--compact" : ""}">
        ${items.map((e) => renderCard(e, density, onNavigateToTask, onNavigateToProject))}
      </div>
    </div>
  `;
}

// ── Individual card ────────────────────────────────────────────────────────

function renderCard(
  entry: PrcEntry,
  density: Density,
  onNavigateToTask?: (taskId: string, projectId: string | null) => void,
  onNavigateToProject?: (projectId: string) => void,
): TemplateResult {
  const isNew      = _newIds.has(entry.taskId);
  const isPinned   = _pinnedIds.has(entry.taskId);
  const isExpanded = _expandedIds.has(entry.taskId);
  const dur        = fmtDur(entry.durationMs);
  const ts         = fmtTime(entry.completedAt);
  const ago        = timeAgo(entry.completedAt);

  return html`
    <div
      class="prc-card ${isNew ? "prc-card--new" : ""} ${isPinned ? "prc-card--pinned" : ""} ${density === "compact" ? "prc-card--compact" : ""}"
      role="article"
      tabindex="0"
      aria-label="${entry.title}"
      @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") onNavigateToTask?.(entry.taskId, entry.projectId ?? null); }}
    >
      <!-- Corner brackets (sci-fi HUD accent) -->
      <span class="prc-corner prc-corner--tl" aria-hidden="true"></span>
      <span class="prc-corner prc-corner--br" aria-hidden="true"></span>

      <!-- Header: done mark + title + status pill -->
      <div class="prc-card-header">
        <span class="prc-done-mark" aria-hidden="true">✓</span>
        <span
          class="prc-card-title"
          role="button"
          tabindex="-1"
          title="Open task: ${entry.title}"
          @click=${(e: Event) => { e.stopPropagation(); onNavigateToTask?.(entry.taskId, entry.projectId ?? null); }}
        >${entry.title}</span>
        <span class="prc-status-pill">DONE</span>
        ${isPinned ? html`<span class="prc-pin-indicator" title="Pinned" aria-label="pinned">📌</span>` : nothing}
      </div>

      <!-- Description (compact: hidden; comfortable: collapsible) -->
      ${density === "comfortable" && entry.description ? html`
        <div
          class="prc-desc ${isExpanded ? "prc-desc--expanded" : ""}"
          role="button"
          tabindex="0"
          aria-expanded="${isExpanded}"
          title="${isExpanded ? "Collapse description" : "Expand description"}"
          @click=${(e: Event) => {
            e.stopPropagation();
            const s = new Set(_expandedIds);
            s.has(entry.taskId) ? s.delete(entry.taskId) : s.add(entry.taskId);
            _expandedIds = s;
            rerender();
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault(); e.stopPropagation();
              const s = new Set(_expandedIds);
              s.has(entry.taskId) ? s.delete(entry.taskId) : s.add(entry.taskId);
              _expandedIds = s;
              rerender();
            }
          }}
        >${entry.description}</div>
      ` : nothing}

      <!-- Property row -->
      <div class="prc-props">
        ${entry.projectName ? html`
          <span
            class="prc-prop prc-prop--project ${entry.projectId ? "prc-prop--clickable" : ""}"
            role="${entry.projectId ? "button" : "text"}"
            tabindex="${entry.projectId ? "0" : "-1"}"
            title="Project: ${entry.projectName}"
            @click=${(e: Event) => {
              if (!entry.projectId) return;
              e.stopPropagation();
              onNavigateToProject?.(entry.projectId);
            }}
            @keydown=${(e: KeyboardEvent) => {
              if ((e.key === "Enter" || e.key === " ") && entry.projectId) {
                e.preventDefault(); e.stopPropagation();
                onNavigateToProject?.(entry.projectId);
              }
            }}
          >⬡ ${entry.projectName}</span>
        ` : nothing}

        ${entry.assignee ? html`
          <span class="prc-prop prc-prop--agent" title="Agent: ${entry.assignee}">⚡ ${entry.assignee}</span>
        ` : nothing}

        ${dur ? html`
          <span class="prc-prop prc-prop--dur" title="Duration: ${dur}">⏱ ${dur}</span>
        ` : nothing}

        <span class="prc-prop prc-prop--time" title="${new Date(entry.completedAt).toLocaleString()}">
          ${ts} · ${ago}
        </span>
      </div>

      <!-- Action row (CSS hover-reveal) -->
      <div class="prc-actions" role="group" aria-label="Actions for ${entry.title}">
        <button
          class="prc-act"
          @click=${(e: Event) => { e.stopPropagation(); onNavigateToTask?.(entry.taskId, entry.projectId ?? null); }}
        >Open task</button>

        ${entry.projectId ? html`
          <button
            class="prc-act"
            @click=${(e: Event) => { e.stopPropagation(); onNavigateToProject?.(entry.projectId!); }}
          >View project</button>
        ` : nothing}

        <button
          class="prc-act ${isPinned ? "prc-act--active" : ""}"
          @click=${(e: Event) => {
            e.stopPropagation();
            const s = new Set(_pinnedIds);
            s.has(entry.taskId) ? s.delete(entry.taskId) : s.add(entry.taskId);
            _pinnedIds = s;
            rerender();
          }}
        >${isPinned ? "Unpin" : "Pin"}</button>
      </div>
    </div>
  `;
}

// ── Skeleton loading cards ─────────────────────────────────────────────────

function renderSkeletons(): TemplateResult {
  return html`
    <div class="prc-cards">
      ${([80, 65, 75] as const).map((w) => html`
        <div class="prc-card prc-card--skeleton" aria-hidden="true">
          <span class="prc-corner prc-corner--tl"></span>
          <span class="prc-corner prc-corner--br"></span>
          <div class="prc-skel-line" style="width:${w}%;height:14px;"></div>
          <div class="prc-skel-line" style="width:55%;height:10px;margin-top:10px;"></div>
          <div class="prc-skel-line" style="width:90%;height:9px;margin-top:4px;"></div>
        </div>
      `)}
    </div>
  `;
}

// ── Empty state ────────────────────────────────────────────────────────────

function renderEmpty(): TemplateResult {
  return html`
    <div class="prc-card prc-empty-card">
      <span class="prc-corner prc-corner--tl" aria-hidden="true"></span>
      <span class="prc-corner prc-corner--br" aria-hidden="true"></span>
      <div class="prc-empty-icon" aria-hidden="true">✓</div>
      <div class="prc-empty-title">No completed work yet</div>
      <div class="prc-empty-sub">Completed tasks across all projects will appear here as your agents finish work.</div>
    </div>
  `;
}

// ── Error state ────────────────────────────────────────────────────────────

function renderErrorCard(): TemplateResult {
  return html`
    <div class="prc-card prc-error-card">
      <span class="prc-corner prc-corner--tl" aria-hidden="true"></span>
      <span class="prc-corner prc-corner--br" aria-hidden="true"></span>
      <div class="prc-error-icon" aria-hidden="true">⚠</div>
      <div class="prc-error-msg">${_error}</div>
      <button class="prc-act" style="margin-top:10px;" @click=${() => {
        _error = null; _initialized = false;
        rerender();
      }}>Retry</button>
    </div>
  `;
}

// ── Scoped styles ──────────────────────────────────────────────────────────

function prcStyles(): TemplateResult {
  return html`<style>
/* ── Projects Recently Completed — scoped to .prc-root ── */

.prc-root {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  margin: 0 0 6px;
}

/* ─── Collapse header (always-visible 42px bar) ─── */
.prc-collapse-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 42px;
  padding: 0 12px;
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  outline: none;
  color: inherit;
  font-family: inherit;
  transition: background 0.15s ease, border-color 0.15s ease;
  box-sizing: border-box;
}
.prc-collapse-header:hover {
  background: rgba(255,255,255,0.06);
  border-color: rgba(34,211,238,0.22);
}
.prc-collapse-header:focus-visible {
  border-color: rgba(34,211,238,0.5);
  box-shadow: 0 0 0 2px rgba(34,211,238,0.18);
}

/* push chevron to the far right */
.prc-collapse-header .prc-chevron {
  margin-left: auto;
  font-size: 18px;
  color: #52525b;
  transform: rotate(90deg);
  transition: transform 0.2s ease, color 0.15s ease;
  line-height: 1;
  flex-shrink: 0;
}
@media (prefers-reduced-motion: reduce) {
  .prc-collapse-header .prc-chevron { transition: none; }
}
.prc-collapse-header .prc-chevron--up {
  transform: rotate(-90deg);
  color: #22d3ee;
}
.prc-collapse-header:hover .prc-chevron { color: #a1a1aa; }

.prc-count-badge--total {
  background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.12);
  color: #71717a;
  font-size: 0.62rem;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 999px;
  letter-spacing: 0.05em;
  font-family: 'SF Mono', 'Fira Mono', monospace;
}

/* ─── Panel body (collapses/expands) ─── */
.prc-panel-body {
  overflow: hidden;
  max-height: 0;
  transition: max-height 0.2s ease;
}
@media (prefers-reduced-motion: reduce) {
  .prc-panel-body { transition: none; }
}
.prc-panel-body--open {
  max-height: 340px;
  overflow: hidden;
}

/* scrollable cards area inside expanded panel */
.prc-body--scrollable {
  overflow-y: auto;
  max-height: 210px;
  padding-bottom: 6px;
}
.prc-body--scrollable::-webkit-scrollbar { width: 4px; }
.prc-body--scrollable::-webkit-scrollbar-track { background: transparent; }
.prc-body--scrollable::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 2px; }

/* ─── Top bar ─── */
.prc-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 4px 8px;
}
.prc-topbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.prc-topbar-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.prc-topbar-icon {
  font-size: 14px;
  color: #22d3ee;
  flex-shrink: 0;
}
.prc-topbar-title {
  font-size: 0.85rem;
  font-weight: 700;
  color: #e4e4e7;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  flex-shrink: 0;
}
.prc-count-badge {
  background: color-mix(in srgb, #22d3ee 14%, transparent);
  border: 1px solid color-mix(in srgb, #22d3ee 30%, transparent);
  color: #22d3ee;
  font-size: 0.62rem;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 999px;
  letter-spacing: 0.05em;
  font-family: 'SF Mono', 'Fira Mono', monospace;
}
.prc-count-badge--week {
  background: color-mix(in srgb, #a855f7 12%, transparent);
  border-color: color-mix(in srgb, #a855f7 28%, transparent);
  color: #c084fc;
}
.prc-spinner {
  width: 8px; height: 8px;
  border-radius: 50%;
  border: 1.5px solid rgba(34, 211, 238, 0.3);
  border-top-color: #22d3ee;
  animation: prc-spin 0.8s linear infinite;
  flex-shrink: 0;
}
@keyframes prc-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .prc-spinner { animation: none; background: #22d3ee; }
}

/* Search + sort + group-toggle */
.prc-search {
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 6px;
  color: #e4e4e7;
  font-size: 0.72rem;
  padding: 4px 10px;
  outline: none;
  width: 160px;
  transition: border-color 0.15s, width 0.2s;
  font-family: inherit;
}
.prc-search::placeholder { color: rgba(255,255,255,0.3); }
.prc-search:focus { border-color: rgba(34,211,238,0.45); width: 200px; }

.prc-sort-select {
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 6px;
  color: #a1a1aa;
  font-size: 0.68rem;
  padding: 4px 8px;
  outline: none;
  cursor: pointer;
  font-family: 'SF Mono', 'Fira Mono', monospace;
}
.prc-sort-select:focus { border-color: rgba(34,211,238,0.4); }

.prc-group-toggle {
  display: flex;
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 6px;
  overflow: hidden;
}
.prc-gtbtn {
  background: transparent;
  border: none;
  border-right: 1px solid rgba(255,255,255,0.08);
  color: #71717a;
  font-size: 0.63rem;
  padding: 4px 9px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
  font-family: 'SF Mono', 'Fira Mono', monospace;
  white-space: nowrap;
}
.prc-gtbtn:last-child { border-right: none; }
.prc-gtbtn:hover { background: rgba(255,255,255,0.06); color: #e4e4e7; }
.prc-gtbtn.active {
  background: color-mix(in srgb, #22d3ee 12%, transparent);
  color: #22d3ee;
}

/* ─── Filter chips ─── */
.prc-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 4px 10px;
}
.prc-fgroup {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.prc-fgroup + .prc-fgroup {
  padding-left: 8px;
  border-left: 1px solid rgba(255,255,255,0.08);
}
.prc-chip {
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: 5px;
  color: #71717a;
  font-size: 0.62rem;
  font-family: 'SF Mono', 'Fira Mono', monospace;
  padding: 3px 9px;
  cursor: pointer;
  transition: all 0.12s;
  white-space: nowrap;
}
.prc-chip:hover { background: rgba(255,255,255,0.08); color: #e4e4e7; }
.prc-chip.active {
  background: color-mix(in srgb, #22d3ee 14%, transparent);
  border-color: color-mix(in srgb, #22d3ee 35%, transparent);
  color: #22d3ee;
}
.prc-chip--project.active {
  background: color-mix(in srgb, #a855f7 12%, transparent);
  border-color: color-mix(in srgb, #a855f7 30%, transparent);
  color: #c084fc;
}
.prc-chip--agent.active {
  background: color-mix(in srgb, #f59e0b 10%, transparent);
  border-color: color-mix(in srgb, #f59e0b 28%, transparent);
  color: #fbbf24;
}
.prc-chip-clear {
  background: none;
  border: none;
  color: #ef4444;
  font-size: 0.68rem;
  cursor: pointer;
  margin-left: 8px;
  text-decoration: underline;
  padding: 0;
}
.prc-chip-clear:hover { color: #f87171; }

/* ─── Body ─── */
.prc-body {
  display: flex;
  flex-direction: column;
  gap: 0;
}

/* ─── Group label ─── */
.prc-group { margin-bottom: 6px; }
.prc-group-label {
  font-size: 0.66rem;
  font-weight: 700;
  color: #52525b;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-family: 'SF Mono', 'Fira Mono', monospace;
  padding: 6px 4px 4px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.prc-group-count {
  background: rgba(255,255,255,0.06);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 0.6rem;
  color: #71717a;
}

/* ─── Cards grid ─── */
.prc-cards {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.prc-cards--compact {
  gap: 3px;
}

/* ─── Individual card ─── */
.prc-card {
  position: relative;
  background: linear-gradient(
    135deg,
    rgba(255,255,255,0.055) 0%,
    rgba(255,255,255,0.025) 100%
  );
  backdrop-filter: blur(20px) saturate(160%);
  -webkit-backdrop-filter: blur(20px) saturate(160%);
  border: 1px solid rgba(34, 211, 238, 0.15);
  border-radius: 10px;
  padding: 12px 14px 10px;
  cursor: default;
  transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
  outline: none;
  overflow: hidden;
  /* Top-light sheen */
  box-shadow:
    0 0 0 0 transparent,
    inset 0 1px 0 rgba(255,255,255,0.07),
    0 2px 8px rgba(0,0,0,0.25);
}
.prc-card:hover {
  transform: translateY(-1px) scale(1.005);
  border-color: rgba(34, 211, 238, 0.35);
  box-shadow:
    0 0 18px rgba(34, 211, 238, 0.12),
    inset 0 1px 0 rgba(255,255,255,0.09),
    0 4px 16px rgba(0,0,0,0.3);
}
.prc-card:focus-visible {
  border-color: rgba(34, 211, 238, 0.55);
  box-shadow: 0 0 0 2px rgba(34, 211, 238, 0.25);
}
.prc-card--compact {
  padding: 7px 12px 6px;
  border-radius: 7px;
}
.prc-card--pinned {
  border-color: rgba(168, 85, 247, 0.35);
  box-shadow:
    0 0 14px rgba(168, 85, 247, 0.10),
    inset 0 1px 0 rgba(255,255,255,0.07),
    0 2px 8px rgba(0,0,0,0.25);
}
.prc-card--pinned:hover {
  border-color: rgba(168, 85, 247, 0.5);
  box-shadow: 0 0 22px rgba(168, 85, 247, 0.18), 0 4px 16px rgba(0,0,0,0.3);
}
.prc-card--new {
  animation: prc-slide-in 0.4s cubic-bezier(0.22, 0.61, 0.36, 1);
}
@keyframes prc-slide-in {
  from { opacity: 0; transform: translateY(-8px); }
  to   { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .prc-card--new { animation: none; }
  .prc-card { transition: none; }
}

/* Corner brackets */
.prc-corner {
  position: absolute;
  width: 8px; height: 8px;
  border-color: rgba(34, 211, 238, 0.45);
  border-style: solid;
  pointer-events: none;
}
.prc-corner--tl {
  top: 5px; left: 5px;
  border-width: 1.5px 0 0 1.5px;
  border-radius: 2px 0 0 0;
}
.prc-corner--br {
  bottom: 5px; right: 5px;
  border-width: 0 1.5px 1.5px 0;
  border-radius: 0 0 2px 0;
}
.prc-card--pinned .prc-corner {
  border-color: rgba(168, 85, 247, 0.55);
}

/* ─── Card header ─── */
.prc-card-header {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 6px;
  min-width: 0;
}
.prc-done-mark {
  font-size: 11px;
  color: #22d3ee;
  flex-shrink: 0;
  width: 14px;
  text-align: center;
  line-height: 1;
}
.prc-card-title {
  font-size: 0.88rem;
  font-weight: 600;
  color: #f4f4f5;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.12s;
}
.prc-card-title:hover { color: #22d3ee; text-decoration: underline; text-decoration-color: rgba(34,211,238,0.4); }
.prc-status-pill {
  font-size: 0.55rem;
  font-weight: 800;
  font-family: 'SF Mono', 'Fira Mono', monospace;
  letter-spacing: 0.1em;
  padding: 2px 7px;
  border-radius: 4px;
  background: color-mix(in srgb, #22c55e 12%, transparent);
  border: 1px solid color-mix(in srgb, #22c55e 30%, transparent);
  color: #4ade80;
  flex-shrink: 0;
  text-transform: uppercase;
}
.prc-pin-indicator {
  font-size: 10px;
  flex-shrink: 0;
  opacity: 0.7;
}

/* ─── Description ─── */
.prc-desc {
  font-size: 0.72rem;
  color: #71717a;
  line-height: 1.5;
  cursor: pointer;
  margin-bottom: 6px;
  padding-left: 21px;
  /* 2-line clamp by default */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  transition: color 0.12s;
}
.prc-desc:hover { color: #a1a1aa; }
.prc-desc--expanded {
  -webkit-line-clamp: unset;
  overflow: visible;
}

/* ─── Property row ─── */
.prc-props {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 0;
  padding-left: 21px;
}
.prc-compact-meta {
  display: flex;
  gap: 6px;
  padding-left: 21px;
}
.prc-prop {
  font-size: 0.62rem;
  font-family: 'SF Mono', 'Fira Mono', monospace;
  border-radius: 4px;
  padding: 2px 7px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.07);
  color: #52525b;
  white-space: nowrap;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: all 0.12s;
}
.prc-prop--project {
  background: color-mix(in srgb, #a855f7 8%, transparent);
  border-color: color-mix(in srgb, #a855f7 20%, transparent);
  color: #a855f7;
}
.prc-prop--clickable { cursor: pointer; }
.prc-prop--clickable:hover {
  background: color-mix(in srgb, #a855f7 16%, transparent);
  border-color: color-mix(in srgb, #a855f7 40%, transparent);
  color: #c084fc;
}
.prc-prop--agent {
  background: color-mix(in srgb, #f59e0b 7%, transparent);
  border-color: color-mix(in srgb, #f59e0b 18%, transparent);
  color: #92400e;
  color: #d97706;
}
.prc-prop--dur {
  background: color-mix(in srgb, #3b82f6 7%, transparent);
  border-color: color-mix(in srgb, #3b82f6 18%, transparent);
  color: #60a5fa;
}
.prc-prop--time {
  color: #3f3f46;
}

/* ─── Action row (hover-reveal) ─── */
.prc-actions {
  display: flex;
  gap: 5px;
  margin-top: 8px;
  padding-left: 21px;
  opacity: 0;
  transform: translateY(2px);
  transition: opacity 0.15s, transform 0.15s;
  pointer-events: none;
}
.prc-card:hover .prc-actions,
.prc-card:focus-within .prc-actions {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}
.prc-act {
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 5px;
  color: #71717a;
  font-size: 0.63rem;
  padding: 3px 10px;
  cursor: pointer;
  transition: all 0.12s;
  font-family: inherit;
}
.prc-act:hover {
  background: rgba(34,211,238,0.1);
  border-color: rgba(34,211,238,0.3);
  color: #22d3ee;
}
.prc-act--active {
  background: color-mix(in srgb, #a855f7 12%, transparent);
  border-color: color-mix(in srgb, #a855f7 30%, transparent);
  color: #c084fc;
}

/* ─── Skeleton ─── */
.prc-card--skeleton {
  pointer-events: none;
  animation: prc-skeleton-pulse 1.4s ease-in-out infinite;
}
@keyframes prc-skeleton-pulse {
  0%, 100% { opacity: 0.55; }
  50%       { opacity: 0.8; }
}
@media (prefers-reduced-motion: reduce) {
  .prc-card--skeleton { animation: none; }
}
.prc-skel-line {
  background: rgba(255,255,255,0.07);
  border-radius: 4px;
}

/* ─── Empty / error states ─── */
.prc-empty-card,
.prc-error-card {
  text-align: center;
  padding: 28px 20px 24px;
}
.prc-empty-icon,
.prc-error-icon {
  font-size: 28px;
  margin-bottom: 10px;
  opacity: 0.35;
}
.prc-error-icon { color: #ef4444; opacity: 1; }
.prc-empty-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: #a1a1aa;
  margin-bottom: 6px;
}
.prc-empty-sub {
  font-size: 0.73rem;
  color: #52525b;
  line-height: 1.6;
  max-width: 320px;
  margin: 0 auto;
}
.prc-error-msg {
  font-size: 0.75rem;
  color: #ef4444;
  line-height: 1.5;
}

.prc-no-match {
  font-size: 0.74rem;
  color: #52525b;
  padding: 16px 4px;
  font-style: italic;
}
</style>`;
}
