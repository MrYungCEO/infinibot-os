/**
 * One-time migration: Content Studio moved from core into the
 * `content-studio` plugin, which is bundled but OFF by default.
 *
 * On the first boot after the move, an install that already has content
 * studio data keeps the feature: the plugin entry is written as enabled and
 * the seed-managed content roster agents are handed over to the plugin (so
 * the plugin refreshes them, and turning the plugin off removes them again).
 * A fresh install — or one that never used the content studio — stays off.
 *
 * Runs once per state dir: a marker in `<stateDir>/plugin-data/content-studio/`
 * records the decision. An explicit `plugins.entries.content-studio.enabled`
 * (true or false) always wins and is never touched. Data is never moved or
 * deleted: the stores keep their existing paths (see
 * docs/plugins/CONTENT-STUDIO.md).
 */

import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type { InfinibotConfig } from "../config/config.js";
import { CONTENT_STUDIO_PLUGIN_ID } from "./methods.js";

export const CONTENT_STUDIO_MIGRATION_VERSION = 1;
export const CONTENT_STUDIO_MIGRATION_MARKER = ".migration.json";

/** Roster agents that ship with the plugin (extensions/content-studio/agents). */
export const CONTENT_STUDIO_AGENT_IDS = [
  "cmo",
  "content-director",
  "scriptwriter",
  "brand-designer",
  "video-editor-agent",
] as const;

function countRows(dbPath: string, table: string): number {
  if (!fs.existsSync(dbPath)) return 0;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!exists) return 0;
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n?: number };
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  } finally {
    db?.close();
  }
}

function nonEmptyFile(file: string): boolean {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

/**
 * Evidence that this install used the content studio. Each entry is a short
 * human-readable reason; empty = no data. `stateDirs` are checked in order
 * (the resolved state dir and the legacy cwd-relative "state" dir the content
 * pages store historically used).
 */
export function detectContentStudioData(stateDirs: string[]): string[] {
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const dir of stateDirs) {
    const abs = path.resolve(dir);
    if (seen.has(abs)) continue;
    seen.add(abs);
    const reels = countRows(path.join(abs, "content-intel.db"), "reels");
    if (reels > 0) reasons.push(`${reels} reels in ${path.join(abs, "content-intel.db")}`);
    const databases = path.join(abs, "databases.db");
    const pages = countRows(databases, "content_pages");
    if (pages > 0) reasons.push(`${pages} content pages in ${databases}`);
    const examples = countRows(databases, "viral_examples");
    if (examples > 0) reasons.push(`${examples} viral examples in ${databases}`);
    const benchmarks =
      countRows(path.join(abs, "viral-formats.db"), "watched_items") +
      countRows(path.join(abs, "viral-formats.db"), "benchmarks");
    if (benchmarks > 0) reasons.push(`viral-format benchmarks in ${abs}`);
    if (nonEmptyFile(path.join(abs, "socials", "analytics.db"))) {
      reasons.push(`social analytics in ${path.join(abs, "socials")}`);
    }
    for (const secret of ["instagram.json", "manychat.json"]) {
      if (nonEmptyFile(path.join(abs, "secrets", secret))) {
        reasons.push(`connected ${secret.replace(".json", "")} account (${abs}/secrets)`);
      }
    }
  }
  return reasons;
}

type Marker = {
  version: number;
  decidedAt: string;
  enabled: boolean;
  reasons: string[];
};

export function readContentStudioMarker(pluginDataDir: string): Marker | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(pluginDataDir, CONTENT_STUDIO_MIGRATION_MARKER), "utf8"),
    ) as Marker;
  } catch {
    return null;
  }
}

function writeMarker(pluginDataDir: string, marker: Marker): void {
  fs.mkdirSync(pluginDataDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDataDir, CONTENT_STUDIO_MIGRATION_MARKER),
    `${JSON.stringify(marker, null, 2)}\n`,
  );
}

type PluginEntries = Record<string, Record<string, unknown>>;

