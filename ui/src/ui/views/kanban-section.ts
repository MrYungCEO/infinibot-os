/**
 * Embedded Kanban section — the full Projects/Tasks board rendered as a page
 * section on the home Dashboard and on Business HQ.
 *
 * This is NOT a second board implementation: it renders the same
 * `renderKanban` view the /projects page uses (global Tasks board by default:
 * columns, drag between columns, open task, + Task) wired to the same kanban
 * controller mutations, inside a framed, height-capped, collapsible section.
 *
 * - variant "dashboard" (core home, business-agency plugin off): the standard
 *   full board — every project and task.
 * - variant "business" (Business HQ, plugin on): the business board — projects
 *   linked to a business + HQ object boards (lib/kanban-section-scope.ts), with
 *   a Business / All tasks toggle. With the plugin off the business scope
 *   collapses to the full board, so the section never renders empty for lack
 *   of the plugin.
 */
import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../app-view-state";
import { isBusinessAgencyOn } from "../business-agency-gate.js";
import {
  createProject as kanbanCreateProject,
  createTask as kanbanCreateTask,
  deleteProject as kanbanDeleteProject,
  deleteTask as kanbanDeleteTask,
  loadKanban,
  updateProject as kanbanUpdateProject,
  updateTask as kanbanUpdateTask,
} from "../controllers/kanban";
import { detectParentProject } from "../controllers/hq-model";
import { icons } from "../icons";
import { getBizFilter } from "../lib/biz-filter";
import {
  effectiveSectionScope,
  openTaskCount,
  selectSectionBoard,
  type KanbanSectionScope,
} from "../lib/kanban-section-scope";
import type { Tab } from "../navigation";
import type { KanbanProject, KanbanTask } from "../types";
import { renderKanban, type KanbanViewProps } from "./kanban";
import { isSecureModeActive } from "../secure-mode/store";
import "../secure-mode/secure-toggle";
import "../secure-mode/secure-board";

export type KanbanSectionVariant = "dashboard" | "business";

type SectionUi = {
  collapsed: boolean;
  scope: KanbanSectionScope;
  galleryView: boolean;
  galleryFilter: string;
  gallerySearch: string;
  gallerySort: string;
  selectedProjectId: string | null;
};

const STORE_KEY = (v: KanbanSectionVariant) => `infinibot.kanbanSection.${v}.v1`;
const uiByVariant = new Map<KanbanSectionVariant, SectionUi>();
const loadKicked = new WeakSet<object>();

function readStored(v: KanbanSectionVariant): Partial<SectionUi> {
  try {
    const raw = localStorage.getItem(STORE_KEY(v));
    return raw ? (JSON.parse(raw) as Partial<SectionUi>) : {};
  } catch {
    return {};
  }
}

function persist(v: KanbanSectionVariant, ui: SectionUi): void {
  try {
    localStorage.setItem(STORE_KEY(v), JSON.stringify({ collapsed: ui.collapsed, scope: ui.scope }));
  } catch {
    /* storage unavailable — in-memory only */
  }
}

function uiFor(v: KanbanSectionVariant): SectionUi {
  let ui = uiByVariant.get(v);
  if (!ui) {
    const stored = readStored(v);
    ui = {
      collapsed: stored.collapsed === true,
      scope: stored.scope === "all" ? "all" : v === "business" ? "business" : "all",
      galleryView: true,
      galleryFilter: "tasks",
      gallerySearch: "",
      gallerySort: "recent",
      selectedProjectId: null,
    };
    uiByVariant.set(v, ui);
  }
  return ui;
}

export interface KanbanSectionOptions {
  variant: KanbanSectionVariant;
  /** Overrides the plugin probe (tests / previews). */
  businessPluginOn?: boolean;
}

