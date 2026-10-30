/**
 * Plugins Gateway Handlers — Setup › Plugins full control.
 *
 * `plugins.list` feeds the control-ui's Plugins page and plugin host: each
 * plugin's status, trust tier, health, v1 `ui` block and, for manifest-v2
 * plugins, the declared contributions, requested permissions, the contribution
 * keys that are currently off and the resolved appearance. The UI builds
 * plugin nav entries, page gating and scoped appearance styles from this.
 *
 * Everything else manages one plugin (`{ id }`):
 *  - plugins.get                     full detail for the detail pane
 *  - plugins.setEnabled              enable/disable (gateway restart)
 *  - plugins.contributions.set       toggle one contribution (live)
 *  - plugins.permissions.set         grant/revoke one permission (live,
 *                                    cascades to dependent contributions)
 *  - plugins.config.get/set          settings form (secrets write-only;
 *                                    saving reloads the plugin = restart)
 *  - plugins.appearance.get/preview/set/reset   appearance (live)
 *  - plugins.health / plugins.logs / plugins.restart
 *  - plugins.data.export/import/clear
 *  - plugins.uninstall               keep-data / remove-data (restart)
 *
 * All are admin-only: none is listed in READ/WRITE_METHODS, so
 * authorizeGatewayMethod requires operator.admin.
 */

import fs from "node:fs";
import path from "node:path";

import {
  loadConfig,
  readConfigFileSnapshot as readConfigFileSnapshotForScope,
  readRawConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile as writeConfigFileForScope,
} from "../../config/config.js";
import type { InfinibotConfig } from "../../config/config.js";
import type { CatalogPluginInput } from "../../learn/guided/catalog.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import {
  resolvePluginAppearance,
  validateAppearanceOverride,
  DEFAULT_APPEARANCE,
  type PluginAppearanceOverride,
} from "../../plugins/appearance.js";
import {
  contributionsBlockedByRevokes,
  listPermissionItems,
  CONTRIBUTION_KIND_LABELS,
  CONTRIBUTION_KIND_PLURALS,
} from "../../plugins/contributions.js";
import {
  clearPluginHostState,
  getPluginHostState,
  resolveContributionStates,
  setPluginHostState,
} from "../../plugins/host-state.js";
import { readPluginRosterAgentIds } from "../../plugins/agent-contributions.js";
import { pluginAccessDecision } from "../../plugins/entitlements/access.js";
import { resolveListingForUi } from "../../plugins/listing.js";
import { PLUGIN_API_VERSION } from "../../plugins/manifest-v2.js";
import {
  clearPluginData,
  exportPluginData,
  importPluginData,
  pluginDataSummary,
} from "../../plugins/plugin-data.js";
import { appendPluginLog, lastPluginErrors, readPluginLogs } from "../../plugins/plugin-logs.js";
import type { PluginRecord } from "../../plugins/registry.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { listPluginServiceStates, reconcilePluginServices } from "../../plugins/services.js";
import {
  cloudBlockedPermissions,
  cloudPluginDecision,
  cloudPluginEnableRefusal,
  isFleetTenantMachine,
} from "../../saas/fleet-plugins.js";
import { CONFIG_DIR } from "../../utils.js";
import { removePackageVersions } from "../../plugins/packages/install.js";
import { readUpdateState, type PluginUpdateState } from "../../plugins/packages/store.js";
import { isRegistryManaged } from "../../plugins/packages/updates.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

type Respond = GatewayRequestHandlerOptions["respond"];

// Hosted fleet tenant Machine: infinibot.json is the tenant's own gateway
// config (on its own volume), so plugin changes read the RAW file — never the
// redacted tenant view — and may write it. Cloud availability + the plan are
// still enforced at load (resolveEnableState) whatever the file says.
export function readConfigFileSnapshot() {
  return isFleetTenantMachine() ? readRawConfigFileSnapshot() : readConfigFileSnapshotForScope();
}
export function writeConfigFile(cfg: InfinibotConfig) {
  return writeConfigFileForScope(cfg, { fleetMachine: isFleetTenantMachine() });
}
type EntryConfig = Record<string, unknown>;

/** Pure config transform, exported for tests. */
export function setPluginEnabledInConfig(
  cfg: InfinibotConfig,
  pluginId: string,
  enabled: boolean,
): InfinibotConfig {
  const entries = { ...cfg.plugins?.entries } as Record<string, Record<string, unknown>>;
  entries[pluginId] = { ...entries[pluginId], enabled };
  let allow = cfg.plugins?.allow;
  if (enabled && Array.isArray(allow) && allow.length > 0 && !allow.includes(pluginId)) {
    allow = [...allow, pluginId];
  }
  return {
    ...cfg,
    plugins: { ...cfg.plugins, ...(allow ? { allow } : {}), entries },
  } as InfinibotConfig;
}

/** Pure transform: apply `fn` to plugins.entries.<id> (undefined deletes it). */
export function updatePluginEntryInConfig(
  cfg: InfinibotConfig,
  pluginId: string,
  fn: (entry: EntryConfig) => EntryConfig | undefined,
): InfinibotConfig {
  const entries = { ...cfg.plugins?.entries } as Record<string, EntryConfig>;
  const next = fn({ ...entries[pluginId] });
  if (next === undefined) delete entries[pluginId];
  else {
    // Drop empty sub-objects so a reset leaves no residue.
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined) delete next[k];
      else if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)
        delete next[k];
    }
    entries[pluginId] = next;
  }
  return { ...cfg, plugins: { ...cfg.plugins, entries } } as InfinibotConfig;
}

