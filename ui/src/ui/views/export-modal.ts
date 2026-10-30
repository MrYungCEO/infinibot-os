/**
 * Export Modal — picks format + template + options for a database row,
 * then triggers the export-row library to download or print.
 *
 * Glassmorphism styling matches the workspace + change-DB dock so it
 * feels like one UI surface. Modal state lives on a per-row slot the
 * caller passes in; we don't grab DatabasesState directly so the modal
 * stays usable from any row context.
 */
import { html, nothing, type TemplateResult } from "lit";
import { commIcon, ensureCommunicationGlassStyles } from "./communication-glass";
import type {
  DatabaseProperty,
  DatabaseRecord,
  DatabaseRow,
} from "../controllers/databases.js";
import {
  DEFAULT_OPTIONS,
  TEMPLATE_DESCRIPTIONS,
  TEMPLATE_LABELS,
  downloadBlob,
  printRowAsPdf,
  rowToHtml,
  rowToJson,
  rowToMarkdown,
  safeFilename,
  type ExportFormat,
  type ExportOptions,
  type ExportTemplate,
} from "../lib/export-row.js";

export interface ExportModalState {
  open: boolean;
  format: ExportFormat;
  template: ExportTemplate;
  options: ExportOptions;
  /** Last error from a failed export, if any. */
  error: string | null;
  /** Set during the brief popup-open + spinner phase for PDF. */
  busy: boolean;
}

export function createExportModalState(): ExportModalState {
  return {
    open: false,
    format: "pdf",
    template: "minimal",
    options: { ...DEFAULT_OPTIONS },
    error: null,
    busy: false,
  };
}

export function openExportModal(state: ExportModalState, requestUpdate: () => void): void {
  state.open = true;
  state.error = null;
  requestUpdate();
}

export function closeExportModal(state: ExportModalState, requestUpdate: () => void): void {
  state.open = false;
  state.error = null;
  state.busy = false;
  requestUpdate();
}

interface RenderOpts {
  state: ExportModalState;
  row: DatabaseRow;
  db: DatabaseRecord | null;
  properties: DatabaseProperty[];
  requestUpdate: () => void;
}

const FORMATS: Array<{
  id: ExportFormat;
  label: string;
  blurb: string;
  icon: string;
  needsTemplate: boolean;
}> = [
  { id: "pdf", label: "PDF", blurb: "Vector print via your browser. Pick from 4 templates.", icon: "file", needsTemplate: true },
  { id: "html", label: "HTML", blurb: "Self-contained .html file with embedded styles.", icon: "globe", needsTemplate: true },
  { id: "markdown", label: "Markdown", blurb: "Plain .md — for git, Obsidian, anywhere markdown lives.", icon: "draft", needsTemplate: false },
  { id: "json", label: "JSON", blurb: "Structured snapshot of properties + body. Re-importable.", icon: "list", needsTemplate: false },
];

const TEMPLATES: ExportTemplate[] = ["minimal", "document", "magazine", "brand-card"];

// ─── Public render entry ────────────────────────────────────────────

