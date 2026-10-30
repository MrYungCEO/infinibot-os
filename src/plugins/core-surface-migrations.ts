/**
 * One-time migrations for core surfaces that became first-party plugins.
 *
 * A fresh install ships these plugins OFF (bundled plugins are disabled by
 * default). An existing install must not silently lose a surface its owner
 * uses, so on the first boot after the move each entry below checks for the
 * owner's existing data and, if there is some, writes
 * `plugins.entries.<id>.enabled = true`. The owner can turn it off in
 * Setup › Plugins afterwards; that choice is never overridden because:
 *   - an explicit `enabled` (true or false) in config is always respected, and
 *   - each migration runs once per state dir: "no data" / "owner already
 *     chose" is recorded in `<stateDir>/plugin-migrations.json`, and an
 *     enable is recorded by the explicit `enabled: true` itself.
 * Nothing here moves or deletes data (plugins move their own data lazily).
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { InfinibotConfig } from "../config/config.js";
import {
  adoptBusinessAgencyAgents,
  businessAgencyHasExistingData,
} from "../business-agency/migration.js";
import { cloudPluginDecision } from "../saas/fleet-plugins.js";
import { canvasLibraryHasExistingData } from "./canvas-library-migration.js";

export type CoreSurfaceMigration = {
  /** Plugin that now owns the surface. */
  pluginId: string;
  /** Surface name for logs ("Discipline (Day + Focus board)"). */
  label: string;
  /** True when the owner has data the surface would show. Must not throw. */
  hasExistingData: (stateDir: string) => boolean;
  /**
   * Optional: hand seed-managed roster agents to the plugin (tag `_plugin`),
   * run once when the migration first decides — whatever it decides. Plugin
   * roster reconciliation then keeps them while the plugin is on and removes
   * them while it is off. Mutates and returns the config.
   */
  adoptAgents?: (config: InfinibotConfig) => { config: InfinibotConfig; adopted: string[] };
  /**
   * Optional: false = not decided on this boot (no marker written), so it is
   * checked again next boot. For migrations that only apply in some
   * environments (a hosted fleet Machine).
   */
  applies?: () => boolean;
  /** Optional boot-log line for an enable (default: the core-surface wording). */
  enabledNote?: string;
};

const MARKER_FILE = "plugin-migrations.json";

type MarkerEntry = { at: string; result: "no-data" | "explicit" };

// ── Discipline ──────────────────────────────────────────────────────────────

/** User-authored tables only: discipline_events / day_start fill themselves
 *  from agent activity even on installs that never opened the page. */
const DISCIPLINE_USER_TABLES = [
  "discipline_blocks",
  "discipline_logs",
  "discipline_templates",
  "discipline_routine_completions",
];

function sqliteHasRows(file: string, tables: string[]): boolean {
  if (!fs.existsSync(file)) return false;
  let db: { prepare: (sql: string) => { get: () => unknown }; close: () => void } | null = null;
  try {
    // Lazy: better-sqlite3 is native; only load it when a DB is present.
    const Database = createRequire(import.meta.url)("better-sqlite3") as new (
      f: string,
      o: { readonly: boolean; fileMustExist: boolean },
    ) => NonNullable<typeof db>;
    db = new Database(file, { readonly: true, fileMustExist: true });
    for (const table of tables) {
      try {
        const row = db.prepare(`SELECT 1 AS x FROM ${table} LIMIT 1`).get();
        if (row) return true;
      } catch {
        /* table missing in an old schema */
      }
    }
    return false;
  } catch {
    // Can't read it (locked, corrupt): the file exists, so assume it matters.
    return true;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

function focusFileHasItems(file: string): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as { items?: unknown[] };
    return Array.isArray(data.items) && data.items.length > 0;
  } catch {
    return false;
  }
}

export function disciplineHasExistingData(stateDir: string): boolean {
  const pluginDir = path.join(stateDir, "plugin-data", "discipline");
  return (
    sqliteHasRows(path.join(stateDir, "discipline.db"), DISCIPLINE_USER_TABLES) ||
    sqliteHasRows(path.join(pluginDir, "discipline.db"), DISCIPLINE_USER_TABLES) ||
    focusFileHasItems(path.join(stateDir, "focus.json")) ||
    focusFileHasItems(path.join(pluginDir, "focus.json"))
  );
}

/**
 * InfiniBot Cloud: every plan includes Robovoice (src/saas/cloud-plan-plugins.ts),
 * but bundled plugins ship off, so tenants saw "The Robovoice plugin is turned
 * off on this install". On a fleet tenant Machine where Robovoice may load
 * (voice broker configured), turn it on once. The tenant's own on/off choice
 * wins, as for every migration here. Elsewhere it is not decided at all.
 */
