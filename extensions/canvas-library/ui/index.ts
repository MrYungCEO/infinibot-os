/**
 * HoloCanvas library page — /canvas route (plugin extensions/canvas-library).
 *
 * A gallery + viewer + share surface for infinite-canvas-walkthrough payloads.
 * Rendered only while the plugin is on (app-render gates the `canvas` tab);
 * talks to the plugin's `canvas-library.*` RPCs. Share links, the HTML export
 * and re-emit use the core canvas runtime, so they work for any saved canvas.
 *
 * Three-pane layout (collapses to single-column <1100px):
 *   Left   — tag filter chips
 *   Center — card grid (title, scene/node count, baked badge, thumbnail)
 *   Right  — inspector: inline preview + play/bake/share/download/re-emit/delete
 * Header — New (paste a payload) · From report · Load examples (opt-in).
 *
 * Design: strict black/gold glassmorphism per feedback_infinibot_os_design_language.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../../ui/src/ui/gateway";

// Ensure the renderer custom element is defined (import side-effect).
import "../../../ui/src/ui/components/walkthroughs/infinite-canvas-walkthrough.js";
import { gatewayOrigin } from "../../../ui/src/ui/gateway-endpoint";

export interface CanvasLibraryEntry {
  id: string;
  title: string;
  tags: string[];
  sceneCount: number;
  nodeCount: number;
  hasBakedAudio: boolean;
  thumbnailDataUrl: string | null;
  createdAt: number;
  updatedAt: number;
  payload?: unknown;
}

// ── Module-level state (mirrors the reports view pattern) ──────────────────────

let _client: GatewayBrowserClient | null = null;
let _requestUpdate: (() => void) | null = null;

let _entries: CanvasLibraryEntry[] = [];
let _tags: string[] = [];
let _activeTag: string | null = null;
let _selectedId: string | null = null;
let _selectedPayload: unknown | null = null;
let _loading = false;
let _error: string | null = null;
let _showNewForm = false;
let _newTitle = "";
let _newPayloadText = "";
let _newTags = "";
let _newError: string | null = null;
let _newSaving = false;
let _baking = false;
let _copyFeedback = false;
let _previewKey = 0;
let _showReportPicker = false;
let _reports: ReportRow[] = [];
let _reportsLoading = false;
let _reportsError: string | null = null;
let _convertingId: string | null = null;
let _examplesBusy = false;

interface ReportRow {
  id: string;
  title: string;
  kind?: string;
  createdAt?: number;
  category?: string | null;
}

const CHANGED_EVENT = "canvas-library:changed";

function ru() {
  _requestUpdate?.();
}

async function rpc(method: string, params?: unknown): Promise<unknown> {
  if (!_client) throw new Error("no client");
  return _client.request(method, params);
}

export async function loadCanvasLibrary(
  client: GatewayBrowserClient,
  requestUpdate: () => void,
): Promise<void> {
  _client = client;
  _requestUpdate = requestUpdate;
  _loading = true;
  _error = null;
  ru();

  try {
    // No auto-seeding: examples are opt-in ("Load examples").
    const [listRes, tagsRes] = await Promise.all([
      rpc("canvas-library.list", { limit: 200 }),
      rpc("canvas-library.tags"),
    ]);
    _entries = (listRes as { entries: CanvasLibraryEntry[] }).entries ?? [];
    _tags = (tagsRes as { tags: string[] }).tags ?? [];
    _loading = false;
    ru();

    // Subscribe to live changes.
    client.subscribe((evt) => {
      const name = (evt.event ?? (evt as { type?: string }).type ?? "") as string;
      if (name === CHANGED_EVENT) void reloadList();
    });
  } catch (e) {
    _error = e instanceof Error ? e.message : String(e);
    _loading = false;
    ru();
  }
}

async function reloadList() {
  try {
    const [listRes, tagsRes] = await Promise.all([
      rpc("canvas-library.list", { limit: 200, ..._activeTag ? { tag: _activeTag } : {} }),
      rpc("canvas-library.tags"),
    ]);
    _entries = (listRes as { entries: CanvasLibraryEntry[] }).entries ?? [];
    _tags = (tagsRes as { tags: string[] }).tags ?? [];
    ru();
  } catch {
    /* ignore reload errors */
  }
}

