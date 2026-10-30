import type { AppViewState } from "../app-view-state";
import type { KanbanProject, KanbanTask, TaskStatus, ProjectStatus, PriorityLevel } from "../types";
import { getBizFilter } from "../lib/biz-filter";
import { applyPendingTaskWrites, beginPendingTaskWrite } from "./kanban-pending-writes";
import {
  applyKanbanTaskUpdate,
  applyKnownVersions,
  markTaskDeleted,
  type KanbanTaskUpdatedPayload,
} from "./kanban-live";

// ── Project/Task cache ──────────────────────────────────
const KANBAN_CACHE_KEY = "kanban-data-cache-v2";
const KANBAN_CACHE_TTL = 5 * 60 * 1000; // 5 min

interface KanbanCache {
  projects: KanbanProject[];
  tasks: KanbanTask[];
  ts: number;
}

function readKanbanCache(): KanbanCache | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KANBAN_CACHE_KEY) : null;
    if (!raw) return null;
    const parsed: KanbanCache = JSON.parse(raw);
    if (!parsed.ts || !Array.isArray(parsed.projects)) return null;
    return parsed;
  } catch { return null; }
}

/** When the board was last fetched successfully (ms), or null — drives "updated Xm ago". */
export function kanbanCacheTimestamp(): number | null {
  return readKanbanCache()?.ts ?? null;
}

function writeKanbanCache(projects: KanbanProject[], tasks: KanbanTask[]): void {
  try {
    const entry: KanbanCache = { projects, tasks, ts: Date.now() };
    localStorage.setItem(KANBAN_CACHE_KEY, JSON.stringify(entry));
  } catch { /* storage full — ignore */ }
}

// ── Status Mappings ──────────────────────────────────
const NOTION_TASK_STATUS_TO_KANBAN: Record<string, TaskStatus> = {
  "Not started": "todo",
  "In progress": "in_progress",
  "Awaiting Response": "review",
  "Revisit": "review",
  "Done": "done",
};

const KANBAN_TO_NOTION_TASK_STATUS: Record<TaskStatus, string> = {
  "backlog": "Not started",
  "todo": "Not started",
  "in_progress": "In progress",
  "review": "Awaiting Response",
  "done": "Done",
};

// ── Notion Property Extractors ──────────────────────────────────
function extractTitle(props: any): string {
  // Try known title property names (KKProjects uses "Project", KK Tasks uses "Task Name")
  for (const key of ["Project", "Task Name", "Name", "Task", "Title", "title", "name"]) {
    const prop = props[key];
    if (prop?.title) {
      return prop.title.map((t: any) => t.plain_text || t.text?.content || "").join("") || "Untitled";
    }
  }
  // Try first title-type property
  for (const key of Object.keys(props)) {
    if (props[key]?.type === "title" && props[key]?.title) {
      return props[key].title.map((t: any) => t.plain_text || t.text?.content || "").join("") || "Untitled";
    }
  }
  return "Untitled";
}

function extractRichText(props: any, key: string): string {
  const prop = props[key];
  if (!prop?.rich_text) return "";
  return prop.rich_text.map((t: any) => t.plain_text || t.text?.content || "").join("");
}

function extractStatus(props: any, key: string): string {
  return props[key]?.status?.name || "";
}

function extractSelect(props: any, key: string): string {
  return props[key]?.select?.name || "";
}

function extractMultiSelect(props: any, key: string): string[] {
  return (props[key]?.multi_select || []).map((s: any) => s.name);
}

function extractNumber(props: any, key: string): number | undefined {
  const prop = props[key];
  // Handle direct number
  if (prop?.type === "number") {
    const val = prop.number;
    return val !== null && val !== undefined ? val : undefined;
  }
  // Handle rollup (e.g., Progress is percent_checked rollup)
  if (prop?.type === "rollup" && prop.rollup?.type === "number") {
    const val = prop.rollup.number;
    return val !== null && val !== undefined ? Math.round(val * 100) : undefined;
  }
  const val = prop?.number;
  return val !== null && val !== undefined ? val : undefined;
}

function extractDate(props: any, key: string): string | undefined {
  return props[key]?.date?.start || undefined;
}

function extractRelationCount(props: any, key: string): number {
  return props[key]?.relation?.length || 0;
}

function extractCheckbox(props: any, key: string): boolean {
  return props[key]?.checkbox === true;
}

function extractUrl(props: any, key: string): string | undefined {
  return props[key]?.url || undefined;
}

function extractPeople(props: any, key: string): string | undefined {
  const people = props[key]?.people;
  if (!people?.length) return undefined;
  return people.map((p: any) => p.name || p.person?.email || "").filter(Boolean).join(", ");
}

