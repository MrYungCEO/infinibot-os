import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type Block, blocksToMarkdown, markdownToBlocks } from "../../content/blocks-markdown.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getKanbanStore } from "../../tasks/store.js";
import {
  agentTaskWriteFields,
  broadcastKanbanChanged,
  noteKanbanTaskWrite,
} from "../../tasks/kanban-events.js";
import { recordHqProgress, unrecordHqProgress } from "../../hq-progress/store.js";
import { getDatabasesStore } from "../../databases/store.js";
import type { DatabaseRow } from "../../databases/types.js";
import {
  getNotionApiKeyOrNull,
  isNotionEnabled,
  resolveNotionDbId,
} from "../../databases/notion-config.js";
import { sanitizeNotionPageWrite } from "../../databases/notion-option-map.js";
import * as localKanban from "../../databases/kanban-store-ops.js";
import { ensureProjectDirectoryLink } from "../../databases/project-directory-link.js";
import {
  resolveClientParam,
  resolveDateParam,
  syncItemClient,
  type ClientParam,
  type DateParam,
} from "../../ideas/agent-params.js";
import { linkedClientIds } from "../../ideas/client-source.js";
import { localGatewayCall } from "../../ideas/service.js";

const log = createSubsystemLogger("kanban-tool");

// ── Local SQLite Store ────────────────────────────────────
function getLocalStore() {
  // No explicit dir: getKanbanStore resolves under the ACTIVE profile and
  // re-opens on profile switch. The old `INFINIBOT_STATE_DIR ?? "state"`
  // fallback wrote to <cwd>/state (an empty stub) when the env was unset and
  // ignored the active profile entirely.
  return getKanbanStore();
}

// ── Notion Config ─────────────────────────────────────────
const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function getProjectsDbId(): string {
  const id = resolveNotionDbId("kanban-projects");
  if (!id) throw new Error("No Notion projects database configured");
  return id;
}

function getTasksDbId(): string {
  const id = resolveNotionDbId("kanban-tasks");
  if (!id) throw new Error("No Notion tasks database configured");
  return id;
}

function getNotionApiKey(): string {
  // Same gate as the gateway handlers + outbox: config key (or legacy env
  // var) AND sync not switched off. Callers check notionKanbanReady() first.
  const key = getNotionApiKeyOrNull();
  if (!key) throw new Error("Notion sync is off");
  return key;
}

/**
 * Notion is an optional mirror. It is only used for kanban writes when sync
 * is on AND the kanban database is bound; otherwise (and whenever a Notion
 * call fails) the tool reads/writes the local store, which is the source of
 * truth, and the outbox in kanban-store-ops mirrors later.
 */
function notionKanbanReady(role: "projects" | "tasks"): boolean {
  try {
    return (
      isNotionEnabled() &&
      !localKanban.isNotionCircuitOpen() &&
      !!resolveNotionDbId(role === "projects" ? "kanban-projects" : "kanban-tasks")
    );
  } catch {
    return false;
  }
}

// Agent-tool Notion calls sit in front of a reply (and claude_coder awaits
// them before spawning), so they fail fast and fall back to local.
const NOTION_TOOL_TIMEOUT_MS = 10_000;
// Whole-pagination budget for list reads (the projects DB is ~12 pages /
// ~3 MB today and takes ~6 s). Past it the read falls back to the local store
// instead of holding the agent's turn.
const NOTION_LIST_BUDGET_MS = 45_000;
const NOTION_SLOW_PAGE_MS = 3_000;