/** Pure transform: toggle one contribution key. */
export function setContributionInEntry(
  entry: EntryConfig,
  key: string,
  enabled: boolean,
  defaultEnabled: boolean,
): EntryConfig {
  const c = (entry.contributions ?? {}) as { disabled?: string[]; enabled?: string[] };
  const disabled = new Set(c.disabled ?? []);
  const forced = new Set(c.enabled ?? []);
  disabled.delete(key);
  forced.delete(key);
  if (!enabled) disabled.add(key);
  else if (!defaultEnabled) forced.add(key);
  const contributions: Record<string, string[]> = {};
  if (disabled.size) contributions.disabled = [...disabled].sort();
  if (forced.size) contributions.enabled = [...forced].sort();
  return { ...entry, contributions };
}

/** Pure transform: grant/revoke one permission key. */
export function setPermissionInEntry(
  entry: EntryConfig,
  key: string,
  granted: boolean,
): EntryConfig {
  const p = (entry.permissions ?? {}) as { revoked?: string[]; granted?: string[] };
  const revoked = new Set(p.revoked ?? []);
  const grants = new Set(p.granted ?? []);
  if (key.startsWith("gated:")) {
    // Gated permissions are OFF by default: record grants, not revokes.
    revoked.delete(key);
    if (granted) grants.add(key);
    else grants.delete(key);
  } else if (granted) revoked.delete(key);
  else revoked.add(key);
  const permissions: { revoked?: string[]; granted?: string[] } = {};
  if (revoked.size) permissions.revoked = [...revoked].sort();
  if (grants.size) permissions.granted = [...grants].sort();
  return { ...entry, permissions };
}

// ── helpers ──────────────────────────────────────────────────────────────

export function bad(respond: Respond, message: string, details?: unknown): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, message, details ? { details } : undefined),
  );
}

function findRecord(id: string): PluginRecord | undefined {
  return (getActivePluginRegistry()?.plugins ?? []).find((p) => p.id === id);
}

function requireRecord(params: unknown, respond: Respond): PluginRecord | undefined {
  const id =
    typeof (params as { id?: unknown })?.id === "string"
      ? String((params as { id: string }).id).trim()
      : "";
  if (!id) {
    bad(respond, "expected { id }");
    return undefined;
  }
  const record = findRecord(id);
  if (!record) {
    bad(respond, `unknown plugin "${id}"`);
    return undefined;
  }
  return record;
}

/** Read → transform → validate → write the config file. */
export async function writeConfig(
  respond: Respond,
  transform: (cfg: InfinibotConfig) => InfinibotConfig,
): Promise<InfinibotConfig | undefined> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    bad(respond, "config file is invalid; fix it before changing plugins", {
      issues: snapshot.issues,
    });
    return undefined;
  }
  const validated = validateConfigObjectWithPlugins(transform(snapshot.config));
  if (!validated.ok) {
    bad(respond, "invalid config", { issues: validated.issues });
    return undefined;
  }
  await writeConfigFile(validated.config);
  return validated.config;
}

async function currentEntry(id: string): Promise<EntryConfig> {
  const snapshot = await readConfigFileSnapshot();
  return ((snapshot.config.plugins?.entries ?? {}) as Record<string, EntryConfig>)[id] ?? {};
}

export type PluginTrustTier = "first-party" | "verified" | "community";

export function pluginTrustTier(
  record: Pick<PluginRecord, "origin" | "publisher">,
): PluginTrustTier {
  if (record.origin === "bundled") return "first-party";
  if (record.publisher === "infinibot") return "verified";
  return "community";
}

type HealthState = "ok" | "degraded" | "error" | "off";

function pluginHealth(record: PluginRecord): { state: HealthState; reason?: string } {
  if (record.status === "error") return { state: "error", reason: record.error };
  if (record.status !== "loaded") return { state: "off", reason: record.error };
  const services = listPluginServiceStates(record.id);
  const failed = services.find((s) => s.lastError);
  if (failed) return { state: "degraded", reason: `service ${failed.id}: ${failed.lastError}` };
  const missing = (record.contributes?.rpc ?? []).filter(
    (r) => !record.gatewayMethods.includes(r.method),
  );
  if (missing.length)
    return { state: "degraded", reason: `${missing.length} declared RPC method(s) not registered` };
  const recent = lastPluginErrors(record.id, 1)[0];
  if (recent && Date.now() - recent.ts < 10 * 60_000)
    return { state: "degraded", reason: recent.message };
  return { state: "ok" };
}

function appearanceFor(record: PluginRecord) {
  return resolvePluginAppearance(
    record.id,
    record.appearance ?? (record.manifestVersion === 2 ? DEFAULT_APPEARANCE : undefined),
    getPluginHostState(record.id).appearance,
  );
}

function contributionStates(record: PluginRecord) {
  return resolveContributionStates(record.id, record.catalog?.items ?? []);
}

export type PluginSetupState = {
  needed: boolean;
  reason?: string;
  /** Where the owner finishes setup: the plugin's settings or Setup › Channels. */
  target?: "settings" | "channels";
};

/**
 * Whether an enabled plugin still needs setup, from real config only: a
 * channel plugin with no `channels.<id>` block, or required settings unset.
 * Exported for tests.
 */
