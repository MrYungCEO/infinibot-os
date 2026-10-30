/**
 * Plugin update engine — the one standard for first-party and third-party
 * plugins alike.
 *
 *  - `checkPluginUpdates` asks the registry which installed plugins have a
 *    newer version this host can run, and caches the answer (the Plugins page
 *    badge reads the cache; it never blocks on the network).
 *  - `fetchRegistryPackage` + `prepareRegistryInstall` download a version and
 *    hand it to the package installer with the checksum the registry
 *    published, so marketplace installs and updates share every safety check
 *    with zip imports.
 *  - `runAutoUpdates` applies updates for plugins whose owner turned
 *    auto-update on — never when the new version asks for new permissions.
 *
 * Trust rules: a plugin that ships with InfiniBot is only ever updated from a
 * registry entry marked first-party; an installed package is only updated by
 * an entry from the same publisher.
 */

import type { InfinibotConfig } from "../../config/config.js";
import { isFleetTenantMachine } from "../../saas/fleet-plugins.js";
import { VERSION } from "../../version.js";
import {
  commitPluginPackage,
  inspectPluginPackage,
  isPackageInstall,
  type CommitResult,
  type ExistingPlugin,
  type PackageInspection,
} from "./install.js";
import {
  createRegistryClient,
  DEFAULT_PLUGIN_REGISTRY_URL,
  normalizeRegistryUrl,
  PaymentRequiredError,
  REGISTRY_URL_ENV,
  resolveRegistryUrl,
  type RegistryClient,
  type RegistryEntry,
  type RegistryFetch,
  type RegistryPluginDetail,
  type RegistryVersion,
} from "./registry-client.js";
import { compareSemver, hostSatisfiesMin, isValidSemver } from "./semver.js";
import {
  readUpdateState,
  resolvePackagePaths,
  writeUpdateState,
  type PackagePaths,
  type PluginUpdateInfo,
  type PluginUpdateState,
} from "./store.js";
import { PackageError } from "./zip-read.js";

/** What the update engine needs to know about one discovered plugin. */
export type InstalledPluginRef = {
  id: string;
  version?: string;
  origin: "bundled" | "global" | "workspace" | "config";
  publisher?: string;
  /** Manifest `update.registryUrl`, when the plugin names its own registry. */
  updateRegistryUrl?: string;
  loaded?: boolean;
};

export type UpdateContext = {
  config: InfinibotConfig;
  env?: NodeJS.ProcessEnv;
  hostVersion?: string;
  paths?: PackagePaths;
  fetchImpl?: RegistryFetch;
  resolveExisting?: (id: string) => ExistingPlugin[];
  now?: () => Date;
};

/**
 * Which registry a plugin's updates come from. On a hosted fleet Machine the
 * config and the plugin are tenant-controlled, so only the platform registry
 * (env or default) is ever used.
 */
export function registryUrlForPlugin(
  plugin: Pick<InstalledPluginRef, "id" | "updateRegistryUrl">,
  ctx: Pick<UpdateContext, "config" | "env">,
): string {
  const env = ctx.env ?? process.env;
  if (isFleetTenantMachine(env)) {
    return normalizeRegistryUrl(env[REGISTRY_URL_ENV]?.trim() || DEFAULT_PLUGIN_REGISTRY_URL);
  }
  const recorded = ctx.config.plugins?.installs?.[plugin.id]?.registryUrl;
  const own = plugin.updateRegistryUrl ?? recorded;
  if (own) {
    try {
      return normalizeRegistryUrl(own);
    } catch {
      /* fall through to the default */
    }
  }
  return resolveRegistryUrl(ctx.config, env);
}

/** The marketplace registry for browsing (same fleet rule as above). */
export function marketplaceRegistryUrl(ctx: Pick<UpdateContext, "config" | "env">): string {
  const env = ctx.env ?? process.env;
  if (isFleetTenantMachine(env)) {
    return normalizeRegistryUrl(env[REGISTRY_URL_ENV]?.trim() || DEFAULT_PLUGIN_REGISTRY_URL);
  }
  return resolveRegistryUrl(ctx.config, env);
}

