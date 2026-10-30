/**
 * Report associations — the visible face of `reports.link` / `reports.forObject`.
 *
 * A rendered report (the black-gold PDFs in /reports) is an artifact *about*
 * something: a client QBR, an opportunity brief, a project status. This module
 * renders that relationship on both ends:
 *
 *   renderObjectReports(...)   — the "Reports" section on a Client / Opportunity /
 *                                Project detail view: every linked report with
 *                                view + download, plus an "Associate report"
 *                                picker to attach an existing one.
 *   renderAssociateControl(...)— the "Associate with…" control for a row/card in
 *                                the Reports gallery: pick a client, opportunity
 *                                or project to bind the report to.
 *
 * Self-contained by design (module-level cache + its own loaders, mirroring
 * related-panel.ts) so it drops into any view with one import and one call —
 * the host views never fetch, and concurrent edits to those views stay merge-
 * friendly.
 *
 * Pre-restart safety: `reports.*` association methods are new, so a gateway
 * that hasn't restarted yet rejects them. A failure is NEVER cached as "no
 * reports" — that would strand the section permanently once the restart finally
 * happens. Instead the entry keeps `error` + a `retryAt` backoff so it stops
 * hammering the socket every render but always heals after a restart.
 */
import { isBusinessAgencyOn } from "../business-agency-gate.js";
import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { icons } from "../icons";

// ── Types ──────────────────────────────────────────────────────────────────

/** Object types a report can be associated with. Mirrors REPORT_TARGET_TYPES. */
export const REPORT_TARGET_TYPES = ["client", "opportunity", "project"] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

interface LinkedReport {
  id: string;
  title: string;
  kind: string;
  status: string;
  category: string | null;
  createdAt: number;
  renderedAt: number | null;
  filePath: string | null;
  fileSize: number | null;
  summaryText: string | null;
}

interface Association {
  relationId: string;
  reportId: string;
  targetType: string;
  targetId: string;
  createdAt: number;
}

interface ObjectEntry {
  loading: boolean;
  loaded: boolean;
  reports: LinkedReport[];
  associations: Association[];
  /** Non-null means the last load failed — never treated as "no reports". */
  error: string | null;
  /** Epoch-ms before which we refuse to retry a failed load. */
  retryAt: number;
  /** Whether the "Associate report" picker is open. */
  pickerOpen: boolean;
  pickerQuery: string;
  busy: boolean;
}

/** Backoff after a failed load, so a pre-restart gateway isn't hammered. */
const RETRY_BACKOFF_MS = 20_000;

const objectCache = new Map<string, ObjectEntry>();
const keyFor = (type: string, id: string) => `${type}:${id}`;

/** All reports, loaded once for the "Associate report" picker. */
interface ReportPoolEntry {
  loading: boolean;
  loaded: boolean;
  reports: LinkedReport[];
  error: string | null;
  retryAt: number;
}
const reportPool: ReportPoolEntry = {
  loading: false,
  loaded: false,
  reports: [],
  error: null,
  retryAt: 0,
};

/** Candidate objects for the gallery-side "Associate with…" picker. */
interface Candidate {
  id: string;
  label: string;
  sub?: string;
}
interface CandidateEntry {
  loading: boolean;
  loaded: boolean;
  items: Candidate[];
  error: string | null;
  retryAt: number;
}
const candidates: Record<ReportTargetType, CandidateEntry> = {
  client: { loading: false, loaded: false, items: [], error: null, retryAt: 0 },
  opportunity: { loading: false, loaded: false, items: [], error: null, retryAt: 0 },
  project: { loading: false, loaded: false, items: [], error: null, retryAt: 0 },
};

// ── Cache control ──────────────────────────────────────────────────────────

/** Drop the cached report list for one object so the next render re-fetches. */
export function invalidateObjectReports(type: string, id: string): void {
  objectCache.delete(keyFor(type, id));
}

/** Drop every cache (used after a link/unlink so both ends stay consistent). */
export function invalidateAllReportAssociations(): void {
  objectCache.clear();
  reportPool.loaded = false;
  reportPool.retryAt = 0;
}

// ── Loaders ────────────────────────────────────────────────────────────────

async function loadObjectReports(
  app: AppViewState,
  client: GatewayBrowserClient,
  type: string,
  id: string,
): Promise<void> {
  const entry = objectCache.get(keyFor(type, id));
  if (!entry || entry.loading) return;
  entry.loading = true;
  entry.error = null;
  try {
    const res = (await client.request("reports.forObject", { type, id })) as {
      reports?: LinkedReport[];
      associations?: Association[];
    };
    entry.reports = Array.isArray(res?.reports) ? res.reports : [];
    entry.associations = Array.isArray(res?.associations) ? res.associations : [];
    entry.loaded = true;
    entry.retryAt = 0;
  } catch (e) {
    // Never mark loaded — a failure and a genuine "none" are different states.
    entry.error = String(e);
    entry.retryAt = Date.now() + RETRY_BACKOFF_MS;
  } finally {
    entry.loading = false;
    app.requestUpdate?.();
  }
}

