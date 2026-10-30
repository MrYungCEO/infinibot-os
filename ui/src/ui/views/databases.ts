/**
 * Databases view — Notion-style table/board/gallery/calendar for any database
 * managed by the generic db.* gateway surface.
 *
 * Layout:
 *   ┌─────────────┬──────────────────────────────────────────┐
 *   │  sidebar    │   header (title, view tabs, new row…)   │
 *   │  (list)     ├──────────────────────────────────────────┤
 *   │             │   active view (table / board / …)        │
 *   └─────────────┴──────────────────────────────────────────┘
 *
 *   Clicking a row opens a right-side detail drawer.
 */

import { html, nothing, type TemplateResult } from "lit";
import "./work-glass/remaining.css";
import { getBizFilter, setBizFilter } from "../lib/biz-filter";
import "../components/block-editor.js";
import "../components/doc-agent-panel.js";
import type { AppViewState } from "../app-view-state.js";
import type { GatewayBrowserClient } from "../gateway.js";
import { icons } from "../icons.js";
import {
  type DatabaseRecord,
  type DatabaseRow,
  type DatabaseProperty,
  type DatabasesState,
  type DbView,
  type PropertyValue,
  closeRelationPicker,
  closeRowPage,
  createDatabase,
  createLinkedSubPage,
  createProperty,
  createRow,
  createSubpage,
  databaseSupportsSync,
  defaultValueFor,
  deleteRow,
  deleteDatabase,
  findDatabase,
  getDatabasesState,
  getTitleProperty,
  importFromNotion,
  discoverNotionDatabases,
  toggleImportSelection,
  selectAllImportable,
  isSyncEnabled,
  lastSyncedAt,
  loadDatabase,
  loadDatabases,
  openRelationPicker,
  openRowPage,
  runSync,
  setDatabaseBusiness,
  setGroupBy,
  setSelectedRow,
  setSyncEnabled,
  setView,
  removeFileFromRowProperty,
  resolveFileUrl,
  updateOpenRow,
  updateRow,
  uploadFilesToRowProperty,
  valueAsString,
  type RelatedGroup,
} from "../controllers/databases.js";
import {
  renderSystemDatabasesCard,
  renderSystemRoleBadges,
  systemDatabaseHighlightClass,
} from "./system-databases-card.js";
import {
  createExportModalState,
  openExportModal,
  renderExportModal,
  type ExportModalState,
} from "./export-modal.js";

// Export modal state lives at module scope — a single modal instance is fine
// because it's strictly tied to whichever row is currently open. The modal is
// hidden between sessions (open: false) and resets format/template defaults
// each time the user re-opens it through the header button.
let exportModalState: ExportModalState | null = null;
function getExportModalState(): ExportModalState {
  if (!exportModalState) exportModalState = createExportModalState();
  return exportModalState;
}


let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = DATABASES_STYLES;
  document.head.appendChild(style);
}

export function renderDatabases(state: AppViewState, client: GatewayBrowserClient) {
  ensureStyles();
  const s = getDatabasesState(state);
  const db = s.databases.find((d) => d.id === s.selectedDatabaseId) ?? null;

  // Kick off initial load
  if (!s.databases.length && !s.loading && !s.error) {
    void loadDatabases(state, client);
  }

  return html`
    <div class="dbx-shell">
      ${renderSidebar(state, client, s)}
      <div class="dbx-main">
        ${s.openRowId
          ? renderRowPage(state, client, s, db)
          : html`
            ${db ? renderHeader(state, client, s, db) : renderEmpty(state, client, s)}
            ${db ? renderActiveView(state, client, s, db) : nothing}
          `}
      </div>
      ${!s.openRowId && s.selectedRowId ? renderRowDrawer(state, client, s) : nothing}
      ${s.showNewDatabaseDialog ? renderNewDatabaseDialog(state, client, s) : nothing}
      ${s.showImportDialog ? renderImportDialog(state, client, s) : nothing}
    </div>
  `;
}

// ─── SIDEBAR ─────────────────────────────────────────────────────

function renderSidebar(state: AppViewState, client: GatewayBrowserClient, s: DatabasesState) {
  const businesses = state.businessState?.businesses ?? [];
  // Scope the visible database list when a filter is set: show those linked
  // to that business OR un-linked (which act as "shared" / unscoped).
  const visibleDatabases = getBizFilter()
    ? s.databases.filter((d) => {
        const linkedBiz = (d.meta as { businessId?: string } | undefined)?.businessId;
        return linkedBiz === getBizFilter();
      })
    : s.databases;
  const linked = getBizFilter()
    ? businesses.find((b) => b.id === getBizFilter())
    : null;
  return html`
    <aside class="dbx-sidebar">
      <div class="dbx-side-head">
        <span class="dbx-side-head-title">
          <span class="dbx-side-head-icon">${icons.database}</span>
          Databases
        </span>
        <button class="dbx-icon-btn" title="New database" @click=${() => {
          s.showNewDatabaseDialog = true;
          state.requestUpdate?.();
        }}>${icons.plus}</button>
      </div>

      ${businesses.length > 0 ? html`
        <label
          class="dbx-biz-filter ${getBizFilter() ? "dbx-biz-filter--active" : ""}"
          title=${getBizFilter()
            ? `Showing databases linked to ${linked?.name ?? "business"}`
            : "Filter by business"}
        >
          <span class="dbx-biz-filter-icon" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="8" height="18" rx="1"/>
              <rect x="13" y="8" width="8" height="13" rx="1"/>
              <path d="M6 7h2"/><path d="M6 11h2"/><path d="M6 15h2"/>
              <path d="M16 12h2"/><path d="M16 16h2"/>
            </svg>
          </span>
          <span class="dbx-biz-filter-label">${linked?.name ?? "All businesses"}</span>
          <span class="dbx-biz-filter-chev" aria-hidden="true">▾</span>
          <select
            class="dbx-biz-filter-select"
            .value=${getBizFilter() ?? ""}
            @change=${(e: Event) => {
              const v = (e.target as HTMLSelectElement).value;
              setBizFilter(v ? v : null);
              // Reload the open database's rows under the new scope so the
              // table immediately reflects the filter change. Sidebar list
              // re-filters via render directly.
              if (s.selectedDatabaseId) {
                void loadDatabase(state, client, s.selectedDatabaseId);
              } else {
                state.requestUpdate?.();
              }
            }}
            aria-label="Filter databases by business"
          >
            <option value="" ?selected=${!getBizFilter()}>All businesses</option>
            ${businesses.map((b) => html`
              <option value=${b.id} ?selected=${getBizFilter() === b.id}>${b.name ?? b.id}</option>
            `)}
          </select>
        </label>
      ` : nothing}

      <div class="dbx-side-system">
        ${renderSystemDatabasesCard(state, client, { mode: "compact" })}
      </div>

      ${visibleDatabases.length === 0 && !s.loading
        ? html`<div class="dbx-empty-side">${getBizFilter() ? "No databases linked to this business." : "No databases yet."}</div>`
        : nothing}
      <ul class="dbx-side-list">
        ${visibleDatabases.map((d) => html`
          <li
            class="dbx-side-item ${s.selectedDatabaseId === d.id ? "active" : ""} ${systemDatabaseHighlightClass(s, d.id)}"
            @click=${() => loadDatabase(state, client, d.id)}
          >
            <span class="dbx-side-icon">${d.icon ?? html`<span class="dbx-side-icon-svg">${icons.fileText}</span>`}</span>
            <span class="dbx-side-name">${d.name}</span>
            ${renderSystemRoleBadges(s, d.id)}
            ${d.source.startsWith("kanban")
              ? html`<span class="dbx-side-tag">kanban</span>`
              : d.source === "notion-import"
                ? html`<span class="dbx-side-tag">notion</span>`
                : nothing}
          </li>
        `)}
      </ul>

      <div class="dbx-side-footer">
        <button class="dbx-btn dbx-btn-ghost" @click=${() => {
          s.showImportDialog = true;
          state.requestUpdate?.();
        }}>
          <span class="dbx-btn-icon">${icons.download}</span>
          Import from Notion
        </button>
      </div>
    </aside>
  `;
}

// ─── EMPTY STATE ─────────────────────────────────────────────────

function renderEmpty(state: AppViewState, client: GatewayBrowserClient, s: DatabasesState) {
  return html`
    <div class="dbx-empty-state">
      <div class="dbx-empty-inner">
        <span class="dbx-empty-icon">${icons.database}</span>
        <h2>No database selected</h2>
        <p>Create a new database, or import one from Notion.</p>
        <div class="dbx-empty-actions">
          <button class="dbx-btn dbx-btn-accent" @click=${() => {
            s.showNewDatabaseDialog = true;
            state.requestUpdate?.();
          }}>
            <span class="dbx-btn-icon">${icons.plus}</span>
            New database
          </button>
          <button class="dbx-btn dbx-btn-ghost" @click=${() => {
            s.showImportDialog = true;
            state.requestUpdate?.();
          }}>
            <span class="dbx-btn-icon">${icons.download}</span>
            Import from Notion
          </button>
        </div>
        ${s.error ? html`<p class="dbx-error">${s.error}</p>` : nothing}
      </div>
    </div>
  `;
}

// ─── HEADER ──────────────────────────────────────────────────────

