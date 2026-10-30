/**
 * Notion page-level sync — pulls a single Notion PAGE (not database) into
 * InfiniBot as:
 *   • A note (markdown body, full recursive block content, idempotent by
 *     notionPageId so re-syncs update rather than duplicate).
 *   • A Kanban project matching the page title (created once, updated on re-sync).
 *   • Kanban tasks derived from:
 *       – to_do blocks anywhere in the page tree
 *       – rows of any child_database blocks embedded on the page
 *
 * Usage:
 *   const result = await syncNotionPage(pageId, apiKey, { stateDir });
 *
 * The gateway RPC `notion.page.sync` is the primary caller.
 */

import { randomUUID } from "node:crypto";
import {
  fetchPageBlocksDeep,
  collectFileUrlsFromBlocks,
  blocksToMarkdown,
  richTextToMarkdown,
} from "./notion-import.js";
import { NoteStore } from "../notes/store.js";
import { getKanbanStore } from "../tasks/store.js";

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const RATE_DELAY_MS = 350;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchNotion(path: string, apiKey: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${NOTION_API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Notion API ${res.status}: ${body?.message ?? JSON.stringify(body)}`);
  }
  return body;
}

/**
 * Extract a Notion page ID from a share URL or a plain UUID.
 *
 * Notion share URLs look like:
 *   https://www.notion.so/My-Page-Title-226f4bdd9bcf8277810a811916483984
 *   https://www.notion.so/226f4bdd9bcf8277810a811916483984
 *   https://notion.so/workspace/Some-Page-abc123def456...
 *
 * The ID is always the last 32-char hex segment (with or without dashes).
 */
export function extractNotionPageId(urlOrId: string): string {
  const stripped = urlOrId.trim().replace(/-/g, "");
  // UUID at end of URL
  const m = stripped.match(/([0-9a-f]{32})(?:[?#].*)?$/i);
  if (m) {
    // Reformat as standard Notion UUID: 8-4-4-4-12
    const hex = m[1]!;
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join("-");
  }
  // Assume it's already a valid ID
  return urlOrId.trim();
}

// ─── Block tree walkers ───────────────────────────────────────────

interface ToDoItem {
  text: string;
  checked: boolean;
  notionBlockId: string;
}

/** Collect all to_do blocks (recursively through children). */
function collectToDos(blocks: any[]): ToDoItem[] {
  const out: ToDoItem[] = [];
  const walk = (list: any[]): void => {
    for (const b of list) {
      if (b.type === "to_do") {
        const text = richTextToMarkdown(b.to_do?.rich_text);
        if (text.trim()) {
          out.push({ text: text.trim(), checked: Boolean(b.to_do?.checked), notionBlockId: b.id });
        }
      }
      if (Array.isArray(b.children)) walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

/** Collect IDs and titles of all child_page blocks. */
function collectSubpages(blocks: any[]): Array<{ id: string; title: string }> {
  const out: Array<{ id: string; title: string }> = [];
  for (const b of blocks) {
    if (b.type === "child_page") {
      out.push({ id: b.id, title: b.child_page?.title ?? "Untitled" });
    }
  }
  return out;
}

/** Collect IDs and titles of embedded child_database blocks. */
function collectChildDatabases(blocks: any[]): Array<{ id: string; title: string }> {
  const out: Array<{ id: string; title: string }> = [];
  for (const b of blocks) {
    if (b.type === "child_database") {
      out.push({ id: b.id, title: b.child_database?.title ?? "Untitled Database" });
    }
  }
  return out;
}

/** Pull all rows from a Notion database (paginated). */
async function queryAllRows(databaseId: string, apiKey: string): Promise<any[]> {
  const rows: any[] = [];
  let cursor: string | undefined;
  do {
    const body: any = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await fetchNotion(`/databases/${databaseId}/query`, apiKey, {
      method: "POST",
      body: JSON.stringify(body),
    });
    rows.push(...(res.results ?? []));
    cursor = res.has_more ? res.next_cursor : undefined;
    await sleep(RATE_DELAY_MS);
  } while (cursor);
  return rows;
}

/** Extract the title text from a Notion row's properties. */
function extractRowTitle(properties: Record<string, any>): string {
  for (const val of Object.values(properties)) {
    if (val?.type === "title") return richTextToMarkdown(val.title) || "";
  }
  return "";
}

/** Map Notion status/select name to a local TaskStatus. */
function mapNotionStatus(name: string | undefined): "todo" | "in_progress" | "done" {
  if (!name) return "todo";
  const lower = name.toLowerCase();
  if (lower.includes("done") || lower.includes("complete")) return "done";
  if (lower.includes("progress") || lower.includes("active")) return "in_progress";
  return "todo";
}

/** Derive status from a Notion page row's properties. */
function extractRowStatus(properties: Record<string, any>): "todo" | "in_progress" | "done" {
  const checked = Object.values(properties).find((v) => v?.type === "checkbox")?.checkbox;
  if (checked === true) return "done";
  for (const val of Object.values(properties)) {
    if (val?.type === "status") return mapNotionStatus(val.status?.name);
    if (val?.type === "select") return mapNotionStatus(val.select?.name);
  }
  return "todo";
}

// ─── Main export ──────────────────────────────────────────────────

export interface PageSyncResult {
  pageId: string;
  title: string;
  noteId: string;
  isNew: boolean;
  subpages: Array<{ id: string; title: string }>;
  mediaUrls: string[];
  tasksCreated: number;
  tasksUpdated: number;
  projectId: string;
  warnings: string[];
}

export interface PageSyncOptions {
  /** API key override. Falls back to NOTION_API_KEY env var. */
  apiKey?: string;
  /** State directory for NoteStore. Defaults to process.env.INFINIBOT_STATE_DIR or "state". */
  stateDir?: string;
  /** Max depth for sub-page recursion (default 2). */
  maxDepth?: number;
  /** Max blocks fetched per page (default 250). */
  maxBlocksPerPage?: number;
}

export async function syncNotionPage(
  urlOrId: string,
  opts: PageSyncOptions = {},
): Promise<PageSyncResult> {
  const apiKey = opts.apiKey ?? process.env.NOTION_API_KEY;
  if (!apiKey) throw new Error("No Notion API key provided (set NOTION_API_KEY or pass apiKey).");

  const stateDir = opts.stateDir ?? process.env.INFINIBOT_STATE_DIR ?? "state";
  const pageId = extractNotionPageId(urlOrId);
  const warnings: string[] = [];

  // ── 1. Fetch page metadata ──────────────────────────────────────
  const page = await fetchNotion(`/pages/${pageId}`, apiKey);
  const title =
    richTextToMarkdown(page.properties?.title?.title) ||
    Object.values(page.properties ?? {})
      .filter((v: any) => v?.type === "title")
      .map((v: any) => richTextToMarkdown(v.title))
      .find(Boolean) ||
    "Untitled";

  // ── 2. Fetch blocks recursively ─────────────────────────────────
  const blocks = await fetchPageBlocksDeep(pageId, apiKey, {
    maxDepth: opts.maxDepth ?? 2,
    maxBlocksPerPage: opts.maxBlocksPerPage ?? 250,
  });

  const markdown = blocksToMarkdown(blocks);
  const mediaUrls = collectFileUrlsFromBlocks(blocks);
  const subpages = collectSubpages(blocks);
  const childDatabases = collectChildDatabases(blocks);
  const todos = collectToDos(blocks);

  // ── 3. Upsert Note ─────────────────────────────────────────────
  const noteStore = new NoteStore(stateDir);
  const existing = noteStore.list().find((n) => n.notionPageId === pageId);

  let noteId: string;
  let isNew = false;
  const syncedAt = new Date().toISOString();

  // Build body including subpage references and media catalog
  let body = markdown;
  if (subpages.length > 0) {
    body +=
      "\n\n## Subpages\n" + subpages.map((s) => `- [${s.title}](notion://page/${s.id})`).join("\n");
  }
  if (mediaUrls.length > 0) {
    body += "\n\n## Media\n" + mediaUrls.map((u) => `- ${u}`).join("\n");
  }

  if (existing) {
    noteStore.update({
      id: existing.id,
      name: title,
      body,
      notionPageId: pageId,
      notionSyncedAt: syncedAt,
    });
    noteId = existing.id;
  } else {
    const note = noteStore.create({
      name: title,
      body,
      notionPageId: pageId,
      notionSyncedAt: syncedAt,
      tags: ["notion-sync"],
    });
    noteId = note.id;
    isNew = true;
  }

  // ── 4. Upsert Kanban project for this page ──────────────────────
  const kanban = getKanbanStore(stateDir);
  const existingProject = kanban.getByNotionPageId("projects", pageId);

  let projectId: string;
  if (existingProject) {
    await kanban.updateProject(existingProject.id, {
      name: title,
      notionId: pageId,
    });
    projectId = existingProject.id;
  } else {
    // Check by notionId field too (set in older syncs)
    const projects = await kanban.getProjects();
    const byNotionId = projects.find((p: any) => p.notionId === pageId);
    if (byNotionId) {
      await kanban.updateProject(byNotionId.id, { name: title, notionId: pageId });
      kanban.setNotionPageId("projects", byNotionId.id, pageId);
      projectId = byNotionId.id;
    } else {
      const proj = await kanban.createProject({
        id: randomUUID(),
        name: title,
        description: `Synced from Notion page: ${pageId}`,
        notionId: pageId,
        status: "Not started",
      });
      kanban.setNotionPageId("projects", proj.id, pageId);
      projectId = proj.id;
    }
  }

  // ── 5. Upsert Kanban tasks from to_do blocks ────────────────────
  let tasksCreated = 0;
  let tasksUpdated = 0;

  for (const todo of todos) {
    // Use the Notion block ID as the notionId so re-syncs update in place
    const existing = kanban.getByNotionPageId("tasks", todo.notionBlockId);
    const status = todo.checked ? "done" : "todo";

    if (existing) {
      await kanban.updateTask(existing.id, {
        title: todo.text,
        status,
        done: todo.checked,
      });
      tasksUpdated++;
    } else {
      const task = await kanban.createTask({
        projectId,
        title: todo.text,
        status,
        done: todo.checked,
        notionId: todo.notionBlockId,
        tags: ["notion-todo"],
      });
      kanban.setNotionPageId("tasks", task.id, todo.notionBlockId);
      tasksCreated++;
    }
  }

  // ── 6. Upsert Kanban tasks from embedded database rows ──────────
  for (const db of childDatabases) {
    try {
      const rows = await queryAllRows(db.id, apiKey);
      await sleep(RATE_DELAY_MS);

      for (const row of rows) {
        const rowTitle = extractRowTitle(row.properties);
        if (!rowTitle) continue;

        const status = extractRowStatus(row.properties);
        const existing = kanban.getByNotionPageId("tasks", row.id);

        if (existing) {
          await kanban.updateTask(existing.id, {
            title: rowTitle,
            status,
            done: status === "done",
          });
          tasksUpdated++;
        } else {
          const task = await kanban.createTask({
            projectId,
            title: rowTitle,
            status,
            done: status === "done",
            notionId: row.id,
            description: `From Notion database: ${db.title}`,
            tags: ["notion-db-row"],
          });
          kanban.setNotionPageId("tasks", task.id, row.id);
          tasksCreated++;
        }
      }
    } catch (e) {
      warnings.push(
        `child_database ${db.id} (${db.title}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return {
    pageId,
    title,
    noteId,
    isNew,
    subpages,
    mediaUrls,
    tasksCreated,
    tasksUpdated,
    projectId,
    warnings,
  };
}