export function renderKanbanSection(state: AppViewState, opts: KanbanSectionOptions): TemplateResult {
  const { variant } = opts;
  const ui = uiFor(variant);
  const rerender = () => state.requestUpdate?.();

  if (state.client && !loadKicked.has(state)) {
    loadKicked.add(state);
    // Business HQ / Projects may have loaded already — only fetch when empty.
    if (!(state.kanbanProjects?.length) && !state.kanbanLoading) void loadKanban(state);
  }

  const pluginOn = opts.businessPluginOn ?? isBusinessAgencyOn();
  const scope = effectiveSectionScope(ui.scope, pluginOn);
  const allProjects = (state.kanbanProjects ?? []) as KanbanProject[];
  const allTasks = (state.kanbanTasks ?? []) as KanbanTask[];
  const board = selectSectionBoard(allProjects, allTasks, scope, {
    activeBusinessId: pluginOn ? getBizFilter() : null,
    hqParentProjectId: scope === "business" ? detectParentProject(allProjects) : null,
  });
  const count = openTaskCount(board.tasks);
  const isBusiness = scope === "business";

  // A project entered inside the section may fall out of scope (toggle) —
  // fall back to the board instead of stranding an empty project view.
  if (!ui.galleryView && ui.selectedProjectId && !board.projects.some((p) => p.id === ui.selectedProjectId)) {
    ui.galleryView = true;
    ui.selectedProjectId = null;
  }

  const enterProject = (id: string) => {
    ui.selectedProjectId = id;
    ui.galleryView = false;
    rerender();
  };
  const props: KanbanViewProps = {
    loading: !!state.kanbanLoading,
    refreshing: state.kanbanRefreshing ?? false,
    projects: board.projects,
    tasks: board.tasks,
    error: state.kanbanError ?? null,
    selectedProjectId: ui.galleryView ? null : ui.selectedProjectId,
    galleryView: ui.galleryView,
    galleryFilter: ui.galleryFilter,
    gallerySearch: ui.gallerySearch,
    gallerySort: ui.gallerySort,
    selectedTaskId: null,
    onCreateTask: (task) => void kanbanCreateTask(state, task).then(rerender),
    onCreateProject: (project) => void kanbanCreateProject(state, project).then(rerender),
    onUpdateTask: (id, patch) => void kanbanUpdateTask(state, id, patch).then(rerender),
    onDeleteTask: (id) => void kanbanDeleteTask(state, id).then(rerender),
    onDeleteProject: (id) => void kanbanDeleteProject(state, id).then(rerender),
    onRefresh: () => void loadKanban(state).then(rerender),
    onSelectProject: enterProject,
    onEnterProject: enterProject,
    onUpdateProject: (id, patch) => void kanbanUpdateProject(state, id, patch).then(rerender),
    onSelectTask: rerender,
    onBackToGallery: () => {
      ui.galleryView = true;
      ui.selectedProjectId = null;
      rerender();
    },
    onGalleryFilterChange: (f) => {
      ui.galleryFilter = f ?? "tasks";
      rerender();
    },
    onGallerySearchChange: (s) => {
      ui.gallerySearch = s ?? "";
      rerender();
    },
    onGallerySortChange: (s) => {
      ui.gallerySort = s ?? "recent";
      rerender();
    },
    onRequestUpdate: rerender,
    client: state.client,
    businesses: pluginOn
      ? (state.businessState?.businesses ?? []).map((b) => ({ id: b.id, name: b.name }))
      : [],
    agencyId: pluginOn ? (state.businessState?.activeBusinessId ?? undefined) : undefined,
  };

  const openFullBoard = (e: Event) => {
    e.preventDefault();
    state.kanbanGalleryView = true;
    state.kanbanSelectedProjectId = null;
    (state as { kanbanOpenTaskId?: string | null }).kanbanOpenTaskId = null;
    state.kanbanGalleryFilter = "tasks";
    state.setTab("projects" as Tab);
  };
  const toggleCollapsed = () => {
    ui.collapsed = !ui.collapsed;
    persist(variant, ui);
    rerender();
  };
  const setScope = (next: KanbanSectionScope) => {
    if (ui.scope === next) return;
    ui.scope = next;
    persist(variant, ui);
    rerender();
  };

  // Secure Mode on → this section shows the encrypted secure board instead.
  const secureOn = isSecureModeActive();
  const title = secureOn ? "Secure board" : isBusiness ? "Business board" : "Kanban board";
  const sub = secureOn
    ? "Encrypted, local-only tasks — never synced to Notion or the normal board."
    : isBusiness
    ? "Work on business-linked projects and HQ boards — drag cards between columns, open any task."
    : "Every project's tasks — drag cards between columns, open any task, add new work.";
  const bodyId = `kbs-body-${variant}`;
  const emptyBusiness = isBusiness && !state.kanbanLoading && board.projects.length === 0;

  return html`
    ${KBS_STYLE}
    <section
      class="kbs ${ui.collapsed ? "is-collapsed" : ""} ${secureOn ? "kbs--secure" : ""}"
      data-testid="kanban-section"
      data-variant=${variant}
      data-scope=${scope}
      aria-label=${title}
    >
      <header class="kbs-head">
        <div class="kbs-headmain">
          <span class="kbs-icon" aria-hidden="true">${secureOn ? icons.lock : isBusiness ? icons.briefcase : icons.kanban}</span>
          <div class="kbs-titles">
            <h2 class="kbs-title">
              ${title}
              ${secureOn
                ? nothing
                : html`<span class="kbs-count" title="Open tasks">${state.kanbanLoading && allTasks.length === 0 ? "—" : count}</span>`}
            </h2>
            <p class="kbs-sub">${sub}</p>
          </div>
        </div>
        <div class="kbs-actions">
          <ib-secure-toggle compact data-secure-surface=${`kanban-section-${variant}`}></ib-secure-toggle>
          ${!secureOn && variant === "business" && pluginOn
            ? html`<div class="kbs-scope" role="group" aria-label="Board scope">
                <button
                  type="button"
                  class="kbs-scope-btn ${scope === "business" ? "is-active" : ""}"
                  aria-pressed=${scope === "business"}
                  @click=${() => setScope("business")}
                >Business</button>
                <button
                  type="button"
                  class="kbs-scope-btn ${scope === "all" ? "is-active" : ""}"
                  aria-pressed=${scope === "all"}
                  @click=${() => setScope("all")}
                >All tasks</button>
              </div>`
            : nothing}
          <a class="kbs-open" href="/projects" @click=${openFullBoard}>
            Open full board <span class="kbs-ic" aria-hidden="true">${icons.externalLink}</span>
          </a>
          <button
            type="button"
            class="kbs-collapse"
            aria-expanded=${!ui.collapsed}
            aria-controls=${bodyId}
            title=${ui.collapsed ? "Expand board" : "Collapse board"}
            @click=${toggleCollapsed}
          >
            <span class="kbs-ic" aria-hidden="true">${ui.collapsed ? icons.chevronDown : icons.chevronUp}</span>
          </button>
        </div>
      </header>
      ${ui.collapsed
        ? nothing
        : html`<div class="kbs-body" id=${bodyId}>
            ${secureOn
              ? html`<ib-secure-board compact style="flex:1;min-height:0;"></ib-secure-board>`
              : emptyBusiness
              ? html`<div class="kbs-empty">
                  <strong>No business-linked projects yet</strong>
                  <span>Link a project to a business from its edit dialog, or switch to All tasks.</span>
                  <button type="button" class="kbs-scope-btn" @click=${() => setScope("all")}>Show all tasks</button>
                </div>`
              : renderKanban(props)}
          </div>`}
    </section>
  `;
}

