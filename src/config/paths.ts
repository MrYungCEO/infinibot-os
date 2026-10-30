import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InfinibotConfig } from "./types.js";

/**
 * Nix mode detection: When INFINIBOT_NIX_MODE=1, the gateway is running under Nix.
 * In this mode:
 * - No auto-install flows should be attempted
 * - Missing dependencies should produce actionable Nix-specific error messages
 * - Config is managed externally (read-only from Nix perspective)
 */
export function resolveIsNixMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INFINIBOT_NIX_MODE === "1";
}

export const isNixMode = resolveIsNixMode();

const STATE_DIRNAME = ".infinibot";
const CONFIG_FILENAME = "infinibot.json";

const LEGACY_STATE_DIRNAMES = [".moltbot", ".clawdbot"] as const;

function defaultStateDir(homedir: () => string = os.homedir): string {
  return path.join(homedir(), STATE_DIRNAME);
}

// ── Multi-user / profile awareness ──────────────────────────────────
//
// The "default" user's data dir IS the shared root (preserved in place).
// Non-default profiles get a `users/<id>/` subtree. The active profile is
// held in a single in-process pointer set at gateway boot from the
// persisted registry (see `src/users/profiles.ts`). `paths.ts` owns only
// the low-level pointer so it has no dependency on the profiles module
// (which depends on paths) — the profiles module is the registry/IO layer
// on top of these primitives.

export const DEFAULT_USER_ID = "default";

let _currentUserId: string = DEFAULT_USER_ID;

// ── Per-request tenant overlay (SaaS mode) ──────────────────────────
//
// In multi-tenant SaaS mode the process serves many tenants concurrently, so a
// single global `_currentUserId` is not enough. Each gateway request is run
// inside `runWithUserId(namespace, ...)`, which sets an AsyncLocalStorage store
// that overrides the global pointer for the duration of that request (and any
// awaits within it). Outside such a scope — CLI, boot, single-user local mode —
// the global pointer is used, so existing behaviour is unchanged.
import { AsyncLocalStorage } from "node:async_hooks";

const _tenantContext = new AsyncLocalStorage<{ userId: string; role?: string }>();

/** Run `fn` with `userId` as the active profile for this async scope. */
export function runWithUserId<T>(userId: string | undefined, fn: () => T): T {
  const id = userId?.trim();
  if (!id) return fn();
  // Re-entering the same tenant (e.g. a job started inside a request) keeps
  // the caller's role; a different tenant starts without one.
  const outer = _tenantContext.getStore();
  const role = outer?.userId === id ? outer.role : undefined;
  return _tenantContext.run({ userId: id, role }, fn);
}

/**
 * Like runWithUserId(), and also records the authenticated user's role in the
 * tenant (owner/admin/member) for the scope. Gateway requests use this so
 * permission checks deep in the stack (config writes on a hosted tenant
 * Machine) can tell the workspace owner from a plain member.
 */
export function runWithTenantScope<T>(
  userId: string | undefined,
  role: string | undefined,
  fn: () => T,
): T {
  const id = userId?.trim();
  if (!id) return fn();
  return _tenantContext.run({ userId: id, role: role?.trim().toLowerCase() || undefined }, fn);
}

/** The tenant role of the current request scope, if any (see runWithTenantScope). */
export function getScopedTenantRole(): string | undefined {
  return _tenantContext.getStore()?.role;
}

/** The userId active for the current async scope (request overlay, else global). */
function activeUserId(): string {
  return _tenantContext.getStore()?.userId ?? _currentUserId;
}

/**
 * The tenant namespace of the current request scope, or undefined when not
 * inside a `runWithUserId(...)` scope (background timers, boot, local mode).
 * Unlike getCurrentUserId(), this does NOT fall back to the global pointer — so
 * callers can distinguish "inside tenant request" from "ambient", e.g. to scope
 * event broadcasts to a single tenant only when emitted during its request.
 */
export function getScopedUserId(): string | undefined {
  return _tenantContext.getStore()?.userId;
}

/** Active profile id driving per-user path resolution (request-scoped in SaaS). */
export function getCurrentUserId(): string {
  return activeUserId();
}

/** The process-global profile id, ignoring any request overlay. */
export function getGlobalUserId(): string {
  return _currentUserId;
}

/** Update the active profile id. Called by the profiles module on boot/switch. */
export function setCurrentUserId(id: string): void {
  _currentUserId = id?.trim() || DEFAULT_USER_ID;
}