/** Per-request signal: the request timeout plus the caller's abort, if any. */
function notionRequestSignal(timeoutMs: number, signal?: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

function notionErrMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Schema cache (delegated) ──────────────────────────────
// Previously this module maintained its own dbSchemaCache. After a
// schema reconcile (`notion.schema.applyPatch`) the canonical cache in
// databases/notion-schema.ts was invalidated but THIS one wasn\'t, so the
// agent kept skipping freshly-added properties until its TTL expired.
// We delegate to the canonical cache so all writers see new properties
// the moment a reconcile completes.
import { getLegacySchemaShape, invalidateSchemaCache } from "../../databases/notion-schema.js";

interface KanbanDbSchema {
  titleProp: string;
  props: Set<string>;
}

async function fetchDatabaseSchema(dbId: string): Promise<KanbanDbSchema | null> {
  return getLegacySchemaShape(dbId);
}

export function invalidateKanbanSchemaCache() {
  invalidateSchemaCache();
}

// ── Status Mappings (match UI exactly) ────────────────────
const NOTION_TASK_STATUS_TO_KANBAN: Record<string, string> = {
  "Not started": "todo",
  "In progress": "in_progress",
  "Awaiting Response": "review",
  Revisit: "review",
  Done: "done",
};

const KANBAN_TO_NOTION_TASK_STATUS: Record<string, string> = {
  backlog: "Not started",
  todo: "Not started",
  in_progress: "In progress",
  review: "Awaiting Response",
  done: "Done",
};

const NOTION_PRIORITY_TO_LOCAL: Record<string, string> = {
  Immediate: "critical",
  High: "high",
  Medium: "medium",
  Low: "low",
};

const LOCAL_PRIORITY_TO_NOTION: Record<string, string> = {
  critical: "Immediate",
  high: "High",
  medium: "Medium",
  low: "Low",
};

// ── Notion API Helper ─────────────────────────────────────
async function notionFetch(
  path: string,
  opts: RequestInit = {},
  callerSignal?: AbortSignal,
): Promise<any> {
  try {
    return await notionFetchRaw(path, opts);
  } catch (err) {
    // The agent turn was aborted / the tool timed out: not a Notion outage.
    if (callerSignal?.aborted) throw err;
    // A Notion outage opens the shared circuit so the next writes go
    // straight to the local store instead of waiting on Notion again.
    localKanban.tripNotionCircuit(err);
    throw err;
  }
}

async function notionFetchRaw(path: string, opts: RequestInit = {}): Promise<any> {
  // Never send a status/select option the target DB doesn't have (a bad
  // status name is a permanent 400; see databases/notion-option-map.ts).
  if (typeof opts.body === "string") {
    opts = {
      ...opts,
      body: await sanitizeNotionPageWrite(getNotionApiKey(), path, opts.method, opts.body, [
        resolveNotionDbId("kanban-tasks"),
        resolveNotionDbId("kanban-projects"),
      ]),
    };
  }
  const res = await fetch(`${NOTION_API_URL}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${getNotionApiKey()}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...((opts.headers as Record<string, string>) || {}),
    },
    signal: notionRequestSignal(NOTION_TOOL_TIMEOUT_MS, opts.signal),
  });
  const raw = await res.text();
  // Guard: Notion always returns JSON. If we get back HTML it means a proxy
  // or the gateway's SPA layer intercepted the request — throw a clear error
  // so callers don't try to parse a <!DOCTYPE …> string as JSON.
  if (raw.trimStart().startsWith("<")) {
    throw new Error(
      `Notion API returned HTML instead of JSON (status ${res.status}). ` +
        "Check that NOTION_API_KEY is set and the request isn't being intercepted.",
    );
  }
  const body = JSON.parse(raw);
  if (!res.ok)
    throw new Error(`Notion API ${res.status}: ${body?.message || JSON.stringify(body)}`);
  return body;
}

// Paginated query helper. Bounded twice: each request by NOTION_TOOL_TIMEOUT_MS
// and the whole pagination by `budgetMs`; `signal` (the tool call's) aborts
// in-flight requests when the agent turn is aborted or the tool times out.
async function queryAllPages(
  databaseId: string,
  filter?: any,
  opts: { signal?: AbortSignal; budgetMs?: number } = {},
): Promise<any[]> {
  const pages: any[] = [];
  const startedAt = Date.now();
  const budgetMs = opts.budgetMs ?? NOTION_LIST_BUDGET_MS;
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageNo = 0;
  do {
    opts.signal?.throwIfAborted();
    const remaining = budgetMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      throw new Error(
        `Notion query exceeded its ${Math.round(budgetMs / 1000)}s budget after ${pageNo} page(s)`,
      );
    }
    const body: any = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const pageStartedAt = Date.now();
    const res = await notionFetch(
      `/databases/${databaseId}/query`,
      {
        method: "POST",
        body: JSON.stringify(body),
        signal: notionRequestSignal(Math.min(NOTION_TOOL_TIMEOUT_MS, remaining), opts.signal),
      },
      opts.signal,
    );
    pageNo++;
    const pageMs = Date.now() - pageStartedAt;
    if (pageMs > NOTION_SLOW_PAGE_MS) {
      log.debug("notion query page slow", { databaseId, page: pageNo, ms: pageMs });
    }
    pages.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : undefined;
    // A cursor Notion already handed out would loop forever.
    if (cursor && seenCursors.has(cursor)) {
      throw new Error(`Notion query returned a repeated cursor after ${pageNo} page(s)`);
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return pages;
}

// ── Property Extractors (same as UI controller) ───────────
function extractTitle(props: any): string {
  for (const key of ["Project", "Task Name", "Name", "Task", "Title", "title", "name"]) {
    const prop = props[key];
    if (prop?.title) {
      return (
        prop.title.map((t: any) => t.plain_text || t.text?.content || "").join("") || "Untitled"
      );
    }
  }
  for (const key of Object.keys(props)) {
    if (props[key]?.type === "title" && props[key]?.title) {
      return (
        props[key].title.map((t: any) => t.plain_text || t.text?.content || "").join("") ||
        "Untitled"
      );
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

function extractDate(props: any, key: string): string | undefined {
  return props[key]?.date?.start || undefined;
}

function extractPeople(props: any, key: string): string | undefined {
  const people = props[key]?.people;
  if (!people?.length) return undefined;
  return people
    .map((p: any) => p.name || p.person?.email || "")
    .filter(Boolean)
    .join(", ");
}

function extractNumber(props: any, key: string): number | undefined {
  const prop = props[key];
  if (prop?.type === "number") {
    return prop.number !== null && prop.number !== undefined ? prop.number : undefined;
  }
  if (prop?.type === "rollup" && prop.rollup?.type === "number") {
    return prop.rollup.number !== null && prop.rollup.number !== undefined
      ? Math.round(prop.rollup.number * 100)
      : undefined;
  }
  return undefined;
}

function extractCheckbox(props: any, key: string): boolean {
  return props[key]?.checkbox === true;
}

// ── Map Notion → Kanban types ─────────────────────────────
function mapNotionProject(page: any) {
  const props = page.properties || {};

  // Federation properties (handle gracefully - may not exist)
  const primaryNode = extractSelect(props, "Primary Node") || undefined;
  const nodes = extractMultiSelect(props, "Nodes"); // Array of node names
  const projectDirectory = extractRichText(props, "Project Directory") || undefined;
  const shared = extractCheckbox(props, "Shared");
  // Archived surfaces in query results (list_projects stays unfiltered so
  // archived projects remain queryable); the kanban UI hides them.
  const archived = extractCheckbox(props, "Archive");

  // Parent project via self-referential "Parent Project" relation
  const parentProjectId = props["Parent Project"]?.relation?.[0]?.id || null;

  return {
    id: page.id,
    notionId: page.id,
    name: extractTitle(props),
    description: extractRichText(props, "Description") || extractRichText(props, "Notes") || "",
    status: extractStatus(props, "Status") || "Not started",
    priority: extractSelect(props, "Priority") || undefined,
    type: extractMultiSelect(props, "Type"),
    progress: extractNumber(props, "Progress") ?? 0,
    taskCount: props.Tasks?.relation?.length || 0,
    dueDate: extractDate(props, "Due") || extractDate(props, "Due Date"),
    coverUrl: page.cover?.external?.url || page.cover?.file?.url || undefined,
    createdAt: new Date(page.created_time).getTime(),
    updatedAt: new Date(page.last_edited_time).getTime(),
    // Federation properties
    primaryNode,
    nodes: nodes.length > 0 ? nodes : undefined,
    projectDirectory,
    shared,
    archived,
    // Parent-child hierarchy
    parentProjectId,
  };
}

function mapNotionTask(page: any) {
  const props = page.properties || {};
  const notionStatus =
    extractStatus(props, "Status Update") || extractStatus(props, "Status") || "Not started";
  const kanbanStatus = NOTION_TASK_STATUS_TO_KANBAN[notionStatus] || "todo";
  const priorityLevel = extractSelect(props, "Priority Level");

  let priority = "medium";
  if (priorityLevel && NOTION_PRIORITY_TO_LOCAL[priorityLevel]) {
    priority = NOTION_PRIORITY_TO_LOCAL[priorityLevel];
  }

  // Federation properties (handle gracefully - may not exist)
  const node = extractSelect(props, "Node") || undefined;
  const directory = extractRichText(props, "Directory") || undefined;
  const computeRequirements = extractMultiSelect(props, "Compute Requirements");
  const delegatedTo = extractRichText(props, "Delegated To") || undefined;
  const sourceNode = extractSelect(props, "Source Node") || undefined;

  return {
    id: page.id,
    notionId: page.id,
    projectId: props.Project?.relation?.[0]?.id || "",
    title: extractTitle(props),
    description: extractRichText(props, "Description") || extractRichText(props, "Notes") || "",
    status: kanbanStatus,
    notionStatus,
    assignee: extractPeople(props, "Assignee") || extractPeople(props, "Assign") || "",
    department: extractMultiSelect(props, "Department"),
    priorityLevel: priorityLevel || undefined,
    priority,
    dueDate: extractDate(props, "Due Date") || extractDate(props, "Due"),
    done: extractCheckbox(props, "Done"),
    createdAt: new Date(page.created_time).getTime(),
    updatedAt: new Date(page.last_edited_time).getTime(),
    // Federation properties
    node,
    directory,
    computeRequirements: computeRequirements.length ? computeRequirements : undefined,
    delegatedTo,
    sourceNode,
  };
}

// ── Tool Schema ───────────────────────────────────────────
const KANBAN_ACTIONS = [
  "create_task",
  "update_task",
  "list_tasks",
  "list_projects",
  "create_project",
  "update_project",
  "add_attachment",
  "remove_attachment",
  // Markdown content actions for project pages. The project content panel
  // in the UI renders block-formatted content (headings, lists, code,
  // images). Using these actions ensures what the agent writes is parsed
  // into proper blocks instead of being stored as a raw text wall — same
  // pipeline the database row body editor uses.
  "set_project_content_md",
  "append_project_content_md",
  "get_project_content_md",
  // Task page content — every task has its own full rich-document body,
  // mirroring the project content actions but keyed by task_id.
  "set_task_content_md",
  "append_task_content_md",
  "get_task_content_md",
  // Read-after-write verification: confirm a create/update landed in the
  // durable store. Bypasses the in-memory list cache.
  "get_task",
  "verify_task",
  "list_files",
  "get_file",
] as const;

// ── Project Status → Task Status Cascade Mapping ──────────
// When a project moves to a status, cascade that to all its tasks
const PROJECT_TO_TASK_STATUS: Record<string, string> = {
  "Not started": "todo",
  "In progress": "in_progress",
  Completed: "done",
  Paused: "backlog",
  Updating: "in_progress",
  "Awaiting Client": "review",
  Reviewing: "review",
  Cancelled: "done",
};

const KANBAN_TO_NOTION_PROJECT_STATUS: Record<string, string> = {
  "Not started": "Not started",
  "In progress": "In progress",
  Completed: "Completed",
  Paused: "Paused",
  Updating: "Updating",
  "Awaiting Client": "Awaiting Client",
  Reviewing: "Reviewing",
  Cancelled: "Cancelled",
};

const KanbanToolSchema = Type.Object({
  action: stringEnum(KANBAN_ACTIONS),
  title: Type.Optional(Type.String()),
  project_id: Type.Optional(Type.String()),
  content_target: Type.Optional(
    stringEnum(["notes", "spec"] as const, {
      description:
        "Which project document the *_project_content_md actions read/write. 'notes' (default) = the free-form page body; 'spec' = the structured spec panel (stored under the '<projectId>::spec' document key).",
    }),
  ),
  description: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  priority: Type.Optional(Type.String()),
  assignee: Type.Optional(Type.String()),
  task_id: Type.Optional(Type.String()),
  project_name: Type.Optional(Type.String()),
  project_description: Type.Optional(Type.String()),
  project_type: Type.Optional(Type.String()),
  filter_project: Type.Optional(Type.String()),
  filter_status: Type.Optional(Type.String()),
  filter_assignee: Type.Optional(Type.String()),
  // Narrowing for list_projects / list_tasks. `query` filters by name/title
  // substring (case-insensitive) — use it when the user names a specific
  // project or task instead of pulling the whole board. `limit` caps how many
  // rows come back (default applied server-side) so a large board can't dump
  // hundreds of full objects into the context window.
  query: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
  // Dates + CRM client (create_task / update_task / create_project / update_project).
  due_date: Type.Optional(
    Type.String({
      description:
        'Task due date / project target date: "YYYY-MM-DD", or words in the owner\'s timezone ("next Friday", "in two weeks", "end of month"). "" or "none" clears it on update.',
    }),
  ),
  client_id: Type.Optional(
    Type.String({
      description:
        'CRM client (Business HQ › Clients) this task / project is for: a client id, or an exact / unambiguous client name. Links it on the client page, the knowledge graph and Notion\'s Customer / Clients relation. "" or "none" clears it on update.',
    }),
  ),
  // Federation properties
  node: Type.Optional(Type.String()), // Which node owns/runs this task
  directory: Type.Optional(Type.String()), // Workspace path for this task
  compute_requirements: Type.Optional(Type.String()), // Comma-separated: GPU,Voice,MCP,Local,Heavy
  delegated_to: Type.Optional(Type.String()), // Agent/Node handling this task
  source_node: Type.Optional(Type.String()), // Where task was created
  filter_node: Type.Optional(Type.String()), // Filter tasks by node
  // Parent project — pass an existing project ID to create a sub-project,
  // or a project name hint to auto-resolve the parent before creating.
  parent_project_id: Type.Optional(Type.String()),
  parent_project_hint: Type.Optional(Type.String()),
  // Project content (page body). Plain markdown — parsed into blocks
  // server-side so the projects content panel displays formatted text,
  // headings, lists, code, images, etc.
  markdown: Type.Optional(Type.String()),
  // Project federation properties
  primary_node: Type.Optional(Type.String()), // Default node for this project
  nodes: Type.Optional(Type.String()), // Comma-separated list of nodes assigned to this project (e.g., "master,robo1,robo2")
  project_directory: Type.Optional(Type.String()), // Full path on target node
  shared: Type.Optional(Type.Boolean()), // Available to all nodes in federation
  // Cascade control
  cascade_status: Type.Optional(Type.Boolean()), // When true, cascade project status to all tasks (default: true)
  // Attachment properties (for add_attachment / remove_attachment)
  attachment_id: Type.Optional(Type.String()),
  attachment_name: Type.Optional(Type.String()),
  attachment_url: Type.Optional(Type.String()), // HTTP(S) URL — e.g. generated image URL
  attachment_path: Type.Optional(Type.String()), // Local filesystem path
  attachment_mime: Type.Optional(Type.String()), // MIME type (e.g. "image/png")
  attachment_size: Type.Optional(Type.Number()), // Size in bytes
  attachment_caption: Type.Optional(Type.String()), // Description / caption
});

// ── Dates + CRM client ────────────────────────────────────

type DateClientExtras = { due?: DateParam; client?: ClientParam };

async function readDateClient(
  params: Record<string, unknown>,
): Promise<DateClientExtras | { error: string; candidates?: Array<{ id: string; name: string }> }> {
  const due = resolveDateParam(params.due_date);
  if (due && "error" in due) return { error: due.error };
  const client = await resolveClientParam(params.client_id);
  if (client && "error" in client) return client;
  return { ...(due ? { due } : {}), ...(client ? { client } : {}) };
}

function hasDateClient(x: DateClientExtras): boolean {
  return !!(x.due || x.client);
}

/**
 * After a task / project write: set its due date and CRM client through
 * kanban.*.update (Notion "Due Date" + "Customer" / "Clients", or the local
 * row) and link the client in the relation indexes. Failures here never undo
 * the main write; they come back as `warning`.
 */
async function applyDateClient(
  kind: "task" | "project",
  givenId: string | null,
  extras: DateClientExtras,
  res: ReturnType<typeof jsonResult>,
): Promise<ReturnType<typeof jsonResult>> {
  if (!hasDateClient(extras)) return res;
  const details = (res.details ?? {}) as Record<string, any>;
  if (details.status === "error") return res;
  const id: string | undefined = givenId ?? details[kind]?.id ?? details.id;
  if (!id) return res;
  const patch: Record<string, unknown> = {};
  if (extras.due) patch.dueDate = "date" in extras.due ? extras.due.date : null;
  let previous: string[] = [];
  let clientId: string | null | undefined;
  if (extras.client && !("error" in extras.client)) {
    clientId = "clientId" in extras.client ? extras.client.clientId : null;
    previous = await linkedClientIds(kind, id).catch(() => []);
    patch.clientId = clientId;
    patch.previousClientIds = previous;
  }
  let warning: string | undefined;
  try {
    await localGatewayCall()(kind === "task" ? "kanban.tasks.update" : "kanban.projects.update", {
      id,
      patch,
    });
  } catch (err) {
    warning = `saved, but the date/client update failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (clientId !== undefined) await syncItemClient(kind, id, previous, [clientId], "agent");
  return jsonResult({
    ...details,
    ...(extras.due ? { dueDate: "date" in extras.due ? extras.due.date : null } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
    ...(warning ? { warning } : {}),
  });
}

// ── Main Tool ─────────────────────────────────────────────
export function createKanbanTool(options?: { agentId?: string }): AnyAgentTool {
  const callingAgentId = options?.agentId || "main";

  return {
    label: "Kanban",
    name: "kanban",
    description:
      "Manage kanban board tasks, projects, and project content (stored locally; mirrored to Notion only when Notion sync is connected — Notion is never required). Actions: create_task, update_task, list_tasks, list_projects, create_project, update_project, add_attachment, remove_attachment, set_project_content_md, append_project_content_md, get_project_content_md. For attaching generated images to a project, use add_attachment with { project_id, attachment_url, attachment_name, attachment_mime: 'image/png' } — images appear as thumbnails in the project content panel. For writing the project's PAGE CONTENT (the body you see when you open a project — headings, paragraphs, lists, code, images) use set_project_content_md / append_project_content_md with { project_id, markdown }. The markdown is parsed into blocks server-side using the same pipeline the database row body editor uses, so what you write renders as formatted text instead of a raw text wall. Use append_project_content_md to add to an existing page without overwriting it. Use get_project_content_md to read the current page as markdown. Every TASK also has its own full document page: use set_task_content_md / append_task_content_md / get_task_content_md with { task_id, markdown } (same block pipeline) to write or read a task's rich body. By default these three actions target the free-form Notes/page body; pass content_target='spec' to instead read/write the project's structured SPEC panel (Deliverables / To-do / Acceptance criteria) — its blocks live under a separate document key, so writing to Notes will NOT populate the spec tab. Markdown '- [ ] item' lines under the To-do heading become dispatchable to-dos in the spec panel. For list_projects and list_tasks, when the user names a specific item pass query='<name>' to filter by name/title instead of pulling the whole board; results are capped (default 50, compact fields) and report count/matched/returned plus a note when truncated — raise limit only when you genuinely need more. DATES + CLIENTS: create_task / update_task / create_project / update_project accept due_date ('YYYY-MM-DD' or words like 'next Friday', in the owner's timezone) and client_id (CRM client id or exact client name) — the item then shows on that client's page and in the knowledge graph; pass 'none' to clear. Valid statuses: backlog, todo, in_progress, review, done. Valid priorities: low, medium, high, critical. For federation, use nodes='master,robo1,robo2' to assign multiple devices to a project. PROJECT DIRECTORY: every code/repo project SHOULD pass project_directory (or directory on update) with the absolute local repo path — on create_project and update_project it is saved on the project (and mirrored to Notion's 'Project Directory' field when Notion is connected) AND auto-creates a clickable 'Project directory' file-link on the project row (idempotent). If you're working on or opening a project that has no directory linked yet, set it via update_project with directory='<absolute path>' before doing further work. FILES: use list_files with { project_id } to enumerate a project's attachments (id, name, mimeType), then get_file with { project_id, attachment_id } to READ THE EXTRACTED MARKDOWN TEXT of a PDF/DOCX/CSV/image/etc. — get_file returns the file's converted `markdown` content (with a `truncated` flag + `charCount`), not just metadata, so you can actually read what's inside instead of getting a path you can't open.",
    parameters: KanbanToolSchema,
    execute: async (_toolCallId, args, signal) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      try {
        // due_date / client_id (task + project create/update) are applied
        // after the main write, through the kanban RPCs (Notion + local).
        const extras = /^(create|update)_(task|project)$/.test(action)
          ? await readDateClient(params)
          : {};
        if ("error" in extras) return jsonResult({ status: "error", ...extras });
        switch (action) {
          case "list_projects": {
            const query = readStringParam(params, "query");
            const limit = readNumberParam(params, "limit", { integer: true });
            return await handleListProjects({ query, limit, signal });
          }
          case "list_tasks": {
            const projectId = readStringParam(params, "filter_project");
            const status = readStringParam(params, "filter_status");
            const assignee = readStringParam(params, "filter_assignee");
            const node = readStringParam(params, "filter_node");
            const query = readStringParam(params, "query");
            const limit = readNumberParam(params, "limit", { integer: true });
            return await handleListTasks({
              projectId,
              status,
              assignee,
              node,
              query,
              limit,
              signal,
            });
          }
          case "create_task": {
            const title = readStringParam(params, "title", { required: true });
            const projectId = readStringParam(params, "project_id");
            const description = readStringParam(params, "description") || "";
            const status = readStringParam(params, "status") || "todo";
            const priority = readStringParam(params, "priority") || "medium";
            const assignee = readStringParam(params, "assignee") || callingAgentId;
            // Federation properties
            const node = readStringParam(params, "node");
            const directory = readStringParam(params, "directory");
            const computeReqStr = readStringParam(params, "compute_requirements");
            const computeRequirements = computeReqStr
              ? computeReqStr
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              : undefined;
            const delegatedTo = readStringParam(params, "delegated_to");
            const sourceNode = readStringParam(params, "source_node");
            return await applyDateClient(
              "task",
              null,
              extras,
              await handleCreateTask({
                title,
                projectId,
                description,
                status,
                priority,
                assignee,
                node,
                directory,
                computeRequirements,
                delegatedTo,
                sourceNode,
              }),
            );
          }
          case "create_project": {
            const name = readStringParam(params, "project_name", { required: true });
            const description =
              readStringParam(params, "description") ||
              readStringParam(params, "project_description") ||
              "";
            const typeParam = readStringParam(params, "project_type") || "AI Projects";
            const types = typeParam
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean);
            if (!types.includes("AI Projects")) types.unshift("AI Projects");
            // Federation properties
            const primaryNode = readStringParam(params, "primary_node");
            const nodesStr = readStringParam(params, "nodes");
            const nodes = nodesStr
              ? nodesStr
                  .split(",")
                  .map((n) => n.trim())
                  .filter(Boolean)
              : undefined;
            const projectDirectory = readStringParam(params, "project_directory");
            const shared = params.shared as boolean | undefined;
            // Parent-child: explicit id OR resolve from hint
            let parentProjectId = readStringParam(params, "parent_project_id") || null;
            const parentHint = readStringParam(params, "parent_project_hint");
            if (!parentProjectId && parentHint) {
              const resolved = await findOrCreateProject(parentHint);
              if (resolved) parentProjectId = resolved.projectId;
            }
            return await applyDateClient(
              "project",
              null,
              extras,
              await handleCreateProject({
                name,
                description,
                types,
                primaryNode,
                nodes,
                projectDirectory,
                shared,
                parentProjectId,
              }),
            );
          }
          case "update_task": {
            const taskId = readStringParam(params, "task_id", { required: true });
            const patch: Record<string, any> = {};
            const title = readStringParam(params, "title");
            const description = readStringParam(params, "description");
            const status = readStringParam(params, "status");
            const priority = readStringParam(params, "priority");
            const assignee = readStringParam(params, "assignee");
            const projectId = readStringParam(params, "project_id");
            // Federation properties
            const node = readStringParam(params, "node");
            const directory = readStringParam(params, "directory");
            const computeReqStr = readStringParam(params, "compute_requirements");
            const delegatedTo = readStringParam(params, "delegated_to");
            const sourceNode = readStringParam(params, "source_node");

            if (title) patch.title = title;
            if (description) patch.description = description;
            if (status) patch.status = status;
            if (priority) patch.priority = priority;
            if (assignee) patch.assignee = assignee;
            if (projectId) patch.projectId = projectId;
            // Federation properties
            if (node) patch.node = node;
            if (directory) patch.directory = directory;
            if (computeReqStr)
              patch.computeRequirements = computeReqStr
                .split(",")
                .map((s: string) => s.trim())
                .filter(Boolean);
            if (delegatedTo) patch.delegatedTo = delegatedTo;
            if (sourceNode) patch.sourceNode = sourceNode;
            return await applyDateClient(
              "task",
              taskId,
              extras,
              Object.keys(patch).length || !hasDateClient(extras)
                ? await handleUpdateTask(taskId, patch)
                : jsonResult({ status: "ok", task: { id: taskId } }),
            );
          }
          case "update_project": {
            const projectId = readStringParam(params, "project_id", { required: true });
            const patch: Record<string, any> = {};
            const name = readStringParam(params, "project_name");
            const description =
              readStringParam(params, "description") ||
              readStringParam(params, "project_description");
            const status = readStringParam(params, "status");
            const priority = readStringParam(params, "priority");
            const typeParam = readStringParam(params, "project_type");
            // Federation properties
            const primaryNode = readStringParam(params, "primary_node");
            const nodesStr = readStringParam(params, "nodes");
            const projectDirectory =
              readStringParam(params, "project_directory") || readStringParam(params, "directory");
            // Cascade control - default true
            const cascadeStatus = params.cascade_status !== false;

            if (name) patch.name = name;
            if (description) patch.description = description;
            if (status) patch.status = status;
            if (priority) patch.priority = priority;
            if (typeParam)
              patch.types = typeParam
                .split(",")
                .map((t: string) => t.trim())
                .filter(Boolean);
            if (primaryNode) patch.primaryNode = primaryNode;
            if (nodesStr)
              patch.nodes = nodesStr
                .split(",")
                .map((n: string) => n.trim())
                .filter(Boolean);
            if (projectDirectory) patch.projectDirectory = projectDirectory;
            if (params.shared !== undefined) patch.shared = params.shared;
            // Parent re-parenting: allow moving a project under a new parent
            const parentProjectId = readStringParam(params, "parent_project_id") || null;
            const parentHint = readStringParam(params, "parent_project_hint");
            if (parentProjectId || parentHint) {
              let resolvedId = parentProjectId;
              if (!resolvedId && parentHint) {
                const resolved = await findOrCreateProject(parentHint);
                if (resolved) resolvedId = resolved.projectId;
              }
              if (resolvedId) patch.parentProjectId = resolvedId;
            }

            return await applyDateClient(
              "project",
              projectId,
              extras,
              Object.keys(patch).length || !hasDateClient(extras)
                ? await handleUpdateProject(projectId, patch, cascadeStatus)
                : jsonResult({ status: "ok", project: { id: projectId } }),
            );
          }
          case "add_attachment": {
            const projectId = readStringParam(params, "project_id", { required: true });
            const url = readStringParam(params, "attachment_url");
            const path = readStringParam(params, "attachment_path");
            const name = readStringParam(params, "attachment_name");
            const mimeType = readStringParam(params, "attachment_mime");
            const caption = readStringParam(params, "attachment_caption");
            const size = typeof params.attachment_size === "number" ? params.attachment_size : 0;
            return await handleAddAttachment({
              projectId,
              url,
              path,
              name,
              mimeType,
              caption,
              size,
            });
          }
          case "remove_attachment": {
            const attachmentId = readStringParam(params, "attachment_id", { required: true });
            return await handleRemoveAttachment(attachmentId);
          }
          case "set_project_content_md": {
            const projectId = readStringParam(params, "project_id", { required: true });
            const markdown = readStringParam(params, "markdown", {
              required: true,
              allowEmpty: true,
            });
            return handleSetProjectMarkdown(resolveContentDocId(params, projectId), markdown);
          }
          case "append_project_content_md": {
            const projectId = readStringParam(params, "project_id", { required: true });
            const markdown = readStringParam(params, "markdown", { required: true });
            return handleAppendProjectMarkdown(resolveContentDocId(params, projectId), markdown);
          }
          case "get_project_content_md": {
            const projectId = readStringParam(params, "project_id", { required: true });
            const { linkedPeopleFields } = await import("../../network/links.js");
            return handleGetProjectMarkdown(
              resolveContentDocId(params, projectId),
              await linkedPeopleFields("project", projectId),
            );
          }
          case "set_task_content_md": {
            const taskId = readStringParam(params, "task_id", { required: true });
            const markdown = readStringParam(params, "markdown", {
              required: true,
              allowEmpty: true,
            });
            return handleSetTaskMarkdown(taskId, markdown);
          }
          case "append_task_content_md": {
            const taskId = readStringParam(params, "task_id", { required: true });
            const markdown = readStringParam(params, "markdown", { required: true });
            return handleAppendTaskMarkdown(taskId, markdown);
          }
          case "get_task_content_md": {
            const taskId = readStringParam(params, "task_id", { required: true });
            return handleGetTaskMarkdown(taskId);
          }

          // ── Verify / point-read actions ──────────────────────────────
          case "get_task": {
            const taskId = readStringParam(params, "task_id", { required: true });
            const task = getLocalStore().getTaskById(taskId);
            if (!task) return jsonResult({ status: "error", error: `Task "${taskId}" not found` });
            const { linkedPeopleFields } = await import("../../network/links.js");
            return jsonResult({
              status: "ok",
              task,
              ...(await linkedPeopleFields("task", taskId)),
            });
          }

          case "verify_task": {
            const taskId = readStringParam(params, "task_id", { required: true });
            const task = getLocalStore().getTaskById(taskId);
            if (!task) return jsonResult({ status: "ok", id: taskId, exists: false });
            return jsonResult({ status: "ok", id: taskId, exists: true, task });
          }

          case "list_files": {
            const projectId = readStringParam(params, "project_id", { required: true });
            const attachments = getLocalStore().getProjectAttachments(projectId);
            return jsonResult({
              status: "ok",
              projectId,
              count: attachments.length,
              attachments,
            });
          }

          case "get_file": {
            // `attachment_id` is the primary param; `task_id` is a legacy
            // fallback (older callers reused it as the file id).
            const fileId =
              readStringParam(params, "attachment_id") ||
              readStringParam(params, "task_id", { required: true });
            const att = getLocalStore().getProjectAttachmentById(fileId);
            if (!att)
              return jsonResult({ status: "error", error: `Attachment "${fileId}" not found` });
            // Return the EXTRACTED MARKDOWN CONTENT (not just metadata) so both
            // native and CLI-via-MCP agents get readable text instead of a
            // filesystem path they cannot open. Falls back to on-demand
            // conversion when the upload-time markdown is missing.
            const { readAttachmentMarkdown } = await import("../../files/attachment-markdown.js");
            const md = await readAttachmentMarkdown(att);
            return jsonResult({
              status: "ok",
              attachment: att,
              name: md.name,
              mimeType: md.mimeType,
              markdown: md.markdown,
              charCount: md.charCount,
              truncated: md.truncated,
              markdownSource: md.source,
            });
          }

          default:
            return jsonResult({ status: "error", error: `Unknown action: ${action}` });
        }
      } catch (err: any) {
        log.error("Kanban tool error", { action, error: err.message });
        return jsonResult({ status: "error", error: err.message });
      }
    },
  };
}

// ── Local store backend (source of truth when Notion is off/down) ─────────

/** True when the id is a local kanban row that has no Notion page yet. */
function isLocalOnlyId(kind: "project" | "task", id: string | null | undefined): boolean {
  if (!id) return false;
  try {
    return localKanban.resolveKanbanId(kind, id).where === "local";
  } catch {
    return false;
  }
}

/** Map a local id that has since been mirrored onto its Notion page id. */
function notionPageIdFor(kind: "project" | "task", id: string): string {
  try {
    const r = localKanban.resolveKanbanId(kind, id);
    return r.where === "notion" ? r.notionId : id;
  } catch {
    return id;
  }
}

function localProjectToTool(p: localKanban.KanbanProjectShape): Record<string, unknown> {
  return { ...p, source: "local" };
}

function localTaskToTool(t: localKanban.KanbanTaskShape): Record<string, unknown> {
  return { ...t, source: "local" };
}

/** Agent vocabulary → local store patch (status ids already match). */
function localTaskPatch(patch: Record<string, any>): Partial<localKanban.KanbanTaskShape> {
  const out: Partial<localKanban.KanbanTaskShape> = {};
  if (patch.title !== undefined) out.title = patch.title;
  if (patch.description !== undefined) out.description = patch.description;
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.status === "done") out.done = true;
  if (patch.priority !== undefined) out.priority = patch.priority;
  if (patch.assignee !== undefined) out.assignee = patch.assignee;
  if (patch.projectId !== undefined) out.projectId = patch.projectId;
  if (patch.dueDate !== undefined) out.dueDate = patch.dueDate;
  return out;
}

