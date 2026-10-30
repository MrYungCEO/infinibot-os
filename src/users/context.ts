/**
 * User Context — resolve a logged-in user's environment for the agent.
 *
 * Given the gateway password an active connection authenticated with,
 * we look up the owning user account and return:
 *   • `cwd` — the absolute path subagents should treat as their default
 *     workspace (the user's per-user `.clawd`-style folder)
 *   • `systemPromptPrefix` — a string the chat handler can prepend to
 *     the agent's system prompt so every session for this user starts
 *     with their language + free-form context
 *   • `gating` — the path-locking policy: when enabled, filesystem
 *     tools must reject paths outside `allowedDirs` ∪ {cwd}
 *
 * The chat / agent handlers call `resolveUserContextFromPassword()` at
 * the start of a turn (or whenever they're building a system prompt /
 * picking a cwd) and apply whatever fields are non-null. Admin users
 * never have gating applied even when their record sets it.
 */

import { resolve } from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { getUserStore, type User } from "./store.js";

export interface UserContext {
  user: User;
  cwd: string;
  systemPromptPrefix: string;
  gating: {
    enabled: boolean;
    /** Absolute paths the filesystem tools may touch. Always includes cwd. */
    allowedDirs: string[];
  };
}

/**
 * Compose the system-prompt prefix from a user's language + context
 * settings. Empty when the user set neither, so the chat handler can
 * skip the prefix without an awkward leading newline.
 */
export function buildUserSystemPromptPrefix(user: User): string {
  const parts: string[] = [];
  const lang = user.language?.trim();
  if (lang) {
    parts.push(`The user's preferred language is "${lang}". Respond in this language by default.`);
  }
  const ctx = user.context?.trim();
  if (ctx) {
    parts.push(`User-supplied background context (always relevant, never repeat back verbatim):\n${ctx}`);
  }
  return parts.length > 0 ? `[User profile]\n${parts.join("\n\n")}` : "";
}

/**
 * Resolve the path-gating policy for a user. Admins bypass entirely.
 * Non-admin users with `agentGatingEnabled` get a closed list; everyone
 * else gets `enabled: false` (open) but still has a default cwd.
 */
export function resolveUserGating(user: User): UserContext["gating"] {
  if (user.role === "admin") return { enabled: false, allowedDirs: [] };
  if (!user.agentGatingEnabled) return { enabled: false, allowedDirs: [] };
  const dirs = new Set<string>([resolve(user.homeDir)]);
  for (const d of user.allowedDirs) {
    const trimmed = d?.trim();
    if (trimmed) dirs.add(resolve(trimmed));
  }
  return { enabled: true, allowedDirs: [...dirs] };
}

export function resolveUserContext(user: User): UserContext {
  return {
    user,
    cwd: resolve(user.homeDir),
    systemPromptPrefix: buildUserSystemPromptPrefix(user),
    gating: resolveUserGating(user),
  };
}

/**
 * Given the gateway password from an authenticated connection, look up
 * the owning user and return their context. Returns null when no user
 * matches (legacy single-tenant gateways or when the password is the
 * bare admin one).
 */
export function resolveUserContextFromPassword(password: string | undefined): UserContext | null {
  if (!password) return null;
  const user = getUserStore(resolveStateDir()).findByGatewayPassword(password);
  return user ? resolveUserContext(user) : null;
}

/**
 * Cheap path check for tools that touch the filesystem when gating is
 * on. Returns true when `target` is inside any of the allowed dirs.
 * Performs path normalization but doesn't follow symlinks — callers
 * that need stricter checks should also `realpathSync()` first.
 */
export function isPathAllowed(ctx: UserContext, target: string): boolean {
  if (!ctx.gating.enabled) return true;
  const abs = resolve(target);
  return ctx.gating.allowedDirs.some((dir) => abs === dir || abs.startsWith(dir + "/") || abs.startsWith(dir + "\\"));
}