export function renderExportModal(opts: RenderOpts): TemplateResult {
  if (!opts.state.open) return html``;
  injectStyles();
  ensureCommunicationGlassStyles();
  const { state } = opts;
  const formatMeta = FORMATS.find((f) => f.id === state.format)!;

  return html`
    <div
      class="exm-backdrop"
      @click=${(e: Event) => {
        if (e.target === e.currentTarget) closeExportModal(state, opts.requestUpdate);
      }}
    >
      <section class="exm-modal g-float" @click=${(e: Event) => e.stopPropagation()} role="dialog" aria-label="Export row">
        <div class="exm-aurora"></div>
        <header class="exm-head">
          <div class="exm-head-text">
            <span class="exm-eyebrow">Export</span>
            <h2 class="exm-title">${opts.row.title || "Untitled"}</h2>
          </div>
          <button
            class="exm-icon"
            @click=${() => closeExportModal(state, opts.requestUpdate)}
            aria-label="Close"
            title="Close"
          >${commIcon("close", 18)}</button>
        </header>

        ${state.error
          ? html`<div class="exm-error">${state.error}</div>`
          : nothing}

        <div class="exm-body">
          <section class="exm-section">
            <div class="exm-section-title">Format</div>
            <div class="exm-format-grid">
              ${FORMATS.map((f) => html`
                <button
                  class="exm-format g-card g-card--interactive ${state.format === f.id ? "is-active" : ""}"
                  @click=${() => { state.format = f.id; opts.requestUpdate(); }}
                >
                  <span class="exm-format-icon">${commIcon(f.icon, 22)}</span>
                  <span class="exm-format-label">${f.label}</span>
                  <span class="exm-format-blurb">${f.blurb}</span>
                </button>
              `)}
            </div>
          </section>

          ${formatMeta.needsTemplate
            ? html`
              <section class="exm-section">
                <div class="exm-section-title">Template</div>
                <div class="exm-templates">
                  ${TEMPLATES.map((t) => html`
                    <button
                      class="exm-template g-card g-card--interactive ${state.template === t ? "is-active" : ""} exm-tpl-${t}"
                      @click=${() => { state.template = t; opts.requestUpdate(); }}
                    >
                      <div class="exm-template-preview" aria-hidden="true">
                        ${renderTemplatePreview(t)}
                      </div>
                      <div class="exm-template-meta">
                        <span class="exm-template-label">${TEMPLATE_LABELS[t]}</span>
                        <span class="exm-template-desc">${TEMPLATE_DESCRIPTIONS[t]}</span>
                      </div>
                    </button>
                  `)}
                </div>
              </section>
            `
            : nothing}

          <section class="exm-section">
            <div class="exm-section-title">Include</div>
            <div class="exm-options">
              ${renderOption(state, "includeProperties", "Properties table", opts.requestUpdate)}
              ${renderOption(state, "includeBody", "Body content", opts.requestUpdate)}
              ${renderOption(state, "includeMeta", "Metadata footer (id + timestamps)", opts.requestUpdate)}
            </div>
          </section>
        </div>

        <footer class="exm-footer">
          <button class="exm-btn exm-btn-ghost" @click=${() => closeExportModal(state, opts.requestUpdate)}>
            Cancel
          </button>
          <button
            class="exm-btn exm-btn-primary"
            ?disabled=${state.busy}
            @click=${() => void runExport(opts)}
          >
            ${state.busy ? "Working…" : exportLabel(state.format)}
          </button>
        </footer>
      </section>
    </div>
  `;
}

function exportLabel(fmt: ExportFormat): string {
  switch (fmt) {
    case "pdf": return "Open print dialog";
    case "html": return "Download HTML";
    case "markdown": return "Download .md";
    case "json": return "Download JSON";
  }
}

function renderOption(
  state: ExportModalState,
  key: keyof ExportOptions,
  label: string,
  requestUpdate: () => void,
): TemplateResult {
  return html`
    <label class="exm-check">
      <input
        type="checkbox"
        .checked=${state.options[key]}
        @change=${(e: Event) => {
          state.options[key] = (e.target as HTMLInputElement).checked;
          requestUpdate();
        }}
      />
      <span>${label}</span>
    </label>
  `;
}

function renderTemplatePreview(t: ExportTemplate): TemplateResult {
  // Tiny inline previews — pure CSS, no images. Each preview hints at the
  // template's overall feel: paper proportions, accent placement, hero or
  // column structure. They're decorative; full templates only render when
  // the export fires.
  if (t === "minimal") {
    return html`
      <div class="exm-pv exm-pv-minimal">
        <div class="exm-pv-line w70"></div>
        <div class="exm-pv-line w40"></div>
        <div class="exm-pv-block"></div>
        <div class="exm-pv-line w90"></div>
        <div class="exm-pv-line w80"></div>
        <div class="exm-pv-line w60"></div>
      </div>
    `;
  }
  if (t === "document") {
    return html`
      <div class="exm-pv exm-pv-document">
        <div class="exm-pv-line w50 accent"></div>
        <div class="exm-pv-line w90 bold"></div>
        <div class="exm-pv-line w95"></div>
        <div class="exm-pv-line w90"></div>
        <div class="exm-pv-line w85"></div>
        <div class="exm-pv-line w95"></div>
      </div>
    `;
  }
  if (t === "magazine") {
    return html`
      <div class="exm-pv exm-pv-magazine">
        <div class="exm-pv-hero">
          <div class="exm-pv-bar"></div>
          <div class="exm-pv-line w60 inv"></div>
          <div class="exm-pv-line w80 inv bold"></div>
        </div>
        <div class="exm-pv-cols">
          <div class="exm-pv-col">
            <div class="exm-pv-line w70"></div>
            <div class="exm-pv-line w50"></div>
          </div>
          <div class="exm-pv-col">
            <div class="exm-pv-line w95"></div>
            <div class="exm-pv-line w90"></div>
            <div class="exm-pv-line w85"></div>
          </div>
        </div>
      </div>
    `;
  }
  // brand-card
  return html`
    <div class="exm-pv exm-pv-card">
      <div class="exm-pv-card-glow"></div>
      <div class="exm-pv-card-pane">
        <div class="exm-pv-line w40 accent inv"></div>
        <div class="exm-pv-line w80 inv bold"></div>
        <div class="exm-pv-line w70 inv"></div>
        <div class="exm-pv-line w60 inv"></div>
      </div>
    </div>
  `;
}

