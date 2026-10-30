/**
 * Kanban → DatabaseRow live adapter.
 *
 * The `kanban-projects` and `kanban-tasks` stub databases are metadata-only:
 * their real rows live in Notion via the legacy kanban handlers. This module
 * fetches those Notion pages on demand and maps them into DatabaseRow shape
 * so the generic `db.rows.*` gateway surface can serve them without the UI
 * having to know anything about the legacy kanban pipeline.
 *
 * Results are cached for 30 s per kanban source so the sidebar doesn't hit
 * Notion every render.
 */

import { sanitizeNotionPageWrite } from "./notion-option-map.js";
import type { DatabasesStore } from "./store.js";
import { getNotionApiKeyForImport, isNotionEnabled, resolveNotionDbId } from "./notion-config.js";
import { fetchPageBlocksDeep } from "./notion-import.js";
import { slugify } from "./slug.js";
import { getKanbanStore } from "../tasks/store.js";
import type {
  DatabaseProperty,
  DatabaseRecord,
  DatabaseRow,
  DatabaseSource,
  PropertyValue,
  RowFilter,
  RowQuery,
  RowSort,
} from "./types.js";

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  at: number;
  rows: DatabaseRow[];
}

const cache = new Map<string, CacheEntry>();

// Per-page body cache so toggling pages doesn't re-fetch blocks every time.
interface BodyCacheEntry {
  at: number;
  body: string;
}
const bodyCache = new Map<string, BodyCacheEntry>();

// Fallback for failed Notion body pushes. On a successful push the entry is
// cleared so reads come from Notion; on failure it stays so the UI keeps
// showing the user's edit instead of reverting to the stale Notion body.
// Also covers the window between optimistic UI update and the push completing.
const localBodyOverrides = new Map<string, string>();

export type KanbanSource = Extract<DatabaseSource, "kanban-projects" | "kanban-tasks">;

export function isKanbanSource(source: DatabaseSource): source is KanbanSource {
  return source === "kanban-projects" || source === "kanban-tasks";
}

function notionDbIdForSource(source: KanbanSource): string {
  const id = resolveNotionDbId(source);
  if (!id) throw new Error(`No Notion database configured for ${source}`);
  return id;
}

function getApiKey(): string | null {
  // Config-aware (env var or the wizard-stored key) — the old env-only read
  // reported "NOTION_API_KEY not set" for users who connected via the wizard.
  return getNotionApiKeyForImport();
}

/**
 * Can a kanban-backed database row be written through Notion right now?
 * False when Notion is off / not connected / unbound — callers then write
 * the local store instead (Notion is an optional mirror, never a gate).
 */
export function kanbanNotionWritable(source: KanbanSource): boolean {
  try {
    return isNotionEnabled() && !!getApiKey() && !!resolveNotionDbId(source);
  } catch {
    return false;
  }
}

async function fetchNotion(path: string, init: RequestInit = {}): Promise<any> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("NOTION_API_KEY not set");
  if (typeof init.body === "string") {
    init = {
      ...init,
      body: await sanitizeNotionPageWrite(apiKey, path, init.method, init.body, [
        resolveNotionDbId("kanban-tasks"),
        resolveNotionDbId("kanban-projects"),
      ]),
    };
  }
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
  if (!res.ok)
    throw new Error(`Notion API ${res.status}: ${body?.message ?? JSON.stringify(body)}`);
  return body;
}

