/**
 * Reports view — main mount point for the InfiniBot Report System UI.
 *
 * Route: /reports
 * Sub-tabs: History (default) · Schedules · Triggers
 *
 * Consumes backend RPCs (verbatim names — foundation agent owns the impl):
 *   reports.list({ kind?, status?, limit?, offset? }) → { reports, total }
 *   reports.get({ id })                               → full record
 *   reports.preview({ id })                           → { filePath, mimeType }
 *   reports.generate({ kind, theme?, config? })       → { id, status }
 *   reports.resend({ id, sinks })                     → { ok, results }
 *   reports.delete({ id })                            → { ok }
 *   reports.insights.list({ since?, kind?, limit? })  → { insights } | [...]
 *   reports.schedules.* / reports.triggers.*          (sub-tabs)
 *
 * Live-update: subscribes to `reports:*` gateway events and folds new/updated
 * records into the list without a manual refresh.
 *
 * Exports REPORT_KINDS / REPORT_THEMES / ALL_SINKS / rpc for the sub-tabs.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../gateway";
import type { AppViewState } from "../../app-view-state";
import {
  renderReportCard,
  statusColor,
  type ReportRecord,
  type ReportStatus,
} from "../../components/report-card";
import { renderPdfPreview } from "../../components/pdf-preview";
import { renderSchedulesTab } from "./schedules";
import { renderTriggersTab } from "./triggers";
import { renderGalleryTab, renderGalleryOverlays } from "./gallery";
import { glassAgentsStyle, glassAurora, glassEmpty } from "../glass-agents-shared";
import { REPORTS_GLASS_CSS } from "../glass-reports";
import {
  openAssociateReportId,
  renderAssociatePanel,
  toggleAssociatePanel,
} from "../../components/report-associations";
import { gatewayHttpUrl } from "../../gateway-endpoint";

// ── Shared constants (imported by schedules.ts / triggers.ts) ──────────────────

export type ReportKindDef = { id: string; label: string };

export const REPORT_KINDS: ReportKindDef[] = [
  { id: "gateway_recovery", label: "Gateway Recovery" },
  { id: "ceo_hourly_insights", label: "CEO Hourly" },
  { id: "daily_summary", label: "24h Summary" },
  { id: "daily_operational", label: "Daily" },
  { id: "weekly_strategic", label: "Weekly" },
  { id: "credit_burn_alert", label: "Credit Alert" },
  { id: "incident", label: "Incident" },
  { id: "custom", label: "Custom" },
];

export const REPORT_THEMES: Array<{ id: string; label: string }> = [
  { id: "black-gold", label: "Black / Gold" },
  { id: "midnight-blue", label: "Midnight Blue" },
  { id: "forest-emerald", label: "Forest Emerald" },
  { id: "crimson-noir", label: "Crimson Noir" },
];

export const ALL_SINKS: Array<{ id: string; label: string }> = [
  { id: "ui", label: "UI" },
  { id: "telegram", label: "Telegram" },
  { id: "email", label: "Email" },
];

export function rpc(client: GatewayBrowserClient, method: string, params?: unknown): Promise<unknown> {
  return (client as unknown as { request: (m: string, p?: unknown) => Promise<unknown> })
    .request(method, params);
}

// ── Insight type (drill-down) ───────────────────────────────────────────────────

type InsightKind = "alert" | "opportunity" | "risk" | "win" | (string & {});
type ReportInsight = {
  id: string;
  report_id?: string;
  kind: InsightKind;
  title: string;
  body?: string;
  action?: string;
  severity?: number | string;
  created_at?: number;
};

// ── Module state ────────────────────────────────────────────────────────────────

type SubTab = "gallery" | "history" | "schedules" | "triggers";
type StatusFilter = "all" | ReportStatus;
type RangeFilter = "all" | "24h" | "7d" | "30d";
type RightMode = "none" | "preview" | "insights";

let _reports: ReportRecord[] = [];
let _total = 0;
let _loading = false;
let _error: string | null = null;
let _client: GatewayBrowserClient | null = null;
let _ru: (() => void) | null = null;
let _wsUnsub: (() => void) | null = null;
let _reloadTimer: ReturnType<typeof setTimeout> | null = null;

let _subTab: SubTab = "gallery";

// filters
let _filterKind: "all" | string = "all";
let _filterStatus: StatusFilter = "all";
let _filterRange: RangeFilter = "all";
let _filterSearch = "";

// card interaction
const _expanded = new Set<string>();
const _confirmDelete = new Set<string>();
const _busyResend = new Set<string>();
const _busyDelete = new Set<string>();

// generate picker
let _kindPickerOpen = false;
const _busyGenerate = new Set<string>();

// right pane (preview / insights)
let _rightMode: RightMode = "none";
let _previewReportId: string | null = null;
let _previewUrl: string | null = null;
let _previewMime: string | null = null;
let _previewLoading = false;
let _previewError: string | null = null;

let _insightsReportId: string | null = null;
let _insights: ReportInsight[] = [];
let _insightsLoading = false;
let _insightsError: string | null = null;

// ── Demo fixture (activated by ?demo=1, used for visual verification) ───────────

function maybeSeedFixture(): void {
  if (typeof window === "undefined") return;
  if (!new URLSearchParams(window.location.search).has("demo")) return;
  if (_reports.length > 0) return;
  const now = Date.now();
  _reports = [
    {
      id: "rep-1", kind: "ceo_hourly_insights", title: "CEO Hourly Insights — 14:05",
      theme: "black-gold", status: "ready", trigger: "cron",
      created_at: now - 18 * 60_000, rendered_at: now - 17 * 60_000,
      file_path: "/reports/ceo-1405.pdf", file_size: 248_400,
      summary_text: "Credit burn is drifting 18% above the daily budget driven by 3 long-running coder agents on the federation satellite. Two kanban initiatives stalled >6h. Federation health nominal.",
      insights_count: 5, sinks: ["ui", "telegram"], sinks_delivered: ["ui", "telegram"],
    },
    {
      id: "rep-2", kind: "gateway_recovery", title: "Gateway Recovery — auto",
      theme: "black-gold", status: "sent", trigger: "event",
      created_at: now - 2 * 3_600_000, rendered_at: now - 2 * 3_600_000,
      file_path: "/reports/gw-recovery-2.pdf", file_size: 96_700,
      summary_text: "Gateway restarted after an unhandled rejection in the voice stream. All 7 in-flight agents re-verified; 6 resumed cleanly, 1 required manual restart.",
      sinks: ["ui", "telegram"], sinks_delivered: ["ui", "telegram"],
    },
    {
      id: "rep-3", kind: "daily_operational", title: "Daily Operational Roll-up",
      theme: "midnight-blue", status: "rendering", trigger: "cron",
      created_at: now - 40 * 60_000, file_size: null,
      summary_text: "End-of-day roll-up in progress…",
      sinks: ["ui"],
    },
    {
      id: "rep-4", kind: "credit_burn_alert", title: "Credit Burn Alert — threshold crossed",
      theme: "crimson-noir", status: "failed", trigger: "event",
      created_at: now - 5 * 3_600_000,
      summary_text: "Hourly spend crossed $4.20 threshold. Render failed — collector timed out gathering provider ledger rows.",
      sinks: ["ui", "telegram"],
    },
    {
      id: "rep-5", kind: "weekly_strategic", title: "Weekly Strategic Review",
      theme: "forest-emerald", status: "queued", trigger: "manual",
      created_at: now - 12 * 60_000,
      sinks: ["ui", "email"],
    },
  ];
  _total = _reports.length;
}

// ── Data loading ────────────────────────────────────────────────────────────────

/**
 * The gateway sends reports in camelCase (createdAt, filePath, summaryText…)
 * while the history cards read snake_case. Without this, every row showed
 * "—" for age and size, the range filter dropped everything, sorting was a
 * no-op, the summary was empty and Download did nothing.
 */
