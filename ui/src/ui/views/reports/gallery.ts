/**
 * Reports → Gallery sub-tab.
 *
 * A polished, responsive document gallery on top of the Report System store. Each
 * card shows a lazily-generated first-page thumbnail (see <report-thumbnail>), a
 * colour-coded status badge, and per-card oversight controls. A bulk selection
 * toolbar drives multi-record actions.
 *
 * RPCs consumed (clean interface — reconciled with the save-pipeline / markitdown
 * parity agent):
 *   reports.list      ({ limit })                         → { reports[], total }
 *   reports.get       ({ id })                            → { report }  (config: markdownPath, originalPath, sourceAgent, format)
 *   reports.preview   ({ id, base64:true })               → { base64 }  (thumbnail + original viewer)
 *   files.read        ({ path })                          → { content } (markdown viewer)
 *   reports.delete    ({ id })                            → { ok }
 *   reports.update    ({ id, kind })                      → { report }  (re-categorize)   [graceful if absent]
 *   reports.reconvert ({ id })                            → { ok }      (re-run markitdown) [graceful if absent]
 *
 * Fields are read tolerantly (camelCase wire shape first, snake_case + config
 * fallbacks) so the gallery degrades cleanly while the parity agent's schema lands.
 */

import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML as unsafeHtml } from "lit/directives/unsafe-html.js";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import type { GatewayBrowserClient } from "../../gateway";
import "../../components/report-thumbnail";
import { glassEmpty } from "../glass-agents-shared";
import {
  openAssociateReportId,
  renderAssociatePanel,
  toggleAssociatePanel,
} from "../../components/report-associations";

// ── Tolerant record shape ───────────────────────────────────────────────────────

export type GalleryReport = {
  id: string;
  title: string;
  kind?: string;
  category?: string;
  status?: string;
  theme?: string;
  trigger?: string;
  sourceAgent?: string;
  createdAt?: number;
  created_at?: number;
  renderedAt?: number | null;
  rendered_at?: number | null;
  filePath?: string | null;
  file_path?: string | null;
  fileSize?: number | null;
  file_size?: number | null;
  summaryText?: string | null;
  summary_text?: string | null;
  format?: string | null;
  markdownPath?: string | null;
  originalPath?: string | null;
  stale?: boolean;
  config?: Record<string, unknown> | null;
};

type SortKey = "date" | "title" | "source";
type ThumbState = "loading" | "ready" | "empty" | "failed";

// ── Field accessors (camelCase → snake_case → config fallbacks) ───────────────────

const f = {
  createdAt: (r: GalleryReport) => r.createdAt ?? r.created_at ?? 0,
  renderedAt: (r: GalleryReport) => r.renderedAt ?? r.rendered_at ?? null,
  filePath: (r: GalleryReport) => r.filePath ?? r.file_path ?? (r.config?.originalPath as string) ?? null,
  fileSize: (r: GalleryReport) => r.fileSize ?? r.file_size ?? null,
  summary: (r: GalleryReport) => r.summaryText ?? r.summary_text ?? null,
  category: (r: GalleryReport) => r.category ?? (r.config?.category as string) ?? r.kind ?? "uncategorized",
  source: (r: GalleryReport) => r.sourceAgent ?? (r.config?.sourceAgent as string) ?? null,
  format: (r: GalleryReport) => r.format ?? (r.config?.format as string) ?? null,
  markdownPath: (r: GalleryReport) => r.markdownPath ?? (r.config?.markdownPath as string) ?? null,
  stale: (r: GalleryReport) => r.stale === true || r.config?.markdownStale === true,
  family: (r: GalleryReport) =>
    ((r as any).documentFamilyId as string) ?? (r.config?.documentFamilyId as string) ?? null,
  version: (r: GalleryReport) => {
    const v = (r as any).version ?? r.config?.version;
    return typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : null;
  },
};

/**
 * Collapse report families to one card each (the highest version), leaving
 * standalone reports untouched. Annotates each returned report with
 * `familyVersionCount` / `familyMembers` for the version chip. Reports carry
 * `documentFamilyId` / `version` either top-level or in `config` (graceful —
 * no-op when absent, so non-versioned reports render exactly as before).
 */