// ── Map Notion Pages to Local Types ──────────────────────────────────
function mapNotionToProject(page: any): KanbanProject {
  const props = page.properties || {};
  const status = extractStatus(props, "Status") as ProjectStatus;
  const priority = extractSelect(props, "Priority") as PriorityLevel;
  const coverUrl = page.cover?.external?.url || page.cover?.file?.url || undefined;

  return {
    id: page.id,
    notionId: page.id,
    name: extractTitle(props),
    description: extractRichText(props, "Description") || extractRichText(props, "Notes") || "",
    status: status || "Not started",
    priority: priority || undefined,
    type: extractMultiSelect(props, "Type"),
    progress: extractNumber(props, "Progress") ?? 0,
    taskCount: extractRelationCount(props, "Tasks"),
    coverUrl,
    productUrl: extractUrl(props, "Product URL") || extractUrl(props, "URL"),
    dueDate: extractDate(props, "Due") || extractDate(props, "Due Date"),
    assignedInstances: extractMultiSelect(props, "Assigned Instances"),
    createdAt: new Date(page.created_time).getTime(),
    updatedAt: new Date(page.last_edited_time).getTime(),
  };
}

function mapNotionToTask(page: any): KanbanTask {
  const props = page.properties || {};
  const notionStatus = extractStatus(props, "Status Update") || extractStatus(props, "Status") || "Not started";
  let kanbanStatus = NOTION_TASK_STATUS_TO_KANBAN[notionStatus] || "todo";
  const priorityLevel = extractSelect(props, "Priority Level") as PriorityLevel;

  // Map Notion priority to our priority type
  let priority: "low" | "normal" | "high" | "critical" = "normal";
  if (priorityLevel === "Immediate") priority = "critical";
  else if (priorityLevel === "High") priority = "high";
  else if (priorityLevel === "Medium") priority = "normal";
  else if (priorityLevel === "Low") priority = "low";

  // Get Done checkbox value
  let done = extractCheckbox(props, "Done");
  
  // ── Bidirectional sync: done checkbox ↔ status ──
  // Sync done and status to be consistent when reading from Notion
  if (done && kanbanStatus !== "done") {
    // Done checkbox is checked, so status should be "done"
    kanbanStatus = "done";
  } else if (kanbanStatus === "done" && !done) {
    // Status is Done but checkbox isn't checked - sync checkbox to match
    done = true;
  }

  return {
    id: page.id,
    notionId: page.id,
    projectId: (props.Project?.relation?.[0]?.id) || "",
    title: extractTitle(props),
    description: extractRichText(props, "Description") || extractRichText(props, "Notes") || "",
    status: kanbanStatus,
    notionStatus,
    assignee: extractPeople(props, "Assignee") || extractPeople(props, "Assign"),
    tags: extractMultiSelect(props, "Tags") || [],
    department: extractMultiSelect(props, "Department"),
    priorityLevel: priorityLevel || undefined,
    priority,
    dueDate: extractDate(props, "Due Date") || extractDate(props, "Due"),
    done,
    createdAt: new Date(page.created_time).getTime(),
    updatedAt: new Date(page.last_edited_time).getTime(),
  };
}

// ── Project Progress Calculation ──────────────────────────────────
// Recompute project progress locally from task data
export function recomputeProjectProgress(
  projects: KanbanProject[],
  tasks: KanbanTask[],
  projectId?: string
): KanbanProject[] {
  // Build a map of projectId -> tasks for efficient lookup
  const tasksByProject = new Map<string, KanbanTask[]>();
  for (const task of tasks) {
    const pid = task.projectId || "";
    if (!tasksByProject.has(pid)) {
      tasksByProject.set(pid, []);
    }
    tasksByProject.get(pid)!.push(task);
  }
  
  console.log("[Kanban] Task distribution by projectId:", 
    Array.from(tasksByProject.entries()).map(([k, v]) => `${k || "(empty)"}: ${v.length}`).join(", "));
  
  return projects.map(project => {
    // Skip if not the target project (when projectId is specified)
    if (projectId && project.id !== projectId) return project;
    
    // Find tasks for this project - try multiple matching strategies
    let projectTasks = tasksByProject.get(project.id) || [];
    
    // If no direct match, try matching by notionId (projects may use notionId as id)
    if (projectTasks.length === 0 && (project as any).notionId) {
      projectTasks = tasksByProject.get((project as any).notionId) || [];
    }
    
    // Try reverse lookup: check if any task's projectId ends with project.id (Notion UUID format)
    if (projectTasks.length === 0) {
      for (const [pid, pTasks] of tasksByProject.entries()) {
        if (pid && (pid.includes(project.id) || project.id.includes(pid))) {
          projectTasks = pTasks;
          console.log(`[Kanban] Matched project "${project.name}" via partial ID match: ${pid}`);
          break;
        }
      }
    }
    
    // If we're in single-project view (projectId specified) and still no matches,
    // assume ALL loaded tasks belong to this project (they were filtered by API)
    if (projectTasks.length === 0 && projectId && tasks.length > 0) {
      console.log(`[Kanban] No tasks match projectId ${project.id}, using all ${tasks.length} tasks`);
      projectTasks = tasks;
    }
    
    if (projectTasks.length === 0) {
      // Keep existing Notion progress if we can't compute
      return { ...project, progress: project.progress || 0 };
    }
    
    const totalTasks = projectTasks.length;
    
    // Count tasks as done if: done=true OR status="done" (case-insensitive)
    const doneTasks = projectTasks.filter(t => {
      const isDone = t.done === true;
      const statusDone = t.status?.toLowerCase() === "done";
      return isDone || statusDone;
    }).length;
    
    const computedProgress = Math.round((doneTasks / totalTasks) * 100);
    
    console.log(`[Kanban] Project "${project.name}" (id: ${project.id.substring(0, 8)}...): ${doneTasks}/${totalTasks} tasks done = ${computedProgress}%`);
    
    return {
      ...project,
      progress: computedProgress,
      taskCount: totalTasks,
    };
  });
}

