/**
 * Imported collection → canonical business stores.
 *
 * After a Notion database (API or ZIP) or an Obsidian folder lands in
 * Documents as a folder of row docs, the user can map it onto a local
 * canonical store:
 *
 *   projects → kanban projects   tasks → kanban tasks   clients → CRM clients
 *
 * `previewMapping` is a dry run (suggested role, proposed property → field
 * map, the first rows as they would land, create/update counts);
 * `applyMapping` writes them. Rows are deduped through the import ledger by
 * their source key (`notion:<id>` / `obsidian:<vault>:<path>`), so re-running
 * a mapping after a re-sync updates rows in place. Relations are preserved:
 * a task's project relation (Notion page ids, or a ZIP export's
 * "Title (https://notion.so/…<id>)" text, or a plain project name) resolves to
 * the kanban project imported from that page. Every write is journaled for undo.
 */

import { randomUUID } from "node:crypto";
import type { DocumentStore } from "./store.js";
import type { DocNode, DocPropertyColumn, DocPropertyValue } from "./types.js";
import { ImportLedger, type EntityRole, type ImportJournal } from "./import-journal.js";
import { normalizeNotionId } from "./notion/shared.js";

export type MappingRole = EntityRole;
export const MAPPING_ROLES: MappingRole[] = ["projects", "tasks", "clients"];

export interface TargetField {
  key: string;
  label: string;
  required?: boolean;
  aliases: string[];
}

export const TARGET_FIELDS: Record<MappingRole, TargetField[]> = {
  projects: [
    {
      key: "name",
      label: "Name",
      required: true,
      aliases: ["name", "title", "project", "project name"],
    },
    {
      key: "description",
      label: "Description",
      aliases: ["description", "summary", "notes", "about", "details"],
    },
    { key: "status", label: "Status", aliases: ["status", "state", "stage"] },
    { key: "priority", label: "Priority", aliases: ["priority", "importance"] },
    {
      key: "dueDate",
      label: "Due date",
      aliases: ["due", "due date", "deadline", "date", "end date", "target date"],
    },
  ],
  tasks: [
    {
      key: "title",
      label: "Title",
      required: true,
      aliases: ["title", "name", "task", "task name"],
    },
    {
      key: "description",
      label: "Description",
      aliases: ["description", "notes", "details", "summary"],
    },
    { key: "status", label: "Status", aliases: ["status", "state", "stage", "column"] },
    {
      key: "done",
      label: "Done (checkbox)",
      aliases: ["done", "complete", "completed", "checked"],
    },
    { key: "priority", label: "Priority", aliases: ["priority", "importance"] },
    {
      key: "dueDate",
      label: "Due date",
      aliases: ["due", "due date", "deadline", "date", "scheduled"],
    },
    { key: "tags", label: "Tags", aliases: ["tags", "labels", "tag", "category", "type"] },
    {
      key: "project",
      label: "Project (relation)",
      aliases: ["project", "projects", "parent project", "epic"],
    },
    {
      key: "assignee",
      label: "Assignee",
      aliases: ["assignee", "assigned", "assigned to", "owner", "person"],
    },
  ],
  clients: [
    {
      key: "name",
      label: "Name",
      required: true,
      aliases: ["name", "client", "client name", "company", "customer", "contact"],
    },
    { key: "email", label: "Email", aliases: ["email", "e-mail", "mail", "email address"] },
    { key: "phone", label: "Phone", aliases: ["phone", "phone number", "mobile", "tel"] },
    {
      key: "legalName",
      label: "Company / legal name",
      aliases: ["company", "legal name", "organization", "business"],
    },
    {
      key: "pipelineStatus",
      label: "Pipeline status",
      aliases: ["status", "stage", "pipeline", "pipeline status"],
    },
    { key: "notes", label: "Notes", aliases: ["notes", "description", "about", "details"] },
    { key: "telegram", label: "Telegram", aliases: ["telegram"] },
    { key: "whatsapp", label: "WhatsApp", aliases: ["whatsapp"] },
    { key: "instagram", label: "Instagram", aliases: ["instagram", "ig"] },
  ],
};

/** Field key → column key (or "" = unmapped). `title` columns map to the row title. */
export type FieldMap = Record<string, string>;

export const TITLE_COLUMN = "__title";

