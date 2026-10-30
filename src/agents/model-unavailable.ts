/**
 * Models a provider rejected as "not found" at request time.
 *
 * The catalog can only be as good as its sources; when a provider still turns
 * a listed model down (retired between refreshes, not enabled for this key,
 * wrong region), the fallback runner records it here. models.list then flags
 * the row `unavailable` with a suggested replacement, so the picker stops
 * offering a dead model as if it worked.
 *
 * In-memory + a small JSON file in the state dir (survives restarts). Entries
 * expire so a model that comes back is offered again.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";

export const UNAVAILABLE_TTL_MS = 24 * 60 * 60 * 1000;

export type UnavailableModel = { at: number; error: string };

let memo: Map<string, UnavailableModel> | null = null;
/** mtime of the file `memo` was read from, and when we last looked at it. */
let memoMtime = 0;
let memoCheckedAt = 0;
const RECHECK_MS = 1000;
let filePathOverride: string | undefined;

const keyOf = (provider: string, model: string) =>
  `${provider.trim().toLowerCase()}/${model.trim().toLowerCase()}`;

function filePath(): string {
  return filePathOverride ?? path.join(resolveStateDir(), "cache", "model-unavailable.json");
}

function load(): Map<string, UnavailableModel> {
  const testNoFile = (process.env.VITEST || process.env.NODE_ENV === "test") && !filePathOverride;
  if (memo && testNoFile) return memo;
  // Agent turns also run outside the gateway process (CLI, coder spawns):
  // pick up their writes by re-reading when the file changed.
  if (memo && Date.now() - memoCheckedAt < RECHECK_MS) return memo;
  memoCheckedAt = Date.now();
  let mtime = 0;
  if (!testNoFile) {
    try {
      mtime = fs.statSync(filePath()).mtimeMs;
    } catch {
      mtime = 0;
    }
  }
  if (memo && mtime === memoMtime) return memo;
  memoMtime = mtime;
  memo = new Map();
  if (testNoFile || !mtime) return memo;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), "utf8")) as Record<string, UnavailableModel>;
    for (const [k, v] of Object.entries(raw ?? {})) {
      if (v && typeof v.at === "number") memo.set(k, { at: v.at, error: String(v.error ?? "") });
    }
  } catch {
    // No file yet.
  }
  return memo;
}

function persist(map: Map<string, UnavailableModel>): void {
  // Unit tests stay off the real state dir unless they point at a temp file.
  if ((process.env.VITEST || process.env.NODE_ENV === "test") && !filePathOverride) return;
  try {
    const target = filePath();
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, JSON.stringify(Object.fromEntries(map)), { mode: 0o600 });
    memoMtime = fs.statSync(target).mtimeMs;
  } catch {
    // Best effort — the in-memory record still covers this process.
  }
}

export function markModelUnavailable(
  provider: string,
  model: string,
  error: string,
  now: number = Date.now(),
): void {
  const map = load();
  map.set(keyOf(provider, model), { at: now, error: error.slice(0, 300) });
  persist(map);
}

/** A successful reply clears the flag (the provider serves it again). */
export function clearModelUnavailable(provider: string, model: string): void {
  const map = load();
  if (map.delete(keyOf(provider, model))) persist(map);
}

export function getUnavailableModel(
  provider: string,
  model: string,
  now: number = Date.now(),
): UnavailableModel | undefined {
  const hit = load().get(keyOf(provider, model));
  if (!hit) return undefined;
  return now - hit.at > UNAVAILABLE_TTL_MS ? undefined : hit;
}

export function resetUnavailableModelsForTest(file?: string): void {
  memo = null;
  memoMtime = 0;
  memoCheckedAt = 0;
  filePathOverride = file;
}