async function loadReportPool(app: AppViewState, client: GatewayBrowserClient): Promise<void> {
  if (reportPool.loading || reportPool.loaded || Date.now() < reportPool.retryAt) return;
  reportPool.loading = true;
  reportPool.error = null;
  try {
    const res = (await client.request("reports.list", { limit: 300 })) as {
      reports?: LinkedReport[];
    };
    reportPool.reports = Array.isArray(res?.reports) ? res.reports : [];
    reportPool.loaded = true;
    reportPool.retryAt = 0;
  } catch (e) {
    reportPool.error = String(e);
    reportPool.retryAt = Date.now() + RETRY_BACKOFF_MS;
  } finally {
    reportPool.loading = false;
    app.requestUpdate?.();
  }
}

/** Read a display name off a loosely-shaped record from any of the three stores. */
function labelOf(row: Record<string, unknown>): string {
  const data = (row.data as Record<string, unknown> | undefined) ?? {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = row[k] ?? data[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  return pick("name", "Name", "title", "Title", "company", "Company") || "Untitled";
}

async function loadCandidates(
  app: AppViewState,
  client: GatewayBrowserClient,
  type: ReportTargetType,
): Promise<void> {
  const entry = candidates[type];
  if (entry.loading || entry.loaded || Date.now() < entry.retryAt) return;
  entry.loading = true;
  entry.error = null;
  try {
    // Each object type has its own list RPC; the shapes differ, so normalize.
    if (type === "client") {
      const res = (await client.request("clients.list", {})) as { clients?: unknown[] };
      entry.items = (res?.clients ?? []).map((c) => {
        const row = c as Record<string, unknown>;
        return { id: String(row.id ?? ""), label: labelOf(row) };
      });
    } else if (type === "opportunity") {
      const res = (await client.request("opportunity.list", { limit: 500 })) as {
        opportunities?: unknown[];
      };
      entry.items = (res?.opportunities ?? []).map((o) => {
        const row = o as Record<string, unknown>;
        return {
          id: String(row.id ?? ""),
          label: labelOf(row),
          sub: typeof row.stage === "string" ? row.stage : undefined,
        };
      });
    } else {
      const res = (await client.request("kanban.projects.list", {})) as
        | { projects?: unknown[] }
        | unknown[];
      const list = Array.isArray(res) ? res : (res?.projects ?? []);
      entry.items = list.map((p) => {
        const row = p as Record<string, unknown>;
        return {
          id: String(row.id ?? ""),
          label: labelOf(row),
          sub: typeof row.status === "string" ? row.status : undefined,
        };
      });
    }
    entry.items = entry.items.filter((i) => i.id);
    entry.loaded = true;
    entry.retryAt = 0;
  } catch (e) {
    entry.error = String(e);
    entry.retryAt = Date.now() + RETRY_BACKOFF_MS;
  } finally {
    entry.loading = false;
    app.requestUpdate?.();
  }
}

// ── Mutations ──────────────────────────────────────────────────────────────

async function link(
  app: AppViewState,
  client: GatewayBrowserClient,
  reportId: string,
  targetType: string,
  targetId: string,
): Promise<void> {
  await client.request("reports.link", { reportId, targetType, targetId, createdBy: "user" });
  invalidateObjectReports(targetType, targetId);
  app.requestUpdate?.();
}

async function unlink(
  app: AppViewState,
  client: GatewayBrowserClient,
  relationId: string,
  targetType: string,
  targetId: string,
): Promise<void> {
  await client.request("reports.unlink", { relationId });
  invalidateObjectReports(targetType, targetId);
  app.requestUpdate?.();
}

/**
 * Open a report's PDF. `reports.preview` returns base64 so this works without a
 * static file route; the blob URL is revoked on the next tick after the tab
 * takes ownership of it.
 */
async function openReport(client: GatewayBrowserClient, reportId: string, download = false, name = "report"): Promise<void> {
  const res = (await client.request("reports.preview", { id: reportId, base64: true })) as {
    base64?: string;
    mimeType?: string;
  };
  if (!res?.base64) throw new Error("report has no rendered file yet");
  const bytes = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: res.mimeType || "application/pdf" }));
  if (download) {
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60) || "report"}.pdf`;
    a.click();
  } else {
    window.open(url, "_blank", "noopener");
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ── Shared styling ─────────────────────────────────────────────────────────

const GOLD = "#fbbf24";
const S = {
  panel:
    "grid-column:1/-1; margin-top:10px; padding:10px 12px; border:1px solid rgba(251,191,36,0.16); border-radius:10px; background:rgba(255,255,255,0.02);",
  head: "display:flex; align-items:center; gap:8px; margin:0 0 8px; color:#fbbf24; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.08em;",
  muted: "font-size:12px; color:rgba(245,245,244,0.5); font-style:italic;",
  btn: "background:none; border:1px solid rgba(255,255,255,0.14); color:rgba(245,245,244,0.7); border-radius:6px; font-size:10px; padding:2px 8px; cursor:pointer;",
  goldBtn:
    "background:rgba(251,191,36,0.12); border:1px solid rgba(251,191,36,0.45); color:#fbbf24; border-radius:6px; font-size:10px; padding:2px 9px; cursor:pointer; font-weight:600;",
  row: "display:flex; align-items:center; gap:8px; padding:6px 8px; border:1px solid rgba(255,255,255,0.08); border-radius:8px; background:rgba(255,255,255,0.02);",
  input:
    "flex:1; min-width:0; background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.14); color:#f5f5f4; border-radius:6px; font-size:11px; padding:4px 8px; outline:none;",
  list: "max-height:190px; overflow:auto; display:flex; flex-direction:column; gap:4px; margin-top:6px;",
  // Compact mode (dense detail pages such as the project board header).
  panelCompact:
    "min-width:0; padding:8px 10px; border:1px solid rgba(251,191,36,0.16); border-radius:10px; background:rgba(255,255,255,0.02);",
  rowCompact:
    "display:flex; align-items:center; gap:6px; padding:3px 6px; border:1px solid rgba(255,255,255,0.08); border-radius:6px; background:rgba(255,255,255,0.02); min-width:0;",
  btnCompact:
    "background:none; border:1px solid rgba(255,255,255,0.14); color:rgba(245,245,244,0.7); border-radius:5px; font-size:10px; padding:1px 6px; cursor:pointer; flex:none;",
  pick: "text-align:left; width:100%; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); color:rgba(245,245,244,0.85); border-radius:6px; font-size:11px; padding:5px 8px; cursor:pointer;",
};

const fmtDate = (ms: number | null) =>
  ms
    ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : "";
const fmtSize = (b: number | null) => (b ? `${Math.max(1, Math.round(b / 1024))} KB` : "");

function docIcon(): TemplateResult {
  return html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke=${GOLD}
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="flex:none;">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
    <polyline points="14 2 14 8 20 8"></polyline>
  </svg>`;
}

