/**
 * Grid-panel renderer for the Databases view.
 *
 * Wraps `renderDatabases` from `views/databases.ts` so the panel has true
 * feature parity with the /databases page — sidebar of databases, selected
 * database table/board/gallery view, row pages, etc.
 *
 * The renderer kicks off `loadDatabases` once per panel, listens for the
 * cross-panel refresh event, and exposes its scroll container under
 * `data-grid-scroll="<panelId>"` so A4's ui_control bus can drive
 * `grid:scroll_panel`.
 */

import { html, type TemplateResult } from "lit";
import type { GridPanel } from "../../controllers/masonry-grid";
import type { GatewayBrowserClient } from "../../gateway";
import type { AppViewState } from "../../app-view-state";
import { renderDatabases } from "../databases";
import { loadDatabases } from "../../controllers/databases";
import {
  ensurePanelWiring,
  findScrollElInPanel,
  panelLoading,
  panelError,
} from "./_shared";

const _initByPanel = new Map<string, boolean>();

export function renderGridDatabasePanel(
  panel: GridPanel,
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  if (!_initByPanel.get(panel.id)) {
    _initByPanel.set(panel.id, true);
    queueMicrotask(() => {
      void loadDatabases(state, client).then(() => state.requestUpdate?.());
      ensurePanelWiring(panel.id, {
        onRefresh: () => {
          void loadDatabases(state, client).then(() => state.requestUpdate?.());
        },
        scrollEl: () => findScrollElInPanel(panel.id, document),
      });
    });
  }

  if (panel.needsRefresh) {
    void loadDatabases(state, client).then(() => state.requestUpdate?.());
    panel.needsRefresh = false;
  }

  const dbState = state.databasesState;
  const dbs = dbState?.databases ?? [];
  const loading = !!dbState?.loading;
  const error = dbState?.error ?? null;

  return html`
    <div style="
      display:flex; flex-direction:column;
      height:100%; min-height:0; width:100%;
      overflow:hidden;
    ">
      <!-- Header strip: matches kanban-panel chrome -->
      <div style="
        flex-shrink:0;
        display:flex; align-items:center; gap:8px;
        padding:6px 10px;
        border-bottom:1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
        background: color-mix(in srgb, var(--g-primary) 3%, transparent);
        font-family:'JetBrains Mono','SF Mono',Consolas,monospace;
      ">
        <span style="
          font-size:10px; letter-spacing:0.12em; font-weight:700;
          color: color-mix(in srgb, var(--g-primary) 80%, #888);
        ">DATABASES</span>
        <span style="font-size:9px; color:#71717a;">
          ${dbs.length} ${dbs.length === 1 ? "db" : "dbs"}
        </span>
        <div style="flex:1;"></div>
        <button
          @click=${() => {
            void loadDatabases(state, client).then(() => state.requestUpdate?.());
          }}
          title="Refresh"
          style="
            padding:3px 9px; background:transparent;
            border:1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
            color: color-mix(in srgb, var(--g-primary) 80%, #aaa);
            font-size:11px; cursor:pointer; border-radius:3px;
            font-family:inherit;
          "
        >↻</button>
        <button
          @click=${() => {
            state.setTab?.("databases" as any);
            state.requestUpdate?.();
          }}
          title="Open full databases page"
          style="
            padding:3px 9px; background:transparent;
            border:1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
            color: color-mix(in srgb, var(--g-primary) 80%, #aaa);
            font-size:10px; cursor:pointer; border-radius:3px;
            font-family:inherit; letter-spacing:0.08em;
          "
        >FULL →</button>
      </div>

      <!-- Scroll container — A4 targets data-grid-scroll -->
      <div
        data-grid-scroll=${panel.id}
        style="
          position:relative; flex:1; min-height:0;
          overflow:auto;
          scrollbar-width: thin;
          scrollbar-color: color-mix(in srgb, var(--g-primary) 30%, transparent) transparent;
        "
      >
        ${error && !loading && dbs.length === 0
          ? panelError(error, () => {
              void loadDatabases(state, client).then(() => state.requestUpdate?.());
            })
          : loading && dbs.length === 0
          ? panelLoading("Loading databases…")
          : renderDatabases(state, client)}
      </div>
    </div>
  `;
}