/** Is this plugin updatable through the registry at all? */
export function isRegistryManaged(plugin: InstalledPluginRef, config: InfinibotConfig): boolean {
  if (plugin.origin === "bundled") return true;
  if (plugin.origin === "global") return isPackageInstall(config, plugin.id);
  return false;
}

/** Null when `entry` may update `plugin`; otherwise why not. */
export function updateTrustRefusal(
  plugin: InstalledPluginRef,
  entry: RegistryEntry,
): string | null {
  if (plugin.origin === "bundled" && !entry.firstParty) {
    return "the registry entry is not first-party, so it can't replace a plugin that ships with InfiniBot";
  }
  if (plugin.publisher && entry.publisher.id && plugin.publisher !== entry.publisher.id) {
    return `the registry lists a different publisher (${entry.publisher.id}) than the installed plugin (${plugin.publisher})`;
  }
  return null;
}

/** Newest version newer than `current` that this host can run, plus the newest overall. */
export function pickUpdateVersion(
  detail: Pick<
    RegistryPluginDetail,
    "version" | "sha256" | "sizeBytes" | "minHostVersion" | "versions"
  >,
  current: string | undefined,
  hostVersion: string,
): { best?: RegistryVersion; newest?: RegistryVersion; newer: RegistryVersion[] } {
  const all: RegistryVersion[] = detail.versions.length
    ? [...detail.versions]
    : [
        {
          version: detail.version,
          releasedAt: "",
          sha256: detail.sha256,
          sizeBytes: detail.sizeBytes,
          minHostVersion: detail.minHostVersion,
          changelog: "",
        },
      ];
  all.sort((a, b) => compareSemver(b.version, a.version));
  const newer = all.filter(
    (v) => !current || !isValidSemver(current) || compareSemver(v.version, current) > 0,
  );
  return {
    newest: newer[0],
    best: newer.find((v) => hostSatisfiesMin(hostVersion, v.minHostVersion)),
    newer,
  };
}

export async function checkPluginUpdates(
  plugins: InstalledPluginRef[],
  ctx: UpdateContext,
): Promise<PluginUpdateState> {
  const hostVersion = ctx.hostVersion ?? VERSION;
  const paths = ctx.paths ?? resolvePackagePaths();
  const now = (ctx.now ?? (() => new Date()))();
  const previous = readUpdateState(paths);
  const managed = plugins.filter((p) => isRegistryManaged(p, ctx.config));

  const clients = new Map<string, RegistryClient>();
  const indexes = new Map<string, Map<string, RegistryEntry> | Error>();
  const clientFor = (url: string) => {
    let c = clients.get(url);
    if (!c) {
      c = createRegistryClient({ registryUrl: url, fetchImpl: ctx.fetchImpl });
      clients.set(url, c);
    }
    return c;
  };
  const indexFor = async (url: string) => {
    let idx = indexes.get(url);
    if (!idx) {
      try {
        const res = await clientFor(url).index();
        idx = new Map(res.plugins.map((e) => [e.id, e]));
      } catch (err) {
        idx = err instanceof Error ? err : new Error(String(err));
      }
      indexes.set(url, idx);
    }
    return idx;
  };

  const results: Record<string, PluginUpdateInfo> = {};
  const mainUrl = marketplaceRegistryUrl(ctx);
  let topError: string | undefined;

  for (const plugin of managed) {
    const registryUrl = registryUrlForPlugin(plugin, ctx);
    const base: PluginUpdateInfo = {
      id: plugin.id,
      currentVersion: plugin.version,
      updateAvailable: false,
      changelog: [],
      registryUrl,
    };
    const idx = await indexFor(registryUrl);
    if (idx instanceof Error) {
      if (registryUrl === mainUrl) topError = idx.message;
      results[plugin.id] = { ...base, error: idx.message };
      continue;
    }
    const entry = idx.get(plugin.id);
    // Not listed, or a listing whose seller delivers the zip: nothing to update from here.
    if (!entry || entry.distribution === "external") continue;
    base.latestVersion = entry.version;
    base.paid = entry.pricing.model === "paid";
    if (
      plugin.version &&
      isValidSemver(plugin.version) &&
      compareSemver(entry.version, plugin.version) <= 0
    ) {
      results[plugin.id] = base;
      continue;
    }
    const refusal = updateTrustRefusal(plugin, entry);
    if (refusal) {
      results[plugin.id] = { ...base, error: refusal };
      continue;
    }
    let detail: RegistryPluginDetail;
    try {
      detail = await clientFor(registryUrl).plugin(plugin.id);
    } catch (err) {
      results[plugin.id] = { ...base, error: err instanceof Error ? err.message : String(err) };
      continue;
    }
    const pick = pickUpdateVersion(detail, plugin.version, hostVersion);
    const changelog = pick.newer
      .filter((v) => !pick.best || compareSemver(v.version, pick.best.version) <= 0)
      .map((v) => ({
        version: v.version,
        releasedAt: v.releasedAt || undefined,
        notes: v.changelog,
      }));
    if (pick.best) {
      results[plugin.id] = {
        ...base,
        latestVersion: pick.best.version,
        updateAvailable: true,
        minHostVersion: pick.best.minHostVersion,
        sha256: pick.best.sha256,
        sizeBytes: pick.best.sizeBytes,
        changelog,
        ...(pick.newest && pick.newest.version !== pick.best.version
          ? {
              blocked: `${pick.newest.version} needs InfiniBot ${pick.newest.minHostVersion} or newer; ${pick.best.version} is the newest this version can run`,
            }
          : {}),
      };
    } else if (pick.newest) {
      results[plugin.id] = {
        ...base,
        latestVersion: pick.newest.version,
        minHostVersion: pick.newest.minHostVersion,
        blocked: `${pick.newest.version} needs InfiniBot ${pick.newest.minHostVersion} or newer (this is ${hostVersion})`,
        changelog: [],
      };
    } else {
      results[plugin.id] = base;
    }
  }

  const state: PluginUpdateState = {
    checkedAt: now.toISOString(),
    registryUrl: mainUrl,
    ...(topError ? { error: topError } : {}),
    plugins: results,
    ...(previous.pendingRestart ? { pendingRestart: previous.pendingRestart } : {}),
  };
  writeUpdateState(state, paths);
  return state;
}