function entriesOf(cfg: InfinibotConfig): PluginEntries {
  const plugins = (cfg as Record<string, unknown>).plugins as { entries?: unknown } | undefined;
  const entries = plugins?.entries;
  return entries && typeof entries === "object" ? (entries as PluginEntries) : {};
}

/**
 * Hand the seed-managed content agents (written by the core roster before the
 * move: `_seedVersion` set, no `_plugin`) to the plugin. Their `_seedVersion`
 * no longer matches the plugin's, so the plugin seeder refreshes them; an
 * agent the operator customised (no `_seedVersion`) is left alone.
 */
function adoptContentAgents(cfg: InfinibotConfig): string[] {
  const agents = (cfg as Record<string, unknown>).agents as
    | { list?: Array<Record<string, unknown>> }
    | undefined;
  const adopted: string[] = [];
  for (const entry of agents?.list ?? []) {
    const id = typeof entry?.id === "string" ? entry.id : "";
    if (!(CONTENT_STUDIO_AGENT_IDS as readonly string[]).includes(id)) continue;
    if (typeof entry._seedVersion !== "string" || entry._plugin !== undefined) continue;
    entry._plugin = CONTENT_STUDIO_PLUGIN_ID;
    adopted.push(id);
  }
  return adopted;
}

export type ContentStudioMigrationResult = {
  /** True when `config` was changed and must be written. */
  changed: boolean;
  config: InfinibotConfig;
  /** What happened, for the boot log. Null when the migration already ran. */
  summary: string | null;
};

/**
 * Decide the plugin's initial state for an install upgrading past the move.
 * Pure apart from reading the stores (read-only) and writing the marker.
 */
export function migrateContentStudioEnablement(params: {
  config: InfinibotConfig;
  /** `<stateDir>/plugin-data/content-studio` (marker location). */
  pluginDataDir: string;
  /** Dirs to look for existing content data in. */
  stateDirs: string[];
  now?: () => Date;
}): ContentStudioMigrationResult {
  const { config, pluginDataDir } = params;
  const now = params.now ?? (() => new Date());
  if (readContentStudioMarker(pluginDataDir)) {
    return { changed: false, config, summary: null };
  }
  const entry = entriesOf(config)[CONTENT_STUDIO_PLUGIN_ID];
  if (typeof entry?.enabled === "boolean") {
    writeMarker(pluginDataDir, {
      version: CONTENT_STUDIO_MIGRATION_VERSION,
      decidedAt: now().toISOString(),
      enabled: entry.enabled,
      reasons: ["explicit plugins.entries.content-studio.enabled"],
    });
    return {
      changed: false,
      config,
      summary: `content-studio: kept explicit enabled=${entry.enabled}`,
    };
  }
  const reasons = detectContentStudioData(params.stateDirs);
  if (reasons.length === 0) {
    writeMarker(pluginDataDir, {
      version: CONTENT_STUDIO_MIGRATION_VERSION,
      decidedAt: now().toISOString(),
      enabled: false,
      reasons: [],
    });
    return {
      changed: false,
      config,
      summary: "content-studio: no existing data, plugin stays off",
    };
  }
  const plugins = ((config as Record<string, unknown>).plugins ?? {}) as Record<string, unknown>;
  const entries = { ...entriesOf(config) };
  entries[CONTENT_STUDIO_PLUGIN_ID] = { ...entries[CONTENT_STUDIO_PLUGIN_ID], enabled: true };
  (config as Record<string, unknown>).plugins = { ...plugins, entries };
  const adopted = adoptContentAgents(config);
  writeMarker(pluginDataDir, {
    version: CONTENT_STUDIO_MIGRATION_VERSION,
    decidedAt: now().toISOString(),
    enabled: true,
    reasons,
  });
  return {
    changed: true,
    config,
    summary:
      `content-studio: existing data found (${reasons.join("; ")}) — plugin enabled` +
      (adopted.length > 0 ? `; agents handed to the plugin: ${adopted.join(", ")}` : ""),
  };
}