/**
 * SHARED root for services that must NOT be duplicated per profile:
 * infinibot.json, credentials/, plugins, mcp-servers.json, secrets/.
 * This is the pre-multi-user behaviour of `resolveStateDir()`.
 * Override via INFINIBOT_STATE_DIR.
 * Default: ~/.infinibot
 */
export function resolveSharedDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = env.INFINIBOT_STATE_DIR?.trim();
  if (override) return resolveUserPath(override);
  return defaultStateDir(homedir);
}

/**
 * Per-user STATE directory for mutable data (databases, agent memory,
 * sessions, caches). For the "default" user this equals the shared root,
 * so existing installs are byte-for-byte unchanged (the multi-user
 * feature is a no-op until a non-default profile is selected).
 *
 * Override via INFINIBOT_STATE_DIR (escape hatch — pins both shared and
 * per-user to that path, single-tenant).
 * Default: ~/.infinibot  (or ~/.infinibot/users/<id> for non-default)
 */
export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  // Namespace on top of the shared base so per-user isolation also works
  // under a custom INFINIBOT_STATE_DIR (e.g. a dev profile). The "default"
  // user maps to the shared base itself → unchanged behaviour.
  const shared = resolveSharedDir(env, homedir);
  const userId = activeUserId();
  if (!userId || userId === DEFAULT_USER_ID) return shared;
  const safe = userId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(shared, "users", safe);
}

/**
 * Create the active state directory with owner-only permissions.
 *
 * Deliberately does not chmod an existing directory: changing permissions on
 * an operator-managed path belongs to `doctor --fix`, not normal startup.
 */
export function ensureStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const target = resolveStateDir(env, homedir);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  }
  return target;
}

let _moltbotEnvWarned = false;

/**
 * Back-compat wrapper around {@link resolveStateDir} that still honors the
 * pre-rename `MOLTBOT_STATE_DIR` env var.
 *
 * The canonical resolver deliberately reads only `INFINIBOT_*` env vars (see
 * the note on {@link migrateLegacyStateDir}). A handful of older modules
 * historically read `MOLTBOT_STATE_DIR` directly; routing them through this
 * wrapper preserves that behaviour — with a one-time deprecation warning — so
 * existing single-tenant installs that set the legacy var don't silently move
 * to a different data dir. New code should call {@link resolveStateDir}.
 *
 * Precedence: INFINIBOT_STATE_DIR → MOLTBOT_STATE_DIR (deprecated) → default.
 */
export function resolveStateDirWithLegacyEnv(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const legacy = env.MOLTBOT_STATE_DIR?.trim();
  if (legacy && !env.INFINIBOT_STATE_DIR?.trim()) {
    if (!_moltbotEnvWarned) {
      _moltbotEnvWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[infinibot] MOLTBOT_STATE_DIR is deprecated; please set INFINIBOT_STATE_DIR instead. Honoring the legacy value for now.",
      );
    }
    // Reuse the full resolver (incl. per-user namespacing) by injecting the
    // legacy value as the canonical override.
    return resolveStateDir({ ...env, INFINIBOT_STATE_DIR: legacy }, homedir);
  }
  return resolveStateDir(env, homedir);
}

/**
 * Pin `INFINIBOT_STATE_DIR` in the process environment to the canonical
 * resolved state dir when it is not already set.
 *
 * ── Why this exists (the MCP↔UI split-brain root fix) ──────────────────
 * Two families of resolvers coexist in the tree:
 *   • the canonical {@link resolveStateDir} → default `~/.infinibot`; and
 *   • a large set of legacy call sites that still read
 *     `process.env.INFINIBOT_STATE_DIR ?? "state"` (see
 *     `state-dir-hygiene.test.ts` for the tracked debt), which falls back to
 *     the repo-local `<cwd>/state` when the env var is unset.
 *
 * When the gateway is launched from the repo with `INFINIBOT_STATE_DIR`
 * UNSET, those two families diverge: `resolveStateDir()` callers (e.g.
 * `getKanbanStore()` with no arg) land on `~/.infinibot/kanban.db` while the
 * legacy callers (notes, research, workflows, the projects → kanban path,
 * etc.) land on `<cwd>/state`. Because `getKanbanStore()` is a re-opening
 * singleton keyed on the state dir, it flip-flops between the two, which is
 * exactly the "data written via MCP/agent tools is invisible in the UI /
 * disappears then comes back" symptom.
 *
 * Setting the env var here — from the SINGLE source of truth
 * ({@link resolveStateDir}) — makes BOTH families resolve to the same
 * directory: legacy `?? "state"` readers now see the canonical path, and
 * `resolveStateDir()` (which honors the override) returns the same value.
 * Per-user profile namespacing is preserved: we pin the shared/default base
 * (at boot `_currentUserId` is still "default", so `resolveStateDir()` equals
 * the shared root), and `resolveStateDir()` continues to layer `users/<id>`
 * on top of it after a profile switch.
 *
 * Idempotent and non-destructive: an explicit operator override (or a value
 * inherited from a parent process, e.g. the gateway → detached coder agent →
 * MCP stdio chain) is left untouched. Call once at process boot, BEFORE any
 * store opens.
 *
 * @returns the effective (pinned or pre-existing) `INFINIBOT_STATE_DIR` value.
 */