function createTaskLocally(task: {
  title: string;
  projectId?: string;
  description?: string;
  status?: string;
  priority?: string;
  assignee?: string;
}): localKanban.KanbanTaskShape {
  const created = localKanban.upsertTask({
    title: task.title,
    description: task.description ?? "",
    status: task.status || "todo",
    priority: task.priority || "medium",
    assignee: task.assignee || undefined,
    projectId: task.projectId ?? null,
  });
  log.info("Created task locally", { id: created.id, title: task.title });
  broadcastKanbanChanged({
    entity: "task",
    op: "create",
    id: created.id,
    projectId: task.projectId ?? null,
    title: task.title,
  });
  return created;
}

function createProjectLocally(project: {
  name: string;
  description?: string;
  types?: string[];
  primaryNode?: string;
  nodes?: string[];
  projectDirectory?: string;
  shared?: boolean;
  parentProjectId?: string | null;
}): localKanban.KanbanProjectShape {
  const created = localKanban.upsertProject({
    name: project.name,
    description: project.description ?? "",
    primaryNode: project.primaryNode,
    nodes: project.nodes,
    projectDirectory: project.projectDirectory,
    shared: project.shared,
    parentProjectId: project.parentProjectId ?? null,
  });
  ensureProjectDirectoryLink(created.id, project.projectDirectory);
  invalidateProjectCache();
  log.info("Created project locally", { id: created.id, name: project.name });
  broadcastKanbanChanged({ entity: "project", op: "create", id: created.id, title: project.name });
  return created;
}