const KBS_STYLE = html`<style>
  /* The KIS page root (Business HQ) sets contain: layout, which makes it the
     containing block for position:fixed — the board's task modal would open
     off-screen relative to the page instead of the viewport. Drop layout
     containment only on pages that host this section. */
  .kis:has(.kbs) { contain: style; }
  .kbs {
    --kbs-gold: var(--g-primary, #fbbf24);
    --kbs-fg: var(--glass-fg, var(--text, #e4e4e7));
    --kbs-mute: color-mix(in srgb, var(--kbs-fg) 60%, transparent);
    --kbs-stroke: var(--glass-stroke, rgba(255, 255, 255, 0.08));
    position: relative;
    min-width: 0;
    max-width: 100%;
    margin: 16px 0;
    border: 1px solid var(--glass-stroke-gold, color-mix(in srgb, var(--kbs-gold) 28%, transparent));
    border-radius: var(--glass-radius-lg, 16px);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--kbs-gold) 6%, transparent), transparent 120px),
      var(--glass-2, rgba(18, 18, 22, 0.72));
    box-shadow: var(--glass-elev-2, 0 10px 30px rgba(0, 0, 0, 0.35));
    color: var(--kbs-fg);
    /* No transform / filter / backdrop-filter here: the board's task modal,
       context menu and run dialog are position:fixed and must escape. */
    overflow: clip;
  }
  .kbs.kbs--secure { border-color: var(--ib-secure-ring, rgba(52, 211, 153, 0.5)); box-shadow: var(--ib-secure-glow, none), var(--glass-elev-2, 0 10px 30px rgba(0, 0, 0, 0.35)); }
  .kbs.kbs--secure .kbs-icon { color: var(--ib-secure, #34d399); background: var(--ib-secure-soft, rgba(52, 211, 153, 0.13)); border-color: var(--ib-secure-ring, rgba(52, 211, 153, 0.5)); }
  .kbs-body > ib-secure-board { padding: 8px; }
  .kbs-head {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 14px 16px;
    border-bottom: 1px solid var(--kbs-stroke);
  }
  .kbs.is-collapsed .kbs-head { border-bottom: 0; }
  .kbs-headmain { display: flex; align-items: center; gap: 12px; flex: 1 1 260px; min-width: 0; }
  .kbs-icon {
    display: grid; place-items: center; flex: none;
    width: 34px; height: 34px; border-radius: 10px;
    color: var(--kbs-gold);
    background: color-mix(in srgb, var(--kbs-gold) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--kbs-gold) 30%, transparent);
  }
  .kbs-icon svg, .kbs-ic svg { width: 16px; height: 16px; }
  .kbs-titles { min-width: 0; }
  .kbs-title {
    display: flex; align-items: center; gap: 8px;
    margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -0.005em;
  }
  .kbs-count {
    min-width: 22px; padding: 1px 8px; border-radius: 999px;
    font-size: 12px; font-weight: 650; text-align: center; font-variant-numeric: tabular-nums;
    color: var(--kbs-gold);
    background: color-mix(in srgb, var(--kbs-gold) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--kbs-gold) 30%, transparent);
  }
  .kbs-sub { margin: 2px 0 0; font-size: 12.5px; color: var(--kbs-mute); line-height: 1.4; }
  .kbs-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .kbs-scope {
    display: inline-flex; padding: 2px; gap: 2px; border-radius: 10px;
    border: 1px solid var(--kbs-stroke);
    background: color-mix(in srgb, var(--kbs-fg) 4%, transparent);
  }
  .kbs-scope-btn {
    appearance: none; border: 0; cursor: pointer;
    padding: 6px 12px; min-height: 32px; border-radius: 8px;
    font: 600 12.5px/1 inherit; color: var(--kbs-mute); background: transparent;
  }
  .kbs-scope-btn:hover { color: var(--kbs-fg); }
  .kbs-scope-btn.is-active {
    color: #111; background: var(--kbs-gold);
  }
  .kbs-open, .kbs-collapse {
    display: inline-flex; align-items: center; gap: 6px;
    min-height: 34px; padding: 0 12px; border-radius: 10px;
    font: 600 12.5px/1 inherit; text-decoration: none; cursor: pointer;
    color: var(--kbs-fg);
    border: 1px solid var(--kbs-stroke);
    background: color-mix(in srgb, var(--kbs-fg) 5%, transparent);
  }
  .kbs-open:hover, .kbs-collapse:hover {
    border-color: color-mix(in srgb, var(--kbs-gold) 45%, transparent);
    color: var(--kbs-gold);
  }
  .kbs-collapse { width: 34px; padding: 0; justify-content: center; }
  .kbs-open:focus-visible, .kbs-collapse:focus-visible, .kbs-scope-btn:focus-visible {
    outline: 2px solid var(--kbs-gold); outline-offset: 2px;
  }
  .kbs-ic { display: inline-flex; }
  .kbs-ic svg { width: 14px; height: 14px; }
  .kbs-body {
    position: relative;
    height: min(72vh, 760px);
    min-height: 420px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .kbs-body > .kanban-layout { flex: 1; min-height: 0; overflow: auto; }
  .kbs-empty {
    display: grid; place-items: center; align-content: center; gap: 8px;
    height: 100%; padding: 32px 20px; text-align: center; color: var(--kbs-mute); font-size: 13px;
  }
  .kbs-empty strong { color: var(--kbs-fg); font-size: 14px; }
  .kbs-empty .kbs-scope-btn { border: 1px solid var(--kbs-stroke); }
  @media (max-width: 640px) {
    .kbs { margin: 12px 0; border-radius: 14px; }
    .kbs-head { padding: 12px; }
    .kbs-actions { width: 100%; }
    .kbs-open { flex: 1; justify-content: center; }
    .kbs-body { height: 70vh; min-height: 360px; }
  }
</style>`;