type FamilyReport = GalleryReport & {
  familyVersionCount?: number;
  familyMembers?: GalleryReport[];
};
function collapseReportFamilies(list: GalleryReport[]): FamilyReport[] {
  const families = new Map<string, GalleryReport[]>();
  for (const r of list) {
    const fam = f.family(r);
    if (!fam) continue;
    const arr = families.get(fam) ?? [];
    arr.push(r);
    families.set(fam, arr);
  }
  const seen = new Set<string>();
  const out: FamilyReport[] = [];
  for (const r of list) {
    const fam = f.family(r);
    if (!fam) {
      out.push(r);
      continue;
    }
    if (seen.has(fam)) continue;
    seen.add(fam);
    const members = [...(families.get(fam) ?? [r])].sort(
      (a, b) => (f.version(b) ?? 0) - (f.version(a) ?? 0),
    );
    out.push({ ...members[0], familyVersionCount: members.length, familyMembers: members });
  }
  return out;
}

// ── Recategorize options (static set + whatever categories appear in data) ────────

const BASE_CATEGORIES = [
  "gateway_recovery", "ceo_hourly_insights", "daily_summary", "daily_operational",
  "weekly_strategic", "credit_burn_alert", "incident", "plan", "proposal", "research", "custom",
];

const CATEGORY_LABELS: Record<string, string> = {
  gateway_recovery: "Gateway Recovery", ceo_hourly_insights: "CEO Hourly", daily_summary: "24h Summary",
  daily_operational: "Daily", weekly_strategic: "Weekly", credit_burn_alert: "Credit Alert",
  incident: "Incident", plan: "Plan", proposal: "Proposal", research: "Research",
  custom: "Custom", uncategorized: "Uncategorized", manual_render: "Manual",
};
const catLabel = (c: string) => CATEGORY_LABELS[c] ?? c.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

// ── Module state ──────────────────────────────────────────────────────────────────

let _client: GatewayBrowserClient | null = null;
let _ru: () => void = () => {};
let _reports: GalleryReport[] = [];
let _loading = false;
let _error: string | null = null;
let _loadedOnce = false;
let _wsUnsub: (() => void) | null = null;

let _search = "";
let _category = "all";
let _sort: SortKey = "date";
let _sortDir: 1 | -1 = -1;

const _selected = new Set<string>();
const _confirmDelete = new Set<string>();
const _recatOpen = new Set<string>();
const _busy = new Set<string>();
const _thumbState = new Map<string, ThumbState>();

// modals
let _mdOpen: GalleryReport | null = null;
let _mdHtml: string | null = null;
let _mdLoading = false;
let _mdError: string | null = null;

let _origOpen: GalleryReport | null = null;
let _origUrl: string | null = null;
let _origLoading = false;
let _origError: string | null = null;

let _toast: string | null = null;
let _toastTimer: ReturnType<typeof setTimeout> | null = null;

// ── rpc ─────────────────────────────────────────────────────────────────────────

function rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
  if (!_client) return Promise.reject(new Error("no client"));
  return (_client as unknown as { request: (m: string, p?: unknown) => Promise<T> }).request(method, params);
}

function toast(msg: string): void {
  _toast = msg;
  _ru();
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { _toast = null; _ru(); }, 3200);
}

// ── Data ──────────────────────────────────────────────────────────────────────────

function extract(res: unknown): GalleryReport[] {
  if (Array.isArray(res)) return res as GalleryReport[];
  if (res && typeof res === "object" && Array.isArray((res as any).reports)) return (res as any).reports;
  return [];
}

async function load(): Promise<void> {
  if (_loading || !_client) return;
  _loading = true;
  _error = null;
  _ru();
  try {
    const res = await rpc("reports.list", { limit: 300 });
    _reports = extract(res);
    _loadedOnce = true;
  } catch (e) {
    _error = e instanceof Error ? e.message : String(e);
  } finally {
    _loading = false;
    _ru();
  }
}

function subscribeLive(): void {
  if (_wsUnsub || !_client) return;
  _wsUnsub = _client.subscribe((evt) => {
    const name = (evt.event ?? (evt as any).type ?? "") as string;
    if (!name.startsWith("report")) return;
    void load();
  });
}

// ── Filtering / sorting ─────────────────────────────────────────────────────────

