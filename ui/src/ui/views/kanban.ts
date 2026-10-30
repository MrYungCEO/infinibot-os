import { html, nothing } from "lit";
import { icons } from "../icons";
import "../components/doc-agent-panel";
import { ensureCovers, monogramFor, renderCoverBanner, renderCoverThumb } from "../components/object-cover";
import { renderProjectReports } from "../components/report-associations";
import { renderProjectRelations } from "../components/project-relations";
import "../components/people-chips";
import { getBizFilter, setBizFilter } from "../lib/biz-filter";
import { isBusinessAgencyOn } from "../business-agency-gate.js";
import { renderFederationNodeMultiSelect, renderFederationNodeChips } from "../components/federation-chip.js";
import type { FedNodeOption } from "../components/federation-chip.js";
import { ref } from "lit/directives/ref.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { toSanitizedMarkdownHtml } from "../markdown";
import type { KanbanProject, KanbanTask, TaskStatus, ProjectStatus, PriorityLevel } from "../types";
import { mountBlockEditor, type BlockEditor } from "./project-content-editor";
import { specDocId } from "../controllers/project-spec";
import { renderProjectSpecPanel } from "../components/project-spec-panel";
import { renderProjectSummaryPanel } from "../components/project-summary-panel";
import { mountRichDocEditor, type RichDocEditor } from "./rich-doc-editor";
import { requestChangeNotionDb } from "./change-notion-db-host";
import { getClientName } from "../controllers/clients";
import {
  loadRecentlyCompleted,
  subscribeRecentCompleted,
} from "./recently-completed-feed";
import {
  initProjectsRecentlyCompleted,
  renderProjectsRecentlyCompleted,
} from "../components/projects-recently-completed";
import { managedInterval, type SchedulerHandle } from "../perf/visibility-scheduler";
import kanbanGlassCss from "./work-glass/kanban.css?inline";
import projectSectionsCss from "./work-glass/project-sections.css?inline";
import { renderRepoDirButton } from "../project-repos/index";
import { openProjectGraph } from "../components/knowledge-graph-project-scope";

// Hide-sub-projects toggle (persisted in localStorage)
const HIDE_SUB_PROJECTS_KEY = "kanban:hideSubProjects";
function getHideSubProjects(): boolean {
  try { return localStorage.getItem(HIDE_SUB_PROJECTS_KEY) === "true"; } catch { return false; }
}
function setHideSubProjects(v: boolean) {
  try { localStorage.setItem(HIDE_SUB_PROJECTS_KEY, v ? "true" : "false"); } catch {}
}

// Lazy pdf.js loader so the worker chunk isn't pulled until a user opens a PDF.
let _pdfjsModule: typeof import("pdfjs-dist") | null = null;
async function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (_pdfjsModule) return _pdfjsModule;
  const [lib, workerUrlMod] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.mjs?url"),
  ]);
  lib.GlobalWorkerOptions.workerSrc = (workerUrlMod as { default: string }).default;
  _pdfjsModule = lib;
  return lib;
}

// ── Status / Priority Config ──────────────────────────────────
const STATUS_COLUMNS: { id: TaskStatus; label: string; color: string }[] = [
  { id: "todo", label: "To Do", color: "#3b82f6" },
  { id: "in_progress", label: "In Progress", color: "#f59e0b" },
  { id: "review", label: "Review / Blocked", color: "#a855f7" },
  { id: "done", label: "Done", color: "#10b981" },
];

/**
 * `task.projectId` comes from Notion's relation payload (UUID with dashes)
 * or from the local store (row id). `project.id` is whichever form was
 * returned by `kanban.projects.list`. Most of the time they match, but
 * mixed sources (a hybrid local + Notion install, or a Notion id that
 * round-tripped through a stripped form) can drift between dashed and
 * undashed. This helper folds both to a no-dash, lowercase shape so the
 * filter doesn't drop tasks just because of formatting. Also accepts a
 * `notionId` fallback on the project side.
 */
function canonicalId(id: string | null | undefined): string {
  return (id ?? "").replace(/-/g, "").toLowerCase();
}
function taskMatchesProject(task: KanbanTask, project: { id: string; notionId?: string }): boolean {
  if (!task.projectId) return false;
  const taskKey = canonicalId(task.projectId);
  if (!taskKey) return false;
  return taskKey === canonicalId(project.id) || taskKey === canonicalId(project.notionId);
}

const PROJECT_STATUS_CONFIG: Record<string, { icon: string; color: string; bg: string }> = {
  "Not started": { icon: "○", color: "#9ca3af", bg: "rgba(156,163,175,0.15)" },
  "In progress": { icon: "●", color: "#3b82f6", bg: "rgba(59,130,246,0.15)" },
  "Completed": { icon: "✓", color: "#10b981", bg: "rgba(16,185,129,0.15)" },
  "Paused": { icon: "‖", color: "#9ca3af", bg: "rgba(156,163,175,0.15)" },
  "Updating": { icon: "↻", color: "#3b82f6", bg: "rgba(59,130,246,0.15)" },
  "Awaiting Client": { icon: "◔", color: "#3b82f6", bg: "rgba(59,130,246,0.15)" },
  "Reviewing": { icon: "◉", color: "#f97316", bg: "rgba(249,115,22,0.15)" },
  "Cancelled": { icon: "✕", color: "#ef4444", bg: "rgba(239,68,68,0.15)" },
};

const PRIORITY_CONFIG: Record<string, { dot: string; color: string }> = {
  "Immediate": { dot: "●", color: "#ef4444" },
  "High": { dot: "●", color: "#f97316" },
  "Medium": { dot: "●", color: "#3b82f6" },
  "Low": { dot: "●", color: "#22c55e" },
};

// ── Types ──────────────────────────────────
export type KanbanViewProps = {
  loading: boolean;
  /** Cached data is already displayed; background revalidation is in progress. */
  refreshing?: boolean;
  projects: KanbanProject[];
  tasks: KanbanTask[];
  error: string | null;
  selectedProjectId: string | null;
  galleryView: boolean;
  /** Optional task-route state supplied by the host URL router. */
  openTaskId?: string | null;
  galleryFilter: string;
  gallerySearch: string;
  gallerySort: string;
  onCreateTask: (task: Partial<KanbanTask>) => void;
  onCreateProject: (project: Partial<KanbanProject>) => void;
  onUpdateTask: (id: string, patch: Partial<KanbanTask>) => void;
  onDeleteTask: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onRefresh: () => void;
  onSelectProject: (id: string) => void;
  onUpdateProject: (id: string, patch: Partial<KanbanProject>) => void;
  selectedTaskId: string | null;
  onSelectTask: (id: string | null) => void;
  /** Optional route-aware task open/close hooks used by the full app shell. */
  onOpenTaskPage?: (id: string) => void;
  onCloseTaskPage?: () => void;
  onEnterProject: (id: string) => void;
  onBackToGallery: () => void;
  onGalleryFilterChange: (filter: string) => void;
  onGallerySearchChange: (search: string) => void;
  onGallerySortChange: (sort: string) => void;
  mcpStatus?: any;
  notionSyncStatus?: any;
  onNotionSync?: () => void;
  onMcpSetup?: () => void;
  onFetchNotionBlocks?: (notionPageId: string) => Promise<{ blocks: any[]; subPages: any[] }>;
  onRequestUpdate?: () => void;
  /** Gateway client for direct RPC calls (used by Run dialog) */
  client?: any;
  /**
   * Businesses available for the "Linked business" dropdown on each
   * project. When present and non-empty the gallery + edit dialog show a
   * picker that maps to `KanbanProject.businessId`. Pulled from
   * `state.businessState.businesses` by the caller — empty array hides
   * the affordance entirely.
   */
  businesses?: Array<{ id: string; name?: string }>;
  /** Federation nodes available for device association pickers. */
  fedNodes?: FedNodeOption[];
  /** Selected agency ID — used by the invoice picker to scope available invoices. */
  agencyId?: string;
};

/**
 * Federation associations are already supported by the gateway payload but
 * older shared UI types do not expose them yet. Keep that compatibility local
 * to this view so the glass pass does not require a cross-cutting type edit.
 */
type FederationAssignable = { nodeIds?: string[] };
function federationNodeIds(value: KanbanProject | KanbanTask): string[] {
  return (value as (KanbanProject | KanbanTask) & FederationAssignable).nodeIds ?? [];
}

// ── Sub-agent linkage (kanban ↔ sub-agent registry) ───────────────────
// `_subagentByTaskId` is filled by a lightweight 30 s poller against
// `subagents.list` so each kanban task card can render a "sub-agent" badge
// and the deep-link from the sub-agent detail modal can highlight the
// originating card. The map is shared module-state because every renderTaskCard
// call needs it — wiring it through props would force every caller down the
// chain to thread the value through.
type SubagentBadge = {
  runId: string;
  status: string;
  label?: string;
  coderBackend?: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
};
let _subagentByTaskId: Map<string, SubagentBadge> = new Map();
let _subagentPollTimer: SchedulerHandle | null = null;
let _subagentPollClient: any = null;

/** Module-level "highlight this task on next render" id. Cleared after one paint. */
let _focusTaskId: string | null = null;
let _focusTaskClearTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Deep-link entry point. Called from the global event listener installed by
 * `mountKanbanDeepLinkListener` when the sub-agent detail modal dispatches
 * `infinibot:kanban-open-task`. The host (app-render) supplies a callback that
 * sets the kanban tab + selected project; this function then arms `_focusTaskId`
 * so the next render highlights and scrolls to the linked card.
 */
let _kanbanDeepLinkHost: ((projectId?: string, taskId?: string) => void) | null = null;
let _kanbanDeepLinkMounted = false;

/**
 * Register a host callback that switches the active app tab to Kanban + opens
 * the given project. Once registered (host side), the modal-driven deep-link
 * event will route through here. Idempotent.
 */
export function mountKanbanDeepLinkListener(
  host: (projectId?: string, taskId?: string) => void,
): void {
  _kanbanDeepLinkHost = host;
  if (_kanbanDeepLinkMounted) return;
  _kanbanDeepLinkMounted = true;
  window.addEventListener("infinibot:kanban-open-task", (e: Event) => {
    const detail = (e as CustomEvent).detail as
      | { projectId?: string; taskId?: string }
      | undefined;
    if (!detail) return;
    if (detail.taskId) {
      _focusTaskId = detail.taskId;
      if (_focusTaskClearTimer) clearTimeout(_focusTaskClearTimer);
      // Auto-clear after 6 s so a later organic open of the kanban view
      // doesn't keep highlighting a stale task.
      _focusTaskClearTimer = setTimeout(() => {
        _focusTaskId = null;
        _rerender();
      }, 6_000);
    }
    _kanbanDeepLinkHost?.(detail.projectId, detail.taskId);
  });
}

/**
 * Start a 30 s polling loop against `subagents.list` so kanban task cards can
 * render a sub-agent badge. Idempotent — repeated calls reuse the existing
 * timer. The first call also kicks off an immediate fetch so the badge appears
 * within one paint of mounting the view.
 */
function ensureSubagentPolling(client: any): void {
  if (!client) return;
  _subagentPollClient = client;
  const refresh = async () => {
    try {
      const resp = (await client.request("subagents.list", {
        limit: 100,
        includeCompleted: true,
        compact: true,
      })) as { subagents?: Array<{ runId: string; status: string; label?: string; kanbanTaskId?: string; coderBackend?: SubagentBadge["coderBackend"] }> };
      const next = new Map<string, SubagentBadge>();
      for (const s of resp?.subagents ?? []) {
        if (!s.kanbanTaskId) continue;
        // Latest wins — overwrite an older completed run with a newer in-progress one.
        next.set(s.kanbanTaskId, {
          runId: s.runId,
          status: s.status,
          label: s.label,
          coderBackend: s.coderBackend,
        });
      }
      _subagentByTaskId = next;
      _rerender();
    } catch {
      // Best-effort — kanban view should still render without badges.
    }
  };
  // Guard before fetching: refresh() re-renders, and every render calls this
  // function again — fetching first turned that into a request loop.
  if (_subagentPollTimer) return;
  void refresh();
  _subagentPollTimer = managedInterval(() => void refresh(), 30_000, { hiddenMs: 120_000 });
}

// ── Module State ──────────────────────────────────
let _showCreateDialog = false;
let _createForm = { title: "", description: "", status: "todo" as TaskStatus, priority: "medium" };
let _showCreateProjectDialog = false;
let _createProjectForm = { name: "", description: "" };
let _showEditProjectDialog = false;
let _editProjectForm: {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus | "";
  priority: PriorityLevel | "";
  progress: number;
  dueDate: string;
  productUrl: string;
  githubRepoUrl: string;
  githubDefaultBranch: string;
  githubLocalPath: string;
  businessId: string;
  // USD amounts — empty string when unset so the inputs show placeholder text
  // instead of "0". Parsed at save-time.
  paidAmount: string;
  pendingPay: string;
  nodeIds: string[];
} = {
  id: "",
  name: "",
  description: "",
  status: "",
  priority: "",
  progress: 0,
  dueDate: "",
  productUrl: "",
  githubRepoUrl: "",
  githubDefaultBranch: "",
  githubLocalPath: "",
  businessId: "",
  paidAmount: "",
  pendingPay: "",
  nodeIds: [],
};

// ── GitHub sync UI state ──────────────────────────────────────────────────
let _githubValidating = false;
let _githubValidateResult: { ok: boolean; msg: string } | null = null;
let _githubSyncing = false;
let _githubSyncResult: { syncStatus: string; output?: string } | null = null;

// ── Per-project directory linking state ──────────────────────────────────
// Loaded lazily when the edit dialog opens. Linked = directories.projectId
// matches the open project; Available = all other directories the user can
// link instead. The picker / inline-create form are gated on these flags.
type EditProjectDir = {
  id: string;
  path: string;
  name: string;
  description?: string;
  projectId?: string;
};
let _editProjectDirsLoading = false;
let _editProjectDirsLoaded = false;
let _editProjectDirsLinked: EditProjectDir[] = [];
let _editProjectDirsAvailable: EditProjectDir[] = [];
let _editProjectDirError: string | null = null;
let _editProjectDirPickerOpen = false;
let _editProjectDirPickerQuery = "";
let _editProjectDirNewOpen = false;
let _editProjectDirNew = { name: "", path: "", description: "" };

async function loadEditProjectDirs(client: any, projectId: string): Promise<void> {
  if (!client || !projectId) return;
  _editProjectDirsLoading = true;
  _editProjectDirError = null;
  _rerender();
  try {
    const [linkedRes, allRes] = await Promise.all([
      client.request("directories.list", { projectId, active: true }),
      client.request("directories.list", { active: true }),
    ]);
    const linked: EditProjectDir[] = Array.isArray(linkedRes) ? linkedRes : [];
    const all: EditProjectDir[] = Array.isArray(allRes) ? allRes : [];
    const linkedIds = new Set(linked.map((d) => d.id));
    _editProjectDirsLinked = linked;
    _editProjectDirsAvailable = all.filter((d) => !linkedIds.has(d.id));
    _editProjectDirsLoaded = true;
  } catch (err) {
    _editProjectDirError = err instanceof Error ? err.message : String(err);
  } finally {
    _editProjectDirsLoading = false;
    _rerender();
  }
}

async function linkProjectDir(client: any, projectId: string, dirId: string): Promise<void> {
  try {
    await client.request("directories.update", { id: dirId, projectId });
    await loadEditProjectDirs(client, projectId);
  } catch (err) {
    _editProjectDirError = err instanceof Error ? err.message : String(err);
    _rerender();
  }
}

async function unlinkProjectDir(client: any, projectId: string, dirId: string): Promise<void> {
  try {
    await client.request("directories.update", { id: dirId, projectId: null });
    await loadEditProjectDirs(client, projectId);
  } catch (err) {
    _editProjectDirError = err instanceof Error ? err.message : String(err);
    _rerender();
  }
}

async function createAndLinkProjectDir(
  client: any,
  projectId: string,
  entry: { name: string; path: string; description?: string },
): Promise<void> {
  try {
    await client.request("directories.create", {
      name: entry.name,
      path: entry.path,
      description: entry.description ?? undefined,
      projectId,
      active: true,
    });
    _editProjectDirNew = { name: "", path: "", description: "" };
    _editProjectDirNewOpen = false;
    await loadEditProjectDirs(client, projectId);
  } catch (err) {
    _editProjectDirError = err instanceof Error ? err.message : String(err);
    _rerender();
  }
}

function resetEditProjectDirState(): void {
  _editProjectDirsLoading = false;
  _editProjectDirsLoaded = false;
  _editProjectDirsLinked = [];
  _editProjectDirsAvailable = [];
  _editProjectDirError = null;
  _editProjectDirPickerOpen = false;
  _editProjectDirPickerQuery = "";
  _editProjectDirNewOpen = false;
  _editProjectDirNew = { name: "", path: "", description: "" };
}

// ── GitHub repo metadata fetch state ─────────────────────────────────────
let _githubFetchingInfo = false;
let _githubInfoResult: {
  found: boolean;
  name?: string;
  description?: string | null;
  defaultBranch?: string | null;
  stars?: number;
  visibility?: string | null;
} | null = null;

// ── Project ↔ Invoice linking state ──────────────────────────────────────
type EditProjectInvoice = {
  id: string;
  number: string;
  clientName: string;
  status: string;
  totalCents: number;
  amountPaidCents: number;
  balanceCents: number;
};
let _editProjectInvoicesLoading = false;
let _editProjectInvoicesLoaded = false;
let _editProjectLinkedInvoices: EditProjectInvoice[] = [];
let _editProjectAvailableInvoices: EditProjectInvoice[] = [];
let _editProjectInvoicePaidTotalCents = 0;
let _editProjectInvoicePendingTotalCents = 0;
let _editProjectInvoicePickerOpen = false;
let _editProjectInvoicePickerQuery = "";
let _editProjectInvoiceError: string | null = null;

async function loadEditProjectInvoices(client: any, projectId: string): Promise<void> {
  if (!client || !projectId) return;
  _editProjectInvoicesLoading = true;
  _editProjectInvoiceError = null;
  _rerender();
  try {
    const res = await client.request("kanban.project.invoices.list", { projectId });
    _editProjectLinkedInvoices = res.linked ?? [];
    _editProjectAvailableInvoices = res.available ?? [];
    _editProjectInvoicePaidTotalCents = res.paidTotalCents ?? 0;
    _editProjectInvoicePendingTotalCents = res.pendingTotalCents ?? 0;
    _editProjectInvoicesLoaded = true;
  } catch (err) {
    _editProjectInvoiceError = err instanceof Error ? err.message : String(err);
  } finally {
    _editProjectInvoicesLoading = false;
    _rerender();
  }
}

async function setEditProjectInvoiceLink(client: any, projectId: string, invoiceId: string, linked: boolean): Promise<void> {
  if (!client) return;
  const current = _editProjectLinkedInvoices.map((i) => i.id);
  const next = linked ? [...current, invoiceId] : current.filter((id) => id !== invoiceId);
  try {
    await client.request("kanban.project.invoices.set", { projectId, invoiceIds: next });
    await loadEditProjectInvoices(client, projectId);
  } catch (err) {
    _editProjectInvoiceError = err instanceof Error ? err.message : String(err);
    _rerender();
  }
}

function resetEditProjectInvoiceState(): void {
  _editProjectInvoicesLoading = false;
  _editProjectInvoicesLoaded = false;
  _editProjectLinkedInvoices = [];
  _editProjectAvailableInvoices = [];
  _editProjectInvoicePaidTotalCents = 0;
  _editProjectInvoicePendingTotalCents = 0;
  _editProjectInvoicePickerOpen = false;
  _editProjectInvoicePickerQuery = "";
  _editProjectInvoiceError = null;
  _githubFetchingInfo = false;
  _githubInfoResult = null;
}

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function invoiceStatusColor(status: string): string {
  switch (status) {
    case "paid": return "#22c55e";
    case "partially_paid": return "#84cc16";
    case "issued":
    case "overdue": return "#f59e0b";
    case "void": return "#6b7280";
    default: return "#888";
  }
}

// ── Floating control-center popover on the project board header ──────────
// Anchored under the project name button; no dim backdrop, click anywhere
// outside to close. Provides a quick-edit surface for paid / pending USD
// (with billing dates) and the directories picker — same backend wires as
// the edit modal, just rendered as a floating panel.
function renderProjectHeaderPopover(props: KanbanViewProps, project: KanbanProject) {
  const client = props.client;
  const f = _projectHeaderPopoverForm;

  const commit = async (patch: Partial<KanbanProject>) => {
    _projectHeaderPopoverSaving = true;
    _rerender();
    try {
      props.onUpdateProject(project.id, patch);
    } finally {
      _projectHeaderPopoverSaving = false;
      _rerender();
    }
  };

  const parseMoney = (raw: string): number | undefined => {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };

  return html`
    <div class="proj-popover-overlay" @click=${closeProjectHeaderPopover}></div>
    <div class="proj-popover" @click=${(e: Event) => e.stopPropagation()}>
      <div class="proj-popover-row">
        <label class="proj-popover-label">Paid (USD)</label>
        <input class="proj-popover-input" type="number" min="0" step="0.01" placeholder="0.00"
          .value=${f.paidAmount}
          @input=${(e: Event) => { _projectHeaderPopoverForm.paidAmount = (e.target as HTMLInputElement).value; _rerender(); }}
          @blur=${() => commit({ paidAmount: parseMoney(_projectHeaderPopoverForm.paidAmount) })} />
        <input class="proj-popover-input proj-popover-input--date" type="date"
          .value=${f.paidAmountDate}
          @input=${(e: Event) => { _projectHeaderPopoverForm.paidAmountDate = (e.target as HTMLInputElement).value; _rerender(); }}
          @blur=${() => commit({ paidAmountDate: _projectHeaderPopoverForm.paidAmountDate || undefined })} />
      </div>
      <div class="proj-popover-row">
        <label class="proj-popover-label">Pending (USD)</label>
        <input class="proj-popover-input" type="number" min="0" step="0.01" placeholder="0.00"
          .value=${f.pendingPay}
          @input=${(e: Event) => { _projectHeaderPopoverForm.pendingPay = (e.target as HTMLInputElement).value; _rerender(); }}
          @blur=${() => commit({ pendingPay: parseMoney(_projectHeaderPopoverForm.pendingPay) })} />
        <input class="proj-popover-input proj-popover-input--date" type="date"
          .value=${f.pendingPayDate}
          @input=${(e: Event) => { _projectHeaderPopoverForm.pendingPayDate = (e.target as HTMLInputElement).value; _rerender(); }}
          @blur=${() => commit({ pendingPayDate: _projectHeaderPopoverForm.pendingPayDate || undefined })} />
      </div>
      <div class="proj-popover-row">
        <label class="proj-popover-label">MRR (USD)</label>
        <input class="proj-popover-input" type="number" min="0" step="0.01" placeholder="0.00"
          .value=${f.mrr}
          @input=${(e: Event) => { _projectHeaderPopoverForm.mrr = (e.target as HTMLInputElement).value; _rerender(); }}
          @blur=${() => commit({ mrr: parseMoney(_projectHeaderPopoverForm.mrr) })} />
      </div>
      ${_projectHeaderPopoverSaving ? html`<div class="proj-popover-saving">Saving…</div>` : nothing}
      ${client ? renderProjectLinkedClientsSection(props, project.id) : nothing}
      ${client ? renderProjectDirectoriesSection(props, project.id) : html`
        <div class="proj-popover-hint">Gateway client not ready — reopen this popover once the UI finishes loading.</div>
      `}
      <div class="proj-popover-foot">
        <button class="btn-secondary" @click=${closeProjectHeaderPopover}>Done</button>
      </div>
    </div>
  `;
}

// ── Project ↔ Directories section (lives inside the edit-project dialog) ──
// Surfaces linked directories so autonomous agents can resolve the project
// repo path on the fly. Multi-select via directories.projectId — pick from
// existing entries or inline-create a new one without leaving the dialog.
function renderProjectDirectoriesSection(props: KanbanViewProps, projectId: string) {
  const client = props.client;
  if (!client) {
    return html`
      <div class="form-group">
        <label class="form-label">Project directories</label>
        <div class="form-hint" style="font-size:11px;color:#888;">Gateway client not ready — reopen this dialog once the UI finishes loading.</div>
      </div>
    `;
  }
  const q = _editProjectDirPickerQuery.trim().toLowerCase();
  const available = q
    ? _editProjectDirsAvailable.filter(
        (d) => d.name.toLowerCase().includes(q) || d.path.toLowerCase().includes(q),
      )
    : _editProjectDirsAvailable;

  return html`
    <div class="form-group" style="margin-top:8px;">
      <label class="form-label">
        Project directories
        ${_editProjectDirsLoading ? html`<span style="font-size:11px;color:#888;margin-left:6px;">loading…</span>` : nothing}
      </label>
      <div class="form-hint" style="font-size:11px;color:#888;margin-bottom:6px;">
        Linked directories are injected into agent context so autonomous runs know exactly where this project lives.
      </div>
      ${_editProjectDirError ? html`
        <div style="color:#ef4444;font-size:11px;margin-bottom:6px;">${_editProjectDirError}</div>
      ` : nothing}
      <div style="display:flex;flex-wrap:wrap;gap:6px;min-height:24px;margin-bottom:8px;">
        ${_editProjectDirsLinked.length === 0
          ? html`<span style="color:#888;font-size:11px;">No directories linked yet.</span>`
          : _editProjectDirsLinked.map((d) => html`
              <span title=${d.path}
                style="display:inline-flex;align-items:center;gap:6px;padding:4px 8px 4px 10px;border-radius:999px;background:rgba(250,204,21,0.10);border:1px solid rgba(250,204,21,0.30);color:#facc15;font:600 11px 'Inter',sans-serif;max-width:340px;">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${d.name}</span>
                <span style="opacity:0.6;font:500 10px monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${d.path}</span>
                <button type="button" aria-label="Unlink ${d.name}"
                  style="appearance:none;background:transparent;border:none;color:#facc15;opacity:0.7;cursor:pointer;font:700 12px sans-serif;padding:0 2px;"
                  @click=${() => unlinkProjectDir(client, projectId, d.id)}>×</button>
              </span>
            `)}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button type="button" class="btn-secondary"
          @click=${() => { _editProjectDirPickerOpen = !_editProjectDirPickerOpen; _editProjectDirNewOpen = false; _rerender(); }}>
          ${_editProjectDirPickerOpen ? "Close picker" : "+ Link existing directory"}
        </button>
        <button type="button" class="btn-secondary"
          @click=${() => { _editProjectDirNewOpen = !_editProjectDirNewOpen; _editProjectDirPickerOpen = false; _rerender(); }}>
          ${_editProjectDirNewOpen ? "Cancel" : "+ Create new directory"}
        </button>
      </div>

      ${_editProjectDirPickerOpen ? html`
        <div style="margin-top:8px;padding:10px;border-radius:10px;background:rgba(0,0,0,0.35);border:1px solid rgba(250,204,21,0.25);">
          <input type="text" class="form-input" placeholder="Search directories…"
            .value=${_editProjectDirPickerQuery}
            @input=${(e: Event) => { _editProjectDirPickerQuery = (e.target as HTMLInputElement).value; _rerender(); }} />
          <div style="max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;margin-top:6px;">
            ${available.length === 0
              ? html`<div style="text-align:center;padding:12px;color:rgba(255,255,255,0.4);font-size:11px;">${q ? "No matches." : (_editProjectDirsLoaded ? "All directories are already linked." : "Loading…")}</div>`
              : available.map((d) => html`
                  <button type="button"
                    style="appearance:none;text-align:left;padding:6px 10px;border-radius:6px;background:transparent;border:1px solid transparent;color:rgba(255,255,255,0.85);font:500 11.5px 'Inter',sans-serif;display:flex;justify-content:space-between;align-items:center;cursor:pointer;"
                    @mouseover=${(e: Event) => { (e.currentTarget as HTMLElement).style.background = "rgba(250,204,21,0.12)"; }}
                    @mouseout=${(e: Event) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                    @click=${() => linkProjectDir(client, projectId, d.id)}>
                    <span style="display:flex;flex-direction:column;overflow:hidden;">
                      <span style="font-weight:600;">${d.name}${d.projectId ? html`<span style="margin-left:6px;color:#888;font-weight:400;font-size:10px;">(linked to another project)</span>` : nothing}</span>
                      <span style="font:500 10px monospace;color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${d.path}</span>
                    </span>
                  </button>
                `)}
          </div>
        </div>
      ` : nothing}

      ${_editProjectDirNewOpen ? html`
        <div style="margin-top:8px;padding:10px;border-radius:10px;background:rgba(0,0,0,0.35);border:1px solid rgba(250,204,21,0.25);display:flex;flex-direction:column;gap:6px;">
          <input type="text" class="form-input" placeholder="Name (e.g. infinibot-fresh)"
            .value=${_editProjectDirNew.name}
            @input=${(e: Event) => { _editProjectDirNew.name = (e.target as HTMLInputElement).value; _rerender(); }} />
          <input type="text" class="form-input" placeholder="/absolute/path/to/repo"
            .value=${_editProjectDirNew.path}
            @input=${(e: Event) => { _editProjectDirNew.path = (e.target as HTMLInputElement).value; _rerender(); }} />
          <input type="text" class="form-input" placeholder="Description (optional)"
            .value=${_editProjectDirNew.description}
            @input=${(e: Event) => { _editProjectDirNew.description = (e.target as HTMLInputElement).value; _rerender(); }} />
          <div style="display:flex;gap:6px;justify-content:flex-end;">
            <button type="button" class="btn-secondary"
              @click=${() => { _editProjectDirNewOpen = false; _editProjectDirNew = { name: "", path: "", description: "" }; _rerender(); }}>Cancel</button>
            <button type="button" class="btn-primary"
              ?disabled=${!_editProjectDirNew.name.trim() || !_editProjectDirNew.path.trim()}
              @click=${() => createAndLinkProjectDir(client, projectId, {
                name: _editProjectDirNew.name.trim(),
                path: _editProjectDirNew.path.trim(),
                description: _editProjectDirNew.description.trim() || undefined,
              })}>Create & link</button>
          </div>
        </div>
      ` : nothing}
    </div>
  `;
}
// Floating "control center" popover anchored to the project name on the
// board toolbar. Holds an inline copy of the paid / pending / dates / dirs
// controls so the user doesn't have to open the full edit modal for a quick
// edit. Lives in module state because the board view is a function, not a
// component.
let _projectHeaderPopoverOpenFor: string | null = null;
let _projectHeaderPopoverForm = {
  paidAmount: "",
  pendingPay: "",
  paidAmountDate: "",
  pendingPayDate: "",
  mrr: "",
};
let _projectHeaderPopoverSaving = false;

function openProjectHeaderPopover(project: KanbanProject, client: any, agencyId?: string | null): void {
  _projectHeaderPopoverOpenFor = project.id;
  _projectHeaderPopoverForm = {
    paidAmount: typeof project.paidAmount === "number" ? String(project.paidAmount) : "",
    pendingPay: typeof project.pendingPay === "number" ? String(project.pendingPay) : "",
    paidAmountDate: project.paidAmountDate ?? "",
    pendingPayDate: project.pendingPayDate ?? "",
    mrr: typeof project.mrr === "number" ? String(project.mrr) : "",
  };
  resetEditProjectDirState();
  // Reuse the edit-modal directory state — only one of the two surfaces is
  // ever open at a time, so sharing keeps the wiring simple.
  if (client) void loadEditProjectDirs(client, project.id);
  if (client) void loadProjectLinkedClients(client, project.id, agencyId);
  _rerender();
}

// ── Project ↔ Clients relation surface (kanban side of the relation) ──
// Mirrors `cs.detailRelations.project` on the Clients page; uses the same
// gateway `relations.{list,link,unlink}` RPCs so both ends stay in sync.
type LinkedClientLite = { id: string; name: string; search: string; missing?: boolean };
const _projectLinkedClients = new Map<string, {
  loaded: boolean;
  saving: boolean;
  linked: LinkedClientLite[];
  catalog: LinkedClientLite[];
  query: string;
  err?: string;
}>();

function projectLinkedClientsState(projectId: string) {
  let s = _projectLinkedClients.get(projectId);
  if (!s) {
    s = { loaded: false, saving: false, linked: [], catalog: [], query: "" };
    _projectLinkedClients.set(projectId, s);
  }
  return s;
}

// Build a searchable index string (name + every string field, e.g. email,
// company) from a dynamic client record so the typeahead matches on more
// than just the id.
function clientSearchIndex(rec: any, name: string): string {
  const parts: string[] = [name];
  const data = rec?.data;
  if (data && typeof data === "object") {
    for (const v of Object.values(data)) {
      if (typeof v === "string" && v) parts.push(v);
    }
  }
  return parts.join(" ").toLowerCase();
}

async function loadProjectLinkedClients(
  client: any,
  projectId: string,
  agencyId?: string | null,
): Promise<void> {
  const s = projectLinkedClientsState(projectId);
  try {
    // Scope the CRM lookup to the active business/agency. Without this the
    // gateway falls back to the "default" agency, which is empty for anyone
    // running a real business — the picker then shows zero clients even
    // though the /clients page (which passes agencyId) lists them fine.
    const clientsParams = agencyId ? { agencyId } : {};
    const [relRes, allRes] = await Promise.all([
      client.request("relations.list", { type: "project", id: projectId, peerType: "client" }),
      client.request("business.clients.list", clientsParams).catch(() => ({ clients: [] })),
    ]);
    const rels = Array.isArray((relRes as any)?.relations) ? (relRes as any).relations : [];
    const all = Array.isArray((allRes as any)?.clients) ? (allRes as any).clients : [];
    const schema = (allRes as any)?.schema ?? null;
    const byId = new Map<string, any>(all.map((c: any) => [String(c.id), c]));
    const nameFor = (rec: any): string => {
      // Dynamic CRM records carry their title under `.data`; reuse the same
      // resolver the /clients view uses. Fall back to flat name/title.
      const n = getClientName(rec, schema);
      if (n && n !== "Untitled") return n;
      return String(rec?.name ?? rec?.title ?? rec?.id ?? "");
    };
    s.catalog = all.map((c: any) => {
      const name = nameFor(c);
      return { id: String(c.id), name, search: clientSearchIndex(c, name) };
    });
    s.linked = rels.map((r: any) => {
      const id = String(r.id);
      const rec = byId.get(id);
      if (!rec) return { id, name: id, search: id.toLowerCase(), missing: true };
      const name = nameFor(rec);
      return { id, name, search: clientSearchIndex(rec, name) };
    });
    s.loaded = true;
    s.err = undefined;
  } catch (err) {
    s.err = err instanceof Error ? err.message : String(err);
  }
  _rerender();
}

async function linkClientToProject(client: any, projectId: string, clientId: string): Promise<void> {
  const s = projectLinkedClientsState(projectId);
  if (s.linked.some((c) => c.id === clientId)) return;
  s.saving = true;
  _rerender();
  try {
    await client.request("relations.link", {
      left: { type: "project", id: projectId },
      right: { type: "client", id: clientId },
    });
    const cat = s.catalog.find((c) => c.id === clientId);
    s.linked = [
      ...s.linked,
      { id: clientId, name: cat?.name ?? clientId, search: cat?.search ?? clientId.toLowerCase() },
    ];
    s.query = "";
  } catch (err) {
    s.err = err instanceof Error ? err.message : String(err);
  } finally {
    s.saving = false;
    _rerender();
  }
}

async function unlinkClientFromProject(client: any, projectId: string, clientId: string): Promise<void> {
  const s = projectLinkedClientsState(projectId);
  s.saving = true;
  _rerender();
  try {
    await client.request("relations.unlink", {
      left: { type: "project", id: projectId },
      right: { type: "client", id: clientId },
    });
    s.linked = s.linked.filter((c) => c.id !== clientId);
  } catch (err) {
    s.err = err instanceof Error ? err.message : String(err);
  } finally {
    s.saving = false;
    _rerender();
  }
}

// ── Project ↔ Invoice linking section (lives inside the edit-project dialog) ──
// Replaces raw paidAmount/pendingPay number inputs with invoice picker + computed totals.
function renderProjectInvoicesSection(props: KanbanViewProps, projectId: string) {
  const client = props.client;
  const linked = _editProjectLinkedInvoices;
  const available = _editProjectAvailableInvoices;
  const q = _editProjectInvoicePickerQuery.trim().toLowerCase();
  const filteredAvailable = q
    ? available.filter((inv) =>
        inv.number.toLowerCase().includes(q) || inv.clientName.toLowerCase().includes(q),
      )
    : available;

  return html`
    <div class="form-group" style="margin-top:12px;">
      <label class="form-label" style="font-weight:600;">
        Invoices
        ${_editProjectInvoicesLoading ? html`<span style="font-size:11px;color:#888;margin-left:6px;">loading…</span>` : nothing}
      </label>
      <div class="form-hint" style="font-size:11px;color:#888;margin-bottom:8px;">
        Link invoices from the agency dashboard. Paid and pending totals are computed from linked invoices automatically.
      </div>
      ${_editProjectInvoiceError ? html`
        <div style="color:#ef4444;font-size:11px;margin-bottom:6px;">${_editProjectInvoiceError}</div>
      ` : nothing}

      ${/* Computed totals */ linked.length > 0 ? html`
        <div style="display:flex;gap:16px;margin-bottom:10px;padding:8px 10px;background:rgba(255,255,255,0.04);border-radius:6px;border:1px solid rgba(255,255,255,0.08);">
          <div>
            <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Paid</div>
            <div style="font-size:1.1rem;font-weight:700;color:#22c55e;">$${formatCents(_editProjectInvoicePaidTotalCents)}</div>
          </div>
          <div>
            <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Outstanding</div>
            <div style="font-size:1.1rem;font-weight:700;color:#eab308;">$${formatCents(_editProjectInvoicePendingTotalCents)}</div>
          </div>
          <div>
            <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Invoices</div>
            <div style="font-size:1.1rem;font-weight:700;color:var(--c-text,#fff);">${linked.length}</div>
          </div>
        </div>
      ` : nothing}

      ${/* Linked invoice chips */ linked.length === 0
        ? html`<span style="font-size:11px;color:#888;">No invoices linked.</span>`
        : html`
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
            ${linked.map((inv) => html`
              <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:20px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);font-size:11px;">
                <span style="color:${invoiceStatusColor(inv.status)};font-size:9px;">●</span>
                <span style="font-weight:600;">#${inv.number}</span>
                <span style="color:#888;">${inv.clientName}</span>
                <span style="color:#22c55e;">$${formatCents(inv.totalCents)}</span>
                <button
                  style="background:none;border:none;color:#888;cursor:pointer;padding:0;font-size:12px;line-height:1;"
                  title="Unlink invoice"
                  @click=${() => {
                    if (client) void setEditProjectInvoiceLink(client, projectId, inv.id, false);
                  }}>×</button>
              </span>
            `)}
          </div>
        `}

      ${/* Picker toggle */ !_editProjectInvoicePickerOpen ? html`
        <button class="btn-secondary" style="font-size:11px;padding:3px 10px;"
          ?disabled=${!client || _editProjectInvoicesLoading}
          @click=${() => { _editProjectInvoicePickerOpen = true; _rerender(); }}>
          + Link invoice
        </button>
      ` : html`
        <div style="border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:8px;margin-top:4px;">
          <input
            type="text"
            class="form-input"
            style="margin-bottom:6px;"
            placeholder="Search by invoice # or client…"
            autofocus
            .value=${_editProjectInvoicePickerQuery}
            @input=${(e: Event) => { _editProjectInvoicePickerQuery = (e.target as HTMLInputElement).value; _rerender(); }}
            @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape") { _editProjectInvoicePickerOpen = false; _editProjectInvoicePickerQuery = ""; _rerender(); } }}
          />
          <div style="max-height:160px;overflow-y:auto;display:flex;flex-direction:column;gap:3px;">
            ${filteredAvailable.length === 0
              ? html`<div style="font-size:11px;color:#888;padding:4px;">${available.length === 0 ? "No invoices available." : "No matches."}</div>`
              : filteredAvailable.slice(0, 50).map((inv) => html`
                  <button
                    style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:4px;padding:5px 8px;cursor:pointer;text-align:left;color:var(--c-text,#fff);font-size:11px;display:flex;justify-content:space-between;align-items:center;"
                    @click=${() => {
                      if (client) void setEditProjectInvoiceLink(client, projectId, inv.id, true);
                      _editProjectInvoicePickerOpen = false;
                      _editProjectInvoicePickerQuery = "";
                      _rerender();
                    }}>
                    <span>
                      <span style="color:${invoiceStatusColor(inv.status)};font-size:9px;margin-right:5px;">●</span>
                      <strong>#${inv.number}</strong>
                      <span style="color:#888;margin-left:6px;">${inv.clientName}</span>
                    </span>
                    <span style="color:#22c55e;font-weight:600;">$${formatCents(inv.totalCents)}</span>
                  </button>
                `)}
          </div>
          <button class="btn-secondary" style="font-size:11px;padding:2px 8px;margin-top:6px;"
            @click=${() => { _editProjectInvoicePickerOpen = false; _editProjectInvoicePickerQuery = ""; _rerender(); }}>
            Done
          </button>
        </div>
      `}
    </div>
  `;
}

function renderProjectLinkedClientsSection(props: KanbanViewProps, projectId: string) {
  const client = props.client;
  if (!client) {
    return html`
      <div class="form-group">
        <label class="form-label">Linked clients</label>
        <div class="form-hint" style="font-size:11px;color:#888;">Gateway client not ready.</div>
      </div>
    `;
  }
  const s = projectLinkedClientsState(projectId);
  const q = s.query.trim().toLowerCase();
  const linkedIds = new Set(s.linked.map((c) => c.id));
  const available = s.catalog
    .filter((c) => !linkedIds.has(c.id))
    .filter((c) => (q ? c.search.includes(q) : true))
    .slice(0, 20);
  return html`
    <div class="form-group">
      <label class="form-label">Linked clients</label>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
        ${s.linked.length === 0
          ? html`<span style="font-size:12px;color:#888;">No linked clients yet.</span>`
          : s.linked.map(
              (c) => html`
                <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;background:rgba(255,215,0,0.08);border:1px solid rgba(255,215,0,0.25);font-size:12px;${c.missing ? 'opacity:0.5;' : ''}">
                  ${c.missing
                    ? html`<span style="font-family:monospace;font-size:10px;">${c.name}</span><span style="font-size:10px;color:#888;">(unknown)</span>`
                    : c.name}
                  <button
                    title="Unlink ${c.name}"
                    style="background:none;border:0;color:#c0c0c0;cursor:pointer;padding:0;font-size:14px;line-height:1;"
                    @click=${() => void unlinkClientFromProject(client, projectId, c.id)}
                  >×</button>
                </span>
              `,
            )}
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <input
          class="proj-popover-input"
          style="flex:1;"
          placeholder=${s.loaded ? "Search clients to link…" : "Loading clients…"}
          .value=${s.query}
          @input=${(e: Event) => { s.query = (e.target as HTMLInputElement).value; _rerender(); }}
          ?disabled=${s.saving}
        />
      </div>
      ${available.length > 0
        ? html`
            <div style="margin-top:6px;display:flex;flex-direction:column;gap:2px;max-height:160px;overflow:auto;">
              ${available.map(
                (c) => html`
                  <button
                    style="text-align:left;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:6px;padding:6px 8px;color:inherit;cursor:pointer;font-size:12px;"
                    ?disabled=${s.saving}
                    @click=${() => void linkClientToProject(client, projectId, c.id)}
                  >+ ${c.name}</button>
                `,
              )}
            </div>
          `
        : s.loaded && q
          ? html`<div style="font-size:11px;color:#888;margin-top:6px;">No clients match "${s.query}".</div>`
          : nothing}
      ${s.err ? html`<div style="font-size:11px;color:#ef4444;margin-top:6px;">${s.err}</div>` : nothing}
    </div>
  `;
}

function closeProjectHeaderPopover(): void {
  _projectHeaderPopoverOpenFor = null;
  resetEditProjectDirState();
  _rerender();
}

let _taskDetailId: string | null = null;
let _projectsViewMode: "gallery" | "kanban" = "gallery";
let _hideSubProjects = getHideSubProjects();
let _projectKanbanDragId: string | null = null;
let _projectKanbanDragOverCol: string | null = null;

// ── Drag-render RAF gate ───────────────────────────────────────────────────
// Set to true while any drag is in flight so _rerender() skips the
// scroll-position read/write pair (reading scrollTop during drag forces
// layout on every mousemove and is the #1 source of drag lag).
let _kanbanActiveDrag = false;
// Single RAF ticket shared across both kanban boards.  Cancelling before
// issuing a new one caps drag-over re-renders at ≤60/s.
let _kanbanDragRafId: number | null = null;

// ── Gallery pagination ─────────────────────────────────────────────────────
const GALLERY_PAGE_SIZE = 24;
let _galleryPage = 0;

// ── Task-visualization modal ──────────────────────────────────────────────
let _taskModalProjectId: string | null = null;
// Index (within status-sorted flat list) that has keyboard focus
let _taskModalFocusIdx = 0;

function openTaskModal(projectId: string): void {
  _taskModalProjectId = projectId;
  _taskModalFocusIdx = 0;
  _rerender();
}

function closeTaskModal(): void {
  _taskModalProjectId = null;
  _taskModalFocusIdx = 0;
  _rerender();
}

// ── Assign-parent-project picker modal ────────────────────────────────────
// Right-click a project → "Assign parent project" opens a searchable modal.
// The search is debounced; the candidate list excludes the project itself and
// all of its descendants so a parent assignment can never create a cycle.
let _parentPickerProjectId: string | null = null;     // project being reparented
let _parentPickerQuery = "";                            // raw input value
let _parentPickerDebouncedQuery = "";                   // applied (debounced) query
let _parentPickerDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let _parentPickerActiveIndex = 0;                       // keyboard-highlighted row
let _parentPickerLoading = false;                       // brief skeleton on open / debounce
let _parentPickerLoadTimer: ReturnType<typeof setTimeout> | null = null;

function openParentPicker(projectId: string): void {
  _parentPickerProjectId = projectId;
  _parentPickerQuery = "";
  _parentPickerDebouncedQuery = "";
  _parentPickerActiveIndex = 0;
  if (_parentPickerDebounceTimer) { clearTimeout(_parentPickerDebounceTimer); _parentPickerDebounceTimer = null; }
  // Brief skeleton frame on open so the modal has a settled "loading" state
  // even though the project list is already in memory (matches spec).
  _parentPickerLoading = true;
  if (_parentPickerLoadTimer) clearTimeout(_parentPickerLoadTimer);
  _parentPickerLoadTimer = setTimeout(() => { _parentPickerLoading = false; _rerender(); }, 140);
  _rerender();
  // Focus the search field on the next frame.
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>(".pp-search-input");
    input?.focus();
  });
}

function closeParentPicker(): void {
  _parentPickerProjectId = null;
  _parentPickerQuery = "";
  _parentPickerDebouncedQuery = "";
  _parentPickerActiveIndex = 0;
  _parentPickerLoading = false;
  if (_parentPickerDebounceTimer) { clearTimeout(_parentPickerDebounceTimer); _parentPickerDebounceTimer = null; }
  if (_parentPickerLoadTimer) { clearTimeout(_parentPickerLoadTimer); _parentPickerLoadTimer = null; }
  _rerender();
}

function setParentPickerQuery(q: string): void {
  _parentPickerQuery = q;
  _parentPickerLoading = true;
  if (_parentPickerDebounceTimer) clearTimeout(_parentPickerDebounceTimer);
  _parentPickerDebounceTimer = setTimeout(() => {
    _parentPickerDebouncedQuery = q.trim().toLowerCase();
    _parentPickerDebounceTimer = null;
    _parentPickerActiveIndex = 0;     // reset highlight when the result set changes
    _parentPickerLoading = false;
    _rerender();
  }, 150);
  _rerender();
}

/**
 * Lightweight transient toast for kanban actions. Self-contained (inline
 * styles + body append) so it never depends on the kanban stylesheet scope.
 */
function kanbanToast(message: string, kind: "success" | "error" = "success"): void {
  if (typeof document === "undefined") return;
  const el = document.createElement("div");
  el.textContent = message;
  el.setAttribute("role", "status");
  el.className = "kanban-toast";
  const accent = kind === "error" ? "#ef4444" : "#22c55e";
  el.style.cssText = [
    "position:fixed", "left:50%", "bottom:32px",
    "transform:translateX(-50%) translateY(8px)", "z-index:100000",
    "padding:10px 16px", "border-radius:10px", "font-size:0.82rem",
    "font-weight:600", "color:#fff",
    "background:linear-gradient(180deg,#1d1d1d,#141414)",
    `border:1px solid ${accent}66`,
    `box-shadow:0 12px 36px rgba(0,0,0,0.5),0 0 0 1px ${accent}22`,
    "opacity:0", "transition:opacity .18s ease,transform .18s ease",
    "pointer-events:none",
  ].join(";");
  document.body.appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = "1";
    el.style.transform = "translateX(-50%) translateY(0)";
  });
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateX(-50%) translateY(8px)";
  }, 2400);
  setTimeout(() => el.remove(), 2700);
}

// Cycle guard — collect the project plus every transitive descendant so none
// of them can be chosen as the new parent (that would create a loop). Walks the
// parentProjectId edges iteratively; the visited set also makes it safe against
// any pre-existing cycle in the data.
function collectSelfAndDescendantIds(projects: KanbanProject[], rootId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const p of projects) {
    if (p.parentProjectId) {
      const arr = childrenByParent.get(p.parentProjectId) ?? [];
      arr.push(p.id);
      childrenByParent.set(p.parentProjectId, arr);
    }
  }
  const blocked = new Set<string>([rootId]);
  const stack: string[] = [rootId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const childId of childrenByParent.get(cur) ?? []) {
      if (!blocked.has(childId)) {
        blocked.add(childId);
        stack.push(childId);
      }
    }
  }
  return blocked;
}

// ── Column resize system (line-placement, no snap-back) ──────────────────
// Boards are CSS Grids with explicit `grid-template-columns`. A drag handle
// between columns mutates the width of the column to its left. Widths persist
// to localStorage, so they survive reloads and never snap back to a default.
const COL_DEFAULT_WIDTH = 300;
const COL_MIN_WIDTH = 120;
const COL_STORAGE_KEY = "kanban-col-widths-v1";

let _colWidths: Record<string, number> = (() => {
  try {
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem(COL_STORAGE_KEY) : null;
    return stored ? JSON.parse(stored) : {};
  } catch { return {}; }
})();

function colKey(boardNs: string, colId: string): string {
  return `${boardNs}:${colId}`;
}

function getColWidth(boardNs: string, colId: string): number {
  return _colWidths[colKey(boardNs, colId)] ?? COL_DEFAULT_WIDTH;
}

function setColWidth(boardNs: string, colId: string, width: number): void {
  _colWidths[colKey(boardNs, colId)] = width;
}

function persistColWidths(): void {
  try { localStorage.setItem(COL_STORAGE_KEY, JSON.stringify(_colWidths)); } catch { /* ignore */ }
}

function buildGridTemplate(boardNs: string, colIds: string[]): string {
  return colIds.map(id => `${getColWidth(boardNs, id)}px`).join(" ");
}

function startColumnResize(
  e: PointerEvent,
  boardNs: string,
  colId: string,
  colIds: string[],
  boardSelector: string,
): void {
  e.preventDefault();
  e.stopPropagation();
  const handle = e.currentTarget as HTMLElement;
  const board = handle.closest(boardSelector) as HTMLElement | null;
  const startX = e.clientX;
  const startWidth = getColWidth(boardNs, colId);
  // Capture the pointer so subsequent pointermove/pointerup events go to this
  // handle even when the cursor leaves it. Avoids losing the drag mid-stream.
  try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }

  const onMove = (ev: PointerEvent) => {
    const dx = ev.clientX - startX;
    const w = Math.max(COL_MIN_WIDTH, startWidth + dx);
    setColWidth(boardNs, colId, w);
    // Update the CSS custom property only — the layout reads from `--cols`,
    // so we don't fight Lit's `style="--cols: ..."` attribute binding.
    if (board) board.style.setProperty("--cols", buildGridTemplate(boardNs, colIds));
  };
  const onUp = (ev: PointerEvent) => {
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
    try { handle.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    persistColWidths();
    _rerender();
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}

// Global tasks view state
let _globalTasksShowDone = false;
let _globalTasksSearch = "";
let _globalTasksPriority = "all"; // "all" | "critical" | "high" | "medium" | "low"
let _globalTasksAssignee = "all";
let _globalTasksDepartment = "all";
let _globalTasksDragId: string | null = null;
let _globalTasksDragOverCol: TaskStatus | "autonomous" | null = null;
let _globalTasksDragOverPosition: number = -1; // Position index within column (-1 = end)
let _globalTasksDragOverTaskId: string | null = null; // Task being hovered over
let _autonomousDragOverCol: boolean = false; // Specifically for autonomous column

// ── Context Menu State ──────────────────────────────────
type ContextMenuTarget = 
  | { type: "task"; task: KanbanTask }
  | { type: "project"; project: KanbanProject }
  | null;
type ContextMenuSubMenu = "status" | "priority" | "assignee" | "color" | "icon" | "border" | null;

let _contextMenu: { x: number; y: number; target: ContextMenuTarget; subMenu: ContextMenuSubMenu } | null = null;
let _quickEditField: { target: ContextMenuTarget; field: string; value: string } | null = null;

// Mobile touch state for long-press context menu
let _touchTimer: ReturnType<typeof setTimeout> | null = null;
let _touchStartPos: { x: number; y: number } | null = null;
let _isMobile = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
const LONG_PRESS_DURATION = 500; // 500ms for long press
const TOUCH_MOVE_THRESHOLD = 10; // pixels of movement allowed before canceling long press

// Icon/Emoji picker state
let _iconPickerTab: "emoji" | "icons" = "emoji";
let _iconPickerSearch: string = "";
let _iconPickerColor: string = "#a855f7"; // Default purple like Notion
let _recentEmojis: string[] = ["📋", "🎯", "🔥", "💡", "⚡", "🚀", "✨", "📁", "🏗️", "🔧"];
let _recentIcons: string[] = ["file", "target", "zap"];

// ── Color Palette (Notion-style) ──────────────────────────────────
const COLOR_PALETTE = {
  text: [
    { id: "default", label: "Default", color: "#e5e5e5" },
    { id: "gray", label: "Gray", color: "#9ca3af" },
    { id: "brown", label: "Brown", color: "#a8856c" },
    { id: "orange", label: "Orange", color: "#f97316" },
    { id: "yellow", label: "Yellow", color: "#eab308" },
    { id: "green", label: "Green", color: "#22c55e" },
    { id: "blue", label: "Blue", color: "#3b82f6" },
    { id: "purple", label: "Purple", color: "#a855f7" },
    { id: "pink", label: "Pink", color: "#ec4899" },
    { id: "red", label: "Red", color: "#ef4444" },
  ],
  background: [
    { id: "default", label: "Default", color: "transparent" },
    { id: "gray", label: "Gray", color: "rgba(156,163,175,0.15)" },
    { id: "brown", label: "Brown", color: "rgba(168,133,108,0.15)" },
    { id: "orange", label: "Orange", color: "rgba(249,115,22,0.15)" },
    { id: "yellow", label: "Yellow", color: "rgba(234,179,8,0.15)" },
    { id: "green", label: "Green", color: "rgba(34,197,94,0.15)" },
    { id: "blue", label: "Blue", color: "rgba(59,130,246,0.15)" },
    { id: "purple", label: "Purple", color: "rgba(168,85,247,0.15)" },
    { id: "pink", label: "Pink", color: "rgba(236,72,153,0.15)" },
    { id: "red", label: "Red", color: "rgba(239,68,68,0.15)" },
  ],
  iconColors: [
    "#e5e5e5", "#9ca3af", "#a8856c", "#f97316", "#eab308",
    "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#ef4444",
  ],
};

// ── Emoji Categories ──────────────────────────────────
const EMOJI_CATEGORIES: { id: string; label: string; icon: string; emojis: string[] }[] = [
  { id: "recent", label: "Recent", icon: "🕐", emojis: [] }, // Populated dynamically
  { id: "people", label: "People", icon: "😀", emojis: [
    "😀", "😃", "😄", "😁", "😅", "😂", "🤣", "😊", "😇", "🙂", "😉", "😌",
    "😍", "🥰", "😘", "😗", "😙", "😚", "😋", "😛", "😜", "🤪", "😝", "🤑",
    "🤗", "🤭", "🤫", "🤔", "🤐", "🤨", "😐", "😑", "😶", "😏", "😒", "🙄",
    "😬", "😮‍💨", "🤥", "😌", "😔", "😪", "🤤", "😴", "😷", "🤒", "🤕", "🤢",
    "🤮", "🤧", "🥵", "🥶", "🥴", "😵", "🤯", "🤠", "🥳", "🥸", "😎", "🤓",
  ]},
  { id: "nature", label: "Nature", icon: "🌿", emojis: [
    "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮",
    "🐷", "🐸", "🐵", "🐔", "🐧", "🐦", "🐤", "🦆", "🦅", "🦉", "🦇", "🐺",
    "🌸", "🌺", "🌻", "🌹", "🌷", "🌱", "🌲", "🌳", "🌴", "🌵", "🍀", "🍁",
    "🔥", "💧", "🌊", "⭐", "🌟", "✨", "⚡", "☀️", "🌙", "🌈", "☁️", "❄️",
  ]},
  { id: "food", label: "Food", icon: "🍕", emojis: [
    "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🫐", "🍈", "🍒", "🍑",
    "🥭", "🍍", "🥥", "🥝", "🍅", "🥑", "🥦", "🥬", "🥒", "🌶️", "🫑", "🌽",
    "🍕", "🍔", "🍟", "🌭", "🍿", "🧂", "🥓", "🍳", "🧇", "🥞", "🧈", "🍞",
    "☕", "🍵", "🧃", "🥤", "🍶", "🍺", "🍷", "🥂", "🍸", "🍹", "🧊", "🍰",
  ]},
  { id: "activities", label: "Activities", icon: "⚽", emojis: [
    "⚽", "🏀", "🏈", "⚾", "🥎", "🎾", "🏐", "🏉", "🥏", "🎱", "🏓", "🏸",
    "🏒", "🏑", "🥍", "🏏", "🪃", "🥅", "⛳", "🪁", "🏹", "🎣", "🤿", "🥊",
    "🎮", "🕹️", "🎲", "🧩", "♟️", "🎯", "🎳", "🎰", "🎪", "🎭", "🎨", "🎬",
    "🎤", "🎧", "🎼", "🎹", "🥁", "🎷", "🎺", "🎸", "🪕", "🎻", "🪘", "🎲",
  ]},
  { id: "travel", label: "Travel", icon: "✈️", emojis: [
    "🚗", "🚕", "🚙", "🚌", "🚎", "🏎️", "🚓", "🚑", "🚒", "🚐", "🛻", "🚚",
    "✈️", "🛫", "🛬", "🛩️", "💺", "🚀", "🛸", "🚁", "🛶", "⛵", "🚤", "🛥️",
    "🏠", "🏡", "🏢", "🏣", "🏤", "🏥", "🏦", "🏨", "🏩", "🏪", "🏫", "🏬",
    "⛪", "🕌", "🛕", "🕍", "⛩️", "🕋", "⛲", "⛺", "🌁", "🌃", "🏙️", "🌄",
  ]},
  { id: "objects", label: "Objects", icon: "💡", emojis: [
    "⌚", "📱", "💻", "⌨️", "🖥️", "🖨️", "🖱️", "🖲️", "💽", "💾", "💿", "📀",
    "📷", "📸", "📹", "🎥", "📽️", "🎞️", "📞", "☎️", "📟", "📠", "📺", "📻",
    "💡", "🔦", "🕯️", "🧯", "🛢️", "💸", "💵", "💴", "💶", "💷", "💰", "💳",
    "📦", "📫", "📪", "📬", "📭", "📮", "🗳️", "✏️", "✒️", "🖋️", "🖊️", "🖌️",
    "📁", "📂", "🗂️", "📅", "📆", "🗒️", "🗓️", "📇", "📈", "📉", "📊", "📋",
    "🔒", "🔓", "🔐", "🔑", "🗝️", "🔨", "🪓", "⛏️", "🔧", "🔩", "⚙️", "🛠️",
  ]},
  { id: "symbols", label: "Symbols", icon: "❤️", emojis: [
    "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔", "❣️", "💕",
    "💞", "💓", "💗", "💖", "💘", "💝", "💟", "☮️", "✝️", "☪️", "🕉️", "☸️",
    "✡️", "🔯", "🕎", "☯️", "☦️", "🛐", "⛎", "♈", "♉", "♊", "♋", "♌",
    "✅", "☑️", "✔️", "❌", "❎", "➕", "➖", "➗", "✖️", "💲", "💱", "™️",
    "©️", "®️", "〰️", "➰", "➿", "🔚", "🔙", "🔛", "🔝", "🔜", "✳️", "❇️",
    "‼️", "⁉️", "❓", "❔", "❕", "❗", "〽️", "⚠️", "🚸", "🔱", "⚜️", "🔰",
  ]},
  { id: "flags", label: "Flags", icon: "🏳️", emojis: [
    "🏳️", "🏴", "🏁", "🚩", "🏳️‍🌈", "🏳️‍⚧️", "🏴‍☠️", "🇺🇸", "🇬🇧", "🇨🇦", "🇦🇺", "🇯🇵",
    "🇰🇷", "🇨🇳", "🇮🇳", "🇧🇷", "🇲🇽", "🇫🇷", "🇩🇪", "🇮🇹", "🇪🇸", "🇷🇺", "🇹🇭", "🇻🇳",
  ]},
];

// ── Icon Set (Lucide-style SVG paths) ──────────────────────────────────
const ICON_SET: { id: string; label: string; path: string }[] = [
  { id: "file", label: "File", path: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6" },
  { id: "folder", label: "Folder", path: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" },
  { id: "target", label: "Target", path: "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z M12 18c3.314 0 6-2.686 6-6s-2.686-6-6-6-6 2.686-6 6 2.686 6 6 6z M12 14c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2z" },
  { id: "zap", label: "Zap", path: "M13 2L3 14h9l-1 8 10-12h-9l1-8z" },
  { id: "star", label: "Star", path: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" },
  { id: "heart", label: "Heart", path: "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" },
  { id: "check", label: "Check", path: "M20 6L9 17l-5-5" },
  { id: "x", label: "X", path: "M18 6L6 18 M6 6l12 12" },
  { id: "plus", label: "Plus", path: "M12 5v14 M5 12h14" },
  { id: "minus", label: "Minus", path: "M5 12h14" },
  { id: "settings", label: "Settings", path: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" },
  { id: "home", label: "Home", path: "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10" },
  { id: "user", label: "User", path: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" },
  { id: "users", label: "Users", path: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75" },
  { id: "mail", label: "Mail", path: "M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z M22 6l-10 7L2 6" },
  { id: "calendar", label: "Calendar", path: "M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z M16 2v4 M8 2v4 M3 10h18" },
  { id: "clock", label: "Clock", path: "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z M12 6v6l4 2" },
  { id: "search", label: "Search", path: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.35-4.35" },
  { id: "bell", label: "Bell", path: "M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 0 1-3.46 0" },
  { id: "bookmark", label: "Bookmark", path: "M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" },
  { id: "flag", label: "Flag", path: "M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z M4 22v-7" },
  { id: "archive", label: "Archive", path: "M21 8v13H3V8 M1 3h22v5H1z M10 12h4" },
  { id: "box", label: "Box", path: "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.27 6.96L12 12.01l8.73-5.05 M12 22.08V12" },
  { id: "briefcase", label: "Briefcase", path: "M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" },
  { id: "coffee", label: "Coffee", path: "M18 8h1a4 4 0 0 1 0 8h-1 M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z M6 1v3 M10 1v3 M14 1v3" },
  { id: "cpu", label: "CPU", path: "M18 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z M9 9h6v6H9z M9 1v3 M15 1v3 M9 20v3 M15 20v3 M20 9h3 M20 14h3 M1 9h3 M1 14h3" },
  { id: "database", label: "Database", path: "M12 2C6.48 2 2 3.79 2 6v12c0 2.21 4.48 4 10 4s10-1.79 10-4V6c0-2.21-4.48-4-10-4z M2 6c0 2.21 4.48 4 10 4s10-1.79 10-4 M2 12c0 2.21 4.48 4 10 4s10-1.79 10-4" },
  { id: "globe", label: "Globe", path: "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z M2 12h20 M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" },
  { id: "hash", label: "Hash", path: "M4 9h16 M4 15h16 M10 3L8 21 M16 3l-2 18" },
  { id: "key", label: "Key", path: "M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" },
  { id: "layers", label: "Layers", path: "M12 2L2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5" },
  { id: "layout", label: "Layout", path: "M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z M3 9h18 M9 21V9" },
  { id: "link", label: "Link", path: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" },
  { id: "lock", label: "Lock", path: "M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2z M7 11V7a5 5 0 0 1 10 0v4" },
  { id: "map", label: "Map", path: "M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z M8 2v16 M16 6v16" },
  { id: "message", label: "Message", path: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" },
  { id: "mic", label: "Mic", path: "M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v4 M8 23h8" },
  { id: "monitor", label: "Monitor", path: "M20 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z M8 21h8 M12 17v4" },
  { id: "music", label: "Music", path: "M9 18V5l12-2v13 M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" },
  { id: "package", label: "Package", path: "M16.5 9.4l-9-5.19 M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.27 6.96L12 12.01l8.73-5.05 M12 22.08V12" },
  { id: "paperclip", label: "Paperclip", path: "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" },
  { id: "pen", label: "Pen", path: "M12 19l7-7 3 3-7 7-3-3z M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z M2 2l7.586 7.586 M11 11a2 2 0 1 1-4 0 2 2 0 0 1 4 0z" },
  { id: "phone", label: "Phone", path: "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" },
  { id: "play", label: "Play", path: "M5 3l14 9-14 9V3z" },
  { id: "power", label: "Power", path: "M18.36 6.64a9 9 0 1 1-12.73 0 M12 2v10" },
  { id: "printer", label: "Printer", path: "M6 9V2h12v7 M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2 M6 14h12v8H6z" },
  { id: "rocket", label: "Rocket", path: "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0 M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" },
  { id: "save", label: "Save", path: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z M17 21v-8H7v8 M7 3v5h8" },
  { id: "send", label: "Send", path: "M22 2L11 13 M22 2l-7 20-4-9-9-4 20-7z" },
  { id: "server", label: "Server", path: "M20 3H4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1z M20 15H4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1z M6 7h.01 M6 19h.01" },
  { id: "shield", label: "Shield", path: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" },
  { id: "shopping-bag", label: "Shopping Bag", path: "M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z M3 6h18 M16 10a4 4 0 0 1-8 0" },
  { id: "tag", label: "Tag", path: "M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z M7 7h.01" },
  { id: "tool", label: "Tool", path: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" },
  { id: "trash", label: "Trash", path: "M3 6h18 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M10 11v6 M14 11v6" },
  { id: "truck", label: "Truck", path: "M1 3h15v13H1z M16 8h4l3 3v5h-7V8z M5.5 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M18.5 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" },
  { id: "umbrella", label: "Umbrella", path: "M23 12a11.05 11.05 0 0 0-22 0zm-5 7a3 3 0 0 1-6 0v-7" },
  { id: "video", label: "Video", path: "M23 7l-7 5 7 5V7z M14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" },
  { id: "wifi", label: "Wifi", path: "M5 12.55a11 11 0 0 1 14.08 0 M1.42 9a16 16 0 0 1 21.16 0 M8.53 16.11a6 6 0 0 1 6.95 0 M12 20h.01" },
  { id: "code", label: "Code", path: "M16 18l6-6-6-6 M8 6l-6 6 6 6" },
  { id: "terminal", label: "Terminal", path: "M4 17l6-6-6-6 M12 19h8" },
  { id: "git-branch", label: "Git Branch", path: "M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 9a9 9 0 0 1-9 9" },
  { id: "activity", label: "Activity", path: "M22 12h-4l-3 9L9 3l-3 9H2" },
  { id: "award", label: "Award", path: "M12 15a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M8.21 13.89L7 23l5-3 5 3-1.21-9.12" },
  { id: "crown", label: "Crown", path: "M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7zm3 16h14" },
];

function hslToHex(h: number, s = 70, l = 55): string {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function hexToHue(hex: string | undefined): number {
  if (!hex || !/^#?[0-9a-f]{6}$/i.test(hex)) return 0;
  const v = hex.startsWith("#") ? hex.slice(1) : hex;
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = Math.round(h * 60);
  return h < 0 ? h + 360 : h;
}

// Close context menu on outside click
if (typeof window !== "undefined") {
  window.addEventListener("click", () => {
    if (_contextMenu) {
      _contextMenu = null;
      _rerender();
    }
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _contextMenu) {
      _contextMenu = null;
      _rerender();
    }
  });
}

// ── Run Dialog State ──────────────────────────────────
let _showRunDialog = false;
let _runTargetTask: { id: string; title: string; description?: string; projectId?: string } | null = null;
let _runTargetProject: { id: string; name: string; description?: string } | null = null;
let _runForm = { agentId: "coder", cwd: "", label: "", autonomous: false };
let _runAgents: Array<{ id: string; name?: string; execution?: { mode?: string; cli?: string } }> = [];
let _runLoading = false;
let _runResult: { status: string; sessionKey?: string; runId?: string; terminalId?: string; error?: string } | null = null;

// ── Pre-flight phases (extended with precheck + approval gate) ────
type RunPhase =
  | "setup"
  | "precheck"
  | "analyzing"
  | "questions"
  | "classify"
  | "approval"
  | "ready"
  | "spawning"
  | "done";
let _runPhase: RunPhase = "setup";
type AnalysisQuestion = { id: string; label: string; type: "text" | "textarea" | "select"; required?: boolean; placeholder?: string; options?: string[] };
let _analysisResult: { ready: boolean; summary: string; questions: AnalysisQuestion[]; suggestions: string[] } | null = null;
let _analysisAnswers: Record<string, string> = {};
let _analysisError: string | null = null;

// ── GitHub repo precheck ───────────────────────────────────────────
type PrecheckResult = {
  ok: boolean;
  cwd: string;
  branch: string;
  remote: string | null;
  isGithub: boolean;
  github: { owner: string; repo: string } | null;
  defaultBranch: string;
  onDefaultBranch: boolean;
  dirtyFiles: number;
  ahead: number;
  behind: number;
  reason: string | null;
  message: string | null;
};
let _precheckResult: PrecheckResult | null = null;
let _precheckLoading = false;

// ── Criticality classifier + Telegram approval gate ───────────────
type Classification = {
  criticality: "low" | "medium" | "critical";
  reasons: string[];
  requiresApproval: boolean;
};
let _classification: Classification | null = null;
type ApprovalRecord = {
  id: string;
  status: "pending" | "approved" | "denied" | "unknown";
  decision: "approved" | "denied" | null;
  decidedBy: string | null;
  reason: string | null;
  expiresAt?: number;
};
let _approval: ApprovalRecord | null = null;
let _approvalPollTimer: number | null = null;

// ── Inline icon set (replaces emoji throughout the modal) ─────────
const RUN_ICONS = {
  settings: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  github: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.57.1.78-.25.78-.55v-1.93c-3.2.7-3.87-1.54-3.87-1.54-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.34.95.1-.74.4-1.24.73-1.53-2.55-.29-5.23-1.28-5.23-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.16 1.18.92-.26 1.9-.39 2.88-.39.98 0 1.96.13 2.88.39 2.2-1.49 3.16-1.18 3.16-1.18.62 1.58.23 2.75.11 3.04.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.06.78 2.13v3.16c0 .31.21.66.79.55 4.56-1.52 7.85-5.83 7.85-10.91C23.5 5.65 18.35.5 12 .5z"/></svg>`,
  search: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>`,
  message: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  shield: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  check: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  play: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  flag: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>`,
  alert: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  info: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  bot: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>`,
  send: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
  close: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  zap: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  loop: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
};
function _stopApprovalPolling() {
  if (_approvalPollTimer != null) {
    window.clearInterval(_approvalPollTimer);
    _approvalPollTimer = null;
  }
}

// Notion content state
export type KanbanBoardTab = "tasks" | "content" | "subpages" | "subprojects" | "files" | "notes";
let _boardTab: KanbanBoardTab = "tasks";

/**
 * Programmatic tab switch for outside callers (e.g. grid Projects panel that
 * wants to land on the "content" tab to show the block editor immediately).
 * Does not trigger network fetches — those are owned by the in-component
 * `switchTab` handler. Safe to call before the project is rendered.
 */
export function setKanbanBoardTab(tab: KanbanBoardTab): void {
  _boardTab = tab;
}
let _notionBlocks: any[] = [];
let _notionBlocksLoading = false;
let _notionSubPages: { id: string; title: string; type: string }[] = [];
let _expandedToggles = new Set<string>();
let _subPageBlocks: Record<string, any[]> = {};
let _subPageBlocksLoading: string | null = null;
let _viewingSubPageId: string | null = null;
let _viewingSubPageTitle: string | null = null;
let _notionBlocksProjectId: string | null = null; // cache key

// Project attachments (Files tab) state
type ProjectAttachmentRow = {
  id: string;
  projectId: string;
  name: string;
  path: string;
  size: number;
  mimeType?: string | null;
  createdAt: number;
};
let _attachments: ProjectAttachmentRow[] = [];
let _attachmentsLoading = false;
let _attachmentsProjectId: string | null = null; // cache key
let _attachmentsError: string | null = null;
let _attachmentUploading = false;

// Project notes state
interface ProjectNoteItem {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  category?: string;
  pinned?: boolean;
  projectId?: string;
  preview: string;
  bodyLength: number;
  updatedAt: string;
}
let _projectNotes: ProjectNoteItem[] = [];
let _projectNotesLoading = false;
let _projectNotesProjectId: string | null = null;
let _projectNotesError: string | null = null;
/** Ideas about the open project (ideas.list {projectId}; voice captures land here too). */
let _projectIdeas: Array<{ id: string; title: string; body?: string; status?: string; source?: string; tags?: string[]; projectIds?: string[]; updatedAt?: string }> = [];

// File preview modal state
type PreviewKind = "markdown" | "pdf" | "image" | "text" | "unknown";
let _preview: {
  att: ProjectAttachmentRow | null;
  kind: PreviewKind;
  loading: boolean;
  error: string | null;
  text: string | null;
  blobUrl: string | null;
  pdfTotalPages: number | null;
} = { att: null, kind: "unknown", loading: false, error: null, text: null, blobUrl: null, pdfTotalPages: null };
let _previewKeyHandler: ((e: KeyboardEvent) => void) | null = null;

// Block editor (Notion-style content editor with slash menu + live save)
let _blockEditor: BlockEditor | null = null;
let _blockEditorProjectId: string | null = null;
let _blockEditorEl: HTMLElement | null = null;

function destroyBlockEditor() {
  if (_blockEditor) {
    try { _blockEditor.destroy(); } catch { /* ignore */ }
  }
  _blockEditor = null;
  _blockEditorProjectId = null;
  _blockEditorEl = null;
}

function attachBlockEditor(el: HTMLElement | undefined, projectId: string, client: any) {
  if (!el) {
    destroyBlockEditor();
    return;
  }
  if (_blockEditor && _blockEditorProjectId === projectId && _blockEditorEl === el) return;
  destroyBlockEditor();
  if (!client?.request) return;
  // Full Google-Docs / Notion-style WYSIWYG editor. Persists to the same
  // Block[] store (kanban.projects.content.*) the legacy editor used, so
  // existing project content loads unchanged.
  _blockEditor = mountRichDocEditor(el, {
    client,
    target: { kind: "project", id: projectId },
    placeholder: "Write the project document… press / for blocks",
  }) as unknown as BlockEditor;
  _blockEditorProjectId = projectId;
  _blockEditorEl = el;
}

// ── Task document editor (mirrors the project editor, keyed by taskId) ────
let _taskDocEditor: RichDocEditor | null = null;
let _taskDocId: string | null = null;
let _taskDocEl: HTMLElement | null = null;
function destroyTaskDocEditor() {
  if (_taskDocEditor) { try { _taskDocEditor.destroy(); } catch { /* ignore */ } }
  _taskDocEditor = null; _taskDocId = null; _taskDocEl = null;
}
function attachTaskDocEditor(el: HTMLElement | undefined, taskId: string, client: any) {
  if (!el) { destroyTaskDocEditor(); return; }
  if (_taskDocEditor && _taskDocId === taskId && _taskDocEl === el) return;
  destroyTaskDocEditor();
  if (!client?.request) return;
  _taskDocEditor = mountRichDocEditor(el, {
    client,
    target: { kind: "task", id: taskId },
    placeholder: "Write this task's document… press / for blocks",
  });
  _taskDocId = taskId; _taskDocEl = el;
}
let _taskDocRefCb: ((el: Element | undefined) => void) | null = null;
let _taskDocRefKey: { taskId: string; client: any } | null = null;
function getTaskDocRefCb(taskId: string, client: any): (el: Element | undefined) => void {
  if (!_taskDocRefCb || !_taskDocRefKey || _taskDocRefKey.taskId !== taskId || _taskDocRefKey.client !== client) {
    _taskDocRefKey = { taskId, client };
    _taskDocRefCb = (el) => attachTaskDocEditor(el as HTMLElement | undefined, taskId, client);
  }
  return _taskDocRefCb;
}

// Full document page for a task, embedded in the task detail modal. Uses the
// same rich WYSIWYG editor as projects, backed by kanban.tasks.content.*.
function renderTaskDocSection(taskId: string, client: any) {
  return html`
    <div class="task-doc-section" style="margin-top:18px;">
      <div class="task-doc-head" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <span class="task-doc-title" style="font-weight:700;color:#f0e7d0;font-size:0.95rem;">📄 Document</span>
        <span class="task-doc-hint" style="font-size:11px;color:#8a8578;">type / for blocks · autosaves</span>
      </div>
      <div class="task-doc-host"
        style="height:56vh;min-height:340px;display:flex;flex-direction:column;border:1px solid rgba(212,175,74,0.2);border-radius:12px;overflow:hidden;background:rgba(10,9,8,0.4);"
        ${ref(getTaskDocRefCb(taskId, client))}
        data-task-editor="${taskId}"></div>
    </div>
  `;
}

// Memoized ref-callback. Without this we'd pass a fresh arrow into ref()
// on every parent render — lit's ref directive sees a new callback identity,
// fires the old one with `null` (which destroys the editor), then fires the
// new one with the element (remount → reload). The result is a Loading↔Ready
// bounce that pulls focus out of the contenteditable on every parent render,
// making the editor unusable. Caching by (projectId, client) keeps the
// identity stable across re-renders, so the directive only fires on actual
// project/client switches.
/* ── Project spec editor ──────────────────────────────────────────────
   A SECOND block-editor instance, bound to the document id `<projectId>::spec`.
   The store is keyed by an arbitrary string, so the spec and the freeform
   Notes below it are separate documents that cannot overwrite each other.
   The mount/ref bookkeeping is duplicated rather than generalised because the
   existing singletons are keyed by projectId alone; sharing them would make
   the two editors evict one another on every render. */
let _specEditor: BlockEditor | null = null;
let _specEditorDocId: string | null = null;
let _specEditorEl: HTMLElement | null = null;

function destroySpecEditor() {
  try {
    _specEditor?.destroy();
  } catch {
    /* already torn down */
  }
  _specEditor = null;
  _specEditorDocId = null;
  _specEditorEl = null;
}

function attachSpecEditor(el: HTMLElement | undefined, projectId: string, client: any) {
  if (!el) {
    destroySpecEditor();
    return;
  }
  const docId = specDocId(projectId);
  if (_specEditor && _specEditorDocId === docId && _specEditorEl === el) return;
  destroySpecEditor();
  if (!client?.request) return;
  _specEditor = mountBlockEditor(el, {
    client,
    projectId: docId,
    placeholder: "Deliverables, to-dos, acceptance criteria… type / for commands",
  });
  _specEditorDocId = docId;
  _specEditorEl = el;
}

let _specEditorRefCb: ((el: Element | undefined) => void) | null = null;
let _specEditorRefKey: { projectId: string; client: any } | null = null;
/** Memoized for the same reason as the notes editor — see below. */
function getSpecEditorRefCb(projectId: string, client: any): (el: Element | undefined) => void {
  if (
    !_specEditorRefCb ||
    !_specEditorRefKey ||
    _specEditorRefKey.projectId !== projectId ||
    _specEditorRefKey.client !== client
  ) {
    _specEditorRefKey = { projectId, client };
    _specEditorRefCb = (el?: Element) => attachSpecEditor(el as HTMLElement | undefined, projectId, client);
  }
  return _specEditorRefCb;
}

let _blockEditorRefCb: ((el: Element | undefined) => void) | null = null;
let _blockEditorRefKey: { projectId: string; client: any } | null = null;
function getBlockEditorRefCb(projectId: string, client: any): (el: Element | undefined) => void {
  if (
    !_blockEditorRefCb ||
    !_blockEditorRefKey ||
    _blockEditorRefKey.projectId !== projectId ||
    _blockEditorRefKey.client !== client
  ) {
    _blockEditorRefKey = { projectId, client };
    _blockEditorRefCb = (el) => attachBlockEditor(el as HTMLElement | undefined, projectId, client);
  }
  return _blockEditorRefCb;
}
let _currentRequestUpdate: (() => void) | null = null;

// Scroll position preservation
let _savedScrollPositions: Map<string, { top: number; left: number }> = new Map();
// Timestamp of the user's last scroll *intent*. A background re-render (e.g. the
// 30s subagent poll) must never write scrollTop back under an actively scrolling
// finger/wheel — that fight is what made the board feel glitchy.
let _lastUserScrollAt = 0;
let _userScrollListenerInstalled = false;
function _installUserScrollListener() {
  if (_userScrollListenerInstalled || typeof document === "undefined") return;
  _userScrollListenerInstalled = true;
  const stamp = () => { _lastUserScrollAt = Date.now(); };
  // Passive + capture: records intent without adding any scroll-handler jank.
  document.addEventListener("wheel", stamp, { passive: true, capture: true });
  document.addEventListener("touchmove", stamp, { passive: true, capture: true });
  document.addEventListener("scroll", stamp, { passive: true, capture: true });
}

function _saveScrollPositions() {
  _savedScrollPositions.clear();
  
  // Board-level horizontal scroll
  const boardContainers = [".gt-board", ".kanban-board", ".pk-board", ".gallery-grid"];
  for (const selector of boardContainers) {
    const el = document.querySelector(selector) as HTMLElement;
    if (el) {
      _savedScrollPositions.set(selector, { top: el.scrollTop, left: el.scrollLeft });
    }
  }
  
  // Column-level vertical scroll (each column scrolls independently)
  const columnContents = document.querySelectorAll(".gt-column-content, .kanban-column-content, .pk-column-content");
  columnContents.forEach((el, idx) => {
    const htmlEl = el as HTMLElement;
    if (htmlEl.scrollTop > 0 || htmlEl.scrollLeft > 0) {
      _savedScrollPositions.set(`column-${idx}`, { top: htmlEl.scrollTop, left: htmlEl.scrollLeft });
    }
  });
}

function _restoreScrollPositions() {
  // Don't clobber an active user scroll. The scroll container element is stable
  // across child re-renders, so the browser already preserves scrollTop for us;
  // the manual restore is only needed when the container itself was rebuilt.
  if (Date.now() - _lastUserScrollAt < 500) return;
  requestAnimationFrame(() => {
    // Only write when the value actually differs — a redundant scrollTop assign
    // still triggers a scroll event + reflow, which is pure jank.
    const apply = (el: HTMLElement | null, pos: { top: number; left: number }) => {
      if (!el) return;
      if (el.scrollTop !== pos.top) el.scrollTop = pos.top;
      if (el.scrollLeft !== pos.left) el.scrollLeft = pos.left;
    };
    // Restore board-level scroll
    const boardContainers = [".gt-board", ".kanban-board", ".pk-board", ".gallery-grid"];
    for (const selector of boardContainers) {
      const pos = _savedScrollPositions.get(selector);
      if (pos) apply(document.querySelector(selector) as HTMLElement, pos);
    }

    // Restore column-level scroll
    const columnContents = document.querySelectorAll(".gt-column-content, .kanban-column-content, .pk-column-content");
    columnContents.forEach((el, idx) => {
      const pos = _savedScrollPositions.get(`column-${idx}`);
      if (pos) apply(el as HTMLElement, pos);
    });
  });
}

function _rerender() {
  _installUserScrollListener();
  // Skip the scroll-save/restore round-trip while a drag is active.
  // Columns can't be scrolled during drag, so reading scrollTop is pure
  // forced-layout thrash that contributes to drag lag.
  if (!_kanbanActiveDrag) _saveScrollPositions();
  document.dispatchEvent(new CustomEvent("kanban-state-change"));
  _currentRequestUpdate?.();
  if (!_kanbanActiveDrag) _restoreScrollPositions();
}

// ── Context Menu Functions ──────────────────────────────────
let _subMenuHideTimeout: ReturnType<typeof setTimeout> | null = null;
let _subMenuDirection: "right" | "left" = "right";

function openContextMenu(e: MouseEvent, target: ContextMenuTarget, requestUpdate?: () => void) {
  e.preventDefault();
  e.stopPropagation();
  
  // Clear any pending hide timeout
  if (_subMenuHideTimeout) {
    clearTimeout(_subMenuHideTimeout);
    _subMenuHideTimeout = null;
  }
  
  // Calculate position, keeping menu in viewport
  const menuWidth = 220;
  const menuHeight = 400;
  const submenuWidth = 320;
  
  let x = e.clientX;
  let y = e.clientY;
  
  // Adjust horizontal position
  if (x + menuWidth > window.innerWidth) {
    x = window.innerWidth - menuWidth - 10;
  }
  
  // Determine submenu direction based on available space
  _subMenuDirection = (x + menuWidth + submenuWidth + 20) < window.innerWidth ? "right" : "left";
  
  // Adjust vertical position
  if (y + menuHeight > window.innerHeight) {
    y = Math.max(10, window.innerHeight - menuHeight - 10);
  }
  
  _contextMenu = { x, y, target, subMenu: null };
  
  // Use direct requestUpdate if available, fallback to _rerender
  if (requestUpdate) {
    requestUpdate();
  } else {
    _rerender();
  }
}

function showSubMenu(subMenu: ContextMenuSubMenu, rerender: () => void) {
  if (_subMenuHideTimeout) {
    clearTimeout(_subMenuHideTimeout);
    _subMenuHideTimeout = null;
  }
  if (_contextMenu) {
    _contextMenu.subMenu = subMenu;
    rerender();
  }
}

function hideSubMenuDelayed(currentSubMenu: ContextMenuSubMenu, rerender: () => void) {
  // Only hide if still on the same submenu after a delay
  _subMenuHideTimeout = setTimeout(() => {
    if (_contextMenu && _contextMenu.subMenu === currentSubMenu) {
      _contextMenu.subMenu = null;
      rerender();
    }
  }, 150); // 150ms delay gives user time to move to submenu
}

function cancelSubMenuHide() {
  if (_subMenuHideTimeout) {
    clearTimeout(_subMenuHideTimeout);
    _subMenuHideTimeout = null;
  }
}

// ── Touch Event Handlers for Mobile Long-Press ──────────────────────────────────
function handleTouchStart(e: TouchEvent, target: ContextMenuTarget, requestUpdate?: () => void) {
  if (e.touches.length !== 1) return;
  
  const touch = e.touches[0];
  _touchStartPos = { x: touch.clientX, y: touch.clientY };
  
  _touchTimer = setTimeout(() => {
    if (_touchStartPos) {
      // Vibrate on supported devices
      if (navigator.vibrate) navigator.vibrate(50);
      
      // Calculate position for context menu
      const x = Math.min(_touchStartPos.x, window.innerWidth - 220);
      const y = Math.min(_touchStartPos.y, window.innerHeight - 400);
      
      // Determine submenu direction
      _subMenuDirection = (x + 220 + 320 + 20) < window.innerWidth ? "right" : "left";
      
      _contextMenu = { x, y, target, subMenu: null };
      
      if (requestUpdate) {
        requestUpdate();
      } else {
        _rerender();
      }
    }
    _touchTimer = null;
    _touchStartPos = null;
  }, LONG_PRESS_DURATION);
}

function handleTouchMove(e: TouchEvent) {
  if (!_touchTimer || !_touchStartPos) return;
  
  const touch = e.touches[0];
  const dx = Math.abs(touch.clientX - _touchStartPos.x);
  const dy = Math.abs(touch.clientY - _touchStartPos.y);
  
  // Cancel long press if moved too much
  if (dx > TOUCH_MOVE_THRESHOLD || dy > TOUCH_MOVE_THRESHOLD) {
    clearTimeout(_touchTimer);
    _touchTimer = null;
    _touchStartPos = null;
  }
}

function handleTouchEnd() {
  if (_touchTimer) {
    clearTimeout(_touchTimer);
    _touchTimer = null;
  }
  _touchStartPos = null;
}

function renderContextMenu(props: KanbanViewProps) {
  if (!_contextMenu || !_contextMenu.target) return nothing;
  
  const { x, y, target, subMenu } = _contextMenu;
  const isTask = target.type === "task";
  
  // Local rerender that uses props directly
  const rerender = () => {
    if (props.onRequestUpdate) {
      props.onRequestUpdate();
    } else {
      _rerender();
    }
  };
  const item = isTask ? (target as { type: "task"; task: KanbanTask }).task : (target as { type: "project"; project: KanbanProject }).project;
  
  // Status options based on type
  const taskStatuses: { id: TaskStatus; label: string; icon: string }[] = [
    { id: "backlog", label: "Backlog", icon: "📥" },
    { id: "todo", label: "To Do", icon: "📋" },
    { id: "in_progress", label: "In Progress", icon: "🔄" },
    { id: "review", label: "Review", icon: "👁" },
    { id: "done", label: "Done", icon: "✅" },
  ];
  
  const projectStatuses: { id: string; label: string; icon: string }[] = [
    { id: "Not started", label: "Not Started", icon: "○" },
    { id: "In progress", label: "In Progress", icon: "●" },
    { id: "Reviewing", label: "Reviewing", icon: "👁" },
    { id: "Awaiting Client", label: "Awaiting Client", icon: "⏳" },
    { id: "Paused", label: "Paused", icon: "⏸" },
    { id: "Completed", label: "Completed", icon: "✓" },
    { id: "Cancelled", label: "Cancelled", icon: "✕" },
  ];
  
  const priorities: { id: string; label: string; icon: string }[] = [
    { id: "critical", label: "Critical", icon: "🔴" },
    { id: "high", label: "High", icon: "🟠" },
    { id: "medium", label: "Medium", icon: "🔵" },
    { id: "low", label: "Low", icon: "🟢" },
  ];
  
  // Collect available assignees from all tasks
  const assignees = new Set<string>();
  props.tasks.forEach(t => { if (t.assignee) assignees.add(t.assignee); });
  
  const currentStatus = isTask ? (item as KanbanTask).status : (item as KanbanProject).status;
  const currentPriority = isTask 
    ? ((item as KanbanTask).priorityLevel || (item as KanbanTask).priority || "medium")
    : ((item as KanbanProject).priority || "Medium");
  const currentAssignee = isTask ? (item as KanbanTask).assignee : null;
  const notionId = isTask ? (item as KanbanTask).notionId : (item as KanbanProject).notionId;
  
  const handleStatusChange = (newStatus: string) => {
    if (isTask) {
      props.onUpdateTask((item as KanbanTask).id, { status: newStatus as TaskStatus });
    } else {
      props.onUpdateProject((item as KanbanProject).id, { status: newStatus as any });
    }
    _contextMenu = null;
    rerender();
  };
  
  const handlePriorityChange = (newPriority: string) => {
    if (isTask) {
      // Map to proper format
      const priMap: Record<string, string> = { critical: "Immediate", high: "High", medium: "Medium", low: "Low" };
      props.onUpdateTask((item as KanbanTask).id, { priority: newPriority as any, priorityLevel: priMap[newPriority] as PriorityLevel });
    } else {
      const priMap: Record<string, string> = { critical: "Immediate", high: "High", medium: "Medium", low: "Low" };
      props.onUpdateProject((item as KanbanProject).id, { priority: priMap[newPriority] as any });
    }
    _contextMenu = null;
    rerender();
  };
  
  const handleAssigneeChange = (assignee: string) => {
    if (isTask) {
      props.onUpdateTask((item as KanbanTask).id, { assignee: assignee || undefined } as any);
    }
    _contextMenu = null;
    rerender();
  };
  
  const handleDelete = () => {
    const name = isTask ? (item as KanbanTask).title : (item as KanbanProject).name;
    if (confirm(`Delete "${name}"?`)) {
      if (isTask) {
        props.onDeleteTask((item as KanbanTask).id);
      } else {
        props.onDeleteProject((item as KanbanProject).id);
      }
    }
    _contextMenu = null;
    rerender();
  };
  
  const handleEdit = () => {
    if (isTask) {
      _taskDetailId = (item as KanbanTask).id;
    } else {
      props.onEnterProject((item as KanbanProject).id);
    }
    _contextMenu = null;
    rerender();
  };
  
  const handleRunWithAgent = () => {
    if (isTask) {
      const task = item as KanbanTask;
      openRunDialog(props.client, { task: { id: task.id, title: task.title, description: task.description, projectId: task.projectId } });
    } else {
      const project = item as KanbanProject;
      openRunDialog(props.client, { project: { id: project.id, name: project.name, description: project.description } });
    }
    _contextMenu = null;
    rerender();
  };
  
  const handleAssignParent = () => {
    openParentPicker((item as KanbanProject).id);
    _contextMenu = null;
    rerender();
  };

  const handleClearParent = () => {
    // Optimistic update reflects instantly; we deliberately do NOT call
    // onRefresh here — a refresh round-trips the Notion-backed list which can
    // lag the relation write and momentarily re-show the cleared parent. The
    // existing background poll reconciles with the server.
    props.onUpdateProject((item as KanbanProject).id, { parentProjectId: null });
    kanbanToast("Parent removed");
    _contextMenu = null;
    rerender();
  };

  const handleOpenNotion = () => {
    if (notionId) {
      window.open(`https://notion.so/${notionId.replace(/-/g, '')}`, '_blank');
    }
    _contextMenu = null;
    rerender();
  };
  
  // Get current styles
  const currentIcon = isTask ? (item as any).customIcon : (item as any).customIcon;
  const currentTextColor = isTask ? (item as any).textColor : (item as any).textColor;
  const currentBgColor = isTask ? (item as any).bgColor : (item as any).bgColor;
  const currentIconColor = isTask ? (item as any).iconColor : (item as any).iconColor;
  
  // Style handlers
  const handleStyleChange = (style: Partial<{ customIcon?: string; textColor?: string; bgColor?: string; iconColor?: string }>) => {
    if (isTask) {
      props.onUpdateTask((item as KanbanTask).id, style as any);
    } else {
      props.onUpdateProject((item as KanbanProject).id, style as any);
    }
    rerender();
  };
  
  const handleRemoveIcon = () => {
    handleStyleChange({ customIcon: undefined });
    _contextMenu = null;
    rerender();
  };
  
  const handleSelectEmoji = (emoji: string) => {
    // Add to recent
    if (!_recentEmojis.includes(emoji)) {
      _recentEmojis = [emoji, ..._recentEmojis.slice(0, 9)];
    }
    handleStyleChange({ customIcon: emoji });
    _contextMenu = null;
    rerender();
  };
  
  const handleSelectIcon = (iconId: string) => {
    // Add to recent
    if (!_recentIcons.includes(iconId)) {
      _recentIcons = [iconId, ..._recentIcons.slice(0, 9)];
    }
    handleStyleChange({ customIcon: `icon:${iconId}`, iconColor: _iconPickerColor });
    _contextMenu = null;
    rerender();
  };
  
  const handleRandomEmoji = () => {
    const allEmojis = EMOJI_CATEGORIES.flatMap(c => c.emojis);
    const random = allEmojis[Math.floor(Math.random() * allEmojis.length)];
    handleSelectEmoji(random);
  };
  
  // Filter emojis/icons by search
  const filterEmojis = (emojis: string[]) => {
    if (!_iconPickerSearch) return emojis;
    // Simple filter - in real implementation would need emoji metadata
    return emojis;
  };
  
  const filterIcons = (icons: typeof ICON_SET) => {
    if (!_iconPickerSearch) return icons;
    const q = _iconPickerSearch.toLowerCase();
    return icons.filter(i => i.label.toLowerCase().includes(q) || i.id.includes(q));
  };
  
  // Submenu position helper
  const getSubMenuStyle = (offsetTop: number = 0) => {
    if (_subMenuDirection === "left") {
      return `right: 100%; left: auto; margin-right: 4px; margin-left: 0; top: ${offsetTop}px`;
    }
    return `left: 100%; right: auto; margin-left: 4px; margin-right: 0; top: ${offsetTop}px`;
  };
  
  // Render submenu
  const renderSubMenu = () => {
    if (subMenu === "status") {
      const options = isTask ? taskStatuses : projectStatuses;
      return html`
        <div class="ctx-submenu ctx-submenu--${_subMenuDirection}" style="${getSubMenuStyle(-6)}"
          @mouseenter=${cancelSubMenuHide}
          @mouseleave=${() => hideSubMenuDelayed("status", rerender)}>
          ${options.map(opt => html`
            <div class="ctx-item ${currentStatus === opt.id ? 'ctx-item--active' : ''}"
              @click=${(e: Event) => { e.stopPropagation(); handleStatusChange(opt.id); }}>
              <span class="ctx-icon">${opt.icon}</span>
              <span>${opt.label}</span>
              ${currentStatus === opt.id ? html`<span class="ctx-check">✓</span>` : nothing}
            </div>
          `)}
        </div>
      `;
    }
    
    if (subMenu === "priority") {
      return html`
        <div class="ctx-submenu ctx-submenu--${_subMenuDirection}" style="${getSubMenuStyle(-6)}"
          @mouseenter=${cancelSubMenuHide}
          @mouseleave=${() => hideSubMenuDelayed("priority", rerender)}>
          ${priorities.map(opt => html`
            <div class="ctx-item ${currentPriority.toLowerCase() === opt.id ? 'ctx-item--active' : ''}"
              @click=${(e: Event) => { e.stopPropagation(); handlePriorityChange(opt.id); }}>
              <span class="ctx-icon">${opt.icon}</span>
              <span>${opt.label}</span>
              ${currentPriority.toLowerCase() === opt.id ? html`<span class="ctx-check">✓</span>` : nothing}
            </div>
          `)}
        </div>
      `;
    }
    
    if (subMenu === "assignee" && isTask) {
      return html`
        <div class="ctx-submenu ctx-submenu--${_subMenuDirection}" style="${getSubMenuStyle(-6)}"
          @mouseenter=${cancelSubMenuHide}
          @mouseleave=${() => hideSubMenuDelayed("assignee", rerender)}>
          <div class="ctx-item ${!currentAssignee ? 'ctx-item--active' : ''}"
            @click=${(e: Event) => { e.stopPropagation(); handleAssigneeChange(''); }}>
            <span class="ctx-icon">${icons.person}</span>
            <span>Unassigned</span>
            ${!currentAssignee ? html`<span class="ctx-check">✓</span>` : nothing}
          </div>
          ${[...assignees].sort().map(a => html`
            <div class="ctx-item ${currentAssignee === a ? 'ctx-item--active' : ''}"
              @click=${(e: Event) => { e.stopPropagation(); handleAssigneeChange(a); }}>
              <span class="ctx-icon">${icons.person}</span>
              <span>${a}</span>
              ${currentAssignee === a ? html`<span class="ctx-check">✓</span>` : nothing}
            </div>
          `)}
          <div class="ctx-divider"></div>
          <div class="ctx-item"
            @click=${(e: Event) => { 
              e.stopPropagation();
              const name = prompt("Enter new assignee name:");
              if (name?.trim()) handleAssigneeChange(name.trim());
            }}>
            <span class="ctx-icon">${icons.plus}</span>
            <span>Add New...</span>
          </div>
        </div>
      `;
    }
    
    // ── Color Picker Submenu ──────────────────────────────────
    if (subMenu === "color") {
      const currentAccent = (currentIconColor as string | undefined) || "#a855f7";
      const currentHue = hexToHue(currentAccent);
      return html`
        <div class="ctx-submenu ctx-submenu--wide ctx-submenu--${_subMenuDirection}" style="${getSubMenuStyle(-6)}"
          @mouseenter=${cancelSubMenuHide}
          @mouseleave=${() => hideSubMenuDelayed("color", rerender)}
          @click=${(e: Event) => e.stopPropagation()}>
          <div class="ctx-color-section">
            <div class="ctx-color-label">Custom accent</div>
            <div class="ctx-color-custom">
              <input type="color" class="ctx-color-input"
                .value=${currentAccent}
                @input=${(e: Event) => handleStyleChange({ iconColor: (e.target as HTMLInputElement).value })} />
              <input type="range" class="ctx-color-hue" min="0" max="360" step="1"
                .value=${String(currentHue)}
                style="background: linear-gradient(to right, hsl(0,70%,55%), hsl(60,70%,55%), hsl(120,70%,55%), hsl(180,70%,55%), hsl(240,70%,55%), hsl(300,70%,55%), hsl(360,70%,55%));"
                @input=${(e: Event) => handleStyleChange({ iconColor: hslToHex(parseInt((e.target as HTMLInputElement).value, 10)) })} />
              <button class="ctx-color-clear" title="Reset"
                @click=${() => handleStyleChange({ iconColor: undefined })}>×</button>
            </div>
          </div>
          <div class="ctx-divider"></div>
          <div class="ctx-color-section">
            <div class="ctx-color-label">Text color</div>
            <div class="ctx-color-grid">
              ${COLOR_PALETTE.text.map(c => html`
                <div class="ctx-color-item ${currentTextColor === c.id ? 'ctx-color-item--active' : ''}"
                  @click=${() => { handleStyleChange({ textColor: c.id === 'default' ? undefined : c.id }); }}>
                  <span class="ctx-color-swatch ctx-color-swatch--text" style="color: ${c.color}">A</span>
                  <span>${c.label}</span>
                </div>
              `)}
            </div>
          </div>
          <div class="ctx-divider"></div>
          <div class="ctx-color-section">
            <div class="ctx-color-label">Background color</div>
            <div class="ctx-color-grid">
              ${COLOR_PALETTE.background.map(c => html`
                <div class="ctx-color-item ${currentBgColor === c.id ? 'ctx-color-item--active' : ''}"
                  @click=${() => { handleStyleChange({ bgColor: c.id === 'default' ? undefined : c.id }); }}>
                  <span class="ctx-color-swatch ctx-color-swatch--bg" style="background: ${c.color}"></span>
                  <span>${c.label}</span>
                </div>
              `)}
            </div>
          </div>
        </div>
      `;
    }

    // ── Border Submenu ──────────────────────────────────
    if (subMenu === "border") {
      const proj = (item as KanbanProject);
      const tsk = (item as KanbanTask);
      const currentBorderColor = (isTask ? (tsk as any).borderColor : proj.borderColor) || (currentIconColor as string | undefined) || "#a855f7";
      const currentBorderWidth = isTask ? ((tsk as any).borderWidth ?? 0) : (proj.borderWidth ?? 0);
      const currentBorderStyle = (isTask ? (tsk as any).borderStyle : proj.borderStyle) || "solid";
      const styleOptions: Array<"solid" | "dashed" | "dotted"> = ["solid", "dashed", "dotted"];
      return html`
        <div class="ctx-submenu ctx-submenu--wide ctx-submenu--${_subMenuDirection}" style="${getSubMenuStyle(-6)}"
          @mouseenter=${cancelSubMenuHide}
          @mouseleave=${() => hideSubMenuDelayed("border", rerender)}
          @click=${(e: Event) => e.stopPropagation()}>
          <div class="ctx-color-section">
            <div class="ctx-color-label">Border color</div>
            <div class="ctx-color-custom">
              <input type="color" class="ctx-color-input"
                .value=${currentBorderColor}
                @input=${(e: Event) => handleStyleChange({ borderColor: (e.target as HTMLInputElement).value } as any)} />
              <button class="ctx-color-clear" title="Use accent"
                @click=${() => handleStyleChange({ borderColor: undefined } as any)}>↺</button>
            </div>
          </div>
          <div class="ctx-divider"></div>
          <div class="ctx-color-section">
            <div class="ctx-color-label">Width: ${currentBorderWidth}px</div>
            <input type="range" class="ctx-border-width" min="0" max="6" step="1"
              .value=${String(currentBorderWidth)}
              @input=${(e: Event) => handleStyleChange({ borderWidth: parseInt((e.target as HTMLInputElement).value, 10) } as any)} />
          </div>
          <div class="ctx-divider"></div>
          <div class="ctx-color-section">
            <div class="ctx-color-label">Style</div>
            <div class="ctx-border-styles">
              ${styleOptions.map(s => html`
                <button class="ctx-border-style-btn ${currentBorderStyle === s ? 'ctx-border-style-btn--active' : ''}"
                  @click=${() => handleStyleChange({ borderStyle: s } as any)}>
                  <span class="ctx-border-preview" style="border-top: 2px ${s} currentColor;"></span>
                  <span>${s}</span>
                </button>
              `)}
            </div>
          </div>
        </div>
      `;
    }
    
    // ── Icon/Emoji Picker Submenu ──────────────────────────────────
    if (subMenu === "icon") {
      const filteredIcons = filterIcons(ICON_SET);
      
      return html`
        <div class="ctx-submenu ctx-submenu--picker ctx-submenu--${_subMenuDirection}" style="${getSubMenuStyle(-6)}"
          @mouseenter=${cancelSubMenuHide}
          @mouseleave=${() => hideSubMenuDelayed("icon", rerender)}
          @click=${(e: Event) => e.stopPropagation()}>
          <!-- Tabs -->
          <div class="ctx-picker-tabs">
            <button class="ctx-picker-tab ${_iconPickerTab === 'emoji' ? 'ctx-picker-tab--active' : ''}"
              @click=${() => { _iconPickerTab = 'emoji'; rerender(); }}>Emoji</button>
            <button class="ctx-picker-tab ${_iconPickerTab === 'icons' ? 'ctx-picker-tab--active' : ''}"
              @click=${() => { _iconPickerTab = 'icons'; rerender(); }}>Icons</button>
            <button class="ctx-picker-remove" @click=${handleRemoveIcon}>Remove</button>
          </div>
          
          <!-- Search -->
          <div class="ctx-picker-search">
            <input type="text" placeholder="Filter..." 
              .value=${_iconPickerSearch}
              @input=${(e: Event) => { _iconPickerSearch = (e.target as HTMLInputElement).value; rerender(); }}
              @click=${(e: Event) => e.stopPropagation()} />
            <button class="ctx-picker-random" @click=${handleRandomEmoji} title="Random">${icons.sparkles}</button>
            ${_iconPickerTab === 'icons' ? html`
              <input type="color" class="ctx-picker-color" 
                .value=${_iconPickerColor}
                @input=${(e: Event) => { _iconPickerColor = (e.target as HTMLInputElement).value; rerender(); }}
                @click=${(e: Event) => e.stopPropagation()}
                title="Icon color" />
            ` : nothing}
          </div>
          
          <!-- Content -->
          <div class="ctx-picker-content">
            ${_iconPickerTab === 'emoji' ? html`
              <!-- Recent -->
              ${_recentEmojis.length > 0 ? html`
                <div class="ctx-picker-section">
                  <div class="ctx-picker-section-label">Recent</div>
                  <div class="ctx-picker-grid ctx-picker-grid--emoji">
                    ${_recentEmojis.map(e => html`
                      <button class="ctx-picker-emoji ${currentIcon === e ? 'ctx-picker-emoji--active' : ''}"
                        @click=${() => handleSelectEmoji(e)}>${e}</button>
                    `)}
                  </div>
                </div>
              ` : nothing}
              
              <!-- Categories -->
              ${EMOJI_CATEGORIES.filter(c => c.id !== 'recent').map(cat => html`
                <div class="ctx-picker-section">
                  <div class="ctx-picker-section-label">${cat.label}</div>
                  <div class="ctx-picker-grid ctx-picker-grid--emoji">
                    ${filterEmojis(cat.emojis).map(e => html`
                      <button class="ctx-picker-emoji ${currentIcon === e ? 'ctx-picker-emoji--active' : ''}"
                        @click=${() => handleSelectEmoji(e)}>${e}</button>
                    `)}
                  </div>
                </div>
              `)}
            ` : html`
              <!-- Icon Color Palette -->
              <div class="ctx-picker-section">
                <div class="ctx-picker-color-row">
                  ${COLOR_PALETTE.iconColors.map(c => html`
                    <button class="ctx-picker-color-btn ${_iconPickerColor === c ? 'ctx-picker-color-btn--active' : ''}"
                      style="background: ${c}"
                      @click=${() => { _iconPickerColor = c; rerender(); }}></button>
                  `)}
                </div>
              </div>
              
              <!-- Recent Icons -->
              ${_recentIcons.length > 0 ? html`
                <div class="ctx-picker-section">
                  <div class="ctx-picker-section-label">Recent</div>
                  <div class="ctx-picker-grid ctx-picker-grid--icon">
                    ${_recentIcons.map(iconId => {
                      const icon = ICON_SET.find(i => i.id === iconId);
                      if (!icon) return nothing;
                      return html`
                        <button class="ctx-picker-icon ${currentIcon === 'icon:' + iconId ? 'ctx-picker-icon--active' : ''}"
                          style="color: ${_iconPickerColor}"
                          @click=${() => handleSelectIcon(iconId)}
                          title="${icon.label}">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="${icon.path}"/>
                          </svg>
                        </button>
                      `;
                    })}
                  </div>
                </div>
              ` : nothing}
              
              <!-- All Icons -->
              <div class="ctx-picker-section">
                <div class="ctx-picker-section-label">Icons</div>
                <div class="ctx-picker-grid ctx-picker-grid--icon">
                  ${filteredIcons.map(icon => html`
                    <button class="ctx-picker-icon ${currentIcon === 'icon:' + icon.id ? 'ctx-picker-icon--active' : ''}"
                      style="color: ${_iconPickerColor}"
                      @click=${() => handleSelectIcon(icon.id)}
                      title="${icon.label}">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="${icon.path}"/>
                      </svg>
                    </button>
                  `)}
                </div>
              </div>
            `}
          </div>
        </div>
      `;
    }
    
    return nothing;
  };
  
  return html`
    <div class="ctx-backdrop" @click=${() => { _contextMenu = null; rerender(); }}></div>
    <div class="ctx-menu" style="left: ${x}px; top: ${y}px" @click=${(e: Event) => e.stopPropagation()}>
      <div class="ctx-header">
        <span class="ctx-header-icon">${isTask ? icons.fileText : icons.folder}</span>
        <span class="ctx-header-title">${isTask ? (item as KanbanTask).title : (item as KanbanProject).name}</span>
      </div>
      <div class="ctx-divider"></div>
      
      <!-- Quick Edit Section -->
      <div class="ctx-item ctx-item--submenu ${subMenu === 'status' ? 'ctx-item--submenu-open' : ''}"
        @mouseenter=${() => showSubMenu("status", rerender)}
        @mouseleave=${() => hideSubMenuDelayed("status", rerender)}>
        <span class="ctx-icon">◉</span>
        <span>Status</span>
        <span class="ctx-arrow">${_subMenuDirection === 'left' ? '‹' : '›'}</span>
        ${subMenu === "status" ? renderSubMenu() : nothing}
      </div>
      
      <div class="ctx-item ctx-item--submenu ${subMenu === 'priority' ? 'ctx-item--submenu-open' : ''}"
        @mouseenter=${() => showSubMenu("priority", rerender)}
        @mouseleave=${() => hideSubMenuDelayed("priority", rerender)}>
        <span class="ctx-icon">${icons.target}</span>
        <span>Priority</span>
        <span class="ctx-arrow">${_subMenuDirection === 'left' ? '‹' : '›'}</span>
        ${subMenu === "priority" ? renderSubMenu() : nothing}
      </div>
      
      ${isTask ? html`
        <div class="ctx-item ctx-item--submenu ${subMenu === 'assignee' ? 'ctx-item--submenu-open' : ''}"
          @mouseenter=${() => showSubMenu("assignee", rerender)}
          @mouseleave=${() => hideSubMenuDelayed("assignee", rerender)}>
          <span class="ctx-icon">${icons.person}</span>
          <span>Assignee</span>
          <span class="ctx-arrow">${_subMenuDirection === 'left' ? '‹' : '›'}</span>
          ${subMenu === "assignee" ? renderSubMenu() : nothing}
        </div>
      ` : nothing}
      
      <div class="ctx-divider"></div>
      
      <!-- Styling Section -->
      <div class="ctx-item ctx-item--submenu ${subMenu === 'color' ? 'ctx-item--submenu-open' : ''}"
        @mouseenter=${() => showSubMenu("color", rerender)}
        @mouseleave=${() => hideSubMenuDelayed("color", rerender)}>
        <span class="ctx-icon">${icons.palette}</span>
        <span>Color</span>
        <span class="ctx-arrow">${_subMenuDirection === 'left' ? '‹' : '›'}</span>
        ${subMenu === "color" ? renderSubMenu() : nothing}
      </div>
      
      <div class="ctx-item ctx-item--submenu ${subMenu === 'icon' ? 'ctx-item--submenu-open' : ''}"
        @mouseenter=${() => { _iconPickerSearch = ""; showSubMenu("icon", rerender); }}
        @mouseleave=${() => hideSubMenuDelayed("icon", rerender)}>
        <span class="ctx-icon">${currentIcon && !currentIcon.startsWith('icon:') ? currentIcon : '😀'}</span>
        <span>Edit icon</span>
        <span class="ctx-arrow">${_subMenuDirection === 'left' ? '‹' : '›'}</span>
        ${subMenu === "icon" ? renderSubMenu() : nothing}
      </div>

      <div class="ctx-item ctx-item--submenu ${subMenu === 'border' ? 'ctx-item--submenu-open' : ''}"
        @mouseenter=${() => showSubMenu("border", rerender)}
        @mouseleave=${() => hideSubMenuDelayed("border", rerender)}>
        <span class="ctx-icon">▢</span>
        <span>Border</span>
        <span class="ctx-arrow">${_subMenuDirection === 'left' ? '‹' : '›'}</span>
        ${subMenu === "border" ? renderSubMenu() : nothing}
      </div>

      <div class="ctx-divider"></div>
      
      <!-- Actions -->
      <div class="ctx-item" @click=${handleEdit}>
        <span class="ctx-icon">${icons.penLine}</span>
        <span>${isTask ? 'Edit Task' : 'Open Project'}</span>
      </div>
      
      <div class="ctx-item ctx-item--run" @click=${handleRunWithAgent}>
        <span class="ctx-icon">▶</span>
        <span>Run with Agent</span>
      </div>

      ${!isTask ? html`
        <div class="ctx-item" @click=${handleAssignParent}>
          <span class="ctx-icon">⤷</span>
          <span>Assign parent project…</span>
        </div>
        ${(item as KanbanProject).parentProjectId ? html`
          <div class="ctx-item" @click=${handleClearParent}>
            <span class="ctx-icon">⤴</span>
            <span>Remove parent</span>
          </div>
        ` : nothing}
      ` : nothing}

      ${notionId ? html`
        <div class="ctx-item" @click=${handleOpenNotion}>
          <span class="ctx-icon">${icons.fileText}</span>
          <span>Open in Notion</span>
          <span class="ctx-badge">↗</span>
        </div>
      ` : html`
        <div class="ctx-item ctx-item--disabled">
          <span class="ctx-icon">${icons.fileText}</span>
          <span>Not synced to Notion</span>
        </div>
      `}
      
      <div class="ctx-divider"></div>
      
      <div class="ctx-item ctx-item--danger" @click=${handleDelete}>
        <span class="ctx-icon">${icons.trash}</span>
        <span>Delete</span>
      </div>
    </div>
  `;
}

// ── Shared Project Card Renderer ──────────────────────────────────
// The gallery view and the kanban (column) view both render projects, and the
// user wants them visually identical. The same `.gc` card is used in both
// places — the kanban view simply passes drag handlers via `opts`.

function getProjectIdentity(project: KanbanProject): {
  gradient: string;
  icon: string;
  accentColor: string;
  glowColor: string;
} {
  const name = project.name.toLowerCase();
  const types = project.type || [];

  if (name.includes("robo") || name.includes("robot") || types.includes("Robotics")) {
    return {
      gradient: "linear-gradient(135deg, rgba(0,255,136,0.15) 0%, rgba(0,200,100,0.05) 100%)",
      icon: "🤖", accentColor: "#00ff88", glowColor: "rgba(0,255,136,0.4)",
    };
  }
  if (name.includes("infinibot") || name.includes("agent")) {
    return {
      gradient: "linear-gradient(135deg, rgba(168,85,247,0.15) 0%, rgba(124,58,237,0.05) 100%)",
      icon: "🧠", accentColor: "#a855f7", glowColor: "rgba(168,85,247,0.4)",
    };
  }
  if (name.includes("voice") || name.includes("audio") || name.includes("caal")) {
    return {
      gradient: "linear-gradient(135deg, rgba(59,130,246,0.15) 0%, rgba(29,78,216,0.05) 100%)",
      icon: "🎙️", accentColor: "#3b82f6", glowColor: "rgba(59,130,246,0.4)",
    };
  }
  if (name.includes("money") || name.includes("finance") || name.includes("business") || name.includes("income")) {
    return {
      gradient: "linear-gradient(135deg, rgba(251,191,36,0.12) 0%, rgba(245,158,11,0.04) 100%)",
      icon: "💰", accentColor: "var(--g-primary)", glowColor: "rgba(251,191,36,0.4)",
    };
  }
  if (name.includes("video") || name.includes("media") || name.includes("content")) {
    return {
      gradient: "linear-gradient(135deg, rgba(236,72,153,0.15) 0%, rgba(219,39,119,0.05) 100%)",
      icon: "🎬", accentColor: "#ec4899", glowColor: "rgba(236,72,153,0.4)",
    };
  }
  if (name.includes("sovereignty") || name.includes("ash") || name.includes("identity")) {
    return {
      gradient: "linear-gradient(135deg, rgba(249,115,22,0.15) 0%, rgba(234,88,12,0.05) 100%)",
      icon: "🔥", accentColor: "#f97316", glowColor: "rgba(249,115,22,0.4)",
    };
  }
  if (types.includes("AI Projects")) {
    return {
      gradient: "linear-gradient(135deg, rgba(6,182,212,0.15) 0%, rgba(8,145,178,0.05) 100%)",
      icon: "✨", accentColor: "#06b6d4", glowColor: "rgba(6,182,212,0.4)",
    };
  }
  return {
    gradient: "linear-gradient(135deg, rgba(100,116,139,0.1) 0%, rgba(71,85,105,0.05) 100%)",
    icon: "◈", accentColor: "#94a3b8", glowColor: "rgba(148,163,184,0.3)",
  };
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function formatMoney(amount: number): string {
  if (!Number.isFinite(amount)) return "0";
  // Drop the cents when the value is whole-dollar so cards stay compact;
  // otherwise show two decimals so partial payments don't render as "120.5".
  return amount % 1 === 0
    ? amount.toLocaleString("en-US")
    : amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface ProjectGalleryCardOpts {
  draggable?: boolean;
  isDragging?: boolean;
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: () => void;
  parentProject?: KanbanProject;
}

/**
 * Compact inline business picker — styled `<select>` that fits inside a card
 * footer. Shows the current business's name (or "+ Business" when unset),
 * persists immediately on change via `onUpdateProject` / `onUpdateTask`. The
 * native select is intentional: no popover positioning, no z-index fights,
 * scrolls + filters via the OS, works identically on every card view.
 */
function renderBusinessChip(opts: {
  currentId: string | null | undefined;
  businesses: Array<{ id: string; name?: string }>;
  onChange: (next: string | null) => void;
  variant?: "card" | "row";
}) {
  const { currentId, businesses, onChange, variant = "card" } = opts;
  if (!businesses || businesses.length === 0) return nothing;
  const linked = currentId
    ? businesses.find((b) => b.id === currentId)
    : null;
  const cls = variant === "row" ? "biz-chip biz-chip--row" : "biz-chip";
  return html`
    <label
      class="${cls} ${linked ? "biz-chip--linked" : ""}"
      title=${linked ? `Linked to ${linked.name ?? "business"} — click to change` : "Link to a business"}
      @click=${(e: Event) => e.stopPropagation()}
    >
      <span class="biz-chip-icon" aria-hidden="true">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="8" height="18" rx="1"/>
          <rect x="13" y="8" width="8" height="13" rx="1"/>
          <path d="M6 7h2"/><path d="M6 11h2"/><path d="M6 15h2"/>
          <path d="M16 12h2"/><path d="M16 16h2"/>
        </svg>
      </span>
      <span class="biz-chip-label">${linked?.name ?? "+ Business"}</span>
      <select
        class="biz-chip-select"
        .value=${currentId ?? ""}
        @change=${(e: Event) => {
          const v = (e.target as HTMLSelectElement).value;
          onChange(v ? v : null);
        }}
        @click=${(e: Event) => e.stopPropagation()}
        aria-label="Linked business"
      >
        <option value="" ?selected=${!currentId}>— No business —</option>
        ${businesses.map((b) => html`
          <option value=${b.id} ?selected=${currentId === b.id}>${b.name ?? b.id}</option>
        `)}
      </select>
    </label>
  `;
}

/**
 * Toolbar-sized business filter dropdown. Shared by the Projects gallery
 * + the Databases toolbar via similar callsites in those files. Returns
 * `nothing` when the host has no businesses configured so it doesn't take
 * up real estate before the user creates one.
 */
function renderBusinessFilterDropdown(opts: {
  currentId: string | null;
  businesses: Array<{ id: string; name?: string }>;
  onChange: (next: string | null) => void;
}) {
  const { currentId, businesses, onChange } = opts;
  if (!businesses || businesses.length === 0) return nothing;
  const linked = currentId ? businesses.find((b) => b.id === currentId) : null;
  return html`
    <label
      class="biz-filter ${linked ? "biz-filter--active" : ""}"
      title=${linked
        ? `Filtering to ${linked.name ?? "business"} — change or clear below`
        : "Filter by business"}
    >
      <span class="biz-filter-icon" aria-hidden="true">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="8" height="18" rx="1"/>
          <rect x="13" y="8" width="8" height="13" rx="1"/>
          <path d="M6 7h2"/><path d="M6 11h2"/><path d="M6 15h2"/>
          <path d="M16 12h2"/><path d="M16 16h2"/>
        </svg>
      </span>
      <span class="biz-filter-label">${linked?.name ?? "All businesses"}</span>
      <span class="biz-filter-chev" aria-hidden="true">▾</span>
      <select
        class="biz-filter-select"
        .value=${currentId ?? ""}
        @change=${(e: Event) => {
          const v = (e.target as HTMLSelectElement).value;
          onChange(v ? v : null);
        }}
        aria-label="Filter by business"
      >
        <option value="" ?selected=${!currentId}>All businesses</option>
        ${businesses.map((b) => html`
          <option value=${b.id} ?selected=${currentId === b.id}>${b.name ?? b.id}</option>
        `)}
      </select>
    </label>
  `;
}

function renderProjectGalleryCard(
  project: KanbanProject,
  props: KanbanViewProps,
  opts?: ProjectGalleryCardOpts,
) {
  const statusCfg = PROJECT_STATUS_CONFIG[project.status || "Not started"] || PROJECT_STATUS_CONFIG["Not started"];
  const priorityCfg = project.priority ? PRIORITY_CONFIG[project.priority] : null;
  // Treat 0 as "unset" when there are tasks — server defaults Notion progress
  // to 0 even when the field is empty, so the computed done/total ratio is
  // more useful.
  const projectTasks = props.tasks.filter(t => taskMatchesProject(t, project));
  const computedProgress = projectTasks.length > 0
    ? Math.round((projectTasks.filter(t => t.status === "done" || t.done).length / projectTasks.length) * 100)
    : 0;
  const explicitProgress = typeof project.progress === "number" ? project.progress : 0;
  const progress = explicitProgress > 0
    ? explicitProgress
    : (projectTasks.length > 0 ? computedProgress : 0);
  const identity = getProjectIdentity(project);
  const isActive = project.status === "In progress" || project.status === "Updating";
  const isCompleted = project.status === "Completed";
  const updatedAgo = project.updatedAt ? formatTimeAgo(project.updatedAt) : null;

  const hasCustomIcon = !!project.customIcon;
  const isIconSvg = project.customIcon?.startsWith('icon:') ?? false;
  const iconId = isIconSvg && project.customIcon ? project.customIcon.replace('icon:', '') : null;
  const iconData = iconId ? ICON_SET.find(i => i.id === iconId) : null;
  const displayIcon = hasCustomIcon ? (isIconSvg ? null : project.customIcon) : identity.icon;
  const iconColor = project.iconColor || identity.accentColor;

  const textColorValue = project.textColor ? COLOR_PALETTE.text.find(c => c.id === project.textColor)?.color : null;
  const bgColorValue = project.bgColor ? COLOR_PALETTE.background.find(c => c.id === project.bgColor)?.color : null;

  const borderWidth = typeof project.borderWidth === "number" ? project.borderWidth : 0;
  const borderStyle = project.borderStyle || "solid";
  const borderColor = project.borderColor || iconColor;
  const borderCss = borderWidth > 0 ? `border: ${borderWidth}px ${borderStyle} ${borderColor};` : "";

  const isDragging = !!opts?.isDragging;

  // Resolve the parent for the "Parent" chip. The gallery grouped view passes
  // it explicitly; everywhere else (board view, flat gallery, right after an
  // optimistic reparent) fall back to looking it up by parentProjectId so the
  // chip is always shown when a project has a parent.
  const parentProject = opts?.parentProject
    ?? (project.parentProjectId
      ? props.projects.find((p) => p.id === project.parentProjectId)
      : undefined);

  return html`
    <div class="gc ${isActive ? 'gc--active' : ''} ${isCompleted ? 'gc--done' : ''} ${isDragging ? 'gc--dragging' : ''}"
         style="--accent: ${iconColor}; --glow: ${identity.glowColor}; ${borderCss}"
         draggable=${opts?.draggable ? "true" : "false"}
         @click=${() => props.onEnterProject(project.id)}
         @contextmenu=${(e: MouseEvent) => openContextMenu(e, { type: "project", project }, props.onRequestUpdate)}
         @touchstart=${(e: TouchEvent) => handleTouchStart(e, { type: "project", project }, props.onRequestUpdate)}
         @touchmove=${handleTouchMove}
         @touchend=${handleTouchEnd}
         @touchcancel=${handleTouchEnd}
         @dragstart=${opts?.onDragStart}
         @dragend=${opts?.onDragEnd}>
      <div class="gc-glow"></div>
      <div class="gc-inner" style="${bgColorValue ? `background: ${bgColorValue};` : ''}">
        <!-- Cover thumbnail (components/object-cover.ts); .gc-inner clips it -->
        ${renderCoverThumb({ requestUpdate: () => _rerender() } as any, props.client, "project", project.id, {
          height: 76,
          seed: project.id || project.name,
          monogram: monogramFor(project.name),
          radius: "0",
        })}
        ${parentProject ? html`
          <div class="gc-parent-badge" title="Sub-project of ${parentProject.name}">
            <span class="gc-parent-badge-icon">⤷</span>
            <span class="gc-parent-badge-name">${parentProject.name}</span>
          </div>
        ` : nothing}
        <div class="gc-header" style="background: ${identity.gradient}">
          <div class="gc-avatar" style="${hasCustomIcon && !isIconSvg ? '' : `color: ${iconColor}`}">
            ${iconData ? html`
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 20px; height: 20px; color: ${iconColor}">
                <path d="${iconData.path}"/>
              </svg>
            ` : displayIcon}
          </div>
          <div class="gc-header-content">
            <span class="gc-status" style="--sc: ${statusCfg.color}">
              ${project.status || "Not started"}
            </span>
            ${isActive ? html`<span class="gc-live"></span>` : nothing}
          </div>
          ${priorityCfg ? html`
            <span class="gc-priority" style="--pc: ${priorityCfg.color}">${priorityCfg.dot}</span>
          ` : nothing}
        </div>
        <div class="gc-body">
          <h3 class="gc-title" style="${textColorValue ? `color: ${textColorValue}` : ''}">${project.name}</h3>
          <div class="gc-repo" style="margin:2px 0 4px;min-width:0" @click=${(e: Event) => e.stopPropagation()}>
            <ib-repo-badge .projectId=${project.id} .projectName=${project.name} attachable></ib-repo-badge>
          </div>
          ${project.description ? html`
            <p class="gc-desc">${project.description.slice(0, 80)}${project.description.length > 80 ? "…" : ""}</p>
          ` : nothing}
          ${project.type?.length ? html`
            <div class="gc-tags">
              ${project.type.slice(0, 2).map(t => html`<span class="gc-tag">${t}</span>`)}
            </div>
          ` : nothing}
        </div>
        <div class="gc-footer">
          <div class="gc-progress">
            <div class="gc-progress-track">
              <div class="gc-progress-fill" style="width: ${progress}%"></div>
            </div>
            <span class="gc-progress-val">${progress}%</span>
          </div>
          <div class="gc-meta">
            ${project.taskCount ? html`<span class="gc-meta-item">${project.taskCount} tasks</span>` : nothing}
            ${updatedAgo ? html`<span class="gc-meta-item">${updatedAgo}</span>` : nothing}
            ${typeof project.paidAmount === "number" && project.paidAmount > 0 ? html`
              <span class="gc-meta-item" title="Paid amount" style="color:#22c55e;">$${formatMoney(project.paidAmount)} paid</span>
            ` : nothing}
            ${typeof project.pendingPay === "number" && project.pendingPay > 0 ? html`
              <span class="gc-meta-item" title="Pending pay" style="color:#eab308;">$${formatMoney(project.pendingPay)} pending</span>
            ` : nothing}
            ${renderBusinessChip({
              currentId: project.businessId ?? null,
              businesses: props.businesses ?? [],
              onChange: (next) => props.onUpdateProject(project.id, { businessId: next ?? undefined } as Partial<KanbanProject>),
            })}
          </div>
          ${federationNodeIds(project).length ? html`
            <div style="margin-top:6px;">
              ${renderFederationNodeChips(federationNodeIds(project), props.fedNodes ?? [])}
            </div>
          ` : nothing}
        </div>
        <button class="gc-action gc-action-tasks" title="View tasks"
          @click=${(e: Event) => { e.stopPropagation(); openTaskModal(project.id); }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 10h8M8 14h5"/></svg>
        </button>
        <button class="gc-action gc-action-edit" title="Edit project"
          @click=${(e: Event) => {
            e.stopPropagation();
            _editProjectForm = {
              id: project.id,
              name: project.name ?? "",
              description: project.description ?? "",
              status: (project.status as ProjectStatus) ?? "",
              priority: (project.priority as PriorityLevel) ?? "",
              progress: project.progress ?? 0,
              dueDate: project.dueDate ?? "",
              productUrl: project.productUrl ?? "",
              githubRepoUrl: project.githubRepoUrl ?? (project.githubRepo ? `https://github.com/${project.githubRepo.owner}/${project.githubRepo.name}` : ""),
              githubDefaultBranch: project.githubDefaultBranch ?? "",
              githubLocalPath: project.githubLocalPath ?? "",
              businessId: project.businessId ?? "",
              paidAmount: typeof project.paidAmount === "number" ? String(project.paidAmount) : "",
              pendingPay: typeof project.pendingPay === "number" ? String(project.pendingPay) : "",
              nodeIds: federationNodeIds(project),
            };
            _githubValidateResult = null;
            _githubSyncResult = null;
            resetEditProjectDirState();
            resetEditProjectInvoiceState();
            _showEditProjectDialog = true;
            if (props.client) void loadEditProjectDirs(props.client, project.id);
            if (props.client) void loadEditProjectInvoices(props.client, project.id);
            _rerender();
          }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </button>
        <button class="gc-action" title="Run with AI"
          @click=${(e: Event) => { e.stopPropagation(); openRunDialog(props.client, { project: { id: project.id, name: project.name, description: project.description } }); }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>
      </div>
    </div>
  `;
}

// ── Gallery View ──────────────────────────────────
function renderGallery(props: KanbanViewProps) {
  const { projects, galleryFilter, gallerySearch, gallerySort } = props;

  // Filter projects
  let filtered = [...projects];
  // Business scope: when set, hide projects linked to a different business.
  // Projects with no business are always visible (treated as "any").
  if (getBizFilter()) {
    filtered = filtered.filter(p => p.businessId === getBizFilter());
  }
  if (galleryFilter === "ai") {
    filtered = filtered.filter(p => {
      const types = p.type || [];
      if (types.length === 0) return false; // No type set = don't show in AI filter
      return types.some(t => t === "AI Projects" || t.toLowerCase().includes("ai"));
    });
  } else if (galleryFilter === "active") {
    filtered = filtered.filter(p => p.status === "In progress" || p.status === "Updating" || p.status === "Reviewing" || p.status === "Awaiting Client");
  } else if (galleryFilter === "completed") {
    filtered = filtered.filter(p => p.status === "Completed");
  } else if (galleryFilter === "paused") {
    filtered = filtered.filter(p => p.status === "Paused" || p.status === "Not started");
  }

  // Hide sub-projects when toggle is active
  if (_hideSubProjects) {
    filtered = filtered.filter(p => !p.parentProjectId);
  }

  // Search
  if (gallerySearch) {
    const q = gallerySearch.toLowerCase();
    filtered = filtered.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.description || "").toLowerCase().includes(q) ||
      (p.type || []).some(t => t.toLowerCase().includes(q))
    );
  }

  // Sort
  const projectPriorityOrder: Record<string, number> = {
    Immediate: 0, High: 1, Medium: 2, Low: 3,
  };
  const projectPriorityRank = (p: KanbanProject) => projectPriorityOrder[p.priority || "Low"] ?? 3;
  if (gallerySort === "name") {
    filtered.sort((a, b) => a.name.localeCompare(b.name));
  } else if (gallerySort === "priority") {
    filtered.sort((a, b) => projectPriorityRank(a) - projectPriorityRank(b));
  } else if (gallerySort === "recent") {
    filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } else {
    // Default: priority first, then status grouping, then rank/createdAt for stability.
    const sOrder: Record<string, number> = {
      "In progress": 0, "Updating": 0, "Reviewing": 0, "Awaiting Client": 0,
      "Not started": 1, "Paused": 2, "Completed": 3, "Cancelled": 4,
    };
    filtered.sort((a, b) => {
      const pr = projectPriorityRank(a) - projectPriorityRank(b);
      if (pr !== 0) return pr;
      const sr = (sOrder[a.status || "Not started"] ?? 5) - (sOrder[b.status || "Not started"] ?? 5);
      if (sr !== 0) return sr;
      const ra = a.rank ?? Number.MAX_SAFE_INTEGER;
      const rb = b.rank ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
  }

  // One batch call resolves every project card thumbnail in the gallery.
  if (props.projects?.length) {
    ensureCovers(
      { requestUpdate: () => _rerender() } as any,
      props.client,
      "project",
      props.projects.map((p) => p.id),
    );
  }

  const renderProjectCard = (project: KanbanProject) =>
    renderProjectGalleryCard(project, props);

  const renderCreateProjectCard = () => html`
    <div class="gallery-card gallery-card-new" @click=${() => { _showCreateProjectDialog = true; _createProjectForm = { name: "", description: "" }; _rerender(); }}>
      <div class="gallery-card-new-inner">
        <span class="gallery-card-new-icon">+</span>
        <span class="gallery-card-new-label">New Project</span>
      </div>
    </div>
  `;

  const renderCreateProjectDialog = () => {
    if (!_showCreateProjectDialog) return nothing;
    return html`
      <div class="modal-backdrop" @click=${() => { _showCreateProjectDialog = false; _rerender(); }}>
        <div class="modal-content" @click=${(e: Event) => e.stopPropagation()}>
          <div class="modal-header">
            <h3>New Project</h3>
            <button class="modal-close" @click=${() => { _showCreateProjectDialog = false; _rerender(); }}>✕</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label class="form-label">Project Name</label>
              <input type="text" class="form-input" placeholder="Enter project name..."
                .value=${_createProjectForm.name}
                @input=${(e: Event) => { _createProjectForm.name = (e.target as HTMLInputElement).value; _rerender(); }} />
            </div>
            <div class="form-group">
              <label class="form-label">Description</label>
              <textarea class="form-textarea" rows="3" placeholder="Brief description..."
                .value=${_createProjectForm.description}
                @input=${(e: Event) => { _createProjectForm.description = (e.target as HTMLTextAreaElement).value; _rerender(); }}></textarea>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-secondary" @click=${() => { _showCreateProjectDialog = false; _rerender(); }}>Cancel</button>
            <button class="btn-primary" ?disabled=${!_createProjectForm.name.trim()}
              @click=${() => {
                if (!_createProjectForm.name.trim()) return;
                props.onCreateProject({ name: _createProjectForm.name.trim(), description: _createProjectForm.description.trim() });
                _showCreateProjectDialog = false;
                _rerender();
              }}>Create</button>
          </div>
        </div>
      </div>
    `;
  };

  const renderEditProjectDialog = () => {
    if (!_showEditProjectDialog) return nothing;
    const close = () => { _showEditProjectDialog = false; resetEditProjectDirState(); resetEditProjectInvoiceState(); _rerender(); };
    const f = _editProjectForm;
    const PROJECT_STATUSES: ProjectStatus[] = [
      "Not started", "In progress", "Reviewing", "Awaiting Client",
      "Updating", "Paused", "Completed", "Cancelled",
    ];
    const PRIORITIES: PriorityLevel[] = ["Immediate", "High", "Medium", "Low"];
    return html`
      <div class="modal-backdrop" @click=${close}>
        <div class="modal-content" @click=${(e: Event) => e.stopPropagation()}>
          <div class="modal-header">
            <h3>Edit Project</h3>
            <button class="modal-close" @click=${close}>✕</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label class="form-label">Project Name</label>
              <input type="text" class="form-input" placeholder="Project name..."
                .value=${f.name}
                @input=${(e: Event) => { _editProjectForm.name = (e.target as HTMLInputElement).value; _rerender(); }} />
            </div>
            <div class="form-group">
              <label class="form-label">Description</label>
              <textarea class="form-textarea" rows="3" placeholder="Brief description..."
                .value=${f.description}
                @input=${(e: Event) => { _editProjectForm.description = (e.target as HTMLTextAreaElement).value; _rerender(); }}></textarea>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Status</label>
                <select class="form-select" .value=${f.status}
                  @change=${(e: Event) => { _editProjectForm.status = (e.target as HTMLSelectElement).value as ProjectStatus | ""; _rerender(); }}>
                  <option value="">—</option>
                  ${PROJECT_STATUSES.map(s => html`<option value=${s}>${s}</option>`)}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Priority</label>
                <select class="form-select" .value=${f.priority}
                  @change=${(e: Event) => { _editProjectForm.priority = (e.target as HTMLSelectElement).value as PriorityLevel | ""; _rerender(); }}>
                  <option value="">—</option>
                  ${PRIORITIES.map(p => html`<option value=${p}>${p}</option>`)}
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Progress (%)</label>
                <input type="number" class="form-input" min="0" max="100" step="1"
                  .value=${String(f.progress)}
                  @input=${(e: Event) => {
                    const v = parseInt((e.target as HTMLInputElement).value, 10);
                    _editProjectForm.progress = isNaN(v) ? 0 : Math.max(0, Math.min(100, v));
                    _rerender();
                  }} />
              </div>
              <div class="form-group">
                <label class="form-label">Due Date</label>
                <input type="date" class="form-input"
                  .value=${f.dueDate}
                  @input=${(e: Event) => { _editProjectForm.dueDate = (e.target as HTMLInputElement).value; _rerender(); }} />
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Product URL</label>
              <input type="url" class="form-input" placeholder="https://..."
                .value=${f.productUrl}
                @input=${(e: Event) => { _editProjectForm.productUrl = (e.target as HTMLInputElement).value; _rerender(); }} />
            </div>
            <div class="form-group">
              <label class="form-label" style="font-weight:600;">GitHub Repository</label>
              <input type="url" class="form-input" placeholder="https://github.com/owner/repo"
                .value=${f.githubRepoUrl}
                @input=${(e: Event) => {
                  _editProjectForm.githubRepoUrl = (e.target as HTMLInputElement).value;
                  _githubValidateResult = null;
                  _githubInfoResult = null;
                  _rerender();
                }} />
              ${_githubValidateResult ? html`
                <div style="font-size:11px;margin-top:4px;color:${_githubValidateResult.ok ? '#22c55e' : '#ef4444'}">
                  ${_githubValidateResult.msg}
                </div>
              ` : nothing}
              ${_githubInfoResult?.found ? html`
                <div style="font-size:11px;margin-top:6px;padding:8px;background:rgba(255,255,255,0.05);border-radius:6px;border:1px solid rgba(255,255,255,0.1);">
                  <div style="font-weight:600;color:var(--c-text,#fff);">${_githubInfoResult.name}</div>
                  ${_githubInfoResult.description ? html`<div style="color:#aaa;margin-top:2px;">${_githubInfoResult.description}</div>` : nothing}
                  <div style="display:flex;gap:12px;margin-top:4px;color:#888;font-size:10px;">
                    ${_githubInfoResult.defaultBranch ? html`<span>Branch: <strong>${_githubInfoResult.defaultBranch}</strong></span>` : nothing}
                    ${_githubInfoResult.stars != null ? html`<span>★ ${_githubInfoResult.stars}</span>` : nothing}
                    ${_githubInfoResult.visibility ? html`<span>${_githubInfoResult.visibility}</span>` : nothing}
                  </div>
                </div>
              ` : nothing}
              ${f.githubRepoUrl ? html`
                <div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap;">
                  <button class="btn-secondary" style="font-size:11px;padding:2px 8px;"
                    ?disabled=${_githubValidating}
                    @click=${async () => {
                      _githubValidating = true;
                      _githubValidateResult = null;
                      _rerender();
                      try {
                        const res = await props.client?.request("kanban.github.validate", { repoUrl: f.githubRepoUrl });
                        _githubValidateResult = res?.valid
                          ? { ok: true, msg: `✓ ${res.owner}/${res.name} exists` }
                          : { ok: false, msg: "✗ Repo not found or gh CLI unavailable" };
                      } catch {
                        _githubValidateResult = { ok: false, msg: "✗ Validation failed" };
                      }
                      _githubValidating = false;
                      _rerender();
                    }}>
                    ${_githubValidating ? "Validating…" : "Validate"}
                  </button>
                  <button class="btn-secondary" style="font-size:11px;padding:2px 8px;"
                    ?disabled=${_githubFetchingInfo}
                    @click=${async () => {
                      _githubFetchingInfo = true;
                      _githubInfoResult = null;
                      _rerender();
                      try {
                        const res = await props.client?.request("kanban.github.repoInfo", { repoUrl: f.githubRepoUrl });
                        _githubInfoResult = res ?? null;
                        if (res?.found && res.defaultBranch && !_editProjectForm.githubDefaultBranch) {
                          _editProjectForm.githubDefaultBranch = res.defaultBranch;
                        }
                      } catch {
                        _githubInfoResult = { found: false };
                      }
                      _githubFetchingInfo = false;
                      _rerender();
                    }}>
                    ${_githubFetchingInfo ? "Fetching…" : "Fetch info"}
                  </button>
                </div>
              ` : nothing}
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Default branch</label>
                <input type="text" class="form-input" placeholder="main"
                  .value=${f.githubDefaultBranch}
                  @input=${(e: Event) => { _editProjectForm.githubDefaultBranch = (e.target as HTMLInputElement).value; _rerender(); }} />
              </div>
              <div class="form-group">
                <label class="form-label">Local clone path</label>
                <input type="text" class="form-input" placeholder="/home/user/projects/repo"
                  .value=${f.githubLocalPath}
                  @input=${(e: Event) => { _editProjectForm.githubLocalPath = (e.target as HTMLInputElement).value; _rerender(); }} />
              </div>
            </div>
            ${(props.businesses?.length ?? 0) > 0 ? html`
              <div class="form-group">
                <label class="form-label">Linked business</label>
                <select class="form-select"
                  .value=${f.businessId}
                  @change=${(e: Event) => { _editProjectForm.businessId = (e.target as HTMLSelectElement).value; _rerender(); }}>
                  <option value="">— No business —</option>
                  ${(props.businesses ?? []).map((b) => html`
                    <option value=${b.id} ?selected=${f.businessId === b.id}>${b.name || "Untitled"}</option>
                  `)}
                </select>
                <div class="form-hint" style="font-size:11px;color:#888;margin-top:4px;">
                  Used by /business analytics + AI context to scope this project to a brand.
                </div>
              </div>
            ` : nothing}
            ${renderProjectInvoicesSection(props, f.id)}
            ${renderProjectDirectoriesSection(props, f.id)}
            ${(props.fedNodes?.length ?? 0) > 0 ? html`
              <div class="form-group" style="margin-top:12px;">
                ${renderFederationNodeMultiSelect({
                  value: _editProjectForm.nodeIds,
                  nodes: props.fedNodes ?? [],
                  label: "Devices",
                  onChange: (ids) => { _editProjectForm.nodeIds = ids; _rerender(); },
                })}
              </div>
            ` : nothing}
          </div>
          <div class="modal-footer">
            <button class="btn-secondary" @click=${close}>Cancel</button>
            <button class="btn-primary" ?disabled=${!_editProjectForm.name.trim()}
              @click=${() => {
                const name = _editProjectForm.name.trim();
                if (!name) return;
                const parseMoney = (raw: string): number | undefined => {
                  const trimmed = raw.trim();
                  if (!trimmed) return undefined;
                  const n = Number(trimmed);
                  return Number.isFinite(n) && n >= 0 ? n : undefined;
                };
                const patch: Partial<KanbanProject> & FederationAssignable = {
                  name,
                  description: _editProjectForm.description.trim(),
                  progress: _editProjectForm.progress,
                  productUrl: _editProjectForm.productUrl.trim() || undefined,
                  githubRepoUrl: _editProjectForm.githubRepoUrl.trim() || undefined,
                  githubDefaultBranch: _editProjectForm.githubDefaultBranch.trim() || undefined,
                  githubLocalPath: _editProjectForm.githubLocalPath.trim() || undefined,
                  dueDate: _editProjectForm.dueDate || undefined,
                  businessId: _editProjectForm.businessId.trim() || undefined,
                  // paidAmount/pendingPay are managed by the invoice system when invoices
                  // are linked; they remain as display values updated by kanban.project.invoices.set.
                  // Only set them from the form when no invoices are linked (backward compat).
                  ...(_editProjectLinkedInvoices.length === 0
                    ? {
                        paidAmount: parseMoney(_editProjectForm.paidAmount),
                        pendingPay: parseMoney(_editProjectForm.pendingPay),
                      }
                    : {}),
                  nodeIds: _editProjectForm.nodeIds.length > 0 ? _editProjectForm.nodeIds : undefined,
                };
                if (_editProjectForm.status) patch.status = _editProjectForm.status as ProjectStatus;
                if (_editProjectForm.priority) patch.priority = _editProjectForm.priority as PriorityLevel;
                props.onUpdateProject(_editProjectForm.id, patch);
                _showEditProjectDialog = false;
                resetEditProjectDirState();
                resetEditProjectInvoiceState();
                _rerender();
              }}>Save</button>
          </div>
        </div>
      </div>
    `;
  };

  // Create Task dialog for global tasks view
  const renderCreateTaskDialogGlobal = () => {
    if (!_showCreateDialog) return nothing;
    return html`
      <div class="modal-backdrop" @click=${() => { _showCreateDialog = false; _rerender(); }}>
        <div class="modal-content" @click=${(e: Event) => e.stopPropagation()}>
          <div class="modal-header">
            <h3>New Task</h3>
            <button class="modal-close" @click=${() => { _showCreateDialog = false; _rerender(); }}>✕</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label class="form-label">Task Title</label>
              <input type="text" class="form-input" placeholder="What needs to be done?"
                .value=${_createForm.title}
                @input=${(e: Event) => { _createForm.title = (e.target as HTMLInputElement).value; _rerender(); }} />
            </div>
            <div class="form-group">
              <label class="form-label">Description</label>
              <textarea class="form-textarea" rows="3" placeholder="Details..."
                .value=${_createForm.description}
                @input=${(e: Event) => { _createForm.description = (e.target as HTMLTextAreaElement).value; _rerender(); }}></textarea>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Status</label>
                <select class="form-select" .value=${_createForm.status}
                  @change=${(e: Event) => { _createForm.status = (e.target as HTMLSelectElement).value as TaskStatus; _rerender(); }}>
                  ${STATUS_COLUMNS.map(c => html`<option value=${c.id}>${c.label}</option>`)}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Priority</label>
                <select class="form-select" .value=${_createForm.priority}
                  @change=${(e: Event) => { _createForm.priority = (e.target as HTMLSelectElement).value; _rerender(); }}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Immediate</option>
                </select>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-secondary" @click=${() => { _showCreateDialog = false; _rerender(); }}>Cancel</button>
            <button class="btn-primary" ?disabled=${!_createForm.title.trim()}
              @click=${() => {
                if (!_createForm.title.trim()) return;
                props.onCreateTask({
                  title: _createForm.title.trim(),
                  description: _createForm.description.trim(),
                  status: _createForm.status,
                  priority: _createForm.priority as any,
                });
                _showCreateDialog = false;
                _createForm = { title: "", description: "", status: "todo", priority: "medium" };
                _rerender();
              }}>Create Task</button>
          </div>
        </div>
      </div>
    `;
  };

  return html`
    ${renderCreateProjectDialog()}
    ${renderEditProjectDialog()}
    ${renderCreateTaskDialogGlobal()}
    <div class="gallery-toolbar" data-learn-id="projects-toolbar">
      <div class="gallery-filters">
        <div class="gallery-view-toggle" data-learn-id="projects-view-toggle">
          <button class="gallery-view-btn ${_projectsViewMode === 'gallery' ? 'active' : ''}"
            data-learn-id="projects-view-grid"
            @click=${() => { _projectsViewMode = "gallery"; _rerender(); }} title="Grid View">⊞</button>
          <button class="gallery-view-btn ${_projectsViewMode === 'kanban' ? 'active' : ''}"
            data-learn-id="projects-view-kanban"
            @click=${() => { _projectsViewMode = "kanban"; _rerender(); }} title="Kanban View">⫏</button>
        </div>
        ${renderBusinessFilterDropdown({
          currentId: getBizFilter(),
          // Agency/business scoping belongs to the Business & Agency plugin.
          businesses: isBusinessAgencyOn() ? (props.businesses ?? []) : [],
          onChange: (next) => { setBizFilter(next); _rerender(); },
        })}
        <div class="gallery-filter-group" data-learn-id="projects-filters">
          <button class="gallery-filter-btn gallery-filter-tasks ${galleryFilter === 'tasks' ? 'active' : ''}"
            data-learn-id="projects-filter-tasks"
            @click=${() => props.onGalleryFilterChange('tasks')}>
            ${icons.fileText} Tasks
          </button>
          <button class="gallery-filter-btn gallery-filter-ai ${galleryFilter === 'ai' ? 'active' : ''}"
            @click=${() => props.onGalleryFilterChange('ai')}>
            ${icons.bot} AI Projects
          </button>
          ${["all", "active", "completed", "paused"].map(f => html`
            <button class="gallery-filter-btn ${galleryFilter === f ? 'active' : ''}"
              data-learn-id=${`projects-filter-${f}`}
              @click=${() => props.onGalleryFilterChange(f)}>
              ${f === "all" ? "All" : f === "active" ? "Active" : f === "completed" ? "Completed" : "Paused"}
            </button>
          `)}
        </div>
        ${galleryFilter !== "tasks" && _projectsViewMode === "gallery" ? html`
          <button class="gallery-filter-btn ${_hideSubProjects ? 'active' : ''}"
            @click=${() => { _hideSubProjects = !_hideSubProjects; setHideSubProjects(_hideSubProjects); _rerender(); }}
            title="Toggle sub-project visibility">
            ${_hideSubProjects ? icons.folder : icons.folder} ${_hideSubProjects ? 'Show Sub-Projects' : 'Hide Sub-Projects'}
          </button>
        ` : nothing}
        ${galleryFilter !== "tasks" ? html`
          <input type="text" class="gallery-search" data-learn-id="projects-search" placeholder="Search projects..."
            .value=${gallerySearch}
            @input=${(e: Event) => props.onGallerySearchChange((e.target as HTMLInputElement).value)} />
        ` : nothing}
        ${galleryFilter !== "tasks" && _projectsViewMode === "gallery" ? html`
          <select class="gallery-sort" data-learn-id="projects-sort" .value=${gallerySort}
            @change=${(e: Event) => props.onGallerySortChange((e.target as HTMLSelectElement).value)}>
            <option value="status">Sort: Status</option>
            <option value="name">Sort: Name</option>
            <option value="priority">Sort: Priority</option>
            <option value="recent">Sort: Recent</option>
          </select>
        ` : nothing}
      </div>
      <div class="gallery-actions">
        ${galleryFilter === "tasks" ? html`
          <button class="btn-add-new" data-learn-id="tasks-new" @click=${() => { _showCreateDialog = true; _createForm = { title: "", description: "", status: "todo", priority: "medium" }; _rerender(); }} title="New Task">
            <span class="btn-add-icon">+</span>
            <span>Task</span>
          </button>
        ` : html`
          <button class="btn-add-new" data-learn-id="projects-new" @click=${() => { _showCreateProjectDialog = true; _createProjectForm = { name: "", description: "" }; _rerender(); }} title="New Project">
            <span class="btn-add-icon">+</span>
            <span>Project</span>
          </button>
        `}
        <button class="btn-icon" @click=${props.onRefresh} title="Refresh">↻</button>
        ${renderNotionSyncChip(props.client)}
        ${props.onNotionSync ? html`
          <button class="btn-notion-sync ${props.notionSyncStatus?.syncing ? 'syncing' : ''}"
            @click=${() => props.onNotionSync?.()}
            ?disabled=${props.notionSyncStatus?.syncing}
            title="Sync with Notion">
            <span class="notion-sync-icon">${props.notionSyncStatus?.syncing ? "⟳" : icons.fileText}</span>
            <span>Sync to Notion</span>
          </button>
        ` : nothing}
        <!-- Change DB button is independent of the sync handler — it
             dispatches a custom event to the global host modal. The
             modal works whether or not a binding currently exists, so
             we always render the button. -->
        <button class="btn-notion-sync"
          style="border-color:rgba(167,139,250,0.3); color:#c4b5fd;"
          data-learn-id="projects-change-db"
          @click=${() => requestChangeNotionDb("projects", props.notionSyncStatus?.projectsDbId ?? null)}
          title="Swap which Notion database drives Projects">
          <span class="notion-sync-icon">⇄</span>
          <span>Change DB</span>
        </button>
      </div>
    </div>
    ${galleryFilter !== "tasks" ? html`
      <div style="padding: 0 16px;">
        ${renderProjectsRecentlyCompleted({
          onNavigateToTask: (taskId, projectId) => {
            if (taskId === "__view_all__") {
              props.onGalleryFilterChange("tasks");
            } else if (projectId) {
              props.onEnterProject(projectId);
              props.onSelectTask(taskId);
            } else {
              props.onSelectTask(taskId);
            }
          },
          onNavigateToProject: (projectId) => {
            props.onEnterProject(projectId);
          },
        })}
      </div>
    ` : nothing}
    ${(() => {
      // Banner: if a biz filter is hiding everything, surface that with a
      // clear-filter affordance. Otherwise the page just looks empty after
      // a refresh because the filter is localStorage-persisted.
      const bizFilter = getBizFilter();
      if (!bizFilter) return nothing;
      const hidden = projects.length - filtered.length;
      if (hidden <= 0 || filtered.length > 0) return nothing;
      const bizName =
        (props.businesses ?? []).find((b) => b.id === bizFilter)?.name ?? "this business";
      return html`
        <div class="gallery-filter-banner">
          <span>
            Hiding <strong>${hidden}</strong> project${hidden === 1 ? "" : "s"} not linked to <strong>${bizName}</strong>.
          </span>
          <button
            class="gallery-filter-banner-clear"
            @click=${() => { setBizFilter(null); _rerender(); }}
          >Clear filter</button>
        </div>
      `;
    })()}
    ${galleryFilter === "tasks"
      ? renderGlobalTasks(props)
      : _projectsViewMode === "kanban"
        ? renderProjectsKanban(props, filtered)
        : (() => {
            // Build parent→children map and flatten into hierarchical display order:
            // each parent is immediately followed by its children.
            const _pById = new Map<string, KanbanProject>(filtered.map((p: KanbanProject) => [p.id, p]));
            const _childrenOf = new Map<string, KanbanProject[]>();
            const _topLevel: KanbanProject[] = [];
            for (const p of filtered) {
              if (p.parentProjectId && _pById.has(p.parentProjectId)) {
                const kids = _childrenOf.get(p.parentProjectId) ?? [];
                kids.push(p);
                _childrenOf.set(p.parentProjectId, kids);
              } else {
                _topLevel.push(p);
              }
            }
            type OrderedEntry = { project: KanbanProject; parentProject?: KanbanProject };
            const _ordered: OrderedEntry[] = [];
            for (const p of _topLevel) {
              _ordered.push({ project: p });
              const kids = _childrenOf.get(p.id);
              if (kids?.length) {
                for (const kid of kids) _ordered.push({ project: kid, parentProject: p });
              }
            }

            // Reset to page 0 when the filtered set shrinks (e.g. after a search)
            const totalPages = Math.ceil((_ordered.length + 1) / GALLERY_PAGE_SIZE); // +1 for "new" card
            if (_galleryPage >= totalPages) _galleryPage = Math.max(0, totalPages - 1);
            const pageStart = _galleryPage * GALLERY_PAGE_SIZE;
            const pageEnd = pageStart + GALLERY_PAGE_SIZE;
            // Last page also shows the "New Project" card
            const isLastPage = _galleryPage === Math.max(0, totalPages - 1);
            const paginated = _ordered.slice(pageStart, isLastPage ? undefined : pageEnd);

            if (filtered.length === 0) {
              return html`
                <div class="gallery-empty" data-learn-id="projects-empty">
                  <div class="gallery-empty-icon">${icons.fileText}</div>
                  <div class="gallery-empty-title">No projects found</div>
                  <div class="gallery-empty-subtitle">
                    ${gallerySearch
                      ? `No results for "${gallerySearch}" — try a different search term.`
                      : galleryFilter !== "all"
                        ? "No projects match the current filter."
                        : "Get started by creating your first project."}
                  </div>
                  <div class="gallery-empty-actions">
                    ${gallerySearch || galleryFilter !== "all" ? html`
                      <button class="btn-secondary"
                        @click=${() => { props.onGalleryFilterChange("all"); props.onGallerySearchChange(""); }}>
                        Clear filters
                      </button>
                    ` : nothing}
                    <button class="btn-primary"
                      @click=${() => { _showCreateProjectDialog = true; _createProjectForm = { name: "", description: "" }; _rerender(); }}>
                      + New Project
                    </button>
                  </div>
                </div>
              `;
            }

            return html`
              <div class="gallery-grid">
                ${paginated.map(({ project, parentProject }) =>
                  renderProjectGalleryCard(project, props, { parentProject })
                )}
                ${isLastPage ? renderCreateProjectCard() : nothing}
              </div>
              ${totalPages > 1 ? html`
                <div class="gallery-pagination">
                  <button class="gallery-page-btn" ?disabled=${_galleryPage === 0}
                    @click=${() => { _galleryPage--; _rerender(); }}>← Prev</button>
                  <span class="gallery-page-info">Page ${_galleryPage + 1} of ${totalPages}</span>
                  <button class="gallery-page-btn" ?disabled=${_galleryPage >= totalPages - 1}
                    @click=${() => { _galleryPage++; _rerender(); }}>Next →</button>
                </div>
              ` : nothing}
            `;
          })()}
  `;
}

function _isDueOverdue(dateStr: string): boolean {
  try {
    const d = new Date(dateStr);
    return d.getTime() < Date.now();
  } catch { return false; }
}

// ── Global Tasks View ──────────────────────────────────
const GLOBAL_TASK_COLUMNS: { id: TaskStatus; label: string; color: string }[] = [
  { id: "backlog", label: "Backlog", color: "#6b7280" },
  { id: "todo", label: "To Do", color: "#3b82f6" },
  { id: "in_progress", label: "In Progress", color: "#f59e0b" },
  { id: "review", label: "Review / Blocked", color: "#a855f7" },
];

// Autonomous column config (separate from status columns - shows duplicates)
const AUTONOMOUS_COLUMN = { id: "autonomous" as const, label: "Autonomous", color: "#10b981" };

// Autonomous status display
const AUTONOMOUS_STATUS_CONFIG: Record<string, { icon: string; color: string }> = {
  pending_preflight: { icon: "📋", color: "#6b7280" },
  pending_approval: { icon: "⏳", color: "#f59e0b" },
  approved: { icon: "✅", color: "#3b82f6" },
  in_progress: { icon: "🔄", color: "#f59e0b" },
  blocked: { icon: "🚫", color: "#ef4444" },
  testing: { icon: "🧪", color: "#a855f7" },
  complete: { icon: "✓", color: "#10b981" },
  failed: { icon: "❌", color: "#ef4444" },
};

function renderGlobalTasks(props: KanbanViewProps) {
  const { tasks, projects } = props;
  const projectMap = new Map(projects.map(p => [p.id, p]));

  // Filter tasks
  let filtered = [...tasks];

  // Business scope (inherited from parent project). Tasks with no project,
  // or whose project has no business, are visible under any filter.
  if (getBizFilter()) {
    filtered = filtered.filter((t) => {
      const proj = projectMap.get(t.projectId);
      if (!proj) return true;
      return proj.businessId === getBizFilter();
    });
  }

  // Hide done by default
  if (!_globalTasksShowDone) {
    filtered = filtered.filter(t => t.status !== "done");
  }

  // Search
  if (_globalTasksSearch) {
    const q = _globalTasksSearch.toLowerCase();
    filtered = filtered.filter(t =>
      t.title.toLowerCase().includes(q) ||
      (t.description || "").toLowerCase().includes(q) ||
      (t.assignee || "").toLowerCase().includes(q) ||
      (projectMap.get(t.projectId)?.name || "").toLowerCase().includes(q)
    );
  }

  // Priority filter
  if (_globalTasksPriority !== "all") {
    filtered = filtered.filter(t => (t.priority || "normal") === _globalTasksPriority);
  }

  // Assignee filter
  if (_globalTasksAssignee !== "all") {
    filtered = filtered.filter(t => (t.assignee || "unassigned") === _globalTasksAssignee);
  }

  // Department filter
  if (_globalTasksDepartment !== "all") {
    filtered = filtered.filter(t => t.department?.includes(_globalTasksDepartment));
  }

  // Collect unique assignees and departments for filter dropdowns
  const assignees = new Set<string>();
  const departments = new Set<string>();
  tasks.forEach(t => {
    if (t.assignee) assignees.add(t.assignee);
    t.department?.forEach(d => departments.add(d));
  });

  // Columns to show
  const columns = _globalTasksShowDone
    ? [...GLOBAL_TASK_COLUMNS, { id: "done" as TaskStatus, label: "Done", color: "#10b981" }]
    : GLOBAL_TASK_COLUMNS;

  // Group by status
  const tasksByStatus: Record<string, KanbanTask[]> = {};
  for (const col of columns) tasksByStatus[col.id] = [];
  for (const task of filtered) {
    if (tasksByStatus[task.status]) {
      tasksByStatus[task.status].push(task);
    }
  }

  // Sort within columns: by priority, then rank, then by updated.
  // Accept both PriorityLevel ("Immediate"/"High"/...) and short form ("critical"/"high"/...).
  const priOrder: Record<string, number> = {
    Immediate: 0, High: 1, Medium: 2, Low: 3,
    critical: 0, high: 1, normal: 2, medium: 2, low: 3,
  };
  const rankPri = (t: KanbanTask): number => {
    const lvl = t.priorityLevel || t.priority;
    return lvl ? (priOrder[lvl] ?? 4) : 4;
  };
  for (const col of columns) {
    tasksByStatus[col.id].sort((a, b) => {
      const pr = rankPri(a) - rankPri(b);
      if (pr !== 0) return pr;
      const ra = a.rank ?? Number.MAX_SAFE_INTEGER;
      const rb = b.rank ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }

  // Drag handlers with position awareness
  const handleDragStart = (e: DragEvent, taskId: string) => {
    e.dataTransfer?.setData("text/plain", taskId);
    e.dataTransfer!.effectAllowed = "move";
    _globalTasksDragId = taskId;
    _globalTasksDragOverPosition = -1;
    _globalTasksDragOverTaskId = null;
    _kanbanActiveDrag = true;

    // Create custom drag image
    const dragEl = e.target as HTMLElement;
    if (e.dataTransfer) {
      const rect = dragEl.getBoundingClientRect();
      e.dataTransfer.setDragImage(dragEl, rect.width / 2, 20);
    }

    _rerender();
    requestAnimationFrame(() => {
      dragEl.classList.add("gt-dragging");
    });
  };

  const handleDragEnd = () => {
    _kanbanActiveDrag = false;
    if (_kanbanDragRafId !== null) { cancelAnimationFrame(_kanbanDragRafId); _kanbanDragRafId = null; }
    _globalTasksDragId = null;
    _globalTasksDragOverCol = null;
    _globalTasksDragOverPosition = -1;
    _globalTasksDragOverTaskId = null;
    _rerender();
  };

  const handleDragOver = (e: DragEvent, colId: TaskStatus) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (_globalTasksDragOverCol !== colId) {
      _globalTasksDragOverCol = colId;
      _globalTasksDragOverPosition = -1;
      _globalTasksDragOverTaskId = null;
      if (_kanbanDragRafId !== null) cancelAnimationFrame(_kanbanDragRafId);
      _kanbanDragRafId = requestAnimationFrame(() => { _kanbanDragRafId = null; _rerender(); });
    }
  };

  // Handle drag over individual cards for position-aware dropping
  const handleCardDragOver = (e: DragEvent, taskId: string, index: number, colId: TaskStatus) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";

    // Don't show indicator on the dragged card itself
    if (taskId === _globalTasksDragId) return;

    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;

    // Determine if dropping above or below this card
    const dropPosition = e.clientY < midY ? index : index + 1;

    if (_globalTasksDragOverCol !== colId || _globalTasksDragOverPosition !== dropPosition || _globalTasksDragOverTaskId !== taskId) {
      _globalTasksDragOverCol = colId;
      _globalTasksDragOverPosition = dropPosition;
      _globalTasksDragOverTaskId = taskId;
      if (_kanbanDragRafId !== null) cancelAnimationFrame(_kanbanDragRafId);
      _kanbanDragRafId = requestAnimationFrame(() => { _kanbanDragRafId = null; _rerender(); });
    }
  };

  const handleDragLeave = (e: DragEvent, colId: TaskStatus) => {
    const relTarget = e.relatedTarget as HTMLElement | null;
    const colEl = e.currentTarget as HTMLElement;
    if (relTarget && colEl.contains(relTarget)) return;
    if (_globalTasksDragOverCol === colId) {
      _globalTasksDragOverCol = null;
      _globalTasksDragOverPosition = -1;
      _globalTasksDragOverTaskId = null;
      _rerender();
    }
  };

  const handleDrop = (e: DragEvent, status: TaskStatus | "autonomous") => {
    e.preventDefault();
    const taskId = e.dataTransfer?.getData("text/plain");
    const dropPosition = _globalTasksDragOverPosition;

    _kanbanActiveDrag = false;
    if (_kanbanDragRafId !== null) { cancelAnimationFrame(_kanbanDragRafId); _kanbanDragRafId = null; }
    _globalTasksDragId = null;
    _globalTasksDragOverCol = null;
    _globalTasksDragOverPosition = -1;
    _globalTasksDragOverTaskId = null;
    _rerender();
    
    if (!taskId) return;
    const task = filtered.find(t => t.id === taskId);
    if (!task) return;
    
    // Handle drop to Autonomous column - sets autonomous flag without changing status
    if (status === "autonomous") {
      if (!task.autonomous) {
        props.onUpdateTask(taskId, { autonomous: true, autonomousStatus: "pending_preflight" } as any);
      }
      return;
    }
    
    // Regular status change
    if (task.status === status) return;
    props.onUpdateTask(taskId, { status });
  };

  // Handle drag over/leave for autonomous column
  const handleAutonomousDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; // Copy icon to indicate it's a duplicate
    if (_globalTasksDragOverCol !== "autonomous") {
      _globalTasksDragOverCol = "autonomous";
      _globalTasksDragOverPosition = -1;
      _globalTasksDragOverTaskId = null;
      if (_kanbanDragRafId !== null) cancelAnimationFrame(_kanbanDragRafId);
      _kanbanDragRafId = requestAnimationFrame(() => { _kanbanDragRafId = null; _rerender(); });
    }
  };

  const handleAutonomousDragLeave = (e: DragEvent) => {
    const relTarget = e.relatedTarget as HTMLElement | null;
    const colEl = e.currentTarget as HTMLElement;
    if (relTarget && colEl.contains(relTarget)) return;
    if (_globalTasksDragOverCol === "autonomous") {
      _globalTasksDragOverCol = null;
      if (_kanbanDragRafId !== null) cancelAnimationFrame(_kanbanDragRafId);
      _kanbanDragRafId = requestAnimationFrame(() => { _kanbanDragRafId = null; _rerender(); });
    }
  };

  // Remove task from autonomous queue
  const removeFromAutonomous = (taskId: string) => {
    props.onUpdateTask(taskId, { autonomous: false, autonomousStatus: undefined } as any);
  };

  const totalCount = tasks.filter(t => t.status !== "done").length;
  const doneCount = tasks.filter(t => t.status === "done").length;
  
  // Get tasks assigned to autonomous agent (these appear as duplicates)
  const autonomousTasks = filtered.filter(t => t.autonomous === true);

  const renderGlobalTaskCard = (task: KanbanTask, index: number, colId: TaskStatus) => {
    const project = projectMap.get(task.projectId);
    const isDragging = _globalTasksDragId === task.id;
    const priCfg: Record<string, { dot: string; color: string }> = {
      critical: { dot: "🔴", color: "#ef4444" },
      Immediate: { dot: "🔴", color: "#ef4444" },
      high: { dot: "🟠", color: "#f97316" },
      High: { dot: "🟠", color: "#f97316" },
      normal: { dot: "🔵", color: "#3b82f6" },
      medium: { dot: "🔵", color: "#3b82f6" },
      Medium: { dot: "🔵", color: "#3b82f6" },
      low: { dot: "🟢", color: "#22c55e" },
      Low: { dot: "🟢", color: "#22c55e" },
    };
    const priKey = task.priorityLevel || task.priority || "normal";
    const pri = priCfg[priKey] || priCfg["normal"];

    const isSynced = !!task.notionId;
    
    // Custom styles
    const hasCustomIcon = !!task.customIcon;
    const isIconSvg = task.customIcon?.startsWith('icon:');
    const iconId = isIconSvg ? task.customIcon!.replace('icon:', '') : null;
    const iconData = iconId ? ICON_SET.find(i => i.id === iconId) : null;
    const displayIcon = hasCustomIcon && !isIconSvg ? task.customIcon : null;
    const iconColor = task.iconColor || "#a855f7";
    const textColorValue = task.textColor ? COLOR_PALETTE.text.find(c => c.id === task.textColor)?.color : null;
    const bgColorValue = task.bgColor ? COLOR_PALETTE.background.find(c => c.id === task.bgColor)?.color : null;
    
    // Check if drop indicator should show above this card
    const showDropAbove = _globalTasksDragId && 
      _globalTasksDragOverCol === colId && 
      _globalTasksDragOverPosition === index &&
      task.id !== _globalTasksDragId;
    
    // Check if drop indicator should show below this card (last position)
    const isLastInColumn = index === (tasksByStatus[colId]?.length || 0) - 1;
    const showDropBelow = _globalTasksDragId && 
      _globalTasksDragOverCol === colId && 
      _globalTasksDragOverPosition === index + 1 &&
      isLastInColumn &&
      task.id !== _globalTasksDragId;

    return html`
      ${showDropAbove ? html`<div class="gt-drop-indicator"><div class="gt-drop-indicator-line"></div></div>` : nothing}
      <div class="gt-card ${isDragging ? 'gt-dragging' : ''} ${task.done ? 'gt-card-done' : ''} ${_globalTasksDragOverTaskId === task.id ? 'gt-card-hover-target' : ''}"
        style="${bgColorValue ? `background: ${bgColorValue};` : ''}"
        draggable="true"
        @dragstart=${(e: DragEvent) => handleDragStart(e, task.id)}
        @dragend=${() => handleDragEnd()}
        @dragover=${(e: DragEvent) => handleCardDragOver(e, task.id, index, colId)}
        @click=${() => { _taskDetailId = task.id; _rerender(); }}
        @contextmenu=${(e: MouseEvent) => openContextMenu(e, { type: "task", task }, props.onRequestUpdate)}
        @touchstart=${(e: TouchEvent) => handleTouchStart(e, { type: "task", task }, props.onRequestUpdate)}
        @touchmove=${handleTouchMove}
        @touchend=${handleTouchEnd}
        @touchcancel=${handleTouchEnd}>
        <div class="gt-card-header">
          ${hasCustomIcon ? html`
            <span class="gt-card-icon" style="color: ${iconColor}">
              ${iconData ? html`
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 16px; height: 16px;">
                  <path d="${iconData.path}"/>
                </svg>
              ` : displayIcon}
            </span>
          ` : nothing}
          <span class="gt-card-title" style="${textColorValue ? `color: ${textColorValue}` : ''}">${task.title}</span>
          <div class="gt-card-header-right">
            <button class="run-btn-mini" title="Run with agent"
              @click=${(e: Event) => { e.stopPropagation(); openRunDialog(props.client, { task: { id: task.id, title: task.title, description: task.description, projectId: task.projectId } }); }}>▶</button>
            ${isSynced ? html`<span class="gt-notion-badge" title="Synced with Notion">${icons.fileText}</span>` : html`<span class="gt-local-badge" title="Local only">${icons.database}</span>`}
            <span class="gt-card-pri" style="color: ${pri.color}" title="${priKey}">${pri.dot}</span>
          </div>
        </div>
        ${task.description ? html`<div class="gt-card-desc">${task.description.slice(0, 100)}${task.description.length > 100 ? "…" : ""}</div>` : nothing}
        <div class="gt-card-footer">
          ${project && project.id !== "default" ? html`
            <span class="gt-card-project" title="${project.name}"
              @click=${(e: Event) => { e.stopPropagation(); props.onEnterProject(project.id); }}>
              ${icons.folder} ${project.name.length > 22 ? project.name.slice(0, 22) + "…" : project.name}
            </span>
          ` : nothing}
          ${task.dueDate ? html`<span class="gt-card-due ${_isDueOverdue(task.dueDate) ? 'gt-due-overdue' : ''}">${icons.calendar} ${task.dueDate}</span>` : nothing}
        </div>
        ${task.department?.length || task.assignee ? html`
          <div class="gt-card-meta-row">
            ${task.assignee ? html`<span class="gt-card-assignee">${icons.person} ${task.assignee}</span>` : nothing}
            ${task.department?.slice(0, 2).map(d => html`<span class="gt-dept-chip">${d}</span>`)}
            ${(task.department?.length ?? 0) > 2 ? html`<span class="gt-dept-chip gt-dept-more">+${(task.department?.length ?? 0) - 2}</span>` : nothing}
          </div>
        ` : nothing}
      </div>
    `;
  };

  // Task detail modal (reuse existing _taskDetailId)
  const detailTask = _taskDetailId ? tasks.find(t => t.id === _taskDetailId) : null;
  const renderGlobalTaskDetail = () => {
    if (!detailTask) return nothing;
    const project = projectMap.get(detailTask.projectId);
    const priCfg: Record<string, { dot: string; color: string }> = {
      critical: { dot: "🔴", color: "#ef4444" }, Immediate: { dot: "🔴", color: "#ef4444" },
      high: { dot: "🟠", color: "#f97316" }, High: { dot: "🟠", color: "#f97316" },
      normal: { dot: "🔵", color: "#3b82f6" }, medium: { dot: "🔵", color: "#3b82f6" }, Medium: { dot: "🔵", color: "#3b82f6" },
      low: { dot: "🟢", color: "#22c55e" }, Low: { dot: "🟢", color: "#22c55e" },
    };
    const priKey = detailTask.priorityLevel || detailTask.priority || "normal";
    const pri = priCfg[priKey] || priCfg["normal"];
    return html`
      <div class="modal-backdrop" @click=${() => { _taskDetailId = null; _rerender(); }}>
        <div class="modal-content modal-wide" @click=${(e: Event) => e.stopPropagation()}>
          <div class="modal-header">
            <div style="display: flex; align-items: center; gap: 10px">
              <h3>${detailTask.title}</h3>
              ${detailTask.notionId
                ? html`<span class="gt-sync-status gt-sync-yes" title="Synced with Notion">${icons.fileText} Synced</span>`
                : html`<span class="gt-sync-status gt-sync-no" title="Local only — not synced to Notion">${icons.database} Local</span>`}
            </div>
            <button class="modal-close" @click=${() => { _taskDetailId = null; _rerender(); }}>✕</button>
          </div>
          <div class="modal-body">
            <ib-people-chips class="task-people" style="margin:0 0 12px" .client=${props.client} objectType="task" objectId=${detailTask.id}></ib-people-chips>
            ${detailTask.description ? html`<div class="detail-desc">${detailTask.description}</div>` : nothing}
            <div class="detail-grid">
              <div class="detail-item">
                <label>Status</label>
                <select class="form-select" .value=${detailTask.status}
                  @change=${(e: Event) => { props.onUpdateTask(detailTask.id, { status: (e.target as HTMLSelectElement).value as TaskStatus }); _rerender(); }}>
                  ${[...GLOBAL_TASK_COLUMNS, { id: "done" as TaskStatus, label: "Done", color: "" }].map(c => html`<option value=${c.id} ?selected=${detailTask.status === c.id}>${c.label}</option>`)}
                </select>
              </div>
              <div class="detail-item">
                <label>Priority</label>
                <span class="detail-value" style="color: ${pri.color}">${pri.dot} ${priKey}</span>
              </div>
              ${project && project.id !== "default" ? html`
                <div class="detail-item">
                  <label>Project</label>
                  <button class="btn-link" @click=${() => { _taskDetailId = null; props.onEnterProject(project.id); _rerender(); }}>${icons.folder} ${project.name}</button>
                </div>
              ` : nothing}
              ${detailTask.assignee ? html`<div class="detail-item"><label>Assignee</label><span class="detail-value">${icons.person} ${detailTask.assignee}</span></div>` : nothing}
              ${detailTask.dueDate ? html`<div class="detail-item"><label>Due Date</label><span class="detail-value ${_isDueOverdue(detailTask.dueDate) ? 'gt-due-overdue' : ''}">${icons.calendar} ${detailTask.dueDate}</span></div>` : nothing}
              ${detailTask.projectType ? html`<div class="detail-item"><label>Project Type</label><span class="detail-value">${detailTask.projectType}</span></div>` : nothing}
              ${detailTask.classification ? html`<div class="detail-item"><label>Classification</label><span class="detail-value">${detailTask.classification}</span></div>` : nothing}
              ${detailTask.funnelStage ? html`<div class="detail-item"><label>Funnel Stage</label><span class="detail-value">${detailTask.funnelStage}</span></div>` : nothing}
            </div>
            ${detailTask.department?.length ? html`
              <div style="margin-top: 12px">
                <label class="form-label">Department</label>
                <div class="detail-chips" style="margin-top: 4px">${detailTask.department.map(d => html`<span class="task-dept-chip">${d}</span>`)}</div>
              </div>
            ` : nothing}
            ${detailTask.notionId ? html`
              <div style="margin-top: 12px">
                <a href="https://notion.so/${detailTask.notionId.replace(/-/g, '')}" target="_blank" class="detail-link">Open in Notion ↗</a>
              </div>
            ` : nothing}
            ${(props.fedNodes?.length ?? 0) > 0 ? html`
              <div style="margin-top:16px;">
                ${renderFederationNodeMultiSelect({
                  value: federationNodeIds(detailTask),
                  nodes: props.fedNodes ?? [],
                  label: "Devices",
                  onChange: (ids) => {
                    props.onUpdateTask(
                      detailTask.id,
                      { nodeIds: ids.length > 0 ? ids : undefined } as Partial<KanbanTask> & FederationAssignable,
                    );
                    _rerender();
                  },
                })}
              </div>
            ` : nothing}
            ${renderTaskDocSection(detailTask.id, props.client)}
          </div>
          <div class="modal-footer">
            <button class="btn-danger" @click=${() => {
              if (confirm("Delete this task?")) {
                props.onDeleteTask(detailTask.id);
                _taskDetailId = null;
                _rerender();
              }
            }}>Delete</button>
            <button style="background: #22c55e; color: #000; font-weight: 600; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 6px"
              @click=${() => { _taskDetailId = null; openRunDialog(props.client, { task: { id: detailTask.id, title: detailTask.title, description: detailTask.description, projectId: detailTask.projectId } }); }}>▶ Run</button>
            <button class="btn-secondary" @click=${() => { _taskDetailId = null; _rerender(); }}>Close</button>
          </div>
        </div>
      </div>
    `;
  };

  return html`
    ${renderGlobalTaskDetail()}
    <div class="gt-toolbar" data-learn-id="tasks-toolbar">
      <div class="gt-toolbar-left">
        <div class="gt-stats">
          <span class="gt-stat-active">${totalCount} active</span>
          <span class="gt-stat-done">${doneCount} done</span>
        </div>
        <input type="text" class="gt-search" data-learn-id="tasks-search" placeholder="Search tasks..."
          .value=${_globalTasksSearch}
          @input=${(e: Event) => { _globalTasksSearch = (e.target as HTMLInputElement).value; _rerender(); }} />
        <select class="gt-filter-select" data-learn-id="tasks-priority" .value=${_globalTasksPriority}
          @change=${(e: Event) => { _globalTasksPriority = (e.target as HTMLSelectElement).value; _rerender(); }}>
          <option value="all">All Priorities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        ${assignees.size > 0 ? html`
          <select class="gt-filter-select" .value=${_globalTasksAssignee}
            @change=${(e: Event) => { _globalTasksAssignee = (e.target as HTMLSelectElement).value; _rerender(); }}>
            <option value="all">All Assignees</option>
            ${[...assignees].sort().map(a => html`<option value=${a}>${a}</option>`)}
          </select>
        ` : nothing}
        ${departments.size > 0 ? html`
          <select class="gt-filter-select" .value=${_globalTasksDepartment}
            @change=${(e: Event) => { _globalTasksDepartment = (e.target as HTMLSelectElement).value; _rerender(); }}>
            <option value="all">All Depts</option>
            ${[...departments].sort().map(d => html`<option value=${d}>${d}</option>`)}
          </select>
        ` : nothing}
      </div>
      <div class="gt-toolbar-right">
        ${props.onNotionSync ? html`
          <button class="btn-notion-sync ${props.notionSyncStatus?.syncing ? 'syncing' : ''}"
            @click=${() => props.onNotionSync?.()}
            ?disabled=${props.notionSyncStatus?.syncing}
            title="Sync with Notion">
            <span class="notion-sync-icon">${props.notionSyncStatus?.syncing ? "⟳" : icons.fileText}</span>
            <span>Sync to Notion</span>
          </button>
        ` : nothing}
        <button class="btn-notion-sync"
          style="border-color:rgba(167,139,250,0.3); color:#c4b5fd;"
          @click=${() => requestChangeNotionDb("tasks", props.notionSyncStatus?.tasksDbId ?? null)}
          title="Swap which Notion database drives Tasks">
          <span class="notion-sync-icon">⇄</span>
          <span>Change DB</span>
        </button>
        <label class="gt-toggle-done" data-learn-id="tasks-show-done">
          <input type="checkbox" data-learn-id="tasks-show-done-input" .checked=${_globalTasksShowDone}
            @change=${(e: Event) => { _globalTasksShowDone = (e.target as HTMLInputElement).checked; _rerender(); }} />
          <span>Show done</span>
        </label>
      </div>
    </div>
    <div class="gt-board" data-learn-id="tasks-board" style="--cols: ${buildGridTemplate("gt", [...columns.map(c => c.id), "autonomous"])}">
      ${columns.map(col => {
        const colTasks = tasksByStatus[col.id] ?? [];
        const isDragOver = _globalTasksDragOverCol === col.id;
        const showEmptyDropZone = isDragOver && colTasks.length === 0;
        const showEndDropIndicator = isDragOver &&
          colTasks.length > 0 &&
          _globalTasksDragOverPosition === colTasks.length &&
          _globalTasksDragId;
        const gtAllIds = [...columns.map(c => c.id), "autonomous"];
        return html`
          <div class="gt-column ${isDragOver ? 'gt-col-drag-over' : ''}"
            @dragover=${(e: DragEvent) => handleDragOver(e, col.id)}
            @dragleave=${(e: DragEvent) => handleDragLeave(e, col.id)}
            @drop=${(e: DragEvent) => handleDrop(e, col.id)}>
            <div class="gt-column-header" style="border-top-color: ${col.color}">
              <span class="column-title" style="color: ${col.color}">${col.label}</span>
              <span class="column-count">${colTasks.length}</span>
            </div>
            <div class="gt-column-content">
              ${colTasks.map((task, index) => renderGlobalTaskCard(task, index, col.id))}
              ${showEndDropIndicator ? html`<div class="gt-drop-indicator gt-drop-indicator-end"><div class="gt-drop-indicator-line"></div></div>` : nothing}
              <div class="gt-drop-zone ${showEmptyDropZone ? 'gt-drop-active' : ''}">
                <span class="gt-drop-zone-icon">+</span>
                <span>Drop task here</span>
              </div>
            </div>
            <div class="col-resize-handle" title="Drag to resize"
              @pointerdown=${(e: PointerEvent) => startColumnResize(e, "gt", col.id, gtAllIds, ".gt-board")}></div>
          </div>
        `;
      })}

      <!-- Autonomous Column (shows duplicates of tasks assigned to agent) -->
      <div data-learn-id="tasks-autonomous" class="gt-column gt-column-autonomous ${_globalTasksDragOverCol === 'autonomous' ? 'gt-col-drag-over' : ''}"
        @dragover=${(e: DragEvent) => handleAutonomousDragOver(e)}
        @dragleave=${(e: DragEvent) => handleAutonomousDragLeave(e)}
        @drop=${(e: DragEvent) => handleDrop(e, "autonomous")}>
        <div class="gt-column-header" style="border-top-color: ${AUTONOMOUS_COLUMN.color}">
          <span class="column-title" style="color: ${AUTONOMOUS_COLUMN.color}">${AUTONOMOUS_COLUMN.label}</span>
          <span class="column-count">${autonomousTasks.length}</span>
        </div>
        <div class="gt-column-content">
          ${autonomousTasks.map((task, index) => {
            const project = projectMap.get(task.projectId);
            const isDragging = _globalTasksDragId === task.id;
            const autoStatus = AUTONOMOUS_STATUS_CONFIG[task.autonomousStatus || "pending_preflight"] || AUTONOMOUS_STATUS_CONFIG["pending_preflight"];
            const statusCol = STATUS_COLUMNS.find(c => c.id === task.status) || GLOBAL_TASK_COLUMNS.find(c => c.id === task.status);
            
            return html`
              <div class="gt-card gt-card-autonomous ${isDragging ? 'gt-dragging' : ''}"
                @click=${() => { _taskDetailId = task.id; _rerender(); }}
                @contextmenu=${(e: MouseEvent) => openContextMenu(e, { type: "task", task }, props.onRequestUpdate)}
                @touchstart=${(e: TouchEvent) => handleTouchStart(e, { type: "task", task }, props.onRequestUpdate)}
                @touchmove=${handleTouchMove}
                @touchend=${handleTouchEnd}
                @touchcancel=${handleTouchEnd}>
                <div class="gt-card-header">
                  <span class="gt-card-title">${task.title}</span>
                  <div class="gt-card-header-right">
                    <button class="gt-auto-remove" title="Remove from autonomous queue"
                      @click=${(e: Event) => { e.stopPropagation(); removeFromAutonomous(task.id); }}>✕</button>
                  </div>
                </div>
                <div class="gt-auto-status" style="color: ${autoStatus.color}">
                  ${autoStatus.icon} ${(task.autonomousStatus || "pending_preflight").replace(/_/g, " ")}
                </div>
                <div class="gt-card-footer">
                  ${statusCol ? html`
                    <span class="gt-auto-original-status" style="color: ${statusCol.color}">
                      ◉ ${statusCol.label}
                    </span>
                  ` : nothing}
                  ${project && project.id !== "default" ? html`
                    <span class="gt-card-project" title="${project.name}"
                      @click=${(e: Event) => { e.stopPropagation(); props.onEnterProject(project.id); }}>
                      ${icons.folder} ${project.name.length > 15 ? project.name.slice(0, 15) + "…" : project.name}
                    </span>
                  ` : nothing}
                </div>
              </div>
            `;
          })}
          <div class="gt-drop-zone gt-drop-zone-autonomous ${_globalTasksDragOverCol === 'autonomous' && autonomousTasks.length === 0 ? 'gt-drop-active' : ''}">
            <span class="gt-drop-zone-icon">${icons.bot}</span>
            <span>Drop to assign to agent</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ── Projects Kanban View ──────────────────────────────────
const PROJECT_KANBAN_COLUMNS: { id: string; label: string; color: string; statuses: string[] }[] = [
  { id: "not_started", label: "Not Started", color: "#9ca3af", statuses: ["Not started"] },
  { id: "in_progress", label: "In Progress", color: "#3b82f6", statuses: ["In progress", "Updating"] },
  { id: "review", label: "Review / Waiting", color: "#f97316", statuses: ["Reviewing", "Awaiting Client"] },
  { id: "paused", label: "Paused", color: "#a855f7", statuses: ["Paused"] },
  { id: "completed", label: "Completed", color: "#10b981", statuses: ["Completed"] },
  { id: "cancelled", label: "Cancelled", color: "#ef4444", statuses: ["Cancelled"] },
];

function renderProjectsKanban(props: KanbanViewProps, filtered: KanbanProject[]) {
  const projectsByCol: Record<string, KanbanProject[]> = {};
  for (const col of PROJECT_KANBAN_COLUMNS) projectsByCol[col.id] = [];

  for (const project of filtered) {
    const status = project.status || "Not started";
    const col = PROJECT_KANBAN_COLUMNS.find(c => c.statuses.includes(status));
    if (col) {
      projectsByCol[col.id].push(project);
    } else {
      projectsByCol["not_started"].push(project);
    }
  }

  // Map column ID back to a valid ProjectStatus for DnD
  const colIdToStatus: Record<string, string> = {
    "not_started": "Not started",
    "in_progress": "In progress",
    "review": "Reviewing",
    "paused": "Paused",
    "completed": "Completed",
    "cancelled": "Cancelled",
  };

  const handleDragStart = (e: DragEvent, projectId: string) => {
    e.dataTransfer?.setData("text/plain", projectId);
    e.dataTransfer!.effectAllowed = "move";
    _projectKanbanDragId = projectId;
    _kanbanActiveDrag = true;
    _rerender();
    requestAnimationFrame(() => {
      (e.target as HTMLElement).classList.add("pk-dragging");
    });
  };

  const handleDragEnd = () => {
    _kanbanActiveDrag = false;
    if (_kanbanDragRafId !== null) { cancelAnimationFrame(_kanbanDragRafId); _kanbanDragRafId = null; }
    _projectKanbanDragId = null;
    _projectKanbanDragOverCol = null;
    _rerender();
  };

  const handleDragOver = (e: DragEvent, colId: string) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (_projectKanbanDragOverCol !== colId) {
      _projectKanbanDragOverCol = colId;
      if (_kanbanDragRafId !== null) cancelAnimationFrame(_kanbanDragRafId);
      _kanbanDragRafId = requestAnimationFrame(() => { _kanbanDragRafId = null; _rerender(); });
    }
  };

  const handleDragLeave = (e: DragEvent, colId: string) => {
    const relTarget = e.relatedTarget as HTMLElement | null;
    const colEl = e.currentTarget as HTMLElement;
    if (relTarget && colEl.contains(relTarget)) return;
    if (_projectKanbanDragOverCol === colId) {
      _projectKanbanDragOverCol = null;
      if (_kanbanDragRafId !== null) cancelAnimationFrame(_kanbanDragRafId);
      _kanbanDragRafId = requestAnimationFrame(() => { _kanbanDragRafId = null; _rerender(); });
    }
  };

  const handleDrop = (e: DragEvent, colId: string) => {
    e.preventDefault();
    const projectId = e.dataTransfer?.getData("text/plain");
    _kanbanActiveDrag = false;
    if (_kanbanDragRafId !== null) { cancelAnimationFrame(_kanbanDragRafId); _kanbanDragRafId = null; }
    _projectKanbanDragId = null;
    _projectKanbanDragOverCol = null;
    _rerender();

    if (!projectId) return;
    const newStatus = colIdToStatus[colId];
    if (!newStatus) return;
    const project = filtered.find(p => p.id === projectId);
    if (!project || project.status === newStatus) return;
    props.onUpdateProject(projectId, { status: newStatus as any });
  };

  const renderProjectKanbanCard = (project: KanbanProject) =>
    renderProjectGalleryCard(project, props, {
      draggable: true,
      isDragging: _projectKanbanDragId === project.id,
      onDragStart: (e: DragEvent) => handleDragStart(e, project.id),
      onDragEnd: () => handleDragEnd(),
    });

  return html`
    <div class="pk-board" data-learn-id="projects-kanban-board" style="--cols: ${buildGridTemplate("pk", PROJECT_KANBAN_COLUMNS.map(c => c.id))}">
      ${PROJECT_KANBAN_COLUMNS.map((col, idx) => {
        const projects = projectsByCol[col.id] ?? [];
        const isDragOver = _projectKanbanDragOverCol === col.id;
        const isLast = idx === PROJECT_KANBAN_COLUMNS.length - 1;
        return html`
          <div class="pk-column ${isDragOver ? 'pk-col-drag-over' : ''}"
            @dragover=${(e: DragEvent) => handleDragOver(e, col.id)}
            @dragleave=${(e: DragEvent) => handleDragLeave(e, col.id)}
            @drop=${(e: DragEvent) => handleDrop(e, col.id)}>
            <div class="pk-column-header" style="border-top-color: ${col.color}">
              <span class="column-title" style="color: ${col.color}">${col.label}</span>
              <span class="column-count">${projects.length}</span>
            </div>
            <div class="pk-column-content">
              ${projects.map(renderProjectKanbanCard)}
              <div class="pk-drop-zone ${isDragOver ? 'pk-drop-active' : ''}">DROP HERE</div>
            </div>
            ${!isLast ? html`
              <div class="col-resize-handle" title="Drag to resize"
                @pointerdown=${(e: PointerEvent) => startColumnResize(e, "pk", col.id, PROJECT_KANBAN_COLUMNS.map(c => c.id), ".pk-board")}></div>
            ` : nothing}
          </div>
        `;
      })}
    </div>
  `;
}

// ── Board View (Kanban) ──────────────────────────────────
// ── Notion Content Rendering ──────────────────────────────────

async function fetchProjectBlocks(props: KanbanViewProps, notionId: string, projectId: string) {
  if (_notionBlocksProjectId === projectId && _notionBlocks.length > 0) return;
  if (_notionBlocksLoading || !props.onFetchNotionBlocks) return;
  _notionBlocksLoading = true;
  _notionBlocksProjectId = projectId;
  _rerender();
  try {
    const result = await props.onFetchNotionBlocks(notionId);
    _notionBlocks = result?.blocks || [];
    _notionSubPages = result?.subPages || [];
    _notionBlocksLoading = false;
    _rerender();
  } catch (err) {
    console.error("Failed to fetch notion blocks:", err);
    _notionBlocksLoading = false;
    _rerender();
  }
}

async function fetchProjectAttachments(props: KanbanViewProps, projectId: string, force = false) {
  if (!force && _attachmentsProjectId === projectId && _attachments.length > 0) return;
  if (_attachmentsLoading) return;
  const client = props.client;
  if (!client?.request) return;
  _attachmentsLoading = true;
  _attachmentsProjectId = projectId;
  _attachmentsError = null;
  _rerender();
  try {
    const content = await client.request("kanban.projects.content.get", { projectId });
    _attachments = Array.isArray(content?.attachments) ? content.attachments : [];
  } catch (err) {
    console.error("Failed to fetch project attachments:", err);
    _attachmentsError = String((err as any)?.message ?? err);
    _attachments = [];
  } finally {
    _attachmentsLoading = false;
    _rerender();
  }
}

async function fetchProjectNotes(client: any, projectId: string, force = false) {
  if (!force && _projectNotesProjectId === projectId) return;
  if (_projectNotesLoading) return;
  if (!client?.request) return;
  _projectNotesLoading = true;
  _projectNotesProjectId = projectId;
  _projectNotesError = null;
  _rerender();
  try {
    const [res, ideasRes] = (await Promise.all([
      client.request("notes.list", { projectId }),
      client.request("ideas.list", { projectId, limit: 200 }).catch(() => null),
    ])) as any[];
    _projectNotes = res?.notes ?? [];
    // Filter client-side too: a gateway without the projectId filter returns every idea.
    _projectIdeas = ((ideasRes?.ideas ?? []) as typeof _projectIdeas).filter((i) =>
      (i.projectIds ?? []).includes(projectId),
    );
  } catch (err) {
    console.error("Failed to fetch project notes:", err);
    _projectNotesError = String((err as any)?.message ?? err);
    _projectNotes = [];
    _projectIdeas = [];
  } finally {
    _projectNotesLoading = false;
    _rerender();
  }
}

const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

const ACCEPTED_ATTACHMENT_EXTENSIONS = new Set([
  ".pdf", ".docx", ".doc",
  ".txt", ".md", ".markdown", ".rst",
  ".csv", ".tsv",
  ".json", ".yaml", ".yml", ".toml", ".xml",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".svg", ".bmp",
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".rb", ".php",
  ".java", ".c", ".cpp", ".h", ".cs", ".swift", ".kt", ".sh", ".bash",
  ".sql", ".graphql", ".html", ".htm", ".css", ".scss", ".vue", ".svelte",
]);

function getFileExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

async function uploadProjectAttachment(props: KanbanViewProps, projectId: string, file: File) {
  const client = props.client;
  if (!client?.request) {
    _attachmentsError = "Gateway client unavailable";
    _rerender();
    return;
  }

  // Client-side validation before sending large payload
  const fileExt = getFileExtension(file.name);
  if (!ACCEPTED_ATTACHMENT_EXTENSIONS.has(fileExt) && !file.type.startsWith("image/")) {
    _attachmentsError = `File type "${fileExt || file.type || "unknown"}" is not accepted. Accepted: PDF, images, text, markdown, docx, code, CSV.`;
    _rerender();
    return;
  }
  if (file.size > ATTACHMENT_MAX_BYTES) {
    _attachmentsError = `File exceeds the 50 MB limit (${Math.round(file.size / 1024 / 1024)} MB).`;
    _rerender();
    return;
  }

  _attachmentUploading = true;
  _attachmentsError = null;
  _rerender();
  try {
    // Read file as base64 (strip the data URL prefix)
    const base64: string = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const result = reader.result as string;
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.readAsDataURL(file);
    });

    // Atomic upload: single RPC handles file write + DB insert.
    // Falls back to legacy two-step for older gateways that don't have the handler.
    let att: ProjectAttachmentRow | null = null;
    try {
      att = await client.request("kanban.projects.content.uploadAttachment", {
        projectId,
        name: file.name,
        content: base64,
        mimeType: file.type || undefined,
      }) as ProjectAttachmentRow;
    } catch (atomicErr: any) {
      if (String(atomicErr?.message ?? atomicErr).includes("Unknown method")) {
        // Legacy fallback: two-step
        const safeName = file.name.replace(/[\\/]+/g, "_");
        const uploadPath = `projects/${projectId}/${Date.now()}_${safeName}`;
        const uploaded = await client.request("files.upload", { path: uploadPath, content: base64 });
        att = await client.request("kanban.projects.content.addAttachment", {
          projectId,
          name: file.name,
          path: uploaded?.path ?? uploadPath,
          size: uploaded?.size ?? file.size,
          mimeType: file.type || undefined,
        }) as ProjectAttachmentRow;
      } else {
        throw atomicErr;
      }
    }

    if (!att) throw new Error("Upload succeeded but server returned no attachment record");
    await fetchProjectAttachments(props, projectId, true);
  } catch (err) {
    console.error("Failed to upload attachment:", err);
    _attachmentsError = String((err as any)?.message ?? err);
  } finally {
    _attachmentUploading = false;
    _rerender();
  }
}

async function removeProjectAttachment(props: KanbanViewProps, projectId: string, attachmentId: string) {
  const client = props.client;
  if (!client?.request) return;
  try {
    await client.request("kanban.projects.content.removeAttachment", { attachmentId });
    _attachments = _attachments.filter((a) => a.id !== attachmentId);
    _rerender();
  } catch (err) {
    console.error("Failed to remove attachment:", err);
    _attachmentsError = String((err as any)?.message ?? err);
    _rerender();
  }
}

async function downloadProjectAttachment(props: KanbanViewProps, attachment: ProjectAttachmentRow) {
  const client = props.client;
  if (!client?.request) return;
  try {
    const res = await client.request("files.download", { path: attachment.path });
    const base64 = res?.content;
    if (!base64) throw new Error("No content returned");
    const byteChars = atob(base64);
    const byteNums = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNums[i] = byteChars.charCodeAt(i);
    const blob = new Blob([new Uint8Array(byteNums)], { type: attachment.mimeType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = attachment.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    console.error("Failed to download attachment:", err);
    _attachmentsError = String((err as any)?.message ?? err);
    _rerender();
  }
}

function detectPreviewKind(att: ProjectAttachmentRow): PreviewKind {
  const mt = (att.mimeType || "").toLowerCase();
  const ext = (att.name.split(".").pop() || "").toLowerCase();
  if (mt === "text/markdown" || ext === "md" || ext === "markdown") return "markdown";
  if (mt === "application/pdf" || ext === "pdf") return "pdf";
  if (mt.startsWith("image/") || ["png","jpg","jpeg","gif","webp","svg","bmp","ico"].includes(ext)) return "image";
  if (mt.startsWith("text/") || ["txt","log","csv","tsv","json","yaml","yml","toml","ini","env","ts","tsx","js","jsx","mjs","cjs","py","rs","go","java","rb","php","c","cpp","h","hpp","sh","bash","sql","html","css","scss","xml"].includes(ext)) return "text";
  return "unknown";
}

// renderPreviewMarkdownHtml consolidated into toSanitizedMarkdownHtml (canonical renderer).

async function openFilePreview(props: KanbanViewProps, att: ProjectAttachmentRow) {
  const client = props.client;
  if (!client?.request) return;
  // Release any prior blob URL before overwriting
  if (_preview.blobUrl) {
    try { URL.revokeObjectURL(_preview.blobUrl); } catch { /* ignore */ }
  }
  const kind = detectPreviewKind(att);
  _preview = { att, kind, loading: true, error: null, text: null, blobUrl: null, pdfTotalPages: null };
  // Bind Esc-to-close once per open
  if (!_previewKeyHandler) {
    _previewKeyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && _preview.att) closeFilePreview();
    };
    window.addEventListener("keydown", _previewKeyHandler);
  }
  _rerender();

  try {
    const res = await client.request("files.download", { path: att.path });
    const base64 = res?.content;
    if (!base64) throw new Error("No content returned");
    if (kind === "markdown" || kind === "text") {
      // Decode UTF-8 from base64
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      _preview.text = new TextDecoder("utf-8").decode(bytes);
    } else {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const mime = att.mimeType || (kind === "pdf" ? "application/pdf" : "application/octet-stream");
      const blob = new Blob([bytes], { type: mime });
      _preview.blobUrl = URL.createObjectURL(blob);
    }
  } catch (err) {
    console.error("Failed to load file preview:", err);
    _preview.error = String((err as any)?.message ?? err);
  } finally {
    _preview.loading = false;
    _rerender();
  }
}

function closeFilePreview() {
  if (_preview.blobUrl) {
    try { URL.revokeObjectURL(_preview.blobUrl); } catch { /* ignore */ }
  }
  _preview = { att: null, kind: "unknown", loading: false, error: null, text: null, blobUrl: null, pdfTotalPages: null };
  if (_previewKeyHandler) {
    window.removeEventListener("keydown", _previewKeyHandler);
    _previewKeyHandler = null;
  }
  _rerender();
}

async function mountPdfPages(host: HTMLElement, blobUrl: string): Promise<void> {
  host.innerHTML = '<div class="kb-pdf-loading">Rendering PDF…</div>';
  try {
    const pdfjs = await loadPdfjs();
    if (_preview.blobUrl !== blobUrl) return; // user closed before worker finished
    const pdf = await pdfjs.getDocument(blobUrl).promise;
    if (_preview.blobUrl !== blobUrl) return;
    _preview.pdfTotalPages = pdf.numPages;
    host.innerHTML = "";
    const containerWidth = host.clientWidth || 800;
    for (let n = 1; n <= pdf.numPages; n++) {
      if (_preview.blobUrl !== blobUrl) return;
      const page = await pdf.getPage(n);
      const baseVp = page.getViewport({ scale: 1 });
      const scale = Math.max(1, (containerWidth - 24) / baseVp.width);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.className = "kb-pdf-page";
      canvas.dataset.page = String(n);
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      host.appendChild(canvas);
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      await page.render({ canvasContext: ctx, viewport, canvas } as Parameters<typeof page.render>[0]).promise;
    }
  } catch (err) {
    const msg = (err as { message?: string })?.message ?? String(err);
    host.innerHTML = "";
    const div = document.createElement("div");
    div.className = "kb-preview-status kb-preview-error";
    div.textContent = `PDF render failed: ${msg}`;
    host.appendChild(div);
  }
}

function renderFilePreviewModal(props: KanbanViewProps) {
  const att = _preview.att;
  if (!att) return nothing;
  const { kind, loading, error, text, blobUrl } = _preview;

  let body;
  if (loading) {
    body = html`<div class="kb-preview-status">Loading ${att.name}…</div>`;
  } else if (error) {
    body = html`
      <div class="kb-preview-status kb-preview-error">
        <div style="font-size:32px;margin-bottom:8px;">${icons.alertCircle}</div>
        <div>Failed to load preview</div>
        <div class="kb-preview-error-detail">${error}</div>
      </div>
    `;
  } else if (kind === "markdown" && text != null) {
    body = html`<div class="kb-preview-markdown md-body">${unsafeHTML(toSanitizedMarkdownHtml(text))}</div>`;
  } else if (kind === "pdf" && blobUrl) {
    const pdfBlobUrl = blobUrl;
    body = html`<div class="kb-preview-pdf-host" ${ref((el) => {
      if (!(el instanceof HTMLElement)) return;
      // ref fires on every render — only mount once per blob URL.
      if (el.dataset.mountedFor === pdfBlobUrl) return;
      el.dataset.mountedFor = pdfBlobUrl;
      void mountPdfPages(el, pdfBlobUrl);
    })}></div>`;
  } else if (kind === "image" && blobUrl) {
    body = html`<div class="kb-preview-image-wrap"><img class="kb-preview-image" src=${blobUrl} alt=${att.name} /></div>`;
  } else if (kind === "text" && text != null) {
    body = html`<pre class="kb-preview-text">${text}</pre>`;
  } else {
    body = html`
      <div class="kb-preview-status">
        <div style="font-size:32px;margin-bottom:8px;">${fileIconFor(att)}</div>
        <div>Preview not available for this file type</div>
        <button class="btn-primary" style="margin-top:14px;"
          @click=${() => downloadProjectAttachment(props, att)}>↓ Download</button>
      </div>
    `;
  }

  return html`
    <div class="kb-preview-backdrop" @click=${closeFilePreview}>
      <div class="kb-preview-modal" @click=${(e: Event) => e.stopPropagation()}>
        <header class="kb-preview-header">
          <span class="kb-preview-icon">${fileIconFor(att)}</span>
          <div class="kb-preview-titles">
            <div class="kb-preview-title" title=${att.path}>${att.name}</div>
            <div class="kb-preview-subtitle">
              <span>${formatFileSize(att.size)}</span>
              <span>·</span>
              <span>${new Date(att.createdAt).toLocaleString()}</span>
              ${att.mimeType ? html`<span>·</span><span>${att.mimeType}</span>` : nothing}
            </div>
          </div>
          <div class="kb-preview-actions">
            <button class="btn-icon" title="Download" @click=${() => downloadProjectAttachment(props, att)}>↓</button>
            <button class="btn-icon" title="Close (Esc)" @click=${closeFilePreview}>✕</button>
          </div>
        </header>
        <div class="kb-preview-body kb-preview-body-${kind}">${body}</div>
      </div>
    </div>
  `;
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function fileIconFor(att: ProjectAttachmentRow): string {
  const mt = (att.mimeType || "").toLowerCase();
  const ext = att.name.split(".").pop()?.toLowerCase() || "";
  if (mt.startsWith("image/") || ["png","jpg","jpeg","gif","webp","svg","ico","bmp"].includes(ext)) return "🖼️";
  if (mt.startsWith("video/") || ["mp4","mov","webm","mkv","avi"].includes(ext)) return "🎬";
  if (mt.startsWith("audio/") || ["mp3","wav","ogg","flac","m4a"].includes(ext)) return "🎵";
  if (["pdf"].includes(ext)) return "📕";
  if (["zip","tar","gz","7z","rar"].includes(ext)) return "🗜️";
  if (["md","txt","rtf"].includes(ext)) return "📄";
  if (["doc","docx","xls","xlsx","ppt","pptx","csv"].includes(ext)) return "📊";
  if (["ts","tsx","js","jsx","py","rs","go","java","rb","php","c","cpp","h","sh","json","yaml","yml","html","css"].includes(ext)) return "💻";
  return "📎";
}

async function fetchSubPageBlocks(props: KanbanViewProps, pageId: string, title: string) {
  if (_subPageBlocks[pageId]) {
    _viewingSubPageId = pageId;
    _viewingSubPageTitle = title;
    _rerender();
    return;
  }
  if (!props.onFetchNotionBlocks) return;
  _subPageBlocksLoading = pageId;
  _viewingSubPageId = pageId;
  _viewingSubPageTitle = title;
  _rerender();
  try {
    const result = await props.onFetchNotionBlocks(pageId);
    _subPageBlocks[pageId] = result?.blocks || [];
    _subPageBlocksLoading = null;
    _rerender();
  } catch (err) {
    console.error("Failed to fetch sub-page blocks:", err);
    _subPageBlocksLoading = null;
    _rerender();
  }
}

function renderRichText(richText: any[]): string {
  if (!richText || !Array.isArray(richText) || richText.length === 0) return "";
  return richText.map((rt: any) => {
    let text = rt.text?.content || rt.plain_text || "";
    text = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    text = text.replace(/\n/g, "<br>");
    const ann = rt.annotations || {};
    if (ann.code) text = `<code class="nb-inline-code">${text}</code>`;
    if (ann.bold) text = `<strong>${text}</strong>`;
    if (ann.italic) text = `<em>${text}</em>`;
    if (ann.strikethrough) text = `<s>${text}</s>`;
    if (ann.underline) text = `<u>${text}</u>`;
    if (ann.color && ann.color !== "default") {
      const colorMap: Record<string, string> = {
        gray: "#9ca3af", brown: "#a8856c", orange: "#f97316", yellow: "#eab308",
        green: "#22c55e", blue: "#3b82f6", purple: "#a855f7", pink: "#ec4899", red: "#ef4444",
        gray_background: "#374151", brown_background: "#44403c", orange_background: "#431407",
        yellow_background: "#422006", green_background: "#14532d", blue_background: "#1e3a5f",
        purple_background: "#3b0764", pink_background: "#500724", red_background: "#450a0a",
      };
      const c = colorMap[ann.color];
      if (c) {
        if (ann.color.includes("background")) {
          text = `<span style="background:${c};padding:1px 4px;border-radius:3px">${text}</span>`;
        } else {
          text = `<span style="color:${c}">${text}</span>`;
        }
      }
    }
    if (rt.href) text = `<a href="${rt.href}" target="_blank" class="nb-link">${text}</a>`;
    return text;
  }).join("");
}

function renderNotionBlock(block: any, props: KanbanViewProps, depth: number = 0): string {
  const data = block.data || {};
  const type = block.type;
  const richText = data.rich_text;
  const textContent = renderRichText(richText);
  const childrenHtml = block.children?.map((c: any) => renderNotionBlock(c, props, depth + 1)).join("") || "";
  const indent = depth > 0 ? ` style="margin-left:${depth * 24}px"` : "";

  switch (type) {
    case "paragraph":
      if (!textContent) return `<div class="nb-spacer"></div>`;
      return `<p class="nb-paragraph"${indent}>${textContent}</p>`;

    case "heading_1":
      return `<h1 class="nb-h1"${indent}>${textContent}</h1>`;
    case "heading_2":
      return `<h2 class="nb-h2"${indent}>${textContent}</h2>`;
    case "heading_3":
      return `<h3 class="nb-h3"${indent}>${textContent}</h3>`;

    case "bulleted_list_item":
      return `<div class="nb-list nb-bullet"${indent}><span class="nb-bullet-dot">•</span><div class="nb-list-content">${textContent}${childrenHtml}</div></div>`;

    case "numbered_list_item":
      return `<div class="nb-list nb-numbered"${indent}><div class="nb-list-content">${textContent}${childrenHtml}</div></div>`;

    case "to_do": {
      const checked = data.checked ? "checked" : "";
      const cls = data.checked ? "nb-todo-done" : "";
      return `<div class="nb-list nb-todo ${cls}"${indent}><span class="nb-todo-check">${data.checked ? "☑" : "☐"}</span><div class="nb-list-content">${textContent}</div></div>`;
    }

    case "toggle": {
      const expanded = _expandedToggles.has(block.id);
      return `<div class="nb-toggle"${indent}>
        <div class="nb-toggle-header" data-toggle-id="${block.id}">
          <span class="nb-toggle-arrow ${expanded ? "nb-toggle-open" : ""}">▶</span>
          <span class="nb-toggle-text">${textContent}</span>
        </div>
        ${expanded ? `<div class="nb-toggle-content">${childrenHtml}</div>` : ""}
      </div>`;
    }

    case "quote":
      return `<blockquote class="nb-quote"${indent}>${textContent}${childrenHtml}</blockquote>`;

    case "callout": {
      const icon = data.icon?.emoji || data.icon?.external?.url ? `<img src="${data.icon.external.url}" class="nb-callout-icon-img">` : "💡";
      return `<div class="nb-callout"${indent}><span class="nb-callout-icon">${typeof icon === "string" && !icon.startsWith("<") ? icon : ""}</span><div class="nb-callout-content">${textContent}${childrenHtml}</div></div>`;
    }

    case "code": {
      const lang = data.language || "";
      const codeText = richText?.map((rt: any) => (rt.text?.content || rt.plain_text || "")).join("") || "";
      const escaped = codeText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<div class="nb-code-wrapper"${indent}>${lang ? `<span class="nb-code-lang">${lang}</span>` : ""}<pre class="nb-code"><code>${escaped}</code></pre></div>`;
    }

    case "image": {
      const url = data.file?.url || data.external?.url || "";
      const caption = data.caption ? renderRichText(data.caption) : "";
      return `<div class="nb-image-wrapper"${indent}>${url ? `<img src="${url}" class="nb-image" loading="lazy">` : ""}${caption ? `<p class="nb-caption">${caption}</p>` : ""}</div>`;
    }

    case "file": {
      const url = data.file?.url || data.external?.url || "";
      const name = data.name || data.caption?.[0]?.plain_text || "File";
      const ext = name.split(".").pop()?.toLowerCase() || "";
      const icon = ext === "pdf" ? "📄" : "📎";
      return `<div class="nb-file"${indent}><a href="${url}" target="_blank" class="nb-file-link">${icon} ${name}</a></div>`;
    }

    case "bookmark": {
      const url = data.url || "";
      const caption = data.caption ? renderRichText(data.caption) : "";
      return `<div class="nb-bookmark"${indent}><a href="${url}" target="_blank" class="nb-bookmark-link">🔗 ${caption || url}</a></div>`;
    }

    case "divider":
      return `<hr class="nb-divider">`;

    case "child_page": {
      const title = data.title || "Untitled Page";
      return `<div class="nb-child-page" data-page-id="${block.id}" data-page-title="${title.replace(/"/g, "&quot;")}"${indent}><span class="nb-child-page-icon">📄</span><span class="nb-child-page-title">${title}</span><span class="nb-child-page-arrow">→</span></div>`;
    }

    case "child_database": {
      const title = data.title || "Untitled Database";
      return `<div class="nb-child-database"${indent}><span class="nb-child-db-icon">🗃️</span><span>${title}</span></div>`;
    }

    case "table": {
      const rows = block.children || [];
      if (rows.length === 0) return `<div class="nb-paragraph"${indent}>[Empty table]</div>`;
      let tableHtml = `<div class="nb-table-wrapper"${indent}><table class="nb-table">`;
      rows.forEach((row: any, idx: number) => {
        const cells = row.data?.cells || [];
        const tag = idx === 0 && data.has_column_header ? "th" : "td";
        tableHtml += "<tr>";
        cells.forEach((cell: any) => {
          tableHtml += `<${tag} class="nb-table-cell">${renderRichText(cell)}</${tag}>`;
        });
        tableHtml += "</tr>";
      });
      tableHtml += "</table></div>";
      return tableHtml;
    }

    case "table_row":
      return ""; // handled by table parent

    case "column_list":
      return `<div class="nb-columns"${indent}>${childrenHtml}</div>`;
    case "column":
      return `<div class="nb-column">${childrenHtml}</div>`;

    default:
      if (childrenHtml) return `<div${indent}>${childrenHtml}</div>`;
      return "";
  }
}

function renderNotionContent(props: KanbanViewProps, project: any) {
  if (!project.notionId) {
    return html`<div class="notion-content"><p class="nb-paragraph" style="color:#666">This project has no linked Notion page.</p></div>`;
  }
  if (_notionBlocksLoading) {
    return html`<div class="notion-content"><div class="kanban-loading"><div class="spinner"></div><span>Loading page content...</span></div></div>`;
  }
  if (_notionBlocks.length === 0) {
    return html`<div class="notion-content"><p class="nb-paragraph" style="color:#666">No content found on this page.</p></div>`;
  }

  // If viewing a sub-page
  if (_viewingSubPageId) {
    const blocks = _subPageBlocks[_viewingSubPageId];
    const loading = _subPageBlocksLoading === _viewingSubPageId;
    return html`
      <div class="notion-content">
        <div class="nb-breadcrumb">
          <button class="nb-breadcrumb-btn" @click=${() => { _viewingSubPageId = null; _viewingSubPageTitle = null; _rerender(); }}>
            ${project.name}
          </button>
          <span class="nb-breadcrumb-sep">›</span>
          <span class="nb-breadcrumb-current">${_viewingSubPageTitle || "Sub-page"}</span>
        </div>
        ${loading
          ? html`<div class="kanban-loading"><div class="spinner"></div><span>Loading sub-page...</span></div>`
          : blocks?.length
            ? html`<div class="nb-blocks" .innerHTML=${blocks.map((b: any) => renderNotionBlock(b, props)).join("")}></div>`
            : html`<p class="nb-paragraph" style="color:#666">No content found.</p>`
        }
      </div>
    `;
  }

  const blocksHtml = _notionBlocks.map(b => renderNotionBlock(b, props)).join("");
  return html`
    <div class="notion-content">
      <div class="nb-blocks" .innerHTML=${blocksHtml}></div>
    </div>
  `;
}

function renderSubPagesTab(props: KanbanViewProps, project: any) {
  if (_notionSubPages.length === 0 && _notionBlocks.length === 0) {
    return html`<div class="notion-content"><p class="nb-paragraph" style="color:#666">No sub-pages found.</p></div>`;
  }

  // Gather child_page blocks from _notionBlocks too
  const childPages: { id: string; title: string }[] = [..._notionSubPages.map(sp => ({ id: sp.id, title: sp.title }))];
  function findChildPages(blocks: any[]) {
    for (const b of blocks) {
      if (b.type === "child_page") {
        if (!childPages.find(cp => cp.id === b.id)) {
          childPages.push({ id: b.id, title: b.data?.title || "Untitled" });
        }
      }
      if (b.children) findChildPages(b.children);
    }
  }
  findChildPages(_notionBlocks);

  if (childPages.length === 0) {
    return html`<div class="notion-content"><p class="nb-paragraph" style="color:#666">No sub-pages found.</p></div>`;
  }

  // If viewing a sub-page
  if (_viewingSubPageId) {
    const blocks = _subPageBlocks[_viewingSubPageId];
    const loading = _subPageBlocksLoading === _viewingSubPageId;
    return html`
      <div class="notion-content">
        <div class="nb-breadcrumb">
          <button class="nb-breadcrumb-btn" @click=${() => { _viewingSubPageId = null; _viewingSubPageTitle = null; _rerender(); }}>
            ← Back to Sub-Pages
          </button>
          <span class="nb-breadcrumb-sep">›</span>
          <span class="nb-breadcrumb-current">${_viewingSubPageTitle || "Sub-page"}</span>
        </div>
        ${loading
          ? html`<div class="kanban-loading"><div class="spinner"></div><span>Loading sub-page...</span></div>`
          : blocks?.length
            ? html`<div class="nb-blocks" .innerHTML=${blocks.map((b: any) => renderNotionBlock(b, props)).join("")}></div>`
            : html`<p class="nb-paragraph" style="color:#666">No content found.</p>`
        }
      </div>
    `;
  }

  return html`
    <div class="notion-content">
      <div class="nb-subpage-grid">
        ${childPages.map(sp => html`
          <div class="nb-child-page" @click=${() => fetchSubPageBlocks(props, sp.id, sp.title)}>
            <span class="nb-child-page-icon">${icons.fileText}</span>
            <span class="nb-child-page-title">${sp.title}</span>
            <span class="nb-child-page-arrow">→</span>
          </div>
        `)}
      </div>
    </div>
  `;
}

function renderSubProjectsTab(props: KanbanViewProps, project: KanbanProject) {
  const subProjects = props.projects.filter(p => p.parentProjectId === project.id);

  if (subProjects.length === 0) {
    return html`
      <div class="kanban-loading" style="padding:40px 0;">
        <span style="color:#666; font-size:0.9rem;">No sub-projects</span>
      </div>
    `;
  }

  return html`
    <div class="notion-content">
      <div class="nb-subpage-grid">
        ${subProjects.map(sp => {
          const statusCfg = PROJECT_STATUS_CONFIG[sp.status || "Not started"] || PROJECT_STATUS_CONFIG["Not started"];
          return html`
            <div class="nb-child-page" @click=${() => props.onEnterProject(sp.id)}>
              <span class="nb-child-page-icon">${statusCfg.icon}</span>
              <span class="nb-child-page-title">${sp.name}</span>
              <span class="nb-child-page-arrow">→</span>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

function renderBoard(props: KanbanViewProps) {
  const { projects, tasks, selectedProjectId } = props;
  const project = projects.find(p => p.id === selectedProjectId);
  if (!project) {
    return html`<div class="board-empty">Project not found. <button class="btn-link" @click=${props.onBackToGallery}>Back to Projects</button></div>`;
  }

  const projectTasks = tasks.filter(t => taskMatchesProject(t, project));
  const taskPriorityOrder: Record<string, number> = {
    // PriorityLevel form (Notion)
    Immediate: 0, High: 1, Medium: 2, Low: 3,
    // task.priority short form
    critical: 0, high: 1, normal: 2, medium: 2, low: 3,
  };
  const taskPriorityRank = (t: KanbanTask): number => {
    const lvl = t.priorityLevel || t.priority;
    return lvl ? (taskPriorityOrder[lvl] ?? 4) : 4;
  };
  const tasksByStatus = STATUS_COLUMNS.reduce((acc, col) => {
    acc[col.id] = projectTasks
      .filter(t => t.status === col.id)
      .sort((a, b) => {
        const pr = taskPriorityRank(a) - taskPriorityRank(b);
        if (pr !== 0) return pr;
        const ra = a.rank ?? Number.MAX_SAFE_INTEGER;
        const rb = b.rank ?? Number.MAX_SAFE_INTEGER;
        if (ra !== rb) return ra - rb;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
    return acc;
  }, {} as Record<TaskStatus, KanbanTask[]>);

  const handleDragStart = (e: DragEvent, taskId: string) => {
    e.dataTransfer?.setData("text/plain", taskId);
    e.dataTransfer!.effectAllowed = "move";
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    (e.currentTarget as HTMLElement).classList.add("drag-over");
  };

  const handleDragLeave = (e: DragEvent) => {
    (e.currentTarget as HTMLElement).classList.remove("drag-over");
  };

  const handleDrop = (e: DragEvent, status: TaskStatus) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.remove("drag-over");
    const taskId = e.dataTransfer?.getData("text/plain");
    if (taskId) props.onUpdateTask(taskId, { status });
  };

  const statusCfg = PROJECT_STATUS_CONFIG[project.status || "Not started"] || PROJECT_STATUS_CONFIG["Not started"];

  const renderTaskCard = (task: KanbanTask) => {
    const priorityCfg = task.priorityLevel ? PRIORITY_CONFIG[task.priorityLevel] : null;
    const badge = _subagentByTaskId.get(task.id);
    const focused = _focusTaskId === task.id;
    const onBadgeClick = (e: Event) => {
      e.stopPropagation();
      if (!badge) return;
      // Open the sub-agent detail modal for this run.
      window.dispatchEvent(
        new CustomEvent("infinibot:subagent-open-detail", {
          detail: { runId: badge.runId },
        }),
      );
    };
    const backendIcon = badge?.coderBackend === "opencode"
      ? "🟢"
      : badge?.coderBackend === "codex"
        ? "🟣"
        : badge?.coderBackend === "grok"
          ? "✕"
          : "🤖";
    const badgeColor =
      badge?.status === "completed" || badge?.status === "done"
        ? "#22c55e"
        : badge?.status === "error" || badge?.status === "failed"
          ? "#ef4444"
          : "#f59e0b";
    return html`
      <div class="task-card ${task.done ? 'task-done' : ''} ${focused ? 'task-card-focus' : ''}"
        data-task-id=${task.id}
        ${ref((el) => {
          if (!el) return;
          if (focused) {
            // Wait one frame so the column has laid out before scrolling.
            requestAnimationFrame(() => {
              (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
            });
          }
        })}
        draggable="true"
        @dragstart=${(e: DragEvent) => handleDragStart(e, task.id)}
        @click=${() => { _taskDetailId = task.id; _rerender(); }}
        @contextmenu=${(e: MouseEvent) => openContextMenu(e, { type: "task", task }, props.onRequestUpdate)}
        @touchstart=${(e: TouchEvent) => handleTouchStart(e, { type: "task", task }, props.onRequestUpdate)}
        @touchmove=${handleTouchMove}
        @touchend=${handleTouchEnd}
        @touchcancel=${handleTouchEnd}>
        <div class="task-card-header">
          <span class="task-card-title">${task.title}</span>
          <div style="display:flex;align-items:center;gap:4px">
            ${badge ? html`
              <button
                class="task-subagent-badge"
                style="border-color:${badgeColor}66;color:${badgeColor};"
                title=${`Sub-agent ${badge.status} — open detail modal`}
                @click=${onBadgeClick}
              >${backendIcon} ${badge.status}</button>
            ` : nothing}
            <button class="run-btn-mini" title="Run with agent"
              @click=${(e: Event) => { e.stopPropagation(); openRunDialog(props.client, { task: { id: task.id, title: task.title, description: task.description, projectId: task.projectId } }); }}>▶</button>
            ${priorityCfg ? html`<span class="task-priority-badge" style="background: ${priorityCfg.color}20; color: ${priorityCfg.color}">${task.priorityLevel}</span>` : nothing}
          </div>
        </div>
        ${task.description ? html`<div class="task-card-desc">${task.description.slice(0, 120)}</div>` : nothing}
        <div class="task-card-meta">
          ${task.dueDate ? html`<span class="task-meta-item">${icons.calendar} ${task.dueDate}</span>` : nothing}
          ${task.assignee ? html`<span class="task-meta-item">${icons.person} ${task.assignee}</span>` : nothing}
          ${task.department?.map(d => html`<span class="task-dept-chip">${d}</span>`)}
        </div>
        ${federationNodeIds(task).length ? html`
          <div style="margin-top:6px;">
            ${renderFederationNodeChips(federationNodeIds(task), props.fedNodes ?? [], 2)}
          </div>
        ` : nothing}
      </div>
    `;
  };

  const renderCreateTaskDialog = () => {
    if (!_showCreateDialog) return nothing;
    return html`
      <div class="modal-backdrop" @click=${() => { _showCreateDialog = false; _rerender(); }}>
        <div class="modal-content" @click=${(e: Event) => e.stopPropagation()}>
          <div class="modal-header">
            <h3>New Task</h3>
            <button class="modal-close" @click=${() => { _showCreateDialog = false; _rerender(); }}>✕</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label class="form-label">Task Title</label>
              <input type="text" class="form-input" placeholder="What needs to be done?"
                .value=${_createForm.title}
                @input=${(e: Event) => { _createForm.title = (e.target as HTMLInputElement).value; _rerender(); }} />
            </div>
            <div class="form-group">
              <label class="form-label">Description</label>
              <textarea class="form-textarea" rows="4" placeholder="Details..."
                .value=${_createForm.description}
                @input=${(e: Event) => { _createForm.description = (e.target as HTMLTextAreaElement).value; _rerender(); }}></textarea>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Status</label>
                <select class="form-select" .value=${_createForm.status}
                  @change=${(e: Event) => { _createForm.status = (e.target as HTMLSelectElement).value as TaskStatus; _rerender(); }}>
                  ${STATUS_COLUMNS.map(c => html`<option value=${c.id}>${c.label}</option>`)}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Priority</label>
                <select class="form-select" .value=${_createForm.priority}
                  @change=${(e: Event) => { _createForm.priority = (e.target as HTMLSelectElement).value; _rerender(); }}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Immediate</option>
                </select>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-secondary" @click=${() => { _showCreateDialog = false; _rerender(); }}>Cancel</button>
            <button class="btn-primary" ?disabled=${!_createForm.title.trim()}
              @click=${() => {
                if (!_createForm.title.trim()) return;
                props.onCreateTask({
                  title: _createForm.title.trim(),
                  description: _createForm.description.trim(),
                  projectId: selectedProjectId!,
                  status: _createForm.status,
                  priority: _createForm.priority as any,
                });
                _showCreateDialog = false;
                _createForm = { title: "", description: "", status: "todo", priority: "medium" };
                _rerender();
              }}>Create Task</button>
          </div>
        </div>
      </div>
    `;
  };

  // Task detail modal
  const detailTask = _taskDetailId ? tasks.find(t => t.id === _taskDetailId) : null;
  const renderTaskDetail = () => {
    if (!detailTask) return nothing;
    const priorityCfg = detailTask.priorityLevel ? PRIORITY_CONFIG[detailTask.priorityLevel] : null;
    return html`
      <div class="modal-backdrop" @click=${() => { _taskDetailId = null; _rerender(); }}>
        <div class="modal-content modal-wide" @click=${(e: Event) => e.stopPropagation()}>
          <div class="modal-header">
            <h3>${detailTask.title}</h3>
            <button class="modal-close" @click=${() => { _taskDetailId = null; _rerender(); }}>✕</button>
          </div>
          <div class="modal-body">
            <ib-people-chips class="task-people" style="margin:0 0 12px" .client=${props.client} objectType="task" objectId=${detailTask.id}></ib-people-chips>
            ${detailTask.description ? html`<div class="detail-desc">${detailTask.description}</div>` : nothing}
            <div class="detail-grid">
              <div class="detail-item">
                <label>Status</label>
                <select class="form-select" .value=${detailTask.status}
                  @change=${(e: Event) => { props.onUpdateTask(detailTask.id, { status: (e.target as HTMLSelectElement).value as TaskStatus }); _rerender(); }}>
                  ${STATUS_COLUMNS.map(c => html`<option value=${c.id} ?selected=${detailTask.status === c.id}>${c.label}</option>`)}
                </select>
              </div>
              <div class="detail-item">
                <label>Priority</label>
                <span class="detail-value">${priorityCfg ? html`<span style="color:${priorityCfg.color}">${priorityCfg.dot} ${detailTask.priorityLevel}</span>` : "—"}</span>
              </div>
              ${detailTask.dueDate ? html`<div class="detail-item"><label>Due</label><span class="detail-value">${detailTask.dueDate}</span></div>` : nothing}
              ${detailTask.assignee ? html`<div class="detail-item"><label>Assignee</label><span class="detail-value">${detailTask.assignee}</span></div>` : nothing}
              ${detailTask.department?.length ? html`
                <div class="detail-item">
                  <label>Department</label>
                  <div class="detail-chips">${detailTask.department.map(d => html`<span class="task-dept-chip">${d}</span>`)}</div>
                </div>
              ` : nothing}
              ${detailTask.notionId ? html`
                <div class="detail-item">
                  <label>Notion</label>
                  <a href="https://notion.so/${detailTask.notionId.replace(/-/g, '')}" target="_blank" class="detail-link">Open in Notion ↗</a>
                </div>
              ` : nothing}
            </div>
            ${renderTaskDocSection(detailTask.id, props.client)}
          </div>
          <div class="modal-footer">
            <button class="btn-danger" @click=${() => {
              if (confirm("Delete this task?")) {
                props.onDeleteTask(detailTask.id);
                _taskDetailId = null;
                _rerender();
              }
            }}>Delete</button>
            <button class="btn-secondary" @click=${() => { _taskDetailId = null; _rerender(); }}>Close</button>
          </div>
        </div>
      </div>
    `;
  };

  // Determine if we have sub-pages (from cached data)
  const hasSubPages = _notionSubPages.length > 0 || _notionBlocks.some((b: any) => b.type === "child_page");
  const hasNotion = !!project.notionId && !!props.onFetchNotionBlocks;

  const switchTab = (tab: "tasks" | "content" | "subpages" | "subprojects" | "files" | "notes") => {
    _boardTab = tab;
    _viewingSubPageId = null;
    _viewingSubPageTitle = null;
    if (tab === "content" || tab === "subpages") {
      if (project.notionId) {
        fetchProjectBlocks(props, project.notionId, project.id);
      }
    } else if (tab === "files") {
      fetchProjectAttachments(props, project.id);
    } else if (tab === "notes") {
      fetchProjectNotes(props.client, project.id);
    }
    _rerender();
  };

  const handleContentClick = (e: Event) => {
    const target = e.target as HTMLElement;
    // Handle toggle clicks
    const toggleHeader = target.closest("[data-toggle-id]") as HTMLElement;
    if (toggleHeader) {
      const id = toggleHeader.getAttribute("data-toggle-id")!;
      if (_expandedToggles.has(id)) _expandedToggles.delete(id);
      else _expandedToggles.add(id);
      _rerender();
      return;
    }
    // Handle child_page clicks
    const childPage = target.closest("[data-page-id]") as HTMLElement;
    if (childPage) {
      const pageId = childPage.getAttribute("data-page-id")!;
      const pageTitle = childPage.getAttribute("data-page-title") || "Sub-page";
      fetchSubPageBlocks(props, pageId, pageTitle);
    }
  };

  // Shared app-view-state shim — this board renders outside the Lit host, so
  // cover/related components get a requestUpdate that routes to _rerender().
  const coverHost = { requestUpdate: () => _rerender() } as any;

  return html`
    ${renderCreateTaskDialog()}
    ${renderTaskDetail()}
    ${renderFilePreviewModal(props)}
    <!-- Notion-style cover banner (components/object-cover.ts) -->
    <div style="padding:12px 16px 0;">
      ${renderCoverBanner(coverHost, props.client, "project", project.id, {
        height: 168,
        seed: project.id || project.name,
      })}
    </div>
    <div class="board-toolbar">
      <div class="board-toolbar-left">
        <button class="btn-back" @click=${() => { _boardTab = "tasks"; _viewingSubPageId = null; props.onBackToGallery(); }}>← Projects</button>
        <div class="board-project-info" style="position:relative;"
          @contextmenu=${(e: MouseEvent) => openContextMenu(e, { type: "project", project }, props.onRequestUpdate)}>
          <button class="board-project-name-btn"
            title="Open project controls"
            @click=${(e: Event) => {
              e.stopPropagation();
              if (_projectHeaderPopoverOpenFor === project.id) closeProjectHeaderPopover();
              else openProjectHeaderPopover(project, props.client, props.agencyId);
            }}>
            <h2 class="board-project-name">${project.name}</h2>
            <span class="board-project-chev" aria-hidden="true">▾</span>
          </button>
          <ib-repo-badge class="board-repo-badge" style="margin-left:8px;align-self:center"
            .projectId=${project.id} .projectName=${project.name} attachable></ib-repo-badge>
          ${(() => {
            // Clickable "Parent: <Name>" chip near the title — jumps to the parent board.
            const parent = project.parentProjectId
              ? props.projects.find((p) => p.id === project.parentProjectId)
              : undefined;
            return parent
              ? html`<button class="board-parent-chip" title="Open parent project: ${parent.name}"
                  @click=${(e: Event) => { e.stopPropagation(); props.onEnterProject(parent.id); }}>
                  <span class="board-parent-chip-icon" aria-hidden="true">⤷</span>
                  <span class="board-parent-chip-name">Parent: ${parent.name}</span>
                </button>`
              : nothing;
          })()}
          <span class="gallery-status-badge small" style="color: ${statusCfg.color}; background: ${statusCfg.bg}">
            ${statusCfg.icon} ${project.status || "Not started"}
          </span>
          ${typeof project.paidAmount === "number" && project.paidAmount > 0 ? html`
            <span class="board-money-chip board-money-chip--paid" title="${project.paidAmountDate ? `Paid as of ${project.paidAmountDate}` : 'Paid'}">
              $${formatMoney(project.paidAmount)}
            </span>
          ` : nothing}
          ${typeof project.pendingPay === "number" && project.pendingPay > 0 ? html`
            <span class="board-money-chip board-money-chip--pending" title="${project.pendingPayDate ? `Pending due ${project.pendingPayDate}` : 'Pending'}">
              $${formatMoney(project.pendingPay)} pending
            </span>
          ` : nothing}
          ${_projectHeaderPopoverOpenFor === project.id ? renderProjectHeaderPopover(props, project) : nothing}
        </div>
        <div class="board-tab-switcher">
          <button class="board-tab-btn ${_boardTab === "tasks" ? "active" : ""}" @click=${() => switchTab("tasks")}>${icons.fileText} Tasks</button>
          <button class="board-tab-btn ${_boardTab === "content" ? "active" : ""}" @click=${() => switchTab("content")}>${icons.penLine} Content</button>
          <button class="board-tab-btn ${_boardTab === "files" ? "active" : ""}" @click=${() => switchTab("files")}>${icons.folder} Files</button>
          <button class="board-tab-btn ${_boardTab === "notes" ? "active" : ""}" @click=${() => switchTab("notes")}>${icons.penLine} Notes</button>
          <button class="board-tab-btn ${_boardTab === "subprojects" ? "active" : ""}" @click=${() => switchTab("subprojects")}>${icons.chevronDown} Sub-Projects</button>
          ${hasNotion && hasSubPages ? html`
            <button class="board-tab-btn ${_boardTab === "subpages" ? "active" : ""}" @click=${() => switchTab("subpages")}>${icons.fileText} Sub-Pages</button>
          ` : nothing}
        </div>
      </div>
      <div class="board-toolbar-right">
        <button class="board-kg-btn" data-ib-target="control:projects/knowledge-graph"
          title="Knowledge Graph — only what's connected to ${project.name}"
          @click=${() => openProjectGraph(project.id, { name: project.name })}>
          ${icons.network}<span>Knowledge Graph</span>
        </button>
        ${renderBusinessChip({
          currentId: project.businessId ?? null,
          businesses: props.businesses ?? [],
          onChange: (next) => props.onUpdateProject(project.id, { businessId: next ?? undefined } as Partial<KanbanProject>),
          variant: "row",
        })}
        ${_boardTab === "tasks" ? html`
          <button class="btn-primary" @click=${() => { _showCreateDialog = true; _createForm = { title: "", description: "", status: "todo", priority: "medium" }; _rerender(); }}>
            + Add Task
          </button>
        ` : nothing}
        <button class="btn-icon" @click=${props.onRefresh} title="Refresh">↻</button>
        ${renderNotionSyncChip(props.client)}
        ${props.onNotionSync ? html`
          <button class="btn-notion-sync ${props.notionSyncStatus?.syncing ? 'syncing' : ''}"
            @click=${() => props.onNotionSync?.()}
            ?disabled=${props.notionSyncStatus?.syncing}
            title="Sync with Notion">
            <span class="notion-sync-icon">${props.notionSyncStatus?.syncing ? "⟳" : icons.fileText}</span>
            <span>Sync</span>
          </button>
        ` : nothing}
        ${project.notionId ? html`
          <a href="https://notion.so/${project.notionId.replace(/-/g, '')}" target="_blank" class="btn-icon" title="Open in Notion">↗</a>
        ` : nothing}
      </div>
    </div>
    ${_boardTab === "tasks" ? html`
      <div class="project-relations-strip">
        <ib-people-chips class="project-people" .client=${props.client} objectType="project" objectId=${project.id}></ib-people-chips>
        ${renderProjectRelations(coverHost, props.client, "project", project.id, {
          title: "Relations",
          openable: ["project"],
          onOpen: (type, id) => {
            if (type === "project" && props.projects.some((p) => p.id === id)) props.onEnterProject(id);
          },
        })}
        ${renderProjectReports(coverHost, props.client, "project", project.id, { title: "Reports" })}
      </div>
      <div class="kanban-board">
        ${STATUS_COLUMNS.map(col => html`
          <div class="kanban-column"
            @dragover=${handleDragOver}
            @dragleave=${handleDragLeave}
            @drop=${(e: DragEvent) => handleDrop(e, col.id)}>
            <div class="kanban-column-header" style="border-top-color: ${col.color}">
              <span class="column-title">${col.label}</span>
              <span class="column-count">${tasksByStatus[col.id]?.length || 0}</span>
            </div>
            <div class="kanban-column-content">
              ${tasksByStatus[col.id]?.map(renderTaskCard)}
            </div>
          </div>
        `)}
      </div>
    ` : nothing}
    ${_boardTab === "content" ? html`
      <div class="nb-content-area" @click=${handleContentClick}>
        <div class="kb-page">
          <header class="kb-page-head">
            <span class="kb-page-icon" style="color: ${statusCfg.color}">
              ${project.customIcon ?? statusCfg.icon}
            </span>
            <input
              class="kb-page-title"
              .value=${project.name}
              placeholder="Untitled"
              @change=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value.trim();
                if (v && v !== project.name) props.onUpdateProject(project.id, { name: v });
              }}
            />
          </header>

          <section class="kb-page-section kb-page-props">
            <div class="kb-page-proplist">
              <div class="kb-page-prop">
                <label class="kb-prop-label">Status</label>
                <select
                  class="kb-prop-input"
                  .value=${project.status ?? "Not started"}
                  @change=${(e: Event) => props.onUpdateProject(project.id, { status: (e.target as HTMLSelectElement).value as ProjectStatus })}
                >
                  ${Object.keys(PROJECT_STATUS_CONFIG).map(s => html`
                    <option value=${s} ?selected=${(project.status ?? "Not started") === s}>${s}</option>
                  `)}
                </select>
              </div>

              <div class="kb-page-prop">
                <label class="kb-prop-label">Priority</label>
                <select
                  class="kb-prop-input"
                  .value=${project.priority ?? ""}
                  @change=${(e: Event) => {
                    const v = (e.target as HTMLSelectElement).value;
                    props.onUpdateProject(project.id, { priority: (v || undefined) as PriorityLevel | undefined });
                  }}
                >
                  <option value="">—</option>
                  ${(["Immediate", "High", "Medium", "Low"] as PriorityLevel[]).map(p => html`
                    <option value=${p} ?selected=${project.priority === p}>${p}</option>
                  `)}
                </select>
              </div>

              <div class="kb-page-prop">
                <label class="kb-prop-label">Progress</label>
                <div class="kb-prop-progress">
                  <input
                    class="kb-prop-input kb-prop-input-num"
                    type="number"
                    min="0"
                    max="100"
                    .value=${String(project.progress ?? 0)}
                    @change=${(e: Event) => {
                      const n = Number((e.target as HTMLInputElement).value);
                      const clamped = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
                      props.onUpdateProject(project.id, { progress: clamped });
                    }}
                  />
                  <span class="kb-prop-progress-pct">%</span>
                  <div class="kb-prop-progress-bar">
                    <div class="kb-prop-progress-fill" style="width: ${Math.max(0, Math.min(100, project.progress ?? 0))}%"></div>
                  </div>
                </div>
              </div>

              <div class="kb-page-prop">
                <label class="kb-prop-label">Due Date</label>
                <input
                  class="kb-prop-input"
                  type="date"
                  .value=${project.dueDate ?? ""}
                  @change=${(e: Event) => props.onUpdateProject(project.id, { dueDate: (e.target as HTMLInputElement).value || undefined })}
                />
              </div>

              ${project.productUrl ? html`
                <div class="kb-page-prop">
                  <label class="kb-prop-label">Link</label>
                  <a class="kb-prop-link" href=${project.productUrl} target="_blank" rel="noopener">${project.productUrl}</a>
                </div>
              ` : nothing}

              ${(project.githubRepoUrl || project.githubRepo) ? html`
                <div class="kb-page-prop">
                  <label class="kb-prop-label">GitHub</label>
                  <div style="display:flex;flex-direction:column;gap:6px;">
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                      <a class="kb-prop-link" href=${project.githubRepoUrl ?? (project.githubRepo ? `https://github.com/${project.githubRepo.owner}/${project.githubRepo.name}` : "#")} target="_blank" rel="noopener" style="display:flex;align-items:center;gap:6px;">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.78 0c2.21-1.49 3.18-1.18 3.18-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.05.78 2.12v3.14c0 .31.21.67.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z"/></svg>
                        ${project.githubRepo ? `${project.githubRepo.owner}/${project.githubRepo.name}` : project.githubRepoUrl}
                      </a>
                      ${project.githubSyncStatus ? html`
                        <span style="font-size:10px;font-weight:600;padding:2px 7px;border-radius:9px;background:${
                          project.githubSyncStatus === 'clean' ? '#16a34a22' :
                          project.githubSyncStatus === 'behind' ? '#d97706' + '22' :
                          project.githubSyncStatus === 'ahead' ? '#3b82f622' :
                          project.githubSyncStatus === 'diverged' ? '#ef444422' :
                          project.githubSyncStatus === 'conflict' ? '#ef444422' : '#6b728022'
                        };color:${
                          project.githubSyncStatus === 'clean' ? '#16a34a' :
                          project.githubSyncStatus === 'behind' ? '#d97706' :
                          project.githubSyncStatus === 'ahead' ? '#3b82f6' :
                          (project.githubSyncStatus === 'diverged' || project.githubSyncStatus === 'conflict') ? '#ef4444' : '#6b7280'
                        };">
                          ${project.githubSyncStatus}
                        </span>
                      ` : nothing}
                    </div>
                    ${project.githubLocalPath ? html`
                      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                        <span style="font-size:11px;color:#888;">${project.githubLocalPath}</span>
                        <button class="btn-secondary" style="font-size:11px;padding:2px 8px;"
                          ?disabled=${_githubSyncing}
                          @click=${async () => {
                            _githubSyncing = true;
                            _githubSyncResult = null;
                            _rerender();
                            try {
                              const res = await props.client?.request("kanban.github.sync", { projectId: project.id, action: "status" });
                              _githubSyncResult = { syncStatus: res?.syncStatus ?? "unknown" };
                              props.onUpdateProject(project.id, { githubSyncStatus: res?.syncStatus } as any);
                            } catch {
                              _githubSyncResult = { syncStatus: "unknown", output: "Sync failed" };
                            }
                            _githubSyncing = false;
                            _rerender();
                          }}>
                          ${_githubSyncing ? "Checking…" : "↓ Fetch / check"}
                        </button>
                        ${_githubSyncResult?.output ? html`<span style="font-size:11px;color:#ef4444;">${_githubSyncResult.output}</span>` : nothing}
                      </div>
                    ` : nothing}
                    ${project.githubLastSyncAt ? html`
                      <div style="font-size:10px;color:#888;">Last checked: ${new Date(project.githubLastSyncAt).toLocaleString()}</div>
                    ` : nothing}
                  </div>
                </div>
              ` : nothing}

              <div class="kb-page-prop kb-page-prop-wide">
                <label class="kb-prop-label">Description</label>
                <textarea
                  class="kb-prop-input kb-prop-textarea"
                  rows="3"
                  placeholder="Add a description…"
                  .value=${project.description ?? ""}
                  @change=${(e: Event) => props.onUpdateProject(project.id, { description: (e.target as HTMLTextAreaElement).value })}
                ></textarea>
              </div>
            </div>
          </section>

          <section class="kb-page-section kb-page-body">
            ${renderProjectSummaryPanel({ project, client: props.client, requestUpdate: props.onRequestUpdate })}
          </section>

          <section class="kb-page-section kb-page-body">
            <div class="kb-page-section-head">
              <h3 class="kb-page-section-title">Project spec</h3>
              <span class="kb-page-section-hint">deliverables · to-dos · acceptance</span>
            </div>
            <div class="nb-editor-host kb-page-editor"
              ${ref(getSpecEditorRefCb(project.id, props.client))}
              data-project-spec-editor="${project.id}"></div>
            ${renderProjectSpecPanel({ project, client: props.client, requestUpdate: props.onRequestUpdate })}
          </section>

          <section class="kb-page-section kb-page-body">
            <div class="kb-page-section-head">
              <h3 class="kb-page-section-title">Notes</h3>
              <span class="kb-page-section-hint">type / for commands</span>
            </div>
            <div class="nb-editor-host kb-page-editor"
              ${ref(getBlockEditorRefCb(project.id, props.client))}
              data-project-editor="${project.id}"></div>
          </section>
        </div>
      </div>
    ` : nothing}
    ${_boardTab === "subpages" ? html`<div class="nb-content-area" @click=${handleContentClick}>${renderSubPagesTab(props, project)}</div>` : nothing}
    ${_boardTab === "subprojects" ? html`<div class="nb-content-area">${renderSubProjectsTab(props, project)}</div>` : nothing}
    ${_boardTab === "files" ? renderFilesTab(props, project) : nothing}
    ${_boardTab === "notes" ? renderProjectNotesTab(props, project) : nothing}
  `;
}

function renderFilesTab(props: KanbanViewProps, project: KanbanProject) {
  const projectId = project.id;
  const showingThis = _attachmentsProjectId === projectId;
  const list = showingThis ? _attachments : [];
  const loading = _attachmentsLoading && showingThis;

  const onPickFiles = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = "";
    if (files.length === 0) return;
    (async () => {
      for (const f of files) {
        await uploadProjectAttachment(props, projectId, f);
      }
    })();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const dropZone = (e.currentTarget as HTMLElement);
    dropZone.classList.remove("drag-over");
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;
    (async () => {
      for (const f of files) {
        await uploadProjectAttachment(props, projectId, f);
      }
    })();
  };

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.add("drag-over");
  };
  const onDragLeave = (e: DragEvent) => {
    (e.currentTarget as HTMLElement).classList.remove("drag-over");
  };

  return html`
    <div class="nb-content-area">
      <div class="kb-page">
        <header class="kb-page-head">
          <span class="kb-page-icon">${icons.folder}</span>
          <h2 class="kb-page-title" style="font-size:28px;font-weight:600;">Files</h2>
        </header>

        <section class="kb-files-section">
          <div class="kb-files-toolbar">
            <label class="btn-primary kb-files-upload-btn">
              ${_attachmentUploading ? html`<span>⟳ Uploading…</span>` : html`<span>+ Upload File</span>`}
              <input type="file" multiple style="display:none" ?disabled=${_attachmentUploading} @change=${onPickFiles} />
            </label>
            <button class="btn-icon" title="Refresh" @click=${() => fetchProjectAttachments(props, projectId, true)}>↻</button>
            <span class="kb-files-count">${list.length} ${list.length === 1 ? "file" : "files"}</span>
          </div>

          ${_attachmentsError ? html`
            <div class="kb-files-error">${icons.alertCircle} ${_attachmentsError}</div>
          ` : nothing}

          <div class="kb-files-dropzone"
            @dragover=${onDragOver}
            @dragleave=${onDragLeave}
            @drop=${onDrop}>
            ${loading ? html`
              <div class="kb-files-empty">Loading files…</div>
            ` : list.length === 0 ? html`
              <div class="kb-files-empty">
                <div style="font-size:32px;margin-bottom:8px;">${icons.folder}</div>
                <div>No files yet</div>
                <div class="kb-files-empty-hint">Drag files here or click “Upload File”</div>
              </div>
            ` : html`
              <ul class="kb-files-list">
                ${list.map((att) => html`
                  <li class="kb-file-row" tabindex="0"
                    role="button"
                    title="Click to preview"
                    @click=${() => openFilePreview(props, att)}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openFilePreview(props, att);
                      }
                    }}>
                    <span class="kb-file-icon">${fileIconFor(att)}</span>
                    <div class="kb-file-info">
                      <div class="kb-file-name" title=${att.path}>${att.name}</div>
                      <div class="kb-file-meta">
                        <span>${formatFileSize(att.size)}</span>
                        <span>·</span>
                        <span>${new Date(att.createdAt).toLocaleString()}</span>
                      </div>
                    </div>
                    <div class="kb-file-actions">
                      <button class="btn-icon" title="Download"
                        @click=${(e: Event) => { e.stopPropagation(); downloadProjectAttachment(props, att); }}>↓</button>
                      <button class="btn-icon kb-file-delete" title="Remove"
                        @click=${(e: Event) => {
                          e.stopPropagation();
                          if (confirm(`Remove "${att.name}" from this project?`)) {
                            removeProjectAttachment(props, projectId, att.id);
                          }
                        }}>✕</button>
                    </div>
                  </li>
                `)}
              </ul>
            `}
          </div>
        </section>
      </div>
    </div>
  `;
}

function renderProjectNotesTab(props: KanbanViewProps, project: KanbanProject) {
  const projectId = project.id;
  const showingThis = _projectNotesProjectId === projectId;
  const notes = showingThis ? _projectNotes : [];
  const ideas = showingThis ? _projectIdeas : [];
  const loading = _projectNotesLoading && showingThis;

  const onUnlinkIdea = async (ideaId: string) => {
    const client = props.client;
    if (!client?.request) return;
    if (!confirm("Remove this idea from the project?")) return;
    try {
      await client
        .request("capture.assignProject", { kind: "idea", id: ideaId, projectId: null })
        .catch(() => client.request("ideas.link", { id: ideaId, kind: "project", targetId: projectId, unlink: true }));
      await fetchProjectNotes(client, projectId, true);
    } catch (err) {
      console.error("Failed to unlink idea:", err);
    }
  };

  const onCreateNote = async () => {
    const client = props.client;
    if (!client?.request) return;
    const name = prompt("Note name:");
    if (!name?.trim()) return;
    try {
      const res = await client.request("notes.create", {
        name: name.trim(),
        body: "",
        projectId,
      });
      if (res) {
        await fetchProjectNotes(client, projectId, true);
      }
    } catch (err) {
      console.error("Failed to create project note:", err);
    }
  };

  const onUnlinkNote = async (noteId: string) => {
    const client = props.client;
    if (!client?.request) return;
    if (!confirm("Unlink this note from the project?")) return;
    try {
      await client.request("notes.update", { id: noteId, projectId: "" });
      await fetchProjectNotes(client, projectId, true);
    } catch (err) {
      console.error("Failed to unlink note:", err);
    }
  };

  return html`
    <div class="nb-content-area">
      <div class="kb-page">
        <header class="kb-page-head">
          <span class="kb-page-icon">${icons.penLine}</span>
          <h2 class="kb-page-title" style="font-size:28px;font-weight:600;">Related Notes</h2>
        </header>

        <section class="kb-files-section">
          <div class="kb-files-toolbar">
            <button class="btn-primary" @click=${onCreateNote}>+ New Note</button>
            <button class="btn-icon" title="Refresh" @click=${() => fetchProjectNotes(props.client, projectId, true)}>↻</button>
            <span class="kb-files-count">${notes.length} ${notes.length === 1 ? "note" : "notes"}</span>
          </div>

          ${_projectNotesError ? html`
            <div class="kb-files-error">${icons.alertCircle} ${_projectNotesError}</div>
          ` : nothing}

          <div class="kb-files-dropzone">
            ${loading ? html`
              <div class="kb-files-empty">Loading notes…</div>
            ` : notes.length === 0 ? html`
              <div class="kb-files-empty">
                <div style="font-size:32px;margin-bottom:8px;">${icons.penLine}</div>
                <div>No notes linked to this project</div>
                <div class="kb-files-empty-hint">Click "+ New Note" to create one, or link an existing note from the Notes view</div>
              </div>
            ` : html`
              <ul class="kb-files-list">
                ${notes.map((note) => html`
                  <li class="kb-file-row" tabindex="0"
                    style="cursor:pointer;"
                    @click=${() => {
                      window.dispatchEvent(new CustomEvent("infinibot:navigate", { detail: { view: "notes", noteId: note.id } }));
                    }}>
                    <span class="kb-file-icon">${icons.penLine}</span>
                    <div class="kb-file-info">
                      <div class="kb-file-name" title=${note.id}>${note.name}</div>
                      <div class="kb-file-meta">
                        ${note.category ? html`<span style="color:#3b82f6;">${note.category}</span><span>·</span>` : nothing}
                        ${note.tags?.length ? html`<span>${note.tags.slice(0, 3).join(", ")}</span><span>·</span>` : nothing}
                        <span>${new Date(note.updatedAt).toLocaleString()}</span>
                      </div>
                      ${note.preview ? html`<div style="color:#9ca3af;font-size:11px;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${note.preview.slice(0, 120)}</div>` : nothing}
                    </div>
                    <div class="kb-file-actions">
                      <button class="btn-icon kb-file-delete" title="Unlink from project"
                        @click=${(e: Event) => { e.stopPropagation(); onUnlinkNote(note.id); }}>✕</button>
                    </div>
                  </li>
                `)}
              </ul>
            `}
          </div>
        </section>

        ${ideas.length ? html`
          <section class="kb-files-section" style="margin-top:24px;">
            <div class="kb-files-toolbar">
              <span class="kb-page-icon">${icons.lightbulb}</span>
              <strong style="font-size:16px;">Related Ideas</strong>
              <span class="kb-files-count">${ideas.length} ${ideas.length === 1 ? "idea" : "ideas"}</span>
            </div>
            <ul class="kb-files-list">
              ${ideas.map((idea) => html`
                <li class="kb-file-row">
                  <span class="kb-file-icon">${icons.lightbulb}</span>
                  <div class="kb-file-info">
                    <div class="kb-file-name" title=${idea.id}>${idea.title}</div>
                    <div class="kb-file-meta">
                      ${idea.status ? html`<span style="color:#3b82f6;">${idea.status}</span><span>·</span>` : nothing}
                      ${idea.source ? html`<span>${idea.source}</span><span>·</span>` : nothing}
                      ${idea.tags?.length ? html`<span>${idea.tags.slice(0, 3).join(", ")}</span><span>·</span>` : nothing}
                      ${idea.updatedAt ? html`<span>${new Date(idea.updatedAt).toLocaleString()}</span>` : nothing}
                    </div>
                    ${idea.body ? html`<div style="color:#9ca3af;font-size:11px;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${idea.body.slice(0, 120)}</div>` : nothing}
                  </div>
                  <div class="kb-file-actions">
                    <button class="btn-icon kb-file-delete" title="Remove from project"
                      @click=${(e: Event) => { e.stopPropagation(); void onUnlinkIdea(idea.id); }}>✕</button>
                  </div>
                </li>
              `)}
            </ul>
          </section>
        ` : nothing}
      </div>
    </div>
  `;
}

// ── Main Export ──────────────────────────────────
// ── Run Dialog ──────────────────────────────────
async function openRunDialog(client: any, target: { task?: { id: string; title: string; description?: string; projectId?: string }; project?: { id: string; name: string; description?: string } }) {
  _runTargetTask = target.task || null;
  _runTargetProject = target.project || null;
  _runForm = { agentId: "coder", cwd: "", label: target.task?.title || target.project?.name || "", autonomous: false };
  _runLoading = false;
  _runResult = null;
  _runPhase = "setup";
  _analysisResult = null;
  _analysisAnswers = {};
  _analysisError = null;
  _precheckResult = null;
  _precheckLoading = false;
  _classification = null;
  _approval = null;
  _stopApprovalPolling();
  _showRunDialog = true;

  // Load agents from config
  if (client && _runAgents.length === 0) {
    try {
      const cfg = await client.request("gateway:config.get", {});
      const config = cfg?.config ?? cfg?.parsed ?? cfg;
      _runAgents = (config?.agents?.list || []).map((a: any) => ({
        id: a.id,
        name: a.name,
        execution: a.execution,
      }));
    } catch { /* ignore */ }
  }

  _rerender();
}

async function runPrecheck(client: any) {
  if (!client) return;
  _precheckLoading = true;
  _precheckResult = null;
  _runPhase = "precheck";
  _rerender();
  try {
    const res = await client.request("autonomy.precheck", {
      cwd: _runForm.cwd || undefined,
    });
    _precheckResult = res as PrecheckResult;
  } catch (err: any) {
    _precheckResult = {
      ok: false,
      cwd: _runForm.cwd || "",
      branch: "",
      remote: null,
      isGithub: false,
      github: null,
      defaultBranch: "main",
      onDefaultBranch: false,
      dirtyFiles: 0,
      ahead: 0,
      behind: 0,
      reason: "rpc_error",
      message: err?.message || "precheck failed",
    };
  }
  _precheckLoading = false;
  _rerender();
}

async function runClassify(client: any): Promise<Classification | null> {
  if (!client) return null;
  const taskTitle = _runTargetTask?.title || _runTargetProject?.name || "Task";
  const taskDesc = _runTargetTask?.description || _runTargetProject?.description || "";
  const prompt = `${taskTitle}${taskDesc ? "\n\n" + taskDesc : ""}`;
  try {
    const res = await client.request("autonomy.classify", {
      prompt,
      agentId: _runForm.agentId,
      autonomous: _runForm.autonomous,
      dirtyFiles: _precheckResult?.dirtyFiles ?? 0,
      onDefaultBranch: !!_precheckResult?.onDefaultBranch,
    });
    return res as Classification;
  } catch {
    return null;
  }
}

async function requestApproval(client: any) {
  if (!client) return;
  const taskTitle = _runTargetTask?.title || _runTargetProject?.name || "Task";
  const taskDesc = _runTargetTask?.description || _runTargetProject?.description || "";
  const summary = (_classification?.reasons ?? []).join("; ");
  const ctx = [
    `Repo: ${_precheckResult?.github ? `${_precheckResult.github.owner}/${_precheckResult.github.repo}` : _precheckResult?.remote ?? "(none)"}`,
    `Branch: ${_precheckResult?.branch ?? "(unknown)"}`,
    `Dirty files: ${_precheckResult?.dirtyFiles ?? 0}`,
    "",
    taskDesc,
  ].join("\n");
  try {
    const res = await client.request("autonomy.approval.request", {
      title: taskTitle,
      summary: summary || "Critical autonomous task",
      context: ctx,
      criticality: _classification?.criticality ?? "critical",
      taskId: _runTargetTask?.id ?? null,
    });
    _approval = { id: res.id, status: "pending", decision: null, decidedBy: null, reason: null, expiresAt: res.expiresAt };
    // Poll status every 2s.
    _stopApprovalPolling();
    _approvalPollTimer = window.setInterval(async () => {
      if (!_approval || _approval.status !== "pending") {
        _stopApprovalPolling();
        return;
      }
      try {
        const status = await client.request("autonomy.approval.status", { id: _approval.id });
        if (status && status.status && status.status !== "pending") {
          _approval = {
            id: _approval.id,
            status: status.status,
            decision: status.decision ?? null,
            decidedBy: status.decidedBy ?? null,
            reason: status.reason ?? null,
            expiresAt: _approval.expiresAt,
          };
          _stopApprovalPolling();
          _rerender();
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
    _runPhase = "approval";
    _rerender();
  } catch (err: any) {
    _analysisError = err?.message || "Failed to request approval";
    _runPhase = "ready";
    _rerender();
  }
}

async function runAnalysis(client: any) {
  if (!client) return;
  _runPhase = "analyzing";
  _analysisError = null;
  _analysisResult = null;
  _rerender();

  const taskTitle = _runTargetTask?.title || _runTargetProject?.name || "Task";
  const taskDesc = _runTargetTask?.description || _runTargetProject?.description || "";
  const taskPrompt = `${taskTitle}${taskDesc ? "\n\n" + taskDesc : ""}`;

  try {
    const res = await client.request("sessions.analyze", {
      task: taskPrompt,
      agentId: _runForm.agentId || "coder",
    });
    _analysisResult = {
      ready: !!res?.ready,
      summary: res?.summary || "",
      questions: Array.isArray(res?.questions) ? res.questions : [],
      suggestions: Array.isArray(res?.suggestions) ? res.suggestions : [],
    };
    // If there are questions, show them; otherwise mark ready
    if (_analysisResult.questions.length > 0 && !_analysisResult.ready) {
      _runPhase = "questions";
      // Init empty answers
      _analysisAnswers = {};
      for (const q of _analysisResult.questions) {
        _analysisAnswers[q.id] = "";
      }
    } else {
      _runPhase = "ready";
    }
  } catch (err: any) {
    _analysisError = err?.message || "Analysis failed";
    _runPhase = "setup";
  }
  _rerender();
}

function buildEnrichedTaskPrompt(): string {
  const taskTitle = _runTargetTask?.title || _runTargetProject?.name || "Task";
  const taskDesc = _runTargetTask?.description || _runTargetProject?.description || "";
  let prompt = `${taskTitle}${taskDesc ? "\n\n" + taskDesc : ""}`;

  // Append analysis context if we have answers
  const answeredQuestions = Object.entries(_analysisAnswers).filter(([, v]) => v.trim());
  if (answeredQuestions.length > 0 && _analysisResult?.questions) {
    prompt += "\n\n## Additional Context\n";
    for (const [qId, answer] of answeredQuestions) {
      const q = _analysisResult.questions.find((q) => q.id === qId);
      if (q) {
        prompt += `\n**${q.label}**\n${answer}\n`;
      }
    }
  }

  // Append suggestions acknowledgment
  if (_analysisResult?.summary) {
    prompt += `\n\n## Analysis Summary\n${_analysisResult.summary}`;
  }

  return prompt;
}

async function executeRun(client: any) {
  if (!client || _runLoading) return;

  // Autonomous mode: enforce precheck + (when critical) approval before spawn.
  if (_runForm.autonomous) {
    if (!_precheckResult?.ok) {
      _analysisError = "GitHub precheck must pass before starting an autonomous run.";
      _runPhase = "precheck";
      _rerender();
      return;
    }
    // Always classify to know if approval is required.
    if (!_classification) {
      _classification = await runClassify(client);
    }
    if (_classification?.requiresApproval && _approval?.status !== "approved") {
      _runPhase = "classify";
      _rerender();
      return;
    }
  }

  _runLoading = true;
  _runPhase = "spawning";
  _runResult = null;
  _rerender();

  const taskPrompt = buildEnrichedTaskPrompt();
  const label = _runForm.label || _runTargetTask?.title || _runTargetProject?.name || "Task";

  try {
    const res = await client.request("sessions.spawn", {
      task: taskPrompt,
      agentId: _runForm.agentId || "coder",
      label,
      autonomous: _runForm.autonomous || undefined,
      approvalId: _approval?.id || undefined,
      cwd: _runForm.cwd || undefined,
    });
    _runResult = { status: res?.status || "accepted", sessionKey: res?.childSessionKey, runId: res?.runId, terminalId: res?.terminalId };
    _runPhase = "done";
  } catch (err: any) {
    _runResult = { status: "error", error: err?.message || "Failed to spawn agent" };
    _runPhase = "ready";
  }

  _runLoading = false;
  _rerender();
}

function renderRunDialog(props: KanbanViewProps) {
  if (!_showRunDialog) return nothing;
  const target = _runTargetTask || _runTargetProject;
  if (!target) return nothing;
  const isTask = !!_runTargetTask;
  const title = isTask ? (_runTargetTask?.title || "Task") : (_runTargetProject?.name || "Project");
  const agentOptions = _runAgents.length > 0 ? _runAgents : [
    { id: "coder", name: "Atlas (Developer)" },
    { id: "coder-claude", name: "Claude Code (CLI)" },
    { id: "coder-codex", name: "Codex (CLI)" },
    { id: "coder-opencode", name: "OpenCode (CLI)" },
    { id: "webdev", name: "Architect" },
    { id: "main", name: "Infini (Main)" },
  ];

  // ── Phase indicators ──────────────────────────────────
  // Autonomous runs include extra phases (precheck + classify/approval)
  // so the user always knows where the gate stands.
  const isAuto = _runForm.autonomous;
  const phases: Array<{ key: RunPhase; label: string; icon: ReturnType<typeof html> }> = isAuto
    ? [
        { key: "setup", label: "Setup", icon: RUN_ICONS.settings },
        { key: "precheck", label: "GitHub", icon: RUN_ICONS.github },
        { key: "analyzing", label: "Analyze", icon: RUN_ICONS.search },
        { key: "questions", label: "Context", icon: RUN_ICONS.message },
        { key: "approval", label: "Approval", icon: RUN_ICONS.shield },
        { key: "ready", label: "Ready", icon: RUN_ICONS.check },
        { key: "spawning", label: "Running", icon: RUN_ICONS.play },
        { key: "done", label: "Done", icon: RUN_ICONS.flag },
      ]
    : [
        { key: "setup", label: "Setup", icon: RUN_ICONS.settings },
        { key: "analyzing", label: "Analyze", icon: RUN_ICONS.search },
        { key: "questions", label: "Context", icon: RUN_ICONS.message },
        { key: "ready", label: "Ready", icon: RUN_ICONS.check },
        { key: "spawning", label: "Running", icon: RUN_ICONS.play },
        { key: "done", label: "Done", icon: RUN_ICONS.flag },
      ];
  const phaseIdx = phases.findIndex((p) => p.key === _runPhase);

  const renderPhaseBar = () => html`
    <div class="run-phase-bar">
      ${phases.map((p, i) => html`
        <div class="run-phase-step ${i < phaseIdx ? "run-phase-past" : ""} ${i === phaseIdx ? "run-phase-active" : ""} ${i > phaseIdx ? "run-phase-future" : ""}">
          <span class="run-phase-icon">${p.icon}</span>
          <span class="run-phase-label">${p.label}</span>
        </div>
        ${i < phases.length - 1 ? html`<div class="run-phase-connector ${i < phaseIdx ? "run-phase-connector-done" : ""}"></div>` : nothing}
      `)}
    </div>
  `;

  // ── Setup phase: agent selection + config ──────────────────────────────────
  const renderSetupPhase = () => html`
    <div class="form-group">
      <label class="form-label">Agent</label>
      <select class="form-select" .value=${_runForm.agentId}
        @change=${(e: Event) => { _runForm.agentId = (e.target as HTMLSelectElement).value; _rerender(); }}>
        ${agentOptions.map(a => {
          const execMode = (a as any).execution?.mode === "terminal" ? `  ·  ${(a as any).execution?.cli}` : "";
          return html`<option value=${a.id} ?selected=${_runForm.agentId === a.id}>${a.name || a.id}${execMode}</option>`;
        })}
      </select>
      ${(() => {
        const selected = agentOptions.find(a => a.id === _runForm.agentId);
        const execMode = (selected as any)?.execution?.mode;
        return execMode === "terminal"
          ? html`<div style="color: #22c55e; font-size: 11px; margin-top: 4px; display:flex; align-items:center; gap:4px">${RUN_ICONS.zap} Terminal mode — live CLI output in terminal tab</div>`
          : html`<div style="color: #888; font-size: 11px; margin-top: 4px; display:flex; align-items:center; gap:4px">${RUN_ICONS.loop} Agent loop — runs in background session</div>`;
      })()}
    </div>
    <div class="form-group">
      <label class="form-label">Session Label</label>
      <input type="text" class="form-input" placeholder="Label for tracking"
        .value=${_runForm.label}
        @input=${(e: Event) => { _runForm.label = (e.target as HTMLInputElement).value; _rerender(); }} />
    </div>
    <div class="form-group">
      <label class="form-label">Working Directory <span style="color: #666">(optional)</span></label>
      <div style="display:flex; gap:6px; align-items:center">
        <input type="text" class="form-input" style="flex:1; min-width:0" placeholder="Uses agent default workspace"
          data-coder-workdir
          .value=${_runForm.cwd}
          @input=${(e: Event) => { _runForm.cwd = (e.target as HTMLInputElement).value; _rerender(); }} />
        ${renderRepoDirButton((path) => { _runForm.cwd = path; _rerender(); }, { title: "Coder working directory", initialPath: _runForm.cwd || undefined })}
      </div>
    </div>

    <!-- Autonomous toggle ───────────────────────────────────── -->
    <div class="form-group" style="background:rgba(245,166,35,0.06); border:1px solid rgba(245,166,35,0.2); padding:10px 12px; border-radius:8px;">
      <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-weight:600; color:#f5a623;">
        <input type="checkbox"
          .checked=${_runForm.autonomous}
          @change=${(e: Event) => { _runForm.autonomous = (e.target as HTMLInputElement).checked; _rerender(); }}
          style="accent-color:#f5a623;" />
        <span style="display:flex; align-items:center; gap:6px;">${RUN_ICONS.bot} Run autonomously</span>
      </label>
      <div style="font-size:11px; color:#aaa; margin-top:6px; padding-left:24px;">
        Autonomous runs require a connected GitHub repo and approval via Telegram for any task classified as critical.
      </div>
    </div>

    ${_analysisError ? html`
      <div class="run-alert run-alert-error" style="display:flex; align-items:center; gap:6px;">${RUN_ICONS.alert} ${_analysisError}</div>
    ` : nothing}
  `;

  // ── Precheck phase: GitHub repo verification ─────────────────────────
  const renderPrecheckPhase = () => {
    if (_precheckLoading) {
      return html`
        <div class="run-analysis-loading">
          <div class="run-analysis-spinner"></div>
          <div class="run-analysis-text">
            <div style="font-weight:600; color:var(--g-primary); display:flex; align-items:center; gap:6px;">${RUN_ICONS.github} Checking GitHub connection</div>
            <div style="color:#888; font-size:12px; margin-top:4px;">Verifying repo, remote, and branch state…</div>
          </div>
        </div>
      `;
    }
    if (!_precheckResult) return nothing;
    const r = _precheckResult;
    const slug = r.github ? `${r.github.owner}/${r.github.repo}` : null;
    return html`
      <div class="run-alert ${r.ok ? "run-alert-success" : "run-alert-error"}" style="display:flex; align-items:flex-start; gap:8px;">
        <span style="margin-top:2px;">${r.ok ? RUN_ICONS.check : RUN_ICONS.alert}</span>
        <div>
          <div style="font-weight:600;">${r.ok ? "GitHub repo connected." : "GitHub repo not connected."}</div>
          ${r.message ? html`<div style="font-size:12px; opacity:0.85;">${r.message}</div>` : nothing}
        </div>
      </div>
      <div style="margin-top:12px; display:grid; grid-template-columns: 130px 1fr; gap:6px 12px; font-size:12px; color:#ccc;">
        <div style="color:#888;">Working dir</div><div style="font-family:monospace;">${r.cwd}</div>
        <div style="color:#888;">Remote</div><div style="font-family:monospace;">${slug ? `github.com/${slug}` : (r.remote || "—")}</div>
        <div style="color:#888;">Branch</div><div>${r.branch}${r.onDefaultBranch ? html` <span style="color:#f59e0b; font-size:11px;">(default)</span>` : ""}</div>
        <div style="color:#888;">Uncommitted</div><div>${r.dirtyFiles} file${r.dirtyFiles === 1 ? "" : "s"}</div>
        <div style="color:#888;">Ahead / behind</div><div>${r.ahead} / ${r.behind}</div>
      </div>
      ${!r.ok ? html`
        <div style="margin-top:14px; font-size:12px; color:#aaa;">
          To fix: open a terminal in this directory and run
          <code style="background:#000; padding:2px 6px; border-radius:4px;">git remote add origin git@github.com:OWNER/REPO.git</code>,
          then re-run the precheck.
        </div>
      ` : nothing}
    `;
  };

  // ── Classify phase: criticality summary ─────────────────────────────
  const renderClassifyPhase = () => {
    const c = _classification;
    if (!c) {
      return html`
        <div class="run-analysis-loading">
          <div class="run-analysis-spinner"></div>
          <div class="run-analysis-text">
            <div style="font-weight:600; color:var(--g-primary); display:flex; align-items:center; gap:6px;">${RUN_ICONS.shield} Classifying task</div>
            <div style="color:#888; font-size:12px; margin-top:4px;">Determining criticality…</div>
          </div>
        </div>
      `;
    }
    const tone = c.criticality === "critical" ? "error" : c.criticality === "medium" ? "info" : "success";
    return html`
      <div class="run-alert run-alert-${tone}" style="display:flex; align-items:flex-start; gap:8px;">
        <span style="margin-top:2px;">${c.criticality === "critical" ? RUN_ICONS.alert : RUN_ICONS.info}</span>
        <div>
          <div style="font-weight:600; text-transform:capitalize;">Criticality: ${c.criticality}</div>
          ${c.reasons.length ? html`
            <ul style="margin:6px 0 0 0; padding-left:18px; font-size:12px; opacity:0.9;">
              ${c.reasons.map((r) => html`<li>${r}</li>`)}
            </ul>
          ` : nothing}
        </div>
      </div>
      ${c.requiresApproval ? html`
        <div style="margin-top:14px; padding:10px 12px; background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.25); border-radius:8px; font-size:12px; color:#fca5a5; display:flex; align-items:center; gap:6px;">
          ${RUN_ICONS.shield} This task is critical. Telegram approval is required before the agent can start.
        </div>
      ` : nothing}
    `;
  };

  // ── Approval phase: waiting for Telegram decision ───────────────────
  const renderApprovalPhase = () => {
    const a = _approval;
    if (!a) return nothing;
    if (a.status === "pending") {
      return html`
        <div class="run-analysis-loading">
          <div class="run-analysis-spinner"></div>
          <div class="run-analysis-text">
            <div style="font-weight:600; color:var(--g-primary); display:flex; align-items:center; gap:6px;">${RUN_ICONS.send} Awaiting Telegram approval</div>
            <div style="color:#888; font-size:12px; margin-top:4px;">A request was sent to the configured Telegram chat. Approve or deny the task to continue.</div>
            <div style="color:#666; font-size:11px; margin-top:6px;">Approval id: ${a.id}</div>
          </div>
        </div>
      `;
    }
    if (a.status === "approved") {
      return html`
        <div class="run-alert run-alert-success" style="display:flex; align-items:center; gap:8px;">
          ${RUN_ICONS.check}
          <div>
            <div style="font-weight:600;">Approved by ${a.decidedBy ?? "Telegram"}</div>
            <div style="font-size:12px; opacity:0.85;">Click Run to spawn the agent.</div>
          </div>
        </div>
      `;
    }
    return html`
      <div class="run-alert run-alert-error" style="display:flex; align-items:center; gap:8px;">
        ${RUN_ICONS.close}
        <div>
          <div style="font-weight:600;">Denied${a.decidedBy ? ` by ${a.decidedBy}` : ""}</div>
          <div style="font-size:12px; opacity:0.85;">${a.reason ?? "No reason given."}</div>
        </div>
      </div>
    `;
  };

  // ── Analyzing phase: loading spinner ──────────────────────────────────
  const renderAnalyzingPhase = () => html`
    <div class="run-analysis-loading">
      <div class="run-analysis-spinner"></div>
      <div class="run-analysis-text">
        <div style="font-weight: 600; color: var(--g-primary)">Analyzing task...</div>
        <div style="color: #888; font-size: 12px; margin-top: 4px">Agent is reviewing the task to determine if additional context is needed</div>
      </div>
    </div>
  `;

  // ── Questions phase: display questions as form fields ──────────────────────────────────
  const renderQuestionsPhase = () => {
    if (!_analysisResult) return nothing;
    return html`
      ${_analysisResult.summary ? html`
        <div class="run-alert run-alert-info">
          <strong>Analysis:</strong> ${_analysisResult.summary}
        </div>
      ` : nothing}
      <div style="font-weight: 600; color: #f59e0b; font-size: 13px; margin-bottom: 12px; display:flex; align-items:center; gap:6px;">
        ${RUN_ICONS.message} The agent needs some additional context before proceeding:
      </div>
      ${_analysisResult.questions.map((q) => html`
        <div class="form-group">
          <label class="form-label">
            ${q.label}
            ${q.required ? html`<span style="color: #ef4444">*</span>` : nothing}
          </label>
          ${q.type === "textarea" ? html`
            <textarea class="form-textarea" rows="3"
              placeholder=${q.placeholder || ""}
              .value=${_analysisAnswers[q.id] || ""}
              @input=${(e: Event) => { _analysisAnswers[q.id] = (e.target as HTMLTextAreaElement).value; _rerender(); }}></textarea>
          ` : q.type === "select" && q.options?.length ? html`
            <select class="form-select"
              .value=${_analysisAnswers[q.id] || ""}
              @change=${(e: Event) => { _analysisAnswers[q.id] = (e.target as HTMLSelectElement).value; _rerender(); }}>
              <option value="">— Select —</option>
              ${q.options.map((opt) => html`<option value=${opt} ?selected=${_analysisAnswers[q.id] === opt}>${opt}</option>`)}
            </select>
          ` : html`
            <input type="text" class="form-input"
              placeholder=${q.placeholder || ""}
              .value=${_analysisAnswers[q.id] || ""}
              @input=${(e: Event) => { _analysisAnswers[q.id] = (e.target as HTMLInputElement).value; _rerender(); }} />
          `}
        </div>
      `)}
      ${_analysisResult.suggestions?.length ? html`
        <div style="margin-top: 8px">
          <div style="font-size: 11px; color: #888; margin-bottom: 4px; display:flex; align-items:center; gap:4px;">${RUN_ICONS.info} Suggestions:</div>
          ${_analysisResult.suggestions.map((s) => html`
            <div style="font-size: 12px; color: #aaa; padding: 2px 0">• ${s}</div>
          `)}
        </div>
      ` : nothing}
    `;
  };

  // ── Ready phase: summary + confirm ──────────────────────────────────
  const renderReadyPhase = () => html`
    ${_analysisResult?.summary ? html`
      <div class="run-alert run-alert-success" style="display:flex; align-items:flex-start; gap:8px;">
        <span style="margin-top:2px;">${RUN_ICONS.check}</span>
        <div><strong>Ready to go.</strong> ${_analysisResult.summary}</div>
      </div>
    ` : html`
      <div class="run-alert run-alert-success" style="display:flex; align-items:flex-start; gap:8px;">
        <span style="margin-top:2px;">${RUN_ICONS.check}</span>
        <div><strong>Task is clear and actionable.</strong> Ready to spawn agent.</div>
      </div>
    `}
    ${_runForm.autonomous && _approval?.status === "approved" ? html`
      <div style="margin-top:8px; padding:8px 10px; background:rgba(34,197,94,0.08); border:1px solid rgba(34,197,94,0.25); border-radius:6px; font-size:12px; color:#4ade80; display:flex; align-items:center; gap:6px;">
        ${RUN_ICONS.shield} Approved by ${_approval.decidedBy ?? "Telegram"}.
      </div>
    ` : nothing}
    ${_analysisResult?.suggestions?.length ? html`
      <div style="margin-top: 8px">
        <div style="font-size: 11px; color: #888; margin-bottom: 4px; display:flex; align-items:center; gap:4px;">${RUN_ICONS.info} Suggestions:</div>
        ${_analysisResult.suggestions.map((s) => html`
          <div style="font-size: 12px; color: #aaa; padding: 2px 0">• ${s}</div>
        `)}
      </div>
    ` : nothing}
  `;

  // ── Done phase: result ──────────────────────────────────
  const renderDonePhase = () => {
    if (!_runResult) return nothing;
    return html`
      <div style="text-align: center; padding: 20px 0">
        ${_runResult.status === "error" ? html`
          <div style="display:flex; justify-content:center; margin-bottom:12px; color:#f87171;">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          </div>
          <div style="color: #f87171; font-weight: 600">${_runResult.error}</div>
        ` : html`
          <div style="display:flex; justify-content:center; margin-bottom:12px; color:#4ade80;">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/><circle cx="12" cy="12" r="10"/></svg>
          </div>
          <div style="color: #4ade80; font-weight: 600; font-size: 16px">Agent Spawned</div>
          <div style="color: #888; font-size: 12px; margin-top: 8px">
            ${_runResult.terminalId ? "Terminal session active — check terminal tab" : "Running in background — check activity tab"}
          </div>
          <div style="color: #666; font-size: 11px; margin-top: 4px">Session: ${_runResult.sessionKey || "—"}</div>
        `}
      </div>
    `;
  };

  // ── Footer actions based on phase ──────────────────────────────────
  const renderFooter = () => {
    switch (_runPhase) {
      case "setup":
        if (_runForm.autonomous) {
          return html`
            <button class="btn-secondary" @click=${() => { _showRunDialog = false; _rerender(); }}>Cancel</button>
            <button class="btn-primary run-btn-analyze"
              style="display:flex; align-items:center; gap:6px;"
              @click=${() => runPrecheck(props.client)}>
              ${RUN_ICONS.github} Verify GitHub
            </button>
          `;
        }
        return html`
          <button class="btn-secondary" @click=${() => { _showRunDialog = false; _rerender(); }}>Cancel</button>
          <button class="btn-primary run-btn-analyze"
            style="display:flex; align-items:center; gap:6px;"
            @click=${() => runAnalysis(props.client)}>
            ${RUN_ICONS.search} Analyze First
          </button>
          <button class="btn-primary run-btn-skip"
            style="display:flex; align-items:center; gap:6px;"
            @click=${() => { _runPhase = "ready"; _rerender(); }}>
            ${RUN_ICONS.play} Skip &amp; Run
          </button>
        `;
      case "precheck":
        if (_precheckLoading) {
          return html`
            <button class="btn-secondary" disabled>
              <span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block"></span>
              Checking…
            </button>
          `;
        }
        if (_precheckResult?.ok) {
          return html`
            <button class="btn-secondary" @click=${() => { _runPhase = "setup"; _rerender(); }}>Back</button>
            <button class="btn-primary"
              style="display:flex; align-items:center; gap:6px;"
              @click=${() => runAnalysis(props.client)}>
              ${RUN_ICONS.search} Continue to Analyze
            </button>
          `;
        }
        return html`
          <button class="btn-secondary" @click=${() => { _runPhase = "setup"; _rerender(); }}>Back</button>
          <button class="btn-primary"
            style="display:flex; align-items:center; gap:6px;"
            @click=${() => runPrecheck(props.client)}>
            ${RUN_ICONS.loop} Recheck
          </button>
        `;
      case "analyzing":
        return html`
          <button class="btn-secondary" @click=${() => { _runPhase = _runForm.autonomous ? "precheck" : "setup"; _rerender(); }}>Cancel</button>
        `;
      case "questions": {
        const requiredAnswered = (_analysisResult?.questions || [])
          .filter((q) => q.required)
          .every((q) => (_analysisAnswers[q.id] || "").trim());
        return html`
          <button class="btn-secondary" @click=${() => { _runPhase = _runForm.autonomous ? "precheck" : "setup"; _rerender(); }}>Back</button>
          <button class="btn-primary" style="background: #22c55e; color: #000; font-weight: 600; display:flex; align-items:center; gap:6px;"
            ?disabled=${!requiredAnswered}
            @click=${async () => {
              if (_runForm.autonomous) {
                _classification = await runClassify(props.client);
                _runPhase = "classify";
                _rerender();
              } else {
                _runPhase = "ready";
                _rerender();
              }
            }}>
            Continue ${RUN_ICONS.check}
          </button>
        `;
      }
      case "classify":
        if (!_classification) {
          return html`<button class="btn-secondary" disabled>Classifying…</button>`;
        }
        if (_classification.requiresApproval) {
          return html`
            <button class="btn-secondary" @click=${() => { _runPhase = "setup"; _rerender(); }}>Back</button>
            <button class="btn-primary" style="background:#f59e0b; color:#000; font-weight:600; display:flex; align-items:center; gap:6px;"
              @click=${() => requestApproval(props.client)}>
              ${RUN_ICONS.send} Request Telegram Approval
            </button>
          `;
        }
        return html`
          <button class="btn-secondary" @click=${() => { _runPhase = "setup"; _rerender(); }}>Back</button>
          <button class="btn-primary" style="background:#22c55e; color:#000; font-weight:600; display:flex; align-items:center; gap:6px;"
            @click=${() => { _runPhase = "ready"; _rerender(); }}>
            Continue ${RUN_ICONS.check}
          </button>
        `;
      case "approval": {
        const a = _approval;
        if (!a || a.status === "pending") {
          return html`
            <button class="btn-secondary" @click=${() => { _stopApprovalPolling(); _runPhase = "classify"; _rerender(); }}>Cancel</button>
            <button class="btn-secondary" disabled>
              <span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block"></span>
              Waiting for approval…
            </button>
          `;
        }
        if (a.status === "approved") {
          return html`
            <button class="btn-secondary" @click=${() => { _runPhase = "setup"; _rerender(); }}>Back</button>
            <button class="btn-primary" style="background:#22c55e; color:#000; font-weight:600; display:flex; align-items:center; gap:6px;"
              @click=${() => { _runPhase = "ready"; _rerender(); }}>
              ${RUN_ICONS.check} Continue
            </button>
          `;
        }
        return html`
          <button class="btn-secondary" @click=${() => { _runPhase = "setup"; _rerender(); }}>Back to Setup</button>
          <button class="btn-primary" style="display:flex; align-items:center; gap:6px;"
            @click=${() => requestApproval(props.client)}>
            ${RUN_ICONS.loop} Request Again
          </button>
        `;
      }
      case "ready":
        return html`
          <button class="btn-secondary" @click=${() => { _runPhase = "setup"; _rerender(); }}>Back</button>
          <button class="btn-primary" style="background: #22c55e; color: #000; font-weight: 600; display: flex; align-items: center; gap: 6px"
            @click=${() => executeRun(props.client)}>
            ${RUN_ICONS.play} Run
          </button>
        `;
      case "spawning":
        return html`
          <button class="btn-secondary" disabled>
            <span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block"></span>
            Spawning...
          </button>
        `;
      case "done":
        return html`
          <button class="btn-secondary" @click=${() => { _showRunDialog = false; _rerender(); }}>Close</button>
        `;
      default:
        return nothing;
    }
  };

  const isLocked = _runPhase === "analyzing" || _runPhase === "spawning" || _runPhase === "approval" || _runPhase === "precheck";
  return html`
    <div class="modal-backdrop" @click=${() => { if (!isLocked) { _showRunDialog = false; _stopApprovalPolling(); _rerender(); } }}>
      <div class="modal-content run-dialog" @click=${(e: Event) => e.stopPropagation()}>
        <div class="modal-header">
          <div style="display: flex; align-items: center; gap: 10px; color: var(--g-primary);">
            ${_runForm.autonomous ? RUN_ICONS.bot : RUN_ICONS.play}
            <h3 style="margin: 0">Run ${isTask ? "Task" : "Project"}${_runForm.autonomous ? " · Autonomous" : ""}</h3>
          </div>
          <button class="modal-close" @click=${() => { if (!isLocked) { _showRunDialog = false; _stopApprovalPolling(); _rerender(); } }}>${RUN_ICONS.close}</button>
        </div>
        <div class="modal-body">
          <!-- Task/Project header -->
          <div class="run-task-header">
            <div class="run-task-title" style="display:flex; align-items:center; gap:6px;">${RUN_ICONS.flag} ${title}</div>
            ${(_runTargetTask?.description || _runTargetProject?.description) ? html`
              <div class="run-task-desc">${(_runTargetTask?.description || _runTargetProject?.description || "").slice(0, 200)}</div>
            ` : nothing}
          </div>

          ${renderPhaseBar()}

          <div style="margin-top: 20px">
            ${_runPhase === "setup" ? renderSetupPhase() : nothing}
            ${_runPhase === "precheck" ? renderPrecheckPhase() : nothing}
            ${_runPhase === "analyzing" ? renderAnalyzingPhase() : nothing}
            ${_runPhase === "questions" ? renderQuestionsPhase() : nothing}
            ${_runPhase === "classify" ? renderClassifyPhase() : nothing}
            ${_runPhase === "approval" ? renderApprovalPhase() : nothing}
            ${_runPhase === "ready" ? renderReadyPhase() : nothing}
            ${_runPhase === "spawning" ? renderAnalyzingPhase() : nothing}
            ${_runPhase === "done" ? renderDonePhase() : nothing}
          </div>
        </div>
        <div class="modal-footer">
          ${renderFooter()}
        </div>
      </div>
    </div>
  `;
}

// ── Assign-parent-project picker modal ───────────────────────────────────
function renderParentPicker(props: KanbanViewProps) {
  if (!_parentPickerProjectId) return nothing;
  const target = props.projects.find((p) => p.id === _parentPickerProjectId);
  if (!target) return nothing;

  // Cycle guard: self + all descendants are ineligible as a parent.
  const blocked = collectSelfAndDescendantIds(props.projects, target.id);
  const q = _parentPickerDebouncedQuery;
  // Full-text across name + description (+ type/status for convenience).
  const candidates = props.projects
    .filter((p) => !blocked.has(p.id))
    .filter((p) => {
      if (!q) return true;
      const hay = `${p.name ?? ""} ${p.description ?? ""} ${(p.type ?? []).join(" ")} ${p.status ?? ""}`.toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) // most-recently-updated first
    .slice(0, 50);

  const currentParent = target.parentProjectId
    ? props.projects.find((p) => p.id === target.parentProjectId)
    : null;

  // Business map → used as the closest "owner" the project model carries.
  const bizName = new Map((props.businesses ?? []).map((b) => [b.id, b.name]));
  const ownerOf = (p: KanbanProject): string | null =>
    p.businessId ? (bizName.get(p.businessId) ?? null) : null;

  const choose = (parentId: string | null) => {
    // Defensive cycle guard (the list already excludes descendants; the
    // gateway enforces this authoritatively too).
    if (parentId && collectSelfAndDescendantIds(props.projects, target.id).has(parentId)) {
      kanbanToast("Can't set parent — that would create a cycle", "error");
      return;
    }
    props.onUpdateProject(target.id, { parentProjectId: parentId } as Partial<KanbanProject>);
    if (parentId) {
      const p = props.projects.find((x) => x.id === parentId);
      kanbanToast(`Parent set to “${p?.name ?? "project"}”`);
    } else {
      kanbanToast("Parent removed");
    }
    // Optimistic update reflects instantly; no immediate onRefresh (the
    // Notion-backed list lags the relation write — the background poll
    // reconciles). Keeps the parent chip in sync without a stale flash.
    closeParentPicker();
  };

  // Build the keyboard-navigable list. When the project already has a parent,
  // the first row is a "make top-level" clear action.
  type NavItem = { kind: "clear" } | { kind: "project"; project: KanbanProject };
  const navItems: NavItem[] = [
    ...(currentParent ? [{ kind: "clear" } as NavItem] : []),
    ...candidates.map((p) => ({ kind: "project", project: p } as NavItem)),
  ];
  const activeIndex = navItems.length === 0
    ? -1
    : Math.min(Math.max(_parentPickerActiveIndex, 0), navItems.length - 1);

  const runNav = (item: NavItem | undefined) => {
    if (!item) return;
    choose(item.kind === "clear" ? null : item.project.id);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); closeParentPicker(); return; }
    if (_parentPickerLoading || navItems.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      _parentPickerActiveIndex = Math.min(activeIndex + 1, navItems.length - 1);
      _rerender();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      _parentPickerActiveIndex = Math.max(activeIndex - 1, 0);
      _rerender();
    } else if (e.key === "Enter") {
      e.preventDefault();
      runNav(navItems[activeIndex]);
    }
  };

  const renderSkeleton = () => html`
    ${[0, 1, 2, 3, 4].map(() => html`
      <div class="pp-row pp-skeleton">
        <span class="pp-skel-icon"></span>
        <span class="pp-skel-line"></span>
        <span class="pp-skel-pill"></span>
      </div>
    `)}
  `;

  return html`
    <style>
      .pp-row {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 10px; border-radius: 8px; cursor: pointer;
        border: 1px solid transparent; color: #ddd; font-size: 13px;
        transition: background 0.12s, border-color 0.12s;
      }
      .pp-row:hover { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.12); }
      .pp-row--nav { background: rgba(168,85,247,0.16); border-color: rgba(168,85,247,0.45); }
      .pp-row--current { background: rgba(168,85,247,0.10); border-color: rgba(168,85,247,0.30); }
      .pp-row--clear { color: #9aa; font-style: italic; }
      .pp-icon { font-size: 14px; opacity: 0.85; flex: 0 0 auto; }
      .pp-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .pp-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pp-sub { display: flex; align-items: center; gap: 8px; font-size: 10px; color: #888; }
      .pp-status { text-transform: uppercase; letter-spacing: 0.04em; }
      .pp-owner { color: #9a8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px; }
      .pp-updated { color: #777; }
      .pp-check { color: #a855f7; font-weight: 700; flex: 0 0 auto; }
      .pp-hint { font-size: 10px; color: #666; margin-top: 8px; text-align: right; }
      .pp-skeleton { cursor: default; }
      .pp-skel-icon, .pp-skel-line, .pp-skel-pill {
        background: linear-gradient(90deg, rgba(255,255,255,0.05), rgba(255,255,255,0.12), rgba(255,255,255,0.05));
        background-size: 200% 100%; animation: pp-shimmer 1.1s ease-in-out infinite; border-radius: 5px;
      }
      .pp-skel-icon { width: 16px; height: 16px; flex: 0 0 auto; }
      .pp-skel-line { flex: 1; height: 12px; }
      .pp-skel-pill { width: 46px; height: 12px; flex: 0 0 auto; }
      @keyframes pp-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    </style>
    <div class="modal-backdrop" @click=${() => closeParentPicker()}>
      <div class="modal-content" style="max-width: 480px;" @click=${(e: Event) => e.stopPropagation()}>
        <div class="modal-header">
          <div style="display:flex; align-items:center; gap:10px; color: var(--g-primary);">
            <span style="font-size:18px;">⤷</span>
            <h3 style="margin:0">Assign parent project</h3>
          </div>
          <button class="modal-close" @click=${() => closeParentPicker()}>✕</button>
        </div>
        <div class="modal-body">
          <div style="font-size:12px; color:#888; margin-bottom:10px;">
            Choose a parent for <strong style="color:#ccc;">${target.name}</strong>.
            ${currentParent
              ? html`Currently under <strong style="color:#ccc;">${currentParent.name}</strong>.`
              : nothing}
          </div>
          <input
            type="text"
            class="form-input pp-search-input"
            placeholder="Search projects…"
            .value=${_parentPickerQuery}
            @input=${(e: Event) => setParentPickerQuery((e.target as HTMLInputElement).value)}
            @keydown=${onKeyDown}
          />
          <div style="margin-top:10px; max-height:320px; overflow:auto; display:flex; flex-direction:column; gap:4px;">
            ${_parentPickerLoading
              ? renderSkeleton()
              : navItems.length === 0
                ? html`<div style="color:#666; font-size:12px; padding:14px; text-align:center;">
                    ${q ? "No matching projects." : "No eligible projects."}
                  </div>`
                : navItems.map((item, idx) => {
                    const isNav = idx === activeIndex;
                    if (item.kind === "clear") {
                      return html`
                        <div class="pp-row pp-row--clear ${isNav ? "pp-row--nav" : ""}"
                          ${ref((el) => { if (el && isNav) (el as HTMLElement).scrollIntoView({ block: "nearest" }); })}
                          @click=${() => runNav(item)}>
                          <span class="pp-icon">⤴</span>
                          <span class="pp-main"><span class="pp-name">No parent (make top-level)</span></span>
                        </div>
                      `;
                    }
                    const p = item.project;
                    const isCurrent = target.parentProjectId === p.id;
                    const owner = ownerOf(p);
                    return html`
                      <div class="pp-row ${isNav ? "pp-row--nav" : ""} ${isCurrent ? "pp-row--current" : ""}"
                        ${ref((el) => { if (el && isNav) (el as HTMLElement).scrollIntoView({ block: "nearest" }); })}
                        @click=${() => runNav(item)}>
                        <span class="pp-icon">${icons.folder}</span>
                        <span class="pp-main">
                          <span class="pp-name">${p.name}</span>
                          <span class="pp-sub">
                            ${p.status ? html`<span class="pp-status">${p.status}</span>` : nothing}
                            ${owner ? html`<span class="pp-owner">${icons.person} ${owner}</span>` : nothing}
                            ${p.updatedAt ? html`<span class="pp-updated">${formatTimeAgo(p.updatedAt)}</span>` : nothing}
                            <ib-repo-badge compact readonly .projectId=${p.id} .projectName=${p.name}></ib-repo-badge>
                          </span>
                        </span>
                        ${isCurrent ? html`<span class="pp-check">✓</span>` : nothing}
                      </div>
                    `;
                  })}
          </div>
          <div class="pp-hint">↑↓ to navigate · Enter to select · Esc to close</div>
        </div>
      </div>
    </div>
  `;
}

// ── Task visualization modal ─────────────────────────────────────────────
function renderTaskModal(props: KanbanViewProps) {
  if (!_taskModalProjectId) return nothing;
  const project = props.projects.find(p => p.id === _taskModalProjectId);
  if (!project) return nothing;

  const projectTasks = props.tasks.filter(t => taskMatchesProject(t, project));

  // Group by status in column order
  const STATUS_ORDER: TaskStatus[] = ["todo", "in_progress", "review", "done"];
  const grouped = STATUS_ORDER.map(s => ({
    col: STATUS_COLUMNS.find(c => c.id === s)!,
    tasks: projectTasks.filter(t => t.status === s || (s === "todo" && !STATUS_ORDER.includes(t.status as TaskStatus))),
  }));

  // Flat list for keyboard navigation
  const flat = grouped.flatMap(g => g.tasks);
  const focusedTask = flat[_taskModalFocusIdx] ?? null;

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); closeTaskModal(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      _taskModalFocusIdx = Math.min(_taskModalFocusIdx + 1, flat.length - 1);
      _rerender();
    }
    if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      _taskModalFocusIdx = Math.max(_taskModalFocusIdx - 1, 0);
      _rerender();
    }
    if (e.key === "Enter" && focusedTask) {
      _taskDetailId = focusedTask.id;
      _rerender();
    }
  };

  const renderTaskRow = (task: KanbanTask, idx: number) => {
    const statusCfg = STATUS_COLUMNS.find(c => c.id === task.status) ?? STATUS_COLUMNS[0];
    const isActive = flat.indexOf(task) === _taskModalFocusIdx;
    const updatedAgo = task.updatedAt ? formatTimeAgo(task.updatedAt) : null;
    return html`
      <div class="tm-task ${isActive ? 'tm-task--focused' : ''}"
           tabindex="0"
           @click=${() => { _taskDetailId = task.id; closeTaskModal(); _rerender(); }}
           @focus=${() => { _taskModalFocusIdx = flat.indexOf(task); _rerender(); }}>
        <span class="tm-status-dot" style="background:${statusCfg.color}"></span>
        <span class="tm-task-title">${task.title}</span>
        ${task.assignee ? html`<span class="tm-assignee" title="Assignee">${task.assignee.split(",")[0].trim()}</span>` : nothing}
        ${updatedAgo ? html`<span class="tm-updated">${updatedAgo}</span>` : nothing}
      </div>
    `;
  };

  return html`
    <div class="modal-backdrop" @click=${closeTaskModal} @keydown=${handleKeyDown}>
      <div class="modal-content modal-tasks-view" @click=${(e: Event) => e.stopPropagation()}>
        <div class="modal-header">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:1.2rem">${project.name}</span>
            <span class="tm-total-badge">${projectTasks.length} task${projectTasks.length !== 1 ? "s" : ""}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <button class="btn-secondary" style="font-size:0.75rem;padding:4px 10px"
              @click=${() => { closeTaskModal(); props.onEnterProject(project.id); }}>
              Open full board →
            </button>
            <button class="modal-close" @click=${closeTaskModal}>✕</button>
          </div>
        </div>
        <div class="modal-body" style="padding:0;gap:0">
          ${projectTasks.length === 0 ? html`
            <div class="tm-empty">
              <div class="tm-empty-icon">✓</div>
              <div>No tasks for this project yet.</div>
              <div style="font-size:0.75rem;color:#666;margin-top:4px">Open the full board to create tasks.</div>
            </div>
          ` : html`
            <div class="tm-columns">
              ${grouped.filter(g => g.tasks.length > 0).map(g => html`
                <div class="tm-col">
                  <div class="tm-col-header" style="color:${g.col.color}">
                    <span class="tm-col-dot" style="background:${g.col.color}"></span>
                    ${g.col.label}
                    <span class="tm-col-count">${g.tasks.length}</span>
                  </div>
                  <div class="tm-col-body">
                    ${g.tasks.map((t, i) => renderTaskRow(t, i))}
                  </div>
                </div>
              `)}
            </div>
          `}
        </div>
        <div class="modal-footer" style="justify-content:space-between;align-items:center">
          <span style="font-size:0.72rem;color:#555">↑↓ navigate · Enter expand · Esc close</span>
          <button class="btn-secondary" @click=${closeTaskModal}>Close</button>
        </div>
      </div>
    </div>
  `;
}

// ── Skeleton gallery (shown while cold-loading before any cache) ─────────
function renderSkeletonGallery() {
  const card = () => html`
    <div class="gc gc-skeleton" aria-hidden="true">
      <div class="gc-inner">
        <div class="gc-header" style="background:rgba(255,255,255,0.03)">
          <div class="skeleton-box" style="width:36px;height:36px;border-radius:10px;flex-shrink:0"></div>
          <div style="flex:1;display:flex;flex-direction:column;gap:6px">
            <div class="skeleton-box" style="width:70%;height:10px;border-radius:4px"></div>
          </div>
        </div>
        <div class="gc-body">
          <div class="skeleton-box" style="width:80%;height:16px;border-radius:4px"></div>
          <div class="skeleton-box" style="width:55%;height:11px;border-radius:4px;margin-top:4px"></div>
          <div style="display:flex;gap:6px;margin-top:6px">
            <div class="skeleton-box" style="width:50px;height:20px;border-radius:6px"></div>
            <div class="skeleton-box" style="width:40px;height:20px;border-radius:6px"></div>
          </div>
        </div>
        <div class="gc-footer" style="padding:12px 16px">
          <div class="skeleton-box" style="width:100%;height:4px;border-radius:2px"></div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <div class="skeleton-box" style="width:50px;height:10px;border-radius:3px"></div>
            <div class="skeleton-box" style="width:60px;height:10px;border-radius:3px"></div>
          </div>
        </div>
      </div>
    </div>
  `;
  return html`
    <div class="gallery-grid" aria-busy="true" aria-label="Loading projects">
      ${Array.from({ length: 8 }, () => card())}
    </div>
  `;
}

// ── Quiet Notion-sync chip ──────────────────────────────────────────
// Notion is an optional mirror. The board never errors because of it; when
// writes are queued for Notion (it's down/rate-limited) we show one muted
// chip, and nothing at all when Notion isn't connected or is healthy.
let _notionSyncHealth: {
  state: string;
  pending: number;
  needsAttention: number;
  reasons: string[];
  nextRetryInMs: number | null;
} | null = null;
let _notionSyncCheckedAt = 0;
let _notionSyncInFlight = false;
const NOTION_SYNC_CHECK_MS = 60_000;

function fmtWait(ms: number | null): string {
  if (ms == null) return "";
  const m = Math.round(ms / 60_000);
  return m <= 0 ? " · retrying now" : ` · retry in ${m}m`;
}

function renderNotionSyncChip(client: any) {
  if (client && !_notionSyncInFlight && Date.now() - _notionSyncCheckedAt > NOTION_SYNC_CHECK_MS) {
    _notionSyncInFlight = true;
    _notionSyncCheckedAt = Date.now();
    void Promise.resolve(client.request("kanban.notionSync.status", {}))
      .then((res: any) => {
        const next =
          res && typeof res.state === "string"
            ? {
                state: res.state as string,
                pending: Number(res.pending) || 0,
                needsAttention: Number(res.needsAttention) || 0,
                reasons: Array.isArray(res.deadLetters)
                  ? Array.from(
                      new Set(
                        res.deadLetters
                          .map((d: any) => String(d?.reason ?? ""))
                          .filter(Boolean) as string[],
                      ),
                    ).slice(0, 3)
                  : [],
                nextRetryInMs: typeof res.nextRetryInMs === "number" ? res.nextRetryInMs : null,
              }
            : null;
        const changed =
          next?.state !== _notionSyncHealth?.state ||
          next?.pending !== _notionSyncHealth?.pending ||
          next?.needsAttention !== _notionSyncHealth?.needsAttention;
        _notionSyncHealth = next;
        if (changed) _rerender();
      })
      .catch(() => {
        // Older gateway without the method — stay silent.
      })
      .finally(() => {
        _notionSyncInFlight = false;
      });
  }
  const h = _notionSyncHealth;
  if (!h || (h.state !== "paused" && h.state !== "attention")) return nothing;
  const chipStyle =
    "display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:11px;line-height:18px;color:var(--muted, #9ca3af);border:1px solid var(--border, rgba(255,255,255,0.12));white-space:nowrap;background:transparent;";
  if (h.state === "attention") {
    const n = h.needsAttention;
    return html`<button
      class="kanban-notion-chip"
      data-testid="notion-sync-attention"
      title=${`Notion rejected ${n} change${n === 1 ? "" : "s"} (kept here, not retried):\n${h.reasons.join("\n")}\nClick to retry after fixing the Notion database.`}
      style=${`${chipStyle}cursor:pointer;`}
      @click=${() => {
        void Promise.resolve(client?.request("kanban.notionSync.retry", {})).finally(() => {
          _notionSyncCheckedAt = 0;
          _rerender();
        });
      }}
    >
      Notion: ${n} need${n === 1 ? "s" : ""} attention · Retry
    </button>`;
  }
  const n = h.pending;
  return html`<span
    class="kanban-notion-chip"
    data-testid="notion-sync-chip"
    title=${`Notion is unreachable right now. Everything is saved here; ${n} change${n === 1 ? "" : "s"} will sync to Notion automatically.`}
    style=${chipStyle}
    >Notion sync paused${n > 0 ? ` · ${n} queued` : ""}${fmtWait(h.nextRetryInMs)}</span
  >`;
}

export function renderKanban(props: KanbanViewProps) {
  const { loading, error, galleryView, refreshing } = props;
  // Store requestUpdate ref for async re-renders
  if (props.onRequestUpdate) _currentRequestUpdate = props.onRequestUpdate;

  // Doc-agent panel mount — only when a project is open (board view) and we
  // have a client. Galleries / lists don't represent a single document.
  const openProject = props.selectedProjectId
    ? props.projects.find((p) => p.id === props.selectedProjectId)
    : null;

  // Kick off recently-completed feeds on first gallery render (when client present)
  if (props.client && props.onRequestUpdate) {
    // Shared feed (activity panel + agent-activity dashboard still use this)
    void loadRecentlyCompleted(props.client, props.onRequestUpdate);
    subscribeRecentCompleted(props.client);
    // Projects-page polished component — self-contained state
    initProjectsRecentlyCompleted(props.client, props.onRequestUpdate);
    // Sub-agent → kanban-task badge feed
    ensureSubagentPolling(props.client);
  }

  // Show skeletons only on a true cold load (loading=true, nothing cached yet)
  const showSkeletons = loading && props.projects.length === 0;

  return html`
    <div class="kanban-layout kb-g1 ${openProject && !galleryView && props.client ? "kb-has-agent-fab" : ""}">
      ${error ? html`
        <div class="kanban-error">
          <span>${error}</span>
          <button class="kanban-error-retry" @click=${props.onRefresh}>↻ Retry</button>
        </div>
      ` : nothing}
      ${refreshing && !loading ? html`<div class="kanban-refreshing-bar"></div>` : nothing}
      ${showSkeletons ? renderSkeletonGallery() : nothing}
      ${!loading ? (galleryView ? renderGallery(props) : renderBoard(props)) : nothing}
    </div>
    <div class="kb-g1 kb-g1-ov">
      ${renderContextMenu(props)}
      ${renderRunDialog(props)}
      ${renderParentPicker(props)}
      ${renderTaskModal(props)}
      ${kanbanStyles()}
      <style>${kanbanGlassCss}</style>
      <style>${projectSectionsCss}</style>
      ${openProject && !galleryView && props.client
        ? html`<doc-agent-panel
            .client=${props.client as any}
            docType="project"
            .documentId=${openProject.id}
            .title=${openProject.name ?? openProject.id}
            .extra=${`status=${openProject.status ?? "(none)"} tasks=${props.tasks.filter((t) => taskMatchesProject(t, openProject)).length}`}
          ></doc-agent-panel>`
        : nothing}
    </div>
  `;
}

// ── Styles ──────────────────────────────────
function kanbanStyles() {
  return html`
    <style>
      /* ═══ Layout ═══ */
      .kanban-layout {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        /* Transparent so the global terminal/glass background shows
           through; the kanban columns themselves still have their own
           translucent fills. */
        background: transparent;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      .kanban-loading {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 12px;
        padding: 40px;
        color: #888;
      }
      .spinner {
        width: 20px;
        height: 20px;
        border: 2px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-top-color: var(--g-primary);
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      .kanban-error {
        background: rgba(239,68,68,0.1);
        border: 1px solid rgba(239,68,68,0.3);
        color: #ef4444;
        padding: 12px 20px;
        margin: 16px;
        border-radius: 8px;
        font-size: 0.85rem;
      }

      /* ═══ Gallery Toolbar ═══ */
      .gallery-toolbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px 24px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        flex-shrink: 0;
        gap: 16px;
        flex-wrap: wrap;
      }
      .gallery-filters {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        flex: 1;
      }
      .gallery-filter-group {
        display: flex;
        gap: 0;
        border-radius: 8px;
        overflow: hidden;
        border: 1px solid rgba(255,255,255,0.1);
      }
      .gallery-filter-btn {
        padding: 6px 14px;
        background: rgba(0,0,0,0.3);
        border: none;
        color: #888;
        font-size: 0.8rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s;
        font-family: inherit;
        border-right: 1px solid rgba(255,255,255,0.06);
      }
      .gallery-filter-btn:last-child { border-right: none; }
      .gallery-filter-btn:hover { color: #ccc; background: rgba(255,255,255,0.05); }
      .gallery-filter-btn.active {
        color: var(--g-primary);
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        font-weight: 600;
      }
      .gallery-filter-ai {
        border-right: 2px solid color-mix(in srgb, var(--g-primary) 20%, transparent) !important;
      }
      .gallery-filter-ai.active {
        color: #10b981;
        background: rgba(16,185,129,0.15);
      }
      .gallery-search {
        background: rgba(0,0,0,0.3);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 8px;
        padding: 6px 14px;
        color: #fff;
        font-size: 0.85rem;
        outline: none;
        min-width: 200px;
        font-family: inherit;
        transition: border-color 0.2s;
      }
      .gallery-search:focus { border-color: color-mix(in srgb, var(--g-primary) 40%, transparent); }
      .gallery-search::placeholder { color: #555; }
      .gallery-sort {
        background: rgba(0,0,0,0.3);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 8px;
        padding: 6px 12px;
        color: #ccc;
        font-size: 0.8rem;
        outline: none;
        cursor: pointer;
        font-family: inherit;
        appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' fill='%23888' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 10px center;
        padding-right: 28px;
      }
      .gallery-sort option { background: #1a1a1a; color: #eee; }
      .gallery-actions {
        display: flex;
        gap: 8px;
        align-items: center;
      }

      /* ═══ Add New Button ═══ */
      .btn-add-new {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 16px;
        background: linear-gradient(135deg, var(--g-primary) 0%, #f59e0b 100%);
        border: none;
        border-radius: 8px;
        color: #000;
        font-size: 0.85rem;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
        font-family: inherit;
        white-space: nowrap;
        box-shadow: 0 2px 8px color-mix(in srgb, var(--g-primary) 30%, transparent);
      }
      .btn-add-new:hover {
        background: linear-gradient(135deg, #ffdf4d 0%, var(--g-primary) 100%);
        transform: translateY(-1px);
        box-shadow: 0 4px 12px color-mix(in srgb, var(--g-primary) 40%, transparent);
      }
      .btn-add-new:active {
        transform: translateY(0);
      }
      .btn-add-icon {
        font-size: 1.1rem;
        font-weight: 700;
        line-height: 1;
      }

      /* ═══ Notion Sync Button ═══ */
      .btn-notion-sync {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 14px;
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 8px;
        color: #ccc;
        font-size: 0.8rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
        font-family: inherit;
        white-space: nowrap;
      }
      .btn-notion-sync:hover {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
        color: var(--g-primary);
      }
      .btn-notion-sync:active {
        transform: scale(0.97);
      }
      .btn-notion-sync:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .btn-notion-sync.syncing {
        color: var(--g-primary);
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
      }
      .btn-notion-sync.syncing .notion-sync-icon {
        display: inline-block;
        animation: spin 1s linear infinite;
      }
      .notion-sync-icon {
        font-size: 1rem;
        line-height: 1;
      }

      /* ═══ Gallery Grid ═══ */
      .gallery-grid {
        display: grid;
        /* min(100%, 300px) lets the min track collapse to the container width
           when the gallery is embedded in a narrow surface (e.g. the projects
           grid panel < 356px). On the full /projects page (container > 300px)
           this resolves to the original 300px, so the page is unchanged while
           the panel no longer overflows/clips its cards. */
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
        grid-auto-rows: min-content;
        align-content: start;
        gap: 24px;
        padding: 28px;
        flex: 1;
        min-height: 0;
        background: linear-gradient(180deg, rgba(0,0,0,0.2) 0%, transparent 100px);
      }

      /* ═══ Premium Gallery Card ═══ */
      .gc {
        --accent: var(--g-primary);
        --glow: rgba(251,191,36,0.3);
        position: relative;
        border-radius: 16px;
        cursor: pointer;
        transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      }
      
      .gc-glow {
        position: absolute;
        inset: -1px;
        border-radius: 17px;
        background: linear-gradient(135deg, var(--glow), transparent 60%);
        opacity: 0;
        transition: opacity 0.4s ease;
        pointer-events: none;
        z-index: 0;
      }
      
      .gc-inner {
        position: relative;
        z-index: 1;
        background: linear-gradient(180deg, #111111 0%, #0a0a0a 100%);
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 16px;
        overflow: hidden;
        transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        box-shadow: 
          0 4px 24px rgba(0,0,0,0.4),
          0 1px 2px rgba(0,0,0,0.3),
          inset 0 1px 0 rgba(255,255,255,0.03);
      }
      
      .gc:hover {
        transform: translateY(-6px) scale(1.02);
      }
      .gc:hover .gc-glow {
        opacity: 1;
      }
      .gc:hover .gc-inner {
        border-color: rgba(255,255,255,0.12);
        box-shadow: 
          0 20px 50px rgba(0,0,0,0.5),
          0 8px 24px rgba(0,0,0,0.4),
          inset 0 1px 0 rgba(255,255,255,0.05);
      }
      .gc:hover .gc-action {
        opacity: 1;
        transform: translateY(0);
      }
      .gc:hover .gc-progress-fill {
        box-shadow: 0 0 16px var(--accent);
      }
      
      /* Active state - pulsing glow */
      .gc--active .gc-glow {
        opacity: 0.5;
        animation: gc-pulse 3s ease-in-out infinite;
      }
      @keyframes gc-pulse {
        0%, 100% { opacity: 0.3; }
        50% { opacity: 0.6; }
      }
      
      /* Completed state */
      .gc--done .gc-inner {
        opacity: 0.7;
      }
      .gc--done:hover .gc-inner {
        opacity: 1;
      }
      
      /* Header */
      .gc-header {
        padding: 14px 16px;
        display: flex;
        align-items: center;
        gap: 12px;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }
      
      .gc-avatar {
        width: 36px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0,0,0,0.4);
        border-radius: 10px;
        font-size: 1.1rem;
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      }
      
      .gc-header-content {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .gc-status {
        font-size: 0.68rem;
        font-weight: 600;
        color: var(--sc, #888);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        opacity: 0.9;
      }
      
      .gc-live {
        width: 6px;
        height: 6px;
        background: #22c55e;
        border-radius: 50%;
        box-shadow: 0 0 8px #22c55e;
        animation: gc-live 1.5s ease-in-out infinite;
      }
      @keyframes gc-live {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(0.8); }
      }
      
      .gc-priority {
        font-size: 0.9rem;
        filter: drop-shadow(0 0 4px var(--pc, #888));
      }
      
      /* Body */
      .gc-body {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      
      .gc-title {
        margin: 0;
        font-size: 1rem;
        font-weight: 600;
        color: #f5f5f5;
        line-height: 1.35;
        letter-spacing: -0.01em;
      }
      
      .gc-desc {
        margin: 0;
        font-size: 0.78rem;
        color: rgba(255,255,255,0.45);
        line-height: 1.55;
        font-weight: 400;
      }
      
      .gc-tags {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      
      .gc-tag {
        font-size: 0.65rem;
        padding: 4px 10px;
        border-radius: 6px;
        background: rgba(255,255,255,0.04);
        color: rgba(255,255,255,0.6);
        border: 1px solid rgba(255,255,255,0.06);
        font-weight: 500;
        letter-spacing: 0.2px;
      }
      
      /* Parent badge — shown on child cards */
      .gc-parent-badge {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 4px 12px 0;
        font-size: 10px;
        color: rgba(255,255,255,0.4);
        line-height: 1.2;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      .gc-parent-badge-icon {
        opacity: 0.5;
        flex-shrink: 0;
      }
      .gc-parent-badge-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: rgba(255,255,255,0.5);
        font-weight: 500;
      }

      /* Footer */
      .gc-footer {
        padding: 12px 16px 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        border-top: 1px solid rgba(255,255,255,0.03);
      }
      
      .gc-progress {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      
      .gc-progress-track {
        flex: 1;
        height: 4px;
        background: rgba(255,255,255,0.06);
        border-radius: 2px;
        overflow: hidden;
        position: relative;
      }
      
      .gc-progress-fill {
        height: 100%;
        background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 70%, white));
        border-radius: 2px;
        transition: width 0.5s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s ease;
        position: relative;
      }
      .gc-progress-fill::after {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent);
        animation: gc-shimmer 2s ease-in-out infinite;
      }
      @keyframes gc-shimmer {
        0% { transform: translateX(-100%); }
        100% { transform: translateX(100%); }
      }
      
      .gc-progress-val {
        font-size: 0.72rem;
        font-weight: 600;
        color: var(--accent);
        font-family: 'JetBrains Mono', 'SF Mono', monospace;
        min-width: 32px;
        text-align: right;
      }
      
      .gc-meta {
        display: flex;
        gap: 12px;
      }
      
      .gc-meta-item {
        font-size: 0.68rem;
        color: rgba(255,255,255,0.35);
        font-family: 'JetBrains Mono', 'SF Mono', monospace;
      }

      /* ── Inline business-link chip ─────────────────────────────────
         Sits inside project meta rows. Native <select> overlays the
         label so the OS picker handles the dropdown — no popover or
         z-index gymnastics. */
      .biz-chip {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 0.68rem;
        line-height: 1;
        padding: 3px 8px;
        border-radius: 999px;
        cursor: pointer;
        color: rgba(255, 255, 255, 0.55);
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.1);
        transition: color 140ms ease, background 140ms ease, border-color 140ms ease;
        user-select: none;
      }
      .biz-chip:hover {
        color: var(--g-primary);
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
      }
      .biz-chip--linked {
        color: var(--g-primary);
        background: color-mix(in srgb, var(--g-primary) 12%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 28%, transparent);
      }
      .biz-chip-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
      }
      .biz-chip-icon svg { display: block; }
      .biz-chip-label {
        max-width: 120px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      /* The native select sits on top of the chip, invisible — clicking
         the chip opens the OS dropdown directly. */
      .biz-chip-select {
        position: absolute;
        inset: 0;
        opacity: 0;
        cursor: pointer;
        font-family: inherit;
      }
      .biz-chip--row {
        font-size: 0.7rem;
        padding: 4px 10px;
      }

      /* ── Toolbar-sized business filter (same anatomy as the chip,
            larger and with chevron — sits in gallery toolbars). */
      .biz-filter {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        line-height: 1;
        padding: 7px 12px 7px 11px;
        border-radius: 8px;
        cursor: pointer;
        color: rgba(255, 255, 255, 0.65);
        background: color-mix(in srgb, var(--g-bg, #0a0a0a) 30%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 16%, transparent);
        backdrop-filter: blur(10px);
        transition: color 140ms ease, background 140ms ease, border-color 140ms ease;
        user-select: none;
      }
      .biz-filter:hover {
        color: var(--g-primary, #fbbf24);
        background: color-mix(in srgb, var(--g-primary, #fbbf24) 8%, transparent);
        border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 32%, transparent);
      }
      .biz-filter--active {
        color: var(--g-primary, #fbbf24);
        background: color-mix(in srgb, var(--g-primary, #fbbf24) 12%, transparent);
        border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 36%, transparent);
      }
      .biz-filter-icon {
        display: inline-flex;
        align-items: center;
      }
      .biz-filter-icon svg { display: block; }
      .biz-filter-label {
        max-width: 160px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .biz-filter-chev {
        font-size: 10px;
        color: rgba(255, 255, 255, 0.5);
      }
      .biz-filter-select {
        position: absolute;
        inset: 0;
        opacity: 0;
        cursor: pointer;
        font-family: inherit;
      }

      /* ── Filter-active empty banner ── */
      .gallery-filter-banner {
        margin: 12px 18px 0;
        padding: 10px 14px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        font-size: 12px;
        color: rgba(255, 255, 255, 0.78);
        background: color-mix(in srgb, var(--g-primary, #fbbf24) 8%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 26%, transparent);
        border-radius: 10px;
        backdrop-filter: blur(8px);
      }
      .gallery-filter-banner strong {
        color: var(--g-primary, #fbbf24);
        font-weight: 600;
      }
      .gallery-filter-banner-clear {
        appearance: none;
        font: inherit;
        font-size: 11px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 6px 12px;
        border-radius: 7px;
        cursor: pointer;
        background: linear-gradient(135deg, var(--g-primary, #fbbf24), color-mix(in srgb, var(--g-primary, #fbbf24) 70%, #6366f1));
        color: #0a0a0a;
        font-weight: 700;
        border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 60%, transparent);
        white-space: nowrap;
      }
      
      /* Hover action button */
      .gc-action {
        position: absolute;
        bottom: 16px;
        right: 16px;
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--accent);
        border: none;
        border-radius: 8px;
        color: #000;
        cursor: pointer;
        opacity: 0;
        transform: translateY(4px);
        transition: all 0.3s ease;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        z-index: 10;
      }
      .gc-action:hover {
        transform: translateY(0) scale(1.1) !important;
        box-shadow: 0 6px 20px rgba(0,0,0,0.4);
      }
      .gc-action-edit {
        right: 56px;
        background: rgba(255,255,255,0.12);
        color: #fff;
        backdrop-filter: blur(8px);
      }
      .gc-action-edit:hover {
        background: rgba(255,255,255,0.2);
      }
      
      /* Legacy compatibility */
      .gallery-card { display: none; }
      .gallery-type-chip {
        font-size: 0.65rem;
        padding: 4px 10px;
        border-radius: 6px;
        background: rgba(255,255,255,0.04);
        color: rgba(255,255,255,0.6);
        border: 1px solid rgba(255,255,255,0.06);
        font-weight: 500;
      }

      /* ═══ New Project Card ═══ */
      .gallery-card-new {
        background: transparent;
        border: 1px dashed rgba(255,255,255,0.08);
        border-radius: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 220px;
        cursor: pointer;
        transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        position: relative;
        overflow: hidden;
      }
      .gallery-card-new::before {
        content: '';
        position: absolute;
        inset: 0;
        background: radial-gradient(circle at center, rgba(251,191,36,0.03) 0%, transparent 70%);
        opacity: 0;
        transition: opacity 0.4s ease;
      }
      .gallery-card-new:hover {
        border-color: rgba(251,191,36,0.3);
        transform: translateY(-4px);
        box-shadow: 0 12px 40px rgba(0,0,0,0.3);
      }
      .gallery-card-new:hover::before {
        opacity: 1;
      }
      .gallery-card-new:hover .gallery-card-new-icon {
        color: rgba(251,191,36,0.8);
        transform: scale(1.1);
        text-shadow: 0 0 20px rgba(251,191,36,0.5);
      }
      .gallery-card-new:hover .gallery-card-new-label {
        color: rgba(255,255,255,0.8);
      }
      .gallery-card-new-inner {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        position: relative;
        z-index: 1;
      }
      .gallery-card-new-icon {
        font-size: 2rem;
        color: rgba(255,255,255,0.15);
        font-weight: 300;
        line-height: 1;
        transition: all 0.4s ease;
      }
      .gallery-card-new-label {
        font-size: 0.82rem;
        color: rgba(255,255,255,0.4);
        font-weight: 500;
        letter-spacing: 0.3px;
        transition: color 0.3s ease;
      }

      /* ═══ Board Toolbar ═══ */
      .board-toolbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px 24px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        flex-shrink: 0;
        background: rgba(0,0,0,0.4);
        backdrop-filter: blur(12px);
      }
      .board-toolbar-left {
        display: flex;
        align-items: center;
        gap: 16px;
      }
      .board-toolbar-right {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .board-kg-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 30px;
        padding: 0 12px 0 10px;
        border-radius: 8px;
        font: 600 12px 'Inter', sans-serif;
        color: #f5d77a;
        background: color-mix(in srgb, #d4af37 10%, transparent);
        border: 1px solid color-mix(in srgb, #d4af37 38%, transparent);
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.15s, box-shadow 0.15s, border-color 0.15s;
      }
      .board-kg-btn:hover {
        background: color-mix(in srgb, #d4af37 18%, transparent);
        border-color: color-mix(in srgb, #d4af37 60%, transparent);
        box-shadow: 0 0 14px color-mix(in srgb, #d4af37 25%, transparent);
      }
      .board-kg-btn svg { width: 15px; height: 15px; }
      @media (max-width: 720px) {
        .board-kg-btn span { display: none; }
        .board-kg-btn { padding: 0 8px; }
      }
      .btn-back {
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.1);
        color: #aaa;
        padding: 6px 14px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 0.85rem;
        font-family: inherit;
        transition: all 0.15s;
      }
      .btn-back:hover {
        color: var(--g-primary);
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
        background: color-mix(in srgb, var(--g-primary) 5%, transparent);
      }
      .board-project-info {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .board-project-name {
        margin: 0;
        font-size: 1.2rem;
        font-weight: 600;
        color: #f0f0f0;
      }
      .board-project-name-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        appearance: none;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 8px;
        padding: 2px 8px 2px 6px;
        cursor: pointer;
        color: inherit;
      }
      .board-project-name-btn:hover {
        background: rgba(255,255,255,0.05);
        border-color: rgba(255,255,255,0.10);
      }
      .board-project-chev {
        font-size: 0.7rem;
        opacity: 0.6;
        margin-top: 2px;
      }
      .board-parent-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        max-width: 220px;
        padding: 2px 8px 2px 6px;
        border-radius: 999px;
        font: 600 11px 'Inter', sans-serif;
        letter-spacing: 0.02em;
        color: #c4b5fd;
        background: color-mix(in srgb, #a855f7 12%, transparent);
        border: 1px solid color-mix(in srgb, #a855f7 32%, transparent);
        cursor: pointer;
        transition: background 0.12s, border-color 0.12s;
      }
      .board-parent-chip:hover {
        background: color-mix(in srgb, #a855f7 20%, transparent);
        border-color: color-mix(in srgb, #a855f7 50%, transparent);
      }
      .board-parent-chip-icon { font-size: 12px; opacity: 0.9; }
      .board-parent-chip-name {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .board-money-chip {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: 999px;
        font: 600 11px 'Inter', sans-serif;
        letter-spacing: 0.02em;
        border: 1px solid transparent;
      }
      .board-money-chip--paid {
        color: #22c55e;
        background: color-mix(in srgb, #22c55e 12%, transparent);
        border-color: color-mix(in srgb, #22c55e 28%, transparent);
      }
      .board-money-chip--pending {
        color: #eab308;
        background: color-mix(in srgb, #eab308 12%, transparent);
        border-color: color-mix(in srgb, #eab308 28%, transparent);
      }
      /* ─── Floating project-header popover (no dim backdrop) ─── */
      .proj-popover-overlay {
        position: fixed;
        inset: 0;
        background: transparent;
        z-index: 60;
      }
      .proj-popover {
        position: absolute;
        top: calc(100% + 8px);
        left: 0;
        z-index: 61;
        min-width: 360px;
        max-width: 460px;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        background: rgba(20, 20, 23, 0.92);
        backdrop-filter: blur(12px) saturate(140%);
        -webkit-backdrop-filter: blur(12px) saturate(140%);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 12px;
        box-shadow: 0 18px 48px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.35);
      }
      .proj-popover-row {
        display: grid;
        grid-template-columns: 96px 1fr 140px;
        align-items: center;
        gap: 8px;
      }
      .proj-popover-label {
        font: 600 11px 'Inter', sans-serif;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: rgba(255,255,255,0.7);
      }
      .proj-popover-input {
        width: 100%;
        padding: 6px 8px;
        background: rgba(0,0,0,0.35);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 6px;
        color: #f4f4f5;
        font: 500 12.5px 'Inter', sans-serif;
      }
      .proj-popover-input:focus {
        outline: none;
        border-color: color-mix(in srgb, var(--g-primary, #facc15) 55%, transparent);
      }
      .proj-popover-input--date {
        color-scheme: dark;
      }
      .proj-popover-saving {
        font-size: 11px;
        color: rgba(255,255,255,0.6);
        text-align: right;
      }
      .proj-popover-hint {
        font-size: 11px;
        color: rgba(255,255,255,0.55);
      }
      .proj-popover-foot {
        display: flex;
        justify-content: flex-end;
        margin-top: 4px;
      }
      .board-empty {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: #888;
        gap: 8px;
        padding: 40px;
      }
      .btn-link {
        background: none;
        border: none;
        color: var(--g-primary);
        cursor: pointer;
        text-decoration: underline;
        font-family: inherit;
      }

      /* ═══ Kanban Board ═══ */
      .kanban-board {
        display: flex;
        gap: 16px;
        overflow-x: auto;
        flex: 1;
        min-height: 0;
        padding: 20px;
      }
      .kanban-column {
        min-width: 280px;
        width: 280px;
        background: rgba(0,0,0,0.3);
        border-radius: 12px;
        display: flex;
        flex-direction: column;
        border: 1px solid rgba(255,255,255,0.06);
        transition: border-color 0.2s;
      }
      .kanban-column.drag-over {
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
        background: color-mix(in srgb, var(--g-primary) 2%, transparent);
      }
      .kanban-column-header {
        padding: 14px 16px;
        font-weight: 600;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-top: 3px solid transparent;
        background: rgba(255,255,255,0.02);
        border-radius: 12px 12px 0 0;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }
      .column-title {
        text-transform: uppercase;
        font-size: 0.75rem;
        letter-spacing: 1px;
        color: #aaa;
      }
      .column-count {
        background: rgba(255,255,255,0.08);
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 0.7rem;
        color: #888;
        font-family: 'JetBrains Mono', monospace;
      }
      .kanban-column-content {
        flex: 1 1 auto;
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow-y: auto;
        overflow-anchor: none;
        min-height: 100px;
      }

      /* ═══ Task Card ═══ */
      .task-card {
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        padding: 12px;
        border-radius: 10px;
        cursor: grab;
        transition: all 0.2s;
        flex-shrink: 0;
      }
      .task-card:hover {
        background: rgba(255,255,255,0.07);
        border-color: color-mix(in srgb, var(--g-primary) 20%, transparent);
        box-shadow: 0 4px 16px rgba(0,0,0,0.2);
      }
      .task-card:active { cursor: grabbing; }
      .task-card.task-done { opacity: 0.6; }
      .task-card.task-card-focus {
        border-color: color-mix(in srgb, var(--g-primary, #60a5fa) 70%, transparent);
        box-shadow:
          0 0 0 2px color-mix(in srgb, var(--g-primary, #60a5fa) 50%, transparent),
          0 8px 24px rgba(0,0,0,0.35);
        animation: task-card-focus-pulse 1.4s ease-out 2;
      }
      @keyframes task-card-focus-pulse {
        0%,100% { box-shadow:
          0 0 0 2px color-mix(in srgb, var(--g-primary, #60a5fa) 50%, transparent),
          0 8px 24px rgba(0,0,0,0.35); }
        50% { box-shadow:
          0 0 0 4px color-mix(in srgb, var(--g-primary, #60a5fa) 70%, transparent),
          0 12px 32px rgba(0,0,0,0.45); }
      }
      .task-subagent-badge {
        font-size: 0.62rem;
        padding: 2px 7px;
        border-radius: 10px;
        font-weight: 600;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.18);
        color: #ddd;
        cursor: pointer;
        white-space: nowrap;
        transition: all 0.15s;
      }
      .task-subagent-badge:hover {
        background: rgba(255,255,255,0.10);
        transform: translateY(-1px);
      }
      .task-card-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 8px;
      }
      .task-card-title {
        font-weight: 500;
        font-size: 0.9rem;
        color: #eee;
        line-height: 1.35;
      }
      .task-priority-badge {
        font-size: 0.65rem;
        padding: 2px 8px;
        border-radius: 10px;
        font-weight: 600;
        flex-shrink: 0;
        white-space: nowrap;
      }
      .task-card-desc {
        font-size: 0.8rem;
        color: #777;
        margin-top: 6px;
        line-height: 1.3;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .task-card-meta {
        display: flex;
        gap: 6px;
        margin-top: 8px;
        flex-wrap: wrap;
        align-items: center;
      }
      .task-meta-item {
        font-size: 0.7rem;
        color: #888;
      }
      .task-dept-chip {
        font-size: 0.6rem;
        padding: 1px 6px;
        border-radius: 8px;
        background: rgba(168,85,247,0.12);
        color: #a78bfa;
        border: 1px solid rgba(168,85,247,0.2);
      }

      /* ═══ Buttons ═══ */
      .btn-primary {
        background: color-mix(in srgb, var(--g-primary) 12%, transparent);
        color: var(--g-primary);
        border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
        padding: 8px 18px;
        border-radius: 8px;
        font-weight: 600;
        font-size: 0.85rem;
        cursor: pointer;
        transition: all 0.2s;
        font-family: inherit;
      }
      .btn-primary:hover:not(:disabled) {
        background: color-mix(in srgb, var(--g-primary) 20%, transparent);
        box-shadow: 0 0 12px color-mix(in srgb, var(--g-primary) 12%, transparent);
      }
      .btn-primary:disabled { opacity: 0.35; cursor: not-allowed; }
      .btn-secondary {
        background: rgba(255,255,255,0.05);
        color: #aaa;
        border: 1px solid rgba(255,255,255,0.1);
        padding: 8px 18px;
        border-radius: 8px;
        font-size: 0.85rem;
        cursor: pointer;
        font-family: inherit;
        transition: all 0.15s;
      }
      .btn-secondary:hover { background: rgba(255,255,255,0.1); color: #fff; }
      .btn-danger {
        background: rgba(239,68,68,0.1);
        color: #ef4444;
        border: 1px solid rgba(239,68,68,0.3);
        padding: 8px 18px;
        border-radius: 8px;
        font-size: 0.85rem;
        cursor: pointer;
        font-family: inherit;
      }
      .btn-danger:hover { background: rgba(239,68,68,0.2); }
      .btn-icon {
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 8px;
        color: #aaa;
        cursor: pointer;
        font-size: 0.9rem;
        text-decoration: none;
        transition: all 0.15s;
      }
      .btn-icon:hover { background: rgba(255,255,255,0.1); color: #fff; }
      .notion-btn:hover { color: var(--g-primary); border-color: color-mix(in srgb, var(--g-primary) 30%, transparent); }

      /* ═══ Modal ═══ */
      .modal-backdrop {
        position: fixed;
        top: 0; left: 0;
        width: 100vw; height: 100vh;
        background: rgba(0,0,0,0.7);
        backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        animation: fadeIn 0.15s ease;
      }
      @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      .modal-content {
        width: 480px;
        max-width: 90vw;
        max-height: 85vh;
        background: rgba(18,18,18,0.98);
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 14px;
        box-shadow: 0 0 40px rgba(0,0,0,0.5), 0 0 10px color-mix(in srgb, var(--g-primary) 6%, transparent);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        animation: slideUp 0.2s ease;
      }
      .modal-wide { width: 560px; }
      @keyframes slideUp {
        from { opacity: 0; transform: translateY(20px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .modal-header {
        padding: 16px 20px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: rgba(255,255,255,0.02);
      }
      .modal-header h3 {
        margin: 0;
        font-size: 1.1rem;
        font-weight: 600;
        color: var(--g-primary);
      }
      .modal-close {
        background: none;
        border: none;
        color: #666;
        cursor: pointer;
        font-size: 1.1rem;
        padding: 4px 8px;
        border-radius: 4px;
        transition: all 0.15s;
      }
      .modal-close:hover { color: #fff; background: rgba(255,255,255,0.1); }
      .modal-body {
        padding: 20px;
        display: flex;
        flex-direction: column;
        gap: 16px;
        overflow-y: auto;
        flex: 1;
      }
      .modal-footer {
        padding: 14px 20px;
        border-top: 1px solid rgba(255,255,255,0.08);
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        background: rgba(0,0,0,0.2);
      }

      /* ═══ Forms ═══ */
      .form-group {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .form-label {
        font-size: 0.7rem;
        text-transform: uppercase;
        color: #888;
        letter-spacing: 0.8px;
        font-weight: 600;
      }
      .form-input, .form-select, .form-textarea {
        background: rgba(0,0,0,0.3);
        border: 1px solid rgba(255,255,255,0.1);
        padding: 10px 12px;
        border-radius: 8px;
        color: #fff;
        outline: none;
        font-size: 0.9rem;
        font-family: inherit;
        transition: border-color 0.2s;
      }
      .form-input:focus, .form-select:focus, .form-textarea:focus {
        border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
      }
      .form-textarea { resize: vertical; min-height: 80px; line-height: 1.5; }
      .form-select {
        cursor: pointer;
        appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' fill='%23888' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 10px center;
        padding-right: 28px;
      }
      .form-select option { background: #1a1a1a; color: #eee; }
      .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }

      /* ═══ Detail Modal ═══ */
      .detail-desc {
        background: rgba(0,0,0,0.3);
        padding: 14px;
        border-radius: 8px;
        color: #ccc;
        line-height: 1.6;
        font-size: 0.9rem;
        white-space: pre-wrap;
        border: 1px solid rgba(255,255,255,0.04);
      }
      .detail-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
      }
      .detail-item {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .detail-item label {
        font-size: 0.7rem;
        text-transform: uppercase;
        color: #666;
        letter-spacing: 0.8px;
        font-weight: 600;
      }
      .detail-value {
        font-size: 0.9rem;
        color: #ccc;
      }
      .detail-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .detail-link {
        color: var(--g-primary);
        text-decoration: none;
        font-size: 0.85rem;
        transition: opacity 0.15s;
      }
      .detail-link:hover { opacity: 0.8; text-decoration: underline; }

      /* ═══ View Toggle ═══ */
      .gallery-view-toggle {
        display: flex;
        gap: 0;
        border-radius: 8px;
        overflow: hidden;
        border: 1px solid rgba(255,255,255,0.1);
      }
      .gallery-view-btn {
        padding: 6px 12px;
        background: rgba(0,0,0,0.3);
        border: none;
        color: #666;
        font-size: 0.9rem;
        cursor: pointer;
        transition: all 0.15s;
        border-right: 1px solid rgba(255,255,255,0.06);
      }
      .gallery-view-btn:last-child { border-right: none; }
      .gallery-view-btn:hover { color: #ccc; background: rgba(255,255,255,0.05); }
      .gallery-view-btn.active {
        color: var(--g-primary);
        background: color-mix(in srgb, var(--g-primary) 12%, transparent);
      }

      /* ═══ Projects Kanban ═══ */
      .pk-board {
        display: grid;
        grid-template-columns: var(--cols, 300px 300px 300px 300px 300px 300px);
        gap: 12px;
        overflow-x: auto;
        overscroll-behavior-x: contain;
        flex: 1;
        min-height: 0;
        padding: 24px;
      }
      .pk-board::-webkit-scrollbar { height: 6px; }
      .pk-board::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--g-primary) 15%, transparent); border-radius: 3px; }

      /* ═══ Column resize handle (shared by .pk-board / .gt-board) ═══ */
      .col-resize-handle {
        position: absolute;
        top: 0;
        right: -10px;
        width: 16px;
        height: 100%;
        cursor: col-resize;
        z-index: 5;
        display: flex;
        align-items: center;
        justify-content: center;
        touch-action: none;
      }
      .col-resize-handle::before {
        content: '';
        width: 2px;
        height: 60%;
        background: rgba(255,255,255,0.06);
        border-radius: 1px;
        transition: background 0.15s, width 0.15s;
      }
      .col-resize-handle:hover::before,
      .col-resize-handle:active::before {
        background: var(--g-primary, #f5a623);
        width: 3px;
      }
      .pk-column {
        min-width: 0;
        background: rgba(0,0,0,0.35);
        border-radius: 12px;
        display: flex;
        flex-direction: column;
        border: 1px solid rgba(255,255,255,0.06);
        /* No width transition - snap-back came from animating the all-property transition */
        transition: border-color 0.2s, background 0.2s, box-shadow 0.2s;
        position: relative;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      }
      .pk-column:hover {
        border-color: rgba(255,255,255,0.1);
      }
      .pk-col-drag-over {
        border-color: color-mix(in srgb, var(--g-primary) 45%, transparent);
        background: color-mix(in srgb, var(--g-primary) 4%, transparent);
        box-shadow: 0 0 24px color-mix(in srgb, var(--g-primary) 10%, transparent), 0 4px 12px rgba(0,0,0,0.15);
        transform: scale(1.01);
      }
      .pk-column-header {
        padding: 16px 18px;
        font-weight: 600;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-top: 3px solid transparent;
        background: rgba(255,255,255,0.02);
        border-radius: 12px 12px 0 0;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }
      .pk-column-content {
        flex: 1 1 auto;
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        overflow-y: auto;
        overflow-x: hidden;
        overflow-anchor: none;
        min-height: 100px;
        scroll-behavior: auto;
        overscroll-behavior: contain;
      }
      .pk-column-content::-webkit-scrollbar {
        width: 5px; 
      }
      .pk-column-content::-webkit-scrollbar-track {
        background: rgba(0,0,0,0.2);
        border-radius: 3px;
      }
      .pk-column-content::-webkit-scrollbar-thumb { 
        background: color-mix(in srgb, var(--g-primary) 15%, transparent); 
        border-radius: 3px;
      }
      .pk-column-content::-webkit-scrollbar-thumb:hover { 
        background: color-mix(in srgb, var(--g-primary) 30%, transparent); 
      }
      .pk-card {
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        padding: 0;
        border-radius: 10px;
        cursor: grab;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        overflow: hidden;
        position: relative;
        flex-shrink: 0;
      }
      .pk-card:hover {
        background: rgba(255,255,255,0.07);
        border-color: color-mix(in srgb, var(--g-primary) 25%, transparent);
        box-shadow: 0 6px 20px rgba(0,0,0,0.25);
        transform: translateY(-2px);
      }
      .pk-card:active { cursor: grabbing; }
      .pk-dragging {
        opacity: 0.35;
        border: 2px dashed color-mix(in srgb, var(--g-primary) 50%, transparent) !important;
        transform: scale(0.98);
        box-shadow: none !important;
      }
      
      /* Project drop indicator */
      .pk-drop-indicator {
        height: 4px;
        margin: -2px 0;
        position: relative;
        z-index: 10;
        pointer-events: none;
      }
      .pk-drop-indicator-line {
        position: absolute;
        top: 50%;
        left: 0;
        right: 0;
        height: 3px;
        background: linear-gradient(90deg, color-mix(in srgb, var(--g-primary) 20%, transparent), color-mix(in srgb, var(--g-primary) 80%, transparent), color-mix(in srgb, var(--g-primary) 20%, transparent));
        border-radius: 2px;
        transform: translateY(-50%);
        animation: pk-pulse 1s ease-in-out infinite;
      }
      .pk-drop-indicator-line::before,
      .pk-drop-indicator-line::after {
        content: '';
        position: absolute;
        top: 50%;
        width: 8px;
        height: 8px;
        background: var(--g-primary);
        border-radius: 50%;
        transform: translateY(-50%);
        box-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 60%, transparent);
      }
      .pk-drop-indicator-line::before { left: 0; }
      .pk-drop-indicator-line::after { right: 0; }
      
      @keyframes pk-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.6; }
      }
      .pk-card-cover {
        height: 60px;
        background-size: cover;
        background-position: center;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }
      .pk-card-body {
        padding: 14px 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .pk-card-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 8px;
      }
      .pk-card-title {
        font-weight: 600;
        font-size: 0.9rem;
        color: #f0f0f0;
        line-height: 1.35;
      }
      .pk-priority { font-size: 0.75rem; flex-shrink: 0; }
      .pk-card-desc {
        font-size: 0.8rem;
        color: #888;
        line-height: 1.4;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .pk-card-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        margin-top: 2px;
      }
      .pk-card-footer {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 6px;
      }
      .pk-card-meta {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
      }
      .pk-drop-zone {
        min-height: 50px;
        border: 2px dashed color-mix(in srgb, var(--g-primary) 15%, transparent);
        border-radius: 10px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        color: #3f3f46;
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 1px;
        transition: all 0.2s ease;
        margin-top: auto;
        opacity: 0;
        pointer-events: none;
      }
      .pk-col-drag-over .pk-drop-zone {
        opacity: 1;
        pointer-events: auto;
      }
      .pk-drop-zone-icon {
        font-size: 1.2rem;
        font-weight: 300;
        color: #52525b;
      }
      .pk-drop-active {
        border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
        background: color-mix(in srgb, var(--g-primary) 5%, transparent);
        color: var(--g-primary);
      }
      .pk-drop-active .pk-drop-zone-icon {
        color: var(--g-primary);
      }

      /* ═══ Board Tab Switcher ═══ */
      .board-tab-switcher {
        display: flex;
        gap: 0;
        border-radius: 8px;
        overflow: hidden;
        border: 1px solid rgba(255,255,255,0.1);
        margin-left: 16px;
      }
      .board-tab-btn {
        padding: 5px 14px;
        background: rgba(0,0,0,0.3);
        border: none;
        color: #888;
        font-size: 0.8rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s;
        font-family: inherit;
        border-right: 1px solid rgba(255,255,255,0.06);
        white-space: nowrap;
      }
      .board-tab-btn:last-child { border-right: none; }
      .board-tab-btn:hover { color: #ccc; background: rgba(255,255,255,0.05); }
      .board-tab-btn.active {
        color: var(--g-primary);
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        font-weight: 600;
      }

      /* ═══ Project Files Tab ═══ */
      .kb-files-section {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .kb-files-toolbar {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .kb-files-upload-btn {
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .kb-files-count {
        margin-left: auto;
        color: #888;
        font-size: 0.85rem;
      }
      .kb-files-error {
        padding: 8px 12px;
        border-radius: 6px;
        background: color-mix(in srgb, #ef4444 12%, transparent);
        color: #fca5a5;
        font-size: 0.85rem;
      }
      .kb-files-dropzone {
        border: 1px dashed rgba(255,255,255,0.12);
        border-radius: 10px;
        padding: 8px;
        min-height: 160px;
        transition: background 0.15s, border-color 0.15s;
      }
      .kb-files-dropzone.drag-over {
        border-color: var(--g-primary);
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
      }
      .kb-files-empty {
        padding: 40px 16px;
        text-align: center;
        color: #888;
      }
      .kb-files-empty-hint {
        font-size: 0.8rem;
        color: #666;
        margin-top: 6px;
      }
      .kb-files-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .kb-file-row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 12px;
        border-radius: 8px;
        background: rgba(255,255,255,0.02);
        border: 1px solid rgba(255,255,255,0.05);
        transition: background 0.12s, border-color 0.12s;
      }
      .kb-file-row:hover {
        background: rgba(255,255,255,0.05);
        border-color: rgba(255,255,255,0.1);
      }
      .kb-file-icon {
        font-size: 22px;
        line-height: 1;
        flex-shrink: 0;
        width: 28px;
        text-align: center;
      }
      .kb-file-info {
        flex: 1;
        min-width: 0;
      }
      .kb-file-name {
        font-size: 0.92rem;
        color: #e5e5e5;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .kb-file-meta {
        display: flex;
        gap: 6px;
        font-size: 0.75rem;
        color: #777;
        margin-top: 2px;
      }
      .kb-file-actions {
        display: flex;
        gap: 4px;
        flex-shrink: 0;
      }
      .kb-file-delete:hover {
        color: #ef4444;
      }
      .kb-file-row {
        cursor: pointer;
      }
      .kb-file-row:focus-visible {
        outline: 2px solid var(--g-primary);
        outline-offset: 1px;
      }

      /* ═══ File Preview Modal ═══ */
      .kb-preview-backdrop {
        position: fixed;
        inset: 0;
        z-index: 9999;
        background: rgba(0,0,0,0.72);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        animation: kbPreviewFade 0.15s ease-out;
      }
      @keyframes kbPreviewFade {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      .kb-preview-modal {
        width: min(1100px, 100%);
        height: min(900px, 92vh);
        background: #0f0f12;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 14px;
        box-shadow: 0 30px 80px rgba(0,0,0,0.55);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        animation: kbPreviewPop 0.18s cubic-bezier(0.2,0.8,0.2,1);
      }
      @keyframes kbPreviewPop {
        from { transform: translateY(8px) scale(0.985); opacity: 0; }
        to { transform: translateY(0) scale(1); opacity: 1; }
      }
      .kb-preview-header {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        background: linear-gradient(180deg, rgba(255,255,255,0.03), transparent);
        flex-shrink: 0;
      }
      .kb-preview-icon {
        font-size: 22px;
        line-height: 1;
        flex-shrink: 0;
      }
      .kb-preview-titles {
        flex: 1;
        min-width: 0;
      }
      .kb-preview-title {
        font-size: 0.95rem;
        color: #e7e7e9;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .kb-preview-subtitle {
        display: flex;
        gap: 6px;
        font-size: 0.72rem;
        color: #888;
        margin-top: 2px;
      }
      .kb-preview-actions {
        display: flex;
        gap: 4px;
        flex-shrink: 0;
      }
      .kb-preview-body {
        flex: 1;
        min-height: 0;
        overflow: auto;
        background: #0a0a0c;
      }
      .kb-preview-body-image {
        overflow: hidden;
      }
      .kb-preview-pdf-host {
        padding: 12px 0 32px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        min-height: 100%;
      }
      .kb-pdf-page {
        max-width: 100%;
        height: auto;
        background: #fff;
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      }
      .kb-pdf-loading {
        color: #888;
        padding: 32px;
      }
      .kb-preview-status {
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        color: #888;
        padding: 32px;
        text-align: center;
      }
      .kb-preview-error {
        color: #fca5a5;
      }
      .kb-preview-error-detail {
        font-size: 0.75rem;
        color: #666;
        margin-top: 6px;
        max-width: 520px;
        word-break: break-word;
      }
      .kb-preview-pdf {
        width: 100%;
        height: 100%;
        border: 0;
        background: #1a1a1d;
      }
      .kb-preview-image-wrap {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background:
          linear-gradient(45deg, rgba(255,255,255,0.025) 25%, transparent 25%) 0 0/16px 16px,
          linear-gradient(-45deg, rgba(255,255,255,0.025) 25%, transparent 25%) 0 8px/16px 16px;
      }
      .kb-preview-image {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        border-radius: 6px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.45);
      }
      .kb-preview-text {
        margin: 0;
        padding: 20px 24px;
        font-family: ui-monospace, "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace;
        font-size: 0.85rem;
        line-height: 1.55;
        color: #d4d4d8;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .kb-preview-markdown {
        padding: 36px 48px 72px;
        max-width: 820px;
        margin: 0 auto;
        color: #d6d6d8;
        font-family: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
        font-size: 15px;
        line-height: 1.72;
      }
      .kb-preview-markdown h1,
      .kb-preview-markdown h2,
      .kb-preview-markdown h3,
      .kb-preview-markdown h4,
      .kb-preview-markdown h5,
      .kb-preview-markdown h6 {
        color: #f1f1f3;
        margin: 1.6em 0 0.5em;
        line-height: 1.3;
        font-weight: 700;
      }
      .kb-preview-markdown h1 { font-size: 1.9em; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 0.3em; }
      .kb-preview-markdown h2 { font-size: 1.45em; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 0.25em; }
      .kb-preview-markdown h3 { font-size: 1.2em; }
      .kb-preview-markdown h4 { font-size: 1.05em; }
      .kb-preview-markdown p { margin: 0.85em 0; }
      .kb-preview-markdown a { color: #7dd3fc; text-decoration: none; }
      .kb-preview-markdown a:hover { text-decoration: underline; }
      .kb-preview-markdown ul,
      .kb-preview-markdown ol { margin: 0.85em 0; padding-left: 1.6em; }
      .kb-preview-markdown li { margin: 0.25em 0; }
      .kb-preview-markdown code {
        background: rgba(255,255,255,0.07);
        border: 1px solid rgba(255,255,255,0.05);
        padding: 1px 5px;
        border-radius: 4px;
        font-family: ui-monospace, Menlo, Consolas, monospace;
        font-size: 0.88em;
        color: #f0abfc;
      }
      .kb-preview-markdown pre {
        background: #16161a;
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 8px;
        padding: 14px 16px;
        overflow-x: auto;
        margin: 1em 0;
      }
      .kb-preview-markdown pre code {
        background: transparent;
        border: 0;
        padding: 0;
        color: #d4d4d8;
        font-size: 0.85em;
      }
      .kb-preview-markdown blockquote {
        margin: 1em 0;
        padding: 6px 16px;
        border-left: 3px solid color-mix(in srgb, var(--g-primary) 60%, transparent);
        color: #b8b8bb;
        background: rgba(255,255,255,0.02);
        border-radius: 0 6px 6px 0;
      }
      .kb-preview-markdown hr {
        border: 0;
        border-top: 1px solid rgba(255,255,255,0.08);
        margin: 1.6em 0;
      }
      .kb-preview-markdown img {
        max-width: 100%;
        border-radius: 6px;
        margin: 0.5em 0;
      }
      .kb-preview-markdown table {
        border-collapse: collapse;
        margin: 1em 0;
        width: 100%;
        font-size: 0.9em;
      }
      .kb-preview-markdown th,
      .kb-preview-markdown td {
        border: 1px solid rgba(255,255,255,0.08);
        padding: 8px 12px;
        text-align: left;
      }
      .kb-preview-markdown th {
        background: rgba(255,255,255,0.03);
        font-weight: 600;
      }

      /* ═══ Notion Content Area ═══ */
      .nb-content-area {
        flex: 1;
        overflow-y: auto;
        min-height: 0;
      }
      .nb-content-area::-webkit-scrollbar { width: 6px; }
      .nb-content-area::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--g-primary) 15%, transparent); border-radius: 3px; }

      /* ═══ Project full-page (Notion / Database row style) ═══ */
      .kb-page {
        max-width: 840px;
        margin: 0 auto;
        padding: 28px 32px 80px;
        display: flex;
        flex-direction: column;
        gap: 28px;
      }
      .kb-page-head {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .kb-page-icon {
        font-size: 28px;
        line-height: 1;
        flex-shrink: 0;
        width: 36px;
        text-align: center;
      }
      .kb-page-title {
        flex: 1;
        background: transparent;
        border: none;
        color: var(--c-fg, #f5f5f4);
        font-size: 28px;
        font-weight: 700;
        outline: none;
        padding: 2px 0;
        letter-spacing: -0.01em;
        font-family: inherit;
      }
      .kb-page-title:focus { border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent); }
      .kb-page-section {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .kb-page-section-head { display: flex; align-items: baseline; gap: 10px; }
      .kb-page-section-title {
        margin: 0;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: rgba(255,255,255,0.55);
      }
      .kb-page-section-hint {
        font-size: 11px;
        color: rgba(255,255,255,0.35);
      }
      .kb-page-proplist {
        display: flex;
        flex-direction: column;
        gap: 2px;
        border-top: 1px solid rgba(255,255,255,0.04);
      }
      .kb-page-prop {
        display: grid;
        grid-template-columns: 160px minmax(0, 1fr);
        gap: 14px;
        align-items: center;
        padding: 6px 0;
        border-bottom: 1px solid rgba(255,255,255,0.04);
        min-width: 0;
      }
      .kb-page-prop-wide { align-items: flex-start; padding: 10px 0; }
      .kb-page-prop-wide .kb-prop-label { padding-top: 8px; }
      .kb-prop-label {
        color: rgba(255,255,255,0.55);
        font-size: 12px;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .kb-prop-input {
        appearance: none;
        background: transparent;
        border: 1px solid transparent;
        color: var(--c-fg, #f5f5f4);
        font-size: 13px;
        padding: 4px 8px;
        border-radius: 6px;
        font-family: inherit;
        outline: none;
        width: 100%;
        min-width: 0;
      }
      .kb-prop-input:hover { background: rgba(255,255,255,0.04); }
      .kb-prop-input:focus {
        background: rgba(0,0,0,0.35);
        border-color: color-mix(in srgb, var(--g-primary) 35%, transparent);
      }
      select.kb-prop-input {
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' fill='%23888' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 8px center;
        padding-right: 24px;
        cursor: pointer;
      }
      select.kb-prop-input option { background: #1a1a1a; color: #eee; }
      .kb-prop-textarea {
        resize: vertical;
        min-height: 60px;
        line-height: 1.5;
      }
      .kb-prop-input-num { max-width: 80px; width: 80px; }
      .kb-prop-progress {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .kb-prop-progress-pct {
        color: rgba(255,255,255,0.5);
        font-size: 12px;
      }
      .kb-prop-progress-bar {
        flex: 1;
        height: 6px;
        background: rgba(255,255,255,0.08);
        border-radius: 3px;
        overflow: hidden;
      }
      .kb-prop-progress-fill {
        height: 100%;
        background: linear-gradient(90deg, var(--g-primary), #f59e0b);
        border-radius: 3px;
        transition: width 0.2s ease;
      }
      .kb-prop-link {
        color: var(--g-primary);
        text-decoration: none;
        font-size: 13px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .kb-prop-link:hover { text-decoration: underline; }
      .kb-page-editor {
        max-width: none;
        margin: 0;
        padding: 0;
      }
      .notion-content {
        max-width: 800px;
        margin: 0 auto;
        padding: 24px 32px;
      }
      .nb-blocks { display: flex; flex-direction: column; gap: 2px; }

      /* Block editor host */
      .nb-editor-host {
        max-width: 820px;
        margin: 0 auto;
        padding: 24px 32px 8px;
      }
      .nb-notion-reference {
        max-width: 820px;
        margin: 8px auto 24px;
        padding: 0 32px;
      }
      .nb-notion-reference > summary {
        cursor: pointer;
        color: #888;
        font-size: 0.85rem;
        padding: 8px 12px;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 6px;
        background: rgba(255,255,255,0.02);
        list-style: none;
        user-select: none;
      }
      .nb-notion-reference > summary::before { content: "▸ "; font-size: 0.75rem; }
      .nb-notion-reference[open] > summary::before { content: "▾ "; }

      /* ═══ Notion Block Styles ═══ */
      .nb-h1 {
        font-size: 1.8rem;
        font-weight: 700;
        color: var(--g-primary);
        margin: 24px 0 12px;
        line-height: 1.2;
        border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
        padding-bottom: 8px;
      }
      .nb-h2 {
        font-size: 1.4rem;
        font-weight: 600;
        color: #e0d5b0;
        margin: 20px 0 8px;
        line-height: 1.3;
      }
      .nb-h3 {
        font-size: 1.1rem;
        font-weight: 600;
        color: #ccc;
        margin: 16px 0 6px;
        line-height: 1.3;
      }
      .nb-paragraph {
        color: #ccc;
        line-height: 1.6;
        font-size: 0.92rem;
        margin: 4px 0;
      }
      .nb-spacer {
        height: 12px;
      }

      /* Lists */
      .nb-list {
        display: flex;
        gap: 8px;
        color: #ccc;
        font-size: 0.92rem;
        line-height: 1.6;
        margin: 2px 0;
        padding-left: 8px;
      }
      .nb-bullet-dot {
        color: var(--g-primary);
        flex-shrink: 0;
        margin-top: 1px;
      }
      .nb-list-content { flex: 1; }
      .nb-todo { align-items: flex-start; }
      .nb-todo-check {
        flex-shrink: 0;
        font-size: 1rem;
        margin-top: 1px;
      }
      .nb-todo-done { opacity: 0.5; text-decoration: line-through; }

      /* Toggle */
      .nb-toggle {
        margin: 4px 0;
      }
      .nb-toggle-header {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        padding: 6px 8px;
        border-radius: 6px;
        color: #ccc;
        font-size: 0.92rem;
        transition: background 0.15s;
      }
      .nb-toggle-header:hover { background: rgba(255,255,255,0.05); }
      .nb-toggle-arrow {
        font-size: 0.65rem;
        color: #888;
        transition: transform 0.2s;
        flex-shrink: 0;
      }
      .nb-toggle-open { transform: rotate(90deg); }
      .nb-toggle-text { flex: 1; }
      .nb-toggle-content {
        padding-left: 24px;
        border-left: 2px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
        margin-left: 8px;
        margin-top: 4px;
      }

      /* Quote */
      .nb-quote {
        border-left: 3px solid color-mix(in srgb, var(--g-primary) 40%, transparent);
        padding: 8px 16px;
        margin: 8px 0;
        color: #bbb;
        font-size: 0.92rem;
        line-height: 1.6;
        background: rgba(255,255,255,0.02);
        border-radius: 0 6px 6px 0;
      }

      /* Callout */
      .nb-callout {
        display: flex;
        gap: 12px;
        padding: 14px 16px;
        border-radius: 8px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        margin: 8px 0;
        align-items: flex-start;
      }
      .nb-callout-icon { font-size: 1.2rem; flex-shrink: 0; margin-top: 1px; }
      .nb-callout-content { color: #ccc; font-size: 0.92rem; line-height: 1.6; flex: 1; }

      /* Code */
      .nb-code-wrapper {
        position: relative;
        margin: 10px 0;
        border-radius: 10px;
        overflow: hidden;
        border: 1px solid rgba(255,255,255,0.08);
      }
      .nb-code-lang {
        position: absolute;
        top: 8px;
        right: 12px;
        font-size: 0.65rem;
        color: #888;
        background: rgba(0,0,0,0.4);
        padding: 2px 8px;
        border-radius: 4px;
        font-family: 'JetBrains Mono', 'Fira Code', monospace;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .nb-code {
        background: rgba(0,0,0,0.5);
        padding: 18px 20px;
        margin: 0;
        font-family: 'JetBrains Mono', 'Fira Code', monospace;
        font-size: 0.82rem;
        color: #e0e0e0;
        line-height: 1.6;
        overflow-x: auto;
        white-space: pre;
      }
      .nb-code::-webkit-scrollbar { height: 4px; }
      .nb-code::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--g-primary) 15%, transparent); border-radius: 2px; }
      .nb-inline-code {
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
        color: var(--g-primary);
        padding: 1px 6px;
        border-radius: 4px;
        font-family: 'JetBrains Mono', 'Fira Code', monospace;
        font-size: 0.85em;
      }

      /* Image */
      .nb-image-wrapper {
        margin: 12px 0;
        text-align: center;
      }
      .nb-image {
        max-width: 100%;
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.08);
      }
      .nb-caption {
        font-size: 0.78rem;
        color: #888;
        margin-top: 6px;
        font-style: italic;
      }

      /* File */
      .nb-file {
        margin: 6px 0;
      }
      .nb-file-link {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 16px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 8px;
        color: #ccc;
        text-decoration: none;
        font-size: 0.85rem;
        transition: all 0.15s;
      }
      .nb-file-link:hover {
        background: color-mix(in srgb, var(--g-primary) 6%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
        color: var(--g-primary);
      }

      /* Bookmark */
      .nb-bookmark { margin: 6px 0; }
      .nb-bookmark-link {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: #3b82f6;
        text-decoration: none;
        font-size: 0.88rem;
        transition: opacity 0.15s;
      }
      .nb-bookmark-link:hover { opacity: 0.8; text-decoration: underline; }

      /* Divider */
      .nb-divider {
        border: none;
        border-top: 1px solid rgba(255,255,255,0.08);
        margin: 16px 0;
      }

      /* Child Page */
      .nb-child-page {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 16px;
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 10px;
        cursor: pointer;
        transition: all 0.2s;
        margin: 6px 0;
      }
      .nb-child-page:hover {
        background: color-mix(in srgb, var(--g-primary) 5%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 25%, transparent);
        transform: translateX(4px);
      }
      .nb-child-page-icon { font-size: 1.1rem; }
      .nb-child-page-title {
        flex: 1;
        color: #e0e0e0;
        font-weight: 500;
        font-size: 0.92rem;
      }
      .nb-child-page-arrow {
        color: #666;
        font-size: 0.9rem;
        transition: color 0.15s;
      }
      .nb-child-page:hover .nb-child-page-arrow { color: var(--g-primary); }

      /* Child Database */
      .nb-child-database {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 16px;
        background: rgba(59,130,246,0.05);
        border: 1px solid rgba(59,130,246,0.15);
        border-radius: 8px;
        color: #7cb3f4;
        font-size: 0.88rem;
        margin: 6px 0;
      }
      .nb-child-db-icon { font-size: 1.1rem; }

      /* Table */
      .nb-table-wrapper {
        overflow-x: auto;
        margin: 10px 0;
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.08);
      }
      .nb-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.85rem;
      }
      .nb-table th {
        background: color-mix(in srgb, var(--g-primary) 6%, transparent);
        color: #e0d5b0;
        font-weight: 600;
        text-align: left;
        padding: 10px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.1);
      }
      .nb-table td {
        padding: 8px 14px;
        color: #ccc;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }
      .nb-table tr:hover td { background: rgba(255,255,255,0.02); }

      /* Columns */
      .nb-columns {
        display: flex;
        gap: 20px;
        margin: 8px 0;
      }
      .nb-column { flex: 1; min-width: 0; }

      /* Breadcrumb */
      .nb-breadcrumb {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 20px;
        padding-bottom: 12px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .nb-breadcrumb-btn {
        background: none;
        border: none;
        color: var(--g-primary);
        cursor: pointer;
        font-size: 0.88rem;
        font-family: inherit;
        padding: 4px 8px;
        border-radius: 4px;
        transition: background 0.15s;
      }
      .nb-breadcrumb-btn:hover { background: color-mix(in srgb, var(--g-primary) 8%, transparent); }
      .nb-breadcrumb-sep { color: #555; font-size: 0.85rem; }
      .nb-breadcrumb-current { color: #ccc; font-size: 0.88rem; }

      /* Sub-page grid */
      .nb-subpage-grid {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      /* Links */
      .nb-link {
        color: #3b82f6;
        text-decoration: underline;
        text-decoration-color: rgba(59,130,246,0.3);
        transition: all 0.15s;
      }
      .nb-link:hover { color: #60a5fa; text-decoration-color: rgba(59,130,246,0.6); }

      /* ═══ Global Tasks Tab Button ═══ */
      .gallery-filter-tasks {
        border-right: 2px solid rgba(59,130,246,0.2) !important;
      }
      .gallery-filter-tasks.active {
        color: #3b82f6;
        background: rgba(59,130,246,0.12);
      }

      /* ═══ Global Tasks View ═══ */
      .gt-toolbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 24px;
        gap: 12px;
        flex-wrap: wrap;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }
      .gt-toolbar-left {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        flex: 1;
      }
      .gt-toolbar-right {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .gt-stats {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .gt-stat-active {
        font-size: 0.75rem;
        font-weight: 600;
        color: #3b82f6;
        background: rgba(59,130,246,0.1);
        padding: 3px 10px;
        border-radius: 12px;
        border: 1px solid rgba(59,130,246,0.2);
      }
      .gt-stat-done {
        font-size: 0.75rem;
        font-weight: 600;
        color: #10b981;
        background: rgba(16,185,129,0.1);
        padding: 3px 10px;
        border-radius: 12px;
        border: 1px solid rgba(16,185,129,0.2);
      }
      .gt-search {
        background: rgba(0,0,0,0.3);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 8px;
        padding: 5px 12px;
        color: #fff;
        font-size: 0.8rem;
        outline: none;
        min-width: 180px;
        font-family: inherit;
        transition: border-color 0.2s;
      }
      .gt-search:focus { border-color: rgba(59,130,246,0.4); }
      .gt-search::placeholder { color: #555; }
      .gt-filter-select {
        background: rgba(0,0,0,0.3);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 8px;
        padding: 5px 10px;
        color: #ccc;
        font-size: 0.78rem;
        outline: none;
        cursor: pointer;
        font-family: inherit;
        appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' fill='%23888' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 8px center;
        padding-right: 24px;
      }
      .gt-filter-select option { background: #1a1a1a; color: #eee; }
      .gt-toggle-done {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.78rem;
        color: #888;
        cursor: pointer;
        user-select: none;
      }
      .gt-toggle-done input[type="checkbox"] {
        accent-color: #10b981;
        cursor: pointer;
      }
      .gt-toggle-done:hover { color: #ccc; }

      /* ═══ Global Tasks Board ═══ */
      .gt-board {
        display: grid;
        grid-template-columns: var(--cols, 300px 300px 300px 300px 300px 300px);
        gap: 12px;
        overflow-x: auto;
        flex: 1;
        min-height: 0;
        height: 100%;
        padding: 20px;
        align-items: stretch;
      }
      .gt-board::-webkit-scrollbar { height: 6px; }
      .gt-board::-webkit-scrollbar-thumb { background: rgba(59,130,246,0.15); border-radius: 3px; }
      .gt-column {
        min-width: 0;
        height: 100%;
        background: rgba(0,0,0,0.35);
        border-radius: 12px;
        display: flex;
        flex-direction: column;
        border: 1px solid rgba(255,255,255,0.06);
        /* No width transition - snap-back came from animating the all-property transition */
        transition: border-color 0.2s, background 0.2s, box-shadow 0.2s;
        position: relative;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      }
      .gt-column:hover {
        border-color: rgba(255,255,255,0.1);
      }
      .gt-col-drag-over {
        border-color: rgba(59,130,246,0.45);
        background: rgba(59,130,246,0.04);
        box-shadow: 0 0 24px rgba(59,130,246,0.1), 0 4px 12px rgba(0,0,0,0.15);
        transform: scale(1.01);
      }
      .gt-column-header {
        padding: 14px 16px;
        font-weight: 600;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-top: 3px solid transparent;
        background: rgba(255,255,255,0.02);
        border-radius: 12px 12px 0 0;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }
      .gt-column-content {
        flex: 1 1 auto;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow-y: auto;
        overflow-x: hidden;
        overflow-anchor: none;
        min-height: 100px;
        scroll-behavior: auto;
        overscroll-behavior: contain;
      }
      .gt-column-content::-webkit-scrollbar {
        width: 5px; 
      }
      .gt-column-content::-webkit-scrollbar-track {
        background: rgba(0,0,0,0.2);
        border-radius: 3px;
      }
      .gt-column-content::-webkit-scrollbar-thumb { 
        background: rgba(59,130,246,0.2); 
        border-radius: 3px;
        transition: background 0.2s;
      }
      .gt-column-content::-webkit-scrollbar-thumb:hover { 
        background: rgba(59,130,246,0.4); 
      }

      /* ═══ Global Task Card ═══ */
      .gt-card {
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        padding: 12px;
        border-radius: 10px;
        cursor: grab;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        position: relative;
        flex-shrink: 0;
      }
      .gt-card:hover {
        background: rgba(255,255,255,0.07);
        border-color: rgba(59,130,246,0.25);
        box-shadow: 0 4px 16px rgba(0,0,0,0.2);
        transform: translateY(-1px);
      }
      .gt-card:active { cursor: grabbing; }
      .gt-card-done { opacity: 0.5; }
      .gt-card-hover-target {
        border-color: rgba(59,130,246,0.35);
        box-shadow: 0 0 0 2px rgba(59,130,246,0.1);
      }
      .gt-dragging {
        opacity: 0.35;
        border: 2px dashed rgba(59,130,246,0.5) !important;
        transform: scale(0.98);
        box-shadow: none !important;
      }
      
      /* ═══ Drop Indicator ═══ */
      .gt-drop-indicator {
        height: 4px;
        margin: -2px 0;
        position: relative;
        z-index: 10;
        pointer-events: none;
      }
      .gt-drop-indicator-line {
        position: absolute;
        top: 50%;
        left: 0;
        right: 0;
        height: 3px;
        background: linear-gradient(90deg, rgba(59,130,246,0.2), rgba(59,130,246,0.8), rgba(59,130,246,0.2));
        border-radius: 2px;
        transform: translateY(-50%);
        animation: gt-pulse 1s ease-in-out infinite;
      }
      .gt-drop-indicator-line::before,
      .gt-drop-indicator-line::after {
        content: '';
        position: absolute;
        top: 50%;
        width: 8px;
        height: 8px;
        background: #3b82f6;
        border-radius: 50%;
        transform: translateY(-50%);
        box-shadow: 0 0 8px rgba(59,130,246,0.6);
      }
      .gt-drop-indicator-line::before { left: 0; }
      .gt-drop-indicator-line::after { right: 0; }
      
      .gt-drop-indicator-end {
        margin-top: 4px;
        margin-bottom: -2px;
      }
      
      @keyframes gt-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.6; }
      }
      
      /* Enhanced drop zone */
      .gt-drop-zone {
        min-height: 50px;
        border: 2px dashed rgba(59,130,246,0.15);
        border-radius: 10px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        color: #3f3f46;
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 1px;
        transition: all 0.2s ease;
        margin-top: auto;
        opacity: 0;
        pointer-events: none;
      }
      .gt-col-drag-over .gt-drop-zone {
        opacity: 1;
        pointer-events: auto;
      }
      .gt-drop-zone-icon {
        font-size: 1.2rem;
        font-weight: 300;
        color: #52525b;
      }
      .gt-drop-active {
        border-color: rgba(59,130,246,0.5);
        background: rgba(59,130,246,0.05);
        color: #3b82f6;
      }
      .gt-drop-active .gt-drop-zone-icon {
        color: #3b82f6;
      }
      .gt-card-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 8px;
      }
      .gt-card-header-right {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
      }
      .gt-card-icon {
        font-size: 1rem;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        margin-right: 6px;
      }
      .gt-card-title {
        font-weight: 500;
        font-size: 0.88rem;
        color: #eee;
        line-height: 1.35;
      }
      .gt-card-pri {
        font-size: 0.7rem;
        flex-shrink: 0;
      }
      .run-btn-mini {
        width: 22px; height: 22px;
        border: 1px solid rgba(34,197,94,0.3);
        background: rgba(34,197,94,0.1);
        color: #22c55e;
        border-radius: 4px;
        cursor: pointer;
        font-size: 10px;
        display: flex; align-items: center; justify-content: center;
        opacity: 0;
        transition: opacity 0.15s, background 0.15s;
        flex-shrink: 0;
      }
      .gt-card:hover .run-btn-mini,
      .task-card:hover .run-btn-mini,
      .gallery-card:hover .run-btn-mini {
        opacity: 1;
      }
      .run-btn-mini:hover {
        background: rgba(34,197,94,0.25);
        border-color: #22c55e;
      }

      /* ══════════════════════════════════════════════════════════════ */
      /* ── Run Dialog Styles — Futuristic HUD Theme ── */
      /* ══════════════════════════════════════════════════════════════ */
      
      .run-dialog { 
        max-width: 600px;
        border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent) !important;
        box-shadow: 
          0 0 40px rgba(0,0,0,0.6),
          0 0 1px color-mix(in srgb, var(--g-primary) 30%, transparent),
          inset 0 1px 0 rgba(255,255,255,0.03);
      }
      .run-dialog .modal-header {
        background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 6%, transparent) 0%, transparent 100%);
        border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
        padding: 18px 24px;
      }
      .run-dialog .modal-header h3 {
        color: var(--g-primary);
        font-size: 1.15rem;
        text-shadow: 0 0 20px color-mix(in srgb, var(--g-primary) 30%, transparent);
      }
      .run-dialog .modal-body {
        padding: 24px;
        gap: 20px;
      }
      .run-dialog .modal-footer {
        padding: 18px 24px;
        gap: 12px;
        background: rgba(0,0,0,0.2);
        border-top: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
      }

      /* Task header card */
      .run-dialog .run-task-header {
        background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 8%, transparent) 0%, color-mix(in srgb, var(--g-primary) 2%, transparent) 100%);
        border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
        border-radius: 10px;
        padding: 16px 18px;
        position: relative;
        overflow: hidden;
      }
      .run-dialog .run-task-header::before {
        content: '';
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 2px;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--g-primary) 40%, transparent), transparent);
      }
      .run-dialog .run-task-title {
        font-weight: 600;
        color: var(--g-primary);
        font-size: 15px;
        margin-bottom: 6px;
      }
      .run-dialog .run-task-desc {
        color: #888;
        font-size: 12px;
        line-height: 1.5;
      }

      /* Phase bar — HUD style */
      .run-phase-bar {
        display: flex;
        align-items: center;
        gap: 0;
        padding: 16px 8px;
        background: rgba(0,0,0,0.25);
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.04);
        margin-top: 4px;
      }
      .run-phase-step {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        min-width: 56px;
        flex-shrink: 0;
        padding: 4px 0;
      }
      .run-phase-icon { 
        font-size: 18px; 
        filter: grayscale(1); 
        opacity: 0.35; 
        transition: all 0.3s ease; 
      }
      .run-phase-label { 
        font-size: 9px; 
        color: #444; 
        text-transform: uppercase; 
        letter-spacing: 1px; 
        font-weight: 500;
        transition: all 0.3s ease; 
      }
      .run-phase-active .run-phase-icon { 
        filter: grayscale(0); 
        opacity: 1; 
        transform: scale(1.25); 
        filter: drop-shadow(0 0 6px color-mix(in srgb, var(--g-primary) 50%, transparent));
      }
      .run-phase-active .run-phase-label { 
        color: var(--g-primary); 
        font-weight: 700; 
        text-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 40%, transparent);
      }
      .run-phase-past .run-phase-icon { 
        filter: grayscale(0); 
        opacity: 0.6; 
      }
      .run-phase-past .run-phase-label { color: #666; }
      .run-phase-connector {
        flex: 1;
        height: 2px;
        background: linear-gradient(90deg, #222, #333, #222);
        min-width: 16px;
        border-radius: 1px;
        transition: all 0.4s ease;
        position: relative;
      }
      .run-phase-connector-done { 
        background: linear-gradient(90deg, #22c55e, #4ade80, #22c55e);
        box-shadow: 0 0 8px rgba(34,197,94,0.4);
      }

      /* Form spacing in run dialog */
      .run-dialog .form-group {
        margin-bottom: 18px;
      }
      .run-dialog .form-group:last-child {
        margin-bottom: 0;
      }
      .run-dialog .form-label {
        font-size: 0.68rem;
        letter-spacing: 1.2px;
        margin-bottom: 8px;
        color: #777;
      }
      .run-dialog .form-input,
      .run-dialog .form-select,
      .run-dialog .form-textarea {
        padding: 12px 14px;
        border-radius: 8px;
        background: rgba(0,0,0,0.4);
        border: 1px solid rgba(255,255,255,0.08);
        font-size: 0.9rem;
      }
      .run-dialog .form-input:focus,
      .run-dialog .form-select:focus,
      .run-dialog .form-textarea:focus {
        border-color: color-mix(in srgb, var(--g-primary) 35%, transparent);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--g-primary) 8%, transparent);
      }

      /* Analysis loading */
      .run-analysis-loading {
        display: flex;
        align-items: center;
        gap: 20px;
        padding: 32px 16px;
        justify-content: center;
      }
      .run-analysis-spinner {
        width: 36px; height: 36px;
        border: 3px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
        border-top-color: var(--g-primary);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
        flex-shrink: 0;
        box-shadow: 0 0 20px color-mix(in srgb, var(--g-primary) 15%, transparent);
      }
      .run-analysis-text {
        text-align: left;
      }

      /* Alert boxes */
      .run-alert {
        padding: 14px 18px;
        border-radius: 10px;
        font-size: 13px;
        margin-bottom: 16px;
        line-height: 1.5;
        position: relative;
        overflow: hidden;
      }
      .run-alert::before {
        content: '';
        position: absolute;
        left: 0; top: 0; bottom: 0;
        width: 3px;
      }
      .run-alert-error { 
        background: rgba(239,68,68,0.08); 
        border: 1px solid rgba(239,68,68,0.2); 
        color: #f87171; 
      }
      .run-alert-error::before { background: #ef4444; }
      .run-alert-info { 
        background: rgba(59,130,246,0.08); 
        border: 1px solid rgba(59,130,246,0.2); 
        color: #93c5fd; 
      }
      .run-alert-info::before { background: #3b82f6; }
      .run-alert-success { 
        background: rgba(34,197,94,0.08); 
        border: 1px solid rgba(34,197,94,0.2); 
        color: #4ade80; 
      }
      .run-alert-success::before { background: #22c55e; }

      /* Action buttons */
      .run-btn-analyze {
        background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 12%, transparent) 0%, color-mix(in srgb, var(--g-primary) 6%, transparent) 100%) !important;
        color: var(--g-primary) !important;
        border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent) !important;
        font-weight: 600;
        padding: 10px 18px !important;
        transition: all 0.2s ease;
      }
      .run-btn-analyze:hover { 
        background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 20%, transparent) 0%, color-mix(in srgb, var(--g-primary) 10%, transparent) 100%) !important; 
        box-shadow: 0 0 20px color-mix(in srgb, var(--g-primary) 15%, transparent);
        transform: translateY(-1px);
      }
      .run-btn-skip {
        background: linear-gradient(135deg, rgba(34,197,94,0.12) 0%, rgba(34,197,94,0.06) 100%) !important;
        color: #22c55e !important;
        border: 1px solid rgba(34,197,94,0.25) !important;
        padding: 10px 18px !important;
        transition: all 0.2s ease;
      }
      .run-btn-skip:hover { 
        background: linear-gradient(135deg, rgba(34,197,94,0.2) 0%, rgba(34,197,94,0.1) 100%) !important; 
        box-shadow: 0 0 20px rgba(34,197,94,0.15);
        transform: translateY(-1px);
      }
      .gt-notion-badge {
        font-size: 0.6rem;
        opacity: 0.6;
        cursor: default;
      }
      .gt-local-badge {
        font-size: 0.6rem;
        opacity: 0.4;
        cursor: default;
      }
      .gt-sync-status {
        font-size: 0.65rem;
        padding: 2px 8px;
        border-radius: 10px;
        font-weight: 600;
        white-space: nowrap;
      }
      .gt-sync-yes {
        color: #10b981;
        background: rgba(16,185,129,0.1);
        border: 1px solid rgba(16,185,129,0.2);
      }
      .gt-sync-no {
        color: #888;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.1);
      }
      .gt-card-desc {
        font-size: 0.78rem;
        color: #777;
        margin-top: 6px;
        line-height: 1.3;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .gt-card-footer {
        display: flex;
        gap: 8px;
        margin-top: 8px;
        flex-wrap: wrap;
        align-items: center;
      }
      .gt-card-project {
        font-size: 0.65rem;
        color: var(--g-primary);
        background: color-mix(in srgb, var(--g-primary) 6%, transparent);
        padding: 2px 8px;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 170px;
        cursor: pointer;
        transition: all 0.15s;
      }
      .gt-card-project:hover {
        background: color-mix(in srgb, var(--g-primary) 12%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
        color: var(--g-primary);
      }
      .gt-card-assignee {
        font-size: 0.65rem;
        color: #888;
      }
      .gt-card-due {
        font-size: 0.65rem;
        color: #888;
      }
      .gt-due-overdue {
        color: #ef4444 !important;
        font-weight: 600;
      }
      .gt-card-meta-row {
        display: flex;
        gap: 4px;
        margin-top: 6px;
        flex-wrap: wrap;
        align-items: center;
      }
      .gt-dept-chip {
        font-size: 0.58rem;
        padding: 1px 6px;
        border-radius: 8px;
        background: rgba(168,85,247,0.1);
        color: #a78bfa;
        border: 1px solid rgba(168,85,247,0.2);
        white-space: nowrap;
      }
      .gt-dept-more {
        background: rgba(255,255,255,0.06);
        color: #888;
        border-color: rgba(255,255,255,0.1);
      }
      .gt-card-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 3px;
        margin-top: 6px;
      }
      .gt-tag {
        font-size: 0.6rem;
        padding: 1px 6px;
        border-radius: 8px;
        background: rgba(168,85,247,0.1);
        color: #a78bfa;
        border: 1px solid rgba(168,85,247,0.2);
      }
      .gt-drop-zone {
        min-height: 40px;
        border: 1px dashed rgba(59,130,246,0.12);
        border-radius: 8px;
        display: none;
        align-items: center;
        justify-content: center;
        color: #3f3f46;
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 1px;
        transition: all 0.15s;
      }
      .gt-col-drag-over .gt-drop-zone,
      .gt-drop-active {
        display: flex;
        border-color: rgba(59,130,246,0.3);
        color: #3b82f6;
      }

      /* ═══ Context Menu ═══ */
      .ctx-backdrop {
        position: fixed;
        inset: 0;
        z-index: 9998;
      }
      .ctx-menu {
        position: fixed;
        z-index: 9999;
        background: linear-gradient(180deg, #1a1a1a 0%, #111 100%);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 12px;
        min-width: 200px;
        padding: 6px;
        box-shadow: 
          0 20px 60px rgba(0,0,0,0.5),
          0 8px 24px rgba(0,0,0,0.4),
          inset 0 1px 0 rgba(255,255,255,0.05);
        animation: ctx-appear 0.15s ease-out;
      }
      @keyframes ctx-appear {
        from { opacity: 0; transform: scale(0.95) translateY(-4px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }
      .ctx-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        margin-bottom: 4px;
      }
      .ctx-header-icon {
        font-size: 0.9rem;
        opacity: 0.8;
      }
      .ctx-header-title {
        font-size: 0.75rem;
        font-weight: 600;
        color: #aaa;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 160px;
      }
      .ctx-divider {
        height: 1px;
        background: rgba(255,255,255,0.06);
        margin: 4px 8px;
      }
      .ctx-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.1s ease;
        position: relative;
        color: #ccc;
        font-size: 0.82rem;
      }
      .ctx-item:hover {
        background: rgba(255,255,255,0.08);
        color: #fff;
      }
      .ctx-item--active {
        color: var(--g-primary);
      }
      .ctx-item--active:hover {
        color: var(--g-primary);
      }
      .ctx-item--submenu {
        padding-right: 28px;
      }
      .ctx-item--run {
        color: #22c55e;
      }
      .ctx-item--run:hover {
        background: rgba(34,197,94,0.15);
        color: #4ade80;
      }
      .ctx-item--danger {
        color: #ef4444;
      }
      .ctx-item--danger:hover {
        background: rgba(239,68,68,0.15);
        color: #f87171;
      }
      .ctx-item--disabled {
        opacity: 0.4;
        cursor: not-allowed;
        pointer-events: none;
      }
      .ctx-icon {
        font-size: 0.9rem;
        width: 18px;
        text-align: center;
        flex-shrink: 0;
      }
      .ctx-arrow {
        position: absolute;
        right: 10px;
        color: #666;
        font-size: 0.9rem;
      }
      .ctx-check {
        margin-left: auto;
        color: #22c55e;
        font-size: 0.75rem;
        font-weight: 600;
      }
      .ctx-badge {
        margin-left: auto;
        font-size: 0.7rem;
        color: #666;
      }
      .ctx-submenu {
        position: absolute;
        background: linear-gradient(180deg, #1a1a1a 0%, #111 100%);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 12px;
        min-width: 180px;
        padding: 6px;
        box-shadow: 
          0 16px 48px rgba(0,0,0,0.5),
          0 6px 18px rgba(0,0,0,0.4);
        animation: ctx-submenu-appear 0.1s ease-out;
        z-index: 10;
      }
      /* Right-side submenu (default) */
      .ctx-submenu--right {
        animation: ctx-submenu-appear-right 0.1s ease-out;
      }
      /* Left-side submenu */
      .ctx-submenu--left {
        animation: ctx-submenu-appear-left 0.1s ease-out;
      }
      @keyframes ctx-submenu-appear-right {
        from { opacity: 0; transform: translateX(-8px); }
        to { opacity: 1; transform: translateX(0); }
      }
      @keyframes ctx-submenu-appear-left {
        from { opacity: 0; transform: translateX(8px); }
        to { opacity: 1; transform: translateX(0); }
      }
      .ctx-submenu .ctx-item {
        padding: 6px 12px;
        font-size: 0.78rem;
      }
      
      /* Submenu item with open submenu */
      .ctx-item--submenu-open {
        background: rgba(255,255,255,0.08);
        color: #fff;
      }
      
      /* Hover bridge - creates a safe zone for mouse movement to submenu */
      .ctx-item--submenu::after {
        content: '';
        position: absolute;
        top: 0;
        width: 20px;
        height: 100%;
        pointer-events: auto;
      }
      .ctx-item--submenu-open::after {
        width: 30px;
      }
      /* Right-pointing submenu bridge */
      .ctx-menu .ctx-item--submenu::after {
        right: -20px;
      }
      .ctx-menu .ctx-item--submenu-open::after {
        right: -30px;
      }
      
      /* Wide submenu for color picker */
      .ctx-submenu--wide {
        min-width: 220px;
        max-height: 400px;
        overflow-y: auto;
      }
      
      /* Picker submenu for emoji/icon */
      .ctx-submenu--picker {
        min-width: 300px;
        max-height: 400px;
        display: flex;
        flex-direction: column;
      }
      
      /* ═══ Color Picker ═══ */
      .ctx-color-section {
        padding: 8px;
      }
      .ctx-color-label {
        font-size: 0.7rem;
        color: #888;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 8px;
        padding: 0 4px;
      }
      .ctx-color-grid {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .ctx-color-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 8px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 0.78rem;
        color: #ccc;
        transition: background 0.1s;
      }
      .ctx-color-item:hover {
        background: rgba(255,255,255,0.08);
      }
      .ctx-color-item--active {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        color: var(--g-primary);
      }
      .ctx-color-swatch {
        width: 20px;
        height: 20px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 700;
        font-size: 0.75rem;
        flex-shrink: 0;
      }
      .ctx-color-swatch--text {
        background: rgba(0,0,0,0.3);
        border: 1px solid rgba(255,255,255,0.1);
      }
      .ctx-color-swatch--bg {
        border: 1px solid rgba(255,255,255,0.15);
      }

      /* ═══ Custom Color / Hue Slider ═══ */
      .ctx-color-custom {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 4px;
      }
      .ctx-color-input {
        width: 32px;
        height: 28px;
        padding: 0;
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 6px;
        background: transparent;
        cursor: pointer;
        flex-shrink: 0;
      }
      .ctx-color-input::-webkit-color-swatch-wrapper { padding: 2px; }
      .ctx-color-input::-webkit-color-swatch { border: none; border-radius: 4px; }
      .ctx-color-hue {
        flex: 1;
        height: 12px;
        appearance: none;
        -webkit-appearance: none;
        border-radius: 6px;
        outline: none;
        cursor: pointer;
        border: 1px solid rgba(255,255,255,0.1);
      }
      .ctx-color-hue::-webkit-slider-thumb {
        appearance: none;
        -webkit-appearance: none;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #fff;
        border: 2px solid rgba(0,0,0,0.5);
        cursor: grab;
        box-shadow: 0 1px 4px rgba(0,0,0,0.4);
      }
      .ctx-color-hue::-moz-range-thumb {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #fff;
        border: 2px solid rgba(0,0,0,0.5);
        cursor: grab;
      }
      .ctx-color-clear {
        width: 24px;
        height: 24px;
        border-radius: 6px;
        border: 1px solid rgba(255,255,255,0.1);
        background: transparent;
        color: #888;
        cursor: pointer;
        font-size: 0.85rem;
        line-height: 1;
        flex-shrink: 0;
      }
      .ctx-color-clear:hover { color: #fff; background: rgba(255,255,255,0.08); }

      /* ═══ Border Controls ═══ */
      .ctx-border-width {
        width: 100%;
        appearance: none;
        -webkit-appearance: none;
        height: 4px;
        border-radius: 2px;
        background: rgba(255,255,255,0.15);
        cursor: pointer;
      }
      .ctx-border-width::-webkit-slider-thumb {
        appearance: none;
        -webkit-appearance: none;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: var(--g-primary, #a855f7);
        cursor: grab;
        border: none;
      }
      .ctx-border-width::-moz-range-thumb {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: var(--g-primary, #a855f7);
        cursor: grab;
        border: none;
      }
      .ctx-border-styles {
        display: flex;
        gap: 4px;
        padding: 0 4px;
      }
      .ctx-border-style-btn {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        padding: 6px;
        background: transparent;
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 6px;
        color: #ccc;
        font-size: 0.7rem;
        cursor: pointer;
        transition: all 0.1s;
        text-transform: capitalize;
        font-family: inherit;
      }
      .ctx-border-style-btn:hover { background: rgba(255,255,255,0.06); color: #fff; }
      .ctx-border-style-btn--active {
        border-color: var(--g-primary, #a855f7);
        color: var(--g-primary, #a855f7);
        background: color-mix(in srgb, var(--g-primary, #a855f7) 10%, transparent);
      }
      .ctx-border-preview {
        display: block;
        width: 28px;
        height: 4px;
      }

      /* ═══ Icon/Emoji Picker ═══ */
      .ctx-picker-tabs {
        display: flex;
        gap: 0;
        padding: 6px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .ctx-picker-tab {
        flex: 1;
        padding: 6px 12px;
        background: transparent;
        border: none;
        color: #888;
        font-size: 0.78rem;
        font-weight: 500;
        cursor: pointer;
        border-radius: 6px;
        transition: all 0.15s;
        font-family: inherit;
      }
      .ctx-picker-tab:hover {
        color: #ccc;
        background: rgba(255,255,255,0.05);
      }
      .ctx-picker-tab--active {
        color: #fff;
        background: rgba(255,255,255,0.1);
      }
      .ctx-picker-remove {
        padding: 6px 12px;
        background: transparent;
        border: none;
        color: #ef4444;
        font-size: 0.72rem;
        cursor: pointer;
        border-radius: 6px;
        transition: all 0.15s;
        font-family: inherit;
        margin-left: auto;
      }
      .ctx-picker-remove:hover {
        background: rgba(239,68,68,0.15);
      }
      
      .ctx-picker-search {
        display: flex;
        gap: 6px;
        padding: 8px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .ctx-picker-search input[type="text"] {
        flex: 1;
        background: rgba(0,0,0,0.3);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 6px;
        padding: 6px 10px;
        color: #fff;
        font-size: 0.78rem;
        outline: none;
        font-family: inherit;
      }
      .ctx-picker-search input[type="text"]:focus {
        border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
      }
      .ctx-picker-search input[type="text"]::placeholder {
        color: #555;
      }
      .ctx-picker-random {
        width: 32px;
        height: 32px;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 6px;
        cursor: pointer;
        font-size: 0.9rem;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s;
      }
      .ctx-picker-random:hover {
        background: rgba(255,255,255,0.1);
        border-color: rgba(255,255,255,0.2);
      }
      .ctx-picker-color {
        width: 32px;
        height: 32px;
        padding: 0;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        overflow: hidden;
        background: transparent;
      }
      .ctx-picker-color::-webkit-color-swatch-wrapper {
        padding: 0;
      }
      .ctx-picker-color::-webkit-color-swatch {
        border: 2px solid rgba(255,255,255,0.2);
        border-radius: 6px;
      }
      
      .ctx-picker-content {
        flex: 1;
        overflow-y: auto;
        padding: 4px;
        max-height: 280px;
      }
      .ctx-picker-section {
        margin-bottom: 8px;
      }
      .ctx-picker-section-label {
        font-size: 0.68rem;
        color: #666;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        padding: 4px 8px;
        margin-bottom: 4px;
      }
      
      .ctx-picker-color-row {
        display: flex;
        gap: 4px;
        padding: 4px 8px;
        flex-wrap: wrap;
      }
      .ctx-picker-color-btn {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        border: 2px solid transparent;
        cursor: pointer;
        transition: all 0.15s;
      }
      .ctx-picker-color-btn:hover {
        transform: scale(1.15);
      }
      .ctx-picker-color-btn--active {
        border-color: #fff;
        box-shadow: 0 0 0 2px rgba(255,255,255,0.3);
      }
      
      .ctx-picker-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 2px;
        padding: 0 4px;
      }
      .ctx-picker-grid--emoji {
        gap: 0;
      }
      .ctx-picker-grid--icon {
        gap: 4px;
      }
      
      .ctx-picker-emoji {
        width: 32px;
        height: 32px;
        background: transparent;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 1.2rem;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.1s;
      }
      .ctx-picker-emoji:hover {
        background: rgba(255,255,255,0.1);
        transform: scale(1.15);
      }
      .ctx-picker-emoji--active {
        background: color-mix(in srgb, var(--g-primary) 20%, transparent);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--g-primary) 40%, transparent);
      }
      
      .ctx-picker-icon {
        width: 36px;
        height: 36px;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 8px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s;
        padding: 6px;
      }
      .ctx-picker-icon svg {
        width: 100%;
        height: 100%;
      }
      .ctx-picker-icon:hover {
        background: rgba(255,255,255,0.12);
        border-color: rgba(255,255,255,0.2);
        transform: scale(1.08);
      }
      .ctx-picker-icon--active {
        background: rgba(168,85,247,0.2);
        border-color: rgba(168,85,247,0.5);
        box-shadow: 0 0 0 2px rgba(168,85,247,0.3);
      }
      
      /* Scrollbar for picker */
      .ctx-picker-content::-webkit-scrollbar {
        width: 6px;
      }
      .ctx-picker-content::-webkit-scrollbar-track {
        background: transparent;
      }
      .ctx-picker-content::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.15);
        border-radius: 3px;
      }
      .ctx-picker-content::-webkit-scrollbar-thumb:hover {
        background: rgba(255,255,255,0.25);
      }

      /* ═══ Mobile ═══ */
      @media (max-width: 640px) {
        .gallery-grid { grid-template-columns: 1fr; padding: 16px; gap: 16px; }
        .gallery-toolbar { padding: 12px 16px; }
        .gallery-filters { flex-direction: column; align-items: stretch; min-width: 0; }
        .gallery-filter-group {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          width: 100%;
          overflow: visible;
        }
        .gallery-filter-btn {
          min-width: 0;
          padding: 7px 6px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          border-bottom: 1px solid rgba(255,255,255,0.06);
        }
        .gallery-search { width: 100%; min-width: 0; box-sizing: border-box; }
        .gallery-actions { width: 100%; flex-wrap: wrap; }
        .gc-footer { padding-right: 128px; min-height: 66px; }
        .gc-progress-val { flex: 0 0 32px; }
        .kanban-board { padding: 12px; }
        .kanban-column { min-width: 260px; }
        .detail-grid { grid-template-columns: 1fr; }
        .form-row { grid-template-columns: 1fr; }
        .board-tab-switcher { margin-left: 0; margin-top: 8px; }
        .board-toolbar-left { flex-wrap: wrap; }
        .notion-content { padding: 16px; }
        .gt-board { padding: 12px; }
        /* leave .gt-column min-width: 0 so the user-defined column widths set via the resize handle remain authoritative */
        .gt-toolbar { padding: 10px 16px; }
        .gt-toolbar-left { flex-direction: column; align-items: stretch; }
        .gt-search { min-width: 100%; }
        .nb-columns { flex-direction: column; }
        
        /* Mobile Context Menu */
        .ctx-backdrop {
          background: rgba(0,0,0,0.6);
        }
        .ctx-menu {
          position: fixed !important;
          left: 50% !important;
          top: auto !important;
          bottom: 0 !important;
          transform: translateX(-50%) !important;
          width: 100% !important;
          max-width: 100% !important;
          min-width: 100% !important;
          border-radius: 20px 20px 0 0 !important;
          max-height: 70vh;
          overflow-y: auto;
          padding-bottom: env(safe-area-inset-bottom, 12px);
          animation: ctx-slide-up 0.2s ease-out;
        }
        @keyframes ctx-slide-up {
          from { transform: translateX(-50%) translateY(100%); }
          to { transform: translateX(-50%) translateY(0); }
        }
        .ctx-header {
          padding: 16px 20px;
          border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .ctx-header-title {
          font-size: 1rem;
        }
        .ctx-item {
          padding: 14px 20px;
          font-size: 0.95rem;
        }
        .ctx-item--submenu {
          position: relative;
        }
        /* On mobile, submenus expand inline instead of floating */
        .ctx-submenu {
          position: relative !important;
          left: 0 !important;
          right: 0 !important;
          top: 0 !important;
          margin: 0 !important;
          background: rgba(0,0,0,0.3);
          border: none;
          border-radius: 8px;
          margin: 4px 12px !important;
          box-shadow: none;
          animation: ctx-submenu-expand 0.15s ease-out;
        }
        @keyframes ctx-submenu-expand {
          from { opacity: 0; max-height: 0; }
          to { opacity: 1; max-height: 500px; }
        }
        .ctx-submenu .ctx-item {
          padding: 12px 16px;
        }
        .ctx-arrow {
          transform: rotate(90deg);
          transition: transform 0.15s ease;
        }
        .ctx-item--submenu-open .ctx-arrow {
          transform: rotate(-90deg);
        }
        .ctx-submenu--wide,
        .ctx-submenu--picker {
          max-height: 50vh;
          overflow-y: auto;
        }
        .ctx-color-grid {
          grid-template-columns: repeat(5, 1fr);
        }
        .ctx-picker-grid {
          grid-template-columns: repeat(8, 1fr);
        }
        .ctx-picker-grid--icon {
          grid-template-columns: repeat(6, 1fr);
        }
        .ctx-picker-icon {
          width: 40px;
          height: 40px;
        }
        .ctx-picker-emoji {
          font-size: 1.5rem;
          width: 40px;
          height: 40px;
        }
        .ctx-divider {
          margin: 8px 16px;
        }
        /* Disable hover bridges on mobile since we tap instead */
        .ctx-item--submenu::after {
          display: none;
        }
      }

      /* ═══ Skeleton / Shimmer ═══ */
      @keyframes shimmer {
        0%   { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
      .skeleton-box {
        display: block;
        background: linear-gradient(
          90deg,
          rgba(255,255,255,0.04) 0%,
          rgba(255,255,255,0.09) 50%,
          rgba(255,255,255,0.04) 100%
        );
        background-size: 200% 100%;
        animation: shimmer 1.4s ease-in-out infinite;
        border-radius: 4px;
      }
      .gc-skeleton { pointer-events: none; }
      .gc-skeleton .gc-inner {
        background: linear-gradient(180deg, #111 0%, #0a0a0a 100%);
      }

      /* ═══ Refreshing indicator bar ═══ */
      .kanban-refreshing-bar {
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 2px;
        background: linear-gradient(90deg, transparent, var(--g-primary), transparent);
        background-size: 200% 100%;
        animation: shimmer 1.2s ease-in-out infinite;
        z-index: 100;
        pointer-events: none;
      }

      /* ═══ Error retry ═══ */
      .kanban-error {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .kanban-error-retry {
        background: transparent;
        border: 1px solid rgba(239,68,68,0.4);
        color: #ef4444;
        border-radius: 6px;
        padding: 4px 10px;
        font-size: 0.78rem;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.15s;
      }
      .kanban-error-retry:hover { background: rgba(239,68,68,0.1); }

      /* ═══ Empty state ═══ */
      .gallery-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 80px 24px;
        gap: 10px;
        text-align: center;
        flex: 1;
      }
      .gallery-empty-icon {
        font-size: 2.5rem;
        opacity: 0.4;
        margin-bottom: 4px;
      }
      .gallery-empty-title {
        font-size: 1.1rem;
        font-weight: 600;
        color: rgba(255,255,255,0.7);
      }
      .gallery-empty-subtitle {
        font-size: 0.82rem;
        color: rgba(255,255,255,0.35);
        max-width: 340px;
        line-height: 1.5;
      }
      .gallery-empty-actions {
        display: flex;
        gap: 10px;
        margin-top: 12px;
      }

      /* ═══ Pagination ═══ */
      .gallery-pagination {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 16px;
        padding: 16px;
        border-top: 1px solid rgba(255,255,255,0.06);
        flex-shrink: 0;
      }
      .gallery-page-btn {
        background: rgba(0,0,0,0.3);
        border: 1px solid rgba(255,255,255,0.1);
        color: rgba(255,255,255,0.7);
        border-radius: 6px;
        padding: 6px 14px;
        font-size: 0.82rem;
        cursor: pointer;
        font-family: inherit;
        transition: all 0.15s;
      }
      .gallery-page-btn:hover:not(:disabled) {
        border-color: var(--g-primary);
        color: var(--g-primary);
      }
      .gallery-page-btn:disabled { opacity: 0.3; cursor: default; }
      .gallery-page-info { font-size: 0.78rem; color: #666; }

      /* ═══ Task visualization modal ═══ */
      .modal-tasks-view {
        width: 760px;
        max-width: 92vw;
      }
      .tm-total-badge {
        font-size: 0.72rem;
        background: rgba(255,255,255,0.08);
        border-radius: 999px;
        padding: 2px 8px;
        color: #888;
        font-weight: 500;
      }
      .tm-columns {
        display: flex;
        gap: 1px;
        min-height: 200px;
        max-height: calc(60vh - 120px);
        overflow: hidden;
      }
      .tm-col {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        border-right: 1px solid rgba(255,255,255,0.05);
      }
      .tm-col:last-child { border-right: none; }
      .tm-col-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 10px 14px 8px;
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.6px;
        background: rgba(0,0,0,0.2);
        border-bottom: 1px solid rgba(255,255,255,0.05);
        flex-shrink: 0;
      }
      .tm-col-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .tm-col-count {
        margin-left: auto;
        font-size: 0.68rem;
        background: rgba(255,255,255,0.07);
        border-radius: 999px;
        padding: 1px 6px;
        color: #888;
      }
      .tm-col-body {
        flex: 1;
        overflow-y: auto;
        padding: 6px 0;
      }
      .tm-task {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 14px;
        cursor: pointer;
        border-left: 2px solid transparent;
        transition: all 0.1s;
        outline: none;
      }
      .tm-task:hover, .tm-task--focused {
        background: rgba(255,255,255,0.05);
        border-left-color: var(--g-primary);
      }
      .tm-status-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .tm-task-title {
        flex: 1;
        font-size: 0.82rem;
        color: rgba(255,255,255,0.85);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .tm-assignee {
        font-size: 0.68rem;
        color: #666;
        white-space: nowrap;
        max-width: 70px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .tm-updated {
        font-size: 0.65rem;
        color: #555;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .tm-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 48px 24px;
        color: rgba(255,255,255,0.4);
        font-size: 0.85rem;
        gap: 4px;
      }
      .tm-empty-icon {
        font-size: 2rem;
        opacity: 0.3;
        margin-bottom: 8px;
      }

      /* "View tasks" action button on gallery card — left of the edit button */
      .gc-action-tasks {
        right: 96px;
        background: rgba(255,255,255,0.08);
        color: #fff;
        backdrop-filter: blur(8px);
      }
      .gc-action-tasks:hover { background: rgba(255,255,255,0.18); }
    </style>
  `;
}
