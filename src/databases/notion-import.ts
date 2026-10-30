/**
 * Notion → generic-databases importer (one-shot).
 *
 * Used by the legacy quickstart, the `databases.notionImport` gateway
 * method, and the `databases-tool` agent tool. These callers want a
 * Notion DB mirrored into the generic SQLite database store as opaque
 * `notion-import` rows for agents to query — there is NO role binding
 * involved.
 *
 * For role-bound imports (Projects / Tasks / CRM) the entry point is the
 * unified import wizard in `gateway/server-methods/notion-import.ts`,
 * which writes a binding into `notion-config.bindings` and triggers the
 * bidirectional poller. The two paths intentionally coexist — they serve
 * different shapes of "import" — but new wiring should prefer the
 * binding-aware path so the new conflict queue and field map apply.
 *
 * Throttles to ~3 req/s per Notion's rate limit.
 */

import { randomUUID } from "node:crypto";
import type {
  DatabaseRecord,
  PropertyConfig,
  PropertyType,
  PropertyValue,
  SelectOption,
} from "./types.js";
import type { DatabasesStore } from "./store.js";

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const RATE_DELAY_MS = 350; // ~2.8 req/s

export interface ImportOptions {
  apiKey?: string;
  databaseIds?: string[];
  onLog?: (line: string) => void;
}

export interface ImportReport {
  imported: Array<{ databaseId: string; name: string; rowCount: number; notionDatabaseId: string }>;
  warnings: string[];
}

function resolveApiKey(override?: string): string {
  const raw = override || process.env.NOTION_API_KEY;
  if (!raw) throw new Error("No Notion API key provided (set NOTION_API_KEY or pass apiKey).");
  // Strip wrapping whitespace + zero-width / BOM marks that often hitchhike
  // when pasting from a browser tooltip. The actual token Notion issues is
  // ASCII (`secret_…` / `ntn_…`), so any non-Latin-1 character almost
  // certainly came from a paste artifact (a truncation ellipsis, a smart
  // quote, a non-breaking space) and fetch() will throw a ByteString
  // TypeError when we try to put it in the Authorization header.
  const trimmed = raw.replace(/^[\s​‌‍﻿]+|[\s​‌‍﻿]+$/g, "");
  // Surface the bad character with its position so the operator can see
  // exactly which character to strip from the pasted key.
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code > 255) {
      const ch = trimmed[i];
      throw new Error(
        `Notion API key contains a non-ASCII character (${JSON.stringify(ch)}, U+${code.toString(16).toUpperCase().padStart(4, "0")}) at position ${i}. ` +
          `This usually means the key was pasted from a tooltip that truncates with "…" or contains a smart quote — paste the key directly from Notion's "Internal Integration Secret" reveal.`,
      );
    }
  }
  if (!trimmed) throw new Error("Notion API key is empty after trimming whitespace.");
  return trimmed;
}

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

// ─── Discovery ───────────────────────────────────────────────────

