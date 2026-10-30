/**
 * Grid-panel renderer for the Tasks view.
 *
 * Reuses `renderKanban` with the gallery filter pre-set to "tasks" — that
 * filter switches the kanban view into a task-board layout (see
 * `views/kanban.ts` around the `galleryFilter === "tasks"` branches), giving
 * us feature parity with the dedicated task page without duplicating the
 * task-list renderer.
 *
 * Scope persistence: dispatching `panel-meta-update` lets the masonry grid
 * persist `kanbanProjectId` to the panel record so reopening the panel
 * restores the active project filter.
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
const _filterByPanel = new Map<string, string>();
const _searchByPanel = new Map<string, string>();
const _sortByPanel = new Map<string, string>();

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

export function renderGridTasksPanel(
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

  const setScope = (projectId: string | null) => {
    const proj = projects.find((p) => p.id === projectId);
    const title = projectId
      ? `✅ ${proj?.name ?? "Project"} · Tasks`
      : "✅ Tasks";
    emitMetaUpdate(panel.id, { kanbanProjectId: projectId, title });
  };

  // Tasks panel forces gallery view + "tasks" filter so the user always
  // lands on the task list. They can still pivot to "ai"/"active"/etc. via
  // the kanban chrome — the filter is held per-panel in `_filterByPanel`.
  const props: KanbanViewProps = {
    loading: !!state.kanbanLoading,
    refreshing: !!state.kanbanRefreshing,
    projects,
    tasks,
    error: state.kanbanError ?? null,
    selectedProjectId: null,
    galleryView: true,
    galleryFilter: _filterByPanel.get(panel.id) ?? "tasks",
    gallerySearch: _searchByPanel.get(panel.id) ?? "",
    gallerySort: _sortByPanel.get(panel.id) ?? "recent",
    selectedTaskId: null,
    onCreateTask: (task) => {
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
    onSelectProject: () => state.requestUpdate?.(),
    onUpdateProject: (id, patch) => {
      void kanbanUpdateProject(state, id, patch).then(() => state.requestUpdate?.());
    },
    onSelectTask: () => state.requestUpdate?.(),
    onEnterProject: () => state.requestUpdate?.(),
    onBackToGallery: () => state.requestUpdate?.(),
    onGalleryFilterChange: (filter: string) => {
      _filterByPanel.set(panel.id, filter ?? "tasks");
      state.requestUpdate?.();
    },
    onGallerySearchChange: (search: string) => {
      _searchByPanel.set(panel.id, search ?? "");
      state.requestUpdate?.();
    },
    onGallerySortChange: (sort: string) => {
      _sortByPanel.set(panel.id, sort ?? "recent");
      state.requestUpdate?.();
    },
    onRequestUpdate: () => state.requestUpdate?.(),
    client,
    businesses: ((state.businessState as any)?.businesses ?? []).map((b: any) => ({
      id: b.id,
      name: b.name,
    })),
  };

  return html`
    <div style="
      display:flex; flex-direction:column;
      height:100%; min-height:0; width:100%;
      overflow:hidden;
    ">
      <!-- Project filter strip -->
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
        ">TASKS</span>
        <select
          .value=${selectedProjectId ?? "__all__"}
          @change=${(e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            setScope(v === "__all__" ? null : v);
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
          <option value="__all__">— All Projects —</option>
          ${projects.map((p) => html`
            <option value=${p.id} ?selected=${p.id === selectedProjectId}>
              ${p.name || "Untitled"}
            </option>
          `)}
        </select>
        <span style="font-size:9px; color:#71717a;">
          ${(selectedProjectId
            ? tasks.filter((t) => t.projectId === selectedProjectId)
            : tasks
          ).length} ${tasks.length === 1 ? "task" : "tasks"}
        </span>
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
          title="Open full kanban / tasks page"
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
        ${state.kanbanError && !state.kanbanLoading && tasks.length === 0
          ? panelError(state.kanbanError, () => {
              void loadKanban(state).then(() => state.requestUpdate?.());
            })
          : state.kanbanLoading && tasks.length === 0
          ? panelLoading("Loading tasks…")
          : renderKanban(props)}
      </div>
    </div>
  `;
}