export function pluginSetupState(
  record: Pick<PluginRecord, "id" | "enabled" | "declaredChannels" | "configJsonSchema">,
  cfg: InfinibotConfig | undefined,
): PluginSetupState {
  if (!record.enabled || !cfg) return { needed: false };
  const channels = record.declaredChannels ?? [];
  const channelCfg = (cfg.channels ?? {}) as Record<string, unknown>;
  if (channels.length && !channels.some((ch) => channelCfg[ch] !== undefined)) {
    return { needed: true, reason: "No account connected yet", target: "channels" };
  }
  const required = Array.isArray(record.configJsonSchema?.required)
    ? (record.configJsonSchema.required as unknown[]).filter(
        (k): k is string => typeof k === "string",
      )
    : [];
  const entry = ((cfg.plugins?.entries ?? {}) as Record<string, EntryConfig>)[record.id];
  const values = (entry?.config ?? {}) as Record<string, unknown>;
  const missing = required.filter((k) => values[k] === undefined || values[k] === "");
  if (missing.length) {
    return {
      needed: true,
      reason: `${missing.length} required setting${missing.length === 1 ? "" : "s"} not set`,
      target: "settings",
    };
  }
  return { needed: false };
}

/**
 * plugins.list stays small: Learn tracks can be large, so only their ids and
 * titles are listed here. The full content is served by learn.guided.catalog.
 */
function slimContributes(contributes: PluginRecord["contributes"]) {
  if (!contributes?.learn) return contributes;
  return {
    ...contributes,
    learn: {
      tracks: contributes.learn.tracks.map((t) => ({
        id: t.id,
        title: t.title,
        walkthroughs: t.walkthroughs.length,
      })),
      missions: contributes.learn.missions,
    },
  };
}

/** Plugin state the guided Learn catalog needs (src/learn/guided/catalog.ts). */
export function learnCatalogPluginInputs(): CatalogPluginInput[] {
  return (getActivePluginRegistry()?.plugins ?? []).map((record) => {
    const v2 = record.manifestVersion === 2;
    const appearance = v2 ? appearanceFor(record) : undefined;
    const dark = appearance?.themes.dark.vars["--g-accent"];
    const light = appearance?.themes.light.vars["--g-accent"];
    return {
      id: record.id,
      name: record.name,
      enabled: record.enabled,
      status: record.status,
      learn: record.contributes?.learn,
      disabledContributions: v2
        ? contributionStates(record)
            .filter((c) => !c.enabled)
            .map((c) => c.key)
        : [],
      monogram: appearance?.values.monogram,
      icon: appearance?.values.icon,
      accent: dark || light ? { dark, light } : undefined,
    };
  });
}

function summarize(
  record: PluginRecord,
  cfg?: InfinibotConfig,
  updates: PluginUpdateState = readUpdateState(),
) {
  const health = pluginHealth(record);
  const access = pluginAccessDecision(record.id, { manifestAccess: record.manifestAccess });
  const update = updates.plugins[record.id];
  const v2 = record.manifestVersion === 2;
  const appearance = v2 ? appearanceFor(record) : undefined;
  return {
    id: record.id,
    name: record.name,
    version: record.version,
    description: record.description,
    source: record.source,
    origin: record.origin,
    enabled: record.enabled,
    status: record.status,
    error: record.error,
    ui: record.ui,
    manifestVersion: record.manifestVersion ?? 1,
    contributes: slimContributes(record.contributes),
    /** Roster agent ids seeded from `contributes.agents` (mesh-map plugin rooms). */
    rosterAgentIds:
      v2 && record.contributes?.agents?.length && record.rootDir
        ? readPluginRosterAgentIds(record.rootDir, record.contributes.agents)
        : [],
    permissions: record.permissions,
    gatewayMethods: record.gatewayMethods,
    publisher: record.publisher,
    license: record.license,
    tier: pluginTrustTier(record),
    health,
    kind: record.kind,
    category: record.category ?? "developer",
    listing: resolveListingForUi(record.id, record.listing),
    channels: record.declaredChannels ?? [],
    providers: record.declaredProviders ?? [],
    setup: pluginSetupState(record, cfg),
    /** Hosted fleet only: plan / cloud-availability status (null elsewhere). */
    cloud: cloudPluginDecision(record.id, record.origin),
    /** Paid gate (entitlements/access.ts): price, lock state, why. */
    access,
    // Flat aliases of `access` for readers that check loose fields
    // (onboarding's plugin-gating.ts): paid / priceLabel / entitled.
    paid: access.requires.purchase,
    priceLabel: access.price?.label ?? null,
    entitled: access.loadable && access.requires.purchase,
    /** Newer version in the registry this host can run (cached check), else null. */
    updateAvailable: update?.updateAvailable ? (update.latestVersion ?? null) : null,
    /** An auto-update is on disk and takes effect at the next gateway restart. */
    updatePendingRestart: updates.pendingRestart?.[record.id] ?? null,
    autoUpdate:
      (cfg?.plugins?.entries as Record<string, { autoUpdate?: boolean }> | undefined)?.[record.id]
        ?.autoUpdate === true,
    disabledContributions: v2
      ? contributionStates(record)
          .filter((c) => !c.enabled)
          .map((c) => c.key)
      : [],
    appearance: appearance
      ? {
          icon: appearance.values.icon,
          monogram: appearance.values.monogram,
          customized: appearance.customized,
          themes: appearance.themes,
        }
      : undefined,
  };
}

