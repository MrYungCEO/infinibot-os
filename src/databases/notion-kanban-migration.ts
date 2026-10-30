/**
 * One-time migration from configured Notion kanban DBs into the
 * local SQLite store.
 *
 * Pre-revamp, kanban data lived in two specific Notion databases (the
 * databases selected during setup. This migration pulls those rows down once so users upgrading
 * keep their data, then flips sync mode appropriately.
 *
 * Safe to re-run: the migration upserts on the original Notion page id
 * preserved in `externalRef.externalId`, so a second run is a no-op for rows
 * already imported.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getNotionConfig, getNotionApiKeyOrNull } from "./notion-config.js";
import { resolveKanbanDatabase } from "./kanban-store-ops.js";
import type { DatabasesStore } from "./store.js";
import type { DatabaseProperty, DatabaseRecord, PropertyValue } from "./types.js";

const log = createSubsystemLogger("notion-kanban-migration");

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export interface MigrationResult {
  ok: boolean;
  skipped?: "no_api_key" | "already_migrated" | "no_legacy_data";
  imported?: { projects: number; tasks: number };
  /** Map of legacy Notion page id → newly assigned local row id. */
  idMap?: Record<string, string>;
  message?: string;
}

const MIGRATION_FLAG_META_KEY = "__legacyNotionMigrationCompletedAt";

