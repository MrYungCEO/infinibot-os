/**
 * Report Card — stacked card component for a single report row in the Reports view.
 *
 * Mirrors the mobile PDF stacked-card layout: status pill, title, kind badge,
 * theme badge, created/rendered timestamp, file size. Expanding the card reveals
 * summary_text + insights count + sinks delivered, plus an actions row
 * (Preview / Download / Resend Telegram / Delete).
 *
 * Pure render function (Lit `html`) — no custom element, matching the oversight
 * view's function-based rendering style. All state + handlers come in via `ctx`.
 */

import { html, nothing, type TemplateResult } from "lit";

// ── Shared report types (single source of truth, re-exported by the view) ──────

export type ReportKind =
  | "gateway_recovery"
  | "ceo_hourly_insights"
  | "daily_summary"
  | "daily_operational"
  | "weekly_strategic"
  | "credit_burn_alert"
  | "incident"
  | "custom"
  | (string & {});

export type ReportStatus = "queued" | "rendering" | "ready" | "failed" | "sent";

export type ReportTrigger = "cron" | "event" | "manual" | (string & {});

export type ReportRecord = {
  id: string;
  kind: ReportKind;
  title: string;
  theme?: string;
  status: ReportStatus;
  trigger?: ReportTrigger;
  source_record_id?: string | null;
  created_at: number;
  rendered_at?: number | null;
  file_path?: string | null;
  file_size?: number | null;
  summary_text?: string | null;
  insights_count?: number | null;
  sinks?: string[] | null;
  sinks_delivered?: string[] | null;
};

// ── Context passed from the view ───────────────────────────────────────────────

export type ReportCardCtx = {
  expanded: boolean;
  selected: boolean;
  /** delete confirm step active for this id */
  confirmingDelete: boolean;
  /** in-flight action flags */
  busyResend: boolean;
  busyDelete: boolean;
  onToggleExpand: () => void;
  onSelectPreview: () => void;
  onDownload: () => void;
  onResendTelegram: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  /**
   * Open the "Associate with…" picker for this report. Optional: the action is
   * only rendered when a host supplies it, so call sites that don't do
   * associations are unchanged.
   */
  onAssociate?: () => void;
};

// ── Icons ──────────────────────────────────────────────────────────────────────

