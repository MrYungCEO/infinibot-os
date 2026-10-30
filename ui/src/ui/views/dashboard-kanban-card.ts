/**
 * <dashboard-kanban-card> — embeds the full /kanban board (drag-and-drop, lane
 * reorder, task move) for a single "main" project directly on /dashboard, beside
 * the Focus card.
 *
 * It reuses the SAME `renderKanban` component + the SAME kanban controller
 * mutations the /kanban view uses — there is NO forked drag logic here. The only
 * dashboard-specific concern is which project to show, persisted in localStorage
 * (`infinibot.dashboard.mainProjectId`), defaulting to the highest-priority
 * focused project, then the first kanban project.
 *
 * Lifecycle note: because this is a real LitElement, its event listeners live and
 * die with the element. renderKanban attaches its drag handlers per-render inside
 * this element's shadow root, so mounting it on /dashboard does not leak listeners
 * onto /kanban (separate render roots, separate handler instances). Switching the
 * picker just re-renders renderKanban with a different `selectedProjectId`.
 */
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icons } from "../icons";
import { renderKanban, type KanbanViewProps } from "./kanban";
import {
  loadKanban as loadKanbanData,
  createProject as kanbanCreateProject,
  updateProject as kanbanUpdateProject,
  deleteProject as kanbanDeleteProject,
  createTask as kanbanCreateTask,
  updateTask as kanbanUpdateTask,
  deleteTask as kanbanDeleteTask,
} from "../controllers/kanban";
import { getFocusProjectIds } from "../controllers/focus";
import { SecureModeController } from "../secure-mode";
import { onProjectReposChange, projectOptionLabel } from "../project-repos/index";

export const DASHBOARD_MAIN_PROJECT_KEY = "infinibot.dashboard.mainProjectId";

@customElement("dashboard-kanban-card")
export class DashboardKanbanCard extends LitElement {
  /** Secure Mode on → the card shows the encrypted secure board instead. */
  private secure = new SecureModeController(this);
  static styles = css`
    :host { display: block; color: var(--glass-fg); font-family: var(--glass-font); }
    .dkc {
      position: relative;
      isolation: isolate;
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 360px;
      background: var(--glass-sheen), var(--glass-tint), var(--glass-2);
      border: 1px solid var(--glass-stroke-gold);
      border-radius: var(--glass-radius-lg);
      box-shadow: var(--glass-elev-2);
      backdrop-filter: var(--glass-blur);
      -webkit-backdrop-filter: var(--glass-blur);
      overflow: hidden;
    }
    .dkc--secure { border-color: var(--ib-secure-ring, rgba(52, 211, 153, 0.5)); box-shadow: var(--ib-secure-glow, none), var(--glass-elev-2); }
    .dkc-title--secure { color: var(--ib-secure, #34d399); }
    .dkc-body--secure { padding: 8px; }
    .dkc-body--secure ib-secure-board { height: 100%; }
    .dkc-head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--glass-stroke);
      background: var(--glass-gold-a06);
    }
    .dkc-title {
      font-weight: 600;
      font-size: 14px;
      color: var(--glass-fg);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex: 1;
      min-width: 0;
    }
    .dkc-title span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dkc-picker {
      background: var(--glass-hover);
      color: var(--glass-fg);
      border: 1px solid var(--glass-stroke-strong);
      border-radius: var(--glass-radius-xs);
      padding: 4px 8px;
      font-size: 12px;
      max-width: 180px;
    }
    .dkc-body {
      flex: 1;
      min-height: 0;
      overflow: auto;
    }
    .dkc-empty {
      min-height: 220px;
      padding: 32px 20px;
      text-align: center;
      color: var(--glass-fg-3);
      font-size: 13px;
      line-height: 1.6;
      display: grid;
      place-items: center;
    }
    .dkc-empty strong {
      display: block;
      margin-bottom: 4px;
      color: var(--glass-fg);
      font: 600 14px/1.3 var(--glass-font);
    }
    .dkc-loading {
      min-height: 260px;
      padding: 20px;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      align-items: stretch;
    }
    .dkc-skeleton {
      min-height: 190px;
      border: 1px solid var(--glass-stroke);
      border-radius: var(--glass-radius);
      background:
        linear-gradient(100deg, transparent 20%, var(--glass-gold-a10) 42%, transparent 64%) 140% 0 / 220% 100%,
        var(--glass-sheen),
        var(--glass-3);
      box-shadow: var(--glass-elev-1);
      animation: dkc-shimmer 1.8s var(--glass-ease) infinite;
    }
    .dkc-sr {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    @keyframes dkc-shimmer { to { background-position: -120% 0, 0 0, 0 0; } }
    .dkc-picker:focus-visible { outline: none; box-shadow: var(--glass-focus-ring); }
    @media (max-width: 520px) {
      .dkc-head { align-items: stretch; flex-direction: column; }
      .dkc-picker { max-width: none; width: 100%; min-height: 36px; }
      .dkc-loading { grid-template-columns: 1fr; padding: 14px; }
      .dkc-skeleton { min-height: 112px; }
      .dkc-skeleton:nth-child(n + 3) { display: none; }
    }
    @media (prefers-reduced-transparency: reduce) {
      .dkc { background: var(--glass-solid); backdrop-filter: none; -webkit-backdrop-filter: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition: none !important; }
    }
  `;