export function ensureStateDirEnv(env: NodeJS.ProcessEnv = process.env): string {
  const existing = env.INFINIBOT_STATE_DIR?.trim();
  const resolved = existing ? resolveUserPath(existing) : resolveStateDir(env);
  ensureStateDir(env);
  if (existing) return resolved;
  env.INFINIBOT_STATE_DIR = resolved;
  return resolved;
}

/**
 * One-shot backfill of stale repo-local `state/` data into the canonical
 * per-user state dir, for installs that historically wrote to `<cwd>/state/`
 * (the old bare-env `?? "state"` fallback).
 *
 * Conservative by design — it NEVER overwrites an existing target file:
 *  - `business.json` is copied only when the target doesn't already have one.
 *  - `databases.db` is copied only when the target has none (the home copy is
 *    almost always larger / authoritative, so we never clobber it).
 *
 * Skipped entirely when `INFINIBOT_STATE_DIR` is set (explicit single-tenant
 * override — the operator owns that path) or when the repo `state/` dir is
 * absent. Call once at boot, after {@link migrateLegacyStateDir}.
 */
export function backfillStateFromRepo(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): void {
  if (env.INFINIBOT_STATE_DIR?.trim()) return;
  const target = resolveStateDir(env, homedir);
  const repoState = path.join(resolveRepoRoot(env), "state");
  if (!fs.existsSync(repoState)) return;

  const copyIfMissing = (file: string, label: string): void => {
    const src = path.join(repoState, file);
    const dst = path.join(target, file);
    if (!fs.existsSync(src) || fs.existsSync(dst)) return;
    try {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      fs.copyFileSync(src, dst);
      // eslint-disable-next-line no-console
      console.error(
        `[infinibot] Migrated stale repo-local ${label} (${src}) into ${dst}. ` +
          `The gateway now reads ${label} from the canonical state dir.`,
      );
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        `[infinibot] Failed to backfill ${label} from ${src}: ${
          error instanceof Error ? error.message : String(error)
        }. Move it manually if ${label} is missing.`,
      );
    }
  };

  copyIfMissing("business.json", "business profile");
  copyIfMissing("databases.db", "databases");
}

function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("~")) {
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}

export const STATE_DIR = resolveStateDir();

/** Shared services root (never per-user). */
export const SHARED_DIR = resolveSharedDir();

/**
 * Repo root for tool execution — the deterministic "where shells / Claude
 * Code / exec / process tools should land their cwd" path.
 *
 * Precedence:
 *   1. `INFINIBOT_REPO_ROOT` env var (explicit override; preserves the user's
 *      choice when they launch the gateway from a different directory).
 *   2. Walk up from this module's compiled location looking for a
 *      `package.json` whose `name` matches infinibot/moltbot. Works in both
 *      src/ (dev) and dist/ (prod) layouts.
 *   3. `process.cwd()` as the last resort — keeps backwards compatibility
 *      with existing scripted launches.
 *
 * Why this exists: voice-mode terminal spawns (claude_coder, exec) and the
 * AI tool surface need a stable, predictable cwd. `process.cwd()` is
 * whatever directory the gateway was started in — which on Electron, MCP,
 * or systemd starts is often `/` or `~`. Without this, "open my project"
 * voice commands land in the wrong directory.
 */