/** The Versions section of plugins.get: where it came from, updates, rollback. */
function pluginVersionsBlock(record: PluginRecord, cfg: InfinibotConfig) {
  const install = cfg.plugins?.installs?.[record.id];
  const updates = readUpdateState();
  const update = updates.plugins[record.id];
  const managed = isRegistryManaged(
    { id: record.id, version: record.version, origin: record.origin },
    cfg,
  );
  const updateCheck = !managed
    ? "This plugin was not installed as a package, so the registry does not manage its updates."
    : update?.error
      ? `Update check failed: ${update.error}`
      : !updates.checkedAt
        ? "Not checked yet."
        : update?.updateAvailable
          ? `Version ${update.latestVersion} is available.`
          : (update?.blocked ?? "Up to date.");
  return {
    current: record.version,
    source: install?.source ?? (record.origin === "bundled" ? "bundled" : record.origin),
    installedAt: install?.installedAt,
    spec: install?.spec,
    sha256: install?.sha256,
    sourceUrl: install?.sourceUrl,
    registryUrl: update?.registryUrl ?? install?.registryUrl ?? updates.registryUrl ?? undefined,
    overridesBundled: install?.overridesBundled === true,
    managed,
    checkedAt: updates.checkedAt,
    updateAvailable: update?.updateAvailable ? (update.latestVersion ?? null) : null,
    latestVersion: update?.latestVersion,
    blocked: update?.blocked,
    paid: update?.paid === true,
    changelog: update?.changelog ?? [],
    updateCheck,
    rollbackAvailable: Boolean(install?.previous),
    previousVersion: install?.previous?.version,
    autoUpdate:
      (cfg.plugins?.entries as Record<string, { autoUpdate?: boolean }> | undefined)?.[record.id]
        ?.autoUpdate === true,
    pendingRestart: updates.pendingRestart?.[record.id] ?? null,
    minHostVersion: record.minHostVersion,
  };
}

// ── config form (secrets write-only) ─────────────────────────────────────

const SECRET_NAME_RE = /(token|secret|password|passwd|api[-_]?key|private[-_]?key|credential)s?$/i;

export function secretConfigKeys(
  record: Pick<PluginRecord, "configJsonSchema" | "configUiHints">,
): string[] {
  const props = (record.configJsonSchema?.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const hints = record.configUiHints ?? {};
  return Object.keys(props).filter((key) => {
    const p = props[key] ?? {};
    return (
      hints[key]?.sensitive === true ||
      p.writeOnly === true ||
      p.format === "password" ||
      p["x-secret"] === true ||
      SECRET_NAME_RE.test(key)
    );
  });
}

export function maskPluginConfig(
  values: Record<string, unknown>,
  secretKeys: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    out[k] = secretKeys.includes(k)
      ? { __secret: true, set: v !== undefined && v !== null && v !== "" }
      : v;
  }
  for (const k of secretKeys) if (!(k in out)) out[k] = { __secret: true, set: false };
  return out;
}

/** Merge a submitted form: omitted/blank/masked secrets keep their stored value. */
export function mergePluginConfig(
  stored: Record<string, unknown>,
  submitted: Record<string, unknown>,
  secretKeys: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(submitted)) {
    const isMasked = v && typeof v === "object" && (v as { __secret?: unknown }).__secret === true;
    if (secretKeys.includes(k) && (v === undefined || v === "" || isMasked)) {
      if (stored[k] !== undefined) out[k] = stored[k];
      continue;
    }
    if (v === null && secretKeys.includes(k)) continue; // explicit clear
    if (v !== undefined) out[k] = v;
  }
  for (const k of secretKeys) if (!(k in submitted) && stored[k] !== undefined) out[k] = stored[k];
  return out;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** When the plugin's files on disk last changed (manifest mtime), ISO. */
function manifestMtime(record: Pick<PluginRecord, "manifestPath">): string | undefined {
  if (!record.manifestPath) return undefined;
  try {
    return fs.statSync(record.manifestPath).mtime.toISOString();
  } catch {
    return undefined;
  }
}

export function scheduleRestart(reason: string) {
  return scheduleGatewaySigusr1Restart({ delayMs: 400, reason });
}

// ── handlers ─────────────────────────────────────────────────────────────

export type PluginLanding = { pluginId: string; tab: string; route: string };

/**
 * The start page a plugin supplies ("clinic mode"): only when the operator
 * named the plugin in `plugins.landing`, the plugin is loaded, and its v2
 * manifest declares `contributes.landing`. Exported for tests.
 */
export function resolvePluginLanding(
  plugins: Pick<PluginRecord, "id" | "status" | "contributes">[],
  landingPluginId: string | undefined,
): PluginLanding | null {
  const id = landingPluginId?.trim();
  if (!id) return null;
  const plugin = plugins.find((p) => p.id === id);
  if (!plugin || plugin.status !== "loaded" || !plugin.contributes?.landing) return null;
  const page = plugin.contributes.pages.find((pg) => pg.tab === plugin.contributes?.landing);
  return page ? { pluginId: id, tab: page.tab, route: page.route } : null;
}