async function queryAllPages(databaseId: string): Promise<any[]> {
  const pages: any[] = [];
  let cursor: string | undefined;
  do {
    const body: any = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await fetchNotion(`/databases/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    pages.push(...(res.results ?? []));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

function richTextPlain(rich: any[] | undefined): string {
  if (!Array.isArray(rich)) return "";
  return rich.map((r) => r.plain_text ?? "").join("");
}

function richTextToMarkdown(rich: any[] | undefined): string {
  if (!Array.isArray(rich)) return "";
  return rich
    .map((r) => {
      let t = r.plain_text ?? "";
      if (r.annotations?.code) t = "`" + t + "`";
      if (r.annotations?.bold) t = `**${t}**`;
      if (r.annotations?.italic) t = `*${t}*`;
      if (r.annotations?.strikethrough) t = `~~${t}~~`;
      if (r.href) t = `[${t}](${r.href})`;
      return t;
    })
    .join("");
}

function blocksToMarkdown(blocks: any[], depth = 0): string {
  const out: string[] = [];
  const indent = "  ".repeat(depth);
  for (const b of blocks) {
    const t = b.type;
    const body = b[t];
    if (!body && t !== "divider") continue;
    const children = Array.isArray(b.children) ? b.children : [];
    const renderedChildren =
      children.length > 0 ? "\n" + blocksToMarkdown(children, depth + 1) : "";
    switch (t) {
      case "paragraph":
        out.push(indent + richTextToMarkdown(body.rich_text));
        if (renderedChildren) out.push(renderedChildren.trim());
        break;
      case "heading_1":
        out.push(`# ${richTextToMarkdown(body.rich_text)}`);
        break;
      case "heading_2":
        out.push(`## ${richTextToMarkdown(body.rich_text)}`);
        break;
      case "heading_3":
        out.push(`### ${richTextToMarkdown(body.rich_text)}`);
        break;
      case "bulleted_list_item":
        out.push(`${indent}- ${richTextToMarkdown(body.rich_text)}${renderedChildren}`);
        break;
      case "numbered_list_item":
        out.push(`${indent}1. ${richTextToMarkdown(body.rich_text)}${renderedChildren}`);
        break;
      case "to_do":
        out.push(
          `${indent}- [${body.checked ? "x" : " "}] ${richTextToMarkdown(body.rich_text)}${renderedChildren}`,
        );
        break;
      case "quote":
        out.push(`${indent}> ${richTextToMarkdown(body.rich_text)}${renderedChildren}`);
        break;
      case "toggle":
        out.push(
          `${indent}<details><summary>${richTextToMarkdown(body.rich_text)}</summary>\n\n${blocksToMarkdown(children, depth + 1)}\n\n${indent}</details>`,
        );
        break;
      case "code":
        out.push(
          "```" + (body.language ?? "") + "\n" + richTextToMarkdown(body.rich_text) + "\n```",
        );
        break;
      case "divider":
        out.push("---");
        break;
      case "image": {
        const url = body.file?.url ?? body.external?.url;
        const caption = richTextToMarkdown(body.caption) || "image";
        if (url) out.push(`![${caption}](${url})`);
        break;
      }
      case "video": {
        const url = body.file?.url ?? body.external?.url;
        if (url) out.push(`<video src="${url}" controls></video>`);
        break;
      }
      case "audio": {
        const url = body.file?.url ?? body.external?.url;
        if (url) out.push(`<audio src="${url}" controls></audio>`);
        break;
      }
      case "pdf":
      case "file": {
        const url = body.file?.url ?? body.external?.url;
        const name = richTextToMarkdown(body.caption) || "file";
        if (url) out.push(`[📎 ${name}](${url})`);
        break;
      }
      case "bookmark":
      case "embed": {
        const url = body.url;
        if (url) out.push(`[${url}](${url})`);
        break;
      }
      case "callout":
        out.push(
          `${indent}> **${body.icon?.emoji ?? "💡"}** ${richTextToMarkdown(body.rich_text)}${renderedChildren}`,
        );
        break;
      case "child_page": {
        // Notion's block id is the page id of the child. We emit a custom
        // URL scheme that the preview handler intercepts and turns into
        // a real page navigation.
        const title = body.title || "Untitled page";
        const pageId = b.id ? `kanban_${b.id}` : "";
        if (pageId) out.push(`[${title}](moltbot://page/${pageId})`);
        else out.push(`**${title}**`);
        break;
      }
      case "child_database": {
        const title = body.title || "Database";
        out.push(`> 🗃️ **${title}** — linked database (view in Projects → Databases)`);
        break;
      }
      case "column_list":
      case "column":
      case "synced_block":
      case "template":
        // Wrapper blocks — children attached by fetchPageBlocksDeep are
        // flattened inline here so columns / synced content surface in
        // the rendered markdown.
        if (renderedChildren) out.push(renderedChildren.trim());
        out.push("");
        break;
      case "table_of_contents":
        out.push("> _Table of contents_");
        break;
      case "breadcrumb":
        break;
      case "equation":
        if (body.expression) out.push("$$\n" + body.expression + "\n$$");
        break;
      case "link_to_page": {
        const ref = body.page_id ?? body.database_id;
        if (ref) out.push(`[→ linked page](moltbot://page/kanban_${ref})`);
        break;
      }
    }
  }
  return out.join("\n\n");
}

/**
 * Mirror of `blocksToMarkdown` in ui/src/ui/components/block-editor.ts —
 * lets the server serialize project_content_blocks into the same markdown
 * the editor would emit, so the /databases full-page body matches what
 * the kanban Content tab is editing.
 */