/** Columns of a collection folder: its schema, else the union of row property keys. */
export function collectionColumns(store: DocumentStore, folder: DocNode): DocPropertyColumn[] {
  const cols: DocPropertyColumn[] = [{ key: TITLE_COLUMN, name: "Title", type: "title" }];
  if (folder.schema?.length) {
    for (const c of folder.schema) if (c.type !== "title") cols.push(c);
    return cols;
  }
  const seen = new Set<string>();
  for (const row of rowsOf(store, folder.id)) {
    for (const [k, v] of Object.entries(row.properties ?? {})) {
      if (seen.has(k) || k === "obsidianPath") continue;
      seen.add(k);
      cols.push({
        key: k,
        name: k,
        type: Array.isArray(v)
          ? "multiSelect"
          : typeof v === "boolean"
            ? "checkbox"
            : typeof v === "number"
              ? "number"
              : "text",
      });
    }
  }
  return cols;
}

export function rowsOf(store: DocumentStore, folderId: string): DocNode[] {
  return store.children(folderId).filter((n) => n.kind === "doc" && !n.deletedAt);
}

const ROLE_HINTS: Array<[MappingRole, RegExp]> = [
  ["tasks", /\b(tasks?|to-?dos?|action items?|backlog|issues?|tickets?)\b/i],
  ["projects", /\b(projects?|initiatives?|epics?|programs?)\b/i],
  ["clients", /\b(clients?|customers?|crm|contacts?|leads?|accounts?|companies)\b/i],
];

export function suggestRole(folder: DocNode, columns: DocPropertyColumn[]): MappingRole | null {
  for (const [role, re] of ROLE_HINTS) if (re.test(folder.title)) return role;
  const names = columns.map((c) => c.name.toLowerCase());
  if (names.some((n) => /e-?mail|phone/.test(n))) return "clients";
  if (names.some((n) => /^(done|assignee|project)$/.test(n))) return "tasks";
  return null;
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function proposeFieldMap(role: MappingRole, columns: DocPropertyColumn[]): FieldMap {
  const map: FieldMap = {};
  const used = new Set<string>();
  for (const field of TARGET_FIELDS[role]) {
    if (field.required) {
      map[field.key] = TITLE_COLUMN;
      continue;
    }
    let hit: DocPropertyColumn | undefined;
    for (const alias of field.aliases) {
      hit = columns.find(
        (c) => c.key !== TITLE_COLUMN && !used.has(c.key) && norm(c.name) === alias,
      );
      if (hit) break;
    }
    if (!hit && field.key === "project") {
      hit = columns.find((c) => c.type === "relation" && !used.has(c.key));
    }
    if (!hit && field.key === "done") {
      hit = columns.find((c) => c.type === "checkbox" && !used.has(c.key));
    }
    map[field.key] = hit?.key ?? "";
    if (hit) used.add(hit.key);
  }
  return map;
}

// ── Value conversion ─────────────────────────────────────────

function text(v: DocPropertyValue | undefined): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function isoDay(v: DocPropertyValue | undefined): string | undefined {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(text(v));
  return m?.[1];
}

export function toTaskStatus(
  v: DocPropertyValue | undefined,
  done?: boolean,
): "backlog" | "todo" | "in_progress" | "review" | "done" {
  if (done) return "done";
  const s = norm(text(v));
  if (!s) return "todo";
  if (/(not started|to do|todo|not begun)/.test(s)) return "todo";
  if (/(done|complete|finished|closed|shipped|resolved)/.test(s)) return "done";
  if (/(review|qa|testing|approval)/.test(s)) return "review";
  if (/(progress|doing|active|started|wip|working)/.test(s)) return "in_progress";
  if (/(backlog|someday|later|icebox|idea)/.test(s)) return "backlog";
  return "todo";
}

export function toProjectStatus(v: DocPropertyValue | undefined): string | undefined {
  const s = norm(text(v));
  if (!s) return undefined;
  if (/not started/.test(s)) return "Not started";
  if (/(done|complete|finished|closed|shipped)/.test(s)) return "Completed";
  if (/(pause|hold|blocked)/.test(s)) return "Paused";
  if (/(progress|doing|active|started|ongoing)/.test(s)) return "In progress";
  if (/(client|awaiting|waiting)/.test(s)) return "Awaiting Client";
  return "Not started";
}

export function toPriority(
  v: DocPropertyValue | undefined,
): "Immediate" | "High" | "Medium" | "Low" | undefined {
  const s = norm(text(v));
  if (!s) return undefined;
  if (/(urgent|immediate|critical|p0|asap)/.test(s)) return "Immediate";
  if (/(high|p1|important)/.test(s)) return "High";
  if (/(low|p3|minor|nice)/.test(s)) return "Low";
  if (/(med|normal|p2)/.test(s)) return "Medium";
  return undefined;
}

function truthy(v: DocPropertyValue | undefined): boolean {
  if (typeof v === "boolean") return v;
  return /^(true|yes|x|done|checked|1)$/i.test(text(v).trim());
}

const DOC_REF_RE = /^doc:([a-zA-Z0-9_-]+)$/;

/** The imported node a `doc:<id>` relation item points at. */
function docRef(p: unknown, store?: DocumentStore): DocNode | null {
  const m = DOC_REF_RE.exec(String(p).trim());
  return m && store ? store.getNode(m[1]!) : null;
}

/**
 * Notion ids referenced by a relation value: Notion ids, ZIP "Title (https://…<id>)"
 * text, or `doc:<id>` references to imported Notion nodes (resolved via `store`).
 */
export function relationIds(v: DocPropertyValue | undefined, store?: DocumentStore): string[] {
  const parts = Array.isArray(v) ? v : text(v).split(/,\s*(?=[^)]*(?:\(|$))/);
  const out: string[] = [];
  for (const p of parts) {
    const node = docRef(p, store);
    const id =
      node?.source?.type === "notion"
        ? normalizeNotionId(node.source.id?.replace(/^folder:/, ""))
        : normalizeNotionId(String(p));
    if (id) out.push(id);
  }
  return [...new Set(out)];
}

/** Relation display names (ZIP text without URLs, `doc:` refs → titles) — fallback for name matching. */
function relationNames(v: DocPropertyValue | undefined, store?: DocumentStore): string[] {
  const parts = Array.isArray(v) ? v : text(v).split(",");
  return parts
    .map((p) =>
      (docRef(p, store)?.title ?? String(p))
        .replace(/\s*\(https?:[^)]*\)\s*/g, "")
        .replace(/\[\[|\]\]/g, "")
        .trim(),
    )
    .filter((p) => p && !/^[0-9a-f]{32}$/i.test(p) && !DOC_REF_RE.test(p));
}

