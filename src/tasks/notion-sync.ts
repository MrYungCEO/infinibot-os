/**
 * Notion Kanban Sync - Bidirectional sync between local SQLite kanban and Notion databases.
 *
 * Config sources, in priority order:
 *   1. The wizard-managed `notion` block in infinibot.json (apiKey, projectsDbId, tasksDbId)
 *      via src/databases/notion-config.ts. This is what `infinibot setup-ui` writes.
 *   2. Legacy state/notion-sync.json file (older installs that pre-date the wizard).
 *   3. Legacy NOTION_API_KEY env var (oldest fallback).
 *
 * Reading from the wizard config is critical: without it, `kanban-sync.ts`
 * silently falls back to "skipped" because neither the env var nor the
 * legacy state file exists on a fresh wizard-only setup, and sessions only
 * land in local SQLite.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { getKanbanStore, KanbanStore } from "./store.js";
import { KanbanTask, KanbanProject, TaskStatus, ComputeRequirement } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { sanitizeNotionPageWrite } from "../databases/notion-option-map.js";
import {
  getNotionConfig as getWizardNotionConfig,
  getNotionApiKeyOrNull as getWizardNotionApiKey,
  resolveNotionDbId,
} from "../databases/notion-config.js";

const log = createSubsystemLogger("notion-sync");

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28"; // Works with both old and new Notion API versions

// ── Config ───────────────────────────────────────────────

export interface NotionSyncConfig {
  projectsDbId: string | null;
  tasksDbId: string | null;
  lastSyncAt: number | null;
}

let configCache: NotionSyncConfig | null = null;

function getStateDir(): string {
  return process.env.INFINIBOT_STATE_DIR ?? "state";
}

function getConfigPath(): string {
  return join(getStateDir(), "notion-sync.json");
}

export function getNotionConfig(): NotionSyncConfig {
  // Prefer the wizard-managed config in infinibot.json. Read on every call
  // (no caching) so a wizard re-run during the same gateway process is
  // picked up immediately. The legacy state/notion-sync.json file is only
  // consulted when the wizard hasn't populated projectsDbId/tasksDbId.
  const wizard = getWizardNotionConfig();
  if (wizard.projectsDbId && wizard.tasksDbId) {
    return {
      projectsDbId: wizard.projectsDbId,
      tasksDbId: wizard.tasksDbId,
      lastSyncAt: configCache?.lastSyncAt ?? null,
    };
  }
  if (configCache) return configCache;
  const p = getConfigPath();
  if (existsSync(p)) {
    try {
      configCache = JSON.parse(readFileSync(p, "utf-8"));
      return configCache!;
    } catch {
      // fall through
    }
  }
  configCache = { projectsDbId: null, tasksDbId: null, lastSyncAt: null };
  return configCache;
}

function saveConfig(cfg: NotionSyncConfig): void {
  configCache = cfg;
  const p = getConfigPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2));
}

export function getNotionApiKey(): string | null {
  // Wizard-configured key wins. The wizard's `getNotionApiKeyOrNull`
  // already enforces "syncMode !== off", so on `mirror`/`import-once` we
  // get the saved key, otherwise null. Falls back to the legacy env var
  // for older installs that haven't run the wizard yet.
  const wizardKey = getWizardNotionApiKey();
  if (wizardKey) return wizardKey;
  return process.env.NOTION_API_KEY || null;
}

// ── Schema cache (delegated) ─────────────────────────────
// This module previously maintained its own per-database property cache.
// That meant a `notion.schema.applyPatch` (in databases/notion-schema.ts)
// would invalidate its OWN cache but the writers below would still hold a
// stale shape for up to 5 minutes — the agent would skip writing newly-
// added properties until the TTL expired. The legacy wrapper now delegates
// to the canonical cache so a reconcile reaches every reader instantly.
import { getLegacySchemaShape } from "../databases/notion-schema.js";

interface DatabaseSchema {
  titleProp: string;
  props: Set<string>;
}

async function getDatabaseSchema(dbId: string): Promise<DatabaseSchema | null> {
  return getLegacySchemaShape(dbId);
}

// ── Notion API helpers ───────────────────────────────────

async function notionFetch(path: string, opts: RequestInit = {}): Promise<any> {
  const apiKey = getNotionApiKey();
  if (!apiKey) throw new Error("NOTION_API_KEY not set");
  if (typeof opts.body === "string") {
    opts = {
      ...opts,
      body: await sanitizeNotionPageWrite(apiKey, path, opts.method, opts.body, [
        resolveNotionDbId("kanban-tasks"),
        resolveNotionDbId("kanban-projects"),
      ]),
    };
  }

  const url = `${NOTION_API_URL}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...((opts.headers as Record<string, string>) || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });

  const body = await res.json();
  if (!res.ok) {
    log.error("Notion API error", { status: res.status, body });
    throw new Error(`Notion API ${res.status}: ${body?.message || JSON.stringify(body)}`);
  }
  return body;
}

// ── Status mapping ───────────────────────────────────────

const LOCAL_TO_NOTION_STATUS: Record<string, string> = {
  backlog: "Not started",
  todo: "Not started",
  in_progress: "In progress",
  review: "Awaiting Response",
  done: "Done",
};

const NOTION_TO_LOCAL_STATUS: Record<string, TaskStatus> = {
  "Not started": "todo",
  "Awaiting Response": "review",
  Revisit: "review",
  "In progress": "in_progress",
  Done: "done",
  // Legacy mappings
  Backlog: "backlog",
  "To Do": "todo",
  "In Progress": "in_progress",
  Review: "review",
};

const LOCAL_TO_NOTION_PRIORITY: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Immediate",
};

// ── Project Status → Task Status Cascade Mapping ──────────
const PROJECT_TO_TASK_STATUS: Record<string, TaskStatus> = {
  "Not started": "todo",
  "In progress": "in_progress",
  Completed: "done",
  Paused: "backlog",
  Updating: "in_progress",
  "Awaiting Client": "review",
  Reviewing: "review",
  Cancelled: "done",
};

const NOTION_TO_LOCAL_PRIORITY: Record<string, string> = {
  Low: "low",
  Medium: "medium",
  High: "high",
  Immediate: "critical",
  Critical: "critical",
};

// ── Database creation ────────────────────────────────────

export async function createNotionDatabases(parentPageId?: string): Promise<{
  projectsDbId: string;
  tasksDbId: string;
}> {
  // If no parent page given, search for one
  let parentId = parentPageId;
  if (!parentId) {
    const searchRes = await notionFetch("/search", {
      method: "POST",
      body: JSON.stringify({
        filter: { value: "page", property: "object" },
        page_size: 10,
      }),
    });

    // Find a workspace-level page
    const workspacePage = searchRes.results?.find(
      (r: any) => r.object === "page" && r.parent?.type === "workspace",
    );

    if (workspacePage) {
      parentId = workspacePage.id;
    } else if (searchRes.results?.length > 0) {
      // Use first available page
      parentId = searchRes.results[0].id;
    } else {
      throw new Error("No pages found in Notion workspace to create databases under");
    }
  }

  log.info("Creating Notion databases under page", { parentId });

  // Create Projects database
  const projectsDb = await notionFetch("/databases", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "page_id", page_id: parentId },
      title: [{ type: "text", text: { content: "InfiniBot Projects" } }],
      properties: {
        Name: { title: {} },
        Description: { rich_text: {} },
        Color: { rich_text: {} },
        Deadline: { date: {} },
        LocalId: { rich_text: {} },
        SyncedAt: { date: {} },
      },
    }),
  });

  const projectsDbId = projectsDb.id;
  log.info("Created Projects database", { projectsDbId });

  // Create Tasks database
  const tasksDb = await notionFetch("/databases", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "page_id", page_id: parentId },
      title: [{ type: "text", text: { content: "InfiniBot Tasks" } }],
      properties: {
        Name: { title: {} },
        Description: { rich_text: {} },
        Status: {
          select: {
            options: [
              { name: "Backlog", color: "gray" },
              { name: "To Do", color: "blue" },
              { name: "In Progress", color: "yellow" },
              { name: "Review", color: "purple" },
              { name: "Done", color: "green" },
            ],
          },
        },
        Priority: {
          select: {
            options: [
              { name: "Low", color: "gray" },
              { name: "Medium", color: "blue" },
              { name: "High", color: "orange" },
              { name: "Critical", color: "red" },
            ],
          },
        },
        Assignee: { rich_text: {} },
        Project: {
          relation: {
            database_id: projectsDbId,
            single_property: {},
          },
        },
        LocalId: { rich_text: {} },
        Phase: { rich_text: {} },
        SyncedAt: { date: {} },
      },
    }),
  });

  const tasksDbId = tasksDb.id;
  log.info("Created Tasks database", { tasksDbId });

  // Save config
  const cfg = getNotionConfig();
  cfg.projectsDbId = projectsDbId;
  cfg.tasksDbId = tasksDbId;
  saveConfig(cfg);

  return { projectsDbId, tasksDbId };
}

// ── Single-item sync (fire-and-forget) ───────────────────

export async function notionCreateTask(task: KanbanTask): Promise<void> {
  try {
    const cfg = getNotionConfig();
    if (!cfg.tasksDbId || !getNotionApiKey()) return;

    // Wizard's Tasks DB titles the title field "Task Name"; the legacy
    // schema used "Name". Same skip-unknown-props logic as projects above.
    const schema = await getDatabaseSchema(cfg.tasksDbId);
    if (!schema) {
      log.warn("Skipping Notion task create: schema unavailable", { taskId: task.id });
      return;
    }

    // Find the project's Notion page ID for relation
    const store = getKanbanStore();
    const projectNotionId = store.getNotionPageId("projects", task.projectId);

    // ── Bidirectional sync: done checkbox ↔ status ──
    // Ensure done and status are consistent
    const isDone = task.done || task.status === "done";
    const notionStatus = LOCAL_TO_NOTION_STATUS[task.status] || "Not started";

    const properties: Record<string, any> = {
      [schema.titleProp]: { title: [{ text: { content: task.title } }] },
    };
    const addIfPresent = (name: string, value: any) => {
      if (schema.props.has(name)) properties[name] = value;
    };

    addIfPresent("Description", { rich_text: [{ text: { content: task.description || "" } }] });
    // Wizard schema uses "Status Update" (status type) for tasks. Send
    // it whichever name the DB has — fall back to "Status" for legacy.
    if (schema.props.has("Status Update")) {
      properties["Status Update"] = { status: { name: notionStatus } };
    } else if (schema.props.has("Status")) {
      properties.Status = { status: { name: notionStatus } };
    }
    addIfPresent("Done", { checkbox: isDone });
    addIfPresent("Assignee", { rich_text: [{ text: { content: task.assignee || "" } }] });
    addIfPresent("LocalId", { rich_text: [{ text: { content: task.id } }] });
    addIfPresent("SyncedAt", { date: { start: new Date().toISOString() } });

    if (task.priority && LOCAL_TO_NOTION_PRIORITY[task.priority]) {
      const mapped = LOCAL_TO_NOTION_PRIORITY[task.priority];
      // Wizard schema uses "Priority Level" (select); legacy used "Priority".
      if (schema.props.has("Priority Level")) {
        properties["Priority Level"] = { select: { name: mapped } };
      } else if (schema.props.has("Priority")) {
        properties.Priority = { select: { name: mapped } };
      }
    }

    if (task.dueDate) {
      addIfPresent("Due Date", { date: { start: task.dueDate } });
    }

    if (projectNotionId) {
      addIfPresent("Project", { relation: [{ id: projectNotionId }] });
    }

    const phaseName = getPhaseNameForTask(store, task);
    if (phaseName !== undefined) {
      addIfPresent("Phase", { rich_text: [{ text: { content: phaseName } }] });
    }

    // Federation properties (handle gracefully - only add if present)
    if (task.node) {
      addIfPresent("Node", { select: { name: task.node } });
    }
    if (task.directory) {
      addIfPresent("Directory", { rich_text: [{ text: { content: task.directory } }] });
    }
    if (task.computeRequirements?.length) {
      addIfPresent("Compute Requirements", {
        multi_select: task.computeRequirements.map((req) => ({ name: req })),
      });
    }
    if (task.delegatedTo) {
      addIfPresent("Delegated To", { rich_text: [{ text: { content: task.delegatedTo } }] });
    }
    if (task.sourceNode) {
      addIfPresent("Source Node", { select: { name: task.sourceNode } });
    }

    const page = await notionFetch("/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { database_id: cfg.tasksDbId },
        properties,
      }),
    });

    // Store the Notion page ID locally
    store.setNotionPageId("tasks", task.id, page.id);
    log.info("Created task in Notion", { localId: task.id, notionId: page.id });
  } catch (err) {
    log.error("Failed to create task in Notion", { err, taskId: task.id });
  }
}

export async function notionUpdateTask(taskId: string, patch: Partial<KanbanTask>): Promise<void> {
  try {
    const cfg = getNotionConfig();
    if (!cfg.tasksDbId || !getNotionApiKey()) return;

    const schema = await getDatabaseSchema(cfg.tasksDbId);
    if (!schema) {
      log.warn("Skipping Notion task update: schema unavailable", { taskId });
      return;
    }

    const store = getKanbanStore();
    const notionPageId = store.getNotionPageId("tasks", taskId);
    if (!notionPageId) {
      // Task not yet synced, try creating it
      const tasks = await store.getTasks();
      const task = tasks.find((t) => t.id === taskId);
      if (task) {
        await notionCreateTask({ ...task, ...patch });
      }
      return;
    }

    const properties: Record<string, any> = {};
    const addIfPresent = (name: string, value: any) => {
      if (schema.props.has(name)) properties[name] = value;
    };
    const setStatusUpdate = (statusName: string) => {
      if (schema.props.has("Status Update")) {
        properties["Status Update"] = { status: { name: statusName } };
      } else if (schema.props.has("Status")) {
        properties.Status = { status: { name: statusName } };
      }
    };

    addIfPresent("SyncedAt", { date: { start: new Date().toISOString() } });

    if (patch.title !== undefined) {
      properties[schema.titleProp] = { title: [{ text: { content: patch.title } }] };
    }
    if (patch.description !== undefined) {
      addIfPresent("Description", { rich_text: [{ text: { content: patch.description } }] });
    }

    // ── Bidirectional sync: done checkbox ↔ status ──
    // When status changes, also update Done checkbox
    if (patch.status !== undefined) {
      if (LOCAL_TO_NOTION_STATUS[patch.status]) {
        setStatusUpdate(LOCAL_TO_NOTION_STATUS[patch.status]);
      }
      // Sync Done checkbox with status
      if (patch.done === undefined) {
        addIfPresent("Done", { checkbox: patch.status === "done" });
      }
    }

    // When done checkbox changes, also update status
    if (patch.done !== undefined) {
      addIfPresent("Done", { checkbox: patch.done });
      // Sync status with Done checkbox (if status not already being set)
      if (patch.status === undefined) {
        setStatusUpdate(patch.done ? "Done" : "Not started");
      }
    }

    if (patch.priority !== undefined && LOCAL_TO_NOTION_PRIORITY[patch.priority]) {
      const mapped = LOCAL_TO_NOTION_PRIORITY[patch.priority];
      if (schema.props.has("Priority Level")) {
        properties["Priority Level"] = { select: { name: mapped } };
      } else if (schema.props.has("Priority")) {
        properties.Priority = { select: { name: mapped } };
      }
    }
    if (patch.assignee !== undefined) {
      addIfPresent("Assignee", { rich_text: [{ text: { content: patch.assignee || "" } }] });
    }
    if (patch.phaseId !== undefined) {
      const tasks = await store.getTasks();
      const localTask = tasks.find((t) => t.id === taskId);
      const projectId = patch.projectId ?? localTask?.projectId;
      const phaseName =
        patch.phaseId && projectId
          ? store.listPhases(projectId).find((phase) => phase.id === patch.phaseId)?.name
          : "";
      addIfPresent("Phase", { rich_text: [{ text: { content: phaseName ?? "" } }] });
    }

    // Federation properties (handle gracefully - only add if present)
    if (patch.node !== undefined) {
      addIfPresent("Node", patch.node ? { select: { name: patch.node } } : { select: null });
    }
    if (patch.directory !== undefined) {
      addIfPresent("Directory", { rich_text: [{ text: { content: patch.directory || "" } }] });
    }
    if (patch.computeRequirements !== undefined) {
      addIfPresent("Compute Requirements", {
        multi_select: (patch.computeRequirements || []).map((req) => ({ name: req })),
      });
    }
    if (patch.delegatedTo !== undefined) {
      addIfPresent("Delegated To", { rich_text: [{ text: { content: patch.delegatedTo || "" } }] });
    }
    if (patch.sourceNode !== undefined) {
      addIfPresent(
        "Source Node",
        patch.sourceNode ? { select: { name: patch.sourceNode } } : { select: null },
      );
    }

    await notionFetch(`/pages/${notionPageId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });

    log.info("Updated task in Notion", { localId: taskId, notionId: notionPageId });
  } catch (err) {
    log.error("Failed to update task in Notion", { err, taskId });
  }
}

export async function notionCreateProject(project: KanbanProject): Promise<void> {
  try {
    const cfg = getNotionConfig();
    if (!cfg.projectsDbId || !getNotionApiKey()) return;

    // Read the actual database schema so we use the right title field
    // (the wizard names it "Project", legacy installs may have "Name") and
    // skip props that don't exist on this database — Notion rejects the
    // entire write if any property is unknown.
    const schema = await getDatabaseSchema(cfg.projectsDbId);
    if (!schema) {
      log.warn("Skipping Notion project create: schema unavailable", { projectId: project.id });
      return;
    }

    const properties: Record<string, any> = {
      [schema.titleProp]: { title: [{ text: { content: project.name } }] },
    };
    const addIfPresent = (name: string, value: any) => {
      if (schema.props.has(name)) properties[name] = value;
    };

    addIfPresent("Description", { rich_text: [{ text: { content: project.description || "" } }] });
    addIfPresent("Color", { rich_text: [{ text: { content: project.color || "" } }] });
    addIfPresent("LocalId", { rich_text: [{ text: { content: project.id } }] });
    addIfPresent("SyncedAt", { date: { start: new Date().toISOString() } });

    if (project.status) {
      // Wizard schema uses "Status" with `status` type. Older installs
      // may instead have a select-typed status; we send `status` first
      // and let Notion reject if the type doesn't match (rare).
      addIfPresent("Status", { status: { name: project.status } });
    }
    if (project.priority) {
      addIfPresent("Priority", { select: { name: project.priority } });
    }
    if (project.dueDate) {
      addIfPresent("Due Date", { date: { start: project.dueDate } });
      addIfPresent("Deadline", { date: { start: project.dueDate } });
    }
    if (project.type?.length) {
      addIfPresent("Type", { multi_select: project.type.map((t) => ({ name: t })) });
    }

    // Federation properties (handle gracefully - only add if present)
    if (project.primaryNode) {
      addIfPresent("Primary Node", { select: { name: project.primaryNode } });
    }
    if (project.projectDirectory) {
      addIfPresent("Project Directory", {
        rich_text: [{ text: { content: project.projectDirectory } }],
      });
    }
    if (project.shared !== undefined) {
      addIfPresent("Shared", { checkbox: project.shared });
    }

    const page = await notionFetch("/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { database_id: cfg.projectsDbId },
        properties,
      }),
    });

    const store = getKanbanStore();
    store.setNotionPageId("projects", project.id, page.id);
    log.info("Created project in Notion", { localId: project.id, notionId: page.id });
  } catch (err) {
    log.error("Failed to create project in Notion", { err, projectId: project.id });
  }
}

export async function notionUpdateProject(
  projectId: string,
  patch: Partial<KanbanProject>,
  options?: { cascadeStatus?: boolean },
): Promise<void> {
  try {
    const cfg = getNotionConfig();
    if (!cfg.projectsDbId || !getNotionApiKey()) return;

    const schema = await getDatabaseSchema(cfg.projectsDbId);
    if (!schema) {
      log.warn("Skipping Notion project update: schema unavailable", { projectId });
      return;
    }

    const store = getKanbanStore();
    const notionPageId = store.getNotionPageId("projects", projectId);
    if (!notionPageId) {
      // Project not yet synced, try creating it
      const projects = await store.getProjects();
      const project = projects.find((p) => p.id === projectId);
      if (project) {
        await notionCreateProject({ ...project, ...patch });
      }
      return;
    }

    const properties: Record<string, any> = {};
    const addIfPresent = (name: string, value: any) => {
      if (schema.props.has(name)) properties[name] = value;
    };

    addIfPresent("SyncedAt", { date: { start: new Date().toISOString() } });

    if (patch.name !== undefined) {
      properties[schema.titleProp] = { title: [{ text: { content: patch.name } }] };
    }
    if (patch.description !== undefined) {
      addIfPresent("Description", { rich_text: [{ text: { content: patch.description } }] });
    }
    if (patch.status !== undefined) {
      // Wizard schema uses status type for Status property
      addIfPresent("Status", { status: { name: patch.status } });
    }
    if (patch.priority !== undefined) {
      addIfPresent("Priority", { select: { name: patch.priority } });
    }
    if (patch.type !== undefined) {
      addIfPresent("Type", { multi_select: patch.type.map((t) => ({ name: t })) });
    }
    if (patch.color !== undefined) {
      addIfPresent("Color", { rich_text: [{ text: { content: patch.color } }] });
    }
    if (patch.dueDate !== undefined) {
      addIfPresent("Due Date", patch.dueDate ? { date: { start: patch.dueDate } } : { date: null });
      addIfPresent("Deadline", patch.dueDate ? { date: { start: patch.dueDate } } : { date: null });
    }
    // Federation properties
    if (patch.primaryNode !== undefined) {
      addIfPresent(
        "Primary Node",
        patch.primaryNode ? { select: { name: patch.primaryNode } } : { select: null },
      );
    }
    if (patch.projectDirectory !== undefined) {
      addIfPresent("Project Directory", {
        rich_text: [{ text: { content: patch.projectDirectory || "" } }],
      });
    }
    if (patch.shared !== undefined) {
      addIfPresent("Shared", { checkbox: patch.shared });
    }

    await notionFetch(`/pages/${notionPageId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });

    log.info("Updated project in Notion", { localId: projectId, notionId: notionPageId });

    // ── Cascade status to all tasks when project status changes ──
    const shouldCascade = options?.cascadeStatus !== false; // Default true
    if (shouldCascade && patch.status) {
      const targetTaskStatus = PROJECT_TO_TASK_STATUS[patch.status];
      if (targetTaskStatus && cfg.tasksDbId) {
        const taskSchema = await getDatabaseSchema(cfg.tasksDbId);
        if (!taskSchema) {
          log.warn("Skipping task status cascade: tasks DB schema unavailable", { projectId });
        } else {
          // Get all tasks for this project from local store
          const tasks = await store.getTasks(projectId);
          const notionTaskStatus = LOCAL_TO_NOTION_STATUS[targetTaskStatus] || "Not started";
          const isDone = targetTaskStatus === "done";
          let cascadedCount = 0;

          for (const task of tasks) {
            const taskNotionId = store.getNotionPageId("tasks", task.id);
            if (taskNotionId) {
              try {
                const taskProps: Record<string, any> = {};
                if (taskSchema.props.has("Status Update")) {
                  taskProps["Status Update"] = { status: { name: notionTaskStatus } };
                } else if (taskSchema.props.has("Status")) {
                  taskProps.Status = { status: { name: notionTaskStatus } };
                }
                if (isDone && taskSchema.props.has("Done")) {
                  taskProps.Done = { checkbox: true };
                }
                if (Object.keys(taskProps).length === 0) continue;
                await notionFetch(`/pages/${taskNotionId}`, {
                  method: "PATCH",
                  body: JSON.stringify({ properties: taskProps }),
                });
                cascadedCount++;
              } catch (err) {
                log.warn("Failed to cascade status to task in Notion", { taskId: task.id, err });
              }
            }
          }
          log.info("Cascaded project status to tasks in Notion", {
            projectId,
            projectStatus: patch.status,
            taskStatus: targetTaskStatus,
            tasksUpdated: cascadedCount,
          });
        }
      }
    }
  } catch (err) {
    log.error("Failed to update project in Notion", { err, projectId });
  }
}

// ── Full sync operations ─────────────────────────────────

async function queryAllPages(databaseId: string): Promise<any[]> {
  const pages: any[] = [];
  let cursor: string | undefined;

  do {
    const body: any = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const res = await notionFetch(`/databases/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return pages;
}

function extractRichText(prop: any): string {
  if (!prop?.rich_text?.length) return "";
  return prop.rich_text.map((t: any) => t.plain_text).join("");
}

function extractTitle(prop: any): string {
  if (!prop?.title?.length) return "";
  return prop.title.map((t: any) => t.plain_text).join("");
}

function getPhaseNameForTask(
  store: KanbanStore,
  task: Pick<KanbanTask, "projectId" | "phaseId">,
): string | undefined {
  if (!task.phaseId) return undefined;
  return store.listPhases(task.projectId).find((phase) => phase.id === task.phaseId)?.name;
}

function resolvePhaseIdFromName(
  store: KanbanStore,
  projectId: string,
  phaseName: string,
): string | undefined {
  const normalized = phaseName.trim();
  if (!normalized) return undefined;
  const existing = store
    .listPhases(projectId)
    .find((phase) => phase.name.trim().toLowerCase() === normalized.toLowerCase());
  return existing?.id ?? store.createPhase({ projectId, name: normalized }).id;
}

export async function syncToNotion(): Promise<{ projects: number; tasks: number }> {
  const cfg = getNotionConfig();
  if (!cfg.projectsDbId || !cfg.tasksDbId || !getNotionApiKey()) {
    throw new Error("Notion sync not configured (missing database IDs or API key)");
  }

  const store = getKanbanStore();
  const projects = await store.getProjects();
  const tasks = await store.getTasks();

  let projectCount = 0;
  let taskCount = 0;

  // Sync projects
  for (const project of projects) {
    const notionId = store.getNotionPageId("projects", project.id);
    if (notionId) {
      await notionUpdateProject(project.id, project, { cascadeStatus: false });
    } else {
      await notionCreateProject(project);
    }
    projectCount++;
  }

  // Sync tasks
  for (const task of tasks) {
    const notionId = store.getNotionPageId("tasks", task.id);
    if (notionId) {
      await notionUpdateTask(task.id, task);
    } else {
      await notionCreateTask(task);
    }
    taskCount++;
  }

  const now = Date.now();
  cfg.lastSyncAt = now;
  saveConfig(cfg);

  log.info("Sync to Notion complete", { projects: projectCount, tasks: taskCount });
  return { projects: projectCount, tasks: taskCount };
}

export async function syncFromNotion(): Promise<{ projects: number; tasks: number }> {
  const cfg = getNotionConfig();
  if (!cfg.projectsDbId || !cfg.tasksDbId || !getNotionApiKey()) {
    throw new Error("Notion sync not configured (missing database IDs or API key)");
  }

  const store = getKanbanStore();
  let projectCount = 0;
  let taskCount = 0;

  // Build Notion→local project ID mapping
  const notionToLocalProject: Map<string, string> = new Map();

  // Pull projects (KKProjects schema)
  const notionProjects = await queryAllPages(cfg.projectsDbId);
  for (const np of notionProjects) {
    const props = np.properties;
    const name = extractTitle(props.Project || props.Name);
    if (!name) continue;

    const description = extractRichText(props.Description);
    const status = props.Status?.status?.name || "Not started";
    const priority = props.Priority?.select?.name;
    const types = props.Type?.multi_select?.map((t: any) => t.name) || [];
    const progress = props.Progress?.rollup?.number ?? undefined;
    const productUrl = props["Product URL"]?.url ?? undefined;
    const dueDate = props.Deadline?.date?.start ?? props["Due Date"]?.date?.start ?? undefined;
    const coverUrl =
      props.Cover?.files?.[0]?.file?.url || props.Cover?.files?.[0]?.external?.url || undefined;

    // Federation properties (handle gracefully - may not exist for older projects)
    const primaryNode = props["Primary Node"]?.select?.name ?? undefined;
    const projectDirectory = extractRichText(props["Project Directory"]);
    const shared = props.Shared?.checkbox ?? false;

    // Check if we already have this project by notionPageId
    const existing = store.getByNotionPageId("projects", np.id);
    if (existing) {
      await store.updateProject(existing.id, {
        name,
        description,
        status: status as any,
        priority: priority as any,
        type: types.length ? types : undefined,
        progress,
        productUrl,
        dueDate,
        coverUrl,
        notionId: np.id,
        // Federation properties
        primaryNode: primaryNode || undefined,
        projectDirectory: projectDirectory || undefined,
        shared,
      });
      notionToLocalProject.set(np.id, existing.id);
    } else {
      // Also check by LocalId (legacy)
      const localId = extractRichText(props.LocalId);
      const existingById = localId
        ? (await store.getProjects()).find((p) => p.id === localId)
        : null;
      if (existingById) {
        await store.updateProject(existingById.id, {
          name,
          description,
          status: status as any,
          priority: priority as any,
          type: types.length ? types : undefined,
          progress,
          productUrl,
          dueDate,
          coverUrl,
          notionId: np.id,
          // Federation properties
          primaryNode: primaryNode || undefined,
          projectDirectory: projectDirectory || undefined,
          shared,
        });
        store.setNotionPageId("projects", existingById.id, np.id);
        notionToLocalProject.set(np.id, existingById.id);
      } else {
        // Create locally
        const id = crypto.randomUUID();
        await store.createProject({
          id,
          name,
          description,
          color: undefined,
          type: types.length ? types : undefined,
          status: status as any,
          priority: priority as any,
          progress,
          productUrl,
          dueDate,
          coverUrl,
          notionId: np.id,
          // Federation properties
          primaryNode: primaryNode || undefined,
          projectDirectory: projectDirectory || undefined,
          shared,
        });
        store.setNotionPageId("projects", id, np.id);
        notionToLocalProject.set(np.id, id);
      }
    }
    projectCount++;
  }

  // Pull tasks (KKTasks schema)
  const notionTasks = await queryAllPages(cfg.tasksDbId);
  for (const nt of notionTasks) {
    const props = nt.properties;
    const title = extractTitle(props["Task Name"] || props.Name);
    if (!title) continue;

    // Status Update (status type, not select)
    const notionStatus =
      props["Status Update"]?.status?.name ||
      props.Status?.status?.name ||
      props.Status?.select?.name ||
      "Not started";
    let status = NOTION_TO_LOCAL_STATUS[notionStatus] || "todo";

    // Priority Level
    const notionPriority = props["Priority Level"]?.select?.name || props.Priority?.select?.name;
    const priority = notionPriority
      ? NOTION_TO_LOCAL_PRIORITY[notionPriority] || notionPriority.toLowerCase()
      : undefined;
    const priorityLevel = (notionPriority as any) || undefined;

    // Done checkbox
    let done = props.Done?.checkbox ?? false;

    // ── Bidirectional sync: done checkbox ↔ status ──
    // Sync done and status to be consistent when reading from Notion
    // Priority: If Done is checked → status must be "done"
    //           If status is "Done" → done must be true
    if (done && status !== "done") {
      // Done checkbox was checked, so status should be "done"
      status = "done";
      log.debug("Syncing status=done to match Done checkbox", { taskTitle: title });
    } else if (status === "done" && !done) {
      // Status is Done but checkbox isn't checked - sync checkbox to match
      done = true;
      log.debug("Syncing done=true to match status", { taskTitle: title });
    }

    // Department (multi_select)
    const department = props.Department?.multi_select?.map((d: any) => d.name) || [];

    // Due Date
    const dueDate = props["Due Date"]?.date?.start ?? undefined;

    // Project Type (select)
    const projectType = props["Project Type"]?.select?.name ?? undefined;

    // Classification
    const classification = props.Classification?.select?.name ?? undefined;

    // Funnel Stage
    const funnelStage = props["Funnel Stage"]?.select?.name ?? undefined;

    // Description
    const description = extractRichText(props.Description);

    // Federation properties (handle gracefully - may not exist for older tasks)
    const node = props.Node?.select?.name ?? undefined;
    const directory = extractRichText(props.Directory) || undefined;
    const computeRequirements = (props["Compute Requirements"]?.multi_select || [])
      .map((cr: any) => cr.name as ComputeRequirement)
      .filter((cr: ComputeRequirement) => ["GPU", "Voice", "MCP", "Local", "Heavy"].includes(cr));
    const delegatedTo = extractRichText(props["Delegated To"]) || undefined;
    const sourceNode = props["Source Node"]?.select?.name ?? undefined;

    // Assignee (relation — we'll store the first relation ID for now)
    const assigneeRelation = props.Assignee?.relation?.[0]?.id;
    // We could resolve this to a name, but for now store the relation ID or any text fallback
    const assignee = extractRichText(props.Assignee) || undefined;

    // Project relation → local project ID
    const projectRelation = props.Project?.relation?.[0]?.id;
    let projectId = "default";
    if (projectRelation) {
      const localId = notionToLocalProject.get(projectRelation);
      if (localId) {
        projectId = localId;
      } else {
        const localProject = store.getByNotionPageId("projects", projectRelation);
        if (localProject) projectId = (localProject as any).id;
      }
    }

    const phaseText = props.Phase ? extractRichText(props.Phase) : undefined;
    const phaseId =
      phaseText === undefined
        ? undefined
        : phaseText.trim()
          ? resolvePhaseIdFromName(store, projectId, phaseText)
          : null;
    const phasePatch = phaseId !== undefined ? { phaseId } : {};

    // Check if we already have this task by notionPageId
    const existing = store.getByNotionPageId("tasks", nt.id);
    if (existing) {
      await store.updateTask(existing.id, {
        ...phasePatch,
        title,
        description: description || undefined,
        status,
        priority,
        projectId,
        done,
        dueDate,
        department: department.length ? department : undefined,
        priorityLevel,
        projectType,
        classification,
        funnelStage,
        notionId: nt.id,
        assignee,
        // Federation properties
        node: node || undefined,
        directory: directory || undefined,
        computeRequirements: computeRequirements.length ? computeRequirements : undefined,
        delegatedTo: delegatedTo || undefined,
        sourceNode: sourceNode || undefined,
      });
    } else {
      // Also check by LocalId (legacy)
      const localId = extractRichText(props.LocalId);
      const existingById = localId ? (await store.getTasks()).find((t) => t.id === localId) : null;
      if (existingById) {
        await store.updateTask(existingById.id, {
          ...phasePatch,
          title,
          description: description || undefined,
          status,
          priority,
          projectId,
          done,
          dueDate,
          department: department.length ? department : undefined,
          priorityLevel,
          projectType,
          classification,
          funnelStage,
          notionId: nt.id,
          assignee,
          // Federation properties
          node: node || undefined,
          directory: directory || undefined,
          computeRequirements: computeRequirements.length ? computeRequirements : undefined,
          delegatedTo: delegatedTo || undefined,
          sourceNode: sourceNode || undefined,
        });
        store.setNotionPageId("tasks", existingById.id, nt.id);
      } else {
        const newTask = await store.createTask({
          ...phasePatch,
          projectId,
          title,
          description: description || undefined,
          status,
          priority,
          assignee,
          done,
          dueDate,
          department: department.length ? department : undefined,
          priorityLevel,
          projectType,
          classification,
          funnelStage,
          notionId: nt.id,
          // Federation properties
          node: node || undefined,
          directory: directory || undefined,
          computeRequirements: computeRequirements.length ? computeRequirements : undefined,
          delegatedTo: delegatedTo || undefined,
          sourceNode: sourceNode || undefined,
        });
        store.setNotionPageId("tasks", newTask.id, nt.id);
      }
    }
    taskCount++;
  }

  const now = Date.now();
  cfg.lastSyncAt = now;
  saveConfig(cfg);

  log.info("Sync from Notion complete", { projects: projectCount, tasks: taskCount });
  return { projects: projectCount, tasks: taskCount };
}

export async function syncBidirectional(): Promise<{
  pushed: { projects: number; tasks: number };
  pulled: { projects: number; tasks: number };
}> {
  // Push first, then pull (local wins on conflicts since we push first)
  const pushed = await syncToNotion();
  const pulled = await syncFromNotion();
  return { pushed, pulled };
}

// ── Status helper ────────────────────────────────────────

export function getNotionSyncStatus(): {
  configured: boolean;
  apiKeySet: boolean;
  projectsDbId: string | null;
  tasksDbId: string | null;
  parentPageId: string | null;
  lastSyncAt: number | null;
} {
  const cfg = getNotionConfig();
  return {
    configured: !!(cfg.projectsDbId && cfg.tasksDbId && getNotionApiKey()),
    apiKeySet: !!getNotionApiKey(),
    projectsDbId: cfg.projectsDbId,
    tasksDbId: cfg.tasksDbId,
    parentPageId: (cfg as any).parentPageId ?? null,
    lastSyncAt: cfg.lastSyncAt,
  };
}
