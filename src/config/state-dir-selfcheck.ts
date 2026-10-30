/**
 * Startup self-check for the MCP↔UI "split-brain" state-store hazard.
 *
 * Background
 * ----------
 * The gateway and the agent/MCP tool surface must read and write the SAME
 * state directory. When they diverge, data written through one path
 * (e.g. a client added via an MCP/agent tool) becomes invisible to the other
 * (e.g. the control UI), even though nothing errors — a silent split-brain.
 *
 * Two ways this has bitten us:
 *   1. A code path used the deprecated repo-local fallback
 *      (`process.env.INFINIBOT_STATE_DIR || "state"` → `<cwd>/state`) instead
 *      of {@link resolveStateDir}. Guarded structurally by
 *      `state-dir-hygiene.test.ts`.
 *   2. The process resolves a NON-default state dir (e.g. a stray
 *      `INFINIBOT_STATE_DIR` in the daemon env, or a per-user profile) while a
 *      populated legacy `~/.infinibot` store sits untouched. Reads land in an
 *      empty/new dir and the UI "loses" everything.
 *
 * This module does not fix either — it makes the second class LOUD at boot so
 * an operator notices before assuming data loss. The first class is caught by
 * the companion unit test (`state-dir-selfcheck.test.ts`).
 *
 * WHERE TO CALL THIS (not wired here on purpose — this file owns no startup):
 *   Call `runStateDirSelfCheck()` once during gateway boot, right AFTER
 *   `migrateLegacyStateDir()` / `backfillStateFromRepo()` run and BEFORE any
 *   store opens — e.g. in `src/entry.ts` (or wherever the gateway boots),
 *   just after the existing paths migration calls:
 *
 *       migrateLegacyStateDir();
 *       backfillStateFromRepo();
 *       runStateDirSelfCheck();   // ← add this line
 *
 * It only logs; it never throws and never blocks startup.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveStateDir, resolveSharedDir, DEFAULT_USER_ID, getCurrentUserId } from "./paths.js";

/**
 * Files/dirs that a real, initialized InfiniBot state dir is expected to
 * contain. We don't require ALL of them (a brand-new install legitimately has
 * none yet) — the self-check only warns when the ACTIVE dir looks empty of
 * markers while a DIFFERENT dir is populated, which is the split-brain shape.
 */
export const CANONICAL_STORE_MARKERS = [
  "infinibot.json", // shared gateway config
  "databases.db", // CRM / clients / kanban SQLite store
  "business.json", // business profile
  "agents", // per-agent identity/memory dir
] as const;

export interface StateDirSelfCheckResult {
  /** The state dir this process resolved. */
  activeStateDir: string;
  /** The shared (never per-user) root — where infinibot.json lives. */
  sharedDir: string;
  /** The default `~/.infinibot` store, regardless of overrides. */
  defaultStore: string;
  /** Which canonical markers were found in the active dir. */
  markersPresent: string[];
  /** Human-readable warnings; empty when everything looks aligned. */
  warnings: string[];
  /** True when no divergence was detected. */
  ok: boolean;
}

/** How many marker files/dirs a dir has (used to judge "populated"). */
function countMarkers(dir: string): string[] {
  const found: string[] = [];
  for (const marker of CANONICAL_STORE_MARKERS) {
    try {
      if (fs.existsSync(path.join(dir, marker))) found.push(marker);
    } catch {
      /* unreadable — treat as absent */
    }
  }
  return found;
}

/**
 * Compute the split-brain self-check result without emitting anything.
 * Pure(ish): only reads the filesystem. Injectable env/homedir for tests.
 */
export function evaluateStateDirSelfCheck(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): StateDirSelfCheckResult {
  const activeStateDir = resolveStateDir(env, homedir);
  const sharedDir = resolveSharedDir(env, homedir);
  const defaultStore = path.join(homedir(), ".infinibot");

  const markersPresent = countMarkers(activeStateDir);
  const warnings: string[] = [];

  // 1. Active dir looks uninitialized (no canonical markers at all).
  if (markersPresent.length === 0) {
    warnings.push(
      `Active state dir has NONE of the canonical store markers ` +
        `(${CANONICAL_STORE_MARKERS.join(", ")}): ${activeStateDir}. ` +
        `If this is not a brand-new install, the gateway may be pointed at the ` +
        `wrong directory — run the reconcile step (see docs/split-brain-state-stores.md).`,
    );
  }

  // 2. Active dir differs from the default `~/.infinibot` store AND that
  //    default store is populated → classic split-brain. Data written by a
  //    component that ignored the override is invisible here.
  if (path.resolve(activeStateDir) !== path.resolve(defaultStore)) {
    const legacyMarkers = countMarkers(defaultStore);
    if (legacyMarkers.length > 0) {
      warnings.push(
        `A populated store exists at the default ${defaultStore} ` +
          `(markers: ${legacyMarkers.join(", ")}) but this process resolved a ` +
          `DIFFERENT active state dir: ${activeStateDir}. Any component that ` +
          `does not honor the override will read/write ${defaultStore} instead — ` +
          `a split-brain. Confirm INFINIBOT_STATE_DIR is intentional and run the ` +
          `reconcile step (docs/split-brain-state-stores.md) if data looks missing.`,
      );
    }
  }

  // 3. Shared root differs from the active dir under a non-default profile.
  //    This is expected for per-user profiles, but worth surfacing once so an
  //    operator can tell "config here, data there" apart from a real mismatch.
  const userId = getCurrentUserId();
  if (userId !== DEFAULT_USER_ID && path.resolve(sharedDir) !== path.resolve(activeStateDir)) {
    warnings.push(
      `Running under non-default profile "${userId}": shared services resolve to ` +
        `${sharedDir} while per-user data resolves to ${activeStateDir}. This is ` +
        `expected for multi-user, but ensure agent/MCP tools resolve the SAME ` +
        `per-user dir as the gateway (both must call resolveStateDir()).`,
    );
  }

  return {
    activeStateDir,
    sharedDir,
    defaultStore,
    markersPresent,
    warnings,
    ok: warnings.length === 0,
  };
}

/**
 * Run the self-check and log any warnings to stderr. Never throws.
 * Returns the result so a caller can also react programmatically if desired.
 *
 * @see evaluateStateDirSelfCheck for the pure evaluation.
 */
export function runStateDirSelfCheck(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): StateDirSelfCheckResult {
  let result: StateDirSelfCheckResult;
  try {
    result = evaluateStateDirSelfCheck(env, homedir);
  } catch (error) {
    // A self-check must never take down boot.
    // eslint-disable-next-line no-console
    console.error(
      `[infinibot] state-dir self-check failed to run (non-fatal): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      activeStateDir: "",
      sharedDir: "",
      defaultStore: "",
      markersPresent: [],
      warnings: [],
      ok: true,
    };
  }

  for (const warning of result.warnings) {
    // eslint-disable-next-line no-console
    console.warn(`[infinibot] WARNING: state-store split-brain risk — ${warning}`);
  }
  return result;
}
