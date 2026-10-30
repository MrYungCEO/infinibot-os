/**
 * Focus board store — the server copy of the up-to-5 priority items.
 *
 * Shared by the discipline.focus.* RPCs (focus-rpc.ts) and the `focus` agent
 * tool (focus-tool.ts), which used to keep two copies of this code writing a
 * cwd-relative `state/focus.json`. Now one file in the plugin data dir
 * (`<stateDir>/plugin-data/discipline/focus.json`; data-dir.ts moves the old
 * file in once). The control UI mirrors its board here so it survives a
 * browser change (controllers/focus.ts).
 *
 * Items added by id (agent tool / add.task / add.project) are resolved from
 * Notion when NOTION_API_KEY is set; items sent with a title (the UI) are
 * stored as given.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { disciplineDataDir, migrateLegacyData } from "./data-dir.js";

export const MAX_FOCUS_ITEMS = 5;

export interface FocusItem {
  id: string;
  type: "task" | "project";
  title: string;
  description?: string;
  status?: string;
  priority: number; // 1-5, position in focus list
  projectName?: string;
  projectId?: string;
  addedAt: number;
}

export interface FocusStore {
  items: FocusItem[];
  updatedAt: number;
}

let resolveStateDir: (() => string) | null = null;

/** Wire the tenant-aware state dir (plugin entry). */
export function setFocusStateDir(fn: () => string): void {
  resolveStateDir = fn;
}

function focusStorePath(): string {
  if (!resolveStateDir) throw new Error("focus store used before the plugin registered it");
  const stateDir = resolveStateDir();
  migrateLegacyData(stateDir);
  const dir = disciplineDataDir(stateDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "focus.json");
}

export function loadFocusStore(): FocusStore {
  const path = focusStorePath();
  try {
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, "utf-8"));
      return {
        items: Array.isArray(data.items) ? data.items : [],
        updatedAt: data.updatedAt || Date.now(),
      };
    }
  } catch {
    /* unreadable → empty board; the next save rewrites it */
  }
  return { items: [], updatedAt: Date.now() };
}

export function saveFocusStore(store: FocusStore): void {
  store.updatedAt = Date.now();
  writeFileSync(focusStorePath(), JSON.stringify(store, null, 2), "utf-8");
}

// ── Notion lookups (id → title/status) ─────────────────────────────────────

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/** Sync only makes sense with Notion; without it, a sync must not drop items. */
export function notionConfigured(): boolean {
  return Boolean(process.env.NOTION_API_KEY?.trim());
}

function getNotionApiKey(): string {
  const key = process.env.NOTION_API_KEY;
  if (!key) throw new Error("NOTION_API_KEY not set");
  return key;
}

/** A Notion page that definitely does not exist (as opposed to Notion being down). */
class NotionNotFoundError extends Error {}

async function notionFetch(path: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(`${NOTION_API_URL}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${getNotionApiKey()}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(opts.headers as Record<string, string> | undefined),
    },
    // Focus actions are interactive — never hang on a slow Notion.
    signal: AbortSignal.timeout(8_000),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 404 || (res.status === 400 && body?.code === "validation_error")) {
    throw new NotionNotFoundError(`Notion API ${res.status}: ${body?.message ?? "not found"}`);
  }
  if (!res.ok)
    throw new Error(`Notion API ${res.status}: ${body?.message || JSON.stringify(body)}`);
  return body;
}

function looksLikeNotionId(id: string): boolean {
  return /^[0-9a-f]{32}$/i.test(id.replace(/-/g, ""));
}

/**
 * The local kanban store is the source of truth for projects/tasks; Notion
 * is only an optional mirror. Loaded lazily so the plugin still boots if the
 * host build moves things around.
 */
async function localKanban(): Promise<
  typeof import("../../../src/databases/kanban-store-ops.js") | null
> {
  try {
    return await import("../../../src/databases/kanban-store-ops.js");
  } catch {
    return null;
  }
}

function extractTitle(props: any): string {
  for (const key of ["Project", "Task Name", "Name", "Task", "Title"]) {
    const prop = props[key];
    if (prop?.title) return prop.title.map((t: any) => t.plain_text || "").join("") || "Untitled";
  }
  return "Untitled";
}

function extractRichText(props: any, key: string): string {
  return (props[key]?.rich_text || []).map((t: any) => t.plain_text || "").join("");
}

function extractStatus(props: any, key: string): string {
  return props[key]?.status?.name || "";
}

/**
 * Resolve a task id → details. Local store first, then Notion when it's
 * connected and the id is a Notion page id.
 * Returns null only when the task definitely doesn't exist; throws when the
 * answer is unknown (Notion unreachable / erroring) so callers keep the item.
 */
export async function fetchTaskById(
  taskId: string,
): Promise<{ title: string; description: string; status: string; projectId?: string } | null> {
  const ops = await localKanban();
  const local = ops?.getTask(taskId);
  if (local) {
    return {
      title: local.title || "Untitled",
      description: local.description ?? "",
      status: local.status ?? "todo",
      projectId: local.projectId ?? undefined,
    };
  }
  if (!ops) throw new Error("local kanban store unavailable");
  if (!notionConfigured() || !looksLikeNotionId(taskId)) return null;
  try {
    const page = await notionFetch(`/pages/${taskId}`);
    const props = page.properties || {};
    return {
      title: extractTitle(props),
      description: extractRichText(props, "Description") || extractRichText(props, "Notes") || "",
      status:
        extractStatus(props, "Status Update") || extractStatus(props, "Status") || "Not started",
      projectId: props.Project?.relation?.[0]?.id,
    };
  } catch (err) {
    if (err instanceof NotionNotFoundError) return null;
    throw err;
  }
}

/** Same contract as fetchTaskById. */
export async function fetchProjectById(
  projectId: string,
): Promise<{ name: string; description: string; status: string } | null> {
  const ops = await localKanban();
  const local = ops?.getProject(projectId);
  if (local) {
    return {
      name: local.name || "Untitled",
      description: local.description ?? "",
      status: local.status ?? "Not started",
    };
  }
  if (!ops) throw new Error("local kanban store unavailable");
  if (!notionConfigured() || !looksLikeNotionId(projectId)) return null;
  try {
    const page = await notionFetch(`/pages/${projectId}`);
    const props = page.properties || {};
    return {
      name: extractTitle(props),
      description: extractRichText(props, "Description") || extractRichText(props, "Notes") || "",
      status: extractStatus(props, "Status") || "Not started",
    };
  } catch (err) {
    if (err instanceof NotionNotFoundError) return null;
    throw err;
  }
}

export async function fetchProjectName(projectId: string): Promise<string | undefined> {
  const project = await fetchProjectById(projectId).catch(() => null);
  return project?.name;
}