// ── The object-side section ────────────────────────────────────────────────

/** Sections the user collapsed (compact mode only), keyed by `type:id`. */
const collapsedObjects = new Set<string>();

/**
 * Render the "Reports" section for a Client / Opportunity / Project detail
 * view. Lazily loads on first render and caches per (type, id).
 */
export function renderObjectReports(
  app: AppViewState,
  client: GatewayBrowserClient,
  type: string,
  id: string,
  opts: { title?: string; compact?: boolean } = {},
): TemplateResult {
  if (!id) return nothing as unknown as TemplateResult;
  const k = keyFor(type, id);
  const compact = !!opts.compact;
  const isCollapsed = compact && collapsedObjects.has(k);
  let entry = objectCache.get(k);
  if (!entry) {
    entry = {
      loading: false,
      loaded: false,
      reports: [],
      associations: [],
      error: null,
      retryAt: 0,
      pickerOpen: false,
      pickerQuery: "",
      busy: false,
    };
    objectCache.set(k, entry);
    void loadObjectReports(app, client, type, id);
  } else if (!entry.loaded && !entry.loading && Date.now() >= entry.retryAt) {
    // A previous attempt failed and the backoff has expired — heal after a
    // gateway restart without re-firing on every single render.
    void loadObjectReports(app, client, type, id);
  }
  const e = entry;

  const head = html`<div style="${S.head}${compact ? ` min-width:0; margin:${isCollapsed ? "0" : "0 0 6px"};` : ""}">
    ${compact
      ? html`<button
          @click=${() => {
            if (collapsedObjects.has(k)) collapsedObjects.delete(k);
            else collapsedObjects.add(k);
            app.requestUpdate?.();
          }}
          aria-expanded=${String(!isCollapsed)}
          title=${isCollapsed ? "Show reports" : "Hide reports"}
          style="display:inline-flex; align-items:center; gap:6px; min-width:0; background:none; border:none; padding:0; color:inherit; font:inherit; letter-spacing:inherit; text-transform:inherit; cursor:pointer;"
        >
          <span style="font-size:9px; width:8px;">${isCollapsed ? "▸" : "▾"}</span>
          ${docIcon()}
          <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${opts.title || "Reports"}</span>
        </button>`
      : html`${docIcon()} ${opts.title || "Reports"}`}
    ${e.reports.length
      ? html`<span style="color:rgba(245,245,244,0.5); font-weight:500;">${e.reports.length}</span>`
      : nothing}
    <span style="margin-left:auto; display:flex; gap:6px;">
      <button
        style=${S.goldBtn}
        title="Associate an existing report with this record"
        @click=${() => {
          e.pickerOpen = !e.pickerOpen;
          if (e.pickerOpen) void loadReportPool(app, client);
          app.requestUpdate?.();
        }}
      >${e.pickerOpen ? "Cancel" : compact ? "+ Link" : "+ Associate report"}</button>
      <button
        style=${S.btn}
        title="Refresh linked reports"
        @click=${() => {
          invalidateObjectReports(type, id);
          app.requestUpdate?.();
        }}
      >↻</button>
    </span>
  </div>`;

  let body: TemplateResult;
  if (e.loading && !e.loaded) {
    body = html`<div style=${S.muted}>Loading reports…</div>`;
  } else if (e.error && !e.loaded) {
    body = html`<div style="font-size:11px; color:rgba(245,245,244,0.45); font-style:italic;">
      Report associations unavailable (gateway restart required to serve
      <code>reports.forObject</code>). Retrying automatically.
    </div>`;
  } else if (!e.reports.length) {
    body = compact
      ? html`<div style="${S.muted} font-size:11px;">No reports linked yet.</div>`
      : html`<div style=${S.muted}>
          No reports linked yet — associate one, or pass this record's id when generating a report.
        </div>`;
  } else if (compact) {
    // One line per report (title · date), short actions, capped height so a
    // long list scrolls inside the section instead of pushing the page down.
    body = html`<div style="display:flex; flex-direction:column; gap:3px; max-height:74px; overflow:auto; overscroll-behavior:contain;">
      ${e.reports.map((r) => {
        const assoc = e.associations.find((a) => a.reportId === r.id);
        const meta = [r.category, fmtDate(r.renderedAt ?? r.createdAt), fmtSize(r.fileSize)]
          .filter(Boolean)
          .join(" · ");
        const ready = !!r.filePath;
        return html`<div style=${S.rowCompact} title=${meta ? `${r.title} — ${meta}` : r.title}>
          <span style="flex:1; min-width:0; font-size:11px; color:#f5f5f4; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            ${r.title || "Untitled report"}
            <span style="font-size:10px; color:rgba(245,245,244,0.45);"> · ${fmtDate(r.renderedAt ?? r.createdAt)}</span>
          </span>
          <button
            style=${S.btnCompact}
            ?disabled=${!ready}
            title=${ready ? "Open the PDF" : "Not rendered yet"}
            @click=${() => void openReport(client, r.id, false, r.title)}
          >View</button>
          <button
            style=${S.btnCompact}
            ?disabled=${!ready}
            title=${ready ? "Download the PDF" : "Not rendered yet"}
            aria-label="Download the PDF"
            @click=${() => void openReport(client, r.id, true, r.title)}
          >↓</button>
          ${assoc
            ? html`<button
                style=${S.btnCompact}
                title="Remove this association (the report itself is kept)"
                aria-label="Remove association"
                @click=${() => void unlink(app, client, assoc.relationId, type, id)}
              >✕</button>`
            : nothing}
        </div>`;
      })}
    </div>`;
  } else {
    body = html`<div style="display:flex; flex-direction:column; gap:5px;">
      ${e.reports.map((r) => {
        const assoc = e.associations.find((a) => a.reportId === r.id);
        const meta = [r.category, fmtDate(r.renderedAt ?? r.createdAt), fmtSize(r.fileSize)]
          .filter(Boolean)
          .join(" · ");
        const ready = !!r.filePath;
        return html`<div style=${S.row}>
          ${docIcon()}
          <div style="flex:1; min-width:0;">
            <div style="font-size:12px; color:#f5f5f4; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title=${r.title}>
              ${r.title || "Untitled report"}
            </div>
            <div style="font-size:10px; color:rgba(245,245,244,0.5);">${meta}</div>
          </div>
          <button
            style=${S.btn}
            ?disabled=${!ready}
            title=${ready ? "Open the PDF" : "Not rendered yet"}
            @click=${() => void openReport(client, r.id, false, r.title)}
          >View</button>
          <button
            style=${S.btn}
            ?disabled=${!ready}
            title=${ready ? "Download the PDF" : "Not rendered yet"}
            @click=${() => void openReport(client, r.id, true, r.title)}
          >Download</button>
          ${assoc
            ? html`<button
                style=${S.btn}
                title="Remove this association (the report itself is kept)"
                @click=${() => void unlink(app, client, assoc.relationId, type, id)}
              >✕</button>`
            : nothing}
        </div>`;
      })}
    </div>`;
  }

  const picker = e.pickerOpen
    ? html`<div style="margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.08);">
        <input
          style=${S.input}
          placeholder="Search reports by title…"
          .value=${e.pickerQuery}
          @input=${(ev: Event) => {
            e.pickerQuery = (ev.target as HTMLInputElement).value;
            app.requestUpdate?.();
          }}
        />
        ${reportPool.loading
          ? html`<div style=${S.muted}>Loading reports…</div>`
          : reportPool.error && !reportPool.loaded
            ? html`<div style=${S.muted}>Could not load reports — retrying shortly.</div>`
            : html`<div style=${S.list}>
                ${(() => {
                  const q = e.pickerQuery.trim().toLowerCase();
                  const linked = new Set(e.reports.map((r) => r.id));
                  const options = reportPool.reports
                    .filter((r) => !linked.has(r.id))
                    .filter((r) => !q || (r.title || "").toLowerCase().includes(q))
                    .slice(0, 40);
                  if (!options.length) {
                    return html`<div style=${S.muted}>No matching unlinked reports.</div>`;
                  }
                  return options.map(
                    (r) => html`<button
                      style=${S.pick}
                      @click=${async () => {
                        e.busy = true;
                        try {
                          await link(app, client, r.id, type, id);
                          e.pickerOpen = false;
                        } catch (err) {
                          e.error = String(err);
                        } finally {
                          e.busy = false;
                          app.requestUpdate?.();
                        }
                      }}
                    >
                      ${r.title || "Untitled report"}
                      <span style="opacity:0.5;"> · ${fmtDate(r.renderedAt ?? r.createdAt)}</span>
                    </button>`,
                  );
                })()}
              </div>`}
      </div>`
    : nothing;

  return html`<div style=${compact ? S.panelCompact : S.panel}>
    ${head}${isCollapsed ? nothing : html`${body}${picker}`}
  </div>`;
}

