/**
 * Proactive store — persistence for the v2 commitment + focus-rotation state.
 *
 * Small JSON store (STATE_DIR/proactive.json), mirroring the focus.json pattern
 * already used by the Focus board. State-dir scoped so multi-user namespacing
 * via resolveStateDir() is honoured by the caller passing the resolved dir.
 */

import { resolve } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { DEFAULT_PROACTIVE_CONFIG, type ProactiveStore, type ProactiveConfig } from "./types.js";

const MAX_BREAKS = 200;
const MAX_COMPLETIONS = 200;

function storePath(stateDir: string): string {
  const dir = resolve(stateDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return resolve(dir, "proactive.json");
}

function emptyStore(): ProactiveStore {
  return {
    config: { ...DEFAULT_PROACTIVE_CONFIG },
    focusedProjectIds: [],
    coldProjectIds: [],
    activeCommitment: null,
    lastCommitment: null,
    breaks: [],
    completions: [],
    lastSeenAt: 0,
    updatedAt: Date.now(),
  };
}

export function loadProactiveStore(stateDir: string): ProactiveStore {
  const path = storePath(stateDir);
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<ProactiveStore>;
      const base = emptyStore();
      return {
        config: { ...base.config, ...raw.config },
        focusedProjectIds: Array.isArray(raw.focusedProjectIds) ? raw.focusedProjectIds : [],
        coldProjectIds: Array.isArray(raw.coldProjectIds) ? raw.coldProjectIds : [],
        activeCommitment: raw.activeCommitment ?? null,
        lastCommitment: raw.lastCommitment ?? null,
        breaks: Array.isArray(raw.breaks) ? raw.breaks : [],
        completions: Array.isArray(raw.completions) ? raw.completions : [],
        lastSeenAt: typeof raw.lastSeenAt === "number" ? raw.lastSeenAt : 0,
        updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
      };
    }
  } catch (e) {
    console.error("[Proactive] Failed to load store:", e);
  }
  return emptyStore();
}

export function saveProactiveStore(stateDir: string, store: ProactiveStore): void {
  const path = storePath(stateDir);
  try {
    store.updatedAt = Date.now();
    // Bound the append-only logs so the file can't grow without limit.
    if (store.breaks.length > MAX_BREAKS) store.breaks = store.breaks.slice(-MAX_BREAKS);
    if (store.completions.length > MAX_COMPLETIONS)
      store.completions = store.completions.slice(-MAX_COMPLETIONS);
    writeFileSync(path, JSON.stringify(store, null, 2), "utf-8");
  } catch (e) {
    console.error("[Proactive] Failed to save store:", e);
    throw new Error("Failed to save proactive store");
  }
}

/** Mutate the store via a callback, then persist. Returns the new store. */
export function updateProactiveStore(
  stateDir: string,
  mutate: (store: ProactiveStore) => void,
): ProactiveStore {
  const store = loadProactiveStore(stateDir);
  mutate(store);
  saveProactiveStore(stateDir, store);
  return store;
}

export function setProactiveConfig(
  stateDir: string,
  patch: Partial<ProactiveConfig>,
): ProactiveStore {
  return updateProactiveStore(stateDir, (s) => {
    if (typeof patch.maxFocus === "number" && patch.maxFocus >= 1 && patch.maxFocus <= 8) {
      s.config.maxFocus = Math.round(patch.maxFocus);
    }
    if (typeof patch.driftDays === "number" && patch.driftDays >= 1 && patch.driftDays <= 30) {
      s.config.driftDays = Math.round(patch.driftDays);
    }
  });
}