// Recalculate progress for a specific project after task update
export function updateProjectProgressFromTasks(state: AppViewState, projectId: string): void {
  if (!state.kanbanProjects.length || !state.kanbanTasks.length) return;
  
  const updatedProjects = recomputeProjectProgress(
    state.kanbanProjects,
    state.kanbanTasks,
    projectId
  );
  
  // Only update if progress changed
  const oldProject = state.kanbanProjects.find(p => p.id === projectId);
  const newProject = updatedProjects.find(p => p.id === projectId);
  
  if (oldProject && newProject && oldProject.progress !== newProject.progress) {
    state.kanbanProjects = updatedProjects;
    state.requestUpdate?.();
  }
}

// ── Notion Data Fetching ──────────────────────────────────
// Use standard databases.query as primary (data sources API may not be configured)
export async function loadNotionProjects(client: any): Promise<KanbanProject[]> {
  return (await client.request("kanban.projects.list", {})) || [];
}

export async function loadNotionTasksForProject(client: any, projectPageId: string): Promise<KanbanTask[]> {
  return (await client.request("kanban.tasks.list", { projectId: projectPageId })) || [];
}

export async function loadAllNotionTasks(client: any): Promise<KanbanTask[]> {
  return (await client.request("kanban.tasks.list", {})) || [];
}

export async function createNotionTask(client: any, projectPageId: string, title: string, opts?: {
  description?: string;
  status?: string;
  priority?: string;
}): Promise<KanbanTask> {
  return client.request("kanban.tasks.create", {
    title,
    projectId: projectPageId,
    description: opts?.description,
    status: opts?.status,
    priority: opts?.priority,
  });
}

export async function updateNotionTask(client: any, pageId: string, props: Record<string, any>) {
  await client.request("kanban.tasks.update", { id: pageId, patch: props });
}

export async function updateNotionTaskStatus(client: any, pageId: string, status: string) {
  await updateNotionTask(client, pageId, {
    "Status Update": { status: { name: status } },
  });
}

export async function createNotionProject(client: any, name: string, opts?: {
  description?: string;
  status?: string;
  priority?: string;
  type?: string[];
}): Promise<KanbanProject> {
  return client.request("kanban.projects.create", {
    name,
    description: opts?.description,
    status: opts?.status,
    priority: opts?.priority,
    type: opts?.type,
  });
}

export async function updateNotionProject(client: any, pageId: string, props: Record<string, any>) {
  await client.request("kanban.projects.update", { id: pageId, patch: props });
}

// ── Kanban Polling ──────────────────────────────────
let kanbanPollTimer: ReturnType<typeof setInterval> | null = null;
let kanbanPollActive = false;

export function startKanbanPolling(state: AppViewState) {
  if (kanbanPollTimer) return;
  kanbanPollActive = true;
  kanbanPollTimer = setInterval(() => {
    if (!kanbanPollActive) return;
    void pollKanbanUpdates(state);
  }, 15000); // Poll every 15s for Notion
}

export function stopKanbanPolling() {
  kanbanPollActive = false;
  if (kanbanPollTimer) {
    clearInterval(kanbanPollTimer);
    kanbanPollTimer = null;
  }
}

async function pollKanbanUpdates(state: AppViewState) {
  if (!state.client) return;
  try {
    // ── DATA-LOSS FIX: poll via the gateway list, NOT loadNotionProjects ──
    // businessId (business/agency link), mediaProjectId, linkedInvoiceIds and
    // style fields live in the local SQLite project_meta table — they are NOT
    // Notion properties. `kanban.projects.list` fetches from Notion AND merges
    // that local meta server-side; `loadNotionProjects` queries Notion directly
    // and returns meta-stripped rows. Polling with the latter overwrote
    // state.kanbanProjects every 15s with businessId/invoice links dropped, so
    // the per-project client + business associations "flakily disappeared"
    // (they were still safe in SQLite, but the live poll blew them out of the
    // UI until a full reload re-merged them). Use the same endpoint loadKanban
    // uses so the merged fields survive every poll.
    let projects: KanbanProject[];
    try {
      projects = (await state.client.request<KanbanProject[]>("kanban.projects.list")) || [];
    } catch {
      // Fall back to direct Notion only if the gateway list is unavailable;
      // this path loses local meta but is better than a blank board.
      projects = await loadNotionProjects(state.client);
    }
    const projChanged = JSON.stringify(projects) !== JSON.stringify(state.kanbanProjects);
    if (projChanged) {
      state.kanbanProjects = projects;
      // If we have a selected project, also reload its tasks (merged endpoint).
      if (state.kanbanSelectedProjectId) {
        let tasks: KanbanTask[];
        try {
          tasks =
            (await state.client.request<KanbanTask[]>("kanban.tasks.list", {
              projectId: state.kanbanSelectedProjectId,
            })) || [];
        } catch {
          tasks = await loadNotionTasksForProject(state.client, state.kanbanSelectedProjectId);
        }
        state.kanbanTasks = applyPendingTaskWrites(applyKnownVersions(tasks, state.kanbanTasks));
      }
      state.requestUpdate?.();
    }
  } catch {
    // Silently ignore poll failures
  }
}