function updateTaskLocally(taskId: string, patch: Record<string, any>) {
  if (!localKanban.getTask(taskId)) {
    return jsonResult({ status: "error", error: `Task "${taskId}" not found` });
  }
  const updated = localKanban.upsertTask({ id: taskId, ...localTaskPatch(patch) });
  broadcastKanbanChanged({
    entity: "task",
    op: "update",
    id: taskId,
    projectId: updated.projectId ?? null,
    title: updated.title,
  });
  if (patch.status === "done") {
    recordHqProgress({
      kind: "task.done",
      objectId: taskId,
      title: updated.title || "Untitled",
      source: "kanban",
      origin: "agent",
      connKey: "agent-tool",
    });
  } else if (patch.status) {
    unrecordHqProgress("task.done", taskId);
  }
  return jsonResult({ status: "ok", task: updated });
}

function updateProjectLocally(
  projectId: string,
  patch: Record<string, any>,
  cascadeStatus: boolean,
) {
  if (!localKanban.getProject(projectId)) {
    return jsonResult({ status: "error", error: `Project "${projectId}" not found` });
  }
  const updated = localKanban.upsertProject({
    id: projectId,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    ...(patch.primaryNode !== undefined ? { primaryNode: patch.primaryNode } : {}),
    ...(patch.nodes !== undefined ? { nodes: patch.nodes } : {}),
    ...(patch.projectDirectory !== undefined ? { projectDirectory: patch.projectDirectory } : {}),
    ...(patch.shared !== undefined ? { shared: patch.shared } : {}),
    ...(patch.parentProjectId !== undefined ? { parentProjectId: patch.parentProjectId } : {}),
  });
  if (patch.projectDirectory) ensureProjectDirectoryLink(projectId, patch.projectDirectory);
  let cascadedTasks = 0;
  const targetTaskStatus =
    cascadeStatus && patch.status ? PROJECT_TO_TASK_STATUS[patch.status] : undefined;
  if (targetTaskStatus) {
    for (const t of localKanban.listTasks({ projectId })) {
      localKanban.upsertTask({
        id: t.id,
        status: targetTaskStatus,
        ...(targetTaskStatus === "done" ? { done: true } : {}),
      });
      cascadedTasks++;
    }
  }
  invalidateProjectCache();
  broadcastKanbanChanged({ entity: "project", op: "update", id: projectId, title: updated.name });
  if (cascadedTasks > 0) broadcastKanbanChanged({ entity: "task", op: "update", projectId });
  return jsonResult({
    status: "ok",
    project: updated,
    cascaded: targetTaskStatus
      ? { status: patch.status, taskStatus: targetTaskStatus, tasksUpdated: cascadedTasks }
      : undefined,
  });
}

// ── Handlers ──────────────────────────────────────────────

/**
 * Returns the system role resolution for a known kanban role, or null if
 * the role is unset or still pointed at the legacy kanban-* stubs.
 */
function resolveActiveKanbanRole(role: "projects" | "tasks") {
  try {
    // getDatabasesStore auto-seeds kanban stubs + default roles on first call.
    const store = getDatabasesStore();
    const resolved = store.resolveSystemRole(role);
    if (!resolved) return null;
    const legacySources = new Set(["kanban-projects", "kanban-tasks"]);
    if (legacySources.has(resolved.database.source)) return null;
    return { store, ...resolved };
  } catch {
    return null;
  }
}

function dbRowToKanbanProject(row: DatabaseRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.title,
    description: row.body ?? "",
    status: pickProp(row, "Status") ?? "",
    priority: pickProp(row, "Priority") ?? "",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    source: "database",
  };
}

function dbRowToKanbanTask(row: DatabaseRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    description: row.body ?? "",
    status: pickProp(row, "Status") ?? "",
    priority: pickProp(row, "Priority") ?? "",
    assignee: pickProp(row, "Assignee") ?? "",
    projectId: pickProp(row, "Project") ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    source: "database",
  };
}

function pickProp(row: DatabaseRow, name: string): string | null {
  for (const [key, val] of Object.entries(row.values)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      if (val.type === "select" || val.type === "status") return val.optionId;
      if (val.type === "title") return val.text;
      if (val.type === "richText") return val.markdown;
      if (val.type === "relation") return val.rowIds[0] ?? null;
    }
  }
  return null;
}

// Default cap on how many rows list_projects / list_tasks return. Boards can
// hold hundreds of rows; returning every one as a full object once dumped
// ~250k tokens into a 128k-window voice session and wedged it permanently.
// The agent narrows with `query` or raises `limit` when it truly needs more.
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

function resolveListLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_LIST_LIMIT);
}

function matchesQuery(name: unknown, query?: string): boolean {
  if (!query) return true;
  return String(name ?? "")
    .toLowerCase()
    .includes(query.toLowerCase());
}

/** Trim a project object to the fields worth carrying in a chat/voice reply. */
function compactProject(p: Record<string, unknown>): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    priority: p.priority,
    progress: p.progress,
    taskCount: p.taskCount,
    parentProjectId: p.parentProjectId ?? null,
    updatedAt: p.updatedAt,
  };
}