// ─── Run ────────────────────────────────────────────────────────────

async function runExport(opts: RenderOpts): Promise<void> {
  const { state, row, db, properties, requestUpdate } = opts;
  state.busy = true;
  state.error = null;
  requestUpdate();
  try {
    const fname = safeFilename(row.title, formatExt(state.format));
    if (state.format === "markdown") {
      downloadBlob(fname, "text/markdown", rowToMarkdown(row, db, properties, state.options));
    } else if (state.format === "json") {
      downloadBlob(fname, "application/json", rowToJson(row, db, properties, state.options));
    } else if (state.format === "html") {
      downloadBlob(fname, "text/html", rowToHtml(row, db, properties, state.options, state.template));
    } else {
      const result = printRowAsPdf(row, db, properties, state.options, state.template);
      if (!result.ok) {
        state.error = result.reason ?? "Could not open the print window.";
        return;
      }
    }
    // Success — keep the modal open in case the user wants another format,
    // but clear busy state.
    state.busy = false;
    requestUpdate();
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
    state.busy = false;
    requestUpdate();
  }
}

function formatExt(fmt: ExportFormat): string {
  switch (fmt) {
    case "markdown": return "md";
    case "json": return "json";
    case "html": return "html";
    case "pdf": return "pdf";
  }
}

// ─── Styles (single injection) ──────────────────────────────────────

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected || typeof document === "undefined") return;
  stylesInjected = true;
  const tag = document.createElement("style");
  tag.id = "infinibot-export-modal-styles";
  tag.textContent = EXM_STYLES;
  document.head.appendChild(tag);
}