// ── Main Load Function ──────────────────────────────────
export async function loadKanban(state: AppViewState) {
  if (!state.client) return;
  state.kanbanError = null;

  // ── Optimistic: serve cached data immediately, then revalidate ──
  // Only a cold start renders the localStorage copy: re-rendering it on a
  // live reload (every `kanban:changed`) flashed pre-write rows — the drag
  // to Done that "reset" a moment later.
  const cached = state.kanbanTasks?.length ? null : readKanbanCache();
  const cacheHit = cached && Date.now() - cached.ts < KANBAN_CACHE_TTL;
  if (cacheHit) {
    state.kanbanProjects = cached.projects;
    state.kanbanTasks = applyPendingTaskWrites(cached.tasks, Date.now(), { fromServer: false });
    state.kanbanLoading = false;
    state.kanbanRefreshing = true;
    if (state.kanbanGalleryView === undefined) state.kanbanGalleryView = true;
    state.requestUpdate?.();
  } else {
    state.kanbanLoading = true;
    state.kanbanRefreshing = false;
    state.requestUpdate?.();
  }

  try {
    // ── BACKLOG FIX: Use gateway endpoints which merge local status (including backlog) ──
    // Gateway fetches from Notion but overlays locally-stored statuses
    const [projects, tasks] = await Promise.all([
      state.client.request<KanbanProject[]>("kanban.projects.list"),
      state.client.request<KanbanTask[]>("kanban.tasks.list"),
    ]);
    state.kanbanProjects = projects || [];
    // A list read before a write (pending, or already applied from a
    // `kanban.task.updated` event) must not bring the old row back.
    state.kanbanTasks = applyPendingTaskWrites(applyKnownVersions(tasks || [], state.kanbanTasks));

    console.log("[Kanban] Loaded", state.kanbanProjects.length, "projects and", state.kanbanTasks.length, "tasks via gateway");
    writeKanbanCache(state.kanbanProjects, state.kanbanTasks);
  } catch (err: any) {
    console.warn("[Kanban] Gateway load failed, trying direct Notion:", err.message);

    // Fallback to direct Notion (backlog status may be lost)
    try {
      const [projects, tasks] = await Promise.all([
        loadNotionProjects(state.client),
        loadAllNotionTasks(state.client),
      ]);
      state.kanbanProjects = projects;
      state.kanbanTasks = applyPendingTaskWrites(tasks);
      writeKanbanCache(state.kanbanProjects, state.kanbanTasks);
    } catch {
      if (!cacheHit) {
        state.kanbanError = `Failed to load projects: ${err.message}`;
      }
    }
  }

  if (state.kanbanProjects.length === 0) {
    state.kanbanProjects = [{
      id: "default",
      name: "Main Project",
      description: "Default project",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }];
  }

  // ── Recompute project progress from actual task data ──
  // This overrides Notion's rollup which only counts Done checkbox
  // We want to count tasks where status="done" OR done=true
  if (state.kanbanProjects.length > 0 && state.kanbanTasks.length > 0) {
    state.kanbanProjects = recomputeProjectProgress(state.kanbanProjects, state.kanbanTasks);
  }

  // Default to gallery view
  if (state.kanbanGalleryView === undefined) {
    state.kanbanGalleryView = true;
  }

  state.kanbanLoading = false;
  state.kanbanRefreshing = false;
  state.requestUpdate?.();
}

// ── Load tasks for a specific project (called when entering board view) ──
export async function loadProjectTasks(state: AppViewState, projectId: string) {
  if (!state.client) return;
  state.kanbanLoading = true;
  state.kanbanError = null;
  state.requestUpdate?.();

  try {
    // ── BACKLOG FIX: Use gateway endpoint which merges local status ──
    const tasks = await state.client.request<KanbanTask[]>("kanban.tasks.list", { projectId });
    state.kanbanTasks = applyPendingTaskWrites(applyKnownVersions(tasks || [], state.kanbanTasks));
    console.log("[Kanban] Loaded", state.kanbanTasks.length, "tasks for project", projectId);
  } catch (err: any) {
    // Fallback to direct Notion
    console.warn("[Kanban] Gateway failed, trying direct Notion:", err.message);
    try {
      const tasks = await loadNotionTasksForProject(state.client, projectId);
      state.kanbanTasks = applyPendingTaskWrites(tasks);
    } catch (notionErr: any) {
      console.error("[Kanban] Failed to load tasks:", notionErr);
      state.kanbanError = `Failed to load tasks: ${err.message}`;
    }
  }

  // ── Recompute progress for this project from actual task data ──
  if (state.kanbanTasks.length > 0) {
    state.kanbanProjects = recomputeProjectProgress(state.kanbanProjects, state.kanbanTasks, projectId);
  }

  state.kanbanLoading = false;
  state.requestUpdate?.();
}

