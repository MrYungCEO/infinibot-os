/**
 * Reviews Page — dedicated in-depth review surface for EVERY agent run.
 *
 * Route: /reviews (list) and /reviews/:runId (deep-linked detail).
 *
 * Left  : filterable / searchable list of all runs (status · project · time).
 * Right : the FULL review rendered by the SHARED `renderAgentRunReview()`
 *         component — the exact same component the activity modal and the
 *         proactive completion modal use.
 *
 * DATA SOURCE — the backend `agents.reviews.*` gateway methods (owned by a
 * parallel agent; we only CONSUME them here):
 *   agents.reviews.list   { status?, projectId?, since?, limit? }
 *   agents.reviews.get    { id | runId }
 *   agents.reviews.regenerateSummary { id }
 *
 * Until the backend lands the page shows a graceful empty state. Append
 * `?reviewsDemo=1` to populate it with the local mock fixture for build/verify.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../gateway";
import type { AppViewState } from "../../app-view-state";
import { pathForTab } from "../../navigation";
import {
  renderAgentRunReview,
  listReviews,
  getReview,
  MOCK_REVIEWS,
  type AgentRunReview,
  type ReviewStatus,
} from "../../components/agent-run-review";

// ── Module state ──────────────────────────────────────────────────────────────

let _client: GatewayBrowserClient | null = null;
let _requestUpdate: (() => void) | null = null;
let _basePath = "";

let _reviews: AgentRunReview[] = [];
let _loading = false;
let _loaded = false;
let _backendMissing = false;
let _selectedRunId: string | null = null;
let _initialized = false;
let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _wsUnsub: (() => void) | null = null;
/** True once the user's deep-link slug has been consumed (prevents loops). */
let _deepLinkConsumed = false;

// Filters
type StatusFilter = "all" | ReviewStatus;
type TimeRange = "all" | "1h" | "24h" | "7d";
let _filterStatus: StatusFilter = "all";
let _filterTime: TimeRange = "all";
let _filterSearch = "";
let _filterProject = "";

const TIME_MS: Record<TimeRange, number> = {
  all: 0,
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
};

function demoMode(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("reviewsDemo") === "1";
  } catch {
    return false;
  }
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadReviews(): Promise<void> {
  if (!_client || _loading) return;
  _loading = true;
  _requestUpdate?.();
  try {
    const params: { status?: string; project?: string; since?: number; limit: number } = {
      limit: 200,
    };
    if (_filterTime !== "all") params.since = Date.now() - TIME_MS[_filterTime];
    const { reviews, backendMissing } = await listReviews(_client, params);
    _backendMissing = backendMissing;
    if ((reviews.length === 0 || backendMissing) && demoMode()) {
      _reviews = MOCK_REVIEWS;
      _backendMissing = false;
    } else {
      _reviews = reviews;
    }
  } finally {
    _loading = false;
    _loaded = true;
    _requestUpdate?.();
  }
}

/** Fetch one review fresh (detail deep-link) and merge into the list cache. */
async function ensureReview(runId: string): Promise<void> {
  if (!_client) return;
  if (_reviews.some((r) => r.runId === runId || r.id === runId)) return;
  const r = await getReview(_client, { runId });
  if (r) {
    _reviews = [r, ..._reviews];
    _requestUpdate?.();
  }
}

// ── Live updates ──────────────────────────────────────────────────────────────

const LIFECYCLE_EVENTS = new Set([
  "subagent.complete",
  "subagent.completed",
  "session.completed",
  "reviews:changed",
  "agents.reviews:changed",
  "review.ready",
]);

