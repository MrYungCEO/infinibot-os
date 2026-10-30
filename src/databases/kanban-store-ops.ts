/**
 * Unified, local-first kanban CRUD.
 *
 * Local SQLite is the source of truth. Notion is treated as an optional
 * mirror controlled by `NotionSyncMode` (see `notion-config.ts`). Every
 * caller — agent tool, CLI, gateway RPC handler — should go through this
 * module so the contract is consistent: reads come from the store, writes
 * land in the store first, and the Notion mirror is fired off best-effort
 * after the local commit succeeds.
 *
 * This is the layer that lets users with no Notion at all use the kanban
 * exactly the same way users on the Notion sync layer do.
 */
import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getDatabasesStore, type DatabasesStore } from "./store.js";
import type { DatabaseProperty, DatabaseRecord, DatabaseRow, PropertyValue } from "./types.js";
import {
  getNotionApiKeyOrNull,
  getNotionConfig,
  resolveNotionDbId,
  type NotionSyncMode,
} from "./notion-config.js";
import {
  getNotionOptionSchema,
  invalidateNotionOptionSchema,
  pickSchemaProp,
  readOptionOverrides,
  resolveNotionOption,
  type NotionDbOptionSchema,
} from "./notion-option-map.js";

const log = createSubsystemLogger("kanban-store-ops");

export type KanbanRole = "projects" | "tasks";

export interface KanbanProjectShape {
  id: string;
  name: string;
  description: string;
  status: string;
  priority?: string;
  createdAt: number;
  updatedAt: number;
  // Federation extras carried through both local + remote forms
  primaryNode?: string;
  nodes?: string[];
  nodeIds?: string[];
  projectDirectory?: string;
  shared?: boolean;
  notionId?: string;
  // Cash-flow tracking — surfaced on the Business Command Center KPI strip.
  // Dates are optional; when set they scope the amount to a specific month.
  pendingPay?: number;
  paidAmount?: number;
  pendingPayDate?: string;
  paidAmountDate?: string;
  // Monthly recurring revenue (USD) — manually set on the project header
  // popover. Feeds the Agency Operations MRR statistic. Persisted via the
  // `__mrr` pseudo-value so it round-trips locally without a schema property.
  mrr?: number;
  // Target date (YYYY-MM-DD). Local rows keep it as the `__dueDate`
  // pseudo-value; the mirror writes Notion's "Due Date".
  dueDate?: string;
  // Parent-child hierarchy — null = top-level project
  parentProjectId?: string | null;
  // Active Client Project checkbox — surfaces in Business Command Center
  active?: boolean;
  // Archived (Notion "Archive" checkbox) — hidden from the kanban UI list
  // but still returned by query paths (MCP list_projects, localListProjects).
  archived?: boolean;
}

export interface KanbanTaskShape {
  id: string;
  title: string;
  description: string;
  status: string;
  priority?: string;
  assignee?: string;
  projectId: string | null;
  dueDate?: string;
  done?: boolean;
  createdAt: number;
  updatedAt: number;
  /** Unix ms set on the first transition to status "done". */
  completedAt?: number;
  // Federation extras
  node?: string;
  nodeIds?: string[];
  directory?: string;
  computeRequirements?: string[];
  delegatedTo?: string;
  sourceNode?: string;
  notionId?: string;
  // Agent hand-off state. The Notion path keeps these in its SQLite side
  // table; the local store persists them as pseudo-values so blocked /
  // awaiting-approval / handed-to-agent tasks round-trip on local installs.
  autonomous?: boolean;
  autonomousStatus?: string;
  assignedAgent?: string;
}

/**
 * The kanban API speaks critical|high|medium|low (the Notion path maps these
 * to its Priority Level select), but the local store's Priority select uses
 * the option ids immediate|high|medium|low — an unknown id is dropped. Map the
 * API vocabulary onto the local ids so a "critical" write isn't lost.
 */
const LOCAL_PRIORITY_IDS: Record<string, string> = {
  critical: "immediate",
  urgent: "immediate",
  normal: "medium",
};

export interface UpsertOptions {
  /** When false, skip the Notion mirror even if sync is enabled (used for one-shot imports). */
  syncToNotion?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────

/**
 * Resolve the database currently bound to a kanban role. Falls back to the
 * built-in `kanban-projects` / `kanban-tasks` stub if no override is set.
 * Also forces creation of the stubs on first call so a brand-new install has
 * something to read/write immediately.
 */
export function resolveKanbanDatabase(role: KanbanRole): {
  store: DatabasesStore;
  database: DatabaseRecord;
} {
  const store = getDatabasesStore();
  const resolved = store.resolveSystemRole(role);
  if (resolved?.database) {
    return { store, database: resolved.database };
  }
  // Last-resort: the seed in `getDatabasesStore` should have created these.
  // If it didn't (e.g. user wiped the system_databases table), re-seed.
  const fallback = store.getDatabaseBySource(
    role === "projects" ? "kanban-projects" : "kanban-tasks",
  );
  if (!fallback) {
    throw new Error(`Kanban ${role} database not found — store seed is in an inconsistent state`);
  }
  return { store, database: fallback };
}

// ─────────────────────────────────────────────────────────────────────────
// Property helpers
// ─────────────────────────────────────────────────────────────────────────

function findProp(props: DatabaseProperty[], name: string): DatabaseProperty | undefined {
  const lower = name.toLowerCase();
  return props.find((p) => p.name.toLowerCase() === lower);
}

function optionIdFor(
  prop: DatabaseProperty | undefined,
  value: string | undefined | null,
): string | null {
  if (!prop || !value) return null;
  const lower = value.toLowerCase();
  const opt = prop.config?.options?.find((o) => o.name.toLowerCase() === lower || o.id === value);
  return opt?.id ?? null;
}

/**
 * Read a status/select property and return the canonical option id.
 *
 * `readProp` returns the option NAME (e.g. "To Do") because that's what the
 * project UI wants to display. The kanban-tasks UI filters tasks by the
 * lowercase TaskStatus id ("todo", "in_progress", "review", "done") and
 * the seed in store.ts:1167 was crafted so option ids match those values
 * 1:1. Returning the id from this helper keeps `taskFromRow` aligned with
 * the UI's column filter without changing the on-disk shape. Without
 * this, every locally-created task came back with status "To Do" (the
 * display label), so the column filter `t.status === "todo"` rejected
 * everything and /projects boards looked empty.
 */
function readSelectId(row: DatabaseRow, props: DatabaseProperty[], name: string): string | null {
  const prop = findProp(props, name);
  if (!prop) return null;
  const v = row.values[prop.id];
  if (!v) return null;
  if (v.type === "select" || v.type === "status") return v.optionId ?? null;
  return null;
}

function readProp(row: DatabaseRow, props: DatabaseProperty[], name: string): string | null {
  const prop = findProp(props, name);
  if (!prop) return null;
  const v = row.values[prop.id];
  if (!v) return null;
  switch (v.type) {
    case "title":
      return v.text;
    case "richText":
      return v.markdown;
    case "select":
    case "status": {
      if (!v.optionId) return null;
      const opt = prop.config?.options?.find((o) => o.id === v.optionId);
      return opt?.name ?? v.optionId;
    }
    case "multiSelect":
      return v.optionIds
        .map((id) => prop.config?.options?.find((o) => o.id === id)?.name ?? id)
        .join(", ");
    case "date":
      return v.iso;
    case "checkbox":
      return v.checked ? "true" : "false";
    case "url":
      return v.url;
    case "phone":
      return v.phone;
    case "email":
      return v.email;
    case "relation":
      return v.rowIds[0] ?? null;
    case "person":
      return v.personIds[0] ?? null;
    default:
      return null;
  }
}

function readMultiSelect(row: DatabaseRow, props: DatabaseProperty[], name: string): string[] {
  const prop = findProp(props, name);
  if (!prop) return [];
  const v = row.values[prop.id];
  if (v?.type !== "multiSelect") return [];
  return v.optionIds.map((id) => prop.config?.options?.find((o) => o.id === id)?.name ?? id);
}

function readCheckbox(row: DatabaseRow, props: DatabaseProperty[], name: string): boolean {
  const prop = findProp(props, name);
  if (!prop) return false;
  const v = row.values[prop.id];
  return v?.type === "checkbox" ? v.checked : false;
}

function readRelationFirst(
  row: DatabaseRow,
  props: DatabaseProperty[],
  name: string,
): string | null {
  const prop = findProp(props, name);
  if (!prop) return null;
  const v = row.values[prop.id];
  return v?.type === "relation" ? (v.rowIds[0] ?? null) : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Patch building
// ─────────────────────────────────────────────────────────────────────────

interface BuildPatchInput {
  properties: DatabaseProperty[];
  fields: Record<string, unknown>;
}

function buildValuesPatch({ properties, fields }: BuildPatchInput): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};