// ── The project-page Reports section ──────────────────────────────────────

type ReportGroupBy = "month" | "type" | "none";
type ReportSort = "newest" | "oldest" | "title";

interface ProjectReportsUi {
  query: string;
  groupBy: ReportGroupBy;
  sort: ReportSort;
  /** How many rows are rendered (paged in steps of REPORTS_PAGE). */
  limit: number;
  closedGroups: Set<string>;
}

/** Rows rendered before "Show more". */
export const REPORTS_PAGE = 20;
const projectReportsUi = new Map<string, ProjectReportsUi>();
const REPORTS_OPEN_KEY = "ib.projectReports.open";

function reportsOpenPrefs(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(REPORTS_OPEN_KEY) || "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function setReportsOpen(k: string, open: boolean): void {
  try {
    const prefs = reportsOpenPrefs();
    prefs[k] = open;
    const keys = Object.keys(prefs);
    if (keys.length > 300) for (const old of keys.slice(0, keys.length - 300)) delete prefs[old];
    localStorage.setItem(REPORTS_OPEN_KEY, JSON.stringify(prefs));
  } catch {
    /* storage disabled */
  }
}

const reportTime = (r: LinkedReport) => r.renderedAt ?? r.createdAt ?? 0;

/** "daily_operational" → "Daily operational"; prefers the explicit category. */
export function reportTypeLabel(r: { kind?: string; category?: string | null }): string {
  const raw = (r.category || r.kind || "report").replace(/[_-]+/g, " ").trim();
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "Report";
}