/** Ledger key for a row doc (its import source, or the doc itself). */
export function rowKey(row: DocNode): string {
  if (
    row.source?.id &&
    (row.source.type === "notion" ||
      row.source.type === "notion-zip" ||
      row.source.type === "obsidian")
  ) {
    return `${row.source.type === "notion-zip" ? "notion" : row.source.type}:${row.source.id}`;
  }
  return `doc:${row.id}`;
}

function value(
  row: DocNode,
  store: DocumentStore,
  col: string | undefined,
): DocPropertyValue | undefined {
  if (!col) return undefined;
  if (col === TITLE_COLUMN) return row.title;
  return row.properties?.[col];
}

export interface MappedRow {
  docId: string;
  key: string;
  values: Record<string, unknown>;
  existingId: string | null;
}

// ── Store adapters ───────────────────────────────────────────

export interface MappingDeps {
  createProject(p: Record<string, unknown>): Promise<{ id: string }>;
  updateProject(id: string, patch: Record<string, unknown>): Promise<unknown>;
  getProject(id: string): Promise<Record<string, unknown> | null>;
  listProjects(): Promise<Array<{ id: string; name: string }>>;
  createTask(t: Record<string, unknown>): Promise<{ id: string }>;
  updateTask(id: string, patch: Record<string, unknown>): Promise<unknown>;
  getTask(id: string): Promise<Record<string, unknown> | null>;
  createClient(c: Record<string, unknown>): Promise<{ id: string }>;
  updateClient(id: string, patch: Record<string, unknown>): Promise<unknown>;
  getClient(id: string): Promise<Record<string, unknown> | null>;
  deleteEntity(role: MappingRole, id: string): Promise<void>;
}

