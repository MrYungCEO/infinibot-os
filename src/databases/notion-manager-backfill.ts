/**
 * Backfill — migrate entries from the legacy Notion Database Manager into
 * the new generic databases store.
 *
 * The legacy manager stores databases + their schemas in
 *   $STATE_DIR/notion-databases.json
 * as JSON. Each entry has databaseId, name, icon, schema (properties +
 * options), lastSync, pageCount. We mirror each entry into the SQLite
 * store as a `notion-import` source database with matching properties.
 *
 * Idempotent: if a database with
 *   source = "notion-import"  AND  meta.notionDatabaseId = entry.databaseId
 * already exists, we refresh its name + icon, leave schema alone (so user
 * schema tweaks aren't clobbered). Otherwise we create it fresh.
 *
 * Rows are NOT imported here — this is the "shell" backfill so users can
 * see their Notion DBs in the sidebar immediately. Full row sync happens
 * through the existing Notion importer (importFromNotion).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../config/paths.js";
import type { DatabasesStore } from "./store.js";
import type {
  DatabaseRecord,
  PropertyConfig,
  PropertyType,
  SelectOption,
} from "./types.js";

// Mirror of the legacy manager's schema shape — kept local to avoid a
// cross-module dependency on the handler file.
interface LegacyNotionProperty {
  id: string;
  name: string;
  type: string;
  options?: Array<{ id: string; name: string; color?: string }>;
}

interface LegacyNotionEntry {
  id: string;
  databaseId: string;
  name: string;
  icon?: string;
  schema?: {
    databaseId: string;
    databaseName: string;
    properties: Record<string, LegacyNotionProperty>;
    fetchedAt: number;
  };
  lastSync: number | null;
  addedAt?: string;
  pageCount?: number;
}

interface LegacyNotionState {
  databases: LegacyNotionEntry[];
}

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

function propertyConfigFor(prop: LegacyNotionProperty): PropertyConfig | null {
  if (prop.options && prop.options.length > 0) {
    const options: SelectOption[] = prop.options.map((o) => ({
      id: o.id,
      name: o.name,
      color: notionColorToHex(o.color),
    }));
    return { options };
  }
  return null;
}

function legacyStatePath(): string {
  return path.join(STATE_DIR, "notion-databases.json");
}

function readLegacyState(): LegacyNotionState | null {
  const p = legacyStatePath();
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return {
      databases: Array.isArray(raw?.databases) ? raw.databases : [],
    };
  } catch {
    return null;
  }
}

export interface BackfillReport {
  scanned: number;
  created: number;
  refreshed: number;
  skipped: number;
  details: Array<{
    name: string;
    notionDatabaseId: string;
    action: "created" | "refreshed" | "skipped";
    databaseId: string;
    reason?: string;
  }>;
}

export function backfillFromNotionManager(store: DatabasesStore): BackfillReport {
  const report: BackfillReport = {
    scanned: 0,
    created: 0,
    refreshed: 0,
    skipped: 0,
    details: [],
  };

  const legacy = readLegacyState();
  if (!legacy) return report;

  report.scanned = legacy.databases.length;

  // Index existing notion-import databases by notionDatabaseId so we can
  // dedupe without a full scan per entry.
  const existingByNotionId = new Map<string, DatabaseRecord>();
  for (const db of store.listDatabases()) {
    if (db.source !== "notion-import") continue;
    const notionId = db.meta?.notionDatabaseId;
    if (typeof notionId === "string") existingByNotionId.set(notionId, db);
  }

  for (const entry of legacy.databases) {
    const notionId = entry.databaseId;
    if (!notionId) {
      report.skipped++;
      report.details.push({
        name: entry.name ?? "(no name)",
        notionDatabaseId: "",
        action: "skipped",
        databaseId: "",
        reason: "missing databaseId",
      });
      continue;
    }

    const existing = existingByNotionId.get(notionId);

    if (existing) {
      // Refresh name + icon + meta, leave schema alone.
      store.updateDatabase(existing.id, {
        name: entry.name ?? existing.name,
        icon: entry.icon ?? existing.icon ?? "🗃️",
        meta: {
          ...existing.meta,
          notionDatabaseId: notionId,
          lastBackfilledAt: Date.now(),
          pageCount: entry.pageCount ?? existing.meta?.pageCount ?? null,
        },
      });
      report.refreshed++;
      report.details.push({
        name: entry.name ?? existing.name,
        notionDatabaseId: notionId,
        action: "refreshed",
        databaseId: existing.id,
      });
      continue;
    }

    // Map legacy schema properties.
    const propertySpecs = Object.entries(entry.schema?.properties ?? {})
      .map(([name, prop]) => {
        const mapped = NOTION_TO_MOLTBOT_TYPE[prop.type];
        if (!mapped) return null;
        return {
          id: `notion_${prop.id}`,
          name,
          type: mapped,
          config: propertyConfigFor(prop),
          hidden: false,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    // Ensure a title property exists — the generic store expects one for row.title.
    const hasTitle = propertySpecs.some((p) => p.type === "title");
    if (!hasTitle) {
      propertySpecs.unshift({
        id: `notion_title_synth`,
        name: "Name",
        type: "title",
        config: null,
        hidden: false,
      });
    }

    const created = store.createDatabase({
      name: entry.name ?? "Untitled Notion DB",
      icon: entry.icon ?? "🗃️",
      description: null,
      source: "notion-import",
      meta: {
        notionDatabaseId: notionId,
        lastBackfilledAt: Date.now(),
        pageCount: entry.pageCount ?? null,
        legacyManagerId: entry.id,
      },
      properties: propertySpecs,
    });

    existingByNotionId.set(notionId, created);
    report.created++;
    report.details.push({
      name: created.name,
      notionDatabaseId: notionId,
      action: "created",
      databaseId: created.id,
    });
  }

  return report;
}