// ── Cross-view cache invalidation ─────────────────────
/**
 * Drop the Command Center's cached recent-kanban payload so the home
 * task-board, linked-projects panel, and activity feed refetch on next
 * render. Called after any kanban mutation (create/update/delete on
 * projects or tasks) — without this, the home tab would show stale data
 * for up to the cache TTL (30s) after a /projects edit, and the user
 * would think the changes "weren't synced".
 *
 * Cheap: just nulls out the in-memory cache. The next render of the
 * Command Center fires loadRecentKanban which re-pulls kanban.projects.list
 * + kanban.tasks.list (already fetched on a 15s server poll anyway).
 */
function invalidateCommandCenterKanbanCache(state: AppViewState): void {
  const bs = state.businessState;
  if (!bs) return;
  bs.recentKanban = null;
}

// ── CRUD Operations ──────────────────────────────────
export async function createProject(state: AppViewState, project: Partial<KanbanProject>) {
  if (!state.client) return;
  const agencyId = getBizFilter();
  try {
    let newProject = await createNotionProject(state.client, project.name || "New Project", {
      description: project.description,
    });
    if (agencyId) {
      const scoped = await state.client.request<KanbanProject>("kanban.projects.update", {
        id: newProject.id,
        patch: { businessId: agencyId },
      });
      newProject = { ...newProject, ...scoped, businessId: agencyId };
    }
    state.kanbanProjects = [...state.kanbanProjects, newProject];
    invalidateCommandCenterKanbanCache(state);
    state.requestUpdate?.();
  } catch (err: any) {
    // Fallback to local
    try {
      const newProject = await state.client.request<KanbanProject>("kanban.projects.create", {
        ...project,
        ...(agencyId ? { businessId: agencyId } : {}),
      });
      state.kanbanProjects = [...state.kanbanProjects, newProject];
      invalidateCommandCenterKanbanCache(state);
    } catch {
      state.kanbanError = err.message;
    }
    state.requestUpdate?.();
  }
}

export async function updateProject(state: AppViewState, id: string, patch: Partial<KanbanProject>) {
  if (!state.client) return;
  const originalProjects = [...state.kanbanProjects];
  state.kanbanProjects = state.kanbanProjects.map(p => p.id === id ? { ...p, ...patch } : p);
  state.requestUpdate?.();

  // Style fields and local-only meta (businessId, mediaProjectId) are not
  // Notion properties — they only persist via the kanban gateway method,
  // which writes them to the local SQLite store. Without this call the 15s
  // poll wipes out the optimistic update on the next refresh, so the
  // per-project business assignment looks like it "doesn't persist".
  const LOCAL_KEYS: (keyof KanbanProject)[] = [
    "customIcon", "iconColor", "textColor", "bgColor",
    "borderColor", "borderWidth", "borderStyle",
    "businessId", "mediaProjectId",
    // Project hierarchy: the kanban gateway method writes the Notion "Parent
    // Project" relation AND the local SQLite store, so route reparenting
    // through it (Notion's relation isn't covered by the notionProps block
    // below). null clears the parent (top-level).
    "parentProjectId",
    // Cash-flow / recurring-revenue fields edited from the project header
    // popover. These persist through kanban.projects.update (Notion number
    // props + local SQLite), so route them here — otherwise the 15s poll
    // wipes the optimistic edit and the value "doesn't persist on refresh".
    // MRR additionally rolls up into the Agency Operations MRR statistic.
    "paidAmount", "pendingPay", "paidAmountDate", "pendingPayDate", "mrr",
  ];
  const localPatch: Partial<KanbanProject> = {};
  for (const key of LOCAL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      (localPatch as any)[key] = (patch as any)[key];
    }
  }
  if (Object.keys(localPatch).length > 0) {
    try {
      await state.client.request("kanban.projects.update", { id, patch: localPatch });
      // Project↔business link just changed → drop the summary cache too so
      // overview KPIs refresh. recentKanban gets nulled below for any update.
      if (Object.prototype.hasOwnProperty.call(localPatch, "businessId")) {
        const bs = state.businessState;
        if (bs) {
          bs.summary = null;
          bs.summaryLoadedAt = null;
        }
      }
    } catch (err: any) {
      console.warn("[kanban] Failed to persist project local fields:", err?.message ?? err);
    }
  }
  // Any project mutation invalidates the Command Center's task-board cache.
  invalidateCommandCenterKanbanCache(state);

  try {
    const remotePatch: Partial<KanbanProject> = {};
    for (const key of [
      "name",
      "status",
      "priority",
      "description",
      "progress",
      "productUrl",
      "dueDate",
    ] as const) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        (remotePatch as any)[key] = (patch as any)[key];
      }
    }
    if (Object.keys(remotePatch).length > 0) {
      await state.client.request("kanban.projects.update", { id, patch: remotePatch });
    }
  } catch (err: any) {
    state.kanbanError = err.message;
    state.kanbanProjects = originalProjects;
    state.requestUpdate?.();
  }
}