function startLive(): void {
  if (!_pollTimer) {
    _pollTimer = setInterval(() => {
      if (!document.hidden && _client) void loadReviews();
    }, 20_000);
  }
  if (!_wsUnsub && _client) {
    const sub = (
      _client as unknown as { subscribe?: (h: (e: { event?: string }) => void) => () => void }
    ).subscribe;
    if (typeof sub === "function") {
      _wsUnsub = sub.call(_client, (evt: { event?: string }) => {
        if (evt?.event && LIFECYCLE_EVENTS.has(evt.event) && _client) void loadReviews();
      });
    }
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────

function selectReview(runId: string | null): void {
  _selectedRunId = runId;
  try {
    const base = pathForTab("reviews", _basePath);
    const url = runId ? `${base}/${encodeURIComponent(runId)}` : base;
    window.history.pushState({}, "", url + window.location.search);
  } catch {
    /* best effort */
  }
  if (runId) void ensureReview(runId);
  _requestUpdate?.();
}

// ── Filtering ─────────────────────────────────────────────────────────────────

function applyFilters(list: AgentRunReview[]): AgentRunReview[] {
  const q = _filterSearch.trim().toLowerCase();
  const proj = _filterProject.trim().toLowerCase();
  const cutoff = _filterTime === "all" ? 0 : Date.now() - TIME_MS[_filterTime];
  return list
    .filter((r) => {
      if (_filterStatus !== "all" && r.status !== _filterStatus) return false;
      if (cutoff && (r.finishedAt ?? r.startedAt ?? 0) < cutoff) return false;
      if (proj && !(r.projectId ?? "").toLowerCase().includes(proj)) return false;
      if (q) {
        const hay = `${r.title} ${r.runId} ${r.agentKind} ${r.backend ?? ""} ${r.summaryMarkdown}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => (b.finishedAt ?? b.startedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? 0));
}

// ── Formatters ────────────────────────────────────────────────────────────────

const STATUS_TINT: Record<ReviewStatus, string> = {
  built: "#22c55e",
  not_built: "#f59e0b",
  partial: "#eab308",
  failed: "#ef4444",
  in_progress: "#38bdf8",
};

function statusTint(s: ReviewStatus): string {
  return STATUS_TINT[s] ?? "#a78bfa";
}

function timeAgo(ts?: number): string {
  if (!ts) return "—";
  const d = Date.now() - ts;
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

// ── Main render ───────────────────────────────────────────────────────────────

export function renderReviewsView(
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  _client = client;
  _requestUpdate = state.requestUpdate ? () => state.requestUpdate!() : null;
  _basePath = (state as { basePath?: string }).basePath ?? "";

  // Consume a deep-link slug (/reviews/:runId) once.
  const dl = (state as { deepLink?: { kind: string; slug: string; pending: boolean } | null })
    .deepLink;
  if (dl && dl.pending && !_deepLinkConsumed) {
    _deepLinkConsumed = true;
    _selectedRunId = dl.slug;
    void ensureReview(dl.slug);
  }

  if (!_initialized) {
    _initialized = true;
    void loadReviews();
    startLive();
  }

  const filtered = applyFilters(_reviews);
  const selected =
    _selectedRunId != null
      ? _reviews.find((r) => r.runId === _selectedRunId || r.id === _selectedRunId) ?? null
      : filtered[0] ?? null;

  return html`
    ${reviewsStyles()}
    <div class="rv-root" role="main" aria-label="Reviews">
      <div class="rv-layout">
        <div class="rv-list-col" data-learn-id="reviews-list">
          ${renderFilters()}
          ${renderList(filtered, selected)}
        </div>
        <div class="rv-detail-col" data-learn-id="reviews-detail">${renderDetail(selected)}</div>
      </div>
    </div>
  `;
}

function renderFilters(): TemplateResult {
  const ru = _requestUpdate ?? (() => {});
  const statuses: StatusFilter[] = [
    "all",
    "built",
    "not_built",
    "partial",
    "failed",
    "in_progress",
  ];
  const statusLabel = (s: StatusFilter) =>
    s === "all" ? "All" : s === "not_built" ? "Not built" : s === "in_progress" ? "Running" : s[0].toUpperCase() + s.slice(1);
  return html`
    <div class="rv-filters" data-learn-id="reviews-filters">
      <div class="rv-search-wrap">
        <input
          type="search"
          class="rv-search"
          data-learn-id="reviews-search"
          placeholder="Search title, run, summary…"
          .value=${_filterSearch}
          @input=${(e: Event) => {
            _filterSearch = (e.target as HTMLInputElement).value;
            ru();
          }}
          aria-label="Search reviews"
        />
      </div>
      <div class="rv-chips" data-learn-id="reviews-status">
        ${statuses.map(
          (s) => html`
            <button
              class="rv-chip ${_filterStatus === s ? "rv-chip-active" : ""}"
              style=${_filterStatus === s && s !== "all"
                ? `color:${statusTint(s as ReviewStatus)};border-color:${statusTint(s as ReviewStatus)}66;`
                : ""}
              @click=${() => {
                _filterStatus = s;
                ru();
              }}
              aria-pressed=${_filterStatus === s}
            >
              ${statusLabel(s)}
            </button>
          `,
        )}
      </div>
      <div class="rv-chips">
        ${(["all", "1h", "24h", "7d"] as TimeRange[]).map(
          (t) => html`
            <button
              class="rv-chip ${_filterTime === t ? "rv-chip-active" : ""}"
              @click=${() => {
                _filterTime = t;
                void loadReviews();
              }}
              aria-pressed=${_filterTime === t}
            >
              ${t === "all" ? "All time" : t === "1h" ? "1h" : t === "24h" ? "24h" : "7d"}
            </button>
          `,
        )}
        <input
          type="text"
          class="rv-proj"
          placeholder="Project…"
          .value=${_filterProject}
          @input=${(e: Event) => {
            _filterProject = (e.target as HTMLInputElement).value;
            ru();
          }}
          aria-label="Filter by project"
        />
      </div>
    </div>
  `;
}

function renderList(filtered: AgentRunReview[], selected: AgentRunReview | null): TemplateResult {
  if (_loading && _reviews.length === 0) {
    return html`<div class="rv-list">${renderSkeleton()}</div>`;
  }
  if (_loaded && _reviews.length === 0) {
    return html`
      <div class="rv-empty">
        <div class="rv-empty-glyph">◔</div>
        <p class="rv-empty-text">No agent reviews yet.</p>
        <p class="rv-empty-sub">
          ${_backendMissing
            ? html`Reviews will appear here once the <code>agents.reviews.*</code> backend is live and
                agents start finishing runs.`
            : "A review is generated for every agent run — they'll show up here as soon as runs complete."}
        </p>
        ${_backendMissing
          ? html`<p class="rv-empty-hint">
              Append <code>?reviewsDemo=1</code> to preview with sample data.
            </p>`
          : nothing}
      </div>
    `;
  }
  if (filtered.length === 0) {
    return html`
      <div class="rv-empty">
        <p class="rv-empty-text">No reviews match your filters.</p>
        <button
          class="rv-btn"
          @click=${() => {
            _filterSearch = "";
            _filterStatus = "all";
            _filterProject = "";
            _requestUpdate?.();
          }}
        >
          Clear filters
        </button>
      </div>
    `;
  }
  return html`
    <div class="rv-list" role="list">
      ${filtered.map((r) => {
        const active = selected && (selected.runId === r.runId || selected.id === r.id);
        const tint = statusTint(r.status);
        return html`
          <button
            class="rv-row ${active ? "rv-row-active" : ""}"
            style="--rv-tint:${tint}"
            role="listitem"
            @click=${() => selectReview(r.runId)}
          >
            <span class="rv-row-status" style="background:${tint}"></span>
            <span class="rv-row-body">
              <span class="rv-row-title">${r.title}</span>
              <span class="rv-row-meta">
                <span class="rv-row-badge" style="color:${tint};border-color:${tint}55;">
                  ${r.status === "not_built" ? "not built" : r.status.replace("_", " ")}
                </span>
                <span>${r.agentKind}</span>
                ${r.filesTouched.length
                  ? html`<span>· ${r.filesTouched.length} file${r.filesTouched.length !== 1 ? "s" : ""}</span>`
                  : nothing}
                ${r.issues.length
                  ? html`<span class="rv-row-issue">· ${r.issues.length} issue${r.issues.length !== 1 ? "s" : ""}</span>`
                  : nothing}
                <span class="rv-row-ago">${timeAgo(r.finishedAt ?? r.startedAt)}</span>
              </span>
            </span>
          </button>
        `;
      })}
    </div>
  `;
}

function renderDetail(selected: AgentRunReview | null): TemplateResult {
  if (!selected) {
    if (_loading) return html`<div class="rv-detail-empty">Loading review…</div>`;
    return html`
      <div class="rv-detail-empty">
        <div class="rv-empty-glyph">◔</div>
        <p>Select a run to see its full review.</p>
      </div>
    `;
  }
  return html`
    <div class="rv-detail-head">
      <h1 class="rv-detail-title">${selected.title}</h1>
      <code class="rv-detail-run">${selected.runId}</code>
    </div>
    <div class="rv-detail-scroll">
      ${renderAgentRunReview(selected, {
        client: _client!,
        requestUpdate: _requestUpdate ?? (() => {}),
        onRegenerated: (updated) => {
          _reviews = _reviews.map((r) => (r.id === updated.id ? updated : r));
          _requestUpdate?.();
        },
      })}
    </div>
  `;
}

function renderSkeleton(): TemplateResult {
  return html`
    ${Array.from(
      { length: 6 },
      (_, i) => html`<div class="rv-skel" style="animation-delay:${i * 0.06}s"></div>`,
    )}
  `;
}

// ── Styles ────────────────────────────────────────────────────────────────────

function reviewsStyles(): TemplateResult {
  return html`
    <style>
      .rv-root {
        height: 100%;
        min-height: 60vh;
        color: var(--g-fg, #f5eacd);
      }
      .rv-layout {
        display: grid;
        grid-template-columns: minmax(300px, 380px) 1fr;
        gap: 16px;
        height: 100%;
        align-items: start;
      }
      @media (max-width: 860px) {
        .rv-layout {
          grid-template-columns: 1fr;
        }
      }
      .rv-list-col {
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-width: 0;
      }
      .rv-filters {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .rv-search {
        width: 100%;
        box-sizing: border-box;
        background: rgba(0, 0, 0, 0.32);
        border: 1px solid rgba(212, 175, 55, 0.24);
        border-radius: 10px;
        padding: 9px 12px;
        color: #f5eacd;
        font-size: 0.84rem;
      }
      .rv-search:focus {
        outline: none;
        border-color: rgba(212, 175, 55, 0.6);
      }
      .rv-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
      }
      .rv-chip {
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.14);
        color: rgba(245, 234, 205, 0.75);
        border-radius: 999px;
        padding: 4px 11px;
        font-size: 0.72rem;
        font-weight: 700;
        cursor: pointer;
      }
      .rv-chip:hover {
        border-color: rgba(212, 175, 55, 0.5);
      }
      .rv-chip-active {
        background: rgba(212, 175, 55, 0.14);
        border-color: rgba(212, 175, 55, 0.5);
        color: #f5eacd;
      }
      .rv-proj {
        flex: 1;
        min-width: 90px;
        background: rgba(0, 0, 0, 0.28);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 999px;
        padding: 4px 11px;
        color: #f5eacd;
        font-size: 0.72rem;
      }
      .rv-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        overflow: auto;
        max-height: calc(100vh - 220px);
      }
      .rv-row {
        display: flex;
        align-items: stretch;
        gap: 10px;
        text-align: left;
        width: 100%;
        cursor: pointer;
        background: rgba(20, 18, 14, 0.55);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 11px;
        padding: 10px 12px;
        transition: border-color 0.14s, background 0.14s;
      }
      .rv-row:hover {
        border-color: color-mix(in srgb, var(--rv-tint, #d4af37) 45%, transparent);
        background: rgba(30, 26, 18, 0.7);
      }
      .rv-row-active {
        border-color: color-mix(in srgb, var(--rv-tint, #d4af37) 70%, transparent);
        background: color-mix(in srgb, var(--rv-tint, #d4af37) 12%, rgba(30, 26, 18, 0.7));
      }
      .rv-row-status {
        flex: 0 0 auto;
        width: 4px;
        border-radius: 3px;
        align-self: stretch;
      }
      .rv-row-body {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
        flex: 1;
      }
      .rv-row-title {
        font-size: 0.86rem;
        font-weight: 700;
        color: #f5eacd;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .rv-row-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        font-size: 0.68rem;
        color: rgba(245, 234, 205, 0.55);
      }
      .rv-row-badge {
        font-size: 0.58rem;
        font-weight: 800;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        border: 1px solid;
        border-radius: 5px;
        padding: 1px 6px;
      }
      .rv-row-issue {
        color: #f97316;
      }
      .rv-row-ago {
        margin-left: auto;
        color: rgba(245, 234, 205, 0.4);
      }
      .rv-detail-col {
        min-width: 0;
        background: rgba(14, 13, 10, 0.55);
        border: 1px solid rgba(212, 175, 55, 0.16);
        border-radius: 14px;
        padding: 18px 20px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        max-height: calc(100vh - 150px);
      }
      .rv-detail-head {
        display: flex;
        flex-direction: column;
        gap: 4px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        padding-bottom: 12px;
      }
      .rv-detail-title {
        margin: 0;
        font-size: 1.12rem;
        font-weight: 800;
        color: #fff;
        line-height: 1.25;
      }
      .rv-detail-run {
        font-size: 0.7rem;
        color: rgba(245, 234, 205, 0.5);
      }
      .rv-detail-scroll {
        overflow: auto;
        padding-right: 4px;
      }
      .rv-detail-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 10px;
        min-height: 40vh;
        color: rgba(245, 234, 205, 0.5);
        text-align: center;
      }
      .rv-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        text-align: center;
        padding: 40px 20px;
        color: rgba(245, 234, 205, 0.6);
      }
      .rv-empty-glyph {
        font-size: 2.4rem;
        opacity: 0.4;
      }
      .rv-empty-text {
        margin: 0;
        font-weight: 700;
        color: #f5eacd;
      }
      .rv-empty-sub,
      .rv-empty-hint {
        margin: 0;
        font-size: 0.8rem;
        max-width: 320px;
      }
      .rv-empty code {
        background: rgba(255, 255, 255, 0.08);
        padding: 1px 5px;
        border-radius: 4px;
      }
      .rv-btn {
        margin-top: 6px;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.18);
        color: #f5eacd;
        border-radius: 9px;
        padding: 7px 14px;
        font-size: 0.8rem;
        font-weight: 700;
        cursor: pointer;
      }
      .rv-skel {
        height: 58px;
        border-radius: 11px;
        background: linear-gradient(
          90deg,
          rgba(255, 255, 255, 0.04),
          rgba(255, 255, 255, 0.08),
          rgba(255, 255, 255, 0.04)
        );
        background-size: 200% 100%;
        animation: rv-shimmer 1.3s ease-in-out infinite;
      }
      @keyframes rv-shimmer {
        0% {
          background-position: 200% 0;
        }
        100% {
          background-position: -200% 0;
        }
      }
    </style>
  `;
}