async function selectEntry(id: string) {
  _selectedId = id;
  _selectedPayload = null;
  _previewKey++;
  ru();
  try {
    const res = await rpc("canvas-library.get", { id }) as { entry: CanvasLibraryEntry & { payload: unknown } };
    _selectedPayload = res.entry.payload;
    _previewKey++;
    ru();
  } catch {
    /* leave payload null */
  }
}

async function bakeSelected() {
  if (!_selectedId || _baking) return;
  _baking = true;
  ru();
  try {
    await rpc("canvas-library.bake", { id: _selectedId });
    await reloadList();
    // Reload the full payload so baked audioUrls are reflected.
    const res = await rpc("canvas-library.get", { id: _selectedId }) as { entry: CanvasLibraryEntry & { payload: unknown } };
    _selectedPayload = res.entry.payload;
    _previewKey++;
  } catch (e) {
    alert("Bake failed: " + (e instanceof Error ? e.message : String(e)));
  }
  _baking = false;
  ru();
}

async function copyShareLink() {
  if (!_selectedId) return;
  const base = gatewayOrigin();
  const url = `${base}/canvas/${_selectedId}`;
  try {
    await navigator.clipboard.writeText(url);
    _copyFeedback = true;
    ru();
    setTimeout(() => {
      _copyFeedback = false;
      ru();
    }, 2000);
  } catch {
    window.prompt("Copy share link:", url);
  }
}

function downloadHtml() {
  if (!_selectedId) return;
  const url = `/api/canvas/${_selectedId}/export.html`;
  const a = document.createElement("a");
  a.href = url;
  a.download = `canvas-${_selectedId.slice(0, 8)}.html`;
  a.click();
}

async function reEmit() {
  if (!_selectedId || !_selectedPayload) return;
  const entry = _entries.find((e) => e.id === _selectedId);
  if (!entry) return;
  try {
    await fetch("/api/proactive/emit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "NOTABLE",
        title: entry.title,
        body: "Canvas walkthrough from library.",
        attribution: { agentId: "canvas-library", agentName: "HoloCanvas" },
        dedupKey: `canvas-lib-${entry.id}-${Date.now()}`,
        media: {
          kind: "infinite-canvas-walkthrough",
          payload: _selectedPayload,
        },
      }),
    });
  } catch (e) {
    alert("Re-emit failed: " + (e instanceof Error ? e.message : String(e)));
  }
}

async function deleteSelected() {
  if (!_selectedId) return;
  const entry = _entries.find((e) => e.id === _selectedId);
  if (!entry) return;
  if (!confirm(`Delete "${entry.title}"? This cannot be undone.`)) return;
  try {
    await rpc("canvas-library.delete", { id: _selectedId });
    _selectedId = null;
    _selectedPayload = null;
    await reloadList();
  } catch (e) {
    alert("Delete failed: " + (e instanceof Error ? e.message : String(e)));
  }
}

async function saveNew() {
  if (_newSaving) return;
  const title = _newTitle.trim();
  if (!title) {
    _newError = "Title is required.";
    ru();
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(_newPayloadText);
  } catch {
    _newError = "Payload is not valid JSON.";
    ru();
    return;
  }
  const tags = _newTags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  _newSaving = true;
  _newError = null;
  ru();
  try {
    const res = await rpc("canvas-library.save", { title, payload, tags }) as { entry: CanvasLibraryEntry };
    _showNewForm = false;
    _newTitle = "";
    _newPayloadText = "";
    _newTags = "";
    await reloadList();
    void selectEntry(res.entry.id);
  } catch (e) {
    _newError = e instanceof Error ? e.message : String(e);
  }
  _newSaving = false;
  ru();
}

async function loadExamples() {
  if (_examplesBusy) return;
  _examplesBusy = true;
  ru();
  try {
    await rpc("canvas-library.examples.load");
    await reloadList();
  } catch (e) {
    alert("Loading examples failed: " + (e instanceof Error ? e.message : String(e)));
  }
  _examplesBusy = false;
  ru();
}

