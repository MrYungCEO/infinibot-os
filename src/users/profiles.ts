/**
 * Profiles — lightweight, password-free multi-user / profile layer.
 *
 * This is DISTINCT from `src/users/store.ts` (the SQLite, password-auth
 * multi-tenant `UserStore`). Profiles are about *data isolation +
 * appearance*, not authentication:
 *
 *   • Each profile gets its own per-user DATA directory, so its databases
 *     (kanban.db, discipline.db, …) and agent memory live separately.
 *   • SHARED services (the gateway process, infinibot.json, credentials/,
 *     plugins, mcp-servers.json, secrets/) stay at the shared root and are
 *     NOT duplicated per profile — see `resolveSharedDir()` in
 *     `config/paths.ts`. Switching profiles re-points the data layer only;
 *     it never restarts a shared service.
 *   • UI appearance (theme/wallpaper) is stored on the profile record so a
 *     switch can re-skin the app instantly.
 *
 * ── User vs agent nesting ───────────────────────────────────────────
 *   <sharedRoot>/                                  ← shared services AND the
 *                                                    "default" user's data
 *                                                    (preserved IN PLACE)
 *   <sharedRoot>/users/<userId>/                   ← a non-default user's data root
 *   <sharedRoot>/users/<userId>/agents/<agentId>/  ← that user's per-agent memory
 *
 * The "default" user is special: its data dir *is* the shared root, so all
 * existing databases and agent dirs are preserved with ZERO migration.
 * Only NEW profiles get a `users/<id>/` subtree. This is the safe option:
 * we never move live, in-use files.
 *
 * ── Current-user source of truth ────────────────────────────────────
 * A single pointer lives in the registry file's `currentUserId` field
 * (overridable for tests/headless via the `INFINIBOT_USER_ID` env var).
 * `config/paths.ts` reads it through `getCurrentUserId()` so every path
 * that flows through `resolveStateDir()` becomes user-aware. Until a
 * non-default profile is selected, `currentUserId === DEFAULT_USER_ID`
 * and `resolveStateDir()` returns the shared root exactly as before —
 * i.e. the multi-user behaviour is effectively a no-op (feature is
 * "off") for a fresh single-profile install.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  resolveSharedDir,
  DEFAULT_USER_ID,
  setCurrentUserId as setPathsCurrentUserId,
} from "../config/paths.js";

export const PROFILES_FILENAME = "profiles.json";
const REGISTRY_VERSION = 1;

/** Self-reported proficiency, used to tune how agents explain things. */
export type SkillLevel = "beginner" | "intermediate" | "advanced";

export interface Profile {
  /** Stable id; "default" for the in-place root profile. */
  id: string;
  name: string;
  /** Emoji or short avatar token rendered on the gate tile. */
  avatar: string;
  /** UI theme mode for this profile ("system" | "light" | "dark" | "hud"). */
  theme: string;
  /** Optional wallpaper id/url applied on switch. */
  wallpaper?: string;
  createdAt: number;

  // ── Operator context (Layer 1) ─────────────────────────────────────
  // Short, stable, operator-authored fields. ALL optional and ALL default
  // to undefined so existing single-profile installs migrate with zero
  // change. These feed buildProfileContextBlock() (see profile-context.ts)
  // which is injected into every AI surface (voice, coder spawns, chat).
  // Distinct from the auto-memory system (Layer 2), which evolves on its
  // own per-user dir and is never coupled to these fields.
  /** Short title/role, e.g. "Running Example Studio". */
  role?: string;
  /** Multi-line user goals / learning targets. */
  goals?: string;
  /** Multi-line freeform operator notes. */
  notes?: string;
  /** Primary language code/name (e.g. "th"). */
  preferredLanguage?: string;
  /** Optional secondary language (e.g. "en") — enables dual-translate hints. */
  secondaryLanguage?: string;
  /** Self-reported skill level. */
  skillLevel?: SkillLevel;
  /** Multi-line current focus / projects in flight. */
  projectContext?: string;
  /** Short communication-style preference ("explain before jargon", "terse"). */
  communicationStyle?: string;
}

interface Registry {
  version: number;
  currentUserId: string;
  profiles: Profile[];
}

function registryPath(sharedDir = resolveSharedDir()): string {
  return path.join(sharedDir, PROFILES_FILENAME);
}