function normalizeReport(r: ReportRecord): ReportRecord {
  const w = r as ReportRecord & Record<string, any>;
  return {
    ...r,
    created_at: w.created_at ?? w.createdAt,
    rendered_at: w.rendered_at ?? w.renderedAt ?? null,
    file_path: w.file_path ?? w.filePath ?? null,
    file_size: w.file_size ?? w.fileSize ?? null,
    summary_text: w.summary_text ?? w.summaryText ?? null,
  } as ReportRecord;
}

function extractReports(res: unknown): { reports: ReportRecord[]; total: number } {
  if (Array.isArray(res)) return { reports: (res as ReportRecord[]).map(normalizeReport), total: res.length };
  if (res && typeof res === "object") {
    const o = res as any;
    if (Array.isArray(o.reports)) return { reports: (o.reports as ReportRecord[]).map(normalizeReport), total: Number(o.total ?? o.reports.length) };
  }
  return { reports: [], total: 0 };
}

export async function loadReports(client: GatewayBrowserClient, ru: () => void): Promise<void> {
  _client = client;
  _ru = ru;
  if (_loading) return;
  _loading = true;
  _error = null;
  ru();
  try {
    const params: Record<string, unknown> = { limit: 200 };
    if (_filterKind !== "all") params.kind = _filterKind;
    if (_filterStatus !== "all") params.status = _filterStatus;
    const res = await rpc(client, "reports.list", params);
    const { reports, total } = extractReports(res);
    _reports = reports;
    _total = total;
    _error = null;
    if (_reports.length === 0) maybeSeedFixture();
  } catch (e) {
    _error = e instanceof Error ? e.message : String(e);
    _reports = [];
    _total = 0;
    maybeSeedFixture();
    if (_reports.length > 0) _error = null;
  } finally {
    _loading = false;
    ru();
  }
}

