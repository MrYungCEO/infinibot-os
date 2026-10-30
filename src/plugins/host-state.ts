/**
 * Per-plugin host state that applies WITHOUT a gateway restart.
 *
 * Holds the owner's per-plugin choices from `plugins.entries.<id>`:
 *  - `contributions.disabled` — contribution keys switched off individually,
 *  - `contributions.enabled`  — default-off contribution keys switched on,
 *  - `permissions.revoked`    — permission keys the owner took back,
 *  - `permissions.granted`    — gated (default-off) permission keys the owner
 *                               turned on (manifest `permissions.gated`),
 *  - `appearance`             — appearance overrides.
 * The gateway consults this on every plugin RPC, plugin HTTP route and tool
 * resolution, so a toggle takes effect on the next call. The loader seeds it
 * from config on every load, and the plugins.* RPCs update it right after
 * they write config (those config paths are hot/no-op in config-reload).
 */

import type { PluginRecord } from "./registry.js";
import { getActivePluginRegistry } from "./runtime.js";
import { cloudBlockedPermissions } from "../saas/fleet-plugins.js";
import {
  contributionsBlockedByRevokes,
  gatedPermissionKey,
  type ContributionItem,
} from "./contributions.js";
import type { PluginAppearanceOverride } from "./appearance.js";

export type PluginHostEntryState = {
  disabled: Set<string>;
  /** Default-off contributions (e.g. cron with defaultEnabled:false) the owner turned on. */
  enabled: Set<string>;
  /** Effective revoked keys: owner revokes plus gated permissions not granted. */
  revoked: Set<string>;
  /** Gated permission keys the owner granted. */
  granted: Set<string>;
  appearance?: PluginAppearanceOverride;
};

const STATE = Symbol.for("infinibot.pluginHostState");

function store(): Map<string, PluginHostEntryState> {
  const g = globalThis as typeof globalThis & { [STATE]?: Map<string, PluginHostEntryState> };
  if (!g[STATE]) g[STATE] = new Map();
  return g[STATE];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringSet(value: unknown): Set<string> {
  return new Set(
    (Array.isArray(value) ? value : [])
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean),
  );
}

/** Replace the whole state from a `plugins` config block. */
export function syncPluginHostStateFromConfig(plugins: unknown): void {
  const next = new Map<string, PluginHostEntryState>();
  const entries = isRecord(plugins) && isRecord(plugins.entries) ? plugins.entries : {};
  for (const [id, raw] of Object.entries(entries)) {
    if (!isRecord(raw)) continue;
    const contributions = isRecord(raw.contributions) ? raw.contributions : {};
    const permissions = isRecord(raw.permissions) ? raw.permissions : {};
    next.set(id, {
      disabled: stringSet(contributions.disabled),
      enabled: stringSet(contributions.enabled),
      revoked: stringSet(permissions.revoked),
      granted: stringSet(permissions.granted),
      appearance: isRecord(raw.appearance)
        ? (raw.appearance as PluginAppearanceOverride)
        : undefined,
    });
  }
  const s = store();
  s.clear();
  for (const [k, v] of next) s.set(k, v);
}

function rawHostState(pluginId: string): PluginHostEntryState {
  return (
    store().get(pluginId) ?? {
      disabled: new Set(),
      enabled: new Set(),
      revoked: new Set(),
      granted: new Set(),
    }
  );
}

/** Gated permission keys the plugin declares (manifest `permissions.gated`). */
function gatedKeysOf(pluginId: string): string[] {
  const record = (getActivePluginRegistry()?.plugins ?? []).find((p) => p.id === pluginId);
  const gated = (record?.permissions as { gated?: unknown } | undefined)?.gated;
  if (!Array.isArray(gated)) return [];
  return gated
    .map((g) => (isRecord(g) && typeof g.id === "string" ? g.id.trim() : ""))
    .filter(Boolean)
    .map(gatedPermissionKey);
}

/**
 * The owner's choices for a plugin. `revoked` is the EFFECTIVE set: gated
 * permissions count as revoked until they are explicitly granted, so every
 * contribution that `requires` one stays off by default.
 */
export function getPluginHostState(pluginId: string): PluginHostEntryState {
  const raw = rawHostState(pluginId);
  // Hosted fleet: platform-blocked gated permissions stay revoked even if the
  // (tenant-writable) config records a grant.
  const blocked = cloudBlockedPermissions(pluginId);
  const gated = gatedKeysOf(pluginId).filter((k) => !raw.granted.has(k) || Boolean(blocked?.[k]));
  if (gated.length === 0) return raw;
  return { ...raw, revoked: new Set([...raw.revoked, ...gated]) };
}