function editorBlocksToMarkdown(
  blocks: Array<{ type: string; text: string; checked?: boolean; language?: string }>,
): string {
  const out: string[] = [];
  let numCounter = 0;
  let lastWasNumbered = false;
  for (const b of blocks) {
    if (b.type !== "numbered") {
      lastWasNumbered = false;
      numCounter = 0;
    }
    switch (b.type) {
      case "h1":
        out.push(`# ${b.text}`);
        break;
      case "h2":
        out.push(`## ${b.text}`);
        break;
      case "h3":
        out.push(`### ${b.text}`);
        break;
      case "bullet":
        out.push(`- ${b.text}`);
        break;
      case "numbered": {
        if (!lastWasNumbered) numCounter = 0;
        numCounter += 1;
        out.push(`${numCounter}. ${b.text}`);
        lastWasNumbered = true;
        break;
      }
      case "todo":
        out.push(`- [${b.checked ? "x" : " "}] ${b.text}`);
        break;
      case "quote":
        out.push(`> ${b.text}`);
        break;
      case "callout":
        out.push(`> ${b.text}`);
        break;
      case "code":
        out.push(`\`\`\`${b.language ?? ""}\n${b.text}\n\`\`\``);
        break;
      case "divider":
        out.push(`---`);
        break;
      case "paragraph":
      default:
        out.push(b.text);
    }
  }
  return out.join("\n\n");
}

/**
 * Read the gateway's local project_content_blocks for a kanban-project row
 * and return them serialized as markdown. Returns null if the row isn't
 * a kanban-project, the store isn't initialized, or there are no blocks.
 *
 * Why: the /databases full-page body used to come exclusively from
 * fetchPageBodyAsMarkdown — i.e. a Notion round-trip. That returned an
 * empty body whenever Notion wasn't synced for that page, so projects
 * whose content lived only in the local kanban content-blocks editor
 * looked empty in the /databases view even though the kanban Content
 * tab rendered them fine.
 */
function localProjectBodyAsMarkdown(rowId: string): string | null {
  if (!rowId.startsWith("kanban_")) return null;
  const projectId = rowId.slice("kanban_".length);
  try {
    const store = getKanbanStore();
    const { blocks } = store.getProjectContentBlocks(projectId);
    if (!Array.isArray(blocks) || blocks.length === 0) return null;
    const md = editorBlocksToMarkdown(blocks as any[]).trim();
    return md.length > 0 ? md : null;
  } catch {
    // Store not initialized in this context (e.g. running under an isolated
    // unit test) — fall through to the Notion path.
    return null;
  }
}

export async function fetchPageBodyAsMarkdown(pageId: string): Promise<string> {
  const override = localBodyOverrides.get(pageId);
  if (override !== undefined) return override;
  const existing = bodyCache.get(pageId);
  if (existing && Date.now() - existing.at < CACHE_TTL_MS) return existing.body;

  // Deep-walk the page tree (sub-pages + toggles/callouts/list-item
  // children) so the rendered body matches what shows on the Notion
  // page itself. Without recursion, a project whose details live under
  // a "Brief" toggle would render an empty viewer.
  const apiKey = getApiKey();
  if (!apiKey) return "";
  let blocks: any[];
  try {
    blocks = await fetchPageBlocksDeep(pageId, apiKey, {
      maxDepth: 2,
      maxBlocksPerPage: 200,
    });
  } catch {
    return "";
  }
  const body = blocksToMarkdown(blocks);
  bodyCache.set(pageId, { at: Date.now(), body });
  return body;
}

// Notion's rich_text caps each text object at 2000 chars; longer blocks need
// to be split into multiple text objects.
const NOTION_TEXT_LIMIT = 2000;

function richText(content: string): any[] {
  if (!content) return [];
  const out: any[] = [];
  for (let i = 0; i < content.length; i += NOTION_TEXT_LIMIT) {
    out.push({ type: "text", text: { content: content.slice(i, i + NOTION_TEXT_LIMIT) } });
  }
  return out;
}

