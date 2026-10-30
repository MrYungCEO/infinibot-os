/**
 * App alias store — persists user-defined app aliases in apps.json under the
 * Moltbot state dir. Aliases map a short name ("brave", "vscode") to an exe
 * path plus optional default args and monitor.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { resolveStateDir } from "../config/paths.js";

export interface AppAlias {
  alias: string;
  path: string;
  args?: string;
  defaultDisplay?: number;
  defaultPosition?: AppPosition;
  addedAt: number;
  updatedAt: number;
}

export type AppPosition =
  | "fullscreen"
  | "maximized"
  | "normal"
  | "left-half"
  | "right-half"
  | "top-half"
  | "bottom-half"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "center";

export const APP_POSITIONS: AppPosition[] = [
  "fullscreen",
  "maximized",
  "normal",
  "left-half",
  "right-half",
  "top-half",
  "bottom-half",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "center",
];

interface AppsFile {
  aliases: Record<string, AppAlias>;
  updatedAt: number;
}

function getAppsStorePath(): string {
  const stateDir = resolveStateDir();
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
  return path.join(stateDir, "apps.json");
}

export function loadAppsStore(): AppsFile {
  const filePath = getAppsStorePath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const aliases: Record<string, AppAlias> = {};
      if (raw && typeof raw === "object" && raw.aliases && typeof raw.aliases === "object") {
        for (const [key, val] of Object.entries(raw.aliases as Record<string, unknown>)) {
          if (val && typeof val === "object") {
            const entry = val as Partial<AppAlias>;
            if (typeof entry.alias === "string" && typeof entry.path === "string") {
              aliases[key] = {
                alias: entry.alias,
                path: entry.path,
                args: typeof entry.args === "string" ? entry.args : undefined,
                defaultDisplay:
                  typeof entry.defaultDisplay === "number" ? entry.defaultDisplay : undefined,
                defaultPosition:
                  typeof entry.defaultPosition === "string" &&
                  APP_POSITIONS.includes(entry.defaultPosition as AppPosition)
                    ? (entry.defaultPosition as AppPosition)
                    : undefined,
                addedAt: typeof entry.addedAt === "number" ? entry.addedAt : Date.now(),
                updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
              };
            }
          }
        }
      }
      return {
        aliases,
        updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
      };
    }
  } catch (err) {
    console.error("[apps-store] Failed to load:", err);
  }
  return { aliases: {}, updatedAt: Date.now() };
}

export function saveAppsStore(store: AppsFile): void {
  const filePath = getAppsStorePath();
  store.updatedAt = Date.now();
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
}

export function normalizeAlias(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function getAlias(name: string): AppAlias | null {
  const key = normalizeAlias(name);
  if (!key) return null;
  const store = loadAppsStore();
  return store.aliases[key] ?? null;
}

export function listAliases(): AppAlias[] {
  const store = loadAppsStore();
  return Object.values(store.aliases).sort((a, b) => a.alias.localeCompare(b.alias));
}

export function setAlias(params: {
  alias: string;
  path: string;
  args?: string;
  defaultDisplay?: number;
  defaultPosition?: AppPosition;
}): { ok: true; alias: AppAlias } | { ok: false; error: string } {
  const key = normalizeAlias(params.alias);
  if (!key) return { ok: false, error: "alias is empty or invalid" };
  const exePath = params.path.trim();
  if (!exePath) return { ok: false, error: "path is required" };
  if (!fs.existsSync(exePath)) {
    return { ok: false, error: `path does not exist: ${exePath}` };
  }
  if (params.defaultPosition && !APP_POSITIONS.includes(params.defaultPosition)) {
    return { ok: false, error: `invalid defaultPosition: ${params.defaultPosition}` };
  }

  const store = loadAppsStore();
  const existing = store.aliases[key];
  const entry: AppAlias = {
    alias: key,
    path: exePath,
    args: params.args?.trim() || undefined,
    defaultDisplay: params.defaultDisplay,
    defaultPosition: params.defaultPosition,
    addedAt: existing?.addedAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  store.aliases[key] = entry;
  saveAppsStore(store);
  return { ok: true, alias: entry };
}

export function removeAlias(
  name: string,
): { ok: true; removed: AppAlias } | { ok: false; error: string } {
  const key = normalizeAlias(name);
  if (!key) return { ok: false, error: "alias is empty or invalid" };
  const store = loadAppsStore();
  const existing = store.aliases[key];
  if (!existing) return { ok: false, error: `alias not found: ${key}` };
  delete store.aliases[key];
  saveAppsStore(store);
  return { ok: true, removed: existing };
}