async function openReportPicker() {
  _showReportPicker = true;
  _reportsLoading = true;
  _reportsError = null;
  ru();
  try {
    // Core reports RPC — reports themselves are not part of this plugin.
    const res = (await rpc("reports.list", { limit: 50 })) as { reports?: ReportRow[] };
    _reports = res.reports ?? [];
  } catch (e) {
    _reportsError = e instanceof Error ? e.message : String(e);
  }
  _reportsLoading = false;
  ru();
}

async function canvasFromReport(reportId: string) {
  if (_convertingId) return;
  _convertingId = reportId;
  _reportsError = null;
  ru();
  try {
    const res = (await rpc("canvas-library.fromSource", {
      source: "report",
      reportId,
    })) as { entry: CanvasLibraryEntry };
    _showReportPicker = false;
    _activeTag = null;
    await reloadList();
    void selectEntry(res.entry.id);
  } catch (e) {
    _reportsError = e instanceof Error ? e.message : String(e);
  }
  _convertingId = null;
  ru();
}

// ── Render ─────────────────────────────────────────────────────────────────────

export function renderCanvasLibraryView(
  _state: unknown,
  client: GatewayBrowserClient,
  requestUpdate: () => void,
): TemplateResult {
  if (_client !== client) {
    void loadCanvasLibrary(client, requestUpdate);
  }

  const selected = _selectedId ? _entries.find((e) => e.id === _selectedId) ?? null : null;

  return html`
    <style>
      .cl-root {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: #05060b;
        color: #f5eacd;
        font-family: system-ui, sans-serif;
        --gold-1: #d4af37;
        --gold-2: #f4d77a;
        --void-0: #05060b;
        --glass-bg: rgba(14, 12, 8, 0.78);
        --glass-border: rgba(212, 175, 55, 0.22);
        --fg: #f5eacd;
        --fg-faint: rgba(245, 234, 205, 0.6);
        overflow: hidden;
      }
      .cl-header {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px 20px;
        border-bottom: 1px solid var(--glass-border);
        background: rgba(8, 7, 5, 0.6);
        flex-shrink: 0;
      }
      .cl-header-title {
        font-size: 0.78rem;
        font-weight: 800;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--gold-1);
      }
      .cl-header-count {
        font-size: 0.7rem;
        color: var(--fg-faint);
        margin-left: auto;
      }
      .cl-btn {
        padding: 6px 14px;
        border-radius: 8px;
        background: rgba(212, 175, 55, 0.1);
        border: 1px solid var(--glass-border);
        color: var(--fg);
        font-size: 0.78rem;
        font-weight: 700;
        cursor: pointer;
        transition: border-color 160ms;
      }
      .cl-btn:hover { border-color: var(--gold-1); }
      .cl-btn.primary {
        background: linear-gradient(135deg, var(--gold-1), #b8902f);
        color: #1a1206;
        border-color: var(--gold-1);
      }
      .cl-btn.danger { border-color: rgba(239,68,68,0.4); color: #fca5a5; }
      .cl-btn.danger:hover { border-color: #ef4444; }
      .cl-body {
        display: flex;
        flex: 1;
        overflow: hidden;
        min-height: 0;
      }
      /* ── Left sidebar ── */
      .cl-sidebar {
        width: 200px;
        flex-shrink: 0;
        border-right: 1px solid var(--glass-border);
        padding: 14px 12px;
        overflow-y: auto;
        background: rgba(6, 5, 3, 0.4);
      }
      .cl-sidebar-label {
        font-size: 0.62rem;
        font-weight: 800;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--gold-1);
        margin-bottom: 8px;
      }
      .cl-tag {
        display: block;
        width: 100%;
        text-align: left;
        padding: 5px 10px;
        border-radius: 7px;
        background: transparent;
        border: 1px solid transparent;
        color: var(--fg-faint);
        font-size: 0.78rem;
        cursor: pointer;
        transition: all 160ms;
        margin-bottom: 3px;
      }
      .cl-tag:hover { background: rgba(212,175,55,0.06); border-color: var(--glass-border); }
      .cl-tag.active {
        background: rgba(212,175,55,0.12);
        border-color: var(--glass-border);
        color: var(--gold-2);
      }
      /* ── Center grid ── */
      .cl-grid-wrap {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
        min-width: 0;
      }
      .cl-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 12px;
      }
      .cl-card {
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: 14px;
        padding: 14px;
        cursor: pointer;
        transition: border-color 160ms, box-shadow 160ms;
        position: relative;
        overflow: hidden;
      }
      .cl-card:hover {
        border-color: rgba(212,175,55,0.5);
        box-shadow: 0 4px 24px -8px rgba(212,175,55,0.2);
      }
      .cl-card.selected {
        border-color: var(--gold-1);
        box-shadow: 0 0 0 1px var(--gold-1), 0 4px 24px -8px rgba(212,175,55,0.35);
      }
      .cl-card-thumb {
        width: 100%;
        aspect-ratio: 16/9;
        background: rgba(212,175,55,0.04);
        border-radius: 8px;
        margin-bottom: 10px;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1px solid rgba(212,175,55,0.1);
      }
      .cl-card-thumb img { width: 100%; height: 100%; object-fit: cover; border-radius: 7px; }
      .cl-card-thumb-placeholder {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        color: var(--gold-1);
        opacity: 0.45;
      }
      .cl-card-thumb-icon { font-size: 1.4rem; }
      .cl-card-thumb-count { font-size: 0.62rem; font-weight: 700; letter-spacing: 0.06em; }
      .cl-card-title {
        font-size: 0.82rem;
        font-weight: 700;
        color: var(--fg);
        line-height: 1.35;
        margin-bottom: 6px;
      }
      .cl-card-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        font-size: 0.64rem;
        color: var(--fg-faint);
      }
      .cl-badge {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 7px;
        border-radius: 5px;
        background: rgba(212,175,55,0.08);
        border: 1px solid rgba(212,175,55,0.18);
        font-size: 0.6rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        color: var(--gold-2);
      }
      .cl-badge.baked { background: rgba(74,222,128,0.08); border-color: rgba(74,222,128,0.3); color: #4ade80; }
      /* ── Right inspector ── */
      .cl-inspector {
        width: 480px;
        flex-shrink: 0;
        border-left: 1px solid var(--glass-border);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        background: rgba(8,7,5,0.5);
      }
      .cl-inspector-empty {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--fg-faint);
        font-size: 0.82rem;
        text-align: center;
        padding: 2rem;
      }
      .cl-inspector-top {
        padding: 14px 16px;
        border-bottom: 1px solid var(--glass-border);
        flex-shrink: 0;
      }
      .cl-inspector-title {
        font-size: 0.9rem;
        font-weight: 700;
        color: var(--fg);
        margin-bottom: 8px;
        line-height: 1.3;
      }
      .cl-inspector-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .cl-preview-frame {
        flex: 1;
        position: relative;
        overflow: hidden;
        min-height: 200px;
        background: #030407;
        /* transform creates a new containing block for position:fixed children */
        transform: translateZ(0);
      }
      .cl-preview-loading {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--fg-faint);
        font-size: 0.78rem;
      }
      /* Override the host element's position:fixed so it fills the frame */
      .cl-preview-frame infinite-canvas-walkthrough-overlay {
        position: absolute !important;
        inset: 0 !important;
        z-index: 1 !important;
        width: 100% !important;
        height: 100% !important;
      }
      /* ── New form ── */
      .cl-modal-bg {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.7);
        z-index: 200;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
      }
      .cl-modal {
        background: #0a0909;
        border: 1px solid var(--glass-border);
        border-radius: 16px;
        padding: 24px;
        width: min(560px, 90vw);
        display: flex;
        flex-direction: column;
        gap: 14px;
        max-height: 90vh;
        overflow-y: auto;
      }
      .cl-modal-title {
        font-size: 0.9rem;
        font-weight: 800;
        color: var(--gold-1);
        letter-spacing: 0.1em;
        text-transform: uppercase;
      }
      .cl-field-label {
        font-size: 0.68rem;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--fg-faint);
        margin-bottom: 5px;
      }
      .cl-input {
        width: 100%;
        background: rgba(255,255,255,0.04);
        border: 1px solid var(--glass-border);
        border-radius: 9px;
        padding: 9px 12px;
        color: var(--fg);
        font-size: 0.85rem;
        font-family: inherit;
        outline: none;
        transition: border-color 160ms;
        box-sizing: border-box;
      }
      .cl-input:focus { border-color: var(--gold-1); }
      .cl-textarea {
        height: 180px;
        resize: vertical;
        font-family: ui-monospace, Menlo, Consolas, monospace;
        font-size: 0.78rem;
        line-height: 1.5;
      }
      .cl-modal-error {
        font-size: 0.78rem;
        color: #fca5a5;
        background: rgba(239,68,68,0.08);
        border: 1px solid rgba(239,68,68,0.25);
        border-radius: 8px;
        padding: 8px 12px;
      }
      .cl-modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
      .cl-loading-state {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--fg-faint);
        font-size: 0.82rem;
      }
      .cl-error-state {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fca5a5;
        font-size: 0.82rem;
        padding: 2rem;
        text-align: center;
      }
      .cl-empty { color: var(--fg-faint); font-size: 0.85rem; padding: 2.5rem 2rem; max-width: 520px; line-height: 1.5; }
      .cl-empty-title { color: var(--gold-1); font-weight: 800; font-size: 0.95rem; margin-bottom: 6px; }
      .cl-empty-actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
      .cl-report-list { display: flex; flex-direction: column; gap: 6px; max-height: 52vh; overflow-y: auto; }
      .cl-report-row {
        display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 10px;
        border: 1px solid var(--glass-border); background: rgba(212, 175, 55, 0.04);
      }
      .cl-report-row-main { flex: 1; min-width: 0; }
      .cl-report-row-title { font-weight: 700; font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .cl-report-row-meta { font-size: 0.7rem; color: var(--fg-faint); }
      .cl-header .cl-btn:disabled, .cl-empty .cl-btn:disabled { opacity: 0.5; cursor: default; }
      @media (max-width: 640px) {
        .cl-header { flex-wrap: wrap; padding: 12px 14px; }
        .cl-header-count { margin-left: 0; flex: 1; }
        .cl-inspector-actions { flex-wrap: wrap; }
      }
      @media (max-width: 1100px) {
        .cl-inspector { width: 100%; border-left: none; border-top: 1px solid var(--glass-border); }
        .cl-body { flex-direction: column; }
        .cl-sidebar { width: 100%; height: auto; border-right: none; border-bottom: 1px solid var(--glass-border); overflow-x: auto; display: flex; align-items: center; gap: 6px; }
        .cl-sidebar-label { display: none; }
        .cl-tag { display: inline-block; width: auto; white-space: nowrap; }
      }
    </style>

    <div class="cl-root">
      ${renderHeader()}
      <div class="cl-body">
        ${renderSidebar()}
        ${_loading
          ? html`<div class="cl-loading-state">Loading canvas library…</div>`
          : _error
          ? html`<div class="cl-error-state">Failed to load: ${_error}</div>`
          : html`
            <div class="cl-grid-wrap" data-learn-id="holocanvas-gallery">
              ${_entries.length === 0
                ? html`<div class="cl-empty" data-learn-id="holocanvas-empty">
                    <div class="cl-empty-title">No canvases yet</div>
                    <p>Build one from a report, paste a payload, or load two short examples.
                      Canvases that agents save (for example work reviews) appear here too.</p>
                    <div class="cl-empty-actions">
                      <button class="cl-btn primary" @click=${() => void openReportPicker()}>From report</button>
                      <button class="cl-btn" ?disabled=${_examplesBusy} @click=${() => void loadExamples()}>
                        ${_examplesBusy ? "Loading…" : "Load examples"}
                      </button>
                    </div>
                  </div>`
                : html`<div class="cl-grid">${_entries.map(renderCard)}</div>`}
            </div>
            ${renderInspector(selected)}
          `}
      </div>
      <!-- Modals live inside .cl-root so they inherit its gold/glass variables. -->
      ${_showNewForm ? renderNewForm() : nothing}
      ${_showReportPicker ? renderReportPicker() : nothing}
    </div>
  `;
}

