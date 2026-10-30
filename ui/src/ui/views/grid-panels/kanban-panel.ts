/**
 * Grid-panel renderer for the Kanban view.
 *
 * Wraps the dedicated `renderKanban` function (from `views/kanban.ts`) so the
 * panel has true feature parity with the /kanban page — full board with
 * columns, drag/drop, edit-in-place, create/delete, project gallery, etc.
 *
 * Scope:
 *   - `panel.kanbanProjectId == null` → project gallery (all projects)
 *   - `panel.kanbanProjectId === "__tasks__"` → global tasks view (autonomous)
 *   - otherwise → single-project board
 *
 * The panel persists scope changes by dispatching `panel-meta-update` to A1
 * (same protocol the legacy KanbanGridPanel LitElement used).
 */

import { html, type TemplateResult } from "lit";
import type { GridPanel } from "../../controllers/masonry-grid";
import type { GatewayBrowserClient } from "../../gateway";
import type { AppViewState } from "../../app-view-state";
import { renderKanban, type KanbanViewProps } from "../kanban";
import {
  loadKanban,
  createProject as kanbanCreateProject,
  updateProject as kanbanUpdateProject,
  deleteProject as kanbanDeleteProject,
  createTask as kanbanCreateTask,
  updateTask as kanbanUpdateTask,
  deleteTask as kanbanDeleteTask,
} from "../../controllers/kanban";
import {
  ensurePanelWiring,
  findScrollElInPanel,
  panelLoading,
  panelError,
} from "./_shared";

const _initByPanel = new Map<string, boolean>();

/**
 * Dispatch a panel-meta update upward so the masonry grid can persist the
 * change to the panel record (project scope, title). Mirrors the protocol
 * used by the existing KanbanGridPanel LitElement.
 */
function emitMetaUpdate(panelId: string, patch: Partial<GridPanel>): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("panel-meta-update", {
      detail: { panelId, patch },
      bubbles: true,
      composed: true,
    }),
  );
}

export function renderGridKanbanPanel(
  panel: GridPanel,
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  if (!_initByPanel.get(panel.id)) {
    _initByPanel.set(panel.id, true);
    queueMicrotask(() => {
      void loadKanban(state).then(() => state.requestUpdate?.());
      ensurePanelWiring(panel.id, {
        onRefresh: () => {
          void loadKanban(state).then(() => state.requestUpdate?.());
        },
        scrollEl: () => findScrollElInPanel(panel.id, document),
      });
    });
  }

  if (panel.needsRefresh) {
    void loadKanban(state).then(() => state.requestUpdate?.());
    panel.needsRefresh = false;
  }

  const projects = state.kanbanProjects ?? [];
  const tasks = state.kanbanTasks ?? [];
  const selectedProjectId = panel.kanbanProjectId ?? null;
  const galleryView = !selectedProjectId;

  const setScope = (projectId: string | null) => {
    const proj = projects.find((p) => p.id === projectId);
    const title = projectId
      ? `🗂️ ${proj?.name ?? "Project"}`
      : "🗂️ Kanban";
    emitMetaUpdate(panel.id, { kanbanProjectId: projectId, title });
  };

  const props: KanbanViewProps = {
    loading: !!state.kanbanLoading,
    refreshing: !!state.kanbanRefreshing,
    projects,
    tasks,
    error: state.kanbanError ?? null,
    selectedProjectId,
    galleryView,
    galleryFilter: "all",
    gallerySearch: "",
    gallerySort: "recent",
    selectedTaskId: null,
    onCreateTask: (task) => {
      // Default the task to the panel's scoped project when no projectId
      // was set by the caller (gallery/global views still pass projectId).
      const scoped = selectedProjectId && !task.projectId
        ? { ...task, projectId: selectedProjectId }
        : task;
      void kanbanCreateTask(state, scoped).then(() => state.requestUpdate?.());
    },
    onCreateProject: (project) => {
      void kanbanCreateProject(state, project).then(() => state.requestUpdate?.());
    },
    onUpdateTask: (id, patch) => {
      void kanbanUpdateTask(state, id, patch).then(() => state.requestUpdate?.());
    },
    onDeleteTask: (id) => {
      void kanbanDeleteTask(state, id).then(() => state.requestUpdate?.());
    },
    onDeleteProject: (id) => {
      void kanbanDeleteProject(state, id).then(() => state.requestUpdate?.());
    },
    onRefresh: () => {
      void loadKanban(state).then(() => state.requestUpdate?.());
    },
    onSelectProject: (id) => setScope(id),
    onUpdateProject: (id, patch) => {
      void kanbanUpdateProject(state, id, patch).then(() => state.requestUpdate?.());
    },
    onSelectTask: () => state.requestUpdate?.(),
    onEnterProject: (id) => setScope(id),
    onBackToGallery: () => setScope(null),
    onGalleryFilterChange: () => state.requestUpdate?.(),
    onGallerySearchChange: () => state.requestUpdate?.(),
    onGallerySortChange: () => state.requestUpdate?.(),
    onRequestUpdate: () => state.requestUpdate?.(),
    client,
    businesses: (state.businessState as any)?.businesses ?? [],
  };

  return html`
    <div style="
      display:flex; flex-direction:column;
      height:100%; min-height:0; width:100%;
      overflow:hidden;
    ">
      <!-- Project scope picker (mirrors the legacy KanbanGridPanel chrome) -->
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
        ">SCOPE</span>
        <select
          .value=${selectedProjectId ?? "__gallery__"}
          @change=${(e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            setScope(v === "__gallery__" ? null : v);
          }}
          style="
            flex:1; min-width:0; max-width:320px;
            padding:3px 6px;
            background:#0a0a0a;
            border:1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
            color:#e4e4e7;
            font-size:11px; font-family:inherit;
            border-radius:3px;
          "
        >
          <option value="__gallery__">— All Projects (Gallery) —</option>
          ${projects.map((p) => html`
            <option value=${p.id} ?selected=${p.id === selectedProjectId}>
              ${p.name || "Untitled"}
            </option>
          `)}
        </select>
        <div style="flex:1;"></div>
        <button
          @click=${() => {
            void loadKanban(state).then(() => state.requestUpdate?.());
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
            state.setTab?.("kanban" as any);
            state.requestUpdate?.();
          }}
          title="Open full kanban page"
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
        ${state.kanbanError && !state.kanbanLoading && projects.length === 0
          ? panelError(state.kanbanError, () => {
              void loadKanban(state).then(() => state.requestUpdate?.());
            })
          : state.kanbanLoading && projects.length === 0
          ? panelLoading("Loading kanban…")
          : renderKanban(props)}
      </div>
    </div>
  `;
}