async function handleListProjects(
  opts: { query?: string; limit?: number; signal?: AbortSignal } = {},
) {
  const limit = resolveListLimit(opts.limit);

  const role = resolveActiveKanbanRole("projects");
  let source = role ? `database:${role.database.id}` : "notion-legacy";
  let all: Record<string, unknown>[];
  if (role) {
    all = role.store.listRows(role.database.id).map(dbRowToKanbanProject);
  } else if (notionKanbanReady("projects")) {
    try {
      all = (await queryAllPages(getProjectsDbId(), undefined, { signal: opts.signal })).map(
        mapNotionProject,
      );
      all.push(...localKanban.listNotionPendingProjects().map(localProjectToTool));
    } catch (err) {
      log.warn("list_projects: Notion unavailable, serving local store", {
        error: notionErrMessage(err),
      });
      source = "local";
      all = localKanban.listProjects().map(localProjectToTool);
    }
  } else {
    source = "local";
    all = localKanban.listProjects().map(localProjectToTool);
  }

  const filtered = opts.query
    ? all.filter((p) => matchesQuery((p as Record<string, unknown>).name, opts.query))
    : all;
  const returned = filtered.slice(0, limit);
  const projects = returned.map((p) => compactProject(p as Record<string, unknown>));

  return jsonResult({
    status: "ok",
    source,
    count: all.length,
    matched: filtered.length,
    returned: projects.length,
    truncated: filtered.length > projects.length,
    ...(opts.query ? { query: opts.query } : {}),
    ...(filtered.length > projects.length
      ? {
          note: `Showing ${projects.length} of ${filtered.length} matching projects. Narrow with query='<name>' or raise limit to see more.`,
        }
      : {}),
    projects,
  });
}

/** Trim a task object to the fields worth carrying in a chat/voice reply. */
function compactTask(t: Record<string, unknown>): Record<string, unknown> {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    assignee: t.assignee,
    projectId: t.projectId ?? null,
    dueDate: t.dueDate,
    updatedAt: t.updatedAt,
  };
}

function finalizeTaskList(
  allTasks: Record<string, unknown>[],
  extra: Record<string, unknown>,
  opts: { query?: string; limit?: number },
) {
  const limit = resolveListLimit(opts.limit);
  const filtered = opts.query
    ? allTasks.filter((t) => matchesQuery(t.title, opts.query))
    : allTasks;
  const returned = filtered.slice(0, limit).map(compactTask);
  return jsonResult({
    status: "ok",
    ...extra,
    count: allTasks.length,
    matched: filtered.length,
    returned: returned.length,
    truncated: filtered.length > returned.length,
    ...(opts.query ? { query: opts.query } : {}),
    ...(filtered.length > returned.length
      ? {
          note: `Showing ${returned.length} of ${filtered.length} matching tasks. Narrow with query, filter_project, filter_status, or raise limit.`,
        }
      : {}),
    tasks: returned,
  });
}

async function handleListTasks(filters: {
  projectId?: string;
  status?: string;
  assignee?: string;
  node?: string;
  query?: string;
  limit?: number;
  signal?: AbortSignal;
}) {
  let notionFilter: any = undefined;
  const filterConditions: any[] = [];

  // Build Notion filter for project relation
  if (filters.projectId) {
    filterConditions.push({
      property: "Project",
      relation: { contains: filters.projectId },
    });
  }

  // Build Notion filter for node (federation)
  if (filters.node) {
    filterConditions.push({
      property: "Node",
      select: { equals: filters.node },
    });
  }

  // Combine filters with AND if multiple
  if (filterConditions.length === 1) {
    notionFilter = filterConditions[0];
  } else if (filterConditions.length > 1) {
    notionFilter = { and: filterConditions };
  }

  // Role-aware path first: if tasks role is reassigned to a native / imported DB, serve from there.
  const role = resolveActiveKanbanRole("tasks");
  if (role) {
    const rows = role.store.listRows(role.database.id);
    let tasks = rows.map(dbRowToKanbanTask);
    if (filters.projectId) {
      tasks = tasks.filter((t) => t.projectId === filters.projectId);
    }
    if (filters.status) {
      tasks = tasks.filter((t) => String(t.status).toLowerCase() === filters.status!.toLowerCase());
    }
    if (filters.assignee) {
      tasks = tasks.filter((t) => t.assignee === filters.assignee);
    }
    return finalizeTaskList(
      tasks as Record<string, unknown>[],
      { source: `database:${role.database.id}` },
      { query: filters.query, limit: filters.limit },
    );
  }

  const localTaskList = () => {
    let local = localKanban
      .listTasks({
        projectId: filters.projectId,
        status: filters.status,
        assignee: filters.assignee,
        node: filters.node,
      })
      .map(localTaskToTool);
    return finalizeTaskList(
      local as Record<string, unknown>[],
      { source: "local" },
      { query: filters.query, limit: filters.limit },
    );
  };
  if (!notionKanbanReady("tasks")) return localTaskList();
  let pages: any[];
  try {
    pages = await queryAllPages(getTasksDbId(), notionFilter, { signal: filters.signal });
  } catch (err) {
    log.warn("list_tasks: Notion unavailable, serving local store", {
      error: notionErrMessage(err),
    });
    return localTaskList();
  }
  let tasks: any[] = pages.map(mapNotionTask);
  tasks.push(
    ...localKanban
      .listNotionPendingTasks(filters.projectId ? { projectId: filters.projectId } : undefined)
      .map(localTaskToTool),
  );

  // Apply local filters (status is mapped from Notion, so filter after mapping)
  if (filters.status) {
    tasks = tasks.filter((t) => t.status === filters.status);
  }
  if (filters.assignee) {
    tasks = tasks.filter((t) =>
      (t.assignee || "").toLowerCase().includes(filters.assignee!.toLowerCase()),
    );
  }

  return finalizeTaskList(
    tasks as Record<string, unknown>[],
    {},
    {
      query: filters.query,
      limit: filters.limit,
    },
  );
}

async function handleCreateTask(task: {
  title: string;
  projectId?: string;
  description: string;
  status: string;
  priority: string;
  assignee: string;
  // Federation properties
  node?: string;
  directory?: string;
  computeRequirements?: string[];
  delegatedTo?: string;
  sourceNode?: string;
}) {
  if (!notionKanbanReady("tasks") || isLocalOnlyId("project", task.projectId)) {
    return jsonResult({ status: "ok", task: createTaskLocally(task) });
  }
  try {
    return await handleCreateTaskInNotion({
      ...task,
      projectId: task.projectId ? notionPageIdFor("project", task.projectId) : undefined,
    });
  } catch (err) {
    log.warn("create_task: Notion unavailable, saved locally (sync queued)", {
      error: notionErrMessage(err),
    });
    return jsonResult({ status: "ok", task: createTaskLocally(task), syncPending: true });
  }
}

async function handleCreateTaskInNotion(task: Parameters<typeof handleCreateTask>[0]) {
  const dbId = getTasksDbId();
  const schema = await fetchDatabaseSchema(dbId);
  const titleProp = schema?.titleProp ?? "Task Name";
  const has = (name: string) => !schema || schema.props.has(name);
  const notionStatus = KANBAN_TO_NOTION_TASK_STATUS[task.status] || "Not started";
  const notionPriority = LOCAL_PRIORITY_TO_NOTION[task.priority];

  const properties: Record<string, any> = {
    [titleProp]: { title: [{ text: { content: task.title } }] },
  };
  // Wizard schema names the status field "Status Update"; some legacy DBs
  // still use "Status". Try the wizard name first, fall back to legacy.
  if (has("Status Update")) {
    properties["Status Update"] = { status: { name: notionStatus } };
  } else if (has("Status")) {
    properties.Status = { status: { name: notionStatus } };
  }

  if (task.description && has("Description")) {
    properties.Description = { rich_text: [{ text: { content: task.description } }] };
  }
  if (notionPriority) {
    if (has("Priority Level")) {
      properties["Priority Level"] = { select: { name: notionPriority } };
    } else if (has("Priority")) {
      properties.Priority = { select: { name: notionPriority } };
    }
  }
  if (task.projectId && has("Project")) {
    properties.Project = { relation: [{ id: task.projectId }] };
  }
  if (task.node && has("Node")) {
    properties.Node = { select: { name: task.node } };
  }
  if (task.directory && has("Directory")) {
    properties.Directory = { rich_text: [{ text: { content: task.directory } }] };
  }
  if (task.computeRequirements?.length && has("Compute Requirements")) {
    properties["Compute Requirements"] = {
      multi_select: task.computeRequirements.map((req) => ({ name: req })),
    };
  }
  if (task.delegatedTo && has("Delegated To")) {
    properties["Delegated To"] = { rich_text: [{ text: { content: task.delegatedTo } }] };
  }
  if (task.sourceNode && has("Source Node")) {
    properties["Source Node"] = { select: { name: task.sourceNode } };
  }

  const page = await notionFetch("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: dbId },
      properties,
    }),
  });

  const newTask = mapNotionTask(page);

  // ── Sync to local SQLite store for Systems Map ──────────
  // Use Notion page ID as local ID for proper project linking
  try {
    const localStore = getLocalStore();
    const now = Date.now();
    // Raw upsert to control the ID
    (localStore as any).db
      .prepare(`
      INSERT OR REPLACE INTO tasks (id, projectId, title, description, status, priority, done, notionPageId, createdAt, updatedAt, completedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        newTask.id, // Use Notion page ID as local ID
        task.projectId || "default", // Link to project by Notion ID
        task.title,
        task.description || "",
        task.status,
        task.priority || "medium",
        task.status === "done" ? 1 : 0,
        newTask.id, // notionPageId
        now,
        now,
        task.status === "done" ? now : null,
      );
    log.info("Synced task to local store", { id: newTask.id, projectId: task.projectId });
  } catch (syncErr: any) {
    log.warn("Failed to sync task to local store (continuing)", { error: syncErr.message });
  }

  log.info("Created task in Notion", { id: newTask.id, title: task.title, node: task.node });
  broadcastKanbanChanged({
    entity: "task",
    op: "create",
    id: newTask.id,
    projectId: task.projectId ?? null,
    title: task.title,
  });
  return jsonResult({ status: "ok", task: newTask });
}

async function handleCreateProject(project: {
  name: string;
  description: string;
  types: string[];
  // Federation properties
  primaryNode?: string;
  nodes?: string[]; // All nodes assigned to this project
  projectDirectory?: string;
  shared?: boolean;
  // Parent-child hierarchy
  parentProjectId?: string | null;
}) {
  if (!notionKanbanReady("projects") || isLocalOnlyId("project", project.parentProjectId)) {
    return jsonResult({ status: "ok", project: createProjectLocally(project) });
  }
  try {
    return await handleCreateProjectInNotion(project);
  } catch (err) {
    log.warn("create_project: Notion unavailable, saved locally (sync queued)", {
      error: notionErrMessage(err),
    });
    return jsonResult({ status: "ok", project: createProjectLocally(project), syncPending: true });
  }
}

async function handleCreateProjectInNotion(project: Parameters<typeof handleCreateProject>[0]) {
  const dbId = getProjectsDbId();
  const schema = await fetchDatabaseSchema(dbId);
  // Title field varies by DB: wizard creates "Project", legacy installs may
  // have "Name". Without this lookup we'd send "Project" and fail on a
  // legacy DB, or send "Name" and fail on the wizard's DB.
  const titleProp = schema?.titleProp ?? "Project";
  const has = (name: string) => !schema || schema.props.has(name);

  const properties: Record<string, any> = {
    [titleProp]: { title: [{ text: { content: project.name } }] },
  };
  if (project.description && has("Description")) {
    properties.Description = { rich_text: [{ text: { content: project.description } }] };
  }
  if (project.types.length && has("Type")) {
    properties.Type = { multi_select: project.types.map((t) => ({ name: t })) };
  }
  if (project.primaryNode && has("Primary Node")) {
    properties["Primary Node"] = { select: { name: project.primaryNode } };
  }
  if (project.nodes?.length && has("Nodes")) {
    properties["Nodes"] = { multi_select: project.nodes.map((n) => ({ name: n })) };
  }
  if (project.projectDirectory && has("Project Directory")) {
    properties["Project Directory"] = {
      rich_text: [{ text: { content: project.projectDirectory } }],
    };
  }
  if (project.shared !== undefined && has("Shared")) {
    properties.Shared = { checkbox: project.shared };
  }
  // Write parent relation — lazily ensure the Notion DB property exists
  if (project.parentProjectId) {
    const propertyEnsured = await ensureParentProjectRelation(dbId).catch(() => false);
    if (propertyEnsured) {
      properties["Parent Project"] = { relation: [{ id: project.parentProjectId }] };
    }
  }

  const page = await notionFetch("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: dbId },
      properties,
    }),
  });

  const newProject = mapNotionProject(page);

  // ── Sync to local SQLite store for Systems Map ──────────
  // Use Notion page ID as local ID for proper task linking
  try {
    const localStore = getLocalStore();
    const now = Date.now();
    // Raw upsert to control the ID with federation properties
    (localStore as any).db
      .prepare(`
      INSERT OR REPLACE INTO projects (id, name, description, color, status, notionPageId, primaryNode, nodes, projectDirectory, shared, parentProjectId, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        newProject.id, // Use Notion page ID as local ID
        project.name,
        project.description || "",
        "#22c55e", // Default green
        "In progress", // Default status
        newProject.id, // notionPageId
        project.primaryNode || null,
        project.nodes ? JSON.stringify(project.nodes) : null,
        project.projectDirectory || null,
        project.shared ? 1 : 0,
        project.parentProjectId || null,
        now,
        now,
      );
    log.info("Synced project to local store", { id: newProject.id, nodes: project.nodes });
  } catch (syncErr: any) {
    log.warn("Failed to sync project to local store (continuing)", { error: syncErr.message });
  }

  // Auto-link the local directory so it shows up as a clickable file-link
  // on the project — agents create+open these in the same loop, so this saves
  // a follow-up call every time. Idempotent + non-fatal.
  ensureProjectDirectoryLink(newProject.id, project.projectDirectory);

  log.info("Created project in Notion", {
    id: newProject.id,
    name: project.name,
    primaryNode: project.primaryNode,
    nodes: project.nodes,
  });
  broadcastKanbanChanged({
    entity: "project",
    op: "create",
    id: newProject.id,
    title: project.name,
  });
  return jsonResult({ status: "ok", project: newProject });
}