  @property({ type: Object }) appState: any = null;
  @property({ type: Object }) client: any = null;

  @state() private selectedProjectId: string | null = null;
  private kanbanLoaded = false;

  private offRepos: (() => void) | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.selectedProjectId = this.readStoredProjectId();
    // Repo labels in the project picker follow the shared repo store.
    this.offRepos = onProjectReposChange(() => this.requestUpdate());
  }

  disconnectedCallback(): void {
    this.offRepos?.();
    this.offRepos = null;
    super.disconnectedCallback();
  }

  updated(): void {
    if (!this.kanbanLoaded && this.appState && this.client) {
      this.kanbanLoaded = true;
      void loadKanbanData(this.appState).then(() => {
        // Now that projects are loaded, resolve a default if none was stored.
        if (!this.selectedProjectId) {
          this.selectedProjectId = this.resolveDefaultProjectId();
        }
        this.appState?.requestUpdate?.();
        this.requestUpdate();
      });
    }
  }

  private readStoredProjectId(): string | null {
    try {
      return localStorage.getItem(DASHBOARD_MAIN_PROJECT_KEY) || null;
    } catch {
      return null;
    }
  }

  private storeProjectId(id: string | null): void {
    try {
      if (id) localStorage.setItem(DASHBOARD_MAIN_PROJECT_KEY, id);
      else localStorage.removeItem(DASHBOARD_MAIN_PROJECT_KEY);
    } catch {
      /* ignore */
    }
  }

  /** Default = highest-priority focused project that exists, else first project. */
  private resolveDefaultProjectId(): string | null {
    const projects: any[] = this.appState?.kanbanProjects ?? [];
    if (projects.length === 0) return null;
    const ids = new Set(projects.map((p) => p.id));
    const focusProject = getFocusProjectIds().find((id) => ids.has(id));
    if (focusProject) return focusProject;
    return projects[0]?.id ?? null;
  }

  private onPickProject = (e: Event) => {
    const value = (e.target as HTMLSelectElement).value || null;
    this.selectedProjectId = value;
    this.storeProjectId(value);
    this.requestUpdate();
  };

  private buildProps(projects: any[], tasks: any[], selectedProjectId: string | null): KanbanViewProps {
    return {
      loading: !!this.appState?.kanbanLoading,
      projects,
      tasks,
      error: this.appState?.kanbanError ?? null,
      selectedProjectId,
      galleryView: false,
      galleryFilter: "all",
      gallerySearch: "",
      gallerySort: "recent",
      selectedTaskId: null,
      onCreateTask: (task) => {
        if (this.appState) void kanbanCreateTask(this.appState, task).then(() => this.bump());
      },
      onCreateProject: (project) => {
        if (this.appState) void kanbanCreateProject(this.appState, project).then(() => this.bump());
      },
      onUpdateTask: (id, patch) => {
        if (this.appState) void kanbanUpdateTask(this.appState, id, patch).then(() => this.bump());
      },
      onDeleteTask: (id) => {
        if (this.appState) void kanbanDeleteTask(this.appState, id).then(() => this.bump());
      },
      onDeleteProject: (id) => {
        if (this.appState) void kanbanDeleteProject(this.appState, id).then(() => this.bump());
      },
      onRefresh: () => {
        if (this.appState) void loadKanbanData(this.appState).then(() => this.bump());
      },
      onSelectProject: (id) => {
        this.selectedProjectId = id;
        this.storeProjectId(id);
        this.requestUpdate();
      },
      onUpdateProject: (id, patch) => {
        if (this.appState) void kanbanUpdateProject(this.appState, id, patch).then(() => this.bump());
      },
      onSelectTask: () => this.bump(),
      onEnterProject: (id) => {
        this.selectedProjectId = id;
        this.storeProjectId(id);
        this.requestUpdate();
      },
      // Keep the dashboard card pinned to one project — "back to gallery" just
      // clears the selection so the empty/picker state shows.
      onBackToGallery: () => {
        this.selectedProjectId = null;
        this.storeProjectId(null);
        this.requestUpdate();
      },
      onGalleryFilterChange: () => this.bump(),
      onGallerySearchChange: () => this.bump(),
      onGallerySortChange: () => this.bump(),
      onRequestUpdate: () => { this.requestUpdate(); this.appState?.requestUpdate?.(); },
      client: this.client,
    };
  }

  private bump(): void {
    this.requestUpdate();
    this.appState?.requestUpdate?.();
  }

  render() {
    const projects: any[] = this.appState?.kanbanProjects ?? [];
    const tasks: any[] = this.appState?.kanbanTasks ?? [];

    // Resolve the effective selection: stored/clicked, else default. Validate
    // it still exists so a deleted project doesn't strand the card.
    let selected = this.selectedProjectId;
    if (selected && !projects.some((p) => p.id === selected)) selected = null;
    if (!selected && projects.length > 0) selected = this.resolveDefaultProjectId();

    const proj = projects.find((p) => p.id === selected);
    const title = proj ? proj.name || "Project" : "Main Project";

    if (!this.appState || !this.client) {
      return html`
        <div class="dkc" aria-busy="true">
          <div class="dkc-loading" aria-hidden="true">
            <div class="dkc-skeleton"></div>
            <div class="dkc-skeleton"></div>
            <div class="dkc-skeleton"></div>
          </div>
          <span class="dkc-sr">Loading project board</span>
        </div>
      `;
    }

    if (this.secure.active) {
      return html`
        <div class="dkc dkc--secure">
          <div class="dkc-head">
            <div class="dkc-title dkc-title--secure"><span>${icons.lock} Secure board</span></div>
            <ib-secure-toggle compact data-secure-surface="dashboard"></ib-secure-toggle>
          </div>
          <div class="dkc-body dkc-body--secure"><ib-secure-board compact></ib-secure-board></div>
        </div>
      `;
    }

    return html`
      <div class="dkc">
        <div class="dkc-head">
          <div class="dkc-title"><span>${icons.folder} ${title}</span></div>
          ${proj ? html`<ib-repo-badge compact .projectId=${proj.id} .projectName=${proj.name}></ib-repo-badge>` : nothing}
          <ib-secure-toggle compact data-secure-surface="dashboard"></ib-secure-toggle>
          ${projects.length > 0
            ? html`
                <select class="dkc-picker" .value=${selected ?? ""} @change=${this.onPickProject} title="Track a different project">
                  ${projects.map(
                    (p) => html`<option value=${p.id} ?selected=${p.id === selected}>${projectOptionLabel(p.name || "Untitled", p.id)}</option>`,
                  )}
                </select>
              `
            : nothing}
        </div>
        <div class="dkc-body">
          ${selected
            ? renderKanban(this.buildProps(projects, tasks, selected))
            : html`<div class="dkc-empty"><div><strong>No main project yet</strong>Create a project in Projects or pin one from Focus, then it will appear here.</div></div>`}
        </div>
      </div>
    `;
  }
}