function scheduleReload(): void {
  if (_reloadTimer) return;
  _reloadTimer = setTimeout(() => {
    _reloadTimer = null;
    if (_client && _ru) void loadReports(_client, _ru);
  }, 400);
}

function subscribeLive(client: GatewayBrowserClient): void {
  if (_wsUnsub) return;
  _wsUnsub = client.subscribe((evt) => {
    const name = (evt.event ?? (evt as any).type ?? "") as string;
    if (!name.startsWith("reports:") && !name.startsWith("report:")) return;
    const payload = evt.payload as Partial<ReportRecord> | undefined;
    if (payload && payload.id) {
      // Fold the record in optimistically, then debounce-reconcile with the server.
      const idx = _reports.findIndex((r) => r.id === payload.id);
      if (idx >= 0) _reports[idx] = normalizeReport({ ..._reports[idx], ...payload } as ReportRecord);
      else _reports = [normalizeReport(payload as ReportRecord), ..._reports];
      _ru?.();
    }
    scheduleReload();
  });
}

// ── Filtering ───────────────────────────────────────────────────────────────────

function applyFilters(reports: ReportRecord[]): ReportRecord[] {
  const q = _filterSearch.trim().toLowerCase();
  const now = Date.now();
  const rangeMs: Record<RangeFilter, number> = { all: 0, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 };
  const since = _filterRange === "all" ? 0 : now - rangeMs[_filterRange];
  return reports
    .filter((r) => {
      if (_filterKind !== "all" && r.kind !== _filterKind) return false;
      if (_filterStatus !== "all" && r.status !== _filterStatus) return false;
      if (since && (r.created_at ?? 0) < since) return false;
      if (q) {
        const hay = [r.title, r.kind, r.summary_text ?? "", r.theme ?? ""].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
}

// ── Actions ─────────────────────────────────────────────────────────────────────

async function generate(kind: string): Promise<void> {
  if (!_client || _busyGenerate.has(kind)) return;
  _busyGenerate.add(kind);
  _kindPickerOpen = false;
  _ru?.();
  try {
    const res = await rpc(_client, "reports.generate", { kind, theme: "black-gold" }) as any;
    // Optimistic insert so the user sees a queued row immediately.
    if (res && res.id) {
      _reports = [{
        id: String(res.id), kind, title: REPORT_KINDS.find((k) => k.id === kind)?.label ?? kind,
        theme: "black-gold", status: (res.status as ReportStatus) ?? "queued",
        trigger: "manual", created_at: Date.now(),
      }, ..._reports];
    }
    scheduleReload();
  } catch (e) {
    _error = e instanceof Error ? e.message : String(e);
  } finally {
    _busyGenerate.delete(kind);
    _ru?.();
  }
}

async function openPreview(r: ReportRecord): Promise<void> {
  if (!_client) return;
  _rightMode = "preview";
  _previewReportId = r.id;
  _previewLoading = true;
  _previewError = null;
  _previewUrl = null;
  _previewMime = null;
  _ru?.();
  try {
    const res = await rpc(_client, "reports.preview", { id: r.id }) as any;
    const filePath: string | undefined = res?.filePath ?? res?.url ?? r.file_path ?? undefined;
    _previewMime = res?.mimeType ?? null;
    _previewUrl = filePath ? toBrowserUrl(filePath) : null;
    if (!_previewUrl) _previewError = "No file path returned for this report.";
  } catch (e) {
    _previewError = e instanceof Error ? e.message : String(e);
  } finally {
    _previewLoading = false;
    _ru?.();
  }
}

/** Best-effort conversion of a server file path into something the iframe can load. */
function toBrowserUrl(p: string): string {
  if (/^(https?:|blob:|data:|\/)/.test(p)) return p;
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("file://")) return p.startsWith("file://") ? p : `file://${p}`;
  // Relative path served by the gateway file route.
  return gatewayHttpUrl(`/files/raw?path=${encodeURIComponent(p)}`);
}

function downloadReport(r: ReportRecord): void {
  const url = (_previewReportId === r.id && _previewUrl) ? _previewUrl : (r.file_path ? toBrowserUrl(r.file_path) : null);
  if (!url) return;
  const a = document.createElement("a");
  a.href = url;
  a.download = `${r.title || r.kind || "report"}.pdf`;
  a.target = "_blank";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function resendTelegram(r: ReportRecord): Promise<void> {
  if (!_client || _busyResend.has(r.id)) return;
  _busyResend.add(r.id);
  _ru?.();
  try {
    await rpc(_client, "reports.resend", { id: r.id, sinks: ["telegram"] });
  } catch (e) {
    _error = e instanceof Error ? e.message : String(e);
  } finally {
    _busyResend.delete(r.id);
    _ru?.();
  }
}

async function deleteReport(r: ReportRecord): Promise<void> {
  if (!_client || _busyDelete.has(r.id)) return;
  _busyDelete.add(r.id);
  _ru?.();
  try {
    await rpc(_client, "reports.delete", { id: r.id });
    _reports = _reports.filter((x) => x.id !== r.id);
    _confirmDelete.delete(r.id);
    _expanded.delete(r.id);
    if (_previewReportId === r.id) { _rightMode = "none"; _previewReportId = null; }
  } catch (e) {
    _error = e instanceof Error ? e.message : String(e);
  } finally {
    _busyDelete.delete(r.id);
    _ru?.();
  }
}

async function openInsights(r: ReportRecord): Promise<void> {
  if (!_client) return;
  _rightMode = "insights";
  _insightsReportId = r.id;
  _insightsLoading = true;
  _insightsError = null;
  _insights = [];
  _ru?.();
  try {
    const res = await rpc(_client, "reports.insights.list", { kind: r.kind, limit: 100 }) as any;
    const list: ReportInsight[] = Array.isArray(res) ? res
      : Array.isArray(res?.insights) ? res.insights : [];
    // Prefer insights tied to this report if the field is present.
    const scoped = list.filter((i) => !i.report_id || i.report_id === r.id);
    _insights = (scoped.length ? scoped : list);
    _insightsError = null;
  } catch (e) {
    _insightsError = e instanceof Error ? e.message : String(e);
  } finally {
    _insightsLoading = false;
    _ru?.();
  }
}

// ── Icons ────────────────────────────────────────────────────────────────────────

const ICO_SEARCH = html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
const ICO_PLUS = html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
const ICO_DOC = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
const ICO_SPARK = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`;

const ICO_ALERT_ORB = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
const ICO_SPARK_ORB = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/></svg>`;
const ICO_TAB_GALLERY = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>`;
const ICO_TAB_HISTORY = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/><polyline points="12 7 12 12 15 14"/></svg>`;
const ICO_TAB_CLOCK = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="17" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
const ICO_TAB_BOLT = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;

// ── Main view ─────────────────────────────────────────────────────────────────

export function renderReportsView(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  _client = client;
  _ru = state.requestUpdate ? () => state.requestUpdate!() : null;
  const ru = _ru ?? (() => {});

  if (!_wsUnsub) {
    subscribeLive(client);
    void loadReports(client, ru);
  }

  return html`
    ${glassAgentsStyle(REPORTS_GLASS_CSS)}
    <div class="rep-root gt-scope ga-reports" role="main" aria-label="Reports">
      ${glassAurora()}
      ${_renderHeader(ru)}
      <div class="rep-body" role="tabpanel">
        ${_subTab === "gallery" ? renderGalleryTab(client, ru)
          : _subTab === "history" ? _renderHistory(ru)
          : _subTab === "schedules" ? renderSchedulesTab(client, ru)
          : renderTriggersTab(client, ru)}
      </div>
    </div>
    ${renderGalleryOverlays({ associate: _subTab === "gallery" })}
    ${_subTab === "gallery" ? nothing : _renderAssociateModal(ru)}
  `;
}

// ── Associate a report with a business object ────────────────────────────────
// The picker is the shared component used by the Client / Opportunity / Project
// "Reports" sections; this view supplies the overlay it renders in.

/** Adapter so the shared component can drive this module's re-render. */
const _assocHost = (ru: () => void) => ({ requestUpdate: ru }) as never;

function _renderAssociateModal(ru: () => void): TemplateResult {
  const id = openAssociateReportId();
  if (!id || !_client) return html``;
  const report = _reports.find((r) => r.id === id);
  const close = () => toggleAssociatePanel(_assocHost(ru), _client!, id);
  return html`
    <div class="rep-assoc-scrim gt-scope" @click=${close}>
      <div class="rep-assoc-modal" role="dialog" aria-modal="true" @click=${(e: Event) => e.stopPropagation()}>
        <div class="rep-assoc-bar">
          <span class="rep-assoc-title">Associate · ${report?.title ?? "Report"}</span>
          <button class="gt-btn" @click=${close} aria-label="Close">Close</button>
        </div>
        ${renderAssociatePanel(_assocHost(ru), _client, id)}
      </div>
    </div>`;
}

function _renderHeader(ru: () => void): TemplateResult {
  const tabs: Array<{ id: SubTab; label: string; icon: TemplateResult }> = [
    { id: "gallery", label: "Gallery", icon: ICO_TAB_GALLERY },
    { id: "history", label: "History", icon: ICO_TAB_HISTORY },
    { id: "schedules", label: "Schedules", icon: ICO_TAB_CLOCK },
    { id: "triggers", label: "Triggers", icon: ICO_TAB_BOLT },
  ];
  const loadingStats = _loading && _reports.length === 0;
  const count = (pred: (r: ReportRecord) => boolean) => (loadingStats ? "—" : String(_reports.filter(pred).length));
  const inFlight = _reports.filter((r) => r.status === "queued" || r.status === "rendering").length;
  const failed = _reports.filter((r) => r.status === "failed").length;
  const stat = (value: string, label: string, light?: TemplateResult) => html`
    <div class="gt-stat gt-glass rep-stat-tile">
      <span class="gt-stat-value">${light ?? nothing}${value}</span>
      <span class="gt-stat-label">${label}</span>
    </div>`;
  return html`
    <header class="rep-hero">
      <div class="gt-hero">
        <div>
          <span class="gt-eyebrow">Intelligence</span>
          <h1 class="gt-title">Reports</h1>
          <p class="gt-sub">Stylized PDF reporting: scheduled, triggered and on demand.</p>
        </div>
        <div class="gt-stats">
          ${stat(loadingStats ? "—" : String(Math.max(_total, _reports.length)), "Reports")}
          ${stat(count((r) => r.status === "ready" || r.status === "sent"), "Ready", html`<span class="gt-light" data-state="ok"></span>`)}
          ${stat(
            count((r) => r.status === "queued" || r.status === "rendering"),
            "In flight",
            html`<span class="gt-light" data-state=${inFlight > 0 ? "gold" : "idle"} ?data-pulse=${inFlight > 0}></span>`,
          )}
          ${failed > 0 ? stat(String(failed), "Failed", html`<span class="gt-light" data-state="danger"></span>`) : nothing}
          <div class="rep-generate-wrap">
            <button class="gt-btn gt-primary rep-generate-btn" aria-haspopup="menu" aria-expanded=${_kindPickerOpen}
              @click=${() => { _kindPickerOpen = !_kindPickerOpen; ru(); }}
              @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape" && _kindPickerOpen) { _kindPickerOpen = false; ru(); } }}>
              ${ICO_PLUS} Generate now
            </button>
            ${_kindPickerOpen ? html`
              <div class="rep-kind-menu" role="menu" @mouseleave=${() => { _kindPickerOpen = false; ru(); }}
                @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape") { _kindPickerOpen = false; ru(); } }}>
                ${REPORT_KINDS.map((k) => html`
                  <button class="rep-kind-item ${_busyGenerate.has(k.id) ? "rep-kind-item--busy" : ""}" role="menuitem"
                    ?disabled=${_busyGenerate.has(k.id)}
                    @click=${() => void generate(k.id)}>
                    <span>${k.label}</span>
                    ${_busyGenerate.has(k.id) ? html`<span class="rep-preview-spin rep-preview-spin--sm"></span>` : nothing}
                  </button>
                `)}
              </div>
            ` : nothing}
          </div>
        </div>
      </div>
      <div class="rep-subtabs" role="tablist" aria-label="Reports sections">
        ${tabs.map((t) => html`
          <button
            class="rep-subtab ${_subTab === t.id ? "rep-subtab--active" : ""}"
            role="tab"
            aria-selected="${_subTab === t.id}"
            @click=${() => { _subTab = t.id; ru(); }}
          >${t.icon}${t.label}</button>
        `)}
      </div>
    </header>
  `;
}

function _renderHistory(ru: () => void): TemplateResult {
  const filtered = applyFilters(_reports);
  const kindChips: Array<{ id: string; label: string }> = [
    { id: "all", label: "All" },
    { id: "gateway_recovery", label: "Gateway Recovery" },
    { id: "ceo_hourly_insights", label: "CEO Hourly" },
    { id: "daily_summary", label: "24h Summary" },
    { id: "daily_operational", label: "Daily" },
    { id: "weekly_strategic", label: "Weekly" },
    { id: "custom", label: "Custom" },
  ];
  const statuses: StatusFilter[] = ["all", "queued", "rendering", "ready", "sent", "failed"];
  const ranges: RangeFilter[] = ["all", "24h", "7d", "30d"];

  return html`
    <div class="rep-history">
      <div class="rep-filters gt-glass">
        <div class="rep-chip-row">
          ${kindChips.map((c) => html`
            <button
              class="rep-chip ${_filterKind === c.id ? "rep-chip--active" : ""}"
              @click=${() => { _filterKind = c.id; void loadReports(_client!, ru); }}
            >${c.label}</button>
          `)}
        </div>
        <div class="rep-filter-controls">
          <select class="rep-input rep-input--sm" aria-label="Filter by status" .value=${_filterStatus} @change=${(e: Event) => { _filterStatus = (e.target as HTMLSelectElement).value as StatusFilter; void loadReports(_client!, ru); }}>
            ${statuses.map((s) => html`<option value="${s}" ?selected=${_filterStatus === s}>${s === "all" ? "All statuses" : s}</option>`)}
          </select>
          <select class="rep-input rep-input--sm" aria-label="Filter by time range" .value=${_filterRange} @change=${(e: Event) => { _filterRange = (e.target as HTMLSelectElement).value as RangeFilter; ru(); }}>
            ${ranges.map((r) => html`<option value="${r}" ?selected=${_filterRange === r}>${r === "all" ? "All time" : r === "24h" ? "Last 24h" : r === "7d" ? "Last 7 days" : "Last 30 days"}</option>`)}
          </select>
          <div class="rep-search-wrap">
            <span class="rep-search-icon">${ICO_SEARCH}</span>
            <input class="rep-search" type="search" placeholder="Search reports…" aria-label="Search reports" .value=${_filterSearch}
              @input=${(e: Event) => { _filterSearch = (e.target as HTMLInputElement).value; ru(); }} />
          </div>
        </div>
      </div>

      <div class="rep-history-body ${_rightMode !== "none" ? "rep-history-body--split" : ""}">
        <div class="rep-list-pane">
          ${_renderList(filtered, ru)}
        </div>
        ${_rightMode !== "none" ? html`<div class="rep-right-pane">${_renderRightPane(ru)}</div>` : nothing}
      </div>
    </div>
  `;
}

function _renderList(filtered: ReportRecord[], ru: () => void): TemplateResult {
  if (_loading && _reports.length === 0) return html`<div class="rep-list" aria-busy="true" aria-label="Loading reports">${_skeleton()}</div>`;

  if (_error && _reports.length === 0) {
    return glassEmpty({
      title: "Couldn't load reports",
      sub: _error,
      icon: ICO_ALERT_ORB,
      action: html`<button class="rep-btn" @click=${() => void loadReports(_client!, ru)}>Retry</button>`,
    });
  }

  if (filtered.length === 0) {
    return _reports.length === 0
      ? glassEmpty({
          title: "No reports yet",
          sub: "Generate one now, or set up a schedule or trigger so reports arrive on their own.",
          icon: ICO_DOC,
          action: html`<button class="rep-btn rep-btn--primary" @click=${() => { _kindPickerOpen = true; ru(); }}>${ICO_PLUS} Generate now</button>`,
        })
      : glassEmpty({
          title: "No reports match your filters",
          sub: "Try a wider kind, status or time range.",
          icon: ICO_DOC,
          action: html`<button class="rep-btn" @click=${() => {
            const reload = _filterKind !== "all" || _filterStatus !== "all";
            _filterKind = "all"; _filterStatus = "all"; _filterRange = "all"; _filterSearch = "";
            if (reload) void loadReports(_client!, ru); else ru();
          }}>Clear filters</button>`,
        });
  }

  return html`
    <div class="rep-list" role="list" aria-label="Reports">
      ${filtered.map((r) => {
        const isInsights = r.kind === "ceo_hourly_insights";
        return html`${renderReportCard(r, {
          expanded: _expanded.has(r.id),
          selected: _previewReportId === r.id || _insightsReportId === r.id,
          confirmingDelete: _confirmDelete.has(r.id),
          busyResend: _busyResend.has(r.id),
          busyDelete: _busyDelete.has(r.id),
          onToggleExpand: () => { _expanded.has(r.id) ? _expanded.delete(r.id) : _expanded.add(r.id); ru(); },
          onSelectPreview: () => isInsights ? void openInsights(r) : void openPreview(r),
          onDownload: () => downloadReport(r),
          onResendTelegram: () => void resendTelegram(r),
          onRequestDelete: () => { _confirmDelete.add(r.id); ru(); },
          onConfirmDelete: () => void deleteReport(r),
          onCancelDelete: () => { _confirmDelete.delete(r.id); ru(); },
          onAssociate: () => toggleAssociatePanel(_assocHost(ru), _client!, r.id),
        })}`;
      })}
    </div>
  `;
}

function _renderRightPane(ru: () => void): TemplateResult {
  if (_rightMode === "insights") {
    const report = _reports.find((r) => r.id === _insightsReportId);
    return _renderInsightsPanel(report?.title ?? "Insights", ru);
  }
  const report = _reports.find((r) => r.id === _previewReportId);
  return renderPdfPreview({
    title: report?.title ?? "Preview",
    url: _previewUrl,
    mimeType: _previewMime,
    loading: _previewLoading,
    error: _previewError,
    onClose: () => { _rightMode = "none"; _previewReportId = null; _previewUrl = null; ru(); },
    onDownload: () => { if (report) downloadReport(report); },
    onRetry: () => { if (report) void openPreview(report); },
  });
}

function _insightColor(i: ReportInsight): string {
  const sev = typeof i.severity === "number" ? i.severity : 0;
  if (i.kind === "win") return "var(--ok, #22c55e)";
  if (i.kind === "opportunity") return "var(--gt-gold)";
  if (i.kind === "risk") return sev >= 3 ? "var(--danger, #ef4444)" : "var(--warn, #f59e0b)";
  if (i.kind === "alert") return "var(--danger, #ef4444)";
  return "var(--gt-faint)";
}

function _renderInsightsPanel(title: string, ru: () => void): TemplateResult {
  const sevRank = (i: ReportInsight) => {
    const order: Record<string, number> = { alert: 0, risk: 1, opportunity: 2, win: 3 };
    const k = order[String(i.kind)] ?? 4;
    const sev = typeof i.severity === "number" ? i.severity : 0;
    return k * 10 - sev;
  };
  const sorted = [..._insights].sort((a, b) => sevRank(a) - sevRank(b));
  return html`
    <div class="rep-preview" role="region" aria-label="Insights">
      <div class="rep-preview-bar">
        <span class="rep-preview-title">${ICO_SPARK} Insights — ${title}</span>
        <div class="rep-preview-bar-actions">
          <button class="rep-preview-iconbtn" title="Close" aria-label="Close insights" @click=${() => { _rightMode = "none"; _insightsReportId = null; ru(); }}>✕</button>
        </div>
      </div>
      <div class="rep-preview-body rep-insights-body">
        ${_insightsLoading ? html`<div class="rep-insights-stack" aria-busy="true" aria-label="Loading insights">${[0, 1, 2].map(() => html`<div class="gt-skel rep-skel-row" style="height:84px"></div>`)}</div>`
          : _insightsError ? html`<div class="rep-preview-state">${glassEmpty({ title: "Couldn't load insights", sub: _insightsError, icon: ICO_ALERT_ORB })}</div>`
          : sorted.length === 0 ? html`<div class="rep-preview-state">${glassEmpty({ title: "No insights for this report", sub: "Insights appear once the CEO hourly collector records alerts, risks, wins or opportunities.", icon: ICO_SPARK_ORB })}</div>`
          : html`<div class="rep-insights-stack">
              ${sorted.map((i) => {
                const c = _insightColor(i);
                return html`
                  <div class="rep-insight-card" style="--ins-color:${c}">
                    <div class="rep-insight-head">
                      <span class="rep-insight-kind">${String(i.kind).toUpperCase()}</span>
                      <span class="rep-insight-title">${i.title}</span>
                      ${i.severity != null ? html`<span class="rep-insight-sev">sev ${i.severity}</span>` : nothing}
                    </div>
                    ${i.body ? html`<p class="rep-insight-body">${i.body}</p>` : nothing}
                    ${i.action ? html`<div class="rep-insight-action"><b>Action</b> ${i.action}</div>` : nothing}
                  </div>`;
              })}
            </div>`}
      </div>
    </div>
  `;
}

function _skeleton(): TemplateResult {
  return html`${Array.from({ length: 5 }, (_, i) => html`
    <div class="rep-skel-row">
      <div class="gt-skel rep-skel-pill"></div>
      <div class="gt-skel rep-skel-line" style="width:${45 + (i % 3) * 14}%"></div>
      <div class="gt-skel rep-skel-line" style="width:${12 + (i % 2) * 8}%;margin-left:auto"></div>
    </div>`)}`;
}