function defaultProfile(): Profile {
  return {
    id: DEFAULT_USER_ID,
    name: "Default",
    avatar: "🏠",
    theme: "system",
    createdAt: 0,
  };
}

function emptyRegistry(): Registry {
  return {
    version: REGISTRY_VERSION,
    currentUserId: DEFAULT_USER_ID,
    profiles: [defaultProfile()],
  };
}

/** Read an optional, trimmed string field; undefined if absent/empty/non-string. */
function optStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

function optSkillLevel(v: unknown): SkillLevel | undefined {
  return v === "beginner" || v === "intermediate" || v === "advanced" ? v : undefined;
}

function sanitizeProfile(raw: unknown): Profile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id.trim()) return null;
  return {
    id: r.id.trim(),
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : r.id.trim(),
    avatar: typeof r.avatar === "string" && r.avatar ? r.avatar : "👤",
    theme: typeof r.theme === "string" && r.theme ? r.theme : "system",
    wallpaper: typeof r.wallpaper === "string" ? r.wallpaper : undefined,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    // Operator context — all optional; missing on-disk → undefined (no crash).
    role: optStr(r.role),
    goals: optStr(r.goals),
    notes: optStr(r.notes),
    preferredLanguage: optStr(r.preferredLanguage),
    secondaryLanguage: optStr(r.secondaryLanguage),
    skillLevel: optSkillLevel(r.skillLevel),
    projectContext: optStr(r.projectContext),
    communicationStyle: optStr(r.communicationStyle),
  };
}

function readRegistry(sharedDir = resolveSharedDir()): Registry {
  const file = registryPath(sharedDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return emptyRegistry();
  }
  if (!parsed || typeof parsed !== "object") return emptyRegistry();
  const p = parsed as Record<string, unknown>;
  const profiles = Array.isArray(p.profiles)
    ? p.profiles.map(sanitizeProfile).filter((x): x is Profile => x != null)
    : [];
  // Always guarantee the default profile exists at the head.
  if (!profiles.some((x) => x.id === DEFAULT_USER_ID)) {
    profiles.unshift(defaultProfile());
  }
  const currentUserId =
    typeof p.currentUserId === "string" && profiles.some((x) => x.id === p.currentUserId)
      ? p.currentUserId
      : DEFAULT_USER_ID;
  return { version: REGISTRY_VERSION, currentUserId, profiles };
}

function writeRegistry(reg: Registry, sharedDir = resolveSharedDir()): void {
  const file = registryPath(sharedDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

/** Per-user data root for a given profile id. "default" → shared root (in place). */
export function profileDataDir(id: string, sharedDir = resolveSharedDir()): string {
  if (id === DEFAULT_USER_ID) return sharedDir;
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(sharedDir, "users", safe);
}

// ── Public API ──────────────────────────────────────────────────────

export function listProfiles(): { profiles: Profile[]; currentUserId: string } {
  const reg = readRegistry();
  return { profiles: reg.profiles, currentUserId: reg.currentUserId };
}

export function getProfile(id: string): Profile | null {
  return readRegistry().profiles.find((p) => p.id === id) ?? null;
}

export function createProfile(input: {
  name: string;
  avatar?: string;
  theme?: string;
  wallpaper?: string;
}): Profile {
  const name = input.name?.trim();
  if (!name) throw new Error("profile name required");
  const reg = readRegistry();
  if (reg.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`a profile named "${name}" already exists`);
  }
  const profile: Profile = {
    id: `usr_${randomUUID().slice(0, 8)}`,
    name,
    avatar: input.avatar?.trim() || "👤",
    theme: input.theme?.trim() || "system",
    wallpaper: input.wallpaper?.trim() || undefined,
    // createdAt is stamped by the caller (gateway) to keep this module
    // free of Date.now() so it stays deterministic in tests; fall back to
    // 0 if omitted. The gateway method sets it explicitly.
    createdAt: 0,
  };
  // Pre-create the per-user data dir so the first DB open succeeds.
  fs.mkdirSync(profileDataDir(profile.id), { recursive: true });
  reg.profiles.push(profile);
  writeRegistry(reg);
  return profile;
}

export function updateProfile(
  id: string,
  patch: Partial<
    Pick<
      Profile,
      | "name"
      | "avatar"
      | "theme"
      | "wallpaper"
      | "role"
      | "goals"
      | "notes"
      | "preferredLanguage"
      | "secondaryLanguage"
      | "skillLevel"
      | "projectContext"
      | "communicationStyle"
    >
  >,
): Profile | null {
  const reg = readRegistry();
  const profile = reg.profiles.find((p) => p.id === id);
  if (!profile) return null;
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error("profile name cannot be empty");
    if (reg.profiles.some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`a profile named "${name}" already exists`);
    }
    profile.name = name;
  }
  if (patch.avatar !== undefined) profile.avatar = patch.avatar.trim() || profile.avatar;
  if (patch.theme !== undefined) profile.theme = patch.theme.trim() || profile.theme;
  if (patch.wallpaper !== undefined) profile.wallpaper = patch.wallpaper.trim() || undefined;
  // Operator context — empty string clears the field back to undefined so the
  // context block cleanly omits it. skillLevel only accepts the known enum.
  if (patch.role !== undefined) profile.role = patch.role.trim() || undefined;
  if (patch.goals !== undefined) profile.goals = patch.goals.trim() || undefined;
  if (patch.notes !== undefined) profile.notes = patch.notes.trim() || undefined;
  if (patch.preferredLanguage !== undefined)
    profile.preferredLanguage = patch.preferredLanguage.trim() || undefined;
  if (patch.secondaryLanguage !== undefined)
    profile.secondaryLanguage = patch.secondaryLanguage.trim() || undefined;
  if (patch.skillLevel !== undefined) profile.skillLevel = optSkillLevel(patch.skillLevel);
  if (patch.projectContext !== undefined)
    profile.projectContext = patch.projectContext.trim() || undefined;
  if (patch.communicationStyle !== undefined)
    profile.communicationStyle = patch.communicationStyle.trim() || undefined;
  writeRegistry(reg);
  return profile;
}