export const FLEET_ROBOVOICE_MIGRATION: CoreSurfaceMigration = {
  pluginId: "robovoice",
  label: "Robovoice (included in every InfiniBot Cloud plan)",
  applies: () => cloudPluginDecision("robovoice", "bundled")?.loadable === true,
  hasExistingData: () => true,
  enabledNote:
    "Robovoice is included in your InfiniBot Cloud plan — turned ON (turn it off in Setup › Plugins).",
};

export const CORE_SURFACE_MIGRATIONS: CoreSurfaceMigration[] = [
  {
    pluginId: "discipline",
    label: "Discipline (Day + Focus board)",
    hasExistingData: disciplineHasExistingData,
  },
  {
    // Same marker key (`core-surface:canvas-library`) as the standalone
    // applyCanvasLibraryMigration, so installs that ran either agree.
    pluginId: "canvas-library",
    label: "Canvas Library (HoloCanvas)",
    hasExistingData: canvasLibraryHasExistingData,
  },
  {
    // Business HQ, Command, Clients, Sales Pipeline, Register, Leads &
    // Funnels, Settings › Business, the agency selector + business agents.
    pluginId: "business-agency",
    label: "Business & Agency (HQ, Command, Clients, Pipeline, Register)",
    hasExistingData: businessAgencyHasExistingData,
    adoptAgents: adoptBusinessAgencyAgents,
  },
  FLEET_ROBOVOICE_MIGRATION,
];

// ── runner ──────────────────────────────────────────────────────────────────

function readMarkers(stateDir: string): Record<string, MarkerEntry> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, MARKER_FILE), "utf-8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeMarkers(stateDir: string, markers: Record<string, MarkerEntry>): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, MARKER_FILE),
    `${JSON.stringify(markers, null, 2)}\n`,
    "utf-8",
  );
}

export type CoreSurfaceMigrationResult = {
  config: InfinibotConfig;
  /** Human lines for the boot log; non-empty ⇒ config changed. */
  changes: string[];
};

export function applyCoreSurfacePluginMigrations(params: {
  config: InfinibotConfig;
  stateDir: string;
  /** More per-user state dirs to check for data (hosted fleet tenant dirs).
   *  Markers still live in `stateDir`. */
  extraDataDirs?: string[];
  migrations?: CoreSurfaceMigration[];
  now?: () => Date;
}): CoreSurfaceMigrationResult {
  const migrations = params.migrations ?? CORE_SURFACE_MIGRATIONS;
  const markers = readMarkers(params.stateDir);
  let next = params.config;
  const changes: string[] = [];
  let markersChanged = false;
  const at = (params.now?.() ?? new Date()).toISOString();

  for (const m of migrations) {
    const key = `core-surface:${m.pluginId}`;
    if (markers[key]) continue;
    if (m.applies && !m.applies()) continue;
    // Idempotent (already-adopted agents are skipped), so no marker of its own.
    if (m.adoptAgents) {
      const { config, adopted } = m.adoptAgents(structuredClone(next));
      if (adopted.length > 0) {
        next = config;
        changes.push(
          `${m.label}: roster agents handed to the "${m.pluginId}" plugin: ${adopted.join(", ")}`,
        );
      }
    }
    const entry = next.plugins?.entries?.[m.pluginId] as { enabled?: unknown } | undefined;
    if (typeof entry?.enabled === "boolean") {
      markers[key] = { at, result: "explicit" };
      markersChanged = true;
      continue;
    }
    const dataDirs = [params.stateDir, ...(params.extraDataDirs ?? [])];
    if (!dataDirs.some((dir) => m.hasExistingData(dir))) {
      markers[key] = { at, result: "no-data" };
      markersChanged = true;
      continue;
    }
    const allow = next.plugins?.allow;
    next = {
      ...next,
      plugins: {
        ...next.plugins,
        ...(Array.isArray(allow) && !allow.includes(m.pluginId)
          ? { allow: [...allow, m.pluginId] }
          : {}),
        entries: {
          ...next.plugins?.entries,
          [m.pluginId]: {
            ...(next.plugins?.entries?.[m.pluginId] as Record<string, unknown> | undefined),
            enabled: true,
          },
        },
      },
    };
    // No marker here: the explicit `enabled: true` written to config IS the
    // record (next boot logs it as "explicit"). If the config write fails,
    // the check simply runs again next boot.
    changes.push(
      m.enabledNote
        ? `${m.label}: ${m.enabledNote}`
        : `${m.label} is now the "${m.pluginId}" plugin — kept ON because this install has data for it (turn it off in Setup › Plugins).`,
    );
  }

  if (markersChanged) {
    try {
      writeMarkers(params.stateDir, markers);
    } catch {
      /* best-effort: worst case the check runs again next boot */
    }
  }
  return { config: next, changes };
}