export async function createTask(state: AppViewState, task: Partial<KanbanTask>) {
  if (!state.client) return;
  try {
    const newTask = await createNotionTask(
      state.client,
      task.projectId || state.kanbanSelectedProjectId || "",
      task.title || "New Task",
      {
        status: task.status,
        priority: task.priority,
        description: task.description,
      }
    );
    state.kanbanTasks = [...state.kanbanTasks, newTask];
    invalidateCommandCenterKanbanCache(state);
    state.requestUpdate?.();
  } catch (err: any) {
    // Fallback to local
    try {
      const newTask = await state.client.request<KanbanTask>("kanban.tasks.create", task);
      state.kanbanTasks = [...state.kanbanTasks, newTask];
      invalidateCommandCenterKanbanCache(state);
    } catch {
      state.kanbanError = err.message;
    }
    state.requestUpdate?.();
  }
}

export async function updateTask(state: AppViewState, id: string, patch: Partial<KanbanTask>) {
  if (!state.client) return;
  
  // ── Bidirectional sync: done checkbox ↔ status ──
  // Find current task to check existing status
  const currentTask = state.kanbanTasks.find(t => t.id === id);
  if (!currentTask) return;
  
  // If done is being set to true, also set status to "done"
  if (patch.done === true && patch.status === undefined) {
    patch.status = "done";
  }
  // If done is being set to false and status was "done", reset to "todo"
  if (patch.done === false && currentTask.status === "done" && patch.status === undefined) {
    patch.status = "todo";
  }
  // If status is being set to "done", also set done to true
  if (patch.status === "done" && patch.done === undefined) {
    patch.done = true;
  }
  // If status is being changed from "done" to something else, set done to false
  if (patch.status && patch.status !== "done" && currentTask.status === "done" && patch.done === undefined) {
    patch.done = false;
  }
  
  const originalProjects = [...state.kanbanProjects];
  state.kanbanTasks = state.kanbanTasks.map(t => t.id === id ? { ...t, ...patch } : t);
  // Pending from now on: any board reload while the request is in flight
  // re-applies it instead of snapping the card back.
  const undoPending = beginPendingTaskWrite(id, patch as Record<string, unknown>);
  persistBoardCache(state);

  // ── Recalculate project progress locally ──
  const projectId = currentTask.projectId;
  if (projectId && (patch.done !== undefined || patch.status !== undefined)) {
    updateProjectProgressFromTasks(state, projectId);
  }

  state.requestUpdate?.();

  try {
    // ── BACKLOG FIX: Use gateway endpoint for ALL status updates ──
    // Gateway stores exact status locally (including "backlog") and syncs to Notion
    // This single call handles both local SQLite storage AND Notion sync
    const res = await state.client.request<Record<string, unknown> | null>("kanban.tasks.update", { id, patch });
    // Older gateways answer ok + notionSyncFailed when Notion refused the write.
    if (res && res.notionSyncFailed === true) throw new Error("Notion didn't save the change — try again");
    if (res && typeof res.version === "number") {
      applyTaskUpdateEvent(state, { id, fields: patch as Record<string, unknown>, version: res.version, syncPending: res.syncPending === true });
    }
    invalidateCommandCenterKanbanCache(state);
  } catch (err: any) {
    undoPending();
    state.kanbanError = err.message;
    // Roll back only this card — other rows may have been reloaded meanwhile.
    state.kanbanTasks = state.kanbanTasks.map(t => t.id === id ? currentTask : t);
    state.kanbanProjects = originalProjects;
    persistBoardCache(state);
    state.requestUpdate?.();
  }
}

/** Keep the cold-start copy in step with what the board shows. */
function persistBoardCache(state: AppViewState): void {
  if (state.kanbanProjects?.length && state.kanbanTasks?.length) {
    writeKanbanCache(state.kanbanProjects, state.kanbanTasks);
  }
}

/**
 * Apply a `kanban.task.updated` event (or a versioned write answer) to the
 * board in place. Older versions are ignored. Returns true when a row changed.
 */
export function applyTaskUpdateEvent(state: AppViewState, payload: KanbanTaskUpdatedPayload): boolean {
  const before = state.kanbanTasks;
  const after = applyKanbanTaskUpdate(before ?? [], payload);
  if (after === before) return false;
  state.kanbanTasks = after;
  const pid = (after.find((t) => t.id === payload.id)?.projectId) ?? payload.projectId ?? null;
  if (pid && (payload.fields.status !== undefined || payload.fields.done !== undefined)) {
    updateProjectProgressFromTasks(state, pid);
  }
  persistBoardCache(state);
  state.requestUpdate?.();
  return true;
}

export async function deleteTask(state: AppViewState, id: string) {
  if (!state.client) return;
  const removed = state.kanbanTasks.find(t => t.id === id);
  state.kanbanTasks = state.kanbanTasks.filter(t => t.id !== id);
  // Deleted from now on: a board reload while the request is in flight (or a
  // list the gateway read before the delete) can't bring the card back.
  const undoDeleted = markTaskDeleted(id);
  persistBoardCache(state);
  state.requestUpdate?.();

  try {
    // The kanban RPC archives in Notion AND evicts the row from every cached
    // list + broadcasts; the raw notion.update path left it listed for minutes.
    await state.client.request("kanban.tasks.delete", { id });
    invalidateCommandCenterKanbanCache(state);
  } catch (err: any) {
    undoDeleted();
    state.kanbanError = err.message;
    if (removed && !state.kanbanTasks.some(t => t.id === id)) state.kanbanTasks = [...state.kanbanTasks, removed];
    persistBoardCache(state);
    state.requestUpdate?.();
  }
}