/** Real kanban + agency-operations stores for `stateDir`. */
export async function defaultMappingDeps(stateDir: string): Promise<MappingDeps> {
  const [{ getKanbanStore }, { getAgencyOperationsStore }] = await Promise.all([
    import("../tasks/store.js"),
    import("../agency-operations/store.js"),
  ]);
  const kanban = getKanbanStore(stateDir);
  const agency = () => getAgencyOperationsStore(stateDir);
  return {
    createProject: async (p) =>
      kanban.createProject({ id: randomUUID(), ...(p as object) } as never),
    updateProject: (id, patch) => kanban.updateProject(id, patch as never),
    getProject: async (id) =>
      ((await kanban.getProjects()).find((p) => p.id === id) as unknown as Record<
        string,
        unknown
      >) ?? null,
    listProjects: async () => (await kanban.getProjects()).map((p) => ({ id: p.id, name: p.name })),
    createTask: (t) => kanban.createTask(t as never),
    updateTask: (id, patch) => kanban.updateTask(id, patch as never),
    getTask: async (id) => (kanban.getTaskById(id) as unknown as Record<string, unknown>) ?? null,
    createClient: async (c) => agency().createClient(c as never),
    updateClient: async (id, patch) => agency().updateClient(id, patch as never),
    getClient: async (id) => (agency().getClient(id) as unknown as Record<string, unknown>) ?? null,
    deleteEntity: async (role, id) => {
      if (role === "tasks") await kanban.deleteTask(id);
      else if (role === "projects") await kanban.deleteProject(id);
      else agency().deleteClient(id);
    },
  };
}

/** Undo hooks for import-journal.undoJournal backed by the mapping deps. */
export function undoDepsFor(deps: MappingDeps) {
  return {
    deleteEntity: (role: MappingRole, id: string) => deps.deleteEntity(role, id),
    restoreEntity: async (role: MappingRole, id: string, before: Record<string, unknown>) => {
      if (role === "projects") await deps.updateProject(id, before);
      else if (role === "tasks") await deps.updateTask(id, before);
      else await deps.updateClient(id, before);
    },
  };
}

// ── Preview / apply ──────────────────────────────────────────

export interface MappingPreview {
  folderId: string;
  folderTitle: string;
  role: MappingRole;
  suggestedRole: MappingRole | null;
  columns: Array<{ key: string; name: string; type: string }>;
  fields: TargetField[];
  fieldMap: FieldMap;
  total: number;
  create: number;
  update: number;
  sample: Array<{ title: string; values: Record<string, unknown>; action: "create" | "update" }>;
}

function mapRow(
  role: MappingRole,
  row: DocNode,
  store: DocumentStore,
  fm: FieldMap,
): Record<string, unknown> {
  const get = (k: string) => value(row, store, fm[k] || undefined);
  const out: Record<string, unknown> = {};
  if (role === "projects") {
    out.name = text(get("name")).trim() || row.title;
    const d = text(get("description")).trim();
    if (d) out.description = d;
    const st = toProjectStatus(get("status"));
    if (st) out.status = st;
    const pr = toPriority(get("priority"));
    if (pr) out.priority = pr;
    const due = isoDay(get("dueDate"));
    if (due) out.dueDate = due;
  } else if (role === "tasks") {
    out.title = text(get("title")).trim() || row.title;
    const d = text(get("description")).trim();
    if (d) out.description = d;
    const done = fm.done ? truthy(get("done")) : false;
    out.status = toTaskStatus(get("status"), done);
    out.done = out.status === "done";
    const pr = toPriority(get("priority"));
    if (pr) out.priorityLevel = pr;
    const due = isoDay(get("dueDate"));
    if (due) out.dueDate = due;
    const tags = get("tags");
    if (tags !== undefined && tags !== null) {
      const list = (Array.isArray(tags) ? tags : text(tags).split(","))
        .map((t) => String(t).trim())
        .filter(Boolean);
      if (list.length) out.tags = list;
    }
    const assignee = text(get("assignee")).trim();
    if (assignee) out.assignee = assignee;
    const rel = get("project");
    if (rel !== undefined && rel !== null && text(rel)) out.__projectRef = rel;
  } else {
    out.name = text(get("name")).trim() || row.title;
    for (const k of [
      "email",
      "phone",
      "legalName",
      "pipelineStatus",
      "notes",
      "telegram",
      "whatsapp",
      "instagram",
    ]) {
      const v = text(get(k)).trim();
      if (v) out[k] = v;
    }
    out.data = { ...row.properties, importedFrom: rowKey(row) };
  }
  return out;
}