function renderHeader(state: AppViewState, client: GatewayBrowserClient, s: DatabasesState, db: DatabaseRecord) {
  const views: DbView[] = ["table", "board", "gallery", "calendar"];
  const canSync = databaseSupportsSync(db);
  const syncOn = isSyncEnabled(db);
  const lastAt = lastSyncedAt(db);
  const businesses = state.businessState?.businesses ?? [];
  const linkedBusinessId = (db.meta as { businessId?: string } | undefined)?.businessId ?? "";

  return html`
    <header class="dbx-head">
      <div class="dbx-head-title">
        <span class="dbx-head-icon">${db.icon ?? html`<span class="dbx-head-icon-svg">${icons.database}</span>`}</span>
        <h1>${db.name}</h1>
        ${db.description ? html`<span class="dbx-head-desc">${db.description}</span>` : nothing}
      </div>
      <nav class="dbx-view-tabs">
        ${views.map((v) => html`
          <button
            class="dbx-view-tab ${s.view === v ? "active" : ""}"
            @click=${() => setView(state, v)}
          >${v}</button>
        `)}
      </nav>
      <div class="dbx-head-actions">
        ${businesses.length > 0 ? html`
          <label class="dbx-biz-link" title="Link this database to a business so analytics + AI context can scope to that brand"
            style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--g-muted,#888);">
            <span style="text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Business</span>
            <select class="dbx-biz-select"
              .value=${linkedBusinessId}
              @change=${(e: Event) => void setDatabaseBusiness(state, client, db.id, (e.target as HTMLSelectElement).value)}
              style="
                background:rgba(0,0,0,0.4);
                color:inherit;
                border:1px solid color-mix(in srgb, var(--g-primary, #f5a623) 25%, transparent);
                border-radius:6px;
                padding:4px 8px;
                font-family:inherit;
                font-size:12px;
              ">
              <option value="">— None —</option>
              ${businesses.map((b) => html`
                <option value=${b.id} ?selected=${linkedBusinessId === b.id}>${b.name || "Untitled"}</option>
              `)}
            </select>
          </label>
        ` : nothing}
        ${canSync ? html`
          <label
            class="dbx-sync-toggle ${syncOn ? "on" : "off"}"
            title=${syncOn ? "Two-way sync with Notion is ON — edits push live." : "Turn on to mirror changes to Notion."}
          >
            <input
              type="checkbox"
              ?checked=${syncOn}
              @change=${(e: Event) => void setSyncEnabled(state, client, db.id, (e.target as HTMLInputElement).checked)}
            />
            <span class="dbx-btn-icon dbx-btn-icon-sm">${icons.refresh}</span>
            <span>Notion sync</span>
          </label>
          <button
            class="dbx-btn dbx-btn-ghost"
            title=${lastAt ? `Last synced ${new Date(lastAt).toLocaleString()}` : "Run a two-way sync now"}
            @click=${() => void runSync(state, client, db.id)}
          >
            <span class="dbx-btn-icon">${icons.refresh}</span>
            Sync now${lastAt ? html` <span class="dbx-sync-ago">· ${formatAgo(lastAt)}</span>` : nothing}
          </button>
        ` : nothing}
        <button class="dbx-btn dbx-btn-accent" @click=${() => void createRow(state, client, db.id, "Untitled")}>
          <span class="dbx-btn-icon">${icons.plus}</span>
          New row
        </button>
        <button
          class="dbx-btn dbx-btn-ghost dbx-btn-icononly"
          title="Delete database"
          @click=${() => {
            if (confirm(`Delete database "${db.name}"? Rows are removed too.`)) {
              void deleteDatabase(state, client, db.id);
            }
          }}
        >${icons.trash}</button>
      </div>
    </header>
  `;
}

function formatAgo(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

// ─── ACTIVE VIEW ─────────────────────────────────────────────────

function renderActiveView(
  state: AppViewState,
  client: GatewayBrowserClient,
  s: DatabasesState,
  db: DatabaseRecord,
) {
  switch (s.view) {
    case "table": return renderTableView(state, client, s, db);
    case "board": return renderBoardView(state, client, s, db);
    case "gallery": return renderGalleryView(state, client, s, db);
    case "calendar": return renderCalendarView(state, client, s, db);
  }
}

// ─── TABLE VIEW ──────────────────────────────────────────────────

function renderTableView(
  state: AppViewState,
  client: GatewayBrowserClient,
  s: DatabasesState,
  db: DatabaseRecord,
) {
  const visibleProps = s.properties.filter((p) => !p.hidden);
  return html`
    <div class="dbx-table-wrap">
      <table class="dbx-table">
        <thead>
          <tr>
            ${visibleProps.map((p) => html`
              <th class="dbx-th dbx-th-${p.type}">
                <span class="dbx-th-name">${p.name}</span>
                <span class="dbx-th-type">${p.type}</span>
              </th>
            `)}
            <th class="dbx-th-add">
              <button
                class="dbx-icon-btn"
                title="Add property"
                @click=${() => void createProperty(state, client, {
                  databaseId: db.id,
                  name: "New property",
                  type: "richText",
                })}
              >+</button>
            </th>
          </tr>
        </thead>
        <tbody>
          ${s.rows.map((row) => html`
            <tr
              class="dbx-row ${s.selectedRowId === row.id ? "selected" : ""}"
              title="Click to preview, double-click to open page"
              @click=${() => setSelectedRow(state, row.id)}
              @dblclick=${() => void openRowPage(state, client, row.id)}
            >
              ${visibleProps.map((p) => html`
                <td class="dbx-td dbx-td-${p.type}">
                  ${renderCell(row, p)}
                </td>
              `)}
              <td class="dbx-td dbx-td-open">
                <button
                  class="dbx-row-open"
                  title="Open page"
                  @click=${(e: MouseEvent) => { e.stopPropagation(); void openRowPage(state, client, row.id); }}
                >${icons.externalLink}</button>
              </td>
            </tr>
          `)}
          <tr class="dbx-row-new" @click=${() => void createRow(state, client, db.id, "Untitled")}>
            <td colspan=${visibleProps.length + 1} class="dbx-td-new">+ New row</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

/**
 * Treat a URL or filename as an image when it's a known image MIME / file
 * extension. Used by the cell renderer + gallery view to swap text for a
 * thumbnail. Anything we can't confidently classify falls through to text.
 */
function isImageUrl(url: string | undefined, mime?: string | undefined): boolean {
  if (mime && mime.startsWith("image/")) return true;
  if (!url) return false;
  return /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)(\?|#|$)/i.test(url);
}

function renderCell(row: DatabaseRow, prop: DatabaseProperty) {
  if (prop.type === "title") {
    return html`<span class="dbx-cell-title">${row.title || "Untitled"}</span>`;
  }
  const v = row.values[prop.id];
  if (!v) return html`<span class="dbx-cell-empty">—</span>`;
  if (v.type === "checkbox") {
    return html`<span class="dbx-cell-check ${v.checked ? "on" : "off"}">
      ${v.checked ? icons.checkCircle : icons.circle}
    </span>`;
  }
  if (v.type === "select" || v.type === "status") {
    if (!v.optionId) return html`<span class="dbx-cell-empty">—</span>`;
    const opt = prop.config?.options?.find((o) => o.id === v.optionId);
    return html`<span class="dbx-pill" style=${`background:${opt?.color ?? "#334155"};`}>${opt?.name ?? v.optionId}</span>`;
  }
  if (v.type === "multiSelect") {
    if (!v.optionIds.length) return html`<span class="dbx-cell-empty">—</span>`;
    return html`${v.optionIds.map((id) => {
      const opt = prop.config?.options?.find((o) => o.id === id);
      return html`<span class="dbx-pill dbx-pill-sm" style=${`background:${opt?.color ?? "#334155"};`}>${opt?.name ?? id}</span>`;
    })}`;
  }
  if (v.type === "files") {
    if (!v.files.length) return html`<span class="dbx-cell-empty">—</span>`;
    // Render image attachments as inline thumbnails so the user sees the
    // actual asset, not the filename. Mixed sets render thumbs for image
    // entries and a name pill for non-image entries. Click opens the file.
    return html`<span class="dbx-cell-files">
      ${v.files.map((f) => {
        if (isImageUrl(f.url, f.mime)) {
          return html`<a class="dbx-cell-thumb" href=${f.url} target="_blank" rel="noopener" title=${f.name}>
            <img src=${f.url} alt=${f.name} loading="lazy" />
          </a>`;
        }
        return html`<a class="dbx-cell-file" href=${f.url} target="_blank" rel="noopener" title=${f.name}>${f.name}</a>`;
      })}
    </span>`;
  }
  if (v.type === "url" && isImageUrl(v.url ?? undefined)) {
    return html`<a class="dbx-cell-thumb" href=${v.url ?? "#"} target="_blank" rel="noopener" title=${v.url ?? ""}>
      <img src=${v.url ?? ""} alt=${prop.name} loading="lazy" />
    </a>`;
  }
  return html`<span class="dbx-cell-text">${valueAsString(v)}</span>`;
}

// ─── BOARD VIEW ──────────────────────────────────────────────────

function renderBoardView(
  state: AppViewState,
  client: GatewayBrowserClient,
  s: DatabasesState,
  db: DatabaseRecord,
) {
  const groupProp = s.groupByPropertyId
    ? s.properties.find((p) => p.id === s.groupByPropertyId) ?? null
    : null;
  const statusLike = s.properties.filter((p) => p.type === "status" || p.type === "select");

  if (!groupProp) {
    return html`
      <div class="dbx-board-empty">
        <p>Board view needs a Status or Select property to group by.</p>
        ${statusLike.length ? html`
          <p>Pick one:</p>
          <div class="dbx-group-picker">
            ${statusLike.map((p) => html`
              <button class="dbx-btn dbx-btn-ghost" @click=${() => setGroupBy(state, p.id)}>${p.name}</button>
            `)}
          </div>
        ` : html`
          <p class="dbx-hint">Add a Status property first.</p>
        `}
      </div>
    `;
  }

  const columns = groupProp.config?.options ?? [];
  const columnsWithUngrouped = [
    { id: "__none__", name: "Uncategorized", color: "#334155" },
    ...columns,
  ];

  const grouped: Record<string, DatabaseRow[]> = {};
  for (const col of columnsWithUngrouped) grouped[col.id] = [];
  for (const row of s.rows) {
    const v = row.values[groupProp.id];
    const key =
      v && (v.type === "status" || v.type === "select") && v.optionId
        ? v.optionId
        : "__none__";
    (grouped[key] ??= []).push(row);
  }

  return html`
    <div class="dbx-board">
      ${columnsWithUngrouped.map((col) => html`
        <div class="dbx-board-col">
          <div class="dbx-board-col-head" style=${`border-color:${col.color ?? "#334155"};`}>
            <span class="dbx-pill" style=${`background:${col.color ?? "#334155"};`}>${col.name}</span>
            <span class="dbx-board-count">${grouped[col.id]?.length ?? 0}</span>
          </div>
          <div class="dbx-board-list">
            ${(grouped[col.id] ?? []).map((row) => html`
              <div
                class="dbx-card"
                title="Open page"
                @click=${() => void openRowPage(state, client, row.id)}
              >
                <div class="dbx-card-title">${row.title || "Untitled"}</div>
                ${row.body ? html`<div class="dbx-card-body">${row.body.slice(0, 120)}…</div>` : nothing}
              </div>
            `)}
            <button class="dbx-card-add" @click=${async () => {
              const newRow = await createRow(state, client, db.id, "Untitled");
              if (newRow && col.id !== "__none__") {
                await updateRow(state, client, newRow.id, {
                  values: {
                    [groupProp.id]: { type: groupProp.type === "status" ? "status" : "select", optionId: col.id } as PropertyValue,
                  },
                });
              }
            }}>+ Add</button>
          </div>
        </div>
      `)}
    </div>
  `;
}

// ─── GALLERY VIEW (scaffold) ─────────────────────────────────────

/**
 * Pull the first usable image URL from a row's properties. Walks files,
 * url-typed properties, and richText markdown for `![]()` patterns. The
 * gallery view uses this as the card thumbnail.
 */
function firstImageForRow(row: DatabaseRow, props: DatabaseProperty[]): string | null {
  for (const p of props) {
    const v = row.values[p.id];
    if (!v) continue;
    if (v.type === "files") {
      for (const f of v.files) {
        if (isImageUrl(f.url, f.mime)) return f.url;
      }
    } else if (v.type === "url" && isImageUrl(v.url ?? undefined)) {
      return v.url;
    }
  }
  // Fallback: scan body markdown for the first ![](url) image link.
  const md = row.body ?? "";
  const m = md.match(/!\[[^\]]*\]\(([^)\s]+)/);
  if (m && isImageUrl(m[1])) return m[1];
  return null;
}

function renderGalleryView(
  state: AppViewState,
  client: GatewayBrowserClient,
  s: DatabasesState,
  _db: DatabaseRecord,
) {
  return html`
    <div class="dbx-gallery">
      ${s.rows.map((row) => {
        const thumb = firstImageForRow(row, s.properties);
        return html`
          <div class="dbx-gallery-card" title="Open page" @click=${() => void openRowPage(state, client, row.id)}>
            <div class="dbx-gallery-thumb ${thumb ? "" : "dbx-gallery-thumb-empty"}">
              ${thumb
                ? html`<img src=${thumb} alt=${row.title || "Untitled"} loading="lazy" />`
                : nothing}
            </div>
            <div class="dbx-gallery-title">${row.title || "Untitled"}</div>
            ${row.body ? html`<div class="dbx-gallery-body">${row.body.slice(0, 80)}…</div>` : nothing}
          </div>
        `;
      })}
      <div class="dbx-gallery-card dbx-gallery-add" @click=${() => void createRow(state, client, _db.id, "Untitled")}>
        <span class="dbx-gallery-plus">+</span>
      </div>
    </div>
  `;
}

// ─── CALENDAR VIEW (scaffold) ────────────────────────────────────

function renderCalendarView(
  state: AppViewState,
  client: GatewayBrowserClient,
  s: DatabasesState,
  _db: DatabaseRecord,
) {
  const dateProps = s.properties.filter((p) => p.type === "date");
  if (dateProps.length === 0) {
    return html`
      <div class="dbx-board-empty">
        <p>Calendar view needs a Date property.</p>
      </div>
    `;
  }
  const dateProp = dateProps[0]!;
  const today = new Date();
  const month = today.getMonth();
  const year = today.getFullYear();
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startWeekday = firstDay.getDay();
  const cells: Array<{ day: number | null; rows: DatabaseRow[] }> = [];
  for (let i = 0; i < startWeekday; i++) cells.push({ day: null, rows: [] });
  for (let d = 1; d <= daysInMonth; d++) {
    const dayRows = s.rows.filter((r) => {
      const v = r.values[dateProp.id];
      if (!v || v.type !== "date" || !v.iso) return false;
      const dt = new Date(v.iso);
      return dt.getFullYear() === year && dt.getMonth() === month && dt.getDate() === d;
    });
    cells.push({ day: d, rows: dayRows });
  }

  return html`
    <div class="dbx-calendar">
      <div class="dbx-cal-head">
        ${["S", "M", "T", "W", "T", "F", "S"].map((d) => html`<div class="dbx-cal-dow">${d}</div>`)}
      </div>
      <div class="dbx-cal-grid">
        ${cells.map((c) => html`
          <div class="dbx-cal-cell ${c.day ? "" : "empty"}">
            ${c.day ? html`<div class="dbx-cal-day">${c.day}</div>` : nothing}
            ${c.rows.map((r) => html`
              <div class="dbx-cal-event" title="Open page" @click=${() => void openRowPage(state, client, r.id)}>${r.title}</div>
            `)}
          </div>
        `)}
      </div>
    </div>
  `;
}

// ─── ROW DETAIL DRAWER ───────────────────────────────────────────

// ─── FULL-PAGE ROW VIEW ───────────────────────────────────────────

function renderRowPage(
  state: AppViewState,
  client: GatewayBrowserClient,
  s: DatabasesState,
  db: DatabaseRecord | null,
) {
  const row = s.openRow;
  if (s.openRowLoading && !row) {
    return html`
      <div class="dbx-page dbx-page-loading">
        <span>Loading page…</span>
      </div>
    `;
  }
  if (!row) {
    return html`
      <div class="dbx-page dbx-page-loading">
        <span>Row not found.</span>
        <button class="dbx-btn dbx-btn-ghost" @click=${() => closeRowPage(state)}>
          <span class="dbx-btn-icon">${icons.arrowLeft}</span> Back
        </button>
      </div>
    `;
  }

  const rowDb = db ?? s.databases.find((d) => d.id === row.databaseId) ?? null;
  const visibleProps = s.properties.filter((p) => !p.hidden);
  const titleProp = getTitleProperty(s);
  const nonTitleProps = visibleProps.filter((p) => p.type !== "title");

  const relationProps = nonTitleProps.filter(
    (p) => p.type === "relation" && typeof p.config?.targetDatabaseId === "string",
  );
  const hasRelated =
    (s.relatedBundle?.outgoing.length ?? 0) +
      (s.relatedBundle?.incoming.length ?? 0) +
      (s.relatedBundle?.linksOut.length ?? 0) +
      (s.relatedBundle?.linksIn.length ?? 0) >
    0;

  // Ancestors come back top-to-current; drop the last one (it's the current row itself).
  const ancestors = s.openRowAncestors.slice(0, -1);

  return html`
    <doc-agent-panel
      .client=${client}
      docType="db_row"
      .documentId=${row.id}
      .title=${row.title || row.id}
      .content=${row.body ?? ""}
      .databaseId=${db?.id ?? ""}
      .schema=${db
        ? `database: ${db.name}\nproperties:\n${s.properties.map((p) => `  - ${p.name} (${p.type})`).join("\n")}`
        : ""}
    ></doc-agent-panel>
    <div class="dbx-page">
      <div class="dbx-page-breadcrumb">
        <button class="dbx-btn dbx-btn-ghost dbx-page-back" @click=${() => closeRowPage(state)}>
          <span class="dbx-btn-icon">${icons.arrowLeft}</span>
          ${rowDb?.name ?? "Database"}
        </button>
        ${ancestors.map((a) => html`
          <span class="dbx-page-crumb-sep">${icons.chevronRight}</span>
          <button
            class="dbx-page-crumb"
            title=${a.title}
            @click=${() => void openRowPage(state, client, a.id)}
          >${a.title || "Untitled"}</button>
        `)}
      </div>

      <header class="dbx-page-head">
        <span class="dbx-page-icon">${rowDb?.icon ?? html`<span class="dbx-head-icon-svg">${icons.fileText}</span>`}</span>
        <input
          class="dbx-page-title"
          .value=${row.title}
          @change=${(e: Event) => void updateOpenRow(state, client, {
            title: (e.target as HTMLInputElement).value,
          })}
          placeholder="Untitled"
        />
        ${renderRowSaveBadge(s)}
        ${renderRowBusinessChip(state, client, row)}
        <button
          class="dbx-btn dbx-btn-ghost dbx-page-export"
          @click=${() => openExportModal(getExportModalState(), () => state.requestUpdate?.())}
          title="Export this page (PDF, HTML, Markdown, JSON)"
        >
          <span class="dbx-btn-icon">${icons.download}</span>
          Export
        </button>
      </header>

      ${renderExportModal({
        state: getExportModalState(),
        row,
        db: rowDb,
        properties: s.properties,
        requestUpdate: () => state.requestUpdate?.(),
      })}

      ${s.error ? html`
        <p
          class="dbx-error dbx-page-error"
          role="alert"
          @click=${() => { s.error = null; state.requestUpdate?.(); }}
          title="Click to dismiss"
        >${s.error}</p>
      ` : nothing}

      ${nonTitleProps.length ? html`
        <section class="dbx-page-section dbx-page-props">
          <div class="dbx-page-proplist">
            ${nonTitleProps.map((p) => renderPageProperty(state, client, row, p))}
          </div>
        </section>
      ` : nothing}

      ${renderSubpagesSection(state, client, s, row)}

      ${hasRelated || relationProps.length ? html`
        <section class="dbx-page-section dbx-page-related">
          <div class="dbx-page-section-head">
            <h3 class="dbx-page-section-title">Linked pages</h3>
            ${s.relatedLoading ? html`<span class="dbx-hint">Loading…</span>` : nothing}
          </div>
          ${renderRelated(state, client, s)}
          ${relationProps.length ? html`
            <div class="dbx-page-newlinked">
              ${relationProps.map((p) => {
                const targetDbId = p.config!.targetDatabaseId!;
                const targetDb = findDatabase(s, targetDbId);
                return html`
                  <button
                    class="dbx-btn dbx-btn-ghost dbx-btn-sub"
                    title=${`Create and link a new row in ${targetDb?.name ?? "target database"}`}
                    @click=${() => void createLinkedSubPage(state, client, {
                      propertyId: p.id,
                      targetDatabaseId: targetDbId,
                      title: "Untitled",
                    })}
                  >
                    <span class="dbx-btn-icon">${icons.plus}</span>
                    New ${targetDb?.name ?? p.name}
                  </button>
                `;
              })}
            </div>
          ` : nothing}
        </section>
      ` : nothing}

      <section class="dbx-page-section dbx-page-body">
        <moltbot-block-editor
          .value=${row.body ?? ""}
          placeholder="Type / for commands…"
          @change=${(e: CustomEvent<{ value: string }>) => {
            void updateOpenRow(state, client, { body: e.detail.value });
          }}
          @navigate=${(e: CustomEvent<{ rowId: string }>) => {
            void openRowPage(state, client, e.detail.rowId);
          }}
        ></moltbot-block-editor>
      </section>
    </div>
  `;
}

/**
 * Per-row business link chip for the row detail header. Same anatomy as the
 * sidebar `.dbx-biz-filter` pill but writes through `updateOpenRow` so the
 * change persists to the row's `businessId`. Returns nothing when no
 * businesses exist yet.
 */
function renderRowBusinessChip(
  state: AppViewState,
  client: GatewayBrowserClient,
  row: DatabaseRow,
): TemplateResult | typeof nothing {
  const businesses = state.businessState?.businesses ?? [];
  if (businesses.length === 0) return nothing;
  const currentId = row.businessId ?? null;
  const linked = currentId ? businesses.find((b) => b.id === currentId) : null;
  return html`
    <label
      class="dbx-biz-filter dbx-page-biz ${linked ? "dbx-biz-filter--active" : ""}"
      title=${linked
        ? `Linked to ${linked.name ?? "business"} — click to change`
        : "Link this row to a business"}
    >
      <span class="dbx-biz-filter-icon" aria-hidden="true">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="8" height="18" rx="1"/>
          <rect x="13" y="8" width="8" height="13" rx="1"/>
          <path d="M6 7h2"/><path d="M6 11h2"/><path d="M6 15h2"/>
          <path d="M16 12h2"/><path d="M16 16h2"/>
        </svg>
      </span>
      <span class="dbx-biz-filter-label">${linked?.name ?? "+ Business"}</span>
      <span class="dbx-biz-filter-chev" aria-hidden="true">▾</span>
      <select
        class="dbx-biz-filter-select"
        .value=${currentId ?? ""}
        @change=${(e: Event) => {
          const v = (e.target as HTMLSelectElement).value;
          void updateOpenRow(state, client, { businessId: v ? v : null });
        }}
        aria-label="Linked business for this row"
      >
        <option value="" ?selected=${!currentId}>— No business —</option>
        ${businesses.map((b) => html`
          <option value=${b.id} ?selected=${currentId === b.id}>${b.name ?? b.id}</option>
        `)}
      </select>
    </label>
  `;
}

function renderRowSaveBadge(s: DatabasesState) {
  if (s.openRowSavingCount > 0) {
    return html`<span class="dbx-page-save-badge dbx-page-save-saving" title="Saving…">Saving…</span>`;
  }
  if (s.openRowSavedAt) {
    return html`<span class="dbx-page-save-badge dbx-page-save-saved" title="All changes saved">Saved</span>`;
  }
  return nothing;
}

function renderPageProperty(
  state: AppViewState,
  client: GatewayBrowserClient,
  row: DatabaseRow,
  p: DatabaseProperty,
) {
  const value = row.values[p.id] ?? defaultValueFor(p.type);
  const save = (v: PropertyValue) => {
    void updateOpenRow(state, client, { values: { [p.id]: v } });
  };

  switch (p.type) {
    case "richText":
      return html`
        <div class="dbx-page-prop dbx-page-prop-wide">
          <label class="dbx-prop-label">${p.name}</label>
          <moltbot-block-editor
            .value=${value.type === "richText" ? value.markdown : ""}
            placeholder=${`${p.name} — type / for commands…`}
            @change=${(e: CustomEvent<{ value: string }>) => save({ type: "richText", markdown: e.detail.value })}
            @navigate=${(e: CustomEvent<{ rowId: string }>) => {
              void openRowPage(state, client, e.detail.rowId);
            }}
          ></moltbot-block-editor>
        </div>
      `;
    case "checkbox":
      return html`
        <div class="dbx-page-prop dbx-page-prop-row">
          <label class="dbx-prop-label">${p.name}</label>
          <input
            type="checkbox"
            .checked=${value.type === "checkbox" ? value.checked : false}
            @change=${(e: Event) => save({ type: "checkbox", checked: (e.target as HTMLInputElement).checked })}
          />
        </div>
      `;
    case "number":
      return html`
        <div class="dbx-page-prop">
          <label class="dbx-prop-label">${p.name}</label>
          <input
            class="dbx-prop-input"
            type="number"
            .value=${value.type === "number" ? String(value.value ?? "") : ""}
            @change=${(e: Event) => {
              const n = Number((e.target as HTMLInputElement).value);
              save({ type: "number", value: Number.isFinite(n) ? n : null });
            }}
          />
        </div>
      `;
    case "date":
      return html`
        <div class="dbx-page-prop">
          <label class="dbx-prop-label">${p.name}</label>
          <input
            class="dbx-prop-input"
            type="date"
            .value=${value.type === "date" ? (value.iso?.slice(0, 10) ?? "") : ""}
            @change=${(e: Event) => save({
              type: "date",
              iso: (e.target as HTMLInputElement).value
                ? new Date((e.target as HTMLInputElement).value).toISOString()
                : null,
            })}
          />
        </div>
      `;
    case "select":
    case "status": {
      const options = p.config?.options ?? [];
      const currentId = value.type === p.type ? value.optionId : null;
      return html`
        <div class="dbx-page-prop">
          <label class="dbx-prop-label">${p.name}</label>
          <select
            class="dbx-prop-input"
            @change=${(e: Event) => {
              const v = (e.target as HTMLSelectElement).value;
              save({ type: p.type === "status" ? "status" : "select", optionId: v || null } as PropertyValue);
            }}
          >
            <option value="" ?selected=${!currentId}>—</option>
            ${options.map((o) => html`
              <option value=${o.id} ?selected=${currentId === o.id}>${o.name}</option>
            `)}
          </select>
        </div>
      `;
    }
    case "url":
    case "email":
    case "phone":
      return html`
        <div class="dbx-page-prop">
          <label class="dbx-prop-label">${p.name}</label>
          <input
            class="dbx-prop-input"
            type=${p.type === "email" ? "email" : p.type === "url" ? "url" : "tel"}
            .value=${valueAsString(value)}
            @change=${(e: Event) => {
              const text = (e.target as HTMLInputElement).value || null;
              if (p.type === "url") save({ type: "url", url: text });
              else if (p.type === "email") save({ type: "email", email: text });
              else save({ type: "phone", phone: text });
            }}
          />
        </div>
      `;
    case "relation": {
      const rowIds = value.type === "relation" ? value.rowIds : [];
      const targetDbId = p.config?.targetDatabaseId ?? null;
      return renderRelationProperty(state, client, row, p, rowIds, targetDbId);
    }
    case "files": {
      const files = value.type === "files" ? value.files : [];
      const accept = (p.config?.allowedMimePrefixes ?? [])
        .map((prefix) => (prefix.endsWith("*") ? prefix : `${prefix}*`))
        .join(",");
      const inputId = `dbx-files-page-${row.id}-${p.id}`;
      const openFile = async (url: string) => {
        try {
          const resolved = await resolveFileUrl(client, url);
          window.open(resolved, "_blank", "noopener");
        } catch {
          /* surfaced via state.error */
        }
      };
      return html`
        <div class="dbx-page-prop dbx-page-prop-wide">
          <label class="dbx-prop-label">${p.name}</label>
          <div class="dbx-files">
            ${files.length === 0
              ? html`<div class="dbx-files-empty">No files yet.</div>`
              : files.map(
                  (f) => html`
                    <div class="dbx-file-row">
                      <button
                        class="dbx-file-name"
                        @click=${() => void openFile(f.url)}
                        title=${f.url}
                      >
                        📎 ${f.name}
                      </button>
                      <span class="dbx-file-size">${formatFileSize(f.size)}</span>
                      <button
                        class="dbx-file-remove"
                        title="Remove"
                        @click=${() =>
                          void removeFileFromRowProperty(state, client, row.id, p.id, f.url)}
                      >×</button>
                    </div>
                  `,
                )}
            <label class="dbx-file-upload" for=${inputId}>
              <span class="dbx-btn-icon">+</span> Add files
            </label>
            <input
              id=${inputId}
              type="file"
              multiple
              accept=${accept || ""}
              style="display: none"
              @change=${async (e: Event) => {
                const input = e.target as HTMLInputElement;
                if (input.files && input.files.length) {
                  await uploadFilesToRowProperty(state, client, row.id, p.id, input.files);
                }
                input.value = "";
              }}
            />
          </div>
        </div>
      `;
    }
    default:
      return html`
        <div class="dbx-page-prop">
          <label class="dbx-prop-label">${p.name} <span class="dbx-prop-type">(${p.type})</span></label>
          <div class="dbx-prop-readonly">${valueAsString(value) || "—"}</div>
        </div>
      `;
  }
}

function renderRelationProperty(
  state: AppViewState,
  client: GatewayBrowserClient,
  row: DatabaseRow,
  p: DatabaseProperty,
  rowIds: string[],
  targetDbId: string | null,
) {
  const s = getDatabasesState(state);
  const targetDb = targetDbId ? findDatabase(s, targetDbId) : null;
  const pickerOpen = s.openRelationPicker === p.id;

  const removeRelation = (removeId: string) => {
    const next = rowIds.filter((id) => id !== removeId);
    void updateOpenRow(state, client, {
      values: { [p.id]: { type: "relation", rowIds: next } },
    });
  };

  const addRelation = (addId: string) => {
    if (rowIds.includes(addId)) return;
    const next = [...rowIds, addId];
    void updateOpenRow(state, client, {
      values: { [p.id]: { type: "relation", rowIds: next } },
    });
    closeRelationPicker(state);
  };

  const chipLabel = (id: string): string => {
    const idx = s.rowTitleIndex[id];
    if (idx) return idx.title;
    return `${id.slice(0, 10)}…`;
  };
  const chipDb = (id: string): string | null => {
    const idx = s.rowTitleIndex[id];
    if (!idx) return null;
    return findDatabase(s, idx.databaseId)?.name ?? null;
  };

  return html`
    <div class="dbx-page-prop dbx-page-prop-wide">
      <label class="dbx-prop-label">
        ${p.name}
        ${targetDb ? html`<span class="dbx-prop-hint">→ ${targetDb.name}</span>` : nothing}
      </label>
      <div class="dbx-relation-editor">
        ${rowIds.length === 0 ? html`
          <span class="dbx-relation-empty">No relations</span>
        ` : rowIds.map((id) => html`
          <span class="dbx-relation-chip" @click=${() => void openRowPage(state, client, id)}>
            <span class="dbx-relation-chip-title">${chipLabel(id)}</span>
            ${chipDb(id) ? html`<span class="dbx-relation-chip-db">· ${chipDb(id)}</span>` : nothing}
            <button
              class="dbx-relation-chip-remove"
              title="Remove"
              @click=${(e: MouseEvent) => { e.stopPropagation(); removeRelation(id); }}
            >${icons.x}</button>
          </span>
        `)}
        <button
          class="dbx-relation-add"
          title=${targetDbId ? "Add relation" : "This relation property has no target database set yet"}
          ?disabled=${!targetDbId}
          @click=${() => {
            if (!targetDbId) return;
            if (pickerOpen) closeRelationPicker(state);
            else void openRelationPicker(state, client, p.id, targetDbId);
          }}
        >${icons.plus}</button>
      </div>
      ${pickerOpen ? renderRelationPicker(state, client, rowIds, addRelation) : nothing}
    </div>
  `;
}

function renderRelationPicker(
  state: AppViewState,
  client: GatewayBrowserClient,
  alreadyLinked: string[],
  onPick: (id: string) => void,
) {
  const s = getDatabasesState(state);
  const candidates = s.relationCandidates.filter((r) => !alreadyLinked.includes(r.id));
  return html`
    <div class="dbx-relation-picker" @click=${(e: MouseEvent) => e.stopPropagation()}>
      <div class="dbx-relation-picker-head">
        <span>Pick a row</span>
        <button class="dbx-icon-btn" @click=${() => closeRelationPicker(state)}>${icons.x}</button>
      </div>
      ${s.relationCandidatesLoading ? html`
        <div class="dbx-hint" style="padding:10px;">Loading…</div>
      ` : candidates.length === 0 ? html`
        <div class="dbx-hint" style="padding:10px;">No more rows to link.</div>
      ` : html`
        <ul class="dbx-relation-picker-list">
          ${candidates.slice(0, 50).map((r) => html`
            <li class="dbx-relation-picker-item" @click=${() => onPick(r.id)}>
              <span class="dbx-relation-picker-title">${r.title || "Untitled"}</span>
              ${r.body ? html`<span class="dbx-relation-picker-snippet">${r.body.slice(0, 60)}…</span>` : nothing}
            </li>
          `)}
        </ul>
      `}
    </div>
  `;
}

function renderSubpagesSection(
  state: AppViewState,
  client: GatewayBrowserClient,
  s: DatabasesState,
  row: DatabaseRow,
) {
  const children = s.openRowChildren;
  const hasChildren = children.length > 0;

  return html`
    <section class="dbx-page-section dbx-page-subpages">
      <div class="dbx-page-section-head">
        <h3 class="dbx-page-section-title">Sub-pages</h3>
        ${s.treeLoading ? html`<span class="dbx-hint">Loading…</span>` : nothing}
      </div>
      ${hasChildren ? html`
        <div class="dbx-subpage-grid">
          ${children.map((c) => html`
            <button
              class="dbx-subpage-card"
              title=${c.title || "Untitled"}
              @click=${() => void openRowPage(state, client, c.id)}
            >
              <span class="dbx-subpage-icon">${icons.fileText}</span>
              <span class="dbx-subpage-title">${c.title || "Untitled"}</span>
              ${c.body ? html`<span class="dbx-subpage-snippet">${c.body.slice(0, 80).replace(/\s+/g, " ")}${c.body.length > 80 ? "…" : ""}</span>` : nothing}
            </button>
          `)}
        </div>
      ` : html`
        <p class="dbx-hint">No sub-pages yet.</p>
      `}
      <button
        class="dbx-btn dbx-btn-ghost dbx-btn-sub"
        @click=${() => void createSubpage(state, client, row.id)}
      >
        <span class="dbx-btn-icon">${icons.plus}</span>
        New sub-page
      </button>
    </section>
  `;
}

function renderRelated(state: AppViewState, client: GatewayBrowserClient, s: DatabasesState) {
  const bundle = s.relatedBundle;
  if (!bundle) {
    return html`<p class="dbx-hint">${s.relatedLoading ? "Loading relations…" : "No relations loaded."}</p>`;
  }
  const allGroups: Array<RelatedGroup & { direction: "out" | "in" }> = [
    ...bundle.outgoing.map((g) => ({ ...g, direction: "out" as const })),
    ...bundle.incoming.map((g) => ({ ...g, direction: "in" as const })),
  ];
  if (allGroups.length === 0 && bundle.linksOut.length === 0 && bundle.linksIn.length === 0) {
    return html`
      <p class="dbx-hint">
        Nothing links to this row yet. Add a relation property or link it to a project/task/note
        to see it here.
      </p>
    `;
  }
  return html`
    <div class="dbx-related-groups">
      ${allGroups.map((g) => html`
        <div class="dbx-related-group">
          <div class="dbx-related-group-head">
            <span class="dbx-related-arrow">${g.direction === "out" ? icons.arrowRight : icons.arrowLeft}</span>
            <span class="dbx-related-group-name">
              ${g.databaseName}
              <span class="dbx-related-prop">· ${g.propertyName}</span>
            </span>
            <span class="dbx-related-count">${g.rows.length}</span>
          </div>
          <ul class="dbx-related-list">
            ${g.rows.map((r) => html`
              <li class="dbx-related-item" @click=${() => void openRowPage(state, client, r.id)}>
                <span class="dbx-related-title">${r.title || "Untitled"}</span>
                ${r.body ? html`<span class="dbx-related-snippet">${r.body.slice(0, 80)}…</span>` : nothing}
              </li>
            `)}
          </ul>
        </div>
      `)}
      ${bundle.linksOut.length || bundle.linksIn.length ? html`
        <div class="dbx-related-group">
          <div class="dbx-related-group-head">
            <span class="dbx-related-arrow">${icons.link}</span>
            <span class="dbx-related-group-name">Cross-domain links</span>
            <span class="dbx-related-count">${bundle.linksOut.length + bundle.linksIn.length}</span>
          </div>
          <ul class="dbx-related-list">
            ${[...bundle.linksOut, ...bundle.linksIn].map((l) => html`
              <li class="dbx-related-item">
                <span class="dbx-related-title">
                  ${l.label ?? `${l.targetKind}: ${l.targetId.slice(0, 10)}…`}
                </span>
              </li>
            `)}
          </ul>
        </div>
      ` : nothing}
    </div>
  `;
}

function renderRowDrawer(state: AppViewState, client: GatewayBrowserClient, s: DatabasesState) {
  const row = s.rows.find((r) => r.id === s.selectedRowId);
  if (!row) return nothing;
  const titleProp = getTitleProperty(s);
  const visibleProps = s.properties.filter((p) => p.type !== "title" && !p.hidden);

  return html`
    <div class="dbx-drawer" @click=${(e: MouseEvent) => e.stopPropagation()}>
      <header class="dbx-drawer-head">
        <input
          class="dbx-drawer-title"
          .value=${row.title}
          @change=${(e: Event) => updateRow(state, client, row.id, {
            title: (e.target as HTMLInputElement).value,
          })}
        />
        <button
          class="dbx-btn dbx-btn-ghost"
          title="Open as full page"
          @click=${() => void openRowPage(state, client, row.id)}
        >
          <span class="dbx-btn-icon">${icons.externalLink}</span>
          Open page
        </button>
        <button class="dbx-icon-btn" title="Close" @click=${() => setSelectedRow(state, null)}>${icons.x}</button>
      </header>

      <div class="dbx-drawer-body">
        <section class="dbx-props">
          ${visibleProps.map((p) => renderPropertyEditor(state, client, row, p))}
        </section>

        <section class="dbx-body-editor">
          <h4>Body</h4>
          <moltbot-block-editor
            .value=${row.body ?? ""}
            placeholder="Notes, context, references… (type / for blocks)"
            @change=${(e: CustomEvent<{ value: string }>) => updateRow(state, client, row.id, {
              body: e.detail.value,
            })}
          ></moltbot-block-editor>
        </section>

        <section class="dbx-drawer-footer">
          <button class="dbx-btn dbx-btn-danger" @click=${() => {
            if (confirm("Delete this row?")) {
              void deleteRow(state, client, row.id);
            }
          }}>
            <span class="dbx-btn-icon">${icons.trash}</span>
            Delete row
          </button>
        </section>
      </div>
    </div>
  `;
}

function renderPropertyEditor(
  state: AppViewState,
  client: GatewayBrowserClient,
  row: DatabaseRow,
  p: DatabaseProperty,
) {
  const value = row.values[p.id] ?? defaultValueFor(p.type);
  const save = (v: PropertyValue) =>
    updateRow(state, client, row.id, { values: { [p.id]: v } });

  switch (p.type) {
    case "richText":
      return html`
        <div class="dbx-prop">
          <label class="dbx-prop-label">${p.name}</label>
          <moltbot-block-editor
            .value=${value.type === "richText" ? value.markdown : ""}
            placeholder=${`${p.name} — type / for commands…`}
            @change=${(e: CustomEvent<{ value: string }>) => save({ type: "richText", markdown: e.detail.value })}
          ></moltbot-block-editor>
        </div>
      `;
    case "checkbox":
      return html`
        <div class="dbx-prop dbx-prop-row">
          <label class="dbx-prop-label">${p.name}</label>
          <input
            type="checkbox"
            .checked=${value.type === "checkbox" ? value.checked : false}
            @change=${(e: Event) => save({ type: "checkbox", checked: (e.target as HTMLInputElement).checked })}
          />
        </div>
      `;
    case "number":
      return html`
        <div class="dbx-prop">
          <label class="dbx-prop-label">${p.name}</label>
          <input
            class="dbx-prop-input"
            type="number"
            .value=${value.type === "number" ? String(value.value ?? "") : ""}
            @change=${(e: Event) => {
              const n = Number((e.target as HTMLInputElement).value);
              save({ type: "number", value: Number.isFinite(n) ? n : null });
            }}
          />
        </div>
      `;
    case "date":
      return html`
        <div class="dbx-prop">
          <label class="dbx-prop-label">${p.name}</label>
          <input
            class="dbx-prop-input"
            type="date"
            .value=${value.type === "date" ? (value.iso?.slice(0, 10) ?? "") : ""}
            @change=${(e: Event) => save({
              type: "date",
              iso: (e.target as HTMLInputElement).value
                ? new Date((e.target as HTMLInputElement).value).toISOString()
                : null,
            })}
          />
        </div>
      `;
    case "select":
    case "status": {
      const options = p.config?.options ?? [];
      const currentId = value.type === p.type ? value.optionId : null;
      return html`
        <div class="dbx-prop">
          <label class="dbx-prop-label">${p.name}</label>
          <select
            class="dbx-prop-input"
            .value=${currentId ?? ""}
            @change=${(e: Event) => {
              const v = (e.target as HTMLSelectElement).value;
              save({ type: p.type === "status" ? "status" : "select", optionId: v || null } as PropertyValue);
            }}
          >
            <option value="">—</option>
            ${options.map((o) => html`<option value=${o.id}>${o.name}</option>`)}
          </select>
        </div>
      `;
    }
    case "url":
    case "email":
    case "phone":
      return html`
        <div class="dbx-prop">
          <label class="dbx-prop-label">${p.name}</label>
          <input
            class="dbx-prop-input"
            type=${p.type === "email" ? "email" : p.type === "url" ? "url" : "tel"}
            .value=${valueAsString(value)}
            @change=${(e: Event) => {
              const text = (e.target as HTMLInputElement).value || null;
              if (p.type === "url") save({ type: "url", url: text });
              else if (p.type === "email") save({ type: "email", email: text });
              else save({ type: "phone", phone: text });
            }}
          />
        </div>
      `;
    case "files": {
      const files = value.type === "files" ? value.files : [];
      const accept = (p.config?.allowedMimePrefixes ?? [])
        .map((prefix) => (prefix.endsWith("*") ? prefix : `${prefix}*`))
        .join(",");
      const inputId = `dbx-files-${row.id}-${p.id}`;
      const openFile = async (url: string) => {
        try {
          const resolved = await resolveFileUrl(client, url);
          window.open(resolved, "_blank", "noopener");
        } catch {
          /* surfaced via state.error */
        }
      };
      return html`
        <div class="dbx-prop">
          <label class="dbx-prop-label">${p.name}</label>
          <div class="dbx-files">
            ${files.length === 0
              ? html`<div class="dbx-files-empty">No files yet.</div>`
              : files.map(
                  (f) => html`
                    <div class="dbx-file-row">
                      <button
                        class="dbx-file-name"
                        @click=${() => void openFile(f.url)}
                        title=${f.url}
                      >
                        📎 ${f.name}
                      </button>
                      <span class="dbx-file-size">${formatFileSize(f.size)}</span>
                      <button
                        class="dbx-file-remove"
                        title="Remove"
                        @click=${() =>
                          void removeFileFromRowProperty(state, client, row.id, p.id, f.url)}
                      >×</button>
                    </div>
                  `,
                )}
            <label class="dbx-file-upload" for=${inputId}>
              <span class="dbx-btn-icon">+</span> Add files
            </label>
            <input
              id=${inputId}
              type="file"
              multiple
              ?accept=${!!accept}
              accept=${accept || ""}
              style="display: none"
              @change=${async (e: Event) => {
                const input = e.target as HTMLInputElement;
                if (input.files && input.files.length) {
                  await uploadFilesToRowProperty(state, client, row.id, p.id, input.files);
                }
                input.value = "";
              }}
            />
          </div>
        </div>
      `;
    }
    default:
      return html`
        <div class="dbx-prop">
          <label class="dbx-prop-label">${p.name} <span class="dbx-prop-type">(${p.type})</span></label>
          <div class="dbx-prop-readonly">${valueAsString(value) || "—"}</div>
        </div>
      `;
  }
}

function formatFileSize(bytes: number | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ─── DIALOGS ─────────────────────────────────────────────────────

function renderNewDatabaseDialog(state: AppViewState, client: GatewayBrowserClient, s: DatabasesState) {
  return html`
    <div class="dbx-modal-bg" @click=${() => { s.showNewDatabaseDialog = false; state.requestUpdate?.(); }}>
      <div class="dbx-modal" @click=${(e: MouseEvent) => e.stopPropagation()}>
        <h3>New database</h3>
        <input id="dbx-new-name" class="dbx-prop-input" placeholder="Name" />
        <input id="dbx-new-icon" class="dbx-prop-input" placeholder="Icon (emoji)" />
        <textarea id="dbx-new-desc" class="dbx-prop-input" rows="2" placeholder="Description"></textarea>
        <div class="dbx-modal-actions">
          <button class="dbx-btn dbx-btn-ghost" @click=${() => { s.showNewDatabaseDialog = false; state.requestUpdate?.(); }}>Cancel</button>
          <button class="dbx-btn dbx-btn-accent" @click=${async () => {
            const name = (document.getElementById("dbx-new-name") as HTMLInputElement | null)?.value?.trim();
            if (!name) return;
            const icon = (document.getElementById("dbx-new-icon") as HTMLInputElement | null)?.value?.trim() || undefined;
            const description = (document.getElementById("dbx-new-desc") as HTMLTextAreaElement | null)?.value?.trim() || undefined;
            s.showNewDatabaseDialog = false;
            state.requestUpdate?.();
            await createDatabase(state, client, { name, icon, description });
          }}>Create</button>
        </div>
      </div>
    </div>
  `;
}

function renderImportDialog(state: AppViewState, client: GatewayBrowserClient, s: DatabasesState) {
  // Lazy-discover on first open: avoids firing a Notion /search until the
  // dialog actually mounts, and keeps the initial render snappy.
  if (!s.importDiscovering && !s.importDiscovered_loaded && !s.importRunning) {
    void discoverNotionDatabases(state, client);
  }
  const discovered = s.importDiscovered;
  const selected = s.importSelectedIds;
  const allSelected = discovered.length > 0 && selected.size === discovered.length;
  const close = () => {
    s.showImportDialog = false;
    s.importDiscovered = [];
    s.importDiscovered_loaded = false;
    s.importSelectedIds = new Set();
    s.importDiscoveryError = null;
    s.importLog = [];
    state.requestUpdate?.();
  };
  return html`
    <div class="dbx-modal-bg" @click=${close}>
      <div class="dbx-modal" style="max-width:640px; width:100%;" @click=${(e: MouseEvent) => e.stopPropagation()}>
        <h3>Import from Notion</h3>
        <p class="dbx-hint">
          Pick which Notion databases to import as local tables. Each import creates a
          new local database; rows + properties are pulled once (no ongoing sync).
          Formulas, rollups, and relations come in as loose rich-text / row-id strings.
        </p>

        ${s.importDiscovering
          ? html`<div class="dbx-import-loading">Discovering databases…</div>`
          : s.importDiscoveryError
            ? html`
                <div class="dbx-import-error">
                  ${s.importDiscoveryError}
                  <button class="dbx-btn dbx-btn-ghost" style="margin-left:8px;"
                    @click=${() => discoverNotionDatabases(state, client)}>Retry</button>
                </div>
              `
            : discovered.length === 0
              ? html`
                  <div class="dbx-import-empty">
                    No databases visible to the integration. Share a Notion page (or
                    database directly) with the integration, then
                    <button class="dbx-btn dbx-btn-ghost" style="display:inline; padding:2px 6px;"
                      @click=${() => discoverNotionDatabases(state, client)}>refresh</button>.
                  </div>
                `
              : html`
                  <div class="dbx-import-toolbar">
                    <label class="dbx-import-toggle">
                      <input type="checkbox" .checked=${allSelected}
                        @change=${(e: Event) => selectAllImportable(state, (e.target as HTMLInputElement).checked)} />
                      <span>${selected.size > 0
                        ? `${selected.size} of ${discovered.length} selected`
                        : `Select all (${discovered.length})`}</span>
                    </label>
                    <button class="dbx-btn dbx-btn-ghost" style="padding:4px 8px;"
                      ?disabled=${s.importRunning}
                      @click=${() => discoverNotionDatabases(state, client)}>↻ Refresh</button>
                  </div>
                  <div class="dbx-import-list">
                    ${discovered.map((db) => html`
                      <label class="dbx-import-row">
                        <input type="checkbox"
                          .checked=${selected.has(db.id)}
                          @change=${() => toggleImportSelection(state, db.id)} />
                        <div class="dbx-import-row-text">
                          <div class="dbx-import-row-title">${db.title || "Untitled"}</div>
                          <div class="dbx-import-row-meta">
                            ${db.propertyCount} ${db.propertyCount === 1 ? "property" : "properties"}
                            ${db.isSystemManaged ? html` · <span style="color:#fbbf24;">system-managed</span>` : ""}
                          </div>
                        </div>
                      </label>
                    `)}
                  </div>
                `}

        ${s.importLog.length > 0 ? html`
          <div class="dbx-import-log">
            ${s.importLog.map((line) => html`<div>${line}</div>`)}
          </div>
        ` : ""}

        <div class="dbx-modal-actions">
          <button class="dbx-btn dbx-btn-ghost" @click=${close}>Close</button>
          <button class="dbx-btn dbx-btn-accent"
            ?disabled=${s.importRunning || selected.size === 0}
            title=${selected.size === 0 ? "Select at least one database to import" : ""}
            @click=${() => importFromNotion(state, client, { databaseIds: Array.from(selected) })}>
            ${s.importRunning
              ? "Importing…"
              : selected.size === 0
                ? "Pick databases above"
                : `Import ${selected.size} ${selected.size === 1 ? "database" : "databases"}`}
          </button>
        </div>
      </div>
    </div>
  `;
}

// ─── STYLES ──────────────────────────────────────────────────────

const DATABASES_STYLES = `
.dbx-shell {
  display: grid;
  grid-template-columns: 280px 1fr;
  height: 100%;
  min-height: 600px;
  color: var(--c-fg, #f5f5f4);
  position: relative;
  /* Background intentionally transparent so the global terminal/glass
     background shows through. The previous multi-stop radial gradients
     and ::before ambient overlay clashed with the operator's chosen
     theme. */
  background: transparent;
}
.dbx-sidebar, .dbx-main { position: relative; z-index: 1; }

.dbx-shell svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.dbx-side-head-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.dbx-side-head-icon {
  display: inline-flex;
  width: 16px;
  height: 16px;
  color: var(--c-accent, var(--g-primary, #fbbf24));
}
.dbx-side-head-icon svg { width: 16px; height: 16px; }
.dbx-side-icon-svg {
  display: inline-flex;
  width: 14px;
  height: 14px;
  color: rgba(255,255,255,0.55);
}
.dbx-side-icon-svg svg { width: 14px; height: 14px; }

.dbx-btn-icon { display: inline-flex; width: 14px; height: 14px; margin-right: 4px; vertical-align: middle; }
.dbx-btn-icon svg { width: 14px; height: 14px; }
.dbx-btn-icon-sm { width: 12px; height: 12px; }
.dbx-btn-icon-sm svg { width: 12px; height: 12px; }
.dbx-btn-icononly {
  padding: 6px;
  width: 30px; height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.dbx-btn-icononly svg { width: 14px; height: 14px; margin: 0; }

.dbx-head-icon-svg {
  display: inline-flex;
  width: 22px;
  height: 22px;
  color: var(--c-accent, var(--g-primary, #fbbf24));
}
.dbx-head-icon-svg svg { width: 22px; height: 22px; }

.dbx-cell-check {
  display: inline-flex;
  width: 16px; height: 16px;
}
.dbx-cell-check svg { width: 16px; height: 16px; }
.dbx-cell-check.on { color: var(--c-accent, var(--g-primary, #fbbf24)); }
.dbx-cell-check.off { color: rgba(255,255,255,0.3); }

.dbx-icon-btn { display: inline-flex; align-items: center; justify-content: center; }
.dbx-icon-btn svg { width: 14px; height: 14px; }

/* Sidebar — depth glass, multi-layer shadow, theme-token border */
.dbx-sidebar {
  background:
    linear-gradient(180deg,
      color-mix(in srgb, var(--g-bg, #0a0a0a) 65%, transparent),
      color-mix(in srgb, var(--g-bg, #0a0a0a) 80%, transparent));
  backdrop-filter: blur(20px) saturate(140%);
  -webkit-backdrop-filter: blur(20px) saturate(140%);
  border-right: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 18%, transparent);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow:
    1px 0 0 color-mix(in srgb, #ffffff 4%, transparent) inset,
    8px 0 24px rgba(0, 0, 0, 0.25);
}
.dbx-side-head {
  padding: 16px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.04em;
  border-bottom: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--g-primary, #fbbf24) 4%, transparent),
    transparent);
}
.dbx-side-system {
  padding: 8px;
}

/* ── Sidebar business filter ── */
.dbx-biz-filter {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 8px 10px 0;
  padding: 7px 11px;
  font-size: 12px;
  border-radius: 9px;
  cursor: pointer;
  user-select: none;
  color: rgba(255, 255, 255, 0.7);
  background: color-mix(in srgb, var(--g-bg, #0a0a0a) 35%, transparent);
  border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 16%, transparent);
  backdrop-filter: blur(10px);
  transition: color 140ms ease, background 140ms ease, border-color 140ms ease;
}
.dbx-biz-filter:hover {
  color: var(--g-primary, #fbbf24);
  background: color-mix(in srgb, var(--g-primary, #fbbf24) 8%, transparent);
  border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 32%, transparent);
}
.dbx-biz-filter--active {
  color: var(--g-primary, #fbbf24);
  background: color-mix(in srgb, var(--g-primary, #fbbf24) 12%, transparent);
  border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 36%, transparent);
}
.dbx-biz-filter-icon { display: inline-flex; align-items: center; }
.dbx-biz-filter-icon svg { display: block; }
.dbx-biz-filter-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dbx-biz-filter-chev {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.5);
}
.dbx-biz-filter-select {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  font-family: inherit;
}
.dbx-side-list {
  flex: 1;
  overflow: auto;
  list-style: none;
  padding: 6px;
  margin: 0;
}
.dbx-side-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 11px;
  border-radius: 10px;
  cursor: pointer;
  font-size: 13px;
  border: 1px solid transparent;
  transition: background 180ms ease, border-color 180ms ease, transform 180ms ease, box-shadow 180ms ease;
}
.dbx-side-item:hover {
  background: color-mix(in srgb, var(--g-primary, #fbbf24) 6%, transparent);
  border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
  transform: translateX(1px);
}
.dbx-side-item.active {
  background: linear-gradient(135deg,
    color-mix(in srgb, var(--g-primary, #fbbf24) 18%, transparent),
    color-mix(in srgb, var(--g-primary, #fbbf24) 8%, transparent));
  border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 38%, transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, #ffffff 12%, transparent),
    0 0 18px color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
}
.dbx-side-item.active::before {
  content: "";
  position: absolute;
  left: -6px; top: 8px; bottom: 8px;
  width: 3px; border-radius: 2px;
  background: var(--g-primary, #fbbf24);
  box-shadow: 0 0 12px color-mix(in srgb, var(--g-primary, #fbbf24) 60%, transparent);
}
.dbx-side-icon { width: 20px; text-align: center; }
.dbx-side-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.dbx-side-tag {
  font-size: 9px;
  padding: 2px 6px;
  border-radius: 10px;
  background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.6);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.dbx-side-footer { padding: 10px; border-top: 1px solid rgba(250,204,21,0.08); }
.dbx-empty-side { padding: 12px; color: rgba(255,255,255,0.5); font-size: 12px; }

/* Main */
.dbx-main { display: flex; flex-direction: column; overflow: hidden; }
.dbx-head {
  display: flex;
  align-items: center;
  padding: 16px 22px;
  border-bottom: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
  gap: 16px;
  position: sticky;
  top: 0;
  z-index: 4;
  background:
    linear-gradient(180deg,
      color-mix(in srgb, var(--g-bg, #0a0a0a) 75%, transparent),
      color-mix(in srgb, var(--g-bg, #0a0a0a) 60%, transparent));
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, #ffffff 6%, transparent),
    0 8px 24px rgba(0, 0, 0, 0.22);
}
.dbx-head-title {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}
.dbx-head-title h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.01em;
  background: linear-gradient(135deg,
    var(--c-fg, #f5f5f4),
    color-mix(in srgb, var(--g-primary, #fbbf24) 70%, var(--c-fg, #f5f5f4)));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.dbx-head-icon { font-size: 22px; }
.dbx-head-desc { color: rgba(255,255,255,0.5); font-size: 12px; margin-left: 8px; }
.dbx-view-tabs {
  display: flex;
  gap: 2px;
  background: color-mix(in srgb, var(--g-bg, #0a0a0a) 55%, transparent);
  border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
  border-radius: 10px;
  padding: 3px;
  backdrop-filter: blur(8px);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #ffffff 4%, transparent);
}
.dbx-view-tab {
  appearance: none;
  background: transparent;
  border: none;
  color: rgba(255,255,255,0.65);
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.05em;
  text-transform: capitalize;
  border-radius: 7px;
  cursor: pointer;
  transition: color 180ms ease, background 180ms ease;
}
.dbx-view-tab:hover { color: var(--c-fg, #f5f5f4); }
.dbx-view-tab.active {
  background: linear-gradient(135deg,
    var(--c-accent, var(--g-primary, #fbbf24)),
    color-mix(in srgb, var(--c-accent, var(--g-primary, #fbbf24)) 75%, #6366f1));
  color: #0a0a0a;
  font-weight: 700;
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, #ffffff 28%, transparent),
    0 4px 12px color-mix(in srgb, var(--c-accent, var(--g-primary, #fbbf24)) 25%, transparent);
}
.dbx-head-actions { display: flex; gap: 6px; align-items: center; }

.dbx-sync-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid rgba(250, 204, 21, 0.18);
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.3);
  font-size: 11px;
  color: rgba(255, 255, 255, 0.75);
  cursor: pointer;
  user-select: none;
}
.dbx-sync-toggle svg { width: 12px; height: 12px; }
.dbx-sync-toggle input { accent-color: var(--c-accent, #fbbf24); }
.dbx-sync-toggle.on {
  color: var(--c-accent, #fbbf24);
  border-color: var(--c-accent, #fbbf24);
  background: rgba(250, 204, 21, 0.08);
}
.dbx-sync-ago { color: rgba(255, 255, 255, 0.5); font-size: 10px; margin-left: 4px; }

/* Table */
.dbx-table-wrap { flex: 1; overflow: auto; padding: 12px; }
.dbx-table {
  border-collapse: collapse;
  width: 100%;
  font-size: 13px;
}
.dbx-th {
  text-align: left;
  padding: 8px 10px;
  background: rgba(0,0,0,0.3);
  border-bottom: 1px solid rgba(250,204,21,0.1);
  font-weight: 500;
  color: rgba(255,255,255,0.8);
  position: sticky;
  top: 0;
}
.dbx-th-name { margin-right: 6px; }
.dbx-th-type {
  font-size: 9px;
  color: rgba(255,255,255,0.3);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.dbx-th-add { width: 40px; text-align: center; }
.dbx-td-open {
  width: 30px;
  text-align: right;
  padding-right: 6px;
}
.dbx-row-open {
  appearance: none;
  background: transparent;
  border: 1px solid transparent;
  color: rgba(255,255,255,0.35);
  width: 24px; height: 24px;
  border-radius: 5px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s, color 0.15s, border-color 0.15s;
}
.dbx-row-open svg { width: 12px; height: 12px; }
.dbx-row:hover .dbx-row-open { opacity: 1; }
.dbx-row-open:hover {
  color: var(--c-accent, #fbbf24);
  background: rgba(250,204,21,0.08);
  border-color: rgba(250,204,21,0.25);
}
.dbx-row {
  cursor: pointer;
  transition: background 0.15s;
}
.dbx-row:hover { background: rgba(250,204,21,0.04); }
.dbx-row.selected { background: rgba(250,204,21,0.1); }
.dbx-td {
  padding: 8px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  vertical-align: top;
}
.dbx-cell-title { font-weight: 500; }
.dbx-cell-empty { color: rgba(255,255,255,0.25); }
.dbx-row-new td { color: rgba(255,255,255,0.4); cursor: pointer; padding: 8px 10px; }
.dbx-row-new:hover td { color: var(--c-accent, var(--g-primary)); }

.dbx-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 10px;
  color: #fff;
  font-size: 11px;
  margin-right: 4px;
}
.dbx-pill-sm { font-size: 10px; padding: 1px 6px; }

/* Empty */
.dbx-empty-state { flex: 1; display: grid; place-items: center; padding: 40px; }
.dbx-empty-inner { text-align: center; max-width: 460px; }
.dbx-empty-icon {
  display: inline-flex;
  width: 56px;
  height: 56px;
  margin-bottom: 18px;
  color: var(--c-accent, var(--g-primary, #fbbf24));
  opacity: 0.85;
}
.dbx-empty-icon svg { width: 56px; height: 56px; stroke-width: 1.5; }
.dbx-empty-inner h2 { margin: 0 0 4px 0; }
.dbx-empty-inner p { color: rgba(255,255,255,0.6); margin: 0 0 20px 0; }
.dbx-empty-actions { display: flex; gap: 10px; justify-content: center; }
.dbx-error { color: #ef4444; margin-top: 16px; }
.dbx-page-error {
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  padding: 8px 12px;
  margin: 12px 0;
  cursor: pointer;
  font-size: 0.85rem;
}
.dbx-page-error:hover { background: rgba(239, 68, 68, 0.14); }

/* Board */
.dbx-board {
  flex: 1;
  display: flex;
  gap: 12px;
  padding: 14px;
  overflow: auto;
}
.dbx-board-col {
  min-width: 260px;
  max-width: 300px;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  background: rgba(0,0,0,0.25);
  border: 1px solid rgba(250,204,21,0.08);
  border-radius: 12px;
  padding: 10px;
  backdrop-filter: blur(12px);
}
.dbx-board-col-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 4px 10px 4px;
  border-bottom: 1px solid rgba(250,204,21,0.08);
  margin-bottom: 10px;
}
.dbx-board-count { font-size: 11px; color: rgba(255,255,255,0.5); }
.dbx-board-list { display: flex; flex-direction: column; gap: 8px; }
.dbx-card {
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(250,204,21,0.08);
  border-radius: 8px;
  padding: 10px;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
}
.dbx-card:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(0,0,0,0.35);
  border-color: rgba(250,204,21,0.25);
}
.dbx-card-title { font-weight: 500; font-size: 13px; }
.dbx-card-body { font-size: 11px; color: rgba(255,255,255,0.55); margin-top: 4px; }
.dbx-card-add {
  appearance: none;
  border: 1px dashed rgba(250,204,21,0.2);
  background: transparent;
  color: rgba(255,255,255,0.5);
  padding: 8px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
}
.dbx-card-add:hover { border-color: var(--c-accent, var(--g-primary)); color: var(--c-accent, var(--g-primary)); }
.dbx-board-empty {
  flex: 1;
  display: grid;
  place-items: center;
  color: rgba(255,255,255,0.6);
  padding: 40px;
  text-align: center;
}
.dbx-group-picker { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }

/* Gallery */
.dbx-gallery {
  padding: 14px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  /* Equal-height rows — without this, cards with no body text shrink and
     the row looks ragged. Every row tracks the tallest card in it. */
  grid-auto-rows: 1fr;
  gap: 12px;
  overflow: auto;
}
.dbx-gallery-card {
  display: flex;
  flex-direction: column;
  /* Floor every tile at the same height as the "+" add tile so rows stay
     uniform even when the grid only has one card. The flex column +
     body { flex: 1 } below distributes any extra height into the body
     area instead of leaving whitespace under the title. */
  min-height: 220px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(250,204,21,0.1);
  border-radius: 10px;
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
}
.dbx-gallery-card:hover { transform: translateY(-2px); box-shadow: 0 8px 22px rgba(0,0,0,0.4); }
.dbx-gallery-thumb {
  height: 140px;
  flex-shrink: 0;
  background: linear-gradient(135deg,
    color-mix(in srgb, var(--g-primary, #fbbf24) 12%, transparent),
    color-mix(in srgb, #6366f1 8%, transparent) 60%,
    rgba(0, 0, 0, 0.35));
  position: relative;
  overflow: hidden;
}
.dbx-gallery-thumb img {
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
}
.dbx-gallery-thumb-empty::after {
  content: "";
  position: absolute;
  inset: 0;
  background: radial-gradient(circle 80px at 30% 30%,
    color-mix(in srgb, var(--g-primary, #fbbf24) 18%, transparent),
    transparent 60%);
}

/* ── Files / image cell renderers for table view ── */
.dbx-cell-files {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.dbx-cell-thumb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 6px;
  overflow: hidden;
  background: color-mix(in srgb, var(--g-primary, #fbbf24) 8%, rgba(0, 0, 0, 0.3));
  border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 18%, transparent);
  cursor: pointer;
  transition: border-color 140ms ease, transform 140ms ease;
}
.dbx-cell-thumb:hover {
  transform: scale(1.04);
  border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 50%, transparent);
}
.dbx-cell-thumb img {
  width: 100%; height: 100%; object-fit: cover; display: block;
}
.dbx-cell-file {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  font-size: 11px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--g-primary, #fbbf24) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 22%, transparent);
  color: color-mix(in srgb, var(--g-primary, #fbbf24) 90%, #cbd5e1);
  text-decoration: none;
  white-space: nowrap;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dbx-gallery-title {
  padding: 10px 12px 4px 12px;
  font-weight: 500;
  flex-shrink: 0;
}
.dbx-gallery-body {
  padding: 0 12px 10px 12px;
  font-size: 11px;
  color: rgba(255,255,255,0.55);
  flex: 1;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
}
.dbx-gallery-add {
  display: grid;
  place-items: center;
  /* min-height already inherited from .dbx-gallery-card; explicit dashed
     border distinguishes the add tile. */
  border-style: dashed;
}
.dbx-gallery-plus { font-size: 32px; color: rgba(255,255,255,0.3); }

/* Calendar */
.dbx-calendar { flex: 1; padding: 14px; display: flex; flex-direction: column; }
.dbx-cal-head, .dbx-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
.dbx-cal-dow { text-align: center; padding: 6px; color: rgba(255,255,255,0.5); font-size: 11px; }
.dbx-cal-cell {
  background: rgba(0,0,0,0.25);
  border: 1px solid rgba(250,204,21,0.06);
  border-radius: 6px;
  min-height: 80px;
  padding: 4px;
  font-size: 11px;
}
.dbx-cal-cell.empty { background: transparent; border: none; }
.dbx-cal-day { font-weight: 600; color: rgba(255,255,255,0.7); }
.dbx-cal-event {
  margin-top: 3px;
  background: var(--c-accent, var(--g-primary));
  color: #000;
  padding: 2px 4px;
  border-radius: 3px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Drawer */
.dbx-drawer {
  position: absolute;
  top: 0; right: 0;
  height: 100%;
  width: min(520px, 100%);
  background: rgba(10,10,14,0.95);
  backdrop-filter: blur(22px);
  border-left: 1px solid rgba(250,204,21,0.2);
  box-shadow: -20px 0 60px rgba(0,0,0,0.5);
  display: flex;
  flex-direction: column;
  z-index: 20;
}
.dbx-drawer-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px;
  border-bottom: 1px solid rgba(250,204,21,0.1);
}
.dbx-drawer-title {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--c-fg, #f5f5f4);
  font-size: 18px;
  font-weight: 600;
  outline: none;
}
.dbx-drawer-body {
  flex: 1;
  overflow: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.dbx-props { display: flex; flex-direction: column; gap: 10px; }
.dbx-prop { display: flex; flex-direction: column; gap: 4px; }
.dbx-prop-row { flex-direction: row; align-items: center; justify-content: space-between; }
.dbx-prop-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgba(255,255,255,0.55);
}
.dbx-prop-type { color: rgba(255,255,255,0.3); font-size: 9px; }
.dbx-prop-input {
  background: rgba(0,0,0,0.3);
  border: 1px solid rgba(250,204,21,0.12);
  border-radius: 6px;
  color: var(--c-fg, #f5f5f4);
  padding: 6px 8px;
  font-size: 13px;
  outline: none;
}
.dbx-prop-input:focus { border-color: var(--c-accent, var(--g-primary)); }
.dbx-prop-readonly {
  padding: 6px 8px;
  color: rgba(255,255,255,0.5);
  font-size: 13px;
}
.dbx-files { display: flex; flex-direction: column; gap: 4px; }
.dbx-files-empty { color: rgba(255,255,255,0.4); font-size: 12px; padding: 4px 0; }
.dbx-file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(255,255,255,0.04);
}
.dbx-file-name {
  flex: 1;
  text-align: left;
  background: transparent;
  border: none;
  color: var(--c-fg, #f5f5f4);
  font-size: 13px;
  cursor: pointer;
  padding: 0;
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
}
.dbx-file-name:hover { color: var(--c-accent, var(--g-primary)); text-decoration: underline; }
.dbx-file-size { color: rgba(255,255,255,0.4); font-size: 11px; }
.dbx-file-remove {
  background: transparent;
  border: none;
  color: rgba(255,255,255,0.5);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 0 6px;
}
.dbx-file-remove:hover { color: #f87171; }
.dbx-file-upload {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border: 1px dashed rgba(255,255,255,0.15);
  border-radius: 6px;
  color: rgba(255,255,255,0.6);
  font-size: 12px;
  cursor: pointer;
  align-self: flex-start;
}
.dbx-file-upload:hover { color: var(--c-fg, #f5f5f4); border-color: rgba(255,255,255,0.3); }
.dbx-body-editor h4 { margin: 0 0 8px 0; font-size: 13px; color: rgba(255,255,255,0.7); }
.dbx-drawer-footer { border-top: 1px solid rgba(255,255,255,0.08); padding-top: 12px; }

/* Buttons */
.dbx-btn {
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: var(--c-fg, #f5f5f4);
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
  display: inline-flex;
  align-items: center;
  gap: 0;
  white-space: nowrap;
}
.dbx-btn-accent { background: var(--c-accent, var(--g-primary)); color: #000; font-weight: 600; }
.dbx-btn-accent:hover { filter: brightness(1.08); }
.dbx-btn-ghost { border-color: rgba(250,204,21,0.2); color: rgba(255,255,255,0.75); }
.dbx-btn-ghost:hover { background: rgba(250,204,21,0.08); }
.dbx-btn-danger { color: #ef4444; border: 1px solid rgba(239,68,68,0.3); }
.dbx-btn-danger:hover { background: rgba(239,68,68,0.1); }
.dbx-icon-btn {
  appearance: none;
  background: transparent;
  border: none;
  color: rgba(255,255,255,0.65);
  width: 26px; height: 26px;
  border-radius: 6px;
  cursor: pointer;
}
.dbx-icon-btn:hover { background: rgba(250,204,21,0.1); color: var(--c-accent, var(--g-primary)); }

/* Modal */
.dbx-modal-bg {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.55);
  backdrop-filter: blur(6px);
  display: grid;
  place-items: center;
  z-index: 100;
}
.dbx-modal {
  background: rgba(20,20,25,0.98);
  border: 1px solid rgba(250,204,21,0.2);
  border-radius: 12px;
  padding: 20px;
  min-width: 400px;
  max-width: 90vw;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dbx-modal h3 { margin: 0 0 6px 0; }
.dbx-modal-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 10px; }
.dbx-import-log {
  background: rgba(0,0,0,0.4);
  border-radius: 6px;
  padding: 8px;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px;
  max-height: 200px;
  overflow: auto;
  color: rgba(255,255,255,0.8);
}
.dbx-hint { font-size: 11px; color: rgba(255,255,255,0.55); margin: 0; }
.dbx-import-loading {
  padding: 18px 14px;
  text-align: center;
  font-size: 12px;
  color: rgba(255,255,255,0.6);
  background: rgba(0,0,0,0.25);
  border: 1px dashed rgba(255,255,255,0.1);
  border-radius: 8px;
  margin-top: 10px;
}
.dbx-import-error {
  padding: 10px 12px;
  font-size: 12px;
  color: #fca5a5;
  background: color-mix(in srgb, #ef4444 12%, transparent);
  border: 1px solid color-mix(in srgb, #ef4444 30%, transparent);
  border-radius: 8px;
  margin-top: 10px;
}
.dbx-import-empty {
  padding: 16px 14px;
  font-size: 12px;
  color: rgba(255,255,255,0.6);
  background: rgba(0,0,0,0.2);
  border: 1px dashed rgba(255,255,255,0.12);
  border-radius: 8px;
  margin-top: 10px;
  text-align: center;
  line-height: 1.55;
}
.dbx-import-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 10px 0 6px;
  font-size: 11px;
  color: rgba(255,255,255,0.7);
}
.dbx-import-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}
.dbx-import-toggle input { cursor: pointer; }
.dbx-import-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 320px;
  overflow: auto;
  background: rgba(0,0,0,0.2);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  padding: 6px;
}
.dbx-import-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 120ms ease;
}
.dbx-import-row:hover { background: rgba(255,255,255,0.04); }
.dbx-import-row input { cursor: pointer; }
.dbx-import-row-text { flex: 1; min-width: 0; }
.dbx-import-row-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--c-fg, #f5f5f4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dbx-import-row-meta {
  font-size: 10.5px;
  color: rgba(255,255,255,0.5);
  margin-top: 2px;
}

/* ══ Full-page row view ══ */
.dbx-page {
  flex: 1;
  overflow: auto;
  padding: 28px max(24px, calc(50% - 420px)) 80px;
  display: flex;
  flex-direction: column;
  gap: 28px;
  background:
    radial-gradient(1200px 400px at 50% -10%, rgba(250,204,21,0.05), transparent 60%),
    linear-gradient(180deg, rgba(0,0,0,0.2), rgba(0,0,0,0.35));
}
.dbx-page > * { max-width: 840px; width: 100%; align-self: center; }
.dbx-page-loading {
  display: grid;
  place-items: center;
  color: rgba(255,255,255,0.55);
  gap: 14px;
}

.dbx-page-breadcrumb {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.dbx-page-back {
  font-size: 12px;
  color: rgba(255,255,255,0.65);
}
.dbx-page-back:hover { color: var(--c-accent, #fbbf24); }
.dbx-page-crumb {
  appearance: none;
  background: transparent;
  border: none;
  color: rgba(255,255,255,0.55);
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 5px;
  cursor: pointer;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dbx-page-crumb:hover {
  color: var(--c-accent, #fbbf24);
  background: rgba(250,204,21,0.05);
}
.dbx-page-crumb-sep {
  display: inline-flex;
  width: 12px; height: 12px;
  color: rgba(255,255,255,0.3);
}
.dbx-page-crumb-sep svg { width: 12px; height: 12px; }

/* Sub-pages grid */
.dbx-subpage-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
  margin-bottom: 10px;
}
.dbx-subpage-card {
  appearance: none;
  text-align: left;
  background: linear-gradient(180deg, rgba(255,255,255,0.035), rgba(0,0,0,0.35));
  border: 1px solid rgba(250,204,21,0.12);
  border-radius: 10px;
  padding: 10px 12px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--c-fg, #f5f5f4);
  transition: transform 0.15s, border-color 0.15s, box-shadow 0.15s;
  min-width: 0;
}
.dbx-subpage-card:hover {
  transform: translateY(-1px);
  border-color: rgba(250,204,21,0.4);
  box-shadow: 0 6px 18px rgba(0,0,0,0.3);
}
.dbx-subpage-icon {
  display: inline-flex;
  width: 14px; height: 14px;
  color: var(--c-accent, #fbbf24);
}
.dbx-subpage-icon svg { width: 14px; height: 14px; }
.dbx-subpage-title { font-size: 13px; font-weight: 500; }
.dbx-subpage-snippet {
  font-size: 11px;
  color: rgba(255,255,255,0.5);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dbx-pill-dim {
  display: inline-flex;
  padding: 2px 8px;
  font-size: 10px;
  border-radius: 10px;
  background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.55);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.dbx-page-head {
  display: flex;
  align-items: center;
  gap: 14px;
}
.dbx-page-icon { font-size: 28px; display: inline-flex; }
.dbx-page-icon .dbx-head-icon-svg { width: 28px; height: 28px; }
.dbx-page-icon .dbx-head-icon-svg svg { width: 28px; height: 28px; }
.dbx-page-title {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--c-fg, #f5f5f4);
  font-size: 28px;
  font-weight: 700;
  outline: none;
  padding: 2px 0;
  letter-spacing: -0.01em;
}
.dbx-page-title:focus {
  border-bottom: 1px solid rgba(250,204,21,0.25);
}
.dbx-page-title:disabled { color: rgba(255,255,255,0.55); }

.dbx-page-save-badge {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  border-radius: 999px;
  user-select: none;
}
.dbx-page-save-saving {
  color: #eab308;
  background: rgba(234, 179, 8, 0.12);
}
.dbx-page-save-saved {
  color: #22c55e;
  background: rgba(34, 197, 94, 0.12);
}

.dbx-page-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dbx-page-section-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.dbx-page-section-title {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.55);
}

/* Notion-like vertical property list: label on the left at ~140px, control on the right */
.dbx-page-proplist {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-top: 1px solid rgba(255,255,255,0.04);
}
.dbx-page-prop {
  display: grid;
  grid-template-columns: 160px minmax(0, 1fr);
  gap: 14px;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  min-width: 0;
}
.dbx-page-prop .dbx-prop-label {
  padding-top: 0;
  color: rgba(255,255,255,0.55);
  font-size: 12px;
  text-transform: none;
  letter-spacing: 0;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dbx-page-prop-wide {
  grid-template-columns: 160px minmax(0, 1fr);
  align-items: flex-start;
  padding: 10px 0;
}
.dbx-page-prop-wide .dbx-prop-label { padding-top: 8px; }
.dbx-page-prop-row {
  grid-template-columns: 160px minmax(0, 1fr);
}
.dbx-page-prop-row input[type="checkbox"] { justify-self: start; }

.dbx-page-newlinked {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.dbx-btn-sub {
  font-size: 12px;
  color: rgba(255,255,255,0.6);
  border: 1px dashed rgba(250,204,21,0.22);
}
.dbx-btn-sub:hover {
  border-style: solid;
  color: var(--c-accent, #fbbf24);
  background: rgba(250,204,21,0.06);
}

.dbx-related-groups {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dbx-related-group {
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(250,204,21,0.12);
  border-radius: 10px;
  overflow: hidden;
}
.dbx-related-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(0,0,0,0.3);
  border-bottom: 1px solid rgba(255,255,255,0.05);
  font-size: 12px;
}
.dbx-related-arrow {
  display: inline-flex;
  width: 14px;
  height: 14px;
  color: var(--c-accent, #fbbf24);
}
.dbx-related-arrow svg { width: 14px; height: 14px; }
.dbx-related-group-name { flex: 1; font-weight: 500; }
.dbx-related-prop { color: rgba(255,255,255,0.45); font-weight: 400; }
.dbx-related-count {
  background: rgba(250,204,21,0.12);
  padding: 1px 7px;
  border-radius: 10px;
  font-size: 11px;
  color: var(--c-accent, #fbbf24);
}
.dbx-related-list { margin: 0; padding: 0; list-style: none; }
.dbx-related-item {
  padding: 8px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  cursor: pointer;
  transition: background 0.15s;
}
.dbx-related-item:last-child { border-bottom: none; }
.dbx-related-item:hover { background: rgba(250,204,21,0.05); }
.dbx-related-title { font-size: 13px; }
.dbx-related-snippet {
  display: block;
  font-size: 11px;
  color: rgba(255,255,255,0.5);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ══ Relation chips / picker ══ */
.dbx-prop-hint { color: rgba(255,255,255,0.4); font-weight: 400; font-size: 10px; margin-left: 6px; }
.dbx-relation-editor {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 6px;
  border: 1px solid rgba(250,204,21,0.08);
  border-radius: 8px;
  background: rgba(0,0,0,0.2);
  min-height: 34px;
}
.dbx-relation-empty { color: rgba(255,255,255,0.35); font-size: 12px; padding: 2px 6px; }
.dbx-relation-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px 3px 8px;
  background: rgba(250,204,21,0.1);
  border: 1px solid rgba(250,204,21,0.25);
  border-radius: 999px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.dbx-relation-chip:hover {
  background: rgba(250,204,21,0.18);
  border-color: var(--c-accent, #fbbf24);
}
.dbx-relation-chip-title { font-weight: 500; }
.dbx-relation-chip-db { color: rgba(255,255,255,0.5); font-size: 10px; font-weight: 400; }
.dbx-relation-chip-remove {
  appearance: none;
  background: transparent;
  border: none;
  color: rgba(255,255,255,0.45);
  padding: 0;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.dbx-relation-chip-remove svg { width: 10px; height: 10px; }
.dbx-relation-chip-remove:hover {
  background: rgba(239,68,68,0.25);
  color: #fff;
}
.dbx-relation-add {
  appearance: none;
  background: transparent;
  border: 1px dashed rgba(250,204,21,0.28);
  color: rgba(250,204,21,0.7);
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.dbx-relation-add svg { width: 12px; height: 12px; }
.dbx-relation-add:hover {
  background: rgba(250,204,21,0.14);
  color: var(--c-accent, #fbbf24);
  border-style: solid;
}
.dbx-relation-add:disabled { opacity: 0.4; cursor: not-allowed; }

.dbx-relation-picker {
  margin-top: 8px;
  background: rgba(10,10,14,0.98);
  border: 1px solid rgba(250,204,21,0.22);
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.4);
  overflow: hidden;
  max-width: 420px;
}
.dbx-relation-picker-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: rgba(0,0,0,0.35);
  border-bottom: 1px solid rgba(255,255,255,0.05);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgba(255,255,255,0.55);
}
.dbx-relation-picker-list { margin: 0; padding: 4px 0; list-style: none; max-height: 280px; overflow: auto; }
.dbx-relation-picker-item {
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.12s;
}
.dbx-relation-picker-item:hover { background: rgba(250,204,21,0.08); }
.dbx-relation-picker-title { display: block; }
.dbx-relation-picker-snippet { display: block; font-size: 11px; color: rgba(255,255,255,0.5); }
`;