function renderHeader(): TemplateResult {
  return html`
    <div class="cl-header" data-learn-id="holocanvas-header">
      <span class="cl-header-title">HoloCanvas Library</span>
      <span class="cl-header-count">${_entries.length} canvas${_entries.length === 1 ? "" : "es"}</span>
      <button class="cl-btn primary" data-learn-id="holocanvas-new" @click=${() => { _showNewForm = true; ru(); }}>+ New</button>
      <button class="cl-btn" data-learn-id="holocanvas-from-report" @click=${() => void openReportPicker()}>From report</button>
      <button class="cl-btn" data-learn-id="holocanvas-load-examples" title="Add two short example canvases" ?disabled=${_examplesBusy}
        @click=${() => void loadExamples()}>${_examplesBusy ? "Loading…" : "Load examples"}</button>
    </div>
  `;
}

function renderSidebar(): TemplateResult {
  return html`
    <div class="cl-sidebar" data-learn-id="holocanvas-tags">
      <div class="cl-sidebar-label">Filter by tag</div>
      <button class=${"cl-tag" + (_activeTag === null ? " active" : "")} @click=${() => {
        _activeTag = null;
        void reloadList();
      }}>All</button>
      ${_tags.map(
        (tag) => html`
          <button class=${"cl-tag" + (_activeTag === tag ? " active" : "")} @click=${() => {
            _activeTag = tag;
            void reloadList();
          }}>${tag}</button>
        `,
      )}
    </div>
  `;
}