function visibleReports(): GalleryReport[] {
  const q = _search.trim().toLowerCase();
  let list = _reports.filter((r) => {
    if (_category !== "all" && f.category(r) !== _category) return false;
    if (q) {
      const hay = [r.title, f.category(r), f.source(r) ?? "", f.summary(r) ?? ""].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  list = list.sort((a, b) => {
    let cmp = 0;
    if (_sort === "date") cmp = f.createdAt(a) - f.createdAt(b);
    else if (_sort === "title") cmp = (a.title || "").localeCompare(b.title || "");
    else cmp = (f.source(a) ?? f.category(a)).localeCompare(f.source(b) ?? f.category(b));
    return cmp * _sortDir;
  });
  // Fold multi-version document families into a single (current) card.
  return collapseReportFamilies(list);
}

function categoriesInData(): string[] {
  const set = new Set<string>();
  for (const r of _reports) set.add(f.category(r));
  return [...set].sort();
}

// ── Actions ─────────────────────────────────────────────────────────────────────

async function ensureConfig(r: GalleryReport): Promise<GalleryReport> {
  if (r.config !== undefined && r.config !== null) return r;
  try {
    const res = (await rpc("reports.get", { id: r.id })) as { report?: GalleryReport } | null;
    const full = res?.report;
    if (full) {
      Object.assign(r, full);
      const idx = _reports.findIndex((x) => x.id === r.id);
      if (idx >= 0) _reports[idx] = r;
    }
  } catch { /* tolerate */ }
  return r;
}

async function openMarkdown(r: GalleryReport): Promise<void> {
  _mdOpen = r; _mdHtml = null; _mdError = null; _mdLoading = true; _ru();
  try {
    await ensureConfig(r);
    const mdPath = f.markdownPath(r);
    if (!mdPath) {
      _mdError = "This document has no converted markdown yet. Run “Re-convert” to generate it.";
      return;
    }
    const res = (await rpc("files.read", { path: mdPath, encoding: "utf-8" })) as { content?: string } | null;
    const md = res?.content;
    if (!md) { _mdError = "Markdown file was empty or unreadable."; return; }
    const { toSanitizedMarkdownHtml } = await import("../../markdown/render");
    _mdHtml = toSanitizedMarkdownHtml(md);
  } catch (e) {
    _mdError = e instanceof Error ? e.message : String(e);
  } finally {
    _mdLoading = false; _ru();
  }
}

async function openOriginal(r: GalleryReport): Promise<void> {
  _origOpen = r; _origUrl = null; _origError = null; _origLoading = true; _ru();
  try {
    const res = (await rpc("reports.preview", { id: r.id, base64: true })) as
      { base64?: string; mimeType?: string } | null;
    if (!res?.base64) { _origError = "No rendered file available for this document."; return; }
    const mime = res.mimeType || "application/pdf";
    const bin = atob(res.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (_origUrl) URL.revokeObjectURL(_origUrl);
    _origUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
  } catch (e) {
    _origError = e instanceof Error ? e.message : String(e);
  } finally {
    _origLoading = false; _ru();
  }
}

function closeOriginal(): void {
  if (_origUrl) { URL.revokeObjectURL(_origUrl); _origUrl = null; }
  _origOpen = null; _origError = null; _ru();
}

async function recategorize(r: GalleryReport, category: string): Promise<void> {
  _recatOpen.delete(r.id);
  const prev = f.category(r);
  if (category === prev) { _ru(); return; }
  r.category = category; r.kind = category; // optimistic
  _ru();
  try {
    await rpc("reports.update", { id: r.id, kind: category, category });
    toast(`Re-categorized to “${catLabel(category)}”`);
  } catch {
    toast("Saved locally — backend re-categorize RPC not available yet");
  }
}

async function reconvert(r: GalleryReport): Promise<void> {
  if (_busy.has(r.id)) return;
  _busy.add(r.id); _ru();
  try {
    await rpc("reports.reconvert", { id: r.id });
    toast(`Re-conversion queued for “${r.title}”`);
    setTimeout(() => void load(), 800);
  } catch {
    toast("Re-convert RPC not available yet (markitdown pipeline pending)");
  } finally {
    _busy.delete(r.id); _ru();
  }
}

async function del(r: GalleryReport): Promise<void> {
  if (_busy.has(r.id)) return;
  _busy.add(r.id); _ru();
  try {
    await rpc("reports.delete", { id: r.id });
    _reports = _reports.filter((x) => x.id !== r.id);
    _selected.delete(r.id); _confirmDelete.delete(r.id);
    if (_origOpen?.id === r.id) closeOriginal();
    if (_mdOpen?.id === r.id) _mdOpen = null;
  } catch (e) {
    toast(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    _busy.delete(r.id); _ru();
  }
}

async function bulkDelete(): Promise<void> {
  const ids = [..._selected];
  for (const id of ids) {
    const r = _reports.find((x) => x.id === id);
    if (r) await del(r);
  }
  toast(`Deleted ${ids.length} document${ids.length === 1 ? "" : "s"}`);
}

async function bulkRecategorize(category: string): Promise<void> {
  const ids = [..._selected];
  for (const id of ids) {
    const r = _reports.find((x) => x.id === id);
    if (r) await recategorize(r, category);
  }
  _selected.clear();
  toast(`Re-categorized ${ids.length} to “${catLabel(category)}”`);
}

async function bulkReconvert(): Promise<void> {
  const ids = [..._selected];
  for (const id of ids) {
    const r = _reports.find((x) => x.id === id);
    if (r) await reconvert(r);
  }
}

// ── Status badge model ─────────────────────────────────────────────────────────

function statusBadges(r: GalleryReport): Array<{ label: string; color: string; title: string }> {
  const out: Array<{ label: string; color: string; title: string }> = [];
  const st = (r.status ?? "ready").toLowerCase();
  if (st === "failed") out.push({ label: "FAILED", color: "var(--danger, #ef4444)", title: "Conversion / render failed" });
  else if (st === "rendering" || st === "queued") out.push({ label: st.toUpperCase(), color: "var(--warn, #f59e0b)", title: "In progress" });
  else out.push({ label: "READY", color: "var(--ok, #22c55e)", title: "Conversion succeeded" });

  if (f.stale(r)) out.push({ label: "STALE MD", color: "var(--warn, #f59e0b)", title: "Original is newer than the converted markdown" });

  const thumb = _thumbState.get(r.id);
  if (thumb === "empty" || thumb === "failed") {
    out.push({ label: "NO THUMB", color: "var(--muted, #a1a1aa)", title: "Thumbnail could not be generated" });
  }
  return out;
}

// ── Render ────────────────────────────────────────────────────────────────────────

export function renderGalleryTab(client: GatewayBrowserClient, ru: () => void): TemplateResult {
  _client = client;
  _ru = ru;
  if (!_loadedOnce && !_loading) { subscribeLive(); void load(); }

  const list = visibleReports();
  const cats = categoriesInData();

  return html`
    <div class="rgal" role="region" aria-label="Document gallery">
      ${toolbar(cats)}
      ${bulkBar()}
      ${body(list)}
    </div>
  `;
}

/**
 * Gallery overlays (markdown / original viewers, associate picker, toast).
 * Rendered by the Reports view OUTSIDE the page root, so the fixed scrims sit
 * above the app chrome instead of inside the page's stacking context.
 */
export function renderGalleryOverlays(opts: { associate?: boolean } = {}): TemplateResult {
  return html`
    ${markdownModal()}
    ${originalModal()}
    ${opts.associate === false ? nothing : associateModal()}
    ${_toast ? html`<div class="rgal-toast gt-scope" role="status" aria-live="polite">${_toast}</div>` : nothing}
  `;
}

function toolbar(cats: string[]): TemplateResult {
  const chips = ["all", ...cats];
  return html`
    <div class="rgal-bar gt-glass">
      <div class="rgal-chips">
        ${chips.map((c) => html`
          <button class="rgal-chip ${_category === c ? "is-active" : ""}"
            @click=${() => { _category = c; _ru(); }}>
            ${c === "all" ? "All" : catLabel(c)}
          </button>`)}
      </div>
      <div class="rgal-controls">
        <div class="rgal-search">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="search" placeholder="Search title, source, content…" aria-label="Search documents" .value=${_search}
            @input=${(e: Event) => { _search = (e.target as HTMLInputElement).value; _ru(); }} />
        </div>
        <select class="rgal-select" aria-label="Sort documents" .value=${_sort}
          @change=${(e: Event) => { _sort = (e.target as HTMLSelectElement).value as SortKey; _ru(); }}>
          <option value="date" ?selected=${_sort === "date"}>Sort: Date</option>
          <option value="title" ?selected=${_sort === "title"}>Sort: Title</option>
          <option value="source" ?selected=${_sort === "source"}>Sort: Source agent</option>
        </select>
        <button class="rgal-dir" title="Toggle sort direction" aria-label="Toggle sort direction"
          @click=${() => { _sortDir = (_sortDir === 1 ? -1 : 1) as 1 | -1; _ru(); }}>
          ${_sortDir === -1 ? "↓" : "↑"}
        </button>
      </div>
    </div>`;
}

function bulkBar(): TemplateResult {
  if (_selected.size === 0) return html``;
  return html`
    <div class="rgal-bulk">
      <span class="rgal-bulk-count"><span class="gt-light" data-state="gold"></span>${_selected.size} selected</span>
      <div class="rgal-bulk-actions">
        <div class="rgal-recat-wrap">
          <select class="rgal-select rgal-select--sm"
            @change=${(e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) { void bulkRecategorize(v); (e.target as HTMLSelectElement).value = ""; } }}>
            <option value="">Re-categorize…</option>
            ${[...new Set([...BASE_CATEGORIES, ...categoriesInData()])].map((c) => html`<option value="${c}">${catLabel(c)}</option>`)}
          </select>
        </div>
        <button class="rgal-btn" @click=${() => void bulkReconvert()}>Re-convert</button>
        <button class="rgal-btn rgal-btn--danger" @click=${() => void bulkDelete()}>Delete</button>
        <button class="rgal-btn rgal-btn--ghost" @click=${() => { _selected.clear(); _ru(); }}>Clear</button>
      </div>
    </div>`;
}

function body(list: GalleryReport[]): TemplateResult {
  if (_loading && _reports.length === 0) return html`<div class="rgal-grid" aria-busy="true" aria-label="Loading documents">${skeletons()}</div>`;
  if (_error && _reports.length === 0) {
    return glassEmpty({
      title: "Couldn't load documents",
      sub: _error,
      icon: ICO_ALERT_ORB,
      action: html`<button class="rgal-btn" @click=${() => void load()}>${icoRefresh()} Retry</button>`,
    });
  }
  if (list.length === 0) {
    return _reports.length === 0
      ? glassEmpty({
          title: "No documents yet",
          sub: "Reports that agents save land here with first-page previews. Use Generate now above, or set up a schedule so they arrive automatically.",
          icon: ICO_DOC_ORB,
        })
      : glassEmpty({
          title: "No documents match your filters",
          sub: "Try a different category or clear the search.",
          icon: ICO_DOC_ORB,
          action: html`<button class="rgal-btn" @click=${() => { _category = "all"; _search = ""; _ru(); }}>Clear filters</button>`,
        });
  }
  return html`<div class="rgal-grid">${list.map((r) => card(r))}</div>`;
}

function card(r: FamilyReport): TemplateResult {
  const sel = _selected.has(r.id);
  const badges = statusBadges(r);
  const created = f.createdAt(r);
  const dateStr = created ? new Date(created).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  const source = f.source(r);
  const recatOpen = _recatOpen.has(r.id);
  const busy = _busy.has(r.id);

  return html`
    <div class="rgal-card ${sel ? "is-selected" : ""}" data-id=${r.id}>
      <label class="rgal-check" @click=${(e: Event) => e.stopPropagation()}>
        <input type="checkbox" .checked=${sel}
          @change=${() => { sel ? _selected.delete(r.id) : _selected.add(r.id); _ru(); }} />
      </label>

      <div class="rgal-thumb" @click=${() => void openOriginal(r)} title="Open original">
        <report-thumbnail
          .client=${_client as any}
          .reportId=${r.id}
          .filePath=${f.filePath(r)}
          .markdownPath=${f.markdownPath(r)}
          .format=${f.format(r)}
          .fileSize=${f.fileSize(r)}
          .renderedAt=${f.renderedAt(r)}
          .createdAt=${created}
          @thumb-state=${(e: CustomEvent) => {
            _thumbState.set(r.id, e.detail.state);
            if (e.detail.state === "empty" || e.detail.state === "failed") _ru();
          }}></report-thumbnail>
        <div class="rgal-badges">
          ${badges.map((b) => html`<span class="rgal-badge" style="--bc:${b.color}" title=${b.title}>${b.label}</span>`)}
        </div>
      </div>

      <div class="rgal-info">
        <div class="rgal-title" title=${r.title}>${r.title || "Untitled"}</div>
        <div class="rgal-meta">
          <span class="rgal-cat">${catLabel(f.category(r))}</span>
          ${(r.familyVersionCount ?? 1) > 1 ? html`
            <span class="rgal-ver" title="Current version — prior versions below">
              v${f.version(r) ?? r.familyVersionCount} · +${(r.familyVersionCount ?? 1) - 1}
            </span>` : nothing}
          ${source ? html`<span class="rgal-src" title="Source agent">· ${source}</span>` : nothing}
          ${dateStr ? html`<span class="rgal-date">· ${dateStr}</span>` : nothing}
        </div>
        ${(r.familyVersionCount ?? 1) > 1 ? html`
          <div class="rgal-ver-tl" title="Document version history">
            ${[...(r.familyMembers ?? [])].reverse().map((m, i) => html`
              ${i > 0 ? html`<span class="rgal-ver-line"></span>` : nothing}
              <span
                class="rgal-ver-dot ${(f.version(m) ?? 0) === (f.version(r) ?? 0) ? "is-current" : ""}"
                title="v${f.version(m) ?? "?"} — open"
                @click=${(e: Event) => { e.stopPropagation(); void openOriginal(m); }}
              ></span>`)}
          </div>` : nothing}
      </div>

      <div class="rgal-actions">
        <div class="rgal-recat">
          <button class="rgal-ico" title="Re-categorize" @click=${() => { recatOpen ? _recatOpen.delete(r.id) : _recatOpen.add(r.id); _ru(); }}>
            ${icoTag()}
          </button>
          ${recatOpen ? html`
            <div class="rgal-recat-menu" @mouseleave=${() => { _recatOpen.delete(r.id); _ru(); }}>
              ${[...new Set([...BASE_CATEGORIES, ...categoriesInData()])].map((c) => html`
                <button class="rgal-recat-item ${f.category(r) === c ? "is-cur" : ""}" @click=${() => void recategorize(r, c)}>${catLabel(c)}</button>`)}
            </div>` : nothing}
        </div>
        <button class="rgal-ico ${busy ? "is-busy" : ""}" ?disabled=${busy} title="Re-run markitdown conversion" @click=${() => void reconvert(r)}>${icoRefresh()}</button>
        <button class="rgal-ico" title="View markdown" @click=${() => void openMarkdown(r)}>${icoMd()}</button>
        <button class="rgal-ico" title="View original" @click=${() => void openOriginal(r)}>${icoEye()}</button>
        <button
          class="rgal-ico ${openAssociateReportId() === r.id ? "is-busy" : ""}"
          title="Associate with a client, opportunity or project"
          @click=${() => toggleAssociatePanel(assocHost(), _client!, r.id)}
        >${icoLink()}</button>
        <span class="rgal-spacer"></span>
        ${_confirmDelete.has(r.id) ? html`
          <button class="rgal-ico rgal-ico--danger" title="Confirm delete" @click=${() => void del(r)}>${icoCheck()}</button>
          <button class="rgal-ico" title="Cancel" @click=${() => { _confirmDelete.delete(r.id); _ru(); }}>${icoX()}</button>
        ` : html`
          <button class="rgal-ico rgal-ico--danger-ghost" title="Delete" @click=${() => { _confirmDelete.add(r.id); _ru(); }}>${icoTrash()}</button>
        `}
      </div>
    </div>`;
}

// ── Associate with a business object ──────────────────────────────────────────
// The picker itself lives in components/report-associations.ts (shared with the
// object-side "Reports" sections). The gallery only supplies the overlay: the
// card is `overflow:hidden`, so an in-card popover the size of this picker would
// be clipped.

/** Adapter so the shared component can drive this module's re-render. */
const assocHost = () => ({ requestUpdate: () => _ru() }) as never;

function associateModal(): TemplateResult {
  const id = openAssociateReportId();
  const c = _client;
  if (!id || !c) return html``;
  const r = _reports.find((x) => x.id === id);
  const close = () => toggleAssociatePanel(assocHost(), c, id);
  return html`
    <div class="rgal-modal-scrim rgal-overlay gt-scope" @click=${close}>
      <div class="rgal-modal" role="dialog" aria-modal="true" @click=${(e: Event) => e.stopPropagation()}>
        <div class="rgal-modal-bar">
          <span class="rgal-modal-title">${icoLink()} Associate · ${r?.title || "Report"}</span>
          <button class="rgal-ico" aria-label="Close" @click=${close}>${icoX()}</button>
        </div>
        <div class="rgal-assoc-body">
          ${renderAssociatePanel(assocHost(), c, id, {
            // No onClose: the modal bar above already owns the dismiss affordance.
            onLinked: (targetType, _targetId, label) => toast(`Linked to ${targetType} "${label}"`),
          })}
        </div>
      </div>
    </div>`;
}

function skeletons(): TemplateResult {
  return html`${Array.from({ length: 8 }, (_, i) => html`
    <div class="rgal-skel">
      <div class="gt-skel rgal-skel-thumb"></div>
      <div class="gt-skel rgal-skel-line" style="width:${60 + (i % 3) * 12}%"></div>
      <div class="gt-skel rgal-skel-line rgal-skel-line--sm" style="width:${30 + (i % 2) * 14}%"></div>
    </div>`)}`;
}

function markdownModal(): TemplateResult {
  if (!_mdOpen) return html``;
  const r = _mdOpen;
  return html`
    <div class="rgal-modal-scrim rgal-overlay gt-scope" @click=${() => { _mdOpen = null; _ru(); }}>
      <div class="rgal-modal" role="dialog" aria-modal="true" @click=${(e: Event) => e.stopPropagation()}>
        <div class="rgal-modal-bar">
          <span class="rgal-modal-title">${icoMd()} Markdown · ${r.title}</span>
          <button class="rgal-ico" aria-label="Close" @click=${() => { _mdOpen = null; _ru(); }}>${icoX()}</button>
        </div>
        <div class="rgal-modal-body rgal-md">
          ${_mdLoading ? html`<div class="rgal-modal-state" aria-busy="true"><div class="rgal-spin"></div></div>`
            : _mdError ? html`<div class="rgal-modal-state rgal-modal-state--err">${_mdError}</div>`
            : _mdHtml ? html`<div class="rgal-md-render">${unsafeHtml(_mdHtml)}</div>`
            : html`<div class="rgal-modal-state">No content.</div>`}
        </div>
      </div>
    </div>`;
}

function originalModal(): TemplateResult {
  if (!_origOpen) return html``;
  const r = _origOpen;
  return html`
    <div class="rgal-modal-scrim rgal-overlay gt-scope" @click=${closeOriginal}>
      <div class="rgal-modal rgal-modal--wide" role="dialog" aria-modal="true" @click=${(e: Event) => e.stopPropagation()}>
        <div class="rgal-modal-bar">
          <span class="rgal-modal-title">${icoEye()} Original · ${r.title}</span>
          <div style="display:flex;gap:6px;flex-shrink:0">
            ${_origUrl ? html`<a class="rgal-ico" href=${_origUrl} download="${(r.title || "document").replace(/[^\w.-]+/g, "_")}.pdf" title="Download">${icoDownload()}</a>` : nothing}
            <button class="rgal-ico" aria-label="Close" @click=${closeOriginal}>${icoX()}</button>
          </div>
        </div>
        <div class="rgal-modal-body rgal-orig">
          ${_origLoading ? html`<div class="rgal-modal-state" aria-busy="true"><div class="rgal-spin"></div></div>`
            : _origError ? html`<div class="rgal-modal-state rgal-modal-state--err">${_origError}</div>`
            : _origUrl ? html`<iframe class="rgal-orig-frame" src=${_origUrl} title="original document"></iframe>`
            : html`<div class="rgal-modal-state">No preview.</div>`}
        </div>
      </div>
    </div>`;
}

// ── Icons ─────────────────────────────────────────────────────────────────────────
const sv = (p: string, w = 15) => html`<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${unsafeSVG(p)}</svg>`;
const icoTag = () => sv('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>');
const icoRefresh = () => sv('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>');
const icoMd = () => sv('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>');
const icoEye = () => sv('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>');
const icoTrash = () => sv('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>');
const icoCheck = () => sv('<polyline points="20 6 9 17 4 12"/>');
const icoX = () => sv('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>');
const icoLink = () => sv('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>');
const ICO_DOC_ORB = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
const ICO_ALERT_ORB = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
const icoDownload = () => sv('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>');
