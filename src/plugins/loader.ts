import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

import type { InfinibotConfig } from "../config/config.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { discoverInfiniBotPlugins } from "./discovery.js";
import { loadPluginManifestRegistry, type PluginManifestRecord } from "./manifest-registry.js";
import { compareSemver, hostSatisfiesMin, isValidSemver } from "./packages/semver.js";
import { VERSION } from "../version.js";
import {
  normalizePluginsConfig,
  resolveEnableState,
  resolveMemorySlotDecision,
  type NormalizedPluginsConfig,
} from "./config-state.js";
import { initializeGlobalHookRunner } from "./hook-runner-global.js";
import { ensureHostModuleFallback } from "./host-modules.js";
import { clearPluginCommands } from "./commands.js";
import { createPluginRegistry, type PluginRecord, type PluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";
import { setActivePluginRegistry } from "./runtime.js";
import { syncPluginHostStateFromConfig } from "./host-state.js";
import { appendPluginLog } from "./plugin-logs.js";
import { derivePluginCategory } from "./listing.js";
import { entitlementCacheStamp } from "./entitlements/store.js";
import { PLUGIN_API_VERSION, satisfiesRange } from "./manifest-v2.js";
import { validateJsonSchemaValue } from "./schema-validator.js";
import type {
  InfiniBotPluginDefinition,
  InfiniBotPluginModule,
  PluginDiagnostic,
  PluginLogger,
} from "./types.js";

export type PluginLoadResult = PluginRegistry;

export type PluginLoadOptions = {
  config?: InfinibotConfig;
  workspaceDir?: string;
  logger?: PluginLogger;
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  cache?: boolean;
  mode?: "full" | "validate";
};

const registryCache = new Map<string, PluginRegistry>();

const defaultLogger = () => createSubsystemLogger("plugins");

const resolvePluginSdkAlias = (): string | null => {
  try {
    const modulePath = fileURLToPath(import.meta.url);
    const isDistRuntime = modulePath.split(path.sep).includes("dist");
    const preferDist = process.env.VITEST || process.env.NODE_ENV === "test" || isDistRuntime;
    let cursor = path.dirname(modulePath);
    for (let i = 0; i < 6; i += 1) {
      const srcCandidate = path.join(cursor, "src", "plugin-sdk", "index.ts");
      const distCandidate = path.join(cursor, "dist", "plugin-sdk", "index.js");
      const orderedCandidates = preferDist
        ? [distCandidate, srcCandidate]
        : [srcCandidate, distCandidate];
      for (const candidate of orderedCandidates) {
        if (fs.existsSync(candidate)) return candidate;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  } catch {
    // ignore
  }
  return null;
};

function buildCacheKey(params: {
  workspaceDir?: string;
  plugins: NormalizedPluginsConfig;
}): string {
  const workspaceKey = params.workspaceDir ? resolveUserPath(params.workspaceDir) : "";
  // Paid gate inputs: a purchase, revoke or owner grant must reload on restart.
  const accessKey = entitlementCacheStamp();
  return `${workspaceKey}::${accessKey}::${JSON.stringify(params.plugins)}`;
}

function validatePluginConfig(params: {
  schema?: Record<string, unknown>;
  cacheKey?: string;
  value?: unknown;
}): { ok: boolean; value?: Record<string, unknown>; errors?: string[] } {
  const schema = params.schema;
  if (!schema) {
    return { ok: true, value: params.value as Record<string, unknown> | undefined };
  }
  const cacheKey = params.cacheKey ?? JSON.stringify(schema);
  const result = validateJsonSchemaValue({
    schema,
    cacheKey,
    value: params.value ?? {},
  });
  if (result.ok) {
    return { ok: true, value: params.value as Record<string, unknown> | undefined };
  }
  return { ok: false, errors: result.errors };
}

function resolvePluginModuleExport(moduleExport: unknown): {
  definition?: InfiniBotPluginDefinition;
  register?: InfiniBotPluginDefinition["register"];
} {
  const resolved =
    moduleExport &&
    typeof moduleExport === "object" &&
    "default" in (moduleExport as Record<string, unknown>)
      ? (moduleExport as { default: unknown }).default
      : moduleExport;
  if (typeof resolved === "function") {
    return {
      register: resolved as InfiniBotPluginDefinition["register"],
    };
  }
  if (resolved && typeof resolved === "object") {
    const def = resolved as InfiniBotPluginDefinition;
    const register = def.register ?? def.activate;
    return { definition: def, register };
  }
  return {};
}

function createPluginRecord(params: {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  source: string;
  origin: PluginRecord["origin"];
  workspaceDir?: string;
  enabled: boolean;
  configSchema: boolean;
}): PluginRecord {
  return {
    id: params.id,
    name: params.name ?? params.id,
    description: params.description,
    version: params.version,
    source: params.source,
    origin: params.origin,
    workspaceDir: params.workspaceDir,
    enabled: params.enabled,
    status: params.enabled ? "loaded" : "disabled",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    providerIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpHandlers: 0,
    hookCount: 0,
    configSchema: params.configSchema,
    configUiHints: undefined,
    configJsonSchema: undefined,
  };
}

/**
 * A plugin record carrying everything the manifest declares (no code loaded).
 * The loader starts every plugin from this; the package installer uses it to
 * list a just-installed (still off) plugin without a gateway restart.
 */
export function buildPluginRecordFromManifest(
  manifestRecord: PluginManifestRecord,
  params: {
    source: string;
    origin: PluginRecord["origin"];
    workspaceDir?: string;
    enabled: boolean;
  },
): PluginRecord {
  const record = createPluginRecord({
    id: manifestRecord.id,
    name: manifestRecord.name ?? manifestRecord.id,
    description: manifestRecord.description,
    version: manifestRecord.version,
    source: params.source,
    origin: params.origin,
    workspaceDir: params.workspaceDir,
    enabled: params.enabled,
    configSchema: Boolean(manifestRecord.configSchema),
  });
  record.kind = manifestRecord.kind;
  record.configUiHints = manifestRecord.configUiHints;
  record.configJsonSchema = manifestRecord.configSchema;
  record.ui = manifestRecord.ui;
  record.rootDir = manifestRecord.rootDir;
  record.manifestPath = manifestRecord.manifestPath;
  record.listing = manifestRecord.listing;
  record.listingWarnings = manifestRecord.listingWarnings;
  record.manifestAccess = manifestRecord.access;
  record.declaredChannels = manifestRecord.channels;
  record.declaredProviders = manifestRecord.providers;
  record.minHostVersion = manifestRecord.minHostVersion;
  record.updateRegistryUrl = manifestRecord.update?.registryUrl;
  record.category = derivePluginCategory({
    listing: manifestRecord.listing,
    channels: manifestRecord.channels,
    providers: manifestRecord.providers,
    kind: manifestRecord.kind,
    pages: manifestRecord.v2?.contributes.pages.length ?? (manifestRecord.ui ? 1 : 0),
  });
  if (manifestRecord.v2) {
    record.manifestVersion = 2;
    record.contributes = manifestRecord.v2.contributes;
    record.permissions = manifestRecord.v2.permissions;
    record.publisher = manifestRecord.v2.publisher;
    record.license = manifestRecord.v2.license;
    record.homepage = manifestRecord.v2.homepage;
    record.pluginApiRange = manifestRecord.v2.engines.pluginApi;
    record.appearance = manifestRecord.v2.appearance;
    record.catalog = manifestRecord.v2.catalog;
  }
  return record;
}

/**
 * Installed package vs the copy that ships with InfiniBot: the NEWER version
 * wins (ties go to the installed one). Returns the root dirs that lose, with
 * why — so a host upgrade that ships a newer bundled plugin is not held back
 * by an older installed package, and a newer package overrides the bundle.
 */
export function supersededPluginRoots(
  records: Pick<PluginManifestRecord, "id" | "origin" | "rootDir" | "version">[],
): Map<string, string> {
  const out = new Map<string, string>();
  const bundled = new Map(records.filter((r) => r.origin === "bundled").map((r) => [r.id, r]));
  for (const r of records) {
    if (r.origin !== "global") continue;
    const b = bundled.get(r.id);
    if (!b || !isValidSemver(b.version) || !isValidSemver(r.version)) continue;
    if (compareSemver(b.version, r.version) > 0) {
      out.set(r.rootDir, `superseded by the newer bundled version ${b.version}`);
    }
  }
  return out;
}

/**
 * Forget every cached module under a plugin's folder. jiti keeps loaded
 * modules in Node's require cache keyed by file path, so without this an
 * updated package would keep running its previous code until the process
 * exits. Returns how many modules were dropped.
 */
export function evictPluginModuleCache(rootDir: string): number {
  const cache = createRequire(import.meta.url).cache;
  const prefix = path.resolve(rootDir) + path.sep;
  let dropped = 0;
  for (const key of Object.keys(cache)) {
    if (key.startsWith(prefix)) {
      delete cache[key];
      dropped += 1;
    }
  }
  return dropped;
}

function pushDiagnostics(diagnostics: PluginDiagnostic[], append: PluginDiagnostic[]) {
  diagnostics.push(...append);
}

export function loadInfiniBotPlugins(options: PluginLoadOptions = {}): PluginRegistry {
  const cfg = options.config ?? {};
  const logger = options.logger ?? defaultLogger();
  const validateOnly = options.mode === "validate";
  const normalized = normalizePluginsConfig(cfg.plugins);
  const cacheKey = buildCacheKey({
    workspaceDir: options.workspaceDir,
    plugins: normalized,
  });
  const cacheEnabled = options.cache !== false;
  // Hot per-plugin choices (contribution toggles, revoked permissions,
  // appearance) aren't part of the cache key: they apply without a reload.
  syncPluginHostStateFromConfig(cfg.plugins);
  if (cacheEnabled) {
    const cached = registryCache.get(cacheKey);
    if (cached) {
      setActivePluginRegistry(cached, cacheKey);
      return cached;
    }
  }

  // Clear previously registered plugin commands before reloading
  clearPluginCommands();

  const runtime = createPluginRuntime();
  const { registry, createApi, wireRpcAliases } = createPluginRegistry({
    logger,
    runtime,
    coreGatewayHandlers: options.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
  });

  const discovery = discoverInfiniBotPlugins({
    workspaceDir: options.workspaceDir,
    extraPaths: normalized.loadPaths,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    config: cfg,
    workspaceDir: options.workspaceDir,
    cache: options.cache,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  pushDiagnostics(registry.diagnostics, manifestRegistry.diagnostics);

  const pluginSdkAlias = resolvePluginSdkAlias();
  // Packages installed under <state>/extensions resolve host dependencies as a last resort.
  ensureHostModuleFallback();
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
    ...(pluginSdkAlias
      ? {
          alias: {
            "infinibot/plugin-sdk": pluginSdkAlias,
          },
        }
      : {}),
  });

  const manifestByRoot = new Map(
    manifestRegistry.plugins.map((record) => [record.rootDir, record]),
  );

  const superseded = supersededPluginRoots(manifestRegistry.plugins);
  const supersededRecords: PluginRecord[] = [];
  const seenIds = new Map<string, PluginRecord["origin"]>();
  const memorySlot = normalized.slots.memory;
  let selectedMemoryPluginId: string | null = null;
  let memorySlotMatched = false;

  for (const candidate of discovery.candidates) {
    const manifestRecord = manifestByRoot.get(candidate.rootDir);
    if (!manifestRecord) {
      continue;
    }
    const pluginId = manifestRecord.id;
    const supersededWhy = superseded.get(candidate.rootDir);
    if (supersededWhy) {
      const record = buildPluginRecordFromManifest(manifestRecord, {
        source: candidate.source,
        origin: candidate.origin,
        workspaceDir: candidate.workspaceDir,
        enabled: false,
      });
      record.status = "disabled";
      record.error = supersededWhy;
      // Listed after the winner, like every other overridden duplicate.
      supersededRecords.push(record);
      continue;
    }
    const existingOrigin = seenIds.get(pluginId);
    if (existingOrigin) {
      const record = createPluginRecord({
        id: pluginId,
        name: manifestRecord.name ?? pluginId,
        description: manifestRecord.description,
        version: manifestRecord.version,
        source: candidate.source,
        origin: candidate.origin,
        workspaceDir: candidate.workspaceDir,
        enabled: false,
        configSchema: Boolean(manifestRecord.configSchema),
      });
      record.status = "disabled";
      record.error = `overridden by ${existingOrigin} plugin`;
      registry.plugins.push(record);
      continue;
    }

    const enableState = resolveEnableState(pluginId, candidate.origin, normalized, {
      manifestAccess: manifestRecord.access,
    });
    const entry = normalized.entries[pluginId];
    const record = buildPluginRecordFromManifest(manifestRecord, {
      source: candidate.source,
      origin: candidate.origin,
      workspaceDir: candidate.workspaceDir,
      enabled: enableState.enabled,
    });

    if (!enableState.enabled) {
      record.status = "disabled";
      record.error = enableState.reason;
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }

    if (!hostSatisfiesMin(VERSION, manifestRecord.minHostVersion)) {
      record.status = "error";
      record.error = `requires InfiniBot ${manifestRecord.minHostVersion} or newer (this is ${VERSION})`;
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: record.error,
      });
      continue;
    }

    if (
      manifestRecord.v2 &&
      !satisfiesRange(PLUGIN_API_VERSION, manifestRecord.v2.engines.pluginApi)
    ) {
      record.status = "error";
      record.error = `requires plugin API ${manifestRecord.v2.engines.pluginApi} (host provides ${PLUGIN_API_VERSION})`;
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: record.error,
      });
      continue;
    }

    if (!manifestRecord.configSchema) {
      record.status = "error";
      record.error = "missing config schema";
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: record.error,
      });
      continue;
    }

    // A package can be updated or rolled back while the gateway process
    // stays up (in-process restart): drop its cached modules so the files now
    // on disk are what runs.
    if (candidate.origin === "global" && normalized.packageInstalls.includes(pluginId)) {
      evictPluginModuleCache(candidate.rootDir);
    }

    let mod: InfiniBotPluginModule | null = null;
    try {
      mod = jiti(candidate.source) as InfiniBotPluginModule;
    } catch (err) {
      logger.error(`[plugins] ${record.id} failed to load from ${record.source}: ${String(err)}`);
      record.status = "error";
      record.error = String(err);
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `failed to load plugin: ${String(err)}`,
      });
      continue;
    }

    const resolved = resolvePluginModuleExport(mod);
    const definition = resolved.definition;
    const register = resolved.register;

    if (definition?.id && definition.id !== record.id) {
      registry.diagnostics.push({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `plugin id mismatch (config uses "${record.id}", export uses "${definition.id}")`,
      });
    }

    record.name = definition?.name ?? record.name;
    record.description = definition?.description ?? record.description;
    record.version = definition?.version ?? record.version;
    const manifestKind = record.kind as string | undefined;
    const exportKind = definition?.kind as string | undefined;
    if (manifestKind && exportKind && exportKind !== manifestKind) {
      registry.diagnostics.push({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `plugin kind mismatch (manifest uses "${manifestKind}", export uses "${exportKind}")`,
      });
    }
    record.kind = definition?.kind ?? record.kind;

    if (record.kind === "memory" && memorySlot === record.id) {
      memorySlotMatched = true;
    }

    const memoryDecision = resolveMemorySlotDecision({
      id: record.id,
      kind: record.kind,
      slot: memorySlot,
      selectedId: selectedMemoryPluginId,
    });

    if (!memoryDecision.enabled) {
      record.enabled = false;
      record.status = "disabled";
      record.error = memoryDecision.reason;
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }

    if (memoryDecision.selected && record.kind === "memory") {
      selectedMemoryPluginId = record.id;
    }

    const validatedConfig = validatePluginConfig({
      schema: manifestRecord.configSchema,
      cacheKey: manifestRecord.schemaCacheKey,
      value: entry?.config,
    });

    if (!validatedConfig.ok) {
      logger.error(`[plugins] ${record.id} invalid config: ${validatedConfig.errors?.join(", ")}`);
      record.status = "error";
      record.error = `invalid config: ${validatedConfig.errors?.join(", ")}`;
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: record.error,
      });
      continue;
    }

    if (validateOnly) {
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }

    if (typeof register !== "function") {
      logger.error(`[plugins] ${record.id} missing register/activate export`);
      record.status = "error";
      record.error = "plugin export missing register/activate";
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: record.error,
      });
      continue;
    }

    const api = createApi(record, {
      config: cfg,
      pluginConfig: validatedConfig.value,
    });

    try {
      const result = register(api);
      if (result && typeof (result as Promise<void>).then === "function") {
        registry.diagnostics.push({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: "plugin register returned a promise; async registration is ignored",
        });
      }
      if (record.contributes) {
        wireRpcAliases(record);
        for (const decl of record.contributes.rpc) {
          if (!record.gatewayMethods.includes(decl.method)) {
            registry.diagnostics.push({
              level: "warn",
              pluginId: record.id,
              source: record.source,
              message: `declared rpc method was not registered: ${decl.method}`,
            });
          }
          for (const alias of decl.aliases ?? []) {
            if (!record.gatewayMethods.includes(alias)) {
              registry.diagnostics.push({
                level: "warn",
                pluginId: record.id,
                source: record.source,
                message: `declared RPC alias was not registered: ${alias}`,
              });
            }
          }
        }
      }
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
    } catch (err) {
      logger.error(
        `[plugins] ${record.id} failed during register from ${record.source}: ${String(err)}`,
      );
      record.status = "error";
      record.error = String(err);
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin failed during register: ${String(err)}`,
      });
    }
  }

  registry.plugins.push(...supersededRecords);

  if (typeof memorySlot === "string" && !memorySlotMatched) {
    registry.diagnostics.push({
      level: "warn",
      message: `memory slot plugin not found or not marked as memory: ${memorySlot}`,
    });
  }

  for (const diag of registry.diagnostics) {
    if (diag.pluginId)
      appendPluginLog(diag.pluginId, diag.level === "error" ? "error" : "warn", diag.message);
  }
  for (const record of registry.plugins) {
    if (record.status === "loaded") appendPluginLog(record.id, "info", `loaded (${record.origin})`);
  }

  if (cacheEnabled) {
    registryCache.set(cacheKey, registry);
  }
  setActivePluginRegistry(registry, cacheKey);
  initializeGlobalHookRunner(registry);
  return registry;
}