const EXM_STYLES = `
.exm-backdrop {
  position: fixed; inset: 0; z-index: 9999;
  background: radial-gradient(ellipse 60% 60% at 50% 50%, rgba(0,0,0,0.55), rgba(0,0,0,0.78));
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  animation: exm-fade 180ms ease;
}
@keyframes exm-fade { from { opacity: 0; } to { opacity: 1; } }

.exm-modal {
  position: relative;
  width: 100%; max-width: 880px;
  max-height: 92vh;
  display: flex; flex-direction: column;
  color: var(--c-fg, #f5f5f4);
  font-family: 'Inter', system-ui, -apple-system, 'JetBrains Mono', monospace;
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--g-bg, #0a0a0a) 75%, transparent),
    color-mix(in srgb, var(--g-bg, #0a0a0a) 88%, transparent));
  border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 22%, transparent);
  border-radius: 18px;
  overflow: hidden;
  backdrop-filter: blur(28px) saturate(150%);
  -webkit-backdrop-filter: blur(28px) saturate(150%);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, #ffffff 12%, transparent),
    0 30px 80px rgba(0, 0, 0, 0.55),
    0 0 0 1px color-mix(in srgb, var(--g-primary, #fbbf24) 6%, transparent);
  animation: exm-rise 220ms cubic-bezier(0.2, 0.7, 0.2, 1);
}
@keyframes exm-rise {
  from { opacity: 0; transform: translateY(12px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

.exm-aurora {
  position: absolute; inset: -40%;
  pointer-events: none;
  background:
    radial-gradient(ellipse 50% 40% at 0% 0%, color-mix(in srgb, var(--g-primary, #fbbf24) 18%, transparent), transparent 60%),
    radial-gradient(ellipse 50% 40% at 100% 100%, color-mix(in srgb, #6366f1 14%, transparent), transparent 60%);
  filter: blur(28px);
  opacity: 0.55;
  z-index: 0;
}
.exm-modal > * { position: relative; z-index: 1; }

/* ── Header ── */
.exm-head {
  display: flex; align-items: center; gap: 12px;
  padding: 18px 22px;
  border-bottom: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 12%, transparent);
}
.exm-head-text { flex: 1; min-width: 0; }
.exm-eyebrow {
  display: block;
  font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase;
  color: color-mix(in srgb, var(--g-primary, #fbbf24) 80%, #cbd5e1);
}
.exm-title {
  margin: 4px 0 0;
  font-size: 20px; font-weight: 700; letter-spacing: -0.01em;
  color: var(--c-fg, #f5f5f4);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.exm-icon {
  appearance: none; border: none; cursor: pointer;
  width: 32px; height: 32px;
  border-radius: 8px;
  background: color-mix(in srgb, #ffffff 4%, transparent);
  color: var(--c-fg, #f5f5f4);
  font-size: 22px; line-height: 1;
}
.exm-icon:hover { background: color-mix(in srgb, var(--g-primary, #fbbf24) 12%, transparent); }

/* ── Body ── */
.exm-body {
  flex: 1;
  overflow-y: auto;
  padding: 18px 22px 8px;
  display: flex; flex-direction: column; gap: 22px;
}
.exm-section-title {
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: color-mix(in srgb, var(--g-primary, #fbbf24) 75%, #cbd5e1);
  margin-bottom: 10px;
}
.exm-error {
  margin: 14px 22px 0;
  padding: 10px 14px;
  border-radius: 10px;
  background: color-mix(in srgb, #ef4444 14%, transparent);
  border: 1px solid color-mix(in srgb, #ef4444 32%, transparent);
  color: #fca5a5;
  font-size: 12px;
}

/* ── Format grid ── */
.exm-format-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 10px;
}
.exm-format {
  appearance: none; cursor: pointer; text-align: left;
  display: grid; grid-template-columns: 32px 1fr; grid-template-rows: auto auto;
  column-gap: 12px; row-gap: 4px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
  background: color-mix(in srgb, #ffffff 3%, transparent);
  color: var(--c-fg, #f5f5f4);
  font-family: inherit;
  transition: transform 180ms ease, border-color 180ms ease, background 180ms ease, box-shadow 180ms ease;
}
.exm-format:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 32%, transparent);
}
.exm-format.is-active {
  background: color-mix(in srgb, var(--g-primary, #fbbf24) 10%, transparent);
  border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 50%, transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, #ffffff 12%, transparent),
    0 0 22px color-mix(in srgb, var(--g-primary, #fbbf24) 18%, transparent);
}
.exm-format-icon {
  grid-row: 1 / span 2;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 22px; line-height: 1;
  width: 32px; height: 32px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
}
.exm-format-label {
  font-size: 13px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
}
.exm-format-blurb {
  font-size: 11px; line-height: 1.4;
  color: color-mix(in srgb, var(--c-fg, #f5f5f4) 65%, #94a3b8);
}

/* ── Templates ── */
.exm-templates {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}
.exm-template {
  appearance: none; cursor: pointer; text-align: left;
  padding: 0;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
  background: color-mix(in srgb, #ffffff 3%, transparent);
  color: var(--c-fg, #f5f5f4);
  font-family: inherit;
  overflow: hidden;
  transition: transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease;
  display: flex; flex-direction: column;
}
.exm-template:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 32%, transparent);
}
.exm-template.is-active {
  border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 55%, transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, #ffffff 12%, transparent),
    0 0 22px color-mix(in srgb, var(--g-primary, #fbbf24) 22%, transparent);
}
.exm-template-preview {
  position: relative;
  height: 110px;
  background: linear-gradient(180deg, #ffffff, #f1f5f9);
  border-bottom: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 16%, transparent);
  overflow: hidden;
}
.exm-template-meta { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 4px; }
.exm-template-label { font-size: 13px; font-weight: 700; letter-spacing: 0.02em; }
.exm-template-desc {
  font-size: 11px; line-height: 1.4;
  color: color-mix(in srgb, var(--c-fg, #f5f5f4) 65%, #94a3b8);
}

/* ── Preview building blocks ── */
.exm-pv { position: relative; padding: 14px; height: 100%; box-sizing: border-box; }
.exm-pv-line {
  height: 5px;
  background: #94a3b8;
  border-radius: 2px;
  margin: 4px 0;
}
.exm-pv-line.bold { height: 8px; background: #1f2937; }
.exm-pv-line.accent { background: #f59e0b; height: 4px; }
.exm-pv-line.inv { background: rgba(255,255,255,0.85); }
.exm-pv-line.w40 { width: 40%; } .exm-pv-line.w50 { width: 50%; }
.exm-pv-line.w60 { width: 60%; } .exm-pv-line.w70 { width: 70%; }
.exm-pv-line.w80 { width: 80%; } .exm-pv-line.w85 { width: 85%; }
.exm-pv-line.w90 { width: 90%; } .exm-pv-line.w95 { width: 95%; }
.exm-pv-block {
  height: 18px; background: #e5e7eb; border-radius: 3px; margin: 6px 0;
}

.exm-pv-document { background: linear-gradient(180deg, #fbf7ee, #ffffff); }
.exm-pv-document .exm-pv-line.bold { background: #78350f; }

.exm-pv-magazine { padding: 0; }
.exm-pv-hero {
  background: linear-gradient(135deg, #0f172a, #312e81);
  padding: 12px 14px 14px;
  position: relative;
}
.exm-pv-bar {
  width: 22px; height: 2px;
  background: linear-gradient(90deg, #fbbf24, #f59e0b);
  margin-bottom: 4px;
}
.exm-pv-cols {
  display: grid; grid-template-columns: 1fr 2fr; gap: 8px;
  padding: 10px 14px;
}
.exm-pv-col { display: flex; flex-direction: column; }

.exm-pv-card { padding: 0; height: 100%; position: relative; overflow: hidden; }
.exm-pv-card-glow {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 50% 50% at 0% 0%, rgba(251,191,36,0.5), transparent 60%),
    radial-gradient(ellipse 50% 50% at 100% 100%, rgba(99,102,241,0.5), transparent 60%),
    linear-gradient(135deg, #0f172a, #1e1b4b);
}
.exm-pv-card-pane {
  position: absolute; inset: 16px;
  padding: 12px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.55);
  border: 1px solid rgba(251,191,36,0.3);
  backdrop-filter: blur(6px);
}

/* ── Options ── */
.exm-options { display: flex; flex-direction: column; gap: 8px; }
.exm-check {
  display: flex; align-items: center; gap: 10px;
  font-size: 13px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 140ms ease;
}
.exm-check:hover { background: color-mix(in srgb, var(--g-primary, #fbbf24) 6%, transparent); }
.exm-check input { accent-color: var(--g-primary, #fbbf24); width: 14px; height: 14px; }

/* ── Footer ── */
.exm-footer {
  display: flex; gap: 8px; justify-content: flex-end;
  padding: 14px 22px;
  border-top: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 12%, transparent);
  background: color-mix(in srgb, var(--g-bg, #0a0a0a) 50%, transparent);
}
.exm-btn {
  appearance: none; font: inherit;
  font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase;
  padding: 9px 18px;
  border-radius: 9px; cursor: pointer;
  transition: transform 160ms ease, box-shadow 160ms ease, background 160ms ease;
}
.exm-btn-ghost {
  background: color-mix(in srgb, #ffffff 4%, transparent);
  border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 18%, transparent);
  color: color-mix(in srgb, var(--c-fg, #f5f5f4) 80%, #cbd5e1);
}
.exm-btn-ghost:hover {
  background: color-mix(in srgb, var(--g-primary, #fbbf24) 8%, transparent);
  border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 32%, transparent);
  color: var(--c-fg, #f5f5f4);
}
.exm-btn-primary {
  background: linear-gradient(135deg, var(--g-primary, #fbbf24), color-mix(in srgb, var(--g-primary, #fbbf24) 70%, #6366f1));
  border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 60%, transparent);
  color: #0a0a0a;
  font-weight: 700;
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, #ffffff 32%, transparent),
    0 8px 22px color-mix(in srgb, var(--g-primary, #fbbf24) 28%, transparent);
}
.exm-btn-primary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, #ffffff 42%, transparent),
    0 14px 32px color-mix(in srgb, var(--g-primary, #fbbf24) 38%, transparent);
}
.exm-btn-primary:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }

/* Premium communication-glass finish. Kept last so the legacy modal adopts
   the shared dark/light token contract without changing its render wiring. */
.exm-modal {
  color:var(--glass-fg,var(--g-fg,#f5f5f4));
  font-family:var(--glass-font,var(--font-ui,Inter,-apple-system,sans-serif));
  border-radius:var(--glass-radius-lg,20px)!important;
}
.exm-backdrop { background:color-mix(in srgb,var(--glass-base,#090806) 68%,transparent); }
.exm-aurora {
  background:
    radial-gradient(ellipse 50% 40% at 0 0,var(--glass-gold-a16,rgba(217,180,95,.16)),transparent 60%),
    radial-gradient(ellipse 45% 38% at 100% 100%,var(--glass-gold-a10,rgba(217,180,95,.1)),transparent 64%);
  opacity:.72;
}
.exm-head,.exm-footer { border-color:var(--glass-stroke); }
.exm-head { padding:18px 22px; }
.exm-eyebrow,.exm-section-title { color:var(--glass-gold); }
.exm-title { color:var(--glass-fg); letter-spacing:var(--glass-tracking-tight,-.025em); }
.exm-icon {
  width:34px; height:34px; display:grid; place-items:center;
  border:1px solid var(--glass-stroke); border-radius:var(--glass-radius-sm,10px);
  background:var(--glass-hover); color:var(--glass-fg-2);
  transition:transform var(--glass-dur-fast),border-color var(--glass-dur-fast),color var(--glass-dur-fast);
}
.exm-icon:hover { background:var(--glass-hover); color:var(--glass-gold-hi); border-color:var(--glass-stroke-gold); transform:var(--glass-lift,translateY(-1px)); }
.exm-format,.exm-template {
  background:var(--glass-sheen),var(--glass-3); color:var(--glass-fg);
  border-color:var(--glass-stroke); box-shadow:var(--glass-elev-1);
}
.exm-format:hover,.exm-template:hover { border-color:var(--glass-stroke-gold); box-shadow:var(--glass-elev-3),var(--glass-glow-soft); }
.exm-format.is-active,.exm-template.is-active {
  background:var(--glass-gold-tint); border-color:var(--glass-stroke-gold);
  box-shadow:var(--glass-elev-2),var(--glass-glow-soft);
}
.exm-format-icon { background:var(--glass-gold-a10); color:var(--glass-gold-hi); }
.exm-format-blurb,.exm-template-desc { color:var(--glass-fg-3); }
.exm-check { color:var(--glass-fg-2); border:1px solid transparent; }
.exm-check:hover { background:var(--glass-hover); border-color:var(--glass-stroke); }
.exm-check input { accent-color:var(--glass-gold); }
.exm-footer { background:var(--glass-1); }
.exm-btn { min-height:38px; border-radius:var(--glass-radius-sm,10px); }
.exm-btn-ghost { background:var(--glass-sheen),var(--glass-hover); border-color:var(--glass-stroke); color:var(--glass-fg-2); box-shadow:var(--glass-elev-1); }
.exm-btn-ghost:hover { background:var(--glass-hover); border-color:var(--glass-stroke-gold); color:var(--glass-fg); }
.exm-btn-primary {
  background:var(--glass-gold-fill); color:var(--glass-ink,#160f03); border-color:transparent;
  box-shadow:var(--glass-elev-2),var(--glass-glow-soft);
}
.exm-btn-primary:hover:not(:disabled) { box-shadow:var(--glass-elev-3),var(--glass-glow); }
.exm-error { color:var(--glass-danger,#ef7373); }
:where(.exm-icon,.exm-format,.exm-template,.exm-btn,.exm-check input):focus-visible { outline:none; box-shadow:var(--glass-focus-ring)!important; }
@media(max-width:520px) {
  .exm-backdrop { padding:10px; align-items:flex-end; }
  .exm-modal { max-height:calc(100dvh - 20px); border-radius:var(--glass-radius-lg,20px) var(--glass-radius-lg,20px) 12px 12px!important; }
  .exm-head { padding:14px; }
  .exm-title { font-size:17px; }
  .exm-body { padding:14px 14px 6px; gap:18px; }
  .exm-format-grid,.exm-templates { grid-template-columns:1fr; }
  .exm-template { display:grid; grid-template-columns:112px minmax(0,1fr); }
  .exm-template-preview { height:84px; border-bottom:0; border-right:1px solid var(--glass-stroke); }
  .exm-footer { padding:12px 14px; }
  .exm-btn { min-height:42px; flex:1; padding-inline:10px; }
}
@media(prefers-reduced-motion:reduce) { .exm-backdrop,.exm-modal { animation:none; } .exm-format,.exm-template,.exm-btn { transition:none; } }
@media(prefers-reduced-transparency:reduce) { .exm-backdrop { backdrop-filter:none; -webkit-backdrop-filter:none; } }
`;