let _cachedRepoRoot: string | null = null;
export function resolveRepoRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (_cachedRepoRoot && env === process.env) return _cachedRepoRoot;
  const envRoot = env.INFINIBOT_REPO_ROOT?.trim();
  if (envRoot) {
    try {
      const resolved = resolveUserPath(envRoot);
      if (fs.existsSync(path.join(resolved, "package.json"))) {
        if (env === process.env) _cachedRepoRoot = resolved;
        return resolved;
      }
    } catch {
      /* fall through */
    }
  }
  // Walk up from this file. __dirname is unavailable in pure ESM, but the
  // CommonJS-bundled output uses a compatibility shim that provides it; we
  // gate on `typeof` so the source file remains tooling-agnostic.
  try {
    let dir: string | null = typeof __dirname !== "undefined" ? __dirname : null;
    if (dir) {
      for (let i = 0; i < 20; i++) {
        const pkgPath = path.join(dir, "package.json");
        if (fs.existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
              name?: string;
            };
            if (typeof pkg.name === "string" && /^(@[^/]+\/)?(infinibot|moltbot)/i.test(pkg.name)) {
              if (env === process.env) _cachedRepoRoot = dir;
              return dir;
            }
          } catch {
            /* corrupt package.json — keep walking */
          }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch {
    /* fall through */
  }
  const fallback = process.cwd();
  if (env === process.env) _cachedRepoRoot = fallback;
  return fallback;
}

export const REPO_ROOT = resolveRepoRoot();

/**
 * Config file path (JSON5).
 * Override via INFINIBOT_CONFIG_PATH.
 * Default: ~/.infinibot/infinibot.json (or $INFINIBOT_STATE_DIR/infinibot.json)
 */
export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  // Config is a SHARED service file — always resolve at the shared root,
  // never the per-user data dir, so every profile uses the same gateway
  // config, API keys and integrations.
  stateDir: string = resolveSharedDir(env, os.homedir),
): string {
  const override = env.INFINIBOT_CONFIG_PATH?.trim();
  if (override) return resolveUserPath(override);
  return path.join(stateDir, CONFIG_FILENAME);
}

export const CONFIG_PATH = resolveConfigPath();

export function resolveDefaultConfigCandidates(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string[] {
  const explicit = env.INFINIBOT_CONFIG_PATH?.trim();
  if (explicit) return [resolveUserPath(explicit)];

  const candidates: string[] = [];
  const stateDirOverride = env.INFINIBOT_STATE_DIR?.trim();
  if (stateDirOverride) {
    candidates.push(path.join(resolveUserPath(stateDirOverride), CONFIG_FILENAME));
  }
  candidates.push(path.join(defaultStateDir(homedir), CONFIG_FILENAME));
  return candidates;
}

export const DEFAULT_GATEWAY_PORT = 18789;

/**
 * Gateway lock directory (ephemeral).
 * Default: os.tmpdir()/infinibot-<uid> (uid suffix when available).
 */
export function resolveGatewayLockDir(tmpdir: () => string = os.tmpdir): string {
  const base = tmpdir();
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const suffix = uid != null ? `infinibot-${uid}` : "infinibot";
  return path.join(base, suffix);
}

const OAUTH_FILENAME = "oauth.json";

/**
 * OAuth credentials storage directory.
 *
 * Precedence:
 * - `INFINIBOT_OAUTH_DIR` (explicit override)
 * - `$INFINIBOT_STATE_DIR/credentials` (canonical default)
 */
export function resolveOAuthDir(
  env: NodeJS.ProcessEnv = process.env,
  // Credentials are SHARED — every profile uses the same model-backend /
  // provider logins. Resolve at the shared root, not the per-user dir.
  stateDir: string = resolveSharedDir(env, os.homedir),
): string {
  const override = env.INFINIBOT_OAUTH_DIR?.trim();
  if (override) return resolveUserPath(override);
  return path.join(stateDir, "credentials");
}

export function resolveOAuthPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveSharedDir(env, os.homedir),
): string {
  return path.join(resolveOAuthDir(env, stateDir), OAUTH_FILENAME);
}

