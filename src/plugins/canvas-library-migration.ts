/**
 * One-time migration: the Canvas Library became the HoloCanvas plugin
 * (`canvas-library`, extensions/canvas-library).
 *
 * Bundled plugins are OFF by default, so a fresh install never shows the
 * library. An install that already has saved canvases keeps it: on the first
 * boot after the move, if `<stateDir>/canvas-library.db` holds at least one
 * canvas, `plugins.entries.canvas-library.enabled = true` is written.
 *
 * Runs once per state dir. "No data" and "owner already chose" are recorded in
 * `<stateDir>/plugin-migrations.json` under `core-surface:canvas-library`; an
 * enable is recorded by the explicit `enabled: true` itself. An explicit
 * `enabled` (true or false) in config is always respected, and later canvases
 * (e.g. from work-review, which saves with the plugin off) never flip it on.
 *
 * No data moves: saved canvases stay in the core store (canvas runtime, B34).
 * The marker file and key format match plugins/core-surface-migrations.ts on
 * the Discipline branch, so this can join that list when both land.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { InfinibotConfig } from "../config/config.js";

export const CANVAS_LIBRARY_PLUGIN_ID = "canvas-library";
const MARKER_FILE = "plugin-migrations.json";
const MARKER_KEY = `core-surface:${CANVAS_LIBRARY_PLUGIN_ID}`;

type MarkerEntry = { at: string; result: "no-data" | "explicit" };

/** True when the core saved-canvas store has at least one canvas. Never throws. */
export function canvasLibraryHasExistingData(stateDir: string): boolean {
  const file = path.join(stateDir, "canvas-library.db");
  if (!fs.existsSync(file)) return false;
  let db: { prepare: (sql: string) => { get: () => unknown }; close: () => void } | null = null;
  try {
    // Lazy: better-sqlite3 is native; only load it when a DB is present.
    const Database = createRequire(import.meta.url)("better-sqlite3") as new (
      f: string,
      o: { readonly: boolean; fileMustExist: boolean },
    ) => NonNullable<typeof db>;
    db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      return Boolean(db.prepare("SELECT 1 AS x FROM canvas_library LIMIT 1").get());
    } catch {
      return false; // no table yet
    }
  } catch {
    // Exists but unreadable (locked, corrupt): assume it matters.
    return true;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

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

export type CanvasLibraryMigrationResult = {
  config: InfinibotConfig;
  /** Boot-log line when the config changed (write it), else null. */
  change: string | null;
};

export function applyCanvasLibraryMigration(params: {
  config: InfinibotConfig;
  stateDir: string;
  hasExistingData?: (stateDir: string) => boolean;
  now?: () => Date;
}): CanvasLibraryMigrationResult {
  const id = CANVAS_LIBRARY_PLUGIN_ID;
  const markers = readMarkers(params.stateDir);
  if (markers[MARKER_KEY]) return { config: params.config, change: null };
  const at = (params.now?.() ?? new Date()).toISOString();
  const mark = (result: MarkerEntry["result"]) => {
    try {
      writeMarkers(params.stateDir, { ...markers, [MARKER_KEY]: { at, result } });
    } catch {
      /* best-effort: worst case the check runs again next boot */
    }
  };

  const entry = params.config.plugins?.entries?.[id] as { enabled?: unknown } | undefined;
  if (typeof entry?.enabled === "boolean") {
    mark("explicit");
    return { config: params.config, change: null };
  }
  if (!(params.hasExistingData ?? canvasLibraryHasExistingData)(params.stateDir)) {
    mark("no-data");
    return { config: params.config, change: null };
  }

  const plugins = params.config.plugins;
  const allow = plugins?.allow;
  const config: InfinibotConfig = {
    ...params.config,
    plugins: {
      ...plugins,
      ...(Array.isArray(allow) && !allow.includes(id) ? { allow: [...allow, id] } : {}),
      entries: {
        ...plugins?.entries,
        [id]: { ...(plugins?.entries?.[id] as Record<string, unknown> | undefined), enabled: true },
      },
    },
  };
  return {
    config,
    change: `Canvas Library is now the "HoloCanvas" plugin (${id}) — kept ON because this install has saved canvases (turn it off in Setup › Plugins).`,
  };
}