function isMarkdownBlockStart(line: string): boolean {
  return /^(?:#{1,3}\s|[-*]\s|\d+\.\s|>\s|---+$|\*\*\*+$|```)/.test(line);
}

/** Inverse of `blocksToMarkdown` — converts the editor's markdown output to
 *  Notion block payloads suitable for /blocks/{id}/children. */
function markdownToNotionBlocks(md: string): any[] {
  const lines = (md ?? "").replace(/\r\n/g, "\n").split("\n");
  const out: any[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === "") {
      i++;
      continue;
    }

    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      out.push({ object: "block", type: "divider", divider: {} });
      i++;
      continue;
    }

    let m = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (m) {
      const lvl = m[1].length;
      const type = lvl === 1 ? "heading_1" : lvl === 2 ? "heading_2" : "heading_3";
      out.push({ object: "block", type, [type]: { rich_text: richText(m[2]) } });
      i++;
      continue;
    }

    m = /^[-*]\s+\[(\s|x|X)\]\s+(.*)$/.exec(trimmed);
    if (m) {
      out.push({
        object: "block",
        type: "to_do",
        to_do: { rich_text: richText(m[2]), checked: m[1].toLowerCase() === "x" },
      });
      i++;
      continue;
    }

    m = /^[-*]\s+(.*)$/.exec(trimmed);
    if (m) {
      out.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: richText(m[1]) },
      });
      i++;
      continue;
    }

    m = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (m) {
      out.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: { rich_text: richText(m[1]) },
      });
      i++;
      continue;
    }

    m = /^>\s?(.*)$/.exec(trimmed);
    if (m) {
      out.push({
        object: "block",
        type: "quote",
        quote: { rich_text: richText(m[1] ?? "") },
      });
      i++;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const lang = trimmed.replace(/^```/, "").trim() || "plain text";
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      out.push({
        object: "block",
        type: "code",
        code: { rich_text: richText(codeLines.join("\n")), language: lang },
      });
      continue;
    }

    // Paragraph — collect consecutive non-empty, non-block-start lines.
    const paraLines: string[] = [raw];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !isMarkdownBlockStart(lines[i].trim())) {
      paraLines.push(lines[i]);
      i++;
    }
    out.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: richText(paraLines.join(" ")) },
    });
  }
  return out;
}

// Serialized per-page push queue — without this, two rapid saves on the same
// page can interleave their delete/append phases and corrupt the page body.
const bodyPushQueue = new Map<string, Promise<void>>();

async function pushPageBody(pageId: string, md: string): Promise<void> {
  // Phase 1: list current children so we can archive them.
  const existingIds: string[] = [];
  let cursor: string | undefined;
  do {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : `?page_size=100`;
    const res = await fetchNotion(`/blocks/${pageId}/children${qs}`);
    for (const b of res.results ?? []) existingIds.push(b.id);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  // Phase 2: archive existing children sequentially. Notion rate-limits
  // hard if you fan out many DELETEs in parallel.
  for (const id of existingIds) {
    await fetchNotion(`/blocks/${id}`, { method: "DELETE" }).catch(() => {});
  }

  // Phase 3: append new children. Notion accepts up to 100 per request.
  const newBlocks = markdownToNotionBlocks(md);
  for (let i = 0; i < newBlocks.length; i += 100) {
    const chunk = newBlocks.slice(i, i + 100);
    if (chunk.length === 0) continue;
    await fetchNotion(`/blocks/${pageId}/children`, {
      method: "PATCH",
      body: JSON.stringify({ children: chunk }),
    });
  }
}

async function pushPageBodySerialized(pageId: string, md: string): Promise<void> {
  const prev = bodyPushQueue.get(pageId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => pushPageBody(pageId, md));
  bodyPushQueue.set(pageId, next);
  try {
    await next;
  } finally {
    if (bodyPushQueue.get(pageId) === next) bodyPushQueue.delete(pageId);
  }
}

function pagePropByName(page: any, ...names: string[]): any {
  const props = page?.properties ?? {};
  for (const n of names) {
    if (props[n]) return props[n];
  }
  for (const key of Object.keys(props)) {
    for (const n of names) {
      if (key.toLowerCase() === n.toLowerCase()) return props[key];
    }
  }
  return undefined;
}

function pageTitle(page: any): string {
  for (const candidate of ["Project", "Task Name", "Task", "Name", "Title"]) {
    const p = pagePropByName(page, candidate);
    if (p?.type === "title") return richTextPlain(p.title) || "";
  }
  for (const prop of Object.values(page?.properties ?? {}) as any[]) {
    if (prop?.type === "title") return richTextPlain(prop.title) || "";
  }
  return "";
}

function optionIdForName(
  prop: DatabaseProperty | undefined,
  optionName: string | null | undefined,
): string | null {
  if (!prop || !optionName) return null;
  const opt = prop.config?.options?.find(
    (o) => o.name.toLowerCase() === optionName.toLowerCase() || o.id === optionName,
  );
  return opt?.id ?? null;
}

/** Build the DatabaseRow.values map keyed by the stub's property ids. */
function rowFromProjectPage(
  page: any,
  properties: DatabaseProperty[],
): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};
  const titleProp = properties.find((p) => p.type === "title");
  if (titleProp) out[titleProp.id] = { type: "title", text: pageTitle(page) };

  const statusProp = properties.find((p) => p.name.toLowerCase() === "status");
  if (statusProp) {
    const np = pagePropByName(page, "Status");
    const remoteName = np?.status?.name ?? np?.select?.name ?? null;
    out[statusProp.id] = {
      type: statusProp.type === "status" ? "status" : "select",
      optionId: optionIdForName(statusProp, remoteName),
    } as PropertyValue;
  }

  const priorityProp = properties.find((p) => p.name.toLowerCase() === "priority");
  if (priorityProp) {
    const np = pagePropByName(page, "Priority");
    const remoteName = np?.select?.name ?? np?.status?.name ?? null;
    out[priorityProp.id] = {
      type: priorityProp.type === "status" ? "status" : "select",
      optionId: optionIdForName(priorityProp, remoteName),
    } as PropertyValue;
  }

  const descProp = properties.find((p) => p.name.toLowerCase() === "description");
  if (descProp) {
    const np = pagePropByName(page, "Description");
    out[descProp.id] = {
      type: "richText",
      markdown: richTextPlain(np?.rich_text),
    };
  }

  return out;
}

function rowFromTaskPage(page: any, properties: DatabaseProperty[]): Record<string, PropertyValue> {
  const out = rowFromProjectPage(page, properties); // shares Status/Priority/Description handling

  const projectProp = properties.find((p) => p.name.toLowerCase() === "project");
  if (projectProp) {
    const np = pagePropByName(page, "Project");
    const rowIds = (np?.relation ?? []).map((r: any) => r.id).filter(Boolean);
    out[projectProp.id] = { type: "relation", rowIds };
  }

  const assigneeProp = properties.find((p) => p.name.toLowerCase() === "assignee");
  if (assigneeProp) {
    const np = pagePropByName(page, "Assignee");
    const personIds = (np?.people ?? []).map((p: any) => p.id).filter(Boolean);
    out[assigneeProp.id] = { type: "person", personIds };
  }

  const dueProp = properties.find((p) => p.name.toLowerCase() === "due");
  if (dueProp) {
    const np = pagePropByName(page, "Due") ?? pagePropByName(page, "Due Date");
    out[dueProp.id] = { type: "date", iso: np?.date?.start ?? null };
  }

  return out;
}

function mapPageToRow(
  page: any,
  db: DatabaseRecord,
  properties: DatabaseProperty[],
  source: KanbanSource,
): DatabaseRow {
  const values =
    source === "kanban-projects"
      ? rowFromProjectPage(page, properties)
      : rowFromTaskPage(page, properties);

  const titleText = (() => {
    const titleProp = properties.find((p) => p.type === "title");
    const v = titleProp ? values[titleProp.id] : undefined;
    return v?.type === "title" ? v.text : "";
  })();

  const createdAt = page?.created_time ? new Date(page.created_time).getTime() : Date.now();
  const updatedAt = page?.last_edited_time ? new Date(page.last_edited_time).getTime() : createdAt;

  return {
    id: `kanban_${page.id}`,
    databaseId: db.id,
    title: titleText || "Untitled",
    // Stable per-page slug. Notion ids contain dashes which slugify keeps,
    // so we suffix the title slug with a short hash of the Notion id to
    // guarantee uniqueness without round-trip storage.
    slug: `${slugify(titleText || "untitled")}-${
      String(page.id || "")
        .replace(/-/g, "")
        .slice(0, 8) || "x"
    }`,
    body: null,
    values,
    sortOrder: createdAt,
    createdAt,
    updatedAt,
    externalRef: {
      system: "notion",
      externalId: page.id,
      lastSyncedAt: Date.now(),
    },
  };
}

/**
 * Load all kanban rows for a stub database. Uses a short-lived per-source
 * cache; call `invalidateKanbanCache(source)` to force a refresh.
 */
export async function listKanbanRows(
  store: DatabasesStore,
  db: DatabaseRecord,
  opts: { businessId?: string | null } = {},
): Promise<DatabaseRow[]> {
  if (!isKanbanSource(db.source)) return [];
  const source = db.source;
  const cached = cache.get(source);
  const now = Date.now();
  let rows: DatabaseRow[];
  if (cached && now - cached.at < CACHE_TTL_MS) {
    rows = cached.rows;
  } else {
    const properties = store.listProperties(db.id);
    try {
      // Notion-less installs (or an unbound DB): the local store IS the data —
      // don't build an error just to catch it.
      if (!kanbanNotionWritable(source)) throw new Error("notion not bound");
      const pages = await queryAllPages(notionDbIdForSource(source));
      rows = pages.map((p) => mapPageToRow(p, db, properties, source));
    } catch {
      // If Notion fetch fails, fall back to whatever's in local store
      // (possibly nothing) — at least the UI doesn't throw.
      rows = store.listRows(db.id);
    }
    cache.set(source, { at: now, rows });
  }

  // Per-business scope. Kanban-source rows don't carry businessId on the
  // row itself — projects are linked via project_meta.businessId, tasks
  // inherit through their parent project. Resolve via the kanban store
  // and apply post-fetch.
  if (opts.businessId !== undefined) {
    rows = applyBusinessFilterToKanbanRows(rows, source, opts.businessId);
  }
  return rows;
}

/**
 * Filter kanban-source rows by businessId. Tri-state:
 *   undefined → no filter (caller already decided); should not reach here.
 *   null      → only rows whose project meta has no businessId.
 *   string    → only rows whose project meta has that businessId.
 *
 * Tasks resolve through their parent project's meta (the relation column
 * is named "Project" in the kanban-tasks DB; we strip the kanban_ prefix
 * to recover the project id).
 */
function applyBusinessFilterToKanbanRows(
  rows: DatabaseRow[],
  source: KanbanSource,
  businessId: string | null,
): DatabaseRow[] {
  if (rows.length === 0) return rows;
  // Lazy import to avoid a circular dep between kanban-adapter and tasks/store.
  let projectMeta: Record<string, { businessId?: string }> = {};
  try {
    const { getKanbanStore } = require("../tasks/store.js") as typeof import("../tasks/store.js");
    projectMeta = getKanbanStore().getAllProjectMeta();
  } catch {
    // Without project_meta available, return rows unfiltered. Better than
    // hiding everything when the store can't be reached.
    return rows;
  }
  const matchesBiz = (projectId: string | undefined): boolean => {
    if (!projectId) return businessId === null;
    const meta = projectMeta[projectId];
    const linked = meta?.businessId ?? null;
    return businessId === null ? !linked : linked === businessId;
  };
  if (source === "kanban-projects") {
    return rows.filter((r) => matchesBiz(r.externalRef?.externalId));
  }
  // kanban-tasks: relation column "Project" → resolve parent project id.
  return rows.filter((r) => {
    const projectRowId = readRelationFirstId(r);
    if (!projectRowId) return businessId === null;
    const projectId = projectRowId.startsWith("kanban_")
      ? projectRowId.slice("kanban_".length)
      : projectRowId;
    return matchesBiz(projectId);
  });
}

/**
 * Pull the first relation row id from a row's "Project" property. Reads any
 * relation-typed value if "Project" isn't found — handles renames.
 */
function readRelationFirstId(row: DatabaseRow): string | null {
  const values = row.values ?? {};
  for (const v of Object.values(values)) {
    if (v && typeof v === "object" && (v as { type?: string }).type === "relation") {
      const ids = (v as { rowIds?: unknown }).rowIds;
      if (Array.isArray(ids) && typeof ids[0] === "string") return ids[0];
    }
  }
  return null;
}

export function invalidateKanbanCache(source?: KanbanSource): void {
  if (source) cache.delete(source);
  else cache.clear();
}

// ─── Filter + sort (reuse the same logic shape as store.queryRows) ────

function getComparable(value: PropertyValue | undefined): string | number | boolean | null {
  if (!value) return null;
  switch (value.type) {
    case "title":
      return value.text ?? "";
    case "richText":
      return value.markdown ?? "";
    case "select":
    case "status":
      return value.optionId ?? null;
    case "multiSelect":
      return value.optionIds.join(",");
    case "date":
      return value.iso ?? null;
    case "dateRange":
      return value.start ?? null;
    case "number":
      return value.value ?? null;
    case "checkbox":
      return value.checked;
    case "url":
      return value.url ?? null;
    case "email":
      return value.email ?? null;
    case "phone":
      return value.phone ?? null;
    case "files":
      return value.files.length;
    case "relation":
      return value.rowIds.join(",");
    case "person":
      return value.personIds.join(",");
    case "createdAt":
    case "updatedAt":
      return value.iso;
    default:
      return null;
  }
}

function matchesFilter(row: DatabaseRow, filter: RowFilter): boolean {
  switch (filter.kind) {
    case "equals":
      return getComparable(row.values[filter.propertyId]) === filter.value;
    case "contains": {
      const v = getComparable(row.values[filter.propertyId]);
      return typeof v === "string" && v.toLowerCase().includes(filter.value.toLowerCase());
    }
    case "isEmpty": {
      const v = getComparable(row.values[filter.propertyId]);
      return v === null || v === "" || v === 0 || v === false;
    }
    case "isNotEmpty": {
      const v = getComparable(row.values[filter.propertyId]);
      return !(v === null || v === "" || v === 0 || v === false);
    }
    case "in": {
      const v = getComparable(row.values[filter.propertyId]);
      return filter.values.includes(v);
    }
    case "and":
      return filter.filters.every((f) => matchesFilter(row, f));
    case "or":
      return filter.filters.some((f) => matchesFilter(row, f));
  }
}

function compareRows(a: DatabaseRow, b: DatabaseRow, sorts: RowSort[]): number {
  for (const sort of sorts) {
    const av = getComparable(a.values[sort.propertyId]);
    const bv = getComparable(b.values[sort.propertyId]);
    let cmp = 0;
    if (av === null && bv === null) cmp = 0;
    else if (av === null) cmp = 1;
    else if (bv === null) cmp = -1;
    else if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    if (cmp !== 0) return sort.direction === "desc" ? -cmp : cmp;
  }
  return a.sortOrder - b.sortOrder;
}

export async function queryKanbanRows(
  store: DatabasesStore,
  db: DatabaseRecord,
  q: Omit<RowQuery, "databaseId">,
): Promise<DatabaseRow[]> {
  let rows = await listKanbanRows(store, db, { businessId: q.businessId });
  if (q.filter) rows = rows.filter((r) => matchesFilter(r, q.filter!));
  if (q.sorts?.length) rows.sort((a, b) => compareRows(a, b, q.sorts!));
  if (q.offset) rows = rows.slice(q.offset);
  if (q.limit != null) rows = rows.slice(0, q.limit);
  return rows;
}

export async function getKanbanRow(
  store: DatabasesStore,
  db: DatabaseRecord,
  rowId: string,
  opts: { withBody?: boolean } = {},
): Promise<DatabaseRow | null> {
  const rows = await listKanbanRows(store, db);
  const row = rows.find((r) => r.id === rowId) ?? null;
  if (!row) return null;
  if (!opts.withBody) return row;

  const pageId = row.externalRef?.externalId;
  if (!pageId) return row;

  // Body source priority:
  //   1. localBodyOverrides — write-cache from an in-flight /databases save;
  //      always wins so the user's most recent edit is reflected immediately.
  //   2. project_content_blocks — canonical local store the kanban Content
  //      tab edits. Without this, projects whose content was authored locally
  //      (and never synced to Notion) showed up empty in /databases.
  //   3. fetchPageBodyAsMarkdown — Notion round-trip; slow and possibly
  //      empty when the integration isn't wired up.
  const override = localBodyOverrides.get(pageId);
  if (override !== undefined) return { ...row, body: override };

  const local = localProjectBodyAsMarkdown(rowId);
  if (local) return { ...row, body: local };

  const body = await fetchPageBodyAsMarkdown(pageId);
  return { ...row, body };
}

// ─── Write-through: edit kanban-sourced rows by pushing to Notion ────

/** Strip our `kanban_` prefix to recover the underlying Notion page id. */
function notionPageIdFromRowId(rowId: string): string {
  return rowId.startsWith("kanban_") ? rowId.slice("kanban_".length) : rowId;
}

/** Look up an option's display name by id for a given property. */
function optionNameForId(
  prop: DatabaseProperty | undefined,
  optionId: string | null,
): string | null {
  if (!prop || !optionId) return null;
  return prop.config?.options?.find((o) => o.id === optionId)?.name ?? null;
}

/**
 * Translate a partial DatabaseRow patch into a Notion `properties` payload
 * appropriate for the given kanban source (projects vs tasks). Returns the
 * subset of Notion fields that the patch actually touches.
 */
function patchToNotionProperties(
  source: KanbanSource,
  properties: DatabaseProperty[],
  patch: { title?: string; values?: Record<string, PropertyValue> },
): Record<string, any> {
  const out: Record<string, any> = {};
  const titleKey = source === "kanban-projects" ? "Project" : "Task Name";
  const statusKey = source === "kanban-projects" ? "Status" : "Status Update";
  const priorityKey = source === "kanban-projects" ? "Priority" : "Priority Level";

  if (patch.title !== undefined) {
    out[titleKey] = { title: [{ text: { content: patch.title } }] };
  }

  const values = patch.values ?? {};
  for (const [propertyId, value] of Object.entries(values)) {
    const prop = properties.find((p) => p.id === propertyId);
    if (!prop) continue;
    const lname = prop.name.toLowerCase();

    if (prop.type === "title" && value.type === "title") {
      out[titleKey] = { title: [{ text: { content: value.text ?? "" } }] };
      continue;
    }

    if (lname === "status" && (value.type === "status" || value.type === "select")) {
      const name = optionNameForId(prop, value.optionId);
      if (name) out[statusKey] = { status: { name } };
      continue;
    }

    if (lname === "priority" && (value.type === "select" || value.type === "status")) {
      const name = optionNameForId(prop, value.optionId);
      if (name) out[priorityKey] = { select: { name } };
      continue;
    }

    if (lname === "description" && value.type === "richText") {
      out.Description = { rich_text: [{ text: { content: value.markdown ?? "" } }] };
      continue;
    }

    if (source === "kanban-tasks") {
      if (lname === "project" && value.type === "relation") {
        out.Project = {
          relation: value.rowIds
            .map((id) => ({ id: notionPageIdFromRowId(id) }))
            .filter((r) => r.id),
        };
        continue;
      }
      if (lname === "due" && value.type === "date") {
        out["Due Date"] = value.iso ? { date: { start: value.iso } } : { date: null };
        continue;
      }
      if (lname === "assignee" && value.type === "person") {
        out.Assignee = { people: value.personIds.map((id) => ({ id })) };
        continue;
      }
    }
  }

  return out;
}

/**
 * Create or update a kanban-sourced row by writing to Notion. Used by
 * `db.rows.upsert` so the generic database surface can edit kanban content
 * without callers needing to know about the legacy kanban handlers.
 */
export async function upsertKanbanRow(
  store: DatabasesStore,
  db: DatabaseRecord,
  patch: {
    id?: string;
    title?: string;
    body?: string | null;
    values?: Record<string, PropertyValue>;
  },
): Promise<DatabaseRow> {
  if (!isKanbanSource(db.source)) {
    throw new Error(`upsertKanbanRow called on non-kanban database ${db.id}`);
  }
  const source = db.source;
  const properties = store.listProperties(db.id);
  const notionProps = patchToNotionProperties(source, properties, patch);

  let pageId: string;
  if (patch.id) {
    pageId = notionPageIdFromRowId(patch.id);
    if (Object.keys(notionProps).length > 0) {
      await fetchNotion(`/pages/${pageId}`, {
        method: "PATCH",
        body: JSON.stringify({ properties: notionProps }),
      });
    }
  } else {
    if (!notionProps[source === "kanban-projects" ? "Project" : "Task Name"]) {
      const titleKey = source === "kanban-projects" ? "Project" : "Task Name";
      notionProps[titleKey] = {
        title: [{ text: { content: patch.title ?? "Untitled" } }],
      };
    }
    const created = await fetchNotion("/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { database_id: notionDbIdForSource(source) },
        properties: notionProps,
      }),
    });
    pageId = created.id;
  }

  invalidateKanbanCache(source);

  // Body sync to Notion. Set the local override first so the response is
  // consistent even if the push is slow or fails — the UI will show what the
  // user typed either way.
  if (patch.body !== undefined) {
    const nextBody = patch.body ?? "";
    localBodyOverrides.set(pageId, nextBody);
    try {
      await pushPageBodySerialized(pageId, nextBody);
      // Drop the override only if it's still the body we pushed — a
      // concurrent save on the same page may have set a newer one. The
      // newer save will clear it when its own push completes.
      if (localBodyOverrides.get(pageId) === nextBody) {
        localBodyOverrides.delete(pageId);
        bodyCache.delete(pageId);
      }
    } catch (err) {
      // Keep the override so the user's edit isn't lost from the UI. The
      // next save attempt will retry the push.
      console.error(`[kanban-adapter] failed to push body to Notion for ${pageId}:`, err);
    }
  }

  const page = await fetchNotion(`/pages/${pageId}`);
  const row = mapPageToRow(page, db, properties, source);
  // mapPageToRow returns body: null. Without re-attaching the page body, the
  // UI's openRow gets clobbered to empty whenever a non-body field (e.g. the
  // Description property) is saved.
  const body = await fetchPageBodyAsMarkdown(pageId).catch(() => null);
  return { ...row, body };
}

/**
 * Archive a kanban-sourced row in Notion. Used by `db.rows.delete` so the
 * generic surface can delete kanban content without callers having to know
 * about the legacy kanban handlers.
 */
export async function deleteKanbanRow(rowId: string): Promise<void> {
  const pageId = notionPageIdFromRowId(rowId);
  await fetchNotion(`/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: true }),
  });
  invalidateKanbanCache();
}