export function resolveGatewayPort(
  cfg?: InfinibotConfig,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const envRaw = env.INFINIBOT_GATEWAY_PORT?.trim();
  if (envRaw) {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const configPort = cfg?.gateway?.port;
  if (typeof configPort === "number" && Number.isFinite(configPort)) {
    if (configPort > 0) return configPort;
  }
  return DEFAULT_GATEWAY_PORT;
}

const MIGRATION_MARKER = ".migrated-from-legacy";

/**
 * One-shot rescue of user data from the previous brand's state directories.
 *
 * Runs only when the new state dir doesn't exist yet AND a legacy dir
 * (.moltbot or .clawdbot) is present in $HOME. Copies the contents over,
 * drops a marker so we never run again, and silently no-ops on subsequent
 * launches. The legacy directories themselves are left in place so users
 * can verify the copy before deleting.
 *
 * Old environment variables (MOLTBOT_/CLAWDBOT_*) are NOT honored at runtime.
 * The new code only reads INFINIBOT_* env vars.
 *
 * Call this once from entry.ts before any other code touches STATE_DIR.
 */
export function migrateLegacyStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): void {
  if (env.INFINIBOT_STATE_DIR?.trim()) return;
  const target = defaultStateDir(homedir);
  // The marker — not the directory — is the source of truth that migration
  // already ran. If a previous attempt half-copied and crashed, the user can
  // delete the partial target dir and we'll retry on next launch.
  if (fs.existsSync(path.join(target, MIGRATION_MARKER))) return;

  const home = homedir();
  let source: string | null = null;
  for (const name of LEGACY_STATE_DIRNAMES) {
    const candidate = path.join(home, name);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      source = candidate;
      break;
    }
  }
  if (!source) return;

  fs.mkdirSync(target, { recursive: true, mode: 0o700 });

  // Copy each top-level entry in isolation so one bad path (e.g. a symlink to
  // a permission-denied directory, or a Windows symlink we can't recreate)
  // doesn't abort the whole migration. `dereference: true` resolves symlinks
  // so we copy the underlying content rather than trying to recreate the link
  // — Windows blocks symlink creation without elevation.
  const failed: Array<{ entry: string; error: string }> = [];
  let copiedCount = 0;
  for (const entry of fs.readdirSync(source)) {
    const src = path.join(source, entry);
    const dst = path.join(target, entry);
    try {
      fs.cpSync(src, dst, {
        recursive: true,
        dereference: true,
        errorOnExist: false,
        force: false,
      });
      copiedCount += 1;
    } catch (error) {
      failed.push({ entry, error: error instanceof Error ? error.message : String(error) });
    }
  }

  try {
    fs.writeFileSync(
      path.join(target, MIGRATION_MARKER),
      JSON.stringify(
        {
          from: source,
          at: new Date().toISOString(),
          copied: copiedCount,
          failed,
        },
        null,
        2,
      ),
      "utf-8",
    );
  } catch {
    // If we can't write the marker we'll just retry next launch — not fatal.
  }

  // eslint-disable-next-line no-console
  console.error(
    `[infinibot] Rescued ${copiedCount} entries from ${source} into ${target}. The legacy directory was left in place — delete it once you've verified.`,
  );
  if (failed.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[infinibot] ${failed.length} entries could not be copied (see ${MIGRATION_MARKER} for details):`,
    );
    for (const { entry, error } of failed) {
      // eslint-disable-next-line no-console
      console.error(`  - ${entry}: ${error}`);
    }
  }
}

/**
 * Canonical path for a piece of state, migrating any legacy copy forward first.
 *
 * Historically many modules resolved their state dir as
 * `process.env.INFINIBOT_STATE_DIR || "state"`, which lands in a repo-local
 * `<cwd>/state` that moves with the process's launch directory and that nothing
 * else reads. Simply switching those call sites to {@link resolveStateDir}
 * would point them at an empty canonical path and *look* like data loss.
 *
 * So this does the safe thing: if the canonical path is missing but a legacy
 * copy exists, the legacy copy is moved into place before the path is handed
 * back. Copy-then-keep rather than move, so a rollback to an older build still
 * finds its data where it left it.
 *
 * Idempotent and best-effort: once the canonical path exists this is a single
 * `existsSync`, and any copy failure leaves the caller with the canonical path
 * to create from scratch rather than throwing during module init.
 *
 * @param relativePath Path beneath the state dir, e.g. `"business/income.json"`.
 */
export function stateFilePathWithLegacyMigration(relativePath: string): string {
  const canonical = path.join(resolveStateDir(), relativePath);
  try {
    if (fs.existsSync(canonical)) return canonical;
    const legacyRoot = process.env.INFINIBOT_STATE_DIR?.trim() || "state";
    const legacy = path.resolve(legacyRoot, relativePath);
    if (legacy === canonical || !fs.existsSync(legacy)) return canonical;
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    // `cpSync` handles both a single file and a directory tree (SQLite stores
    // keep sidecar -wal/-shm files that must travel with the database).
    fs.cpSync(legacy, canonical, { recursive: true, errorOnExist: false });
    for (const sidecar of ["-wal", "-shm"]) {
      if (fs.existsSync(legacy + sidecar) && !fs.existsSync(canonical + sidecar)) {
        fs.cpSync(legacy + sidecar, canonical + sidecar);
      }
    }
  } catch {
    // Never block startup on a migration; the caller creates fresh state.
  }
  return canonical;
}