export type RegistryPackage = {
  buffer: Buffer;
  url: string;
  entry: RegistryPluginDetail;
  version: RegistryVersion;
  registryUrl: string;
};

/** Resolve a version in the registry and download it (402 → PaymentRequiredError). */
export async function fetchRegistryPackage(params: {
  id: string;
  version?: string;
  /** Entitlement token from the marketplace purchase page (paid plugins). Never stored. */
  token?: string;
  registryUrl: string;
  hostVersion?: string;
  currentVersion?: string;
  fetchImpl?: RegistryFetch;
}): Promise<RegistryPackage> {
  const hostVersion = params.hostVersion ?? VERSION;
  const client = createRegistryClient({
    registryUrl: params.registryUrl,
    fetchImpl: params.fetchImpl,
  });
  const entry = await client.plugin(params.id);
  let version: RegistryVersion | undefined;
  if (params.version && params.version !== "latest") {
    version =
      entry.versions.find((v) => v.version === params.version) ??
      (entry.version === params.version
        ? {
            version: entry.version,
            releasedAt: "",
            sha256: entry.sha256,
            sizeBytes: entry.sizeBytes,
            minHostVersion: entry.minHostVersion,
            changelog: "",
          }
        : undefined);
    if (!version) {
      throw new PackageError(`${params.id} ${params.version} is not in the registry`, "network");
    }
  } else {
    const pick = pickUpdateVersion(entry, undefined, hostVersion);
    version = pick.best;
    if (!version) {
      throw new PackageError(
        `${entry.name} ${pick.newest?.version ?? entry.version} needs InfiniBot ${pick.newest?.minHostVersion ?? entry.minHostVersion} or newer (this is ${hostVersion})`,
        "host",
      );
    }
  }
  if (!hostSatisfiesMin(hostVersion, version.minHostVersion)) {
    throw new PackageError(
      `${entry.name} ${version.version} needs InfiniBot ${version.minHostVersion} or newer (this is ${hostVersion})`,
      "host",
    );
  }
  const dl = await client.download(params.id, {
    version: version.version,
    token: params.token,
  });
  return { ...dl, entry, version, registryUrl: client.registryUrl };
}