async function listDatabases(apiKey: string): Promise<any[]> {
  const results: any[] = [];
  let cursor: string | undefined;
  do {
    const body: any = { filter: { property: "object", value: "database" }, page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await fetchNotion("/search", apiKey, {
      method: "POST",
      body: JSON.stringify(body),
    });
    results.push(...(res.results ?? []));
    cursor = res.has_more ? res.next_cursor : undefined;
    await sleep(RATE_DELAY_MS);
  } while (cursor);
  return results;
}

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

/**
 * Block types that carry children in the Notion API and need a separate
 * `/blocks/{id}/children` fetch to surface them. Without this, files,
 * images, sub-paragraphs nested under toggles, callouts, list items,
 * columns, etc. are invisible to the importer.
 */
const NESTING_BLOCK_TYPES = new Set([
  "toggle",
  "callout",
  "quote",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "column_list",
  "column",
  "synced_block",
  "table",
]);

/**
 * Recursively fetch a page's block tree, attaching a `children` array to
 * each parent block (toggle, callout, list-item, column, sub-page, etc.)
 * so a single markdown render can walk the whole hierarchy. Without this
 * recursion, nested files / images / paragraphs inside collapsibles were
 * silently dropped on import.
 *
 * Caps: blockDepth bounds nested-block recursion; pageDepth bounds
 * sub-page recursion separately so we can fully walk the page's block
 * tree without exploding when child pages link to siblings.
 */
export async function fetchPageBlocksDeep(
  pageId: string,
  apiKey: string,
  opts: {
    maxDepth?: number;
    maxBlocksPerPage?: number;
    visited?: Set<string>;
    blockDepth?: number;
  } = {},
): Promise<any[]> {
  const maxDepth = opts.maxDepth ?? 2;
  const maxBlocks = opts.maxBlocksPerPage ?? 200;
  const blockDepth = opts.blockDepth ?? 4;
  const visited = opts.visited ?? new Set<string>();
  if (visited.has(pageId)) return [];
  visited.add(pageId);

  const top = await fetchPageBlocks(pageId, apiKey);
  const limited = top.slice(0, maxBlocks);

  // Walk each block: if it's a sub-page recurse via fetchPageBlocksDeep
  // (counts against maxDepth); if it's a regular nesting block fetch its
  // children inline and attach as block.children (counts against
  // blockDepth, doesn't burn the sub-page quota).
  const out: any[] = [];
  for (const block of limited) {
    out.push(block);
    if (block.type === "child_page" && maxDepth > 0) {
      const childBlocks = await fetchPageBlocksDeep(block.id, apiKey, {
        maxDepth: maxDepth - 1,
        maxBlocksPerPage: maxBlocks,
        visited,
        blockDepth,
      });
      out.push(...childBlocks);
    } else if (block.has_children && blockDepth > 0 && NESTING_BLOCK_TYPES.has(block.type)) {
      try {
        block.children = await fetchBlockChildrenDeep(block.id, apiKey, blockDepth, maxBlocks);
      } catch {
        // Best-effort — a single nested fetch failure shouldn't kill the import.
        block.children = [];
      }
    }
  }
  return out;
}

/**
 * Inner recursion for non-page block children (toggles inside toggles,
 * lists inside columns, etc). Returns blocks with their own nested
 * children attached.
 */
async function fetchBlockChildrenDeep(
  blockId: string,
  apiKey: string,
  remainingDepth: number,
  maxBlocks: number,
): Promise<any[]> {
  if (remainingDepth <= 0) return [];
  const children = await fetchPageBlocks(blockId, apiKey);
  const limited = children.slice(0, maxBlocks);
  for (const child of limited) {
    if (child.has_children && NESTING_BLOCK_TYPES.has(child.type)) {
      try {
        child.children = await fetchBlockChildrenDeep(
          child.id,
          apiKey,
          remainingDepth - 1,
          maxBlocks,
        );
      } catch {
        child.children = [];
      }
    }
  }
  return limited;
}

/**
 * Walk a block tree (including nested children attached by
 * fetchPageBlocksDeep) and return every file URL it references: image
 * blocks, file blocks, pdf blocks, video blocks. Recurses into
 * block.children so files nested inside toggles/callouts/list-items
 * aren't missed.
 */
export function collectFileUrlsFromBlocks(blocks: any[]): string[] {
  const out: string[] = [];
  const walk = (list: any[]): void => {
    for (const b of list) {
      const body = b[b.type];
      if (body) {
        if (b.type === "image" || b.type === "file" || b.type === "pdf" || b.type === "video") {
          const url = body.external?.url ?? body.file?.url;
          if (typeof url === "string" && url) out.push(url);
        }
      }
      if (Array.isArray(b.children) && b.children.length > 0) walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

export async function fetchPageBlocks(pageId: string, apiKey: string): Promise<any[]> {
  const blocks: any[] = [];
  let cursor: string | undefined;
  do {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : `?page_size=100`;
    const res = await fetchNotion(`/blocks/${pageId}/children${qs}`, apiKey);
    blocks.push(...(res.results ?? []));
    cursor = res.has_more ? res.next_cursor : undefined;
    await sleep(RATE_DELAY_MS);
  } while (cursor);
  return blocks;
}

// ─── Property mapping ────────────────────────────────────────────

const NOTION_TO_MOLTBOT_TYPE: Record<string, PropertyType> = {
  title: "title",
  rich_text: "richText",
  select: "select",
  multi_select: "multiSelect",
  status: "status",
  date: "date",
  number: "number",
  checkbox: "checkbox",
  url: "url",
  email: "email",
  phone_number: "phone",
  files: "files",
  relation: "relation",
  people: "person",
  created_time: "createdAt",
  last_edited_time: "updatedAt",
  formula: "richText",
  rollup: "richText",
  unique_id: "richText",
  created_by: "person",
  last_edited_by: "person",
};

function propertyConfigFor(notionProp: any): PropertyConfig | null {
  if (notionProp.select?.options || notionProp.status?.options) {
    const raw = (notionProp.select?.options ?? notionProp.status?.options ?? []) as Array<{
      id: string;
      name: string;
      color?: string;
    }>;
    const options: SelectOption[] = raw.map((o) => ({
      id: o.id,
      name: o.name,
      color: notionColorToHex(o.color),
    }));
    return { options };
  }
  if (notionProp.multi_select?.options) {
    const raw = notionProp.multi_select.options as Array<{
      id: string;
      name: string;
      color?: string;
    }>;
    const options: SelectOption[] = raw.map((o) => ({
      id: o.id,
      name: o.name,
      color: notionColorToHex(o.color),
    }));
    return { options };
  }
  if (notionProp.number?.format) {
    return { format: notionProp.number.format };
  }
  if (notionProp.relation?.database_id) {
    return { targetDatabaseId: String(notionProp.relation.database_id) };
  }
  return null;
}

function notionColorToHex(color: string | undefined): string | undefined {
  const map: Record<string, string> = {
    default: "#64748b",
    gray: "#6b7280",
    brown: "#92400e",
    orange: "#f97316",
    yellow: "#eab308",
    green: "#10b981",
    blue: "#3b82f6",
    purple: "#a855f7",
    pink: "#ec4899",
    red: "#ef4444",
  };
  return color ? map[color] : undefined;
}

// ─── Row value mapping ───────────────────────────────────────────

export function richTextToMarkdown(rich: any[] | undefined): string {
  if (!Array.isArray(rich)) return "";
  return rich
    .map((r) => {
      let t = r.plain_text ?? "";
      if (r.annotations?.code) t = "`" + t + "`";
      if (r.annotations?.bold) t = "**" + t + "**";
      if (r.annotations?.italic) t = "*" + t + "*";
      if (r.annotations?.strikethrough) t = "~~" + t + "~~";
      if (r.href) t = `[${t}](${r.href})`;
      return t;
    })
    .join("");
}

function mapNotionValue(notionValue: any, targetType: PropertyType): PropertyValue | null {
  if (!notionValue) return null;
  const kind = notionValue.type;
  switch (kind) {
    case "title":
      return { type: "title", text: richTextToMarkdown(notionValue.title) };
    case "rich_text":
      return { type: "richText", markdown: richTextToMarkdown(notionValue.rich_text) };
    case "select":
      return { type: "select", optionId: notionValue.select?.id ?? null };
    case "status":
      return { type: "status", optionId: notionValue.status?.id ?? null };
    case "multi_select":
      return {
        type: "multiSelect",
        optionIds: (notionValue.multi_select ?? []).map((o: any) => o.id),
      };
    case "date":
      if (!notionValue.date) return { type: "date", iso: null };
      return notionValue.date.end
        ? {
            type: "dateRange",
            start: notionValue.date.start ?? null,
            end: notionValue.date.end ?? null,
          }
        : { type: "date", iso: notionValue.date.start ?? null };
    case "number":
      return { type: "number", value: notionValue.number ?? null };
    case "checkbox":
      return { type: "checkbox", checked: Boolean(notionValue.checkbox) };
    case "url":
      return { type: "url", url: notionValue.url ?? null };
    case "email":
      return { type: "email", email: notionValue.email ?? null };
    case "phone_number":
      return { type: "phone", phone: notionValue.phone_number ?? null };
    case "files":
      return {
        type: "files",
        files: (notionValue.files ?? []).map((f: any) => ({
          name: f.name ?? "file",
          url: f.file?.url ?? f.external?.url ?? "",
        })),
      };
    case "relation":
      return { type: "relation", rowIds: (notionValue.relation ?? []).map((r: any) => r.id) };
    case "people":
      return { type: "person", personIds: (notionValue.people ?? []).map((p: any) => p.id) };
    case "created_time":
      return { type: "createdAt", iso: notionValue.created_time };
    case "last_edited_time":
      return { type: "updatedAt", iso: notionValue.last_edited_time };
    case "formula": {
      const f = notionValue.formula;
      const str =
        f?.string ??
        (f?.number != null
          ? String(f.number)
          : f?.boolean != null
            ? String(f.boolean)
            : (f?.date?.start ?? ""));
      return { type: "richText", markdown: str };
    }
    case "rollup": {
      const r = notionValue.rollup;
      return { type: "richText", markdown: r?.string ?? JSON.stringify(r?.array ?? r) };
    }
    case "unique_id":
      return {
        type: "richText",
        markdown:
          (notionValue.unique_id?.prefix ? notionValue.unique_id.prefix + "-" : "") +
          (notionValue.unique_id?.number ?? ""),
      };
    case "created_by":
      return {
        type: "person",
        personIds: notionValue.created_by?.id ? [notionValue.created_by.id] : [],
      };
    case "last_edited_by":
      return {
        type: "person",
        personIds: notionValue.last_edited_by?.id ? [notionValue.last_edited_by.id] : [],
      };
    default:
      // Fallback: store plain_text-ish representation as richText
      return { type: "richText", markdown: JSON.stringify(notionValue).slice(0, 500) };
  }
}

// ─── Blocks → markdown for page body ─────────────────────────────

export function blocksToMarkdown(blocks: any[]): string {
  return blocksToMarkdownAt(blocks, 0);
}

/**
 * Inner renderer — tracks indentation depth so nested list items /
 * toggles / callouts render as proper indented markdown. Walks
 * block.children if present (attached by fetchPageBlocksDeep) so files
 * and paragraphs nested under collapsibles are visible.
 */
function blocksToMarkdownAt(blocks: any[], depth: number): string {
  const out: string[] = [];
  const indent = "  ".repeat(depth);
  for (const b of blocks) {
    const t = b.type;
    const body = b[t];
    if (!body) continue;
    const children = Array.isArray(b.children) ? b.children : [];
    const renderChildren =
      children.length > 0 ? "\n\n" + blocksToMarkdownAt(children, depth + 1) : "";
    switch (t) {
      case "paragraph":
        out.push(indent + richTextToMarkdown(body.rich_text));
        if (renderChildren) out.push(renderChildren.trim());
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
        out.push(`${indent}- ${richTextToMarkdown(body.rich_text)}${renderChildren}`);
        break;
      case "numbered_list_item":
        out.push(`${indent}1. ${richTextToMarkdown(body.rich_text)}${renderChildren}`);
        break;
      case "to_do":
        out.push(
          `${indent}- [${body.checked ? "x" : " "}] ${richTextToMarkdown(body.rich_text)}${renderChildren}`,
        );
        break;
      case "toggle":
        out.push(
          `${indent}<details><summary>${richTextToMarkdown(body.rich_text)}</summary>\n\n${blocksToMarkdownAt(children, depth + 1)}\n\n${indent}</details>`,
        );
        break;
      case "quote":
        out.push(`${indent}> ${richTextToMarkdown(body.rich_text)}${renderChildren}`);
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
        if (url) out.push(`![image](${url})`);
        break;
      }
      case "video": {
        const url = body.file?.url ?? body.external?.url;
        if (url) out.push(`<video src="${url}" controls></video>`);
        break;
      }
      case "bookmark":
        if (body.url) out.push(`[${body.url}](${body.url})`);
        break;
      case "callout":
        out.push(`${indent}> 💡 ${richTextToMarkdown(body.rich_text)}${renderChildren}`);
        break;
      case "child_page":
        if (body.title) out.push(`## ${body.title}`);
        break;
      case "child_database":
        if (body.title) out.push(`### 📊 ${body.title} (linked database)`);
        break;
      case "file": {
        const url = body.file?.url ?? body.external?.url;
        const name = body.name ?? "file";
        if (url) out.push(`📎 [${name}](${url})`);
        break;
      }
      case "pdf": {
        const url = body.file?.url ?? body.external?.url;
        if (url) out.push(`📄 [PDF](${url})`);
        break;
      }
      case "embed":
        if (body.url) out.push(`<iframe src="${body.url}"></iframe>`);
        break;
      case "link_preview":
        if (body.url) out.push(`[${body.url}](${body.url})`);
        break;
      case "equation":
        if (body.expression) out.push(`$$${body.expression}$$`);
        break;
      case "column_list":
      case "column":
        // Containers — just render their children inline.
        if (renderChildren) out.push(renderChildren.trim());
        break;
      case "synced_block":
        if (renderChildren) out.push(renderChildren.trim());
        break;
      case "table_of_contents":
        out.push("<!-- table of contents -->");
        break;
    }
  }
  return out.join("\n\n");
}

// ─── Main import ────────────────────────────────────────────────

export async function importFromNotion(
  store: DatabasesStore,
  opts: ImportOptions = {},
): Promise<ImportReport> {
  const apiKey = resolveApiKey(opts.apiKey);
  const log = (line: string) => opts.onLog?.(line);
  const warnings: string[] = [];
  const imported: ImportReport["imported"] = [];

  log("Enumerating Notion databases…");
  const allDbs = await listDatabases(apiKey);
  log(`Found ${allDbs.length} databases.`);

  const targetDbs = opts.databaseIds?.length
    ? allDbs.filter((d) => opts.databaseIds!.includes(d.id))
    : allDbs;

  for (const notionDb of targetDbs) {
    const title = richTextToMarkdown(notionDb.title) || "Untitled";
    log(`→ ${title} (${notionDb.id})`);

    // Find prior import of this Notion DB regardless of `source` — older
    // imports may have used a different source string, and a `source`
    // filter was making re-imports look "new" and triggering UNIQUE
    // constraint violations on the property table.
    const existing = store.listDatabases().find((d) => d.meta?.notionDatabaseId === notionDb.id);

    // Stable local id we can use to scope property ids. Generate up-front
    // when creating fresh; reuse the existing one on re-import. Property
    // ids are now `<localDbId>:n:<notionPropId>` so a second import of
    // the same Notion DB into a different local table can't collide on
    // the global `database_properties.id` PRIMARY KEY.
    const dbId = existing?.id ?? `db_${randomUUID()}`;
    const localPropIdFor = (notionPropId: string) => `${dbId}:n:${notionPropId}`;

    let dbRecord: DatabaseRecord;
    const notionPropEntries = Object.entries(notionDb.properties ?? {}) as Array<[string, any]>;
    const notionPropIdToLocal: Record<string, string> = {};
    const propertySpecs = notionPropEntries
      .map(([name, prop]) => {
        const mapped = NOTION_TO_MOLTBOT_TYPE[prop.type];
        if (!mapped) {
          warnings.push(
            `${title}: unsupported property type "${prop.type}" on column "${name}" — skipped`,
          );
          return null;
        }
        const localId = localPropIdFor(prop.id);
        notionPropIdToLocal[prop.id] = localId;
        return {
          id: localId,
          name,
          type: mapped,
          config: propertyConfigFor(prop),
          hidden: false,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    if (existing) {
      dbRecord = existing;
      // Refresh name + meta
      store.updateDatabase(existing.id, {
        name: title,
        meta: { ...existing.meta, notionDatabaseId: notionDb.id, lastImportedAt: Date.now() },
      });
      // Upsert schema. Re-imports propagate Notion property renames /
      // type changes; missing properties become new local columns.
      const existingProps = store.listProperties(existing.id);
      const existingPropIds = new Set(existingProps.map((p) => p.id));
      for (let i = 0; i < propertySpecs.length; i++) {
        const spec = propertySpecs[i]!;
        if (existingPropIds.has(spec.id)) {
          store.updateProperty(spec.id, {
            name: spec.name,
            type: spec.type,
            config: spec.config,
          });
        } else {
          store.createProperty({
            databaseId: existing.id,
            id: spec.id,
            name: spec.name,
            type: spec.type,
            config: spec.config,
            hidden: spec.hidden,
            sortOrder: (i + 1) * 1000,
          });
        }
      }
    } else {
      dbRecord = store.createDatabase({
        id: dbId,
        name: title,
        icon: notionDb.icon?.emoji ?? "🗃️",
        description: richTextToMarkdown(notionDb.description),
        source: "notion-import",
        meta: { notionDatabaseId: notionDb.id, lastImportedAt: Date.now() },
        properties: propertySpecs,
      });
    }

    // Pull all rows
    const rows = await queryAllRows(notionDb.id, apiKey);
    log(`  ${rows.length} rows`);

    let imported_count = 0;
    for (const page of rows) {
      const rowId = `notion_${page.id}`;
      const titleText = (() => {
        for (const [, p] of Object.entries(page.properties) as Array<[string, any]>) {
          if (p?.type === "title") return richTextToMarkdown(p.title);
        }
        return "";
      })();

      const values: Record<string, PropertyValue> = {};
      for (const [_name, notionValue] of Object.entries(page.properties) as Array<[string, any]>) {
        const mappedType = NOTION_TO_MOLTBOT_TYPE[notionValue.type];
        if (!mappedType) continue;
        const propId = notionPropIdToLocal[notionValue.id];
        if (!propId) continue;
        const v = mapNotionValue(notionValue, mappedType);
        if (v) values[propId] = v;
      }

      // Deep block fetch: walks sub-pages (up to depth 2) and the
      // children of toggles, callouts, list items, and columns (up to
      // depth 4) so files and paragraphs nested inside those aren't
      // lost. Without this, a Notion page with most of its content
      // under a single "Details" toggle would import as an empty body.
      let body: string | null = null;
      try {
        const blocks = await fetchPageBlocksDeep(page.id, apiKey, {
          maxDepth: 2,
          maxBlocksPerPage: 200,
        });
        if (blocks.length) body = blocksToMarkdown(blocks);
      } catch (e) {
        warnings.push(
          `${title}: could not fetch body for "${titleText}" — ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      store.upsertRow({
        id: rowId,
        databaseId: dbRecord.id,
        title: titleText || "Untitled",
        body,
        values,
      });
      imported_count++;
    }

    imported.push({
      databaseId: dbRecord.id,
      notionDatabaseId: notionDb.id,
      name: title,
      rowCount: imported_count,
    });
  }

  log(
    `Import complete: ${imported.length} databases, ${imported.reduce((a, b) => a + b.rowCount, 0)} rows total.`,
  );
  return { imported, warnings };
}