/**
 * Delete a profile. The "default" profile can never be deleted (it owns
 * the shared root). A profile that is currently active can't be deleted
 * either — switch away first. By default the on-disk data dir is LEFT in
 * place (safe); pass `deleteData: true` to also remove it.
 */
export function deleteProfile(id: string, opts: { deleteData?: boolean } = {}): boolean {
  if (id === DEFAULT_USER_ID) throw new Error("the default profile cannot be deleted");
  const reg = readRegistry();
  if (reg.currentUserId === id)
    throw new Error("cannot delete the active profile; switch away first");
  const idx = reg.profiles.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  reg.profiles.splice(idx, 1);
  writeRegistry(reg);
  if (opts.deleteData) {
    const dir = profileDataDir(id);
    // Guard: never rm the shared root.
    if (dir !== resolveSharedDir()) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
  return true;
}

/**
 * Set the active profile. Persists `currentUserId` to the registry AND
 * updates the in-process pointer in `config/paths.ts` so subsequently
 * instantiated stores resolve to the new per-user data dir. NOTE: stores
 * already opened (cached singletons) keep their old handles — the UI
 * triggers a reload so a fresh connection re-resolves everything.
 */
export function switchProfile(id: string): Profile {
  const reg = readRegistry();
  const profile = reg.profiles.find((p) => p.id === id);
  if (!profile) throw new Error(`unknown profile "${id}"`);
  // Ensure the data dir exists before we point the data layer at it.
  fs.mkdirSync(profileDataDir(id), { recursive: true });
  reg.currentUserId = id;
  writeRegistry(reg);
  setPathsCurrentUserId(id);
  return profile;
}

/**
 * Stamp createdAt on the most recently created profile that lacks one.
 * Called by the gateway create method (which owns wall-clock time) so
 * this module stays Date-free. Returns the updated profile.
 */
export function stampProfileCreatedAt(id: string, createdAt: number): void {
  const reg = readRegistry();
  const profile = reg.profiles.find((p) => p.id === id);
  if (profile && !profile.createdAt) {
    profile.createdAt = createdAt;
    writeRegistry(reg);
  }
}

/**
 * Initialise the in-process current-user pointer from the persisted
 * registry (or the INFINIBOT_USER_ID override). Call once at gateway
 * boot, BEFORE any store is opened, so the very first DB handles resolve
 * to the right per-user dir.
 */
export function initCurrentUserFromRegistry(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.INFINIBOT_USER_ID?.trim();
  if (override) {
    setPathsCurrentUserId(override);
    return override;
  }
  const { currentUserId } = listProfiles();
  setPathsCurrentUserId(currentUserId);
  return currentUserId;
}