/** Download from the registry and run the installer's inspection on it. */
export async function prepareRegistryInstall(
  params: { id: string; version?: string; token?: string; registryUrl?: string },
  ctx: UpdateContext,
): Promise<{ inspection: PackageInspection; pkg: RegistryPackage }> {
  const paths = ctx.paths ?? resolvePackagePaths();
  const registryUrl = params.registryUrl ?? marketplaceRegistryUrl(ctx);
  const pkg = await fetchRegistryPackage({
    id: params.id,
    version: params.version,
    token: params.token?.trim() || undefined,
    registryUrl,
    hostVersion: ctx.hostVersion,
    fetchImpl: ctx.fetchImpl,
  });
  const inspection = await inspectPluginPackage({
    buffer: pkg.buffer,
    source: {
      kind: "registry",
      registryUrl: pkg.registryUrl,
      firstParty: pkg.entry.firstParty,
      url: pkg.url,
    },
    config: ctx.config,
    expectedSha256: pkg.version.sha256,
    expectedId: params.id,
    expectedVersion: pkg.version.version,
    hostVersion: ctx.hostVersion,
    env: ctx.env,
    paths,
    resolveExisting: ctx.resolveExisting,
  });
  return { inspection, pkg };
}

export type AutoUpdateOutcome = {
  id: string;
  status: "updated" | "skipped" | "error";
  from?: string;
  to?: string;
  message: string;
};

/**
 * Apply available updates for plugins with `plugins.entries.<id>.autoUpdate`.
 * Returns the new config (caller persists it) and what happened per plugin.
 * A version asking for new permissions is never applied unattended.
 */
export async function runAutoUpdates(
  plugins: InstalledPluginRef[],
  state: PluginUpdateState,
  ctx: UpdateContext,
): Promise<{ config: InfinibotConfig; outcomes: AutoUpdateOutcome[]; commits: CommitResult[] }> {
  const paths = ctx.paths ?? resolvePackagePaths();
  let config = ctx.config;
  const outcomes: AutoUpdateOutcome[] = [];
  const commits: CommitResult[] = [];
  const entries = (config.plugins?.entries ?? {}) as Record<string, { autoUpdate?: boolean }>;
  for (const plugin of plugins) {
    if (entries[plugin.id]?.autoUpdate !== true) continue;
    const info = state.plugins[plugin.id];
    if (!info?.updateAvailable || !info.latestVersion) continue;
    try {
      const { inspection } = await prepareRegistryInstall(
        { id: plugin.id, version: info.latestVersion, registryUrl: info.registryUrl },
        { ...ctx, config },
      );
      if (inspection.newPermissions.length) {
        outcomes.push({
          id: plugin.id,
          status: "skipped",
          from: plugin.version,
          to: info.latestVersion,
          message: `${info.latestVersion} asks for new permissions (${inspection.newPermissions.join(", ")}); review it on the Plugins page`,
        });
        continue;
      }
      const commit = await commitPluginPackage(inspection, {
        config,
        acceptedPermissions: [],
        paths,
        now: ctx.now,
      });
      config = commit.config;
      commits.push(commit);
      outcomes.push({
        id: plugin.id,
        status: "updated",
        from: plugin.version,
        to: commit.version,
        message: `updated ${plugin.id} ${plugin.version ?? "?"} → ${commit.version}`,
      });
    } catch (err) {
      outcomes.push({
        id: plugin.id,
        status: err instanceof PaymentRequiredError ? "skipped" : "error",
        from: plugin.version,
        to: info.latestVersion,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { config, outcomes, commits };
}

/** Pure config transform: per-plugin auto-update switch (default off). */
export function setAutoUpdateInConfig(
  config: InfinibotConfig,
  id: string,
  auto: boolean,
): InfinibotConfig {
  const entries = { ...config.plugins?.entries } as Record<string, Record<string, unknown>>;
  const next = { ...entries[id] };
  if (auto) next.autoUpdate = true;
  else delete next.autoUpdate;
  if (Object.keys(next).length === 0) delete entries[id];
  else entries[id] = next;
  return { ...config, plugins: { ...config.plugins, entries } } as InfinibotConfig;
}