export function setPluginHostState(pluginId: string, patch: Partial<PluginHostEntryState>): void {
  const cur = rawHostState(pluginId);
  store().set(pluginId, { ...cur, ...patch });
}

/** Is a permission key (including a gated one) currently granted? */
export function isPluginPermissionGranted(pluginId: string, key: string): boolean {
  return !getPluginHostState(pluginId).revoked.has(key);
}

export function clearPluginHostState(pluginId: string): void {
  store().delete(pluginId);
}

export type ContributionState = ContributionItem & {
  enabled: boolean;
  /** Why it's off: "owner" (switched off) or "permission" (revoked dependency). */
  offReason?: "owner" | "permission";
  blockedBy?: string[];
};

/** Catalog items annotated with their effective on/off state. */
export function resolveContributionStates(
  pluginId: string,
  items: ContributionItem[],
): ContributionState[] {
  const st = getPluginHostState(pluginId);
  const blocked = new Map(
    contributionsBlockedByRevokes(items, st.revoked).map((i) => [
      i.key,
      i.requires.filter(
        (r) => st.revoked.has(r) || [...st.revoked].some((k) => k.startsWith(`${r}:`)),
      ),
    ]),
  );
  return items.map((item) => {
    const defaultOff = item.defaultEnabled === false;
    const ownerOff = st.disabled.has(item.key) || (defaultOff && !st.enabled.has(item.key));
    const blockedBy = blocked.get(item.key);
    const enabled = !ownerOff && !blockedBy;
    return {
      ...item,
      enabled,
      offReason: ownerOff ? "owner" : blockedBy ? "permission" : undefined,
      blockedBy,
    };
  });
}

/** Is a contribution (by key) currently active for a plugin? */
export function isContributionActive(
  record: Pick<PluginRecord, "id" | "catalog">,
  key: string,
): boolean {
  const items = record.catalog?.items ?? [];
  const st = getPluginHostState(record.id);
  if (st.disabled.has(key)) return false;
  const item = items.find((i) => i.key === key);
  if (!item) return true;
  if (item.defaultEnabled === false && !st.enabled.has(key)) return false;
  return contributionsBlockedByRevokes([item], st.revoked).length === 0;
}

function loadedPlugins(): PluginRecord[] {
  return (getActivePluginRegistry()?.plugins ?? []).filter((p) => p.status === "loaded");
}

/**
 * Null when the plugin RPC may run; otherwise a human reason. Methods that
 * aren't plugin methods return null (not ours to gate).
 */
export function pluginMethodBlockedReason(method: string): string | null {
  for (const p of loadedPlugins()) {
    if (!p.gatewayMethods.includes(method)) continue;
    if (!p.catalog) return null;
    // Aliases (contributes.rpcAliases and rpc[].aliases) are gated exactly like
    // the method they point at: same owner toggle, same `requires` permissions.
    const target = pluginAliasTarget(p, method);
    return isContributionActive(p, `rpc:${target}`)
      ? null
      : `${method} is turned off in Setup › Plugins › ${p.name}`;
  }
  return null;
}

/** The declared rpc method a plugin method name resolves to (itself when not an alias). */
export function pluginAliasTarget(
  record: Pick<PluginRecord, "contributes">,
  method: string,
): string {
  const c = record.contributes;
  if (!c) return method;
  if (c.rpc.some((r) => r.method === method)) return method;
  const viaDecl = c.rpc.find((r) => r.aliases?.includes(method));
  if (viaDecl) return viaDecl.method;
  return c.rpcAliases?.find((a) => a.method === method)?.target ?? method;
}

/** False when a plugin HTTP route is switched off (or its permission revoked). */
export function isPluginHttpRouteActive(pluginId: string | undefined, path: string): boolean {
  if (!pluginId) return true;
  const p = loadedPlugins().find((x) => x.id === pluginId);
  if (!p?.catalog) return true;
  return isContributionActive(p, `http:${path}`);
}

/** False when a plugin tool is switched off (or its permission revoked). */
export function isPluginToolActive(pluginId: string, toolName: string): boolean {
  const p = (getActivePluginRegistry()?.plugins ?? []).find((x) => x.id === pluginId);
  if (!p?.catalog) return true;
  return isContributionActive(p, `tool:${toolName}`);
}

/** Reset hook for tests. */
export function resetPluginHostStateForTests(): void {
  store().clear();
}
