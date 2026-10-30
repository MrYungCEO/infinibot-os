/**
 * storageState export/import — Playwright-compatible serialization of a
 * profile's cookies + origin-keyed localStorage.
 *
 * The cookies/storage exist on disk inside the profile's userDataDir, but
 * Chrome's SQLite/LevelDB formats are version-specific and painful to
 * read out-of-band. Instead we connect via Playwright's CDP and use the
 * built-in `storageState()` method — same shape Playwright uses for
 * `--storage-state=...` on launch.
 *
 * Use cases:
 *   - Backup logins before a destructive automation run
 *   - Carry an auth session between profiles or machines
 *   - Bootstrap a new profile with just the cookies it needs
 *     (instead of a full userDataDir copy)
 */

import * as fs from "node:fs/promises";

import type { BrowserContext } from "playwright-core";

import type { StorageStateSnapshot } from "./types.js";

/**
 * Read storageState from an open Playwright context.
 *
 * Returns the raw JSON-serializable snapshot — caller can write it to
 * disk, ship over the wire, hand to the agent as a tool result.
 */
export async function exportStorageState(context: BrowserContext): Promise<StorageStateSnapshot> {
  const raw = (await context.storageState()) as StorageStateSnapshot;
  return raw;
}

/**
 * Persist a storageState to disk. Used by the agent tool action.
 * Format: pretty-printed JSON, UTF-8.
 */
export async function writeStorageStateFile(
  filePath: string,
  state: StorageStateSnapshot,
): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Load a storageState from disk (path or already-parsed object) and
 * inject it into an existing Playwright context.
 *
 * `mode`:
 *   - "merge"   (default): add cookies / localStorage on top of whatever
 *     the context already has. Existing entries with the same name +
 *     domain are overwritten by the imported entry.
 *   - "replace": clear cookies for all imported origins first, then load.
 *     Use when you want a clean restore.
 */
export async function importStorageState(
  context: BrowserContext,
  source: string | StorageStateSnapshot,
  mode: "merge" | "replace" = "merge",
): Promise<{ cookies: number; origins: number }> {
  const state =
    typeof source === "string"
      ? (JSON.parse(await fs.readFile(source, "utf-8")) as StorageStateSnapshot)
      : source;

  if (!state || typeof state !== "object") {
    throw new Error("invalid storageState: expected { cookies, origins }");
  }
  const cookies = Array.isArray(state.cookies) ? state.cookies : [];
  const origins = Array.isArray(state.origins) ? state.origins : [];

  if (mode === "replace") {
    await context.clearCookies();
  }

  if (cookies.length > 0) {
    // Playwright accepts the same shape we exported.
    await context.addCookies(cookies as Parameters<BrowserContext["addCookies"]>[0]);
  }

  // localStorage: drive the page through context.addInitScript so the
  // entries are present BEFORE the first navigation. For already-open
  // pages, we also write directly into each open page that matches the
  // origin.
  if (origins.length > 0) {
    const initScript = buildStorageInitScript(origins);
    await context.addInitScript(initScript);

    const pages = context.pages();
    for (const page of pages) {
      for (const o of origins) {
        try {
          const pageOrigin = new URL(page.url()).origin;
          if (pageOrigin !== o.origin) continue;
          await page.evaluate((entries: Array<{ name: string; value: string }>) => {
            for (const e of entries) {
              try {
                window.localStorage.setItem(e.name, e.value);
              } catch {
                /* origin opaque or storage disabled — ignore */
              }
            }
          }, o.localStorage);
        } catch {
          /* page may have closed; ignore */
        }
      }
    }
  }

  return { cookies: cookies.length, origins: origins.length };
}

/**
 * Build a Playwright init script that seeds localStorage on the first
 * page load for each origin in the snapshot. Embedded as a string so the
 * call is JSON-safe.
 */
function buildStorageInitScript(origins: StorageStateSnapshot["origins"]): string {
  return `
    (function () {
      var byOrigin = ${JSON.stringify(
        origins.reduce<Record<string, Array<{ name: string; value: string }>>>((acc, o) => {
          acc[o.origin] = o.localStorage ?? [];
          return acc;
        }, {}),
      )};
      try {
        var entries = byOrigin[location.origin];
        if (entries && entries.length) {
          for (var i = 0; i < entries.length; i++) {
            try {
              localStorage.setItem(entries[i].name, entries[i].value);
            } catch (e) { /* ignore */ }
          }
        }
      } catch (e) { /* ignore */ }
    })();
  `;
}

/**
 * Filter a storageState to a specific origin or list of origins. Used by
 * the manager to ship only the cookies an agent needs into a sandboxed
 * profile — instead of leaking the full session.
 */
export function filterStorageStateByOrigin(
  state: StorageStateSnapshot,
  origins: string[],
): StorageStateSnapshot {
  const allow = new Set(origins.map((o) => normalizeOrigin(o)));
  return {
    cookies: state.cookies.filter((c) => cookieOriginsMatch(c, allow)),
    origins: state.origins.filter((o) => allow.has(normalizeOrigin(o.origin))),
  };
}

function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin.toLowerCase();
  } catch {
    return origin.trim().toLowerCase();
  }
}

function cookieOriginsMatch(cookie: { domain?: string }, allow: Set<string>): boolean {
  const domain = (cookie.domain ?? "").toLowerCase().replace(/^\./, "");
  if (!domain) return false;
  for (const origin of allow) {
    let host: string;
    try {
      host = new URL(origin).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (host === domain || host.endsWith(`.${domain}`)) return true;
  }
  return false;
}