async function handleUpdateTask(taskId: string, patch: Record<string, any>) {
  if (!notionKanbanReady("tasks") || isLocalOnlyId("task", taskId)) {
    return updateTaskLocally(taskId, patch);
  }
  taskId = notionPageIdFor("task", taskId);
  const dbId = getTasksDbId();
  const schema = await fetchDatabaseSchema(dbId);
  const titleProp = schema?.titleProp ?? "Task Name";
  const has = (name: string) => !schema || schema.props.has(name);
  const properties: Record<string, any> = {};

  if (patch.title) {
    properties[titleProp] = { title: [{ text: { content: patch.title } }] };
  }
  if (patch.description && has("Description")) {
    properties.Description = { rich_text: [{ text: { content: patch.description } }] };
  }
  if (patch.status) {
    const notionStatus = KANBAN_TO_NOTION_TASK_STATUS[patch.status];
    if (notionStatus) {
      if (has("Status Update")) {
        properties["Status Update"] = { status: { name: notionStatus } };
      } else if (has("Status")) {
        properties.Status = { status: { name: notionStatus } };
      }
    }
  }
  if (patch.priority) {
    const notionPriority = LOCAL_PRIORITY_TO_NOTION[patch.priority];
    if (notionPriority) {
      if (has("Priority Level")) {
        properties["Priority Level"] = { select: { name: notionPriority } };
      } else if (has("Priority")) {
        properties.Priority = { select: { name: notionPriority } };
      }
    }
  }
  if (patch.status && has("Done")) {
    // Moving a task off Done must clear the checkbox too.
    properties.Done = { checkbox: patch.status === "done" };
  }
  if (patch.projectId && has("Project")) {
    properties.Project = { relation: [{ id: patch.projectId }] };
  }
  if (patch.node && has("Node")) {
    properties.Node = { select: { name: patch.node } };
  }
  if (patch.directory && has("Directory")) {
    properties.Directory = { rich_text: [{ text: { content: patch.directory } }] };
  }
  if (patch.computeRequirements?.length && has("Compute Requirements")) {
    properties["Compute Requirements"] = {
      multi_select: patch.computeRequirements.map((req: string) => ({ name: req })),
    };
  }
  if (patch.delegatedTo && has("Delegated To")) {
    properties["Delegated To"] = { rich_text: [{ text: { content: patch.delegatedTo } }] };
  }
  if (patch.sourceNode && has("Source Node")) {
    properties["Source Node"] = { select: { name: patch.sourceNode } };
  }

  if (Object.keys(properties).length === 0) {
    return jsonResult({ status: "error", error: "No valid fields to update" });
  }

  await notionFetch(`/pages/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });

  // Fetch updated page to return fresh data
  const page = await notionFetch(`/pages/${taskId}`, { method: "GET" });
  const updated = mapNotionTask(page);
  log.info("Updated task in Notion", { id: taskId, patch: Object.keys(patch) });
  noteKanbanTaskWrite(taskId, agentTaskWriteFields(patch), {
    source: "agent",
    pushed: true,
    projectId: (updated as any)?.projectId ?? patch.projectId ?? null,
    title: (updated as any)?.title ?? patch.title,
  });
  // Business HQ progress log: this path bypasses kanban.tasks.update, so record
  // the completion here with origin "agent" (the RPC's `source: "agent"`).
  // Bursts from the agent tool fall under the same bulk heuristic.
  if (patch.status === "done") {
    recordHqProgress({
      kind: "task.done",
      objectId: taskId,
      title: (updated as any)?.title ?? patch.title ?? "Untitled",
      source: "kanban",
      origin: "agent",
      connKey: "agent-tool",
    });
  } else if (patch.status) {
    unrecordHqProgress("task.done", taskId);
  }
  return jsonResult({ status: "ok", task: updated });
}

async function handleUpdateProject(
  projectId: string,
  patch: Record<string, any>,
  cascadeStatus: boolean,
) {
  if (!notionKanbanReady("projects") || isLocalOnlyId("project", projectId)) {
    return updateProjectLocally(projectId, patch, cascadeStatus);
  }
  projectId = notionPageIdFor("project", projectId);
  const dbId = getProjectsDbId();
  const schema = await fetchDatabaseSchema(dbId);
  const titleProp = schema?.titleProp ?? "Project";
  const has = (name: string) => !schema || schema.props.has(name);
  const properties: Record<string, any> = {};

  if (patch.name) {
    properties[titleProp] = { title: [{ text: { content: patch.name } }] };
  }
  if (patch.description && has("Description")) {
    properties.Description = { rich_text: [{ text: { content: patch.description } }] };
  }
  if (patch.status && has("Status")) {
    const notionStatus = KANBAN_TO_NOTION_PROJECT_STATUS[patch.status] || patch.status;
    properties.Status = { status: { name: notionStatus } };
  }
  if (patch.priority && has("Priority")) {
    properties.Priority = { select: { name: patch.priority } };
  }
  if (patch.types?.length && has("Type")) {
    properties.Type = { multi_select: patch.types.map((t: string) => ({ name: t })) };
  }
  if (patch.primaryNode && has("Primary Node")) {
    properties["Primary Node"] = { select: { name: patch.primaryNode } };
  }
  if (patch.nodes?.length && has("Nodes")) {
    properties["Nodes"] = { multi_select: patch.nodes.map((n: string) => ({ name: n })) };
  }
  if (patch.projectDirectory && has("Project Directory")) {
    properties["Project Directory"] = {
      rich_text: [{ text: { content: patch.projectDirectory } }],
    };
  }
  if (patch.shared !== undefined && has("Shared")) {
    properties.Shared = { checkbox: patch.shared };
  }
  if (patch.parentProjectId) {
    const propertyEnsured = await ensureParentProjectRelation(dbId).catch(() => false);
    if (propertyEnsured && has("Parent Project")) {
      properties["Parent Project"] = { relation: [{ id: patch.parentProjectId }] };
    }
  }

  if (Object.keys(properties).length === 0 && !cascadeStatus) {
    return jsonResult({ status: "error", error: "No valid fields to update" });
  }

  // Update the project in Notion if we have properties to update
  if (Object.keys(properties).length > 0) {
    await notionFetch(`/pages/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });
  }

  // Maintain the clickable directory link in lockstep with the Notion field.
  // Idempotent + non-fatal.
  if (patch.projectDirectory) {
    ensureProjectDirectoryLink(projectId, patch.projectDirectory);
  }

  // ── Cascade status to all tasks ──────────────────────────
  let cascadedTasks = 0;
  if (cascadeStatus && patch.status) {
    const targetTaskStatus = PROJECT_TO_TASK_STATUS[patch.status];
    if (targetTaskStatus) {
      // Get all tasks for this project
      const tasksFilter = {
        property: "Project",
        relation: { contains: projectId },
      };
      // The tasks DB may not be bound to Notion even when projects are —
      // cascade through the local store then (Notion is optional).
      if (!notionKanbanReady("tasks")) {
        for (const t of localKanban.listTasks({ projectId })) {
          localKanban.upsertTask({ id: t.id, status: targetTaskStatus });
          cascadedTasks++;
        }
      }
      const taskPages = notionKanbanReady("tasks")
        ? await queryAllPages(getTasksDbId(), tasksFilter)
        : [];

      const notionTaskStatus = KANBAN_TO_NOTION_TASK_STATUS[targetTaskStatus] || "Not started";
      const isDone = targetTaskStatus === "done";

      // Update each task's status
      for (const taskPage of taskPages) {
        try {
          const taskProps: Record<string, any> = {
            "Status Update": { status: { name: notionTaskStatus } },
          };
          if (isDone) {
            taskProps.Done = { checkbox: true };
          }

          await notionFetch(`/pages/${taskPage.id}`, {
            method: "PATCH",
            body: JSON.stringify({ properties: taskProps }),
          });
          cascadedTasks++;
        } catch (err: any) {
          log.warn("Failed to cascade status to task", { taskId: taskPage.id, error: err.message });
        }
      }

      log.info("Cascaded project status to tasks", {
        projectId,
        projectStatus: patch.status,
        taskStatus: targetTaskStatus,
        tasksUpdated: cascadedTasks,
      });
    }
  }

  // Fetch updated project to return fresh data
  const page = await notionFetch(`/pages/${projectId}`, { method: "GET" });
  const updated = mapNotionProject(page);
  log.info("Updated project in Notion", {
    id: projectId,
    patch: Object.keys(patch),
    cascadedTasks,
  });

  broadcastKanbanChanged({
    entity: "project",
    op: "update",
    id: projectId,
    title: (updated as any)?.name ?? patch.name,
  });
  // A cascade rewrote the project's tasks too — tell the board to reload them.
  if (cascadedTasks > 0) {
    broadcastKanbanChanged({ entity: "task", op: "update", projectId });
  }

  return jsonResult({
    status: "ok",
    project: updated,
    cascaded:
      cascadeStatus && patch.status
        ? {
            status: patch.status,
            taskStatus: PROJECT_TO_TASK_STATUS[patch.status],
            tasksUpdated: cascadedTasks,
          }
        : undefined,
  });
}