export async function deleteProject(state: AppViewState, id: string) {
  if (!state.client) return;
  const originalProjects = [...state.kanbanProjects];
  state.kanbanProjects = state.kanbanProjects.filter(p => p.id !== id);
  if (state.kanbanSelectedProjectId === id) {
    state.kanbanSelectedProjectId = state.kanbanProjects.length > 0 ? state.kanbanProjects[0].id : null;
    state.kanbanGalleryView = true;
  }
  state.requestUpdate?.();

  try {
    await state.client.request("notion.update", { pageId: id, archived: true });
    invalidateCommandCenterKanbanCache(state);
    // A deleted project may have been pinned. Strip its id from the
    // localStorage priority list for whichever business it belonged to so
    // the next open of the Command Center doesn't try to render a ghost.
    try {
      const { getPriorities, setPriorities } = await import("../lib/priorities.js");
      const businesses = state.businessState?.businesses ?? [];
      for (const biz of businesses) {
        const pinned = getPriorities(biz.id);
        if (pinned.includes(id)) {
          setPriorities(biz.id, pinned.filter((x) => x !== id));
        }
      }
    } catch { /* priorities lib unavailable in some test contexts */ }
  } catch (err: any) {
    state.kanbanError = err.message;
    state.kanbanProjects = originalProjects;
    state.requestUpdate?.();
  }
}

// ── Notion Sync (legacy compat) ──────────────────────────────────────────
export async function syncToNotion(state: AppViewState): Promise<void> {
  // With Notion-first approach, just reload
  await loadKanban(state);
}

export async function getNotionSyncStatus(_state: AppViewState): Promise<void> {
  // No-op in Notion-first mode
}

// ── MCP Server Lifecycle (keep for backward compat) ──────────────────────────────────
export interface McpStatus {
  running: boolean;
  port: number;
  uptime: number;
}

export async function fetchMcpStatus(state: AppViewState): Promise<McpStatus> {
  if (!state.client) return { running: false, port: 0, uptime: 0 };
  try {
    return await state.client.request<McpStatus>("mcp.status") || { running: false, port: 0, uptime: 0 };
  } catch { return { running: false, port: 0, uptime: 0 }; }
}

export async function startMcpServer(state: AppViewState): Promise<McpStatus> {
  if (!state.client) return { running: false, port: 0, uptime: 0 };
  try {
    return await state.client.request<McpStatus>("mcp.start") || { running: false, port: 0, uptime: 0 };
  } catch { return { running: false, port: 0, uptime: 0 }; }
}

export async function stopMcpServer(state: AppViewState): Promise<McpStatus> {
  if (!state.client) return { running: false, port: 0, uptime: 0 };
  try {
    return await state.client.request<McpStatus>("mcp.stop") || { running: false, port: 0, uptime: 0 };
  } catch { return { running: false, port: 0, uptime: 0 }; }
}

export async function restartMcpServer(state: AppViewState): Promise<McpStatus> {
  if (!state.client) return { running: false, port: 0, uptime: 0 };
  try {
    return await state.client.request<McpStatus>("mcp.restart") || { running: false, port: 0, uptime: 0 };
  } catch { return { running: false, port: 0, uptime: 0 }; }
}

export function startMcpStatusPolling(_state: AppViewState, _onUpdate: (status: McpStatus) => void) {}
export function stopMcpStatusPolling() {}

export async function openMcpDashboard() {
  window.open("http://localhost:8889/admin/tasks", "_blank");
}

// ── Agent Assignment (keep existing exports) ──────────────────────
export async function suggestAgentsForKanbanTask(_state: AppViewState, _task: KanbanTask) { return []; }
export async function assignTaskAgent(_state: AppViewState, _taskId: string, _agentId: string | null) {}
export async function getTaskAssignedAgent(_taskId: string) { return null; }
export async function getAllAgentsForKanban(_state: AppViewState) { return []; }

// ══════════════════════════════════════════════════════════════════════════
// TASK & PROJECT REORDERING (Persistent Vertical Ranking)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Reorder a task within its status column.
 * @param taskId - Task to move
 * @param beforeId - Task that will be AFTER this one (or null if moving to end)
 * @param afterId - Task that will be BEFORE this one (or null if moving to start)
 */
export async function reorderTask(
  state: AppViewState,
  taskId: string,
  beforeId: string | null,
  afterId: string | null
): Promise<void> {
  if (!state.client) return;
  
  try {
    await state.client.request("kanban.tasks.reorder", { id: taskId, beforeId, afterId });
    // Reload to get updated ranks
    await loadKanban(state);
  } catch (err: any) {
    console.error("[Kanban] Failed to reorder task:", err);
    state.kanbanError = err.message;
    state.requestUpdate?.();
  }
}

/**
 * Bulk reorder tasks - set the order for all task IDs.
 * @param taskIds - Array of task IDs in desired order
 */
export async function setTaskRanks(state: AppViewState, taskIds: string[]): Promise<void> {
  if (!state.client) return;
  
  try {
    await state.client.request("kanban.tasks.setRanks", { taskIds });
    // Reload to get updated ranks
    await loadKanban(state);
  } catch (err: any) {
    console.error("[Kanban] Failed to set task ranks:", err);
    state.kanbanError = err.message;
    state.requestUpdate?.();
  }
}