export function buildPreview(
  store: DocumentStore,
  folderId: string,
  role: MappingRole | null,
  fieldMap: FieldMap | undefined,
  ledger: ImportLedger,
): MappingPreview {
  const folder = store.getNode(folderId);
  if (!folder || folder.kind !== "folder" || folder.deletedAt)
    throw new Error("Collection folder not found");
  const columns = collectionColumns(store, folder);
  const suggested = suggestRole(folder, columns);
  const r: MappingRole = role ?? suggested ?? "tasks";
  const fm = { ...proposeFieldMap(r, columns), ...fieldMap };
  const rows = rowsOf(store, folderId);
  let create = 0;
  let update = 0;
  const sample: MappingPreview["sample"] = [];
  for (const row of rows) {
    const existing = ledger.get(r, rowKey(row));
    if (existing) update += 1;
    else create += 1;
    if (sample.length < 8) {
      const values = mapRow(r, row, store, fm);
      if (values.__projectRef !== undefined) {
        values.project =
          relationNames(values.__projectRef as DocPropertyValue, store).join(", ") ||
          text(values.__projectRef as DocPropertyValue);
        delete values.__projectRef;
      }
      delete values.data;
      sample.push({ title: row.title, values, action: existing ? "update" : "create" });
    }
  }
  return {
    folderId,
    folderTitle: folder.title,
    role: r,
    suggestedRole: suggested,
    columns: columns.map((c) => ({ key: c.key, name: c.name, type: c.type })),
    fields: TARGET_FIELDS[r],
    fieldMap: fm,
    total: rows.length,
    create,
    update,
    sample,
  };
}

export interface MappingReport {
  role: MappingRole;
  created: number;
  updated: number;
  unchanged: number;
  relationsLinked: number;
  errors: Array<{ id: string; title?: string; error: string }>;
  defaultProjectId?: string;
}

function diffPatch(
  before: Record<string, unknown>,
  next: Record<string, unknown>,
): { patch: Record<string, unknown>; prev: Record<string, unknown> } {
  const patch: Record<string, unknown> = {};
  const prev: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) {
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(v ?? null)) {
      patch[k] = v;
      prev[k] = before[k] ?? null;
    }
  }
  return { patch, prev };
}