// ── Attachment handlers (local kanban store) ──────────────

async function handleAddAttachment(input: {
  projectId: string;
  url?: string;
  path?: string;
  name?: string;
  mimeType?: string;
  caption?: string;
  size?: number;
}) {
  const storedPath = input.url || input.path;
  if (!storedPath) {
    return jsonResult({ status: "error", error: "attachment_url or attachment_path required" });
  }

  // Derive display name: caption > explicit name > filename from path/url
  const derivedName = input.caption || input.name || deriveNameFromPath(storedPath) || "attachment";

  // Infer MIME type from extension when not provided (so image thumbnails render)
  const mimeType = input.mimeType || inferMimeFromPath(storedPath);

  try {
    const att = getLocalStore().createProjectAttachment({
      projectId: input.projectId,
      name: derivedName,
      path: storedPath,
      size: input.size ?? 0,
      mimeType,
    });
    log.info("Added project attachment", {
      projectId: input.projectId,
      attachmentId: att.id,
      kind: mimeType?.startsWith("image/") ? "image" : "file",
    });
    return jsonResult({ status: "ok", attachment: att });
  } catch (err: any) {
    return jsonResult({ status: "error", error: err.message });
  }
}

async function handleRemoveAttachment(attachmentId: string) {
  try {
    const ok = getLocalStore().deleteProjectAttachment(attachmentId);
    return jsonResult({ status: ok ? "ok" : "error", deleted: ok });
  } catch (err: any) {
    return jsonResult({ status: "error", error: err.message });
  }
}

// ── Project page content (markdown ↔ blocks) ──────────────
// The projects content panel renders block-formatted content. These
// handlers convert markdown into blocks on write and back to markdown on
// read, so agents speak markdown and the UI displays formatted text — same
// behavior as the database row body editor.

/** The document-key suffix the project spec panel stores its blocks under. */
const SPEC_DOC_SUFFIX = "::spec";

/**
 * Resolve which project document the *_project_content_md actions target.
 *
 * Default (content_target unset or 'notes') is the free-form page body, keyed
 * by the bare projectId. content_target='spec' routes to the structured spec
 * panel, which the UI's project-spec controller stores under a distinct
 * '<projectId>::spec' document key — writing to the bare id would land in Notes
 * and leave the spec tab showing its empty template. Idempotent: an id already
 * ending in ::spec is left untouched.
 */
function resolveContentDocId(params: Record<string, unknown>, projectId: string): string {
  const target = readStringParam(params, "content_target");
  if (target === "spec" && !projectId.endsWith(SPEC_DOC_SUFFIX)) {
    return `${projectId}${SPEC_DOC_SUFFIX}`;
  }
  return projectId;
}

function handleSetProjectMarkdown(projectId: string, markdown: string) {
  try {
    const blocks = markdownToBlocks(markdown);
    const result = getLocalStore().saveProjectContentBlocks(projectId, blocks);
    return jsonResult({
      status: "ok",
      projectId,
      blockCount: blocks.length,
      updatedAt: result.updatedAt,
    });
  } catch (err: any) {
    return jsonResult({ status: "error", error: err.message });
  }
}

function handleAppendProjectMarkdown(projectId: string, markdown: string) {
  try {
    const stored = getLocalStore().getProjectContentBlocks(projectId);
    const existing = Array.isArray(stored.blocks) ? (stored.blocks as Block[]) : [];
    const appended = markdownToBlocks(markdown);
    const merged = [...existing, ...appended];
    const result = getLocalStore().saveProjectContentBlocks(projectId, merged);
    return jsonResult({
      status: "ok",
      projectId,
      appended: appended.length,
      blockCount: merged.length,
      updatedAt: result.updatedAt,
    });
  } catch (err: any) {
    return jsonResult({ status: "error", error: err.message });
  }
}

function handleGetProjectMarkdown(projectId: string, extra: Record<string, unknown> = {}) {
  try {
    const stored = getLocalStore().getProjectContentBlocks(projectId);
    const blocks = Array.isArray(stored.blocks) ? (stored.blocks as Block[]) : [];
    return jsonResult({
      status: "ok",
      projectId,
      markdown: blocksToMarkdown(blocks),
      blockCount: blocks.length,
      updatedAt: stored.updatedAt,
      ...extra,
    });
  } catch (err: any) {
    return jsonResult({ status: "error", error: err.message });
  }
}

function handleSetTaskMarkdown(taskId: string, markdown: string) {
  try {
    const blocks = markdownToBlocks(markdown);
    const result = getLocalStore().saveTaskContentBlocks(taskId, blocks);
    return jsonResult({
      status: "ok",
      taskId,
      blockCount: blocks.length,
      updatedAt: result.updatedAt,
    });
  } catch (err: any) {
    return jsonResult({ status: "error", error: err.message });
  }
}

function handleAppendTaskMarkdown(taskId: string, markdown: string) {
  try {
    const stored = getLocalStore().getTaskContentBlocks(taskId);
    const existing = Array.isArray(stored.blocks) ? (stored.blocks as Block[]) : [];
    const appended = markdownToBlocks(markdown);
    const merged = [...existing, ...appended];
    const result = getLocalStore().saveTaskContentBlocks(taskId, merged);
    return jsonResult({
      status: "ok",
      taskId,
      appended: appended.length,
      blockCount: merged.length,
      updatedAt: result.updatedAt,
    });
  } catch (err: any) {
    return jsonResult({ status: "error", error: err.message });
  }
}

function handleGetTaskMarkdown(taskId: string) {
  try {
    const stored = getLocalStore().getTaskContentBlocks(taskId);
    const blocks = Array.isArray(stored.blocks) ? (stored.blocks as Block[]) : [];
    return jsonResult({
      status: "ok",
      taskId,
      markdown: blocksToMarkdown(blocks),
      blockCount: blocks.length,
      updatedAt: stored.updatedAt,
    });
  } catch (err: any) {
    return jsonResult({ status: "error", error: err.message });
  }
}

