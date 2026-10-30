/**
 * Navigation Sidebar Gateway Handlers
 * Server-side persistence for nav sidebar state (synced across browsers)
 */

import { GatewayRequestHandlers } from "./types.js";
import { createHash } from "node:crypto";
import { basename, resolve } from "path";
import { copyFile, readFile, writeFile, mkdir, rename } from "fs/promises";
import { existsSync } from "fs";
import type { GatewayClient } from "./types.js";

const STATE_FILE = "ui/nav-sidebar.json";

interface NavCategory {
  id: string;
  label: string;
  collapsed: boolean;
  position: number;
  tabs: string[];
  icon?: string;
  isCustom?: boolean;
}

interface NavSidebarState {
  categories: NavCategory[];
  hiddenTabs: string[];
  tabCustomNames: Record<string, string>;
  layoutVersion?: string;
  /** Per-plugin sidebar-section prefs (collapsed/hidden), keyed by plugin id. */
  pluginSections?: Record<string, { collapsed?: boolean; hidden?: boolean }>;
  favorites?: string[];
  favoritesCollapsed?: boolean;
  sectionOrder?: string[];
  sectionParents?: Record<string, string>;
  tabSectionOverrides?: Record<string, string>;
}

function legacyStatePath(): string {
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  return resolve(stateDir, STATE_FILE);
}

function userScope(client: GatewayClient | null): string | null {
  const identity = [client?.saasTenantId, client?.authUser ?? client?.saasEmail]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(":")
    .trim()
    .toLowerCase();
  if (!identity) return null;
  return createHash("sha256").update(identity).digest("hex").slice(0, 20);
}

function getStatePath(client: GatewayClient | null): string {
  const scope = userScope(client);
  if (!scope) return legacyStatePath();
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  return resolve(stateDir, "ui", "users", scope, "nav-sidebar.json");
}

/**
 * Parse a saved state, recovering the FIRST complete JSON document when the
 * file has trailing bytes. Two overlapping non-atomic writes (a short state
 * written while a longer, older one was still being written) used to leave
 * `{…current…}` followed by the tail of the older file — unparseable, so the
 * gateway answered `state: null` and every browser fell back to defaults,
 * which looked like the saved layout (custom categories, renames) was lost.
 * Exported for tests.
 */
export function parseNavSidebarFile(data: string): NavSidebarState | null {
  try {
    return JSON.parse(data) as NavSidebarState;
  } catch {
    // Find the end of the first top-level object (string-aware brace match).
    const start = data.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < data.length; i++) {
      const ch = data[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const parsed = JSON.parse(data.slice(start, i + 1)) as NavSidebarState;
          return parsed && Array.isArray(parsed.categories) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
    return null;
  }
}

async function loadState(client: GatewayClient | null): Promise<NavSidebarState | null> {
  const path = getStatePath(client);
  try {
    // First request after the per-user rollout inherits the legacy owner
    // layout once. Future writes go only to the authenticated user's file.
    const legacy = legacyStatePath();
    const source = existsSync(path) ? path : path !== legacy && existsSync(legacy) ? legacy : null;
    if (!source) return null;
    const data = await readFile(source, "utf-8");
    const state = parseNavSidebarFile(data);
    if (!state) console.error("[nav-sidebar] Saved state is unreadable; using defaults");
    if (state && source !== path) await saveStateAt(path, state);
    return state;
  } catch (e) {
    console.error("[nav-sidebar] Failed to load state:", e);
    return null;
  }
}

let writeChain: Promise<void> = Promise.resolve();

/**
 * Writes are serialised and atomic (temp file + rename), so concurrent
 * nav.sidebar.set calls from several browsers can never interleave bytes.
 */
async function saveStateAt(path: string, state: NavSidebarState): Promise<void> {
  const run = writeChain.then(async () => {
    const dir = resolve(path, "..");
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
    await rename(tmp, path);
  });
  writeChain = run.catch(() => undefined);
  try {
    await run;
  } catch (e) {
    console.error("[nav-sidebar] Failed to save state:", e);
    throw e;
  }
}

async function saveState(client: GatewayClient | null, state: NavSidebarState): Promise<void> {
  await saveStateAt(getStatePath(client), state);
}

async function backupState(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const backupDir = resolve(path, "..", "backups");
  await mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = resolve(backupDir, `nav-sidebar.${stamp}.json`);
  await copyFile(path, backup);
  return basename(backup);
}

export const navSidebarHandlers: GatewayRequestHandlers = {
  "nav.sidebar.get": async ({ respond, client }) => {
    const state = await loadState(client);
    respond(true, { state });
  },

  "nav.sidebar.set": async ({ params, respond, client }) => {
    const state = params.state as NavSidebarState | undefined;
    if (!state) {
      respond(false, undefined, { code: "-1", message: "state is required" });
      return;
    }
    await saveState(client, state);
    respond(true, {});
  },

  "nav.sidebar.reset": async ({ params, respond, client }) => {
    const path = getStatePath(client);
    try {
      const backup = await backupState(path);
      const state = params.state as NavSidebarState | undefined;
      if (state) await saveStateAt(path, state);
      else if (existsSync(path)) {
        const { unlink } = await import("fs/promises");
        await unlink(path);
      }
      respond(true, { backup });
    } catch (e) {
      respond(false, undefined, { code: "-1", message: String(e) });
    }
  },
};