const ICO_EYE = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const ICO_DOWNLOAD = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
const ICO_SEND = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
const ICO_TRASH = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
const ICO_LINK = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
const ICO_CHEV = html`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
const ICO_SPARK = html`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`;

// ── Formatters ──────────────────────────────────────────────────────────────────

export function fmtBytes(n?: number | null): string {
  if (!n || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function timeAgo(ts?: number | null): string {
  if (!ts) return "—";
  const d = Date.now() - ts;
  if (d < 0) return "now";
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

export function kindLabel(kind: ReportKind): string {
  switch (kind) {
    case "gateway_recovery": return "Gateway Recovery";
    case "ceo_hourly_insights": return "CEO Hourly";
    case "daily_summary": return "24h Summary";
    case "daily_operational": return "Daily";
    case "weekly_strategic": return "Weekly";
    case "credit_burn_alert": return "Credit Alert";
    case "incident": return "Incident";
    case "custom": return "Custom";
    default: return String(kind).replace(/_/g, " ");
  }
}

export function statusColor(s: ReportStatus): string {
  switch (s) {
    case "ready": return "#d4af37";
    case "sent": return "#22c55e";
    case "rendering": return "#3b82f6";
    case "queued": return "#a1a1aa";
    case "failed": return "#ef4444";
    default: return "#a1a1aa";
  }
}

function statusLabel(s: ReportStatus): string {
  return String(s).toUpperCase();
}

// ── Main render ──────────────────────────────────────────────────────────────────

export function renderReportCard(r: ReportRecord, ctx: ReportCardCtx): TemplateResult {
  const color = statusColor(r.status);
  const canPreview = r.status === "ready" || r.status === "sent";
  const isInsights = r.kind === "ceo_hourly_insights";

  return html`
    <div
      class="rep-card ${ctx.expanded ? "rep-card--expanded" : ""} ${ctx.selected ? "rep-card--selected" : ""}"
      style="--rep-color:${color}"
      role="listitem"
    >
      <div
        class="rep-card-main"
        role="button"
        tabindex="0"
        aria-expanded="${ctx.expanded}"
        @click=${ctx.onToggleExpand}
        @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ctx.onToggleExpand(); } }}
      >
        <span class="rep-status-pill" style="color:${color};border-color:${color}55;background:${color}14;">
          ${r.status === "rendering" ? html`<span class="rep-pulse" style="background:${color}"></span>` : nothing}
          ${statusLabel(r.status)}
        </span>

        <span class="rep-title">${r.title || kindLabel(r.kind)}</span>

        <span class="rep-kind-badge">${kindLabel(r.kind)}</span>

        ${r.theme ? html`<span class="rep-theme-badge" title="Theme">${r.theme}</span>` : nothing}

        ${isInsights && r.insights_count ? html`
          <span class="rep-insights-badge" title="${r.insights_count} insights">${ICO_SPARK} ${r.insights_count}</span>
        ` : nothing}

        <span class="rep-meta" title="${r.created_at ? new Date(r.created_at).toLocaleString() : ""}">${timeAgo(r.created_at)}</span>
        <span class="rep-meta rep-meta--size">${fmtBytes(r.file_size)}</span>

        <span class="rep-chev" style="transform:rotate(${ctx.expanded ? "180deg" : "0deg"})">${ICO_CHEV}</span>
      </div>

      ${ctx.expanded ? html`
        <div class="rep-card-detail">
          ${r.summary_text ? html`
            <div class="rep-detail-section">
              <div class="rep-detail-label">Summary</div>
              <p class="rep-summary">${r.summary_text}</p>
            </div>
          ` : html`<p class="rep-summary rep-summary--empty">No summary recorded for this report.</p>`}

          <div class="rep-detail-stats">
            <span class="rep-stat"><b>Trigger</b> ${r.trigger ?? "—"}</span>
            ${r.rendered_at ? html`<span class="rep-stat"><b>Rendered</b> ${timeAgo(r.rendered_at)}</span>` : nothing}
            ${isInsights ? html`<span class="rep-stat"><b>Insights</b> ${r.insights_count ?? 0}</span>` : nothing}
            <span class="rep-stat"><b>Sinks</b> ${(r.sinks_delivered ?? r.sinks ?? []).join(", ") || "—"}</span>
          </div>

          <div class="rep-actions" role="group" aria-label="Report actions">
            <button
              class="btn primary btn--sm"
              ?disabled=${!canPreview}
              aria-label=${isInsights ? "Open insights" : "Preview report inline"}
              title=${canPreview ? "Preview inline" : "Report not ready"}
              @click=${(e: Event) => { e.stopPropagation(); ctx.onSelectPreview(); }}
            >${ICO_EYE} Preview</button>

            <button
              class="btn btn--sm"
              ?disabled=${!canPreview || !r.file_path}
              aria-label="Download report PDF"
              title=${r.file_path ? "Download PDF" : "No file to download"}
              @click=${(e: Event) => { e.stopPropagation(); ctx.onDownload(); }}
            >${ICO_DOWNLOAD} Download</button>

            <button
              class="btn btn--sm"
              ?disabled=${ctx.busyResend || !canPreview}
              aria-label="Resend report to Telegram"
              aria-busy=${ctx.busyResend ? "true" : "false"}
              title="Resend to Telegram"
              @click=${(e: Event) => { e.stopPropagation(); ctx.onResendTelegram(); }}
            >${ctx.busyResend ? html`<span class="rep-btn-spin" aria-hidden="true"></span>` : ICO_SEND} ${ctx.busyResend ? "Sending…" : "Resend Telegram"}</button>

            ${ctx.onAssociate ? html`
              <button
                class="btn btn--sm"
                aria-label="Associate report with a client, opportunity or project"
                title="Associate with a client, opportunity or project"
                @click=${(e: Event) => { e.stopPropagation(); ctx.onAssociate!(); }}
              >${ICO_LINK} Associate</button>` : nothing}

            <div class="rep-actions-spacer"></div>

            ${ctx.confirmingDelete ? html`
              <span class="rep-confirm-text">Delete?</span>
              <button
                class="btn danger btn--sm"
                ?disabled=${ctx.busyDelete}
                aria-label="Confirm delete report"
                aria-busy=${ctx.busyDelete ? "true" : "false"}
                @click=${(e: Event) => { e.stopPropagation(); ctx.onConfirmDelete(); }}
              >${ctx.busyDelete ? html`<span class="rep-btn-spin" aria-hidden="true"></span>` : nothing} ${ctx.busyDelete ? "Deleting…" : "Confirm"}</button>
              <button class="btn btn--sm" aria-label="Cancel delete" @click=${(e: Event) => { e.stopPropagation(); ctx.onCancelDelete(); }}>Cancel</button>
            ` : html`
              <button
                class="btn danger btn--sm"
                aria-label="Delete report"
                title="Delete report"
                @click=${(e: Event) => { e.stopPropagation(); ctx.onRequestDelete(); }}
              >${ICO_TRASH} Delete</button>
            `}
          </div>
        </div>
      ` : nothing}
    </div>
  `;
}