export const pluginGatewayHandlers: GatewayRequestHandlers = {
  "plugins.list": ({ respond }) => {
    const registry = getActivePluginRegistry();
    let cfg: InfinibotConfig | undefined;
    try {
      cfg = loadConfig();
    } catch {
      cfg = undefined;
    }
    const updates = readUpdateState();
    // One row per id: the active record first, overridden duplicates dropped.
    const seen = new Set<string>();
    const plugins = (registry?.plugins ?? [])
      .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
      .map((r) => summarize(r, cfg, updates));
    const landingId = cfg?.plugins?.landing;
    const landing = resolvePluginLanding(registry?.plugins ?? [], landingId);
    respond(true, {
      plugins,
      pluginApiVersion: PLUGIN_API_VERSION,
      landing,
      landingPluginId: landingId ?? null,
      updates: {
        checkedAt: updates.checkedAt,
        registryUrl: updates.registryUrl,
        error: updates.error ?? null,
        available: plugins.filter((p) => p.updateAvailable).length,
      },
    });
  },

  "plugins.get": async ({ params, respond }) => {
    const record = requireRecord(params, respond);
    if (!record) return;
    const st = getPluginHostState(record.id);
    const perms = listPermissionItems(record.permissions as Record<string, unknown> | undefined);
    const items = record.catalog?.items ?? [];
    const snapshot = await readConfigFileSnapshot();
    const install = snapshot.config.plugins?.installs?.[record.id];
    respond(true, {
      plugin: summarize(record, snapshot.config),
      homepage: record.homepage,
      listingWarnings: record.listingWarnings ?? [],
      updatedAt: install?.installedAt ?? manifestMtime(record),
      pluginApiVersion: PLUGIN_API_VERSION,
      pluginApiRange: record.pluginApiRange,
      contributions: contributionStates(record).map((c) => ({
        ...c,
        kindLabel: CONTRIBUTION_KIND_LABELS[c.kind],
        kindGroupLabel: CONTRIBUTION_KIND_PLURALS[c.kind],
      })),
      permissions: perms.map((p) => ({
        ...p,
        granted: !st.revoked.has(p.key),
        // Gated permissions start off; un-granted is "off by default", not revoked.
        defaultOff: p.category === "gated",
        dependents: items
          .filter((i) => i.requires.some((r) => r === p.key || r === p.category))
          .map((i) => i.key),
      })),
      importers: record.catalog?.importers ?? [],
      config: { hasSchema: Boolean(record.configJsonSchema), secretKeys: secretConfigKeys(record) },
      appearance: record.manifestVersion === 2 ? appearanceFor(record) : undefined,
      versions: pluginVersionsBlock(record, snapshot.config),
      data: pluginDataSummary(record.id),
      restartNotes: {
        enable:
          "Turning a plugin on or off reloads the gateway: open connections reconnect and running sub-agents are stopped.",
        config: "Saving settings reloads the plugin, which restarts the gateway.",
        uninstall: "Uninstalling reloads the gateway.",
        live: "Contribution toggles, permissions and appearance apply immediately without a restart.",
      },
    });
  },

  "plugins.setEnabled": async ({ params, respond }) => {
    const p = (params ?? {}) as { id?: unknown; enabled?: unknown };
    const id = typeof p.id === "string" ? p.id.trim() : "";
    if (!id || typeof p.enabled !== "boolean") {
      bad(respond, "expected { id, enabled: boolean }");
      return;
    }
    if (!findRecord(id)) {
      bad(respond, `unknown plugin "${id}"`);
      return;
    }
    const enabled = p.enabled;
    if (enabled) {
      // Hosted fleet: the tenant's plan and cloud availability decide first.
      const record = findRecord(id)!;
      const enabledIds = (getActivePluginRegistry()?.plugins ?? [])
        .filter((r) => r.enabled)
        .map((r) => r.id);
      const refusal = cloudPluginEnableRefusal(id, record.origin, enabledIds);
      if (refusal) {
        const cloud = cloudPluginDecision(id, record.origin);
        bad(respond, refusal, { cloud });
        return;
      }
      // Paid: refuse without the KinglyVault entitlement (or this machine's
      // owner grant). The loader enforces the same rule at boot.
      const access = pluginAccessDecision(id, { manifestAccess: record.manifestAccess });
      if (!access.loadable) {
        bad(respond, access.reason ?? "This plugin is locked.", { access });
        return;
      }
    }
    const written = await writeConfig(respond, (cfg) => setPluginEnabledInConfig(cfg, id, enabled));
    if (!written) return;
    appendPluginLog(
      id,
      "info",
      `turned ${enabled ? "on" : "off"} from Setup › Plugins (gateway restart)`,
    );
    const restart = scheduleRestart(`plugins.setEnabled ${id}=${enabled}`);
    respond(true, { ok: true, id, enabled, restart });
  },

  "plugins.contributions.set": async ({ params, respond }) => {
    const record = requireRecord(params, respond);
    if (!record) return;
    const p = params as { key?: unknown; enabled?: unknown };
    const key = typeof p.key === "string" ? p.key : "";
    if (typeof p.enabled !== "boolean")
      return bad(respond, "expected { id, key, enabled: boolean }");
    const item = record.catalog?.items.find((i) => i.key === key);
    if (!item) return bad(respond, `"${key}" is not a declared contribution of ${record.id}`);
    if (!item.toggleable)
      return bad(
        respond,
        `${CONTRIBUTION_KIND_LABELS[item.kind]} contributions can't be toggled individually`,
      );
    const enabled = p.enabled;
    const written = await writeConfig(respond, (cfg) =>
      updatePluginEntryInConfig(cfg, record.id, (e) =>
        setContributionInEntry(e, key, enabled, item.defaultEnabled !== false),
      ),
    );
    if (!written) return;
    const c = ((written.plugins?.entries?.[record.id] ?? {}) as EntryConfig).contributions as
      | { disabled?: string[]; enabled?: string[] }
      | undefined;
    setPluginHostState(record.id, {
      disabled: new Set(c?.disabled ?? []),
      enabled: new Set(c?.enabled ?? []),
    });
    if (item.kind === "service") await reconcilePluginServices(record.id);
    appendPluginLog(record.id, "info", `${item.key} turned ${enabled ? "on" : "off"} (live)`);
    respond(true, {
      ok: true,
      key,
      enabled,
      live: item.live,
      restartRequired: false,
      contributions: contributionStates(record),
    });
  },

  "plugins.permissions.set": async ({ params, respond }) => {
    const record = requireRecord(params, respond);
    if (!record) return;
    const p = params as { key?: unknown; granted?: unknown };
    const key = typeof p.key === "string" ? p.key : "";
    if (typeof p.granted !== "boolean")
      return bad(respond, "expected { id, key, granted: boolean }");
    const perms = listPermissionItems(record.permissions as Record<string, unknown> | undefined);
    if (!perms.some((x) => x.key === key))
      return bad(respond, `"${key}" is not a permission ${record.id} requested`);
    const blockedWhy = p.granted ? cloudBlockedPermissions(record.id)?.[key] : undefined;
    if (blockedWhy) return bad(respond, blockedWhy);
    const before = new Set(
      contributionStates(record)
        .filter((c) => !c.enabled)
        .map((c) => c.key),
    );
    const granted = p.granted;
    const written = await writeConfig(respond, (cfg) =>
      updatePluginEntryInConfig(cfg, record.id, (e) => setPermissionInEntry(e, key, granted)),
    );
    if (!written) return;
    const perm = ((written.plugins?.entries?.[record.id] ?? {}) as EntryConfig).permissions as
      | { revoked?: string[]; granted?: string[] }
      | undefined;
    setPluginHostState(record.id, {
      revoked: new Set(perm?.revoked ?? []),
      granted: new Set(perm?.granted ?? []),
    });
    await reconcilePluginServices(record.id);
    const states = contributionStates(record);
    const after = new Set(states.filter((c) => !c.enabled).map((c) => c.key));
    const disabledNow = [...after].filter((k) => !before.has(k));
    const enabledNow = [...before].filter((k) => !after.has(k));
    appendPluginLog(
      record.id,
      "info",
      `permission ${key} ${granted ? "granted" : "revoked"}${disabledNow.length ? `; turned off ${disabledNow.join(", ")}` : ""}`,
    );
    respond(true, {
      ok: true,
      key,
      granted,
      restartRequired: false,
      disabledNow,
      enabledNow,
      blocked: contributionsBlockedByRevokes(
        record.catalog?.items ?? [],
        getPluginHostState(record.id).revoked,
      ).map((i) => i.key),
      contributions: states,
    });
  },

  "plugins.config.get": async ({ params, respond }) => {
    const record = requireRecord(params, respond);
    if (!record) return;
    const entry = await currentEntry(record.id);
    const secretKeys = secretConfigKeys(record);
    respond(true, {
      id: record.id,
      schema: record.configJsonSchema ?? null,
      uiHints: record.configUiHints ?? {},
      values: maskPluginConfig((entry.config ?? {}) as Record<string, unknown>, secretKeys),
      secretKeys,
      restartOnSave: record.status === "loaded",
    });
  },

  "plugins.config.set": async ({ params, respond }) => {
    const record = requireRecord(params, respond);
    if (!record) return;
    const submitted = (params as { values?: unknown }).values;
    if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) {
      return bad(respond, "expected { id, values: object }");
    }
    const secretKeys = secretConfigKeys(record);
    const entry = await currentEntry(record.id);
    const merged = mergePluginConfig(
      (entry.config ?? {}) as Record<string, unknown>,
      submitted as Record<string, unknown>,
      secretKeys,
    );
    if (record.configJsonSchema) {
      const { validateJsonSchemaValue } = await import("../../plugins/schema-validator.js");
      const res = validateJsonSchemaValue({
        schema: record.configJsonSchema,
        cacheKey: `plugins.config.set:${record.id}`,
        value: merged,
      });
      if (!res.ok)
        return bad(respond, "settings don't match the plugin's schema", { errors: res.errors });
    }
    const written = await writeConfig(respond, (cfg) =>
      updatePluginEntryInConfig(cfg, record.id, (e) => ({ ...e, config: merged })),
    );
    if (!written) return;
    appendPluginLog(record.id, "info", "settings saved");
    const restart =
      record.status === "loaded" ? scheduleRestart(`plugins.config.set ${record.id}`) : undefined;
    respond(true, {
      ok: true,
      values: maskPluginConfig(merged, secretKeys),
      restartRequired: Boolean(restart),
      restart,
    });
  },

  "plugins.appearance.get": ({ params, respond }) => {
    const record = requireRecord(params, respond);
    if (!record) return;
    if (record.manifestVersion !== 2)
      return bad(respond, `${record.id} is a v1 plugin and has no appearance settings`);
    respond(true, appearanceFor(record));
  },

  "plugins.appearance.preview": ({ params, respond }) => {
    const record = requireRecord(params, respond);
    if (!record) return;
    if (record.manifestVersion !== 2)
      return bad(respond, `${record.id} is a v1 plugin and has no appearance settings`);
    const manifest = record.appearance ?? DEFAULT_APPEARANCE;
    const v = validateAppearanceOverride(manifest, (params as { appearance?: unknown }).appearance);
    if (!v.ok) return bad(respond, "invalid appearance", { errors: v.errors });
    respond(true, resolvePluginAppearance(record.id, manifest, v.value));
  },

  "plugins.appearance.set": async ({ params, respond }) => {
    const record = requireRecord(params, respond);
    if (!record) return;
    if (record.manifestVersion !== 2)
      return bad(respond, `${record.id} is a v1 plugin and has no appearance settings`);
    const manifest = record.appearance ?? DEFAULT_APPEARANCE;
    const v = validateAppearanceOverride(manifest, (params as { appearance?: unknown }).appearance);
    if (!v.ok) return bad(respond, "invalid appearance", { errors: v.errors });
    const resolved = resolvePluginAppearance(record.id, manifest, v.value);
    // Strict mode rejects the owner's own colours that fail AA; token nudges
    // (the SDK's text-safe accent) are host-side and never block a save.
    const ownFailures = resolved.adjustments.filter((a) => !a.field.includes("(token:"));
    if ((params as { strict?: unknown }).strict === true && ownFailures.length) {
      return bad(respond, "colours fail WCAG AA contrast", { adjustments: ownFailures });
    }
    const value: PluginAppearanceOverride = v.value;
    const written = await writeConfig(respond, (cfg) =>
      updatePluginEntryInConfig(cfg, record.id, (e) => ({ ...e, appearance: value })),
    );
    if (!written) return;
    setPluginHostState(record.id, { appearance: value });
    appendPluginLog(record.id, "info", "appearance updated (live)");
    respond(true, { ...resolved, restartRequired: false });
  },

  "plugins.appearance.reset": async ({ params, respond }) => {
    const record = requireRecord(params, respond);
    if (!record) return;
    const written = await writeConfig(respond, (cfg) =>
      updatePluginEntryInConfig(cfg, record.id, (e) => {
        const { appearance: _drop, ...rest } = e;
        return rest;
      }),
    );
    if (!written) return;
    setPluginHostState(record.id, { appearance: undefined });
    appendPluginLog(record.id, "info", "appearance reset to defaults (live)");
    respond(true, { ...appearanceFor(record), restartRequired: false });
  },

  "plugins.health": ({ params, respond }) => {
    const record = requireRecord(params, respond);
    if (!record) return;
    const registry = getActivePluginRegistry();
    const declaredRpc = record.contributes?.rpc.map((r) => r.method) ?? [];
    respond(true, {
      id: record.id,
      status: record.status,
      enabled: record.enabled,
      error: record.error,
      health: pluginHealth(record),
      services: listPluginServiceStates(record.id),
      sidecars: (record.catalog?.items ?? [])
        .filter((i) => i.kind === "sidecar")
        .map((i) => ({
          id: i.id,
          image: i.detail,
          status: "not-managed",
          note: "Sidecar supervision lands with Phase 0B host services.",
        })),
      rpc: {
        declared: declaredRpc.length,
        registered: record.gatewayMethods.length,
        missing: declaredRpc.filter((m) => !record.gatewayMethods.includes(m)),
      },
      httpRoutes: (registry?.httpRoutes ?? [])
        .filter((r) => r.pluginId === record.id)
        .map((r) => r.path),
      tools: record.toolNames,
      diagnostics: (registry?.diagnostics ?? []).filter((d) => d.pluginId === record.id),
      lastErrors: lastPluginErrors(record.id),
    });
  },

  "plugins.logs": ({ params, respond }) => {
    const record = requireRecord(params, respond);
    if (!record) return;
    const p = params as { limit?: unknown; level?: unknown };
    const level =
      p.level === "info" || p.level === "warn" || p.level === "error" || p.level === "debug"
        ? p.level
        : undefined;
    respond(true, {
      id: record.id,
      lines: readPluginLogs(record.id, {
        limit: typeof p.limit === "number" ? p.limit : 100,
        level,
      }),
    });
  },

  "plugins.restart": async ({ params, respond }) => {
    const record = requireRecord(params, respond);
    if (!record) return;
    if ((params as { full?: unknown }).full === true) {
      appendPluginLog(record.id, "info", "full reload requested (gateway restart)");
      respond(true, {
        ok: true,
        mode: "gateway",
        restart: scheduleRestart(`plugins.restart ${record.id}`),
      });
      return;
    }
    if (record.status !== "loaded") return bad(respond, `${record.id} isn't running`);
    const services = await reconcilePluginServices(record.id, { restart: true });
    appendPluginLog(record.id, "info", `restarted ${services.length} service(s) in place`);
    respond(true, { ok: true, mode: "services", services });
  },

  "plugins.data.export": ({ params, respond }) => {
    const record = requireRecord(params, respond);
    if (!record) return;
    try {
      respond(true, exportPluginData(record.id));
    } catch (err) {
      bad(respond, err instanceof Error ? err.message : String(err));
    }
  },

  "plugins.data.import": async (opts) => {
    const { params, respond } = opts;
    const record = requireRecord(params, respond);
    if (!record) return;
    const p = params as { importer?: unknown; payload?: unknown; bundle?: unknown; mode?: unknown };
    if (typeof p.importer === "string") {
      const importer = record.catalog?.importers.find((i) => i.id === p.importer);
      if (!importer) return bad(respond, `${record.id} declares no importer "${p.importer}"`);
      const states = contributionStates(record);
      if (
        states.some(
          (s) =>
            (s.key === `importer:${importer.id}` || s.key === `rpc:${importer.method}`) &&
            !s.enabled,
        )
      ) {
        return bad(respond, `importer "${importer.id}" is turned off`);
      }
      const handler = getActivePluginRegistry()?.gatewayHandlers[importer.method];
      if (!handler || record.status !== "loaded")
        return bad(respond, `${record.id} must be on to run its importer`);
      appendPluginLog(record.id, "info", `import via ${importer.method}`);
      await handler({
        ...opts,
        req: {
          ...opts.req,
          method: importer.method,
          params: (p.payload ?? {}) as Record<string, unknown>,
        },
        params: (p.payload ?? {}) as Record<string, unknown>,
      });
      return;
    }
    try {
      const res = importPluginData(record.id, p.bundle, p.mode === "replace" ? "replace" : "merge");
      appendPluginLog(record.id, "info", `data imported (${res.written} files)`);
      respond(true, { ok: true, ...res, data: pluginDataSummary(record.id) });
    } catch (err) {
      bad(respond, err instanceof Error ? err.message : String(err));
    }
  },

  "plugins.data.clear": ({ params, respond }) => {
    const record = requireRecord(params, respond);
    if (!record) return;
    if ((params as { confirm?: unknown }).confirm !== record.id) {
      return bad(respond, `confirm by passing { confirm: "${record.id}" }`);
    }
    const res = clearPluginData(record.id);
    appendPluginLog(record.id, "warn", `data cleared (${res.bytes} bytes)`);
    respond(true, { ok: true, ...res, data: pluginDataSummary(record.id) });
  },

  "plugins.uninstall": async ({ params, respond }) => {
    const record = requireRecord(params, respond);
    if (!record) return;
    const keepData = (params as { keepData?: unknown }).keepData !== false;
    const snapshot = await readConfigFileSnapshot();
    const install = snapshot.config.plugins?.installs?.[record.id];
    const extensionsDir = path.join(CONFIG_DIR, "extensions");
    const removablePkg =
      install?.installPath && isInside(path.resolve(install.installPath), extensionsDir)
        ? path.resolve(install.installPath)
        : undefined;
    const written = await writeConfig(respond, (cfg) => {
      const plugins = { ...cfg.plugins };
      const entries = { ...plugins.entries } as Record<string, EntryConfig>;
      const ownPath = (p: string) => {
        const abs = path.resolve(p);
        return abs === record.source || abs === path.dirname(record.source);
      };
      const loadPaths = plugins.load?.paths ?? [];
      if (record.origin === "bundled" || install) {
        // Bundled plugins ship with InfiniBot and default to off once their
        // entry is gone; installed ones are removed from disk below.
        delete entries[record.id];
      } else if (loadPaths.some(ownPath)) {
        // Loaded via plugins.load.paths: drop that path (it points at this
        // plugin only), so it's no longer discovered at all.
        plugins.load = { ...plugins.load, paths: loadPaths.filter((p) => !ownPath(p)) };
        delete entries[record.id];
      } else {
        // Workspace/global plugins would be discovered again: pin them off.
        entries[record.id] = { enabled: false };
      }
      if (plugins.installs?.[record.id]) {
        const installs = { ...plugins.installs };
        delete installs[record.id];
        plugins.installs = installs;
      }
      if (Array.isArray(plugins.allow))
        plugins.allow = plugins.allow.filter((a) => a !== record.id);
      plugins.entries = entries;
      return { ...cfg, plugins } as InfinibotConfig;
    });
    if (!written) return;
    if (removablePkg) fs.rmSync(removablePkg, { recursive: true, force: true });
    if (install) {
      // Package installs: drop the kept rollback copy.
      removePackageVersions(record.id);
    }
    const data = keepData ? pluginDataSummary(record.id) : clearPluginData(record.id);
    clearPluginHostState(record.id);
    appendPluginLog(record.id, "warn", `uninstalled (${keepData ? "data kept" : "data removed"})`);
    const restart =
      record.status === "loaded" || removablePkg
        ? scheduleRestart(`plugins.uninstall ${record.id}`)
        : undefined;
    respond(true, {
      ok: true,
      id: record.id,
      keepData,
      removedPackage: Boolean(removablePkg),
      bundled: record.origin === "bundled",
      data,
      restartRequired: Boolean(restart),
      restart,
    });
  },

  /**
   * Make a plugin's declared landing page the start page (`id`), or restore
   * the normal dashboard (`id: null`). Admin-only (unclassified). Takes
   * effect on the next plugins.list — no restart (config-reload rule).
   */
  "plugins.setLanding": async ({ params, respond }) => {
    const raw = (params ?? {}) as { id?: unknown };
    const id = typeof raw.id === "string" ? raw.id.trim() : raw.id === null ? null : undefined;
    if (id === undefined || id === "") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "expected { id: string | null }"),
      );
      return;
    }
    if (id !== null) {
      const plugin = (getActivePluginRegistry()?.plugins ?? []).find((pl) => pl.id === id);
      if (!plugin?.contributes?.landing) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `plugin "${id}" does not declare a landing page`),
        );
        return;
      }
    }
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "config file is invalid"));
      return;
    }
    const plugins = { ...snapshot.config.plugins } as Record<string, unknown>;
    if (id === null) delete plugins.landing;
    else plugins.landing = id;
    const validated = validateConfigObjectWithPlugins({
      ...snapshot.config,
      plugins,
    } as InfinibotConfig);
    if (!validated.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid config"));
      return;
    }
    await writeConfigFile(validated.config);
    respond(true, { ok: true, landing: id });
  },
};
