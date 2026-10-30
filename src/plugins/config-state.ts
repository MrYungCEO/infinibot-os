import type { InfinibotConfig } from "../config/config.js";
import { cloudPluginDecision } from "../saas/fleet-plugins.js";
import { pluginAccessDecision } from "./entitlements/access.js";
import { defaultSlotIdForKey } from "./slots.js";
import type { PluginRecord } from "./registry.js";

export type NormalizedPluginsConfig = {
  enabled: boolean;
  allow: string[];
  deny: string[];
  loadPaths: string[];
  slots: {
    memory?: string | null;
  };
  entries: Record<string, { enabled?: boolean; config?: unknown }>;
  /** Ids installed as plugin packages (zip / url / registry): off until turned on. */
  packageInstalls: string[];
  /**
   * `<id>@<version>#<sha256>` of every package install. Part of the loader's
   * cache key, so updating or rolling back a package reloads it at the next
   * (in-process) gateway restart instead of serving the cached old version.
   */
  packageStamps: string[];
};

const PACKAGE_SOURCES: ReadonlySet<string> = new Set(["zip", "url", "registry"]);

/**
 * Bundled plugins that are on unless the owner turns them off. Keep this to
 * plugins that are idle until set up:
 *  - kinglyvault-relay: KinglyVault Connect. No network traffic until paired;
 *    on by default so onboarding / Plugins / Settings can link KinglyVault in
 *    one click and the UI never calls a missing kvconnect.* method.
 */
export const BUNDLED_ENABLED_BY_DEFAULT = new Set<string>(["kinglyvault-relay"]);

const normalizeList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
};

const normalizeSlotValue = (value: unknown): string | null | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === "none") return null;
  return trimmed;
};

const normalizePluginEntries = (entries: unknown): NormalizedPluginsConfig["entries"] => {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return {};
  }
  const normalized: NormalizedPluginsConfig["entries"] = {};
  for (const [key, value] of Object.entries(entries)) {
    if (!key.trim()) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      normalized[key] = {};
      continue;
    }
    const entry = value as Record<string, unknown>;
    normalized[key] = {
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : undefined,
      config: "config" in entry ? entry.config : undefined,
    };
  }
  return normalized;
};

function packageRecords(config?: InfinibotConfig["plugins"]) {
  return Object.entries(config?.installs ?? {})
    .filter(([, record]) => PACKAGE_SOURCES.has(String(record?.source)))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export const normalizePluginsConfig = (
  config?: InfinibotConfig["plugins"],
): NormalizedPluginsConfig => {
  const memorySlot = normalizeSlotValue(config?.slots?.memory);
  return {
    enabled: config?.enabled !== false,
    allow: normalizeList(config?.allow),
    deny: normalizeList(config?.deny),
    loadPaths: normalizeList(config?.load?.paths),
    slots: {
      memory: memorySlot === undefined ? defaultSlotIdForKey("memory") : memorySlot,
    },
    entries: normalizePluginEntries(config?.entries),
    packageInstalls: packageRecords(config).map(([id]) => id),
    packageStamps: packageRecords(config).map(
      ([id, record]) => `${id}@${record.version ?? ""}#${record.sha256 ?? ""}`,
    ),
  };
};

export function resolveEnableState(
  id: string,
  origin: PluginRecord["origin"],
  config: NormalizedPluginsConfig,
  opts: { manifestAccess?: unknown } = {},
): { enabled: boolean; reason?: string } {
  if (!config.enabled) {
    return { enabled: false, reason: "plugins disabled" };
  }
  if (config.deny.includes(id)) {
    return { enabled: false, reason: "blocked by denylist" };
  }
  // Hosted fleet tenant Machine: cloud availability + the tenant's plan win
  // over any config entry (config is tenant-writable). No-op elsewhere.
  const cloud = cloudPluginDecision(id, origin);
  if (cloud && !cloud.loadable) {
    return { enabled: false, reason: cloud.reason };
  }
  if (config.allow.length > 0 && !config.allow.includes(id)) {
    return { enabled: false, reason: "not in allowlist" };
  }
  // Paid plugins: a verified KinglyVault entitlement (or this machine's signed
  // owner grant) is required, whatever the config says.
  const access = pluginAccessDecision(id, { manifestAccess: opts.manifestAccess });
  if (!access.loadable) {
    return { enabled: false, reason: access.reason };
  }
  if (config.slots.memory === id) {
    return { enabled: true };
  }
  const entry = config.entries[id];
  if (entry?.enabled === true) {
    return { enabled: true };
  }
  if (entry?.enabled === false) {
    return { enabled: false, reason: "disabled in config" };
  }
  if (origin === "bundled" && BUNDLED_ENABLED_BY_DEFAULT.has(id)) {
    return { enabled: true };
  }
  if (origin === "bundled") {
    return { enabled: false, reason: "bundled (disabled by default)" };
  }
  // An imported package is never switched on by installing it: the owner
  // reviews it and turns it on (plugins.entries.<id>.enabled).
  if (origin === "global" && config.packageInstalls?.includes(id)) {
    return { enabled: false, reason: "installed (not turned on yet)" };
  }
  return { enabled: true };
}

export function resolveMemorySlotDecision(params: {
  id: string;
  kind?: string;
  slot: string | null | undefined;
  selectedId: string | null;
}): { enabled: boolean; reason?: string; selected?: boolean } {
  if (params.kind !== "memory") return { enabled: true };
  if (params.slot === null) {
    return { enabled: false, reason: "memory slot disabled" };
  }
  if (typeof params.slot === "string") {
    if (params.slot === params.id) {
      return { enabled: true, selected: true };
    }
    return {
      enabled: false,
      reason: `memory slot set to "${params.slot}"`,
    };
  }
  if (params.selectedId && params.selectedId !== params.id) {
    return {
      enabled: false,
      reason: `memory slot already filled by "${params.selectedId}"`,
    };
  }
  return { enabled: true, selected: true };
}