  for (const [fieldName, raw] of Object.entries(fields)) {
    if (raw === undefined) continue;
    const prop = findProp(properties, fieldName);
    if (!prop) continue;

    switch (prop.type) {
      case "title": {
        out[prop.id] = { type: "title", text: String(raw ?? "") };
        break;
      }
      case "richText": {
        out[prop.id] = { type: "richText", markdown: String(raw ?? "") };
        break;
      }
      case "select": {
        const id = typeof raw === "string" ? optionIdFor(prop, raw) : null;
        out[prop.id] = { type: "select", optionId: id };
        break;
      }
      case "status": {
        const id = typeof raw === "string" ? optionIdFor(prop, raw) : null;
        out[prop.id] = { type: "status", optionId: id };
        break;
      }
      case "multiSelect": {
        const arr = Array.isArray(raw) ? raw : [];
        const ids = arr
          .map((name) => optionIdFor(prop, typeof name === "string" ? name : null))
          .filter((id): id is string => !!id);
        out[prop.id] = { type: "multiSelect", optionIds: ids };
        break;
      }
      case "date": {
        out[prop.id] = { type: "date", iso: typeof raw === "string" ? raw : null };
        break;
      }
      case "checkbox": {
        out[prop.id] = { type: "checkbox", checked: !!raw };
        break;
      }
      case "url": {
        out[prop.id] = { type: "url", url: typeof raw === "string" ? raw : null };
        break;
      }
      case "phone": {
        out[prop.id] = { type: "phone", phone: typeof raw === "string" ? raw : null };
        break;
      }
      case "email": {
        out[prop.id] = { type: "email", email: typeof raw === "string" ? raw : null };
        break;
      }
      case "relation": {
        if (typeof raw === "string") {
          out[prop.id] = { type: "relation", rowIds: raw ? [raw] : [] };
        } else if (Array.isArray(raw)) {
          out[prop.id] = {
            type: "relation",
            rowIds: raw.filter((x): x is string => typeof x === "string"),
          };
        }
        break;
      }
      case "person": {
        if (typeof raw === "string") {
          out[prop.id] = { type: "person", personIds: raw ? [raw] : [] };
        } else if (Array.isArray(raw)) {
          out[prop.id] = {
            type: "person",
            personIds: raw.filter((x): x is string => typeof x === "string"),
          };
        }
        break;
      }
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Public read API
// ─────────────────────────────────────────────────────────────────────────

export function listProjects(filter?: {
  active?: boolean;
  businessId?: string;
}): KanbanProjectShape[] {
  const { store, database } = resolveKanbanDatabase("projects");
  const properties = store.listProperties(database.id);
  const rows = store.listRows(database.id);
  let projects = rows.map((row) => projectFromRow(row, properties));
  if (filter?.active !== undefined) {
    projects = projects.filter((p) => (p.active ?? false) === filter.active);
  }
  if (filter?.businessId !== undefined) {
    projects = projects.filter((p) => (p as any).businessId === filter.businessId);
  }
  return projects;
}

export function listTasks(filter?: {
  projectId?: string;
  status?: string;
  assignee?: string;
  node?: string;
}): KanbanTaskShape[] {
  const { store, database } = resolveKanbanDatabase("tasks");
  const properties = store.listProperties(database.id);
  let tasks = store.listRows(database.id).map((row) => taskFromRow(row, properties));

  if (filter?.projectId) {
    tasks = tasks.filter((t) => t.projectId === filter.projectId);
  }
  if (filter?.status) {
    tasks = tasks.filter((t) => String(t.status).toLowerCase() === filter.status!.toLowerCase());
  }
  if (filter?.assignee) {
    tasks = tasks.filter((t) =>
      (t.assignee ?? "").toLowerCase().includes(filter.assignee!.toLowerCase()),
    );
  }
  if (filter?.node) {
    tasks = tasks.filter((t) => t.node === filter.node);
  }
  return tasks;
}

export function getProject(id: string): KanbanProjectShape | null {
  const { store, database } = resolveKanbanDatabase("projects");
  const row = store.getRow(id);
  if (!row || row.databaseId !== database.id) return null;
  const properties = store.listProperties(database.id);
  return projectFromRow(row, properties);
}

export function getTask(id: string): KanbanTaskShape | null {
  const { store, database } = resolveKanbanDatabase("tasks");
  const row = store.getRow(id);
  if (!row || row.databaseId !== database.id) return null;
  const properties = store.listProperties(database.id);
  return taskFromRow(row, properties);
}

// ─────────────────────────────────────────────────────────────────────────
// Public write API
// ─────────────────────────────────────────────────────────────────────────

export function upsertProject(
  patch: Partial<KanbanProjectShape> & { name?: string },
  opts: UpsertOptions = {},
): KanbanProjectShape {
  const { store, database } = resolveKanbanDatabase("projects");
  const properties = store.listProperties(database.id);

  const fields: Record<string, unknown> = {};
  if (patch.name !== undefined) fields.Name = patch.name;
  if (patch.status !== undefined) fields.Status = patch.status;
  if (patch.priority !== undefined) fields.Priority = patch.priority;
  if (patch.description !== undefined) fields.Description = patch.description;
  if (patch.primaryNode !== undefined) fields["Primary Node"] = patch.primaryNode;
  if (patch.nodes !== undefined) fields.Nodes = patch.nodes;
  if (patch.projectDirectory !== undefined) fields["Project Directory"] = patch.projectDirectory;
  if (patch.shared !== undefined) fields.Shared = patch.shared;

  const extraProjectValues: Record<string, import("./types.js").PropertyValue> = {};
  if (patch.nodeIds !== undefined) {
    extraProjectValues["__nodeIds"] = {
      type: "richText",
      markdown: JSON.stringify(patch.nodeIds ?? []),
    };
  }
  // MRR has no seeded schema property, so persist it as a pseudo-value the
  // same way nodeIds is — this makes it round-trip locally on refresh.
  // Seeded local schemas have no "Project Directory" property (only the
  // Notion one does) — keep the directory as a pseudo-value so a repo
  // binding round-trips on local-only installs too.
  if (
    patch.projectDirectory !== undefined &&
    !properties.some((p) => p.name === "Project Directory")
  ) {
    extraProjectValues["__projectDirectory"] = {
      type: "richText",
      markdown: JSON.stringify(patch.projectDirectory || null),
    };
  }
  if (patch.mrr !== undefined) {
    extraProjectValues["__mrr"] = {
      type: "richText",
      markdown: JSON.stringify(patch.mrr ?? null),
    };
  }
  if (patch.dueDate !== undefined) {
    extraProjectValues["__dueDate"] = {
      type: "richText",
      markdown: JSON.stringify(patch.dueDate || null),
    };
  }
  if (patch.pendingPay !== undefined) fields["Pending Pay"] = patch.pendingPay;
  if (patch.paidAmount !== undefined) fields["Paid Amount"] = patch.paidAmount;
  if (patch.pendingPayDate !== undefined) fields["Pending Pay Date"] = patch.pendingPayDate;
  if (patch.paidAmountDate !== undefined) fields["Paid Amount Date"] = patch.paidAmountDate;
  if (patch.parentProjectId !== undefined) fields["Parent Project"] = patch.parentProjectId;
  if (patch.active !== undefined) fields["Active Client Project"] = patch.active;
  if (patch.archived !== undefined) fields["Archive"] = patch.archived;

  const mirror = opts.syncToNotion !== false && shouldMirror().ok;
  const values = {
    ...buildValuesPatch({ properties, fields }),
    ...extraProjectValues,
    // Flag the write as owed to Notion *before* the mirror runs so it
    // survives a crash/restart and shows on the board while Notion is down.
    ...(mirror ? { [NOTION_PENDING_KEY]: PENDING_ON, [NOTION_ERROR_KEY]: ERROR_OFF } : {}),
  };

  const row = store.upsertRow({
    id: patch.id,
    databaseId: database.id,
    title: patch.name,
    body: patch.description ?? null,
    values,
  });

  const project = projectFromRow(row, properties);
  if (mirror) queueMirror("project", project.id);
  return project;
}

export function upsertTask(
  patch: Partial<KanbanTaskShape> & { title?: string },
  opts: UpsertOptions = {},
): KanbanTaskShape {
  const { store, database } = resolveKanbanDatabase("tasks");
  const properties = store.listProperties(database.id);

  const fields: Record<string, unknown> = {};
  if (patch.title !== undefined) fields.Name = patch.title;
  if (patch.status !== undefined) fields.Status = patch.status;
  if (patch.priority !== undefined) {
    fields.Priority = LOCAL_PRIORITY_IDS[String(patch.priority).toLowerCase()] ?? patch.priority;
  }
  if (patch.description !== undefined) fields.Description = patch.description;
  if (patch.projectId !== undefined) fields.Project = patch.projectId;
  if (patch.assignee !== undefined) fields.Assignee = patch.assignee;
  if (patch.dueDate !== undefined) fields.Due = patch.dueDate;

  const extraTaskValues: Record<string, import("./types.js").PropertyValue> = {};
  if (patch.nodeIds !== undefined) {
    extraTaskValues["__nodeIds"] = {
      type: "richText",
      markdown: JSON.stringify(patch.nodeIds ?? []),
    };
  }
  for (const key of ["autonomous", "autonomousStatus", "assignedAgent"] as const) {
    if (patch[key] !== undefined) {
      extraTaskValues[`__${key}`] = {
        type: "richText",
        markdown: JSON.stringify(patch[key] ?? null),
      };
    }
  }

  const mirror = opts.syncToNotion !== false && shouldMirror().ok;
  const values = {
    ...buildValuesPatch({ properties, fields }),
    ...extraTaskValues,
    ...(mirror ? { [NOTION_PENDING_KEY]: PENDING_ON, [NOTION_ERROR_KEY]: ERROR_OFF } : {}),
  };

  // Set completedAt on first transition to "done"; never clear once set.
  const isDone = patch.status === "done" || patch.done === true;
  const existingRow = patch.id ? store.getRow(patch.id) : undefined;
  const prevTask = existingRow ? taskFromRow(existingRow, properties) : null;
  const alreadyCompleted = existingRow?.completedAt;
  const completedAt = isDone && !alreadyCompleted ? Date.now() : (alreadyCompleted ?? undefined);

  const row = store.upsertRow({
    id: patch.id,
    databaseId: database.id,
    title: patch.title,
    body: patch.description ?? null,
    values,
    completedAt: completedAt ?? null,
  });

  const task = taskFromRow(row, properties);

  // Emit completion event on first-ever done transition
  if (isDone && !alreadyCompleted) {
    import("../infra/work-completions.js")
      .then(({ emitWorkCompleted }) => {
        emitWorkCompleted({
          source: "kanban",
          sourceId: task.id,
          title: task.title,
          completedAt: completedAt!,
        });
      })
      .catch(() => {});

    // Push notification: task marked done
    void import("../notifications/emit.js")
      .then(({ emitNotification }) => {
        const projectName = task.projectId ? (getProject(task.projectId)?.name ?? null) : null;
        const body = [task.title, projectName].filter(Boolean).join(" • ");
        return emitNotification({
          category: "kanban.task.completed",
          severity: "success",
          title: "✓ Task done",
          body,
          source: "kanban",
          sourceId: task.id,
          deepLink: `infinibot://board/task/${task.id}`,
          data: {
            taskId: task.id,
            projectId: task.projectId,
            projectName: projectName ?? undefined,
            title: task.title,
            status: task.status,
            priority: task.priority,
          },
        });
      })
      .catch(() => {});
  }

  // Push notification: new assignment (assignee set for first time, or changed)
  const isNewAssignment =
    patch.assignee &&
    typeof patch.assignee === "string" &&
    patch.assignee !== (prevTask?.assignee ?? "");
  if (isNewAssignment) {
    void import("../notifications/emit.js")
      .then(({ emitNotification }) => {
        const projectName = task.projectId ? (getProject(task.projectId)?.name ?? null) : null;
        const priority = task.priority ?? "medium";
        const parts = [task.title, projectName, priority].filter(Boolean);
        return emitNotification({
          category: "kanban.task.assigned",
          severity: "info",
          title: "📋 New task for you",
          body: parts.join(" • "),
          source: "kanban",
          sourceId: task.id,
          deepLink: `infinibot://board/task/${task.id}`,
          data: {
            taskId: task.id,
            projectId: task.projectId,
            projectName: projectName ?? undefined,
            title: task.title,
            status: task.status,
            priority,
            assignee: task.assignee,
          },
        });
      })
      .catch(() => {});
  }

  if (mirror) queueMirror("task", task.id);
  return task;
}

export function deleteProject(id: string): boolean {
  const { store, database } = resolveKanbanDatabase("projects");
  const row = store.getRow(id);
  if (!row || row.databaseId !== database.id) return false;
  const ok = store.deleteRow(id);
  if (ok) {
    void archiveNotionPage(row.externalRef?.externalId ?? null).catch((err) => {
      log.warn("notion archive failed", { error: (err as Error).message });
    });
  }
  return ok;
}

export function deleteTask(id: string): boolean {
  const { store, database } = resolveKanbanDatabase("tasks");
  const row = store.getRow(id);
  if (!row || row.databaseId !== database.id) return false;
  const ok = store.deleteRow(id);
  if (ok) {
    void archiveNotionPage(row.externalRef?.externalId ?? null).catch((err) => {
      log.warn("notion archive failed", { error: (err as Error).message });
    });
  }
  return ok;
}

// ─────────────────────────────────────────────────────────────────────────
// Row → public shape
// ─────────────────────────────────────────────────────────────────────────

function readPseudoJsonArray(row: DatabaseRow, key: string): string[] | undefined {
  const v = row.values[key];
  if (!v || v.type !== "richText") return undefined;
  const raw = v.markdown;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function readPseudoJsonString(row: DatabaseRow, key: string): string | undefined {
  const v = row.values[key];
  if (!v || v.type !== "richText" || !v.markdown) return undefined;
  try {
    const parsed = JSON.parse(v.markdown);
    return typeof parsed === "string" && parsed ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readPseudoJsonNumber(row: DatabaseRow, key: string): number | undefined {
  const v = row.values[key];
  if (!v || v.type !== "richText") return undefined;
  const raw = v.markdown;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function projectFromRow(row: DatabaseRow, props: DatabaseProperty[]): KanbanProjectShape {
  const pending = readProp(row, props, "Pending Pay");
  const paid = readProp(row, props, "Paid Amount");
  return {
    id: row.id,
    name: row.title,
    description: row.body ?? readProp(row, props, "Description") ?? "",
    status: readProp(row, props, "Status") ?? "Not started",
    priority: readProp(row, props, "Priority") ?? undefined,
    primaryNode: readProp(row, props, "Primary Node") ?? undefined,
    nodes: readMultiSelect(row, props, "Nodes"),
    nodeIds: readPseudoJsonArray(row, "__nodeIds"),
    projectDirectory:
      readProp(row, props, "Project Directory") ||
      readPseudoJsonString(row, "__projectDirectory") ||
      undefined,
    shared: readCheckbox(row, props, "Shared"),
    pendingPay: pending == null || pending === "" ? undefined : Number(pending),
    paidAmount: paid == null || paid === "" ? undefined : Number(paid),
    pendingPayDate: readProp(row, props, "Pending Pay Date") ?? undefined,
    paidAmountDate: readProp(row, props, "Paid Amount Date") ?? undefined,
    mrr: readPseudoJsonNumber(row, "__mrr"),
    dueDate: readPseudoJsonString(row, "__dueDate"),
    parentProjectId: readRelationFirst(row, props, "Parent Project") ?? null,
    active: readCheckbox(row, props, "Active Client Project"),
    archived: readCheckbox(row, props, "Archive"),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    notionId: row.externalRef?.externalId,
  };
}

function taskFromRow(row: DatabaseRow, props: DatabaseProperty[]): KanbanTaskShape {
  return {
    id: row.id,
    title: row.title,
    description: row.body ?? readProp(row, props, "Description") ?? "",
    // Status/Priority: read the option id, not the display label. The kanban
    // UI columns filter by `task.status === "todo" | "in_progress" | …` and
    // the priority gallery filter expects "high" | "low" | "normal" — both
    // match the option ids the seed in store.ts wrote, but not the names.
    status: readSelectId(row, props, "Status") ?? "todo",
    priority: readSelectId(row, props, "Priority") ?? "medium",
    assignee: readProp(row, props, "Assignee") ?? undefined,
    projectId: readRelationFirst(row, props, "Project"),
    dueDate: readProp(row, props, "Due") ?? undefined,
    done: readCheckbox(row, props, "Done"),
    completedAt: row.completedAt,
    node: readProp(row, props, "Node") ?? undefined,
    nodeIds: readPseudoJsonArray(row, "__nodeIds"),
    directory: readProp(row, props, "Directory") ?? undefined,
    computeRequirements: readMultiSelect(row, props, "Compute Requirements"),
    delegatedTo: readProp(row, props, "Delegated To") ?? undefined,
    sourceNode: readProp(row, props, "Source Node") ?? undefined,
    autonomous: readPseudoJson<boolean>(row, "__autonomous") ?? undefined,
    autonomousStatus: readPseudoJson<string>(row, "__autonomousStatus") ?? undefined,
    assignedAgent: readPseudoJson<string>(row, "__assignedAgent") ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    notionId: row.externalRef?.externalId,
  };
}

function readPseudoJson<T>(row: DatabaseRow, key: string): T | null | undefined {
  const v = row.values[key];
  if (!v || v.type !== "richText" || !v.markdown) return undefined;
  try {
    return JSON.parse(v.markdown) as T | null;
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Notion mirror — runs only when sync mode is `mirror` and the API key works.
// All errors are swallowed at the caller level; the local commit already
// succeeded.
// ─────────────────────────────────────────────────────────────────────────

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
/** Background mirror calls give up after this long and retry later. */
const NOTION_MIRROR_TIMEOUT_MS = 15_000;

function shouldMirror(): { ok: true; apiKey: string } | { ok: false } {
  const cfg = getNotionConfig();
  const apiKey = getNotionApiKeyOrNull();
  if (cfg.syncMode !== "mirror" || !apiKey) return { ok: false };
  return { ok: true, apiKey };
}

async function notionFetch(apiKey: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${NOTION_API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(NOTION_MIRROR_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new NotionHttpError(
      res.status,
      (body as any)?.code ?? null,
      `Notion API ${res.status}: ${(body as any)?.message ?? JSON.stringify(body)}`,
    );
  }
  return body;
}

/** A Notion HTTP error that keeps the status + Notion error code for triage. */
export class NotionHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "NotionHttpError";
  }
}

/**
 * Permanent = retrying the same request can never succeed (bad property
 * value, page deleted/unshared). Everything else — network, timeouts, 409,
 * 429, 5xx, and auth (401/403, fixable by the operator without touching the
 * row) — is transient and retried with backoff.
 */
export function classifyNotionError(err: unknown): "permanent" | "transient" {
  const status =
    err instanceof NotionHttpError
      ? err.status
      : Number(/Notion(?: API)? (\d{3})\b/.exec(String((err as Error)?.message ?? err))?.[1] ?? 0);
  if (status === 400 || status === 404 || status === 422) return "permanent";
  return "transient";
}

/**
 * Set a status/select property only when the value maps onto an option the
 * Notion DB really has (see notion-option-map.ts). Unmappable values are
 * omitted rather than sent — a bad status name is a permanent 400 and a bad
 * select name would create a junk option.
 */
function setOptionProp(
  properties: Record<string, unknown>,
  schema: NotionDbOptionSchema,
  candidates: readonly string[],
  localValue: string | null | undefined,
  overrides: Record<string, string>,
): void {
  if (localValue == null || localValue === "") return;
  const prop = pickSchemaProp(schema, candidates);
  if (!prop) return;
  const { name } = resolveNotionOption(prop, localValue, overrides);
  if (!name) return;
  if (prop.type === "status") properties[prop.name] = { status: { name } };
  else if (prop.type === "select") properties[prop.name] = { select: { name } };
  else properties[prop.name] = { multi_select: [{ name }] };
}

async function mirrorProjectToNotion(
  project: KanbanProjectShape,
  source: "kanban-projects",
): Promise<void> {
  const gate = shouldMirror();
  if (!gate.ok) return;
  const dbId = resolveNotionDbId(source);
  if (!dbId) return;

  const properties: Record<string, unknown> = {
    Project: { title: [{ text: { content: project.name } }] },
  };
  if (project.description) {
    properties.Description = { rich_text: [{ text: { content: project.description } }] };
  }
  const projSchema = await getNotionOptionSchema(gate.apiKey, dbId);
  const projOverrides = readOptionOverrides().projects ?? {};
  setOptionProp(properties, projSchema, ["Status"], project.status, projOverrides);
  setOptionProp(properties, projSchema, ["Priority"], project.priority, projOverrides);
  if (project.archived !== undefined) {
    properties.Archive = { checkbox: project.archived };
  }
  if (project.dueDate) properties["Due Date"] = { date: { start: project.dueDate } };
  // Write parent relation when present and the parent has a Notion page id.
  if (project.parentProjectId) {
    const parentRow = resolveKanbanDatabase("projects").store.getRow(project.parentProjectId);
    const parentNotionId = parentRow?.externalRef?.externalId ?? project.parentProjectId;
    if (parentNotionId) {
      properties["Parent Project"] = { relation: [{ id: parentNotionId }] };
    }
  }

  // Clients relation — round-trip the local relations store through
  // Notion's "Clients" relation property when both sides exist. If
  // none of the linked clients have a Notion page id, we still send
  // an empty array so a previously-linked client cleared locally
  // gets cleared on Notion too.
  try {
    const { buildProjectClientsRelationProperty } = await import("./notion-relation-bridge.js");
    const clientsRel = buildProjectClientsRelationProperty(project.id);
    if (clientsRel) properties.Clients = clientsRel;
  } catch {
    /* relation bridge is best-effort */
  }

  if (project.notionId) {
    await notionFetch(gate.apiKey, `/pages/${project.notionId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });
  } else {
    const created = (await notionFetch(gate.apiKey, "/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { database_id: dbId },
        properties,
      }),
    })) as { id: string };
    // Persist the externalRef so we can update in place next time.
    const { store } = resolveKanbanDatabase("projects");
    store.upsertRow({
      id: project.id,
      databaseId: store.getRow(project.id)!.databaseId,
      externalRef: {
        system: "notion",
        externalId: created.id,
        lastSyncedAt: Date.now(),
      },
    });
  }
}

async function mirrorTaskToNotion(task: KanbanTaskShape, source: "kanban-tasks"): Promise<void> {
  const gate = shouldMirror();
  if (!gate.ok) return;
  const dbId = resolveNotionDbId(source);
  if (!dbId) return;

  const properties: Record<string, unknown> = {
    "Task Name": { title: [{ text: { content: task.title } }] },
  };
  const taskSchema = await getNotionOptionSchema(gate.apiKey, dbId);
  const taskOverrides = readOptionOverrides().tasks ?? {};
  setOptionProp(properties, taskSchema, ["Status Update", "Status"], task.status, taskOverrides);
  setOptionProp(
    properties,
    taskSchema,
    ["Priority Level", "Priority"],
    task.priority,
    taskOverrides,
  );
  if (task.dueDate) properties["Due Date"] = { date: { start: task.dueDate } };
  if (task.projectId) {
    // Project relation needs the Notion page id — look it up if we have one.
    const { store } = resolveKanbanDatabase("projects");
    const projectRow = store.getRow(task.projectId);
    // A task created against a Notion-backed project carries the Notion page
    // id directly (there is no local row for it).
    const projectNotionId =
      projectRow?.externalRef?.externalId ??
      (!projectRow && looksLikeNotionId(task.projectId) ? task.projectId : null);
    if (projectNotionId) {
      properties.Project = {
        relation: [{ id: projectNotionId }],
      };
    }
  }

  if (task.notionId) {
    await notionFetch(gate.apiKey, `/pages/${task.notionId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });
  } else {
    const created = (await notionFetch(gate.apiKey, "/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { database_id: dbId },
        properties,
      }),
    })) as { id: string };
    const { store } = resolveKanbanDatabase("tasks");
    store.upsertRow({
      id: task.id,
      databaseId: store.getRow(task.id)!.databaseId,
      externalRef: {
        system: "notion",
        externalId: created.id,
        lastSyncedAt: Date.now(),
      },
    });
  }
}

async function archiveNotionPage(pageId: string | null): Promise<void> {
  if (!pageId) return;
  const gate = shouldMirror();
  if (!gate.ok) return;
  await notionFetch(gate.apiKey, `/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: true }),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Notion outbox — every mirrored write is flagged `__notionSyncPending` in
// the same SQLite write as the data itself, mirrored in the background, and
// the flag is cleared only once Notion accepts it. Failures (no network,
// 429, 5xx, timeout, revoked key) leave the flag set and schedule a retry
// with backoff; the persisted flag means a restart picks the work back up.
// Nothing here ever runs in a request path or surfaces an error to the user.
// ─────────────────────────────────────────────────────────────────────────

export const NOTION_PENDING_KEY = "__notionSyncPending";
/**
 * Dead-letter marker: set (JSON `{reason, at, attempts}`) when Notion
 * permanently rejected this row's mirror (e.g. an option the DB doesn't
 * have, a deleted page). The pending flag is cleared at the same time so the
 * outbox stops hammering Notion; the row shows up under "needs attention"
 * until the next local edit or an explicit retry.
 */
export const NOTION_ERROR_KEY = "__notionSyncError";
const PENDING_ON: PropertyValue = { type: "richText", markdown: "1" };
const PENDING_OFF: PropertyValue = { type: "richText", markdown: "" };
const ERROR_OFF: PropertyValue = { type: "richText", markdown: "" };
/** Exported for tests. */
export const NOTION_OUTBOX_RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000];
/** ±20% jitter so many installs (or many rows) don't retry in lockstep. */
export const NOTION_OUTBOX_JITTER = 0.2;

type MirrorKind = "project" | "task";

const mirrorInflight = new Map<string, { rerun: boolean; done: Promise<void> }>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let retryDueAt = 0;
let lastMirrorError: { at: number; message: string } | null = null;
let lastMirrorOkAt: number | null = null;
/** Outbox health as last logged — we only log on transitions. */
let outboxState: "ok" | "failing" = "ok";
let outboxFailuresSinceOk = 0;
let randomFn: () => number = Math.random;

function isPendingRow(row: DatabaseRow | undefined | null): boolean {
  const v = row?.values?.[NOTION_PENDING_KEY];
  return !!v && v.type === "richText" && v.markdown === "1";
}

interface DeadLetter {
  reason: string;
  at: number;
  attempts: number;
}

function readDeadLetter(row: DatabaseRow | undefined | null): DeadLetter | null {
  const v = row?.values?.[NOTION_ERROR_KEY];
  if (!v || v.type !== "richText" || !v.markdown) return null;
  try {
    const parsed = JSON.parse(v.markdown) as DeadLetter;
    return parsed && typeof parsed.reason === "string" ? parsed : null;
  } catch {
    return { reason: v.markdown, at: 0, attempts: 1 };
  }
}

export function looksLikeNotionId(id: string | null | undefined): boolean {
  if (!id) return false;
  return /^[0-9a-f]{32}$/i.test(id.replace(/-/g, ""));
}

async function mirrorRowOnce(kind: MirrorKind, id: string): Promise<void> {
  if (kind === "project") {
    const project = getProject(id);
    if (!project) return;
    await mirrorProjectToNotion(project, "kanban-projects");
  } else {
    const task = getTask(id);
    if (!task) return;
    await mirrorTaskToNotion(task, "kanban-tasks");
  }
}

function noteOutboxOk(): void {
  lastMirrorOkAt = Date.now();
  lastMirrorError = null;
  if (outboxState === "failing") {
    log.info("notion mirror recovered; catching up queued writes", {
      failuresWhileDown: outboxFailuresSinceOk,
    });
  }
  outboxState = "ok";
  outboxFailuresSinceOk = 0;
}

function noteOutboxTransientFailure(err: unknown): void {
  const message = (err as Error)?.message ?? String(err);
  lastMirrorError = { at: Date.now(), message };
  outboxFailuresSinceOk++;
  if (outboxState === "ok") {
    outboxState = "failing";
    log.warn("notion mirror unavailable; writes stay local and retry with backoff", {
      error: message,
    });
  }
}

async function mirrorOnce(kind: MirrorKind, id: string): Promise<void> {
  if (!shouldMirror().ok) return;
  const role: KanbanRole = kind === "project" ? "projects" : "tasks";
  const { store } = resolveKanbanDatabase(role);
  try {
    try {
      await mirrorRowOnce(kind, id);
    } catch (err) {
      // A validation 400 may just mean the DB's options changed since we
      // cached its schema — refresh once and retry before giving up.
      if (classifyNotionError(err) !== "permanent" || !/option|validation/i.test(String(err))) {
        throw err;
      }
      invalidateNotionOptionSchema();
      await mirrorRowOnce(kind, id);
    }
    const row = store.getRow(id);
    if (row && (isPendingRow(row) || readDeadLetter(row))) {
      store.upsertRow({
        id,
        databaseId: row.databaseId,
        values: { [NOTION_PENDING_KEY]: PENDING_OFF, [NOTION_ERROR_KEY]: ERROR_OFF },
      });
    }
    noteOutboxOk();
    closeNotionCircuit();
  } catch (err) {
    if (classifyNotionError(err) === "permanent") {
      // Dead-letter: stop retrying, keep the row local, surface the reason.
      const row = store.getRow(id);
      const prev = readDeadLetter(row);
      const reason = ((err as Error)?.message ?? String(err)).slice(0, 500);
      if (row) {
        store.upsertRow({
          id,
          databaseId: row.databaseId,
          values: {
            [NOTION_PENDING_KEY]: PENDING_OFF,
            [NOTION_ERROR_KEY]: {
              type: "richText",
              markdown: JSON.stringify({
                reason,
                at: Date.now(),
                attempts: (prev?.attempts ?? 0) + 1,
              } satisfies DeadLetter),
            },
          },
        });
      }
      log.warn("notion mirror rejected permanently; row needs attention (not retrying)", {
        kind,
        id,
        error: reason,
      });
      return;
    }
    tripNotionCircuit(err);
    noteOutboxTransientFailure(err);
    scheduleNotionOutboxRetry();
  }
}

/**
 * Mirror one row. Concurrent calls for the same row coalesce into a single
 * in-flight run plus at most one re-run, so a create immediately followed by
 * an update can never create two Notion pages.
 */
function runMirror(kind: MirrorKind, id: string): Promise<void> {
  const key = `${kind}:${id}`;
  const current = mirrorInflight.get(key);
  if (current) {
    current.rerun = true;
    return current.done;
  }
  const state = { rerun: false, done: Promise.resolve() };
  state.done = (async () => {
    try {
      do {
        state.rerun = false;
        await mirrorOnce(kind, id);
      } while (state.rerun);
    } finally {
      mirrorInflight.delete(key);
    }
  })();
  mirrorInflight.set(key, state);
  return state.done;
}

/**
 * Fire-and-forget mirror for a freshly written row. While the circuit is open
 * (Notion known to be down) don't start another doomed call per write — the
 * row is already flagged pending, so just make sure a retry is scheduled.
 */
function queueMirror(kind: MirrorKind, id: string): void {
  if (isNotionCircuitOpen()) {
    scheduleNotionOutboxRetry();
    return;
  }
  void runMirror(kind, id);
}

function pendingRowIds(role: KanbanRole): string[] {
  const { store, database } = resolveKanbanDatabase(role);
  return store
    .listRows(database.id)
    .filter(isPendingRow)
    .map((r) => r.id);
}

/**
 * Push every pending row to Notion (projects first so task → project
 * relations resolve). Stops early once Notion is known to be down so an
 * outage costs one failed call per retry, not one per queued row. Returns how
 * many rows are still pending afterwards.
 */
export async function flushNotionOutbox(): Promise<number> {
  if (!shouldMirror().ok) return 0;
  closeNotionCircuit();
  for (const role of ["projects", "tasks"] as const) {
    const { store } = resolveKanbanDatabase(role);
    for (const id of pendingRowIds(role)) {
      if (isNotionCircuitOpen()) break;
      // Re-check right before pushing: the flag may have been cleared since
      // the list was taken (operator backlog clear, dead-letter, a delete).
      if (!isPendingRow(store.getRow(id))) continue;
      await runMirror(role === "projects" ? "project" : "task", id);
    }
  }
  return pendingRowIds("projects").length + pendingRowIds("tasks").length;
}

/** Backoff delay for the given attempt, with ±NOTION_OUTBOX_JITTER jitter. */
export function outboxRetryDelay(attempt: number): number {
  const base =
    NOTION_OUTBOX_RETRY_DELAYS_MS[Math.min(attempt, NOTION_OUTBOX_RETRY_DELAYS_MS.length - 1)]!;
  const factor = 1 - NOTION_OUTBOX_JITTER + randomFn() * 2 * NOTION_OUTBOX_JITTER;
  return Math.round(base * factor);
}

export function scheduleNotionOutboxRetry(delayMs?: number): void {
  if (retryTimer) return;
  const delay = delayMs ?? outboxRetryDelay(retryAttempt);
  retryAttempt++;
  retryDueAt = Date.now() + delay;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flushNotionOutbox()
      .then((remaining) => {
        if (remaining > 0) scheduleNotionOutboxRetry();
        else retryAttempt = 0;
      })
      .catch(() => scheduleNotionOutboxRetry());
  }, delay);
  retryTimer.unref?.();
}

/** Called once at gateway start: resume any writes still owed to Notion. */
export function startNotionOutbox(initialDelayMs = 20_000): void {
  try {
    if (!shouldMirror().ok) return;
    const pending = pendingRowIds("projects").length + pendingRowIds("tasks").length;
    if (pending === 0) return;
    log.info("notion outbox resuming queued writes", { pending });
    scheduleNotionOutboxRetry(initialDelayMs);
  } catch (err) {
    log.warn("notion outbox start skipped", { error: (err as Error)?.message });
  }
}

/** Rows Notion permanently rejected (dead-lettered), newest first. */
export function listNotionDeadLetters(): Array<{
  kind: MirrorKind;
  id: string;
  title: string;
  reason: string;
  at: number;
  attempts: number;
}> {
  const out: ReturnType<typeof listNotionDeadLetters> = [];
  for (const role of ["projects", "tasks"] as const) {
    const { store, database } = resolveKanbanDatabase(role);
    for (const row of store.listRows(database.id)) {
      const dl = readDeadLetter(row);
      if (!dl) continue;
      out.push({
        kind: role === "projects" ? "project" : "task",
        id: row.id,
        title: row.title,
        ...dl,
      });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * Re-queue dead-lettered rows (after the operator fixed the Notion DB or the
 * option map). Returns how many rows were re-queued.
 */
export function retryNotionDeadLetters(ids?: string[]): number {
  const want = ids?.length ? new Set(ids) : null;
  let n = 0;
  for (const role of ["projects", "tasks"] as const) {
    const { store, database } = resolveKanbanDatabase(role);
    for (const row of store.listRows(database.id)) {
      if (!readDeadLetter(row) || (want && !want.has(row.id))) continue;
      store.upsertRow({
        id: row.id,
        databaseId: row.databaseId,
        values: { [NOTION_PENDING_KEY]: PENDING_ON, [NOTION_ERROR_KEY]: ERROR_OFF },
      });
      n++;
    }
  }
  if (n > 0) {
    invalidateNotionOptionSchema();
    retryAttempt = 0;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    scheduleNotionOutboxRetry(0);
  }
  return n;
}

/**
 * Write a row of a kanban-backed database (the generic /databases surface,
 * `db.rows.upsert`) straight to the local store — used when Notion is not
 * configured, is down, or the row has no Notion page yet. When this database
 * is the one the kanban mirrors, the write is queued for Notion like any
 * other kanban write.
 */
export function upsertKanbanRowLocally(
  db: DatabaseRecord,
  patch: {
    id?: string;
    title?: string;
    body?: string | null;
    values?: Record<string, PropertyValue>;
  },
): DatabaseRow {
  const role: KanbanRole = db.source === "kanban-projects" ? "projects" : "tasks";
  const { store, database } = resolveKanbanDatabase(role);
  const mirror = database.id === db.id && shouldMirror().ok;
  const row = store.upsertRow({
    id: patch.id,
    databaseId: db.id,
    title: patch.title,
    body: patch.body,
    values: {
      ...patch.values,
      ...(mirror ? { [NOTION_PENDING_KEY]: PENDING_ON, [NOTION_ERROR_KEY]: ERROR_OFF } : {}),
    },
  });
  if (mirror) queueMirror(role === "projects" ? "project" : "task", row.id);
  return row;
}

/** Local rows created while Notion was unreachable (no Notion page yet). */
export function listNotionPendingProjects(): KanbanProjectShape[] {
  return listProjects().filter(
    (p) => !p.notionId && isPendingRow(resolveKanbanDatabase("projects").store.getRow(p.id)),
  );
}

export function listNotionPendingTasks(filter?: { projectId?: string }): KanbanTaskShape[] {
  const { store } = resolveKanbanDatabase("tasks");
  return listTasks(filter).filter((t) => !t.notionId && isPendingRow(store.getRow(t.id)));
}

/**
 * Where does a kanban id live? `local` = a local row with no Notion page yet
 * (write it locally); `notion` = a Notion page id to call Notion with
 * (resolving a local row's externalRef if the id is local).
 */
export function resolveKanbanId(
  kind: MirrorKind,
  id: string,
): { where: "local"; id: string } | { where: "notion"; notionId: string; localId?: string } {
  const role: KanbanRole = kind === "project" ? "projects" : "tasks";
  const { store, database } = resolveKanbanDatabase(role);
  const row = store.getRow(id);
  if (row && row.databaseId === database.id) {
    const ext = row.externalRef?.system === "notion" ? row.externalRef.externalId : null;
    return ext ? { where: "notion", notionId: ext, localId: row.id } : { where: "local", id };
  }
  return { where: "notion", notionId: id };
}

// ── Notion circuit breaker ────────────────────────────────────────────────
// Request-path callers (kanban RPCs, the kanban agent tool, claude_coder's
// task tracking) only try Notion while it is answering. After a transient
// failure (timeout, network, 401/403/429/5xx) they skip Notion entirely for
// NOTION_CIRCUIT_OPEN_MS and write straight to the local store, so a Notion
// outage costs at most one short wait instead of one per write. The outbox
// keeps retrying in the background and closes the circuit on success.

export const NOTION_CIRCUIT_OPEN_MS = 60_000;
let notionCircuitOpenUntil = 0;

/** Errors that say "Notion is unreachable right now", not "bad request". */
function isTransientNotionError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (/\b409\b/.test(msg) && /Notion/i.test(msg)) return false;
  return classifyNotionError(err) === "transient";
}

export function tripNotionCircuit(err?: unknown): void {
  if (err !== undefined && !isTransientNotionError(err)) return;
  notionCircuitOpenUntil = Date.now() + NOTION_CIRCUIT_OPEN_MS;
}

export function closeNotionCircuit(): void {
  notionCircuitOpenUntil = 0;
}

/** True while request paths should skip Notion and go local immediately. */
export function isNotionCircuitOpen(): boolean {
  return Date.now() < notionCircuitOpenUntil;
}

/**
 * Quiet status for the UI: never an error, just "off" / "ok" / "paused"
 * (Notion unreachable, writes queued) / "attention" (some rows were
 * permanently rejected and need a look). Includes the inbound pull health
 * per Notion DB so the chip can say "retrying in 4m".
 */
export function getNotionSyncHealth(): {
  state: "off" | "ok" | "paused" | "attention";
  syncMode: NotionSyncMode;
  pending: number;
  needsAttention: number;
  deadLetters: Array<{ kind: MirrorKind; id: string; title: string; reason: string; at: number }>;
  lastErrorAt: number | null;
  lastError: string | null;
  lastOkAt: number | null;
  nextRetryInMs: number | null;
  pull: Array<Record<string, unknown>>;
} {
  const cfg = getNotionConfig();
  const on = shouldMirror().ok;
  let pending = 0;
  let deadLetters: ReturnType<typeof listNotionDeadLetters> = [];
  try {
    pending = on ? pendingRowIds("projects").length + pendingRowIds("tasks").length : 0;
    deadLetters = on ? listNotionDeadLetters() : [];
  } catch {
    pending = 0;
  }
  let pull: Array<Record<string, unknown>> = [];
  try {
    pull = pullHealthProvider?.() ?? [];
  } catch {
    pull = [];
  }
  const pullFailing = pull.some((p) => p.state === "failing" || p.state === "open");
  return {
    state: !on
      ? "off"
      : lastMirrorError || pending > 0 || pullFailing
        ? "paused"
        : deadLetters.length > 0
          ? "attention"
          : "ok",
    syncMode: cfg.syncMode,
    pending,
    needsAttention: deadLetters.length,
    deadLetters: deadLetters.slice(0, 20).map(({ kind, id, title, reason, at }) => ({
      kind,
      id,
      title,
      reason,
      at,
    })),
    lastErrorAt: lastMirrorError?.at ?? null,
    lastError: lastMirrorError?.message ?? null,
    lastOkAt: lastMirrorOkAt,
    nextRetryInMs: retryTimer ? Math.max(0, retryDueAt - Date.now()) : null,
    pull,
  };
}

/** The pull side (notion-bidirectional-sync) registers its per-DB health here. */
let pullHealthProvider: (() => Array<Record<string, unknown>>) | null = null;
export function registerNotionPullHealth(fn: (() => Array<Record<string, unknown>>) | null): void {
  pullHealthProvider = fn;
}

/** Test hook: drop timers + in-memory state between cases. */
export function resetNotionOutboxForTests(opts: { random?: () => number } = {}): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryAttempt = 0;
  lastMirrorError = null;
  lastMirrorOkAt = null;
  outboxState = "ok";
  outboxFailuresSinceOk = 0;
  randomFn = opts.random ?? Math.random;
  mirrorInflight.clear();
  notionCircuitOpenUntil = 0;
  invalidateNotionOptionSchema();
}

// ─────────────────────────────────────────────────────────────────────────
// Diagnostics
// ─────────────────────────────────────────────────────────────────────────

export function describeKanbanState(): {
  syncMode: NotionSyncMode;
  notionConfigured: boolean;
  projects: { databaseId: string; source: string };
  tasks: { databaseId: string; source: string };
} {
  const cfg = getNotionConfig();
  const projects = resolveKanbanDatabase("projects").database;
  const tasks = resolveKanbanDatabase("tasks").database;
  return {
    syncMode: cfg.syncMode,
    notionConfigured: !!cfg.apiKey,
    projects: { databaseId: projects.id, source: projects.source },
    tasks: { databaseId: tasks.id, source: tasks.source },
  };
}

/** Generate a fresh local id when callers want a stable handle ahead of time. */
export function newKanbanId(prefix: "proj" | "task"): string {
  return `${prefix}_${randomUUID()}`;
}