export async function migrateLegacyNotionKanban(): Promise<MigrationResult> {
  const apiKey = getNotionApiKeyOrNull();
  if (!apiKey) {
    return { ok: true, skipped: "no_api_key", message: "No Notion API key configured." };
  }

  const cfg = getNotionConfig();
  const projectsSource = cfg.projectsDbId;
  const tasksSource = cfg.tasksDbId;
  if (!projectsSource || !tasksSource) {
    return {
      ok: true,
      skipped: "no_legacy_data",
      message: "No Notion projects/tasks databases configured.",
    };
  }

  const projectsCtx = resolveKanbanDatabase("projects");
  const tasksCtx = resolveKanbanDatabase("tasks");

  if (isAlreadyMigrated(projectsCtx.database) && isAlreadyMigrated(tasksCtx.database)) {
    return { ok: true, skipped: "already_migrated" };
  }

  const idMap: Record<string, string> = {};
  let importedProjects = 0;
  let importedTasks = 0;

  try {
    // Projects pass first so the relation rebuild can resolve targets.
    const projectPages = await safeQueryAll(apiKey, projectsSource);
    if (!projectPages.length) {
      // Mark as completed so we don't re-poll on every gateway start.
      stampMigrationComplete(projectsCtx.store, projectsCtx.database.id);
      stampMigrationComplete(tasksCtx.store, tasksCtx.database.id);
      return { ok: true, skipped: "no_legacy_data" };
    }

    const projProps = projectsCtx.store.listProperties(projectsCtx.database.id);
    for (const page of projectPages) {
      const id = upsertFromNotionPage({
        store: projectsCtx.store,
        databaseId: projectsCtx.database.id,
        properties: projProps,
        page,
        kind: "project",
      });
      if (id) {
        idMap[page.id] = id;
        importedProjects++;
      }
    }

    const taskPages = await safeQueryAll(apiKey, tasksSource);
    const taskProps = tasksCtx.store.listProperties(tasksCtx.database.id);
    for (const page of taskPages) {
      const id = upsertFromNotionPage({
        store: tasksCtx.store,
        databaseId: tasksCtx.database.id,
        properties: taskProps,
        page,
        kind: "task",
        idMap,
      });
      if (id) {
        idMap[page.id] = id;
        importedTasks++;
      }
    }

    stampMigrationComplete(projectsCtx.store, projectsCtx.database.id);
    stampMigrationComplete(tasksCtx.store, tasksCtx.database.id);

    log.info("legacy notion kanban migration complete", {
      projects: importedProjects,
      tasks: importedTasks,
    });
    return {
      ok: true,
      imported: { projects: importedProjects, tasks: importedTasks },
      idMap,
    };
  } catch (err) {
    log.warn("legacy notion kanban migration failed", { error: (err as Error).message });
    return { ok: false, message: (err as Error).message };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

function isAlreadyMigrated(db: DatabaseRecord): boolean {
  return Boolean(db.meta?.[MIGRATION_FLAG_META_KEY]);
}

function stampMigrationComplete(store: DatabasesStore, databaseId: string): void {
  const db = store.getDatabase(databaseId);
  if (!db) return;
  store.updateDatabase(databaseId, {
    meta: { ...db.meta, [MIGRATION_FLAG_META_KEY]: Date.now() },
  });
}

async function safeQueryAll(apiKey: string, databaseId: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    try {
      const res = (await notionFetch(apiKey, `/databases/${databaseId}/query`, {
        method: "POST",
        body: JSON.stringify(body),
      })) as { results?: any[]; has_more?: boolean; next_cursor?: string };
      out.push(...(res.results ?? []));
      cursor = res.has_more ? res.next_cursor : undefined;
    } catch (err) {
      // 404 from a legacy DB simply means the user never had it — return what we have.
      if (/404/.test((err as Error).message)) return out;
      throw err;
    }
  } while (cursor);
  return out;
}

interface UpsertFromNotionInput {
  store: DatabasesStore;
  databaseId: string;
  properties: DatabaseProperty[];
  page: any;
  kind: "project" | "task";
  idMap?: Record<string, string>;
}

function upsertFromNotionPage(input: UpsertFromNotionInput): string | null {
  const { store, databaseId, properties, page, kind } = input;
  const titleText = readNotionTitle(page);
  if (!titleText) return null;

  // De-dupe: if a row already exists with the same externalId, update it.
  const existing = store.listRows(databaseId).find((r) => r.externalRef?.externalId === page.id);

  const values: Record<string, PropertyValue> = {};
  const titleProp = properties.find((p) => p.type === "title");
  if (titleProp) values[titleProp.id] = { type: "title", text: titleText };

  const setOption = (propName: string, optionName: string | null) => {
    if (!optionName) return;
    const prop = properties.find((p) => p.name.toLowerCase() === propName.toLowerCase());
    if (!prop) return;
    const opt = prop.config?.options?.find(
      (o) => o.name.toLowerCase() === optionName.toLowerCase(),
    );
    const optionId = opt?.id ?? null;
    if (prop.type === "select") values[prop.id] = { type: "select", optionId };
    else if (prop.type === "status") values[prop.id] = { type: "status", optionId };
  };

  // Common-ish properties — nothing fancy, just pull what we recognize.
  setOption("Status", readNotionStatus(page) || readNotionSelect(page, "Status Update"));
  setOption(
    "Priority",
    readNotionSelect(page, "Priority") || readNotionSelect(page, "Priority Level"),
  );

  const descProp = properties.find((p) => p.name.toLowerCase() === "description");
  if (descProp) {
    const md = readNotionRichText(page, "Description") || readNotionRichText(page, "Notes");
    values[descProp.id] = { type: "richText", markdown: md };
  }

  if (kind === "task") {
    const projectProp = properties.find((p) => p.name.toLowerCase() === "project");
    const projectRel = page.properties?.Project?.relation?.[0]?.id as string | undefined;
    if (projectProp && projectRel) {
      const localId = input.idMap?.[projectRel];
      if (localId) values[projectProp.id] = { type: "relation", rowIds: [localId] };
    }
    const dueProp = properties.find((p) => p.name.toLowerCase() === "due");
    const dueIso =
      (page.properties?.["Due Date"]?.date?.start ?? page.properties?.Due?.date?.start) || null;
    if (dueProp) values[dueProp.id] = { type: "date", iso: dueIso };
  }

  const upserted = store.upsertRow({
    id: existing?.id,
    databaseId,
    title: titleText,
    values,
    externalRef: {
      system: "notion",
      externalId: page.id,
      lastSyncedAt: Date.now(),
    },
  });
  return upserted.id;
}

function readNotionTitle(page: any): string {
  const props = page?.properties ?? {};
  for (const value of Object.values(props)) {
    const v = value as { type?: string; title?: Array<{ plain_text?: string }> };
    if (v?.type === "title" && Array.isArray(v.title)) {
      const t = v.title.map((seg) => seg.plain_text ?? "").join("");
      if (t) return t;
    }
  }
  return "";
}

function readNotionStatus(page: any): string | null {
  const props = page?.properties ?? {};
  for (const v of Object.values(props)) {
    const cast = v as { type?: string; status?: { name?: string } };
    if (cast?.type === "status" && cast.status?.name) return cast.status.name;
  }
  return null;
}

function readNotionSelect(page: any, key: string): string | null {
  const v = page?.properties?.[key];
  return v?.select?.name ?? v?.status?.name ?? null;
}

function readNotionRichText(page: any, key: string): string {
  const v = page?.properties?.[key];
  if (!v?.rich_text) return "";
  return (v.rich_text as Array<{ plain_text?: string }>).map((r) => r.plain_text ?? "").join("");
}

async function notionFetch(apiKey: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${NOTION_API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (body as any)?.message ?? JSON.stringify(body);
    throw new Error(`Notion API ${res.status}: ${detail}`);
  }
  return body;
}