export async function applyMapping(
  store: DocumentStore,
  p: {
    folderId: string;
    role: MappingRole;
    fieldMap?: FieldMap;
    /** Tasks: project for rows without a resolvable project relation (created when absent). */
    defaultProjectId?: string;
  },
  deps: MappingDeps,
  journal: ImportJournal,
  ledger: ImportLedger = ImportLedger.forStore(store),
): Promise<MappingReport> {
  const preview = buildPreview(store, p.folderId, p.role, p.fieldMap, ledger);
  const fm = preview.fieldMap;
  const role = p.role;
  const report: MappingReport = {
    role,
    created: 0,
    updated: 0,
    unchanged: 0,
    relationsLinked: 0,
    errors: [],
  };
  const rows = rowsOf(store, p.folderId);

  let defaultProject = p.defaultProjectId;
  const projectsByName =
    role === "tasks"
      ? new Map((await deps.listProjects()).map((x) => [x.name.trim().toLowerCase(), x.id]))
      : new Map<string, string>();
  const ensureDefaultProject = async (): Promise<string> => {
    if (defaultProject) return defaultProject;
    const name = preview.folderTitle;
    const key = `collection:${p.folderId}`;
    const known = ledger.get("projects", key);
    if (known && (await deps.getProject(known))) {
      defaultProject = known;
      return known;
    }
    const created = await deps.createProject({ name, status: "In progress" });
    ledger.set("projects", key, created.id);
    journal.entitiesCreated.push({ role: "projects", id: created.id, key });
    defaultProject = created.id;
    return created.id;
  };

  for (const row of rows) {
    try {
      const key = rowKey(row);
      const values = mapRow(role, row, store, fm);
      if (role === "tasks") {
        const ref = values.__projectRef as DocPropertyValue | undefined;
        delete values.__projectRef;
        let projectId: string | undefined;
        if (ref !== undefined) {
          for (const nid of relationIds(ref, store)) {
            projectId = ledger.get("projects", `notion:${nid}`) ?? undefined;
            if (projectId) break;
          }
          if (!projectId) {
            for (const name of relationNames(ref, store)) {
              projectId = projectsByName.get(name.toLowerCase());
              if (projectId) break;
            }
          }
          if (projectId) report.relationsLinked += 1;
        }
        values.projectId = projectId ?? (await ensureDefaultProject());
      }
      if (row.source?.type === "notion" && row.source.id && role !== "clients")
        values.notionId = row.source.id;
      const existingId = ledger.get(role, key);
      const existing = existingId
        ? role === "projects"
          ? await deps.getProject(existingId)
          : role === "tasks"
            ? await deps.getTask(existingId)
            : await deps.getClient(existingId)
        : null;
      if (existing && existingId) {
        const { patch, prev } = diffPatch(existing, values);
        if (!Object.keys(patch).length) {
          report.unchanged += 1;
          continue;
        }
        if (role === "projects") await deps.updateProject(existingId, patch);
        else if (role === "tasks") await deps.updateTask(existingId, patch);
        else await deps.updateClient(existingId, patch);
        journal.entitiesUpdated.push({ role, id: existingId, before: prev });
        report.updated += 1;
      } else {
        const created =
          role === "projects"
            ? await deps.createProject(values)
            : role === "tasks"
              ? await deps.createTask(values)
              : await deps.createClient(values);
        ledger.set(role, key, created.id);
        journal.entitiesCreated.push({ role, id: created.id, key });
        if (role === "projects") projectsByName.set(String(values.name).toLowerCase(), created.id);
        report.created += 1;
      }
    } catch (err) {
      report.errors.push({ id: row.id, title: row.title, error: (err as Error).message });
    }
  }
  report.defaultProjectId = defaultProject;
  ledger.save();
  return report;
}

/** Obsidian `- [ ]` tasks → kanban tasks in one project (deduped by task key). */
export async function applyVaultTasks(
  tasks: Array<{
    key: string;
    text: string;
    done: boolean;
    due: string | null;
    tags: string[];
    notePath: string;
  }>,
  projectName: string,
  deps: MappingDeps,
  journal: ImportJournal,
  ledger: ImportLedger,
): Promise<{ created: number; updated: number; unchanged: number; projectId: string | null }> {
  const out = { created: 0, updated: 0, unchanged: 0, projectId: null as string | null };
  if (!tasks.length) return out;
  const pkey = `vault-tasks:${projectName.toLowerCase()}`;
  let projectId = ledger.get("projects", pkey);
  if (!projectId || !(await deps.getProject(projectId))) {
    const p = await deps.createProject({ name: projectName, status: "In progress" });
    projectId = p.id;
    ledger.set("projects", pkey, projectId);
    journal.entitiesCreated.push({ role: "projects", id: projectId, key: pkey });
  }
  out.projectId = projectId;
  for (const t of tasks) {
    const values: Record<string, unknown> = {
      projectId,
      title: t.text.slice(0, 300),
      status: t.done ? "done" : "todo",
      done: t.done,
      description: `From Obsidian note \`${t.notePath}\``,
      ...(t.due ? { dueDate: t.due } : {}),
      ...(t.tags.length ? { tags: t.tags } : {}),
    };
    const existingId = ledger.get("tasks", t.key);
    const existing = existingId ? await deps.getTask(existingId) : null;
    if (existing && existingId) {
      const { patch, prev } = diffPatch(existing, {
        status: values.status,
        done: values.done,
        dueDate: values.dueDate,
      });
      if (!Object.keys(patch).length) {
        out.unchanged += 1;
        continue;
      }
      await deps.updateTask(existingId, patch);
      journal.entitiesUpdated.push({ role: "tasks", id: existingId, before: prev });
      out.updated += 1;
    } else {
      const created = await deps.createTask(values);
      ledger.set("tasks", t.key, created.id);
      journal.entitiesCreated.push({ role: "tasks", id: created.id, key: t.key });
      out.created += 1;
    }
  }
  ledger.save();
  return out;
}