function renderCard(entry: CanvasLibraryEntry): TemplateResult {
  const isSelected = _selectedId === entry.id;
  return html`
    <div class=${"cl-card" + (isSelected ? " selected" : "")} data-learn-id="holocanvas-card" @click=${() => void selectEntry(entry.id)}>
      <div class="cl-card-thumb">
        ${entry.thumbnailDataUrl
          ? html`<img src=${entry.thumbnailDataUrl} alt="" />`
          : html`
            <div class="cl-card-thumb-placeholder">
              <span class="cl-card-thumb-icon">⬡</span>
              <span class="cl-card-thumb-count">${entry.nodeCount} nodes · ${entry.sceneCount} scenes</span>
            </div>
          `}
      </div>
      <div class="cl-card-title">${entry.title}</div>
      <div class="cl-card-meta">
        <span>${entry.sceneCount} scenes</span>
        <span>·</span>
        <span>${entry.nodeCount} nodes</span>
        ${entry.hasBakedAudio ? html`<span class="cl-badge baked">✓ baked</span>` : nothing}
        ${entry.tags.map((t) => html`<span class="cl-badge">${t}</span>`)}
      </div>
    </div>
  `;
}

function renderInspector(entry: CanvasLibraryEntry | null): TemplateResult {
  return html`
    <div class="cl-inspector" data-learn-id="holocanvas-inspector">
      ${entry
        ? html`
          <div class="cl-inspector-top">
            <div class="cl-inspector-title">${entry.title}</div>
            <div class="cl-inspector-actions" data-learn-id="holocanvas-actions">
              <button class="cl-btn" data-learn-id="holocanvas-bake" @click=${() => void bakeSelected()} ?disabled=${_baking}>
                ${_baking ? "Baking…" : "Bake Narration"}
              </button>
              <button class="cl-btn primary" data-learn-id="holocanvas-share" @click=${() => void copyShareLink()}>
                ${_copyFeedback ? "Copied!" : "Copy Link"}
              </button>
              <button class="cl-btn" data-learn-id="holocanvas-download" @click=${downloadHtml}>Download HTML</button>
              <button class="cl-btn" data-learn-id="holocanvas-reemit" @click=${() => void reEmit()} title="Re-emit as proactive overlay">Re-emit</button>
              <button class="cl-btn danger" @click=${() => void deleteSelected()}>Delete</button>
            </div>
          </div>
          <div class="cl-preview-frame" data-learn-id="holocanvas-preview">
            ${_selectedPayload == null
              ? html`<div class="cl-preview-loading">Loading preview…</div>`
              : html`
                  <infinite-canvas-walkthrough-overlay
                    key=${_previewKey}
                    .payload=${_selectedPayload}
                    @pmedia-dismiss=${() => {
                      // In inline mode, restart from scene 0 instead of dismissing.
                      const overlay = document.querySelector("infinite-canvas-walkthrough-overlay");
                      if (overlay) (overlay as unknown as { index: number }).index = 0;
                    }}
                  ></infinite-canvas-walkthrough-overlay>
                `}
          </div>
        `
        : html`<div class="cl-inspector-empty">Select a canvas to preview it here.</div>`}
    </div>
  `;
}