function monthLabel(ms: number): string {
  if (!ms) return "Undated";
  const d = new Date(ms);
  const now = new Date();
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return "This month";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/** Sort + group reports for the project section. Exported for tests. */
export function organizeReports<T extends LinkedReport>(
  reports: T[],
  opts: { query?: string; groupBy?: ReportGroupBy; sort?: ReportSort },
): Array<{ key: string; label: string; items: T[] }> {
  const q = (opts.query ?? "").trim().toLowerCase();
  const list = reports.filter(
    (r) =>
      !q ||
      `${r.title} ${r.kind} ${r.category ?? ""} ${r.summaryText ?? ""}`.toLowerCase().includes(q),
  );
  const sort = opts.sort ?? "newest";
  list.sort((a, b) =>
    sort === "title"
      ? (a.title || "").localeCompare(b.title || "")
      : sort === "oldest"
        ? reportTime(a) - reportTime(b)
        : reportTime(b) - reportTime(a),
  );
  const groupBy = opts.groupBy ?? "month";
  if (groupBy === "none") return list.length ? [{ key: "all", label: "All reports", items: list }] : [];
  const groups = new Map<string, { key: string; label: string; items: T[] }>();
  for (const r of list) {
    const label = groupBy === "type" ? reportTypeLabel(r) : monthLabel(reportTime(r));
    let g = groups.get(label);
    if (!g) {
      g = { key: label, label, items: [] };
      groups.set(label, g);
    }
    g.items.push(r);
  }
  const out = [...groups.values()];
  // Month groups follow the row sort (already chronological); type groups go
  // biggest-first so the dominant report families lead.
  if (groupBy === "type") out.sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
  return out;
}

/**
 * The project page's Reports section: search, sort (newest first by default),
 * group by month or type, compact rows with open / download / unlink, an
 * internal scroll area, paging past {@link REPORTS_PAGE}, and an empty state.
 * Styles live in views/work-glass/project-sections.css (`pjs-*` / `pjp-*`).
 */
export function renderProjectReports(
  app: AppViewState,
  client: GatewayBrowserClient,
  type: string,
  id: string,
  opts: { title?: string } = {},
): TemplateResult {
  if (!id) return nothing as unknown as TemplateResult;
  const k = keyFor(type, id);
  let entry = objectCache.get(k);
  if (!entry) {
    entry = {
      loading: false,
      loaded: false,
      reports: [],
      associations: [],
      error: null,
      retryAt: 0,
      pickerOpen: false,
      pickerQuery: "",
      busy: false,
    };
    objectCache.set(k, entry);
    void loadObjectReports(app, client, type, id);
  } else if (!entry.loaded && !entry.loading && Date.now() >= entry.retryAt) {
    void loadObjectReports(app, client, type, id);
  }
  const e = entry;
  let ui = projectReportsUi.get(k);
  if (!ui) {
    ui = { query: "", groupBy: "month", sort: "newest", limit: REPORTS_PAGE, closedGroups: new Set() };
    projectReportsUi.set(k, ui);
  }
  const u = ui;
  const pref = reportsOpenPrefs()[k];
  const open = typeof pref === "boolean" ? pref : true;
  const count = e.reports.length;
  const title = opts.title ?? "Reports";
  const rerender = () => app.requestUpdate?.();

  const head = html`<div class="pjs-head">
    <button
      class="pjs-toggle"
      aria-expanded=${String(open)}
      title=${open ? "Collapse reports" : "Expand reports"}
      @click=${() => {
        setReportsOpen(k, !open);
        rerender();
      }}
    >
      <span class="pjs-chev ${open ? "is-open" : ""}" aria-hidden="true">${icons.chevronRight}</span>
      <span class="pjs-ico" aria-hidden="true">${icons.fileText}</span>
      <span class="pjs-title">${title}</span>
      ${e.loaded ? html`<span class="pjs-count">${count}</span>` : nothing}
    </button>
    <span class="pjs-head-actions">
      ${type === "project"
        ? html`<button
            class="pjs-btn pjs-btn--research"
            aria-label="Research for this project"
            title="Research for this project — start new research or see what's linked"
            @click=${() => {
              const base = (app.basePath ?? "").replace(/\/+$/, "");
              window.history.pushState({}, "", `${base}/research?project=${encodeURIComponent(id)}`);
              window.dispatchEvent(new PopStateEvent("popstate"));
            }}
          >
            ${icons.search}<span>Research</span>
          </button>`
        : nothing}
      <button
        class="pjs-btn is-gold"
        title="Link an existing report to this project"
        @click=${() => {
          e.pickerOpen = !e.pickerOpen;
          if (e.pickerOpen) {
            setReportsOpen(k, true);
            void loadReportPool(app, client);
          }
          rerender();
        }}
      >
        ${e.pickerOpen ? html`${icons.x}<span>Cancel</span>` : html`${icons.plus}<span>Link report</span>`}
      </button>
      <button
        class="pjs-icon-btn"
        title="Reload reports"
        aria-label="Reload reports"
        @click=${() => {
          invalidateObjectReports(type, id);
          rerender();
        }}
      >
        ${icons.refresh}
      </button>
    </span>
  </div>`;

  const picker = e.pickerOpen
    ? html`<div class="pjp-picker">
        <label class="pjs-search">
          <span aria-hidden="true">${icons.search}</span>
          <input
            type="search"
            placeholder="Search all reports by title…"
            aria-label="Search reports to link"
            .value=${e.pickerQuery}
            @input=${(ev: Event) => {
              e.pickerQuery = (ev.target as HTMLInputElement).value;
              rerender();
            }}
          />
        </label>
        ${reportPool.loading
          ? html`<div class="pjs-note">Loading reports…</div>`
          : reportPool.error && !reportPool.loaded
            ? html`<div class="pjs-note is-warn">Could not load reports — retrying shortly.</div>`
            : (() => {
                const q = e.pickerQuery.trim().toLowerCase();
                const linked = new Set(e.reports.map((r) => r.id));
                const options = reportPool.reports
                  .filter((r) => !linked.has(r.id))
                  .filter((r) => !q || (r.title || "").toLowerCase().includes(q))
                  .slice(0, 40);
                return options.length
                  ? html`<div class="pjp-picker-list">
                      ${options.map(
                        (r) => html`<button
                          class="pjp-pick"
                          ?disabled=${e.busy}
                          @click=${async () => {
                            e.busy = true;
                            try {
                              await link(app, client, r.id, type, id);
                              e.pickerOpen = false;
                            } catch (err) {
                              e.error = String(err);
                            } finally {
                              e.busy = false;
                              rerender();
                            }
                          }}
                        >
                          <span class="pjp-pick-title">${r.title || "Untitled report"}</span>
                          <span class="pjp-pick-meta">${fmtDate(reportTime(r))}</span>
                        </button>`,
                      )}
                    </div>`
                  : html`<div class="pjs-note">No matching unlinked reports.</div>`;
              })()}
      </div>`
    : nothing;

  let body: TemplateResult | typeof nothing = nothing;
  if (!open) {
    body = nothing;
  } else if (e.loading && !e.loaded) {
    body = html`<div class="pjs-note">Loading reports…</div>`;
  } else if (e.error && !e.loaded) {
    body = html`<div class="pjs-note is-warn">
      Report links unavailable (the gateway needs a restart to serve
      <code>reports.forObject</code>). Retrying automatically.
    </div>`;
  } else if (!count) {
    body = html`<div class="pjp-empty">
      <span class="pjp-empty-ico" aria-hidden="true">${icons.fileText}</span>
      <div class="pjp-empty-copy">
        <strong>No reports yet</strong>
        <span>Link an existing report, or generate one with this project's id and it will appear here.</span>
      </div>
    </div>`;
  } else {
    const groups = organizeReports(e.reports, u);
    const matched = groups.reduce((n, g) => n + g.items.length, 0);
    // Paging counts only rows in open groups, so a collapsed month never
    // leaves a "Show more" that reveals nothing.
    const pageable = groups.reduce((n, g) => n + (u.closedGroups.has(g.key) ? 0 : g.items.length), 0);
    let budget = u.limit;
    body = html`
      <div class="pjs-tools">
        <label class="pjs-search">
          <span aria-hidden="true">${icons.search}</span>
          <input
            type="search"
            placeholder="Search reports…"
            aria-label="Search linked reports"
            .value=${u.query}
            @input=${(ev: Event) => {
              u.query = (ev.target as HTMLInputElement).value;
              u.limit = REPORTS_PAGE;
              rerender();
            }}
          />
        </label>
        <select
          class="pjs-select"
          aria-label="Group reports"
          .value=${u.groupBy}
          @change=${(ev: Event) => {
            u.groupBy = (ev.target as HTMLSelectElement).value as ReportGroupBy;
            rerender();
          }}
        >
          <option value="month" ?selected=${u.groupBy === "month"}>By month</option>
          <option value="type" ?selected=${u.groupBy === "type"}>By type</option>
          <option value="none" ?selected=${u.groupBy === "none"}>No grouping</option>
        </select>
        <select
          class="pjs-select"
          aria-label="Sort reports"
          .value=${u.sort}
          @change=${(ev: Event) => {
            u.sort = (ev.target as HTMLSelectElement).value as ReportSort;
            rerender();
          }}
        >
          <option value="newest" ?selected=${u.sort === "newest"}>Newest first</option>
          <option value="oldest" ?selected=${u.sort === "oldest"}>Oldest first</option>
          <option value="title" ?selected=${u.sort === "title"}>Title A–Z</option>
        </select>
        ${u.query ? html`<span class="pjs-tools-meta">${matched} of ${count}</span>` : nothing}
      </div>
      <div class="pjs-scroll pjp-groups">
        ${groups.length
          ? groups.map((g) => {
              if (budget <= 0) return nothing;
              const gOpen = !u.closedGroups.has(g.key);
              const items = gOpen ? g.items.slice(0, budget) : [];
              budget -= gOpen ? items.length : 0;
              return html`<section class="pjp-group">
                ${u.groupBy !== "none"
                  ? html`<button
                      class="pjr-group-head"
                      aria-expanded=${String(gOpen)}
                      @click=${() => {
                        if (gOpen) u.closedGroups.add(g.key);
                        else u.closedGroups.delete(g.key);
                        rerender();
                      }}
                    >
                      <span class="pjs-chev ${gOpen ? "is-open" : ""}" aria-hidden="true">${icons.chevronRight}</span>
                      <span class="pjr-group-label">${g.label}</span>
                      <span class="pjs-count">${g.items.length}</span>
                    </button>`
                  : nothing}
                ${items.length
                  ? html`<div class="pjp-list">
                      ${items.map((r) => {
                        const assoc = e.associations.find((a) => a.reportId === r.id);
                        const ready = !!r.filePath;
                        const when = fmtDate(reportTime(r));
                        const size = fmtSize(r.fileSize);
                        return html`<div class="pjp-row" title=${r.summaryText || r.title}>
                          <span class="pjp-row-ico" aria-hidden="true">${icons.fileText}</span>
                          <span class="pjp-row-main">
                            <button
                              class="pjp-row-title"
                              ?disabled=${!ready}
                              title=${ready ? `Open ${r.title}` : "Not rendered yet"}
                              @click=${() => void openReport(client, r.id, false, r.title)}
                            >
                              ${r.title || "Untitled report"}
                            </button>
                            <span class="pjp-row-meta">
                              <span class="pjp-type">${reportTypeLabel(r)}</span>
                              <span>${when}</span>
                              ${size ? html`<span class="pjp-size">${size}</span>` : nothing}
                              ${!ready ? html`<span class="pjp-pending">${r.status || "pending"}</span>` : nothing}
                            </span>
                          </span>
                          <span class="pjp-actions">
                            <button
                              class="pjs-icon-btn"
                              ?disabled=${!ready}
                              title=${ready ? "Open the PDF" : "Not rendered yet"}
                              aria-label="Open the PDF"
                              @click=${() => void openReport(client, r.id, false, r.title)}
                            >
                              ${icons.externalLink}
                            </button>
                            <button
                              class="pjs-icon-btn"
                              ?disabled=${!ready}
                              title=${ready ? "Download the PDF" : "Not rendered yet"}
                              aria-label="Download the PDF"
                              @click=${() => void openReport(client, r.id, true, r.title)}
                            >
                              ${icons.download}
                            </button>
                            ${assoc
                              ? html`<button
                                  class="pjs-icon-btn is-quiet"
                                  title="Unlink from this project (the report itself is kept)"
                                  aria-label="Unlink report"
                                  @click=${() => void unlink(app, client, assoc.relationId, type, id)}
                                >
                                  ${icons.x}
                                </button>`
                              : nothing}
                          </span>
                        </div>`;
                      })}
                    </div>`
                  : nothing}
              </section>`;
            })
          : html`<div class="pjs-note">No reports match “${u.query}”.</div>`}
        ${pageable > u.limit
          ? html`<button
              class="pjs-more is-block"
              @click=${() => {
                u.limit += REPORTS_PAGE;
                rerender();
              }}
            >
              Show more (${pageable - u.limit} left)
            </button>`
          : nothing}
      </div>
    `;
  }

  return html`<section class="pjs-panel pjp-panel ${open ? "is-open" : "is-closed"}" aria-label=${title}>
    ${head}${open ? picker : nothing}${body}
  </section>`;
}

// ── The report-side control ────────────────────────────────────────────────

// Single-open by design: the host renders this as one overlay for whichever
// report is being associated, so a Set of open ids would let two panels claim
// the same overlay slot.
let openAssociate: string | null = null;
const associateType = new Map<string, ReportTargetType>();
const associateQuery = new Map<string, string>();

/** The report whose "Associate with…" panel is open, or null. */
export function openAssociateReportId(): string | null {
  return openAssociate;
}

/** Close the open "Associate with…" panel (e.g. when a list re-filters). */
export function closeAssociatePanel(): void {
  openAssociate = null;
}

export function isAssociatePanelOpen(reportId: string): boolean {
  return openAssociate === reportId;
}

/** Toggle the "Associate with…" panel for a report card/row. */
export function toggleAssociatePanel(
  app: AppViewState,
  client: GatewayBrowserClient,
  reportId: string,
): void {
  openAssociate = openAssociate === reportId ? null : reportId;
  if (openAssociate)
    void loadCandidates(
      app,
      client,
      associateType.get(reportId) ?? (isBusinessAgencyOn() ? "client" : "project"),
    );
  app.requestUpdate?.();
}

/**
 * The "Associate with…" panel for one report in the Reports gallery: pick the
 * object type, search, and bind. Render it next to the report's other actions;
 * it returns `nothing` while closed, so hosts can call it unconditionally.
 */
export function renderAssociatePanel(
  app: AppViewState,
  client: GatewayBrowserClient,
  reportId: string,
  opts: {
    /** Called after a successful link, so the host can toast / refresh. */
    onLinked?: (targetType: ReportTargetType, targetId: string, label: string) => void;
    /** Called when the user dismisses the panel without linking. */
    onClose?: () => void;
  } = {},
): TemplateResult {
  if (openAssociate !== reportId) return nothing as unknown as TemplateResult;
  // Clients + opportunities come from the Business & Agency plugin; while it
  // is off a report can only be associated with a project.
  const targetTypes = isBusinessAgencyOn() ? REPORT_TARGET_TYPES : (["project"] as const);
  const picked = associateType.get(reportId) ?? targetTypes[0];
  const type = (targetTypes as readonly ReportTargetType[]).includes(picked) ? picked : "project";
  const q = (associateQuery.get(reportId) ?? "").trim().toLowerCase();
  const entry = candidates[type];
  if (!entry.loaded && !entry.loading && Date.now() >= entry.retryAt) {
    void loadCandidates(app, client, type);
  }

  const items = entry.items.filter((i) => !q || i.label.toLowerCase().includes(q)).slice(0, 40);

  return html`<div
    style="margin-top:8px; padding:8px 10px; border:1px solid rgba(251,191,36,0.24); border-radius:8px; background:rgba(0,0,0,0.4);"
    @click=${(ev: Event) => ev.stopPropagation()}
  >
    <div style=${S.head}>
      Associate with…
      ${opts.onClose
        ? html`<button
            style="margin-left:auto; ${S.btn}"
            title="Close"
            @click=${() => {
              openAssociate = null;
              opts.onClose?.();
              app.requestUpdate?.();
            }}
          >✕</button>`
        : nothing}
    </div>
    <div style="display:flex; gap:5px; margin-bottom:6px;">
      ${targetTypes.map(
        (t) => html`<button
          style=${t === type ? S.goldBtn : S.btn}
          @click=${() => {
            associateType.set(reportId, t);
            void loadCandidates(app, client, t);
            app.requestUpdate?.();
          }}
        >${t.charAt(0).toUpperCase()}${t.slice(1)}</button>`,
      )}
    </div>
    <input
      style=${S.input}
      placeholder=${`Search ${type}s…`}
      .value=${associateQuery.get(reportId) ?? ""}
      @input=${(ev: Event) => {
        associateQuery.set(reportId, (ev.target as HTMLInputElement).value);
        app.requestUpdate?.();
      }}
    />
    ${entry.loading
      ? html`<div style=${S.muted}>Loading ${type}s…</div>`
      : entry.error && !entry.loaded
        ? html`<div style=${S.muted}>Could not load ${type}s — retrying shortly.</div>`
        : html`<div style=${S.list}>
            ${items.length
              ? items.map(
                  (i) => html`<button
                    style=${S.pick}
                    @click=${async () => {
                      try {
                        await link(app, client, reportId, type, i.id);
                        openAssociate = null;
                        opts.onLinked?.(type, i.id, i.label);
                      } catch (err) {
                        console.warn("[report-associations] link failed", err);
                      }
                      app.requestUpdate?.();
                    }}
                  >
                    ${i.label}${i.sub ? html`<span style="opacity:0.5;"> · ${i.sub}</span>` : nothing}
                  </button>`,
                )
              : html`<div style=${S.muted}>No matching ${type}s.</div>`}
          </div>`}
  </div>`;
}