function deriveNameFromPath(p: string): string | undefined {
  try {
    const clean = p.split("?")[0]!.split("#")[0]!;
    const last = clean.split(/[\\/]/).pop();
    return last && last.length > 0 ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}

function inferMimeFromPath(p: string): string | undefined {
  const m = p.toLowerCase().match(/\.(png|jpe?g|gif|webp|svg|avif|bmp|mp4|mov|webm|pdf)(?:\?|#|$)/);
  if (!m) return undefined;
  const ext = m[1];
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    avif: "image/avif",
    bmp: "image/bmp",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    pdf: "application/pdf",
  };
  return map[ext];
}

// ── Standalone helpers for subagent registry ──────────────

// ── Project dedup / condensing ────────────────────────────

const PROJECT_FUZZY_OVERLAP_THRESHOLD = 0.7;
const PROJECT_FUZZY_RECENT_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
// Project statuses we consider "active" (worth merging into vs. creating new).
const ACTIVE_PROJECT_STATUSES = new Set([
  "Not started",
  "In progress",
  "Updating",
  "Awaiting Client",
  "Reviewing",
  "Paused",
]);

// ── Parent project registry ────────────────────────────────
// Maps keyword → canonical parent project name so spawned sub-projects
// condense under one parent instead of each becoming a top-level project.
//
// INTENTIONALLY EMPTY in the shipped package. This used to hard-code the
// developer's personal project taxonomy (real project names), which leaked
// that PII into every npm tarball AND polluted fresh installs with projects
// named after someone else's work. Parent resolution is now fully dynamic:
// findOrCreateProject() fuzzy-matches the hint against the install's own
// active local projects (see step 2 in that function). If a deployment wants
// canonical parent grouping it can populate this from local config — never
// from shipped constants.
const KNOWN_PARENT_MAPPINGS: Array<{ keywords: string[]; parent: string }> = [];

/**
 * Resolve the best parent project for a given hint by scanning KNOWN_PARENT_MAPPINGS.
 * Returns the parent project name if a keyword match is found, null otherwise.
 */
function resolveKnownParent(hint: string): string | null {
  const lower = hint.toLowerCase();
  for (const mapping of KNOWN_PARENT_MAPPINGS) {
    for (const kw of mapping.keywords) {
      if (lower.includes(kw)) return mapping.parent;
    }
  }
  return null;
}

function normalizeTitle(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(input: string): Set<string> {
  const stop = new Set([
    "a",
    "an",
    "the",
    "and",
    "or",
    "to",
    "for",
    "of",
    "in",
    "on",
    "with",
    "by",
    "is",
    "are",
    "be",
    "this",
    "that",
    "it",
    "as",
    "at",
    "from",
  ]);
  return new Set(
    normalizeTitle(input)
      .split(" ")
      .filter((w) => w.length > 2 && !stop.has(w)),
  );
}

function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const tok of a) if (b.has(tok)) intersection++;
  const denom = Math.min(a.size, b.size);
  return denom === 0 ? 0 : intersection / denom;
}

let projectCache: { fetchedAt: number; projects: any[] } | null = null;
const PROJECT_CACHE_TTL_MS = 30_000;

async function fetchProjectsCached(): Promise<any[]> {
  const now = Date.now();
  if (projectCache && now - projectCache.fetchedAt < PROJECT_CACHE_TTL_MS) {
    return projectCache.projects;
  }
  let projects: any[];
  if (notionKanbanReady("projects")) {
    try {
      projects = (await queryAllPages(getProjectsDbId())).map(mapNotionProject);
      projects.push(...localKanban.listNotionPendingProjects().map(localProjectToTool));
    } catch (err) {
      log.warn("project lookup: Notion unavailable, using local store", {
        error: notionErrMessage(err),
      });
      // Short-lived cache so a Notion outage doesn't stall every lookup.
      projects = localKanban.listProjects().map(localProjectToTool);
      projectCache = { fetchedAt: now - PROJECT_CACHE_TTL_MS + 5_000, projects };
      return projects;
    }
  } else {
    projects = localKanban.listProjects().map(localProjectToTool);
  }
  projectCache = { fetchedAt: now, projects };
  return projects;
}

export function invalidateProjectCache() {
  projectCache = null;
}

/**
 * Lazily add a self-referential "Parent Project" relation property to the
 * Notion projects database. Idempotent — if the property already exists this
 * is a no-op. Invalidates the schema cache on success so subsequent
 * fetchDatabaseSchema calls see the new property.
 *
 * Returns true if the property exists or was successfully created, false on
 * error (caller treats the parent relation as optional in that case).
 */
async function ensureParentProjectRelation(dbId: string): Promise<boolean> {
  try {
    const schema = await fetchDatabaseSchema(dbId);
    if (schema?.props.has("Parent Project")) return true;

    await notionFetch(`/databases/${dbId}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          "Parent Project": {
            relation: {
              database_id: dbId,
              type: "single_property",
              single_property: {},
            },
          },
        },
      }),
    });

    invalidateSchemaCache();
    log.info("Added 'Parent Project' relation to Notion DB", { dbId });
    return true;
  } catch (err: any) {
    log.warn("Failed to ensure 'Parent Project' relation on Notion DB", {
      dbId,
      error: err.message,
    });
    return false;
  }
}

/**
 * Resolve a project hint to a concrete projectId, creating one only if no
 * existing active project is a reasonable match. Returns the projectId plus
 * how it was matched ("exact" / "fuzzy" / "created").
 */
export async function findOrCreateProject(
  hint: string,
  opts?: { description?: string; types?: string[]; parentProjectHint?: string },
): Promise<{ projectId: string; matched: "exact" | "fuzzy" | "created"; project?: any } | null> {
  const trimmed = (hint || "").trim();
  if (!trimmed) return null;

  try {
    const projects = await fetchProjectsCached();
    const normalizedHint = normalizeTitle(trimmed);
    const hintTokens = tokenize(trimmed);
    const cutoff = Date.now() - PROJECT_FUZZY_RECENT_MS;

    // 0. Parent-prefix auto-detect (ANY status, ANY age).
    //    If the hint starts with an existing project's normalized name followed
    //    by a space (e.g. "InfiniBot hardware HUD" starts with "InfiniBot "),
    //    flag that project as the implicit parent so the new project is created
    //    as a child rather than a sibling top-level.
    //    Pick the longest matching prefix to be maximally specific.
    let impliedParentId: string | null = null;
    let impliedParentNameLen = 0;
    for (const p of projects) {
      const pNorm = normalizeTitle(p.name || "");
      if (
        pNorm.length > 0 &&
        pNorm !== normalizedHint &&
        normalizedHint.startsWith(pNorm + " ") &&
        pNorm.length > impliedParentNameLen
      ) {
        impliedParentId = p.id;
        impliedParentNameLen = pNorm.length;
      }
    }

    // 1. Exact normalized title match — any age, any status.
    for (const p of projects) {
      if (normalizeTitle(p.name || "") === normalizedHint && normalizedHint.length > 0) {
        return { projectId: p.id, matched: "exact", project: p };
      }
    }

    // 2. Fuzzy match against active recent projects only.
    let best: { project: any; score: number } | null = null;
    for (const p of projects) {
      if (!ACTIVE_PROJECT_STATUSES.has(p.status || "")) continue;
      const updated = typeof p.updatedAt === "number" ? p.updatedAt : 0;
      if (updated < cutoff) continue;
      const score = tokenOverlap(hintTokens, tokenize(p.name || ""));
      if (score >= PROJECT_FUZZY_OVERLAP_THRESHOLD && (!best || score > best.score)) {
        best = { project: p, score };
      }
    }
    if (best) {
      return { projectId: best.project.id, matched: "fuzzy", project: best.project };
    }

    // 3. Create new — enforce "AI Projects" type so it shows in agent views.
    //    Parent resolution order:
    //      a) explicit parentProjectHint (opt) → resolve/create that project first
    //      b) known parent from KNOWN_PARENT_MAPPINGS keyword match
    //      c) auto-detected prefix parent from step 0 (impliedParentId)
    let resolvedParentId: string | null = impliedParentId;
    if (opts?.parentProjectHint) {
      const parentResolved = await findOrCreateProject(opts.parentProjectHint, {
        description: `Auto-created parent for: ${trimmed}`,
      }).catch(() => null);
      if (parentResolved) resolvedParentId = parentResolved.projectId;
    }
    if (!resolvedParentId) {
      const knownParentName = resolveKnownParent(trimmed);
      if (knownParentName) {
        const parentResolved = await findOrCreateProject(knownParentName, {
          description: `Parent project for ${trimmed}`,
        }).catch(() => null);
        if (parentResolved) resolvedParentId = parentResolved.projectId;
      }
    }
    const types = (opts?.types?.length ? opts.types : ["AI Projects"]).slice();
    if (!types.includes("AI Projects")) types.unshift("AI Projects");
    const created = await mcpCreateProject({
      name: trimmed,
      description: opts?.description || "",
      types,
      parentProjectId: resolvedParentId,
    });
    if (!created) return null;
    invalidateProjectCache();
    return { projectId: created.id, matched: "created", project: created };
  } catch (err) {
    log.warn("findOrCreateProject failed", { hint: trimmed, error: (err as Error)?.message });
    return null;
  }
}

export async function mcpCreateProject(params: {
  name: string;
  description?: string;
  types?: string[];
  parentProjectId?: string | null;
}): Promise<{ id: string; name: string } | null> {
  const local = () => {
    try {
      const p = createProjectLocally({
        name: params.name,
        description: params.description ?? "",
        types: params.types ?? [],
        parentProjectId: params.parentProjectId ?? null,
      });
      return { id: String(p.id), name: params.name };
    } catch (err) {
      log.error("mcpCreateProject local create failed", { err });
      return null;
    }
  };
  if (!notionKanbanReady("projects") || isLocalOnlyId("project", params.parentProjectId)) {
    return local();
  }
  try {
    const dbId = getProjectsDbId();
    const schema = await fetchDatabaseSchema(dbId);
    const titleProp = schema?.titleProp ?? "Project";
    const has = (name: string) => !schema || schema.props.has(name);
    const types = params.types?.length ? params.types : ["AI Projects"];

    const properties: Record<string, any> = {
      [titleProp]: { title: [{ text: { content: params.name } }] },
    };
    if (params.description && has("Description")) {
      properties.Description = { rich_text: [{ text: { content: params.description } }] };
    }
    if (has("Type")) {
      properties.Type = { multi_select: types.map((t) => ({ name: t })) };
    }
    if (params.parentProjectId) {
      const propertyEnsured = await ensureParentProjectRelation(dbId).catch(() => false);
      if (propertyEnsured) {
        properties["Parent Project"] = { relation: [{ id: params.parentProjectId }] };
      }
    }

    const page = await notionFetch("/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { database_id: dbId },
        properties,
      }),
    });
    return { id: page.id, name: params.name };
  } catch (err) {
    log.warn("mcpCreateProject: Notion unavailable, saved locally (sync queued)", {
      error: notionErrMessage(err),
    });
    return local();
  }
}

export async function mcpCreateTask(params: {
  title: string;
  projectId?: string;
  description?: string;
  status?: string;
  priority?: string;
  assignee?: string;
}): Promise<{ id: string } | null> {
  const local = () => {
    try {
      const t = createTaskLocally({
        title: params.title,
        projectId: params.projectId,
        description: params.description ?? "",
        status: params.status ?? "todo",
        priority: params.priority ?? "medium",
        assignee: params.assignee ?? "",
      });
      return { id: String(t.id) };
    } catch (err) {
      log.error("mcpCreateTask local create failed", { err });
      return null;
    }
  };
  if (!notionKanbanReady("tasks") || isLocalOnlyId("project", params.projectId)) {
    return local();
  }
  try {
    if (params.projectId)
      params = { ...params, projectId: notionPageIdFor("project", params.projectId) };
    const dbId = getTasksDbId();
    const schema = await fetchDatabaseSchema(dbId);
    const titleProp = schema?.titleProp ?? "Task Name";
    const has = (name: string) => !schema || schema.props.has(name);
    const notionStatus = KANBAN_TO_NOTION_TASK_STATUS[params.status || "todo"] || "Not started";
    const notionPriority = LOCAL_PRIORITY_TO_NOTION[params.priority || "medium"];

    const properties: Record<string, any> = {
      [titleProp]: { title: [{ text: { content: params.title } }] },
    };
    if (has("Status Update")) {
      properties["Status Update"] = { status: { name: notionStatus } };
    } else if (has("Status")) {
      properties.Status = { status: { name: notionStatus } };
    }
    if (params.description && has("Description")) {
      properties.Description = { rich_text: [{ text: { content: params.description } }] };
    }
    if (notionPriority) {
      if (has("Priority Level")) {
        properties["Priority Level"] = { select: { name: notionPriority } };
      } else if (has("Priority")) {
        properties.Priority = { select: { name: notionPriority } };
      }
    }
    if (params.projectId && has("Project")) {
      properties.Project = { relation: [{ id: params.projectId }] };
    }

    const page = await notionFetch("/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { database_id: dbId },
        properties,
      }),
    });
    return { id: page.id };
  } catch (err) {
    log.warn("mcpCreateTask: Notion unavailable, saved locally (sync queued)", {
      error: notionErrMessage(err),
    });
    return local();
  }
}

export async function mcpUpdateTask(
  taskId: string,
  patch: Record<string, string>,
): Promise<boolean> {
  if (!notionKanbanReady("tasks") || isLocalOnlyId("task", taskId)) {
    try {
      const existing = localKanban.getTask(taskId);
      if (!existing) return false;
      localKanban.upsertTask({ id: taskId, ...localTaskPatch(patch) });
      broadcastKanbanChanged({ entity: "task", op: "update", id: taskId });
      return true;
    } catch (err) {
      log.warn("mcpUpdateTask local update failed", { error: notionErrMessage(err), taskId });
      return false;
    }
  }
  taskId = notionPageIdFor("task", taskId);
  try {
    const properties: Record<string, any> = {};
    if (patch.title) properties["Task Name"] = { title: [{ text: { content: patch.title } }] };
    // KK Tasks DB has no "Description" property — skip
    if (patch.status) {
      const ns = KANBAN_TO_NOTION_TASK_STATUS[patch.status];
      if (ns) properties["Status Update"] = { status: { name: ns } };
    }
    if (patch.priority) {
      const np = LOCAL_PRIORITY_TO_NOTION[patch.priority];
      if (np) properties["Priority Level"] = { select: { name: np } };
    }
    // Moving a task off Done must clear the checkbox too, or Notion keeps
    // reading it back as done.
    if (patch.status) properties.Done = { checkbox: patch.status === "done" };

    if (Object.keys(properties).length === 0) return false;

    await notionFetch(`/pages/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });
    // Versioned realtime update + ledger guard (stale lists can't revert it).
    noteKanbanTaskWrite(taskId, agentTaskWriteFields(patch), { source: "agent", pushed: true });
    return true;
  } catch (err) {
    log.error("mcpUpdateTask failed", { err, taskId });
    return false;
  }
}

/**
 * Append a paragraph block to a task page — used to log progress checkpoints
 * and final outputs against an autonomous run.
 */
export async function mcpAppendTaskNote(taskId: string, note: string): Promise<boolean> {
  if (!notionKanbanReady("tasks") || isLocalOnlyId("task", taskId)) {
    // Local tasks keep their notes in the task's own document page.
    try {
      const store = getLocalStore();
      const stored = store.getTaskContentBlocks(taskId);
      const existing = Array.isArray(stored.blocks) ? (stored.blocks as Block[]) : [];
      store.saveTaskContentBlocks(taskId, [...existing, ...markdownToBlocks(note)]);
      return true;
    } catch (err) {
      log.warn("mcpAppendTaskNote local append failed", { error: notionErrMessage(err), taskId });
      return false;
    }
  }
  taskId = notionPageIdFor("task", taskId);
  try {
    const text = note.length > 1900 ? note.slice(0, 1900) + "..." : note;
    await notionFetch(`/blocks/${taskId}/children`, {
      method: "PATCH",
      body: JSON.stringify({
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content: text } }],
            },
          },
        ],
      }),
    });
    return true;
  } catch (err) {
    log.warn("mcpAppendTaskNote failed", { err, taskId });
    return false;
  }
}