function renderNewForm(): TemplateResult {
  return html`
    <div class="cl-modal-bg" @click=${(e: Event) => {
      if ((e.target as HTMLElement).classList.contains("cl-modal-bg")) {
        _showNewForm = false;
        ru();
      }
    }}>
      <div class="cl-modal" data-learn-id="holocanvas-new-modal">
        <div class="cl-modal-title">New Canvas</div>

        <div>
          <div class="cl-field-label">Title</div>
          <input
            class="cl-input"
            type="text"
            placeholder="My walkthrough title"
            .value=${_newTitle}
            @input=${(e: Event) => { _newTitle = (e.target as HTMLInputElement).value; }}
          />
        </div>

        <div>
          <div class="cl-field-label">Payload JSON (InfiniteCanvasWalkthroughMedia)</div>
          <textarea
            class="cl-input cl-textarea"
            placeholder='{ "nodes": [...], "scenes": [...] }'
            .value=${_newPayloadText}
            @input=${(e: Event) => { _newPayloadText = (e.target as HTMLTextAreaElement).value; }}
          ></textarea>
        </div>

        <div>
          <div class="cl-field-label">Tags (comma-separated)</div>
          <input
            class="cl-input"
            type="text"
            placeholder="demo, moat"
            .value=${_newTags}
            @input=${(e: Event) => { _newTags = (e.target as HTMLInputElement).value; }}
          />
        </div>

        ${_newError ? html`<div class="cl-modal-error">${_newError}</div>` : nothing}

        <div class="cl-modal-actions">
          <button class="cl-btn" data-learn-id="holocanvas-new-cancel" @click=${() => { _showNewForm = false; _newError = null; ru(); }}>Cancel</button>
          <button class="cl-btn primary" ?disabled=${_newSaving} @click=${() => void saveNew()}>
            ${_newSaving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderReportPicker(): TemplateResult {
  const close = () => {
    _showReportPicker = false;
    _reportsError = null;
    ru();
  };
  return html`
    <div class="cl-modal-bg" @click=${(e: Event) => {
      if ((e.target as HTMLElement).classList.contains("cl-modal-bg")) close();
    }}>
      <div class="cl-modal" data-learn-id="holocanvas-report-modal" role="dialog" aria-label="Build a canvas from a report">
        <div class="cl-modal-title">Build a canvas from a report</div>
        <div class="cl-field-label">Each report section becomes a card and a scene.</div>
        ${_reportsLoading
          ? html`<div class="cl-preview-loading">Loading reports…</div>`
          : _reports.length === 0
            ? html`<div class="cl-report-row-meta">No reports yet.</div>`
            : html`<div class="cl-report-list">
                ${_reports.map(
                  (r) => html`
                    <div class="cl-report-row">
                      <div class="cl-report-row-main">
                        <div class="cl-report-row-title">${r.title}</div>
                        <div class="cl-report-row-meta">
                          ${[r.category ?? r.kind, r.createdAt ? new Date(r.createdAt).toLocaleDateString() : ""]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </div>
                      <button class="cl-btn primary" ?disabled=${_convertingId !== null}
                        @click=${() => void canvasFromReport(r.id)}>
                        ${_convertingId === r.id ? "Building…" : "Build"}
                      </button>
                    </div>
                  `,
                )}
              </div>`}
        ${_reportsError ? html`<div class="cl-modal-error">${_reportsError}</div>` : nothing}
        <div class="cl-modal-actions">
          <button class="cl-btn" data-learn-id="holocanvas-report-close" @click=${close}>Close</button>
        </div>
      </div>
    </div>
  `;
}
