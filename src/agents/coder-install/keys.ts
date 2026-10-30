/**
 * BYOK keys for coder CLIs.
 *
 * Stored in the existing auth-profile store (per agent dir, which resolves
 * under the state dir, so a hosted tenant's keys live on its own /data
 * volume) as `coder-cli:<coderId>:<ENV_VAR>` profiles with provider
 * "coder-cli". That provider id matches no model provider, so a coder key
 * never changes which key the gateway's own LLM calls use.
 *
 * Keys are write-only from the RPC side: status reports which env vars are
 * set, never the values. They are injected only into the env of the coder
 * they belong to (see applyCoderSpawnEnv, called by each backend's env
 * builder).
 */

import fs from "node:fs";
import path from "node:path";

import { DEFAULT_USER_ID, getScopedUserId, resolveStateDir } from "../../config/paths.js";
import { DEFAULT_AGENT_ID } from "../../routing/session-key.js";
import { AUTH_STORE_VERSION } from "../auth-profiles/constants.js";
import { resolveAuthStorePath } from "../auth-profiles/paths.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "../auth-profiles/store.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import type { CoderBackendId } from "../coder-backend/types.js";
import { apiKeyEnvVars, coderForBackend, getCoderEntry, type CoderId } from "./catalog.js";

const PROFILE_PREFIX = "coder-cli:";
const PROVIDER = "coder-cli";

/**
 * Env vars a sign-in flow may store in addition to the catalog's API-key vars:
 * `claude setup-token` prints a long-lived OAuth token that Claude Code reads
 * from CLAUDE_CODE_OAUTH_TOKEN.
 */
const EXTRA_ENV: Partial<Record<CoderId, string[]>> = {
  "claude-code": ["CLAUDE_CODE_OAUTH_TOKEN"],
};

export function allowedKeyEnvVars(id: CoderId): string[] {
  const entry = getCoderEntry(id);
  if (!entry) return [];
  return [...apiKeyEnvVars(entry), ...(EXTRA_ENV[id] ?? [])];
}

/**
 * Auth store location. Outside a tenant request this is the normal main-agent
 * store. Inside a scoped SaaS tenant request it is that tenant's own
 * `<state>/users/<ns>/agents/main/agent`, because INFINIBOT_AGENT_DIR is pinned
 * process-wide at boot and would otherwise be shared by every tenant.
 */
function keyAgentDir(): string | undefined {
  const scoped = getScopedUserId();
  if (!scoped || scoped === DEFAULT_USER_ID) return undefined;
  return path.join(resolveStateDir(), "agents", DEFAULT_AGENT_ID, "agent");
}

/**
 * Open the key store for the active scope. A tenant store is read and written
 * as a plain file: ensureAuthProfileStore(agentDir) would inherit and merge the
 * main agent's profiles, i.e. hand the operator's keys to a tenant.
 */
function openStore(): { store: AuthProfileStore; save: () => void } {
  const dir = keyAgentDir();
  if (!dir) {
    const store = ensureAuthProfileStore();
    return { store, save: () => saveAuthProfileStore(store) };
  }
  let store: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(resolveAuthStorePath(dir), "utf8")) as AuthProfileStore;
    if (raw && typeof raw.profiles === "object" && raw.profiles) store = raw;
  } catch {
    /* no store yet */
  }
  return { store, save: () => saveAuthProfileStore(store, dir) };
}

function profileId(id: CoderId, envVar: string): string {
  return `${PROFILE_PREFIX}${id}:${envVar}`;
}

export function validateKey(key: unknown): string {
  if (typeof key !== "string") throw new Error("key must be a string");
  const k = key.trim();
  if (k.length < 8 || k.length > 4096) throw new Error("key length looks wrong");
  if (/\s/.test(k)) throw new Error("key must not contain whitespace");
  return k;
}

export function setCoderKey(id: CoderId, envVar: string, key: string): void {
  if (!allowedKeyEnvVars(id).includes(envVar)) {
    throw new Error(`${envVar} is not a key variable for ${id}`);
  }
  const value = validateKey(key);
  const { store, save } = openStore();
  store.profiles[profileId(id, envVar)] = { type: "api_key", provider: PROVIDER, key: value };
  save();
}

/** Remove one key, or all of a coder's keys when envVar is omitted. */
export function clearCoderKey(id: CoderId, envVar?: string): number {
  const { store, save } = openStore();
  let removed = 0;
  for (const pid of Object.keys(store.profiles)) {
    if (!pid.startsWith(`${PROFILE_PREFIX}${id}:`)) continue;
    if (envVar && pid !== profileId(id, envVar)) continue;
    delete store.profiles[pid];
    removed++;
  }
  if (removed) save();
  return removed;
}

/** Stored key values by env var. Internal: never return this over RPC. */
export function coderKeyEnv(id: CoderId): Record<string, string> {
  const out: Record<string, string> = {};
  let store;
  try {
    store = openStore().store;
  } catch {
    return out;
  }
  const prefix = `${PROFILE_PREFIX}${id}:`;
  for (const [pid, cred] of Object.entries(store.profiles)) {
    if (!pid.startsWith(prefix) || cred.provider !== PROVIDER || cred.type !== "api_key") continue;
    const envVar = pid.slice(prefix.length);
    if (allowedKeyEnvVars(id).includes(envVar) && cred.key) out[envVar] = cred.key;
  }
  return out;
}

/** Which env vars have a stored key (names only). */
export function coderKeyNames(id: CoderId): string[] {
  return Object.keys(coderKeyEnv(id)).sort();
}

/**
 * Put a coder's stored keys into a spawn env. Call BEFORE merging per-agent
 * config env and per-launch overrides, so explicit settings still win over
 * the stored key while the stored key wins over whatever the gateway process
 * happened to inherit.
 */
export function applyCoderSpawnEnv(
  backend: CoderBackendId,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const entry = coderForBackend(backend);
  if (!entry) return env;
  for (const [k, v] of Object.entries(coderKeyEnv(entry.id))) env[k] = v;
  return env;
}