/**
 * Reorder a project in the project list.
 * @param projectId - Project to move
 * @param beforeId - Project that will be AFTER this one (or null if moving to end)
 * @param afterId - Project that will be BEFORE this one (or null if moving to start)
 */
export async function reorderProject(
  state: AppViewState,
  projectId: string,
  beforeId: string | null,
  afterId: string | null
): Promise<void> {
  if (!state.client) return;
  
  try {
    await state.client.request("kanban.projects.reorder", { id: projectId, beforeId, afterId });
    // Reload to get updated ranks
    await loadKanban(state);
  } catch (err: any) {
    console.error("[Kanban] Failed to reorder project:", err);
    state.kanbanError = err.message;
    state.requestUpdate?.();
  }
}

/**
 * Bulk reorder projects - set the order for all project IDs.
 * @param projectIds - Array of project IDs in desired order
 */
export async function setProjectRanks(state: AppViewState, projectIds: string[]): Promise<void> {
  if (!state.client) return;
  
  try {
    await state.client.request("kanban.projects.setRanks", { projectIds });
    // Reload to get updated ranks
    await loadKanban(state);
  } catch (err: any) {
    console.error("[Kanban] Failed to set project ranks:", err);
    state.kanbanError = err.message;
    state.requestUpdate?.();
  }
}

/**
 * Handle task drop event from drag-and-drop.
 * @param taskId - Dragged task ID
 * @param targetStatus - Status column dropped into
 * @param insertIndex - Position in the column (0 = top)
 */
export async function handleTaskDrop(
  state: AppViewState,
  taskId: string,
  targetStatus: TaskStatus,
  insertIndex: number
): Promise<void> {
  if (!state.client) return;
  
  const task = state.kanbanTasks.find(t => t.id === taskId);
  if (!task) return;
  
  // Get tasks in target column (sorted by current rank)
  const columnTasks = state.kanbanTasks
    .filter(t => t.status === targetStatus && t.id !== taskId)
    .sort((a, b) => ((a as any).rank ?? 999999) - ((b as any).rank ?? 999999));
  
  // Determine before/after IDs based on insert position
  const afterId = insertIndex > 0 ? columnTasks[insertIndex - 1]?.id : null;
  const beforeId = insertIndex < columnTasks.length ? columnTasks[insertIndex]?.id : null;
  
  // Optimistically update UI (done follows status, as in updateTask)
  const statusPatch: Partial<KanbanTask> = { status: targetStatus };
  if (task.status !== targetStatus) statusPatch.done = targetStatus === "done";
  state.kanbanTasks = state.kanbanTasks.map(t =>
    t.id === taskId ? { ...t, ...statusPatch } : t
  );
  const undoPending = task.status !== targetStatus
    ? beginPendingTaskWrite(taskId, statusPatch as Record<string, unknown>)
    : () => {};
  persistBoardCache(state);
  state.requestUpdate?.();

  try {
    // Update status first if changed
    if (task.status !== targetStatus) {
      const res = await state.client.request<Record<string, unknown> | null>("kanban.tasks.update", {
        id: taskId,
        patch: statusPatch,
      });
      if (res && res.notionSyncFailed === true) throw new Error("Notion didn't save the change — try again");
      if (res && typeof res.version === "number") {
        applyTaskUpdateEvent(state, { id: taskId, fields: statusPatch as Record<string, unknown>, version: res.version, syncPending: res.syncPending === true });
      }
      invalidateCommandCenterKanbanCache(state);
    }
  } catch (err: any) {
    console.error("[Kanban] Failed to handle task drop:", err);
    undoPending();
    state.kanbanTasks = state.kanbanTasks.map(t => t.id === taskId ? task : t);
    persistBoardCache(state);
    state.kanbanError = err.message;
    state.requestUpdate?.();
    return;
  }
  // Rank is cosmetic: a failure here must not undo the (saved) status move.
  try {
    await state.client.request("kanban.tasks.reorder", { id: taskId, beforeId, afterId });
  } catch (err: any) {
    console.warn("[Kanban] reorder after drop failed:", err?.message ?? err);
  }
}

/**
 * Handle project drop event from drag-and-drop.
 * @param projectId - Dragged project ID
 * @param insertIndex - Position in the list (0 = top)
 */
export async function handleProjectDrop(
  state: AppViewState,
  projectId: string,
  insertIndex: number
): Promise<void> {
  if (!state.client) return;
  
  // Get projects excluding the dragged one
  const otherProjects = state.kanbanProjects
    .filter(p => p.id !== projectId)
    .sort((a, b) => ((a as any).rank ?? 999999) - ((b as any).rank ?? 999999));
  
  const afterId = insertIndex > 0 ? otherProjects[insertIndex - 1]?.id : null;
  const beforeId = insertIndex < otherProjects.length ? otherProjects[insertIndex]?.id : null;
  
  try {
    await state.client.request("kanban.projects.reorder", { id: projectId, beforeId, afterId });
    await loadKanban(state);
  } catch (err: any) {
    console.error("[Kanban] Failed to handle project drop:", err);
    state.kanbanError = err.message;
    state.requestUpdate?.();
  }
}
