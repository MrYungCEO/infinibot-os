import type { AnyAgentTool } from "../agents/tools/common.js";
import type { ChannelDock } from "../channels/dock.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlers,
} from "../gateway/server-methods/types.js";
import { registerInternalHook } from "../hooks/internal-hooks.js";
import { resolveUserPath } from "../utils.js";
import type {
  InfiniBotPluginApi,
  InfiniBotPluginSetupCheck,
  InfiniBotPluginChannelRegistration,
  InfiniBotPluginCliRegistrar,
  InfiniBotPluginCommandDefinition,
  InfiniBotPluginHttpHandler,
  InfiniBotPluginHttpRouteHandler,
  InfiniBotPluginHookOptions,
  ProviderPlugin,
  InfiniBotPluginService,
  InfiniBotPluginToolContext,
  InfiniBotPluginToolFactory,
  PluginConfigUiHint,
  PluginDiagnostic,
  PluginLogger,
  PluginOrigin,
  PluginKind,
  PluginHookName,
  PluginHookHandlerMap,
  PluginHookRegistration as TypedPluginHookRegistration,
} from "./types.js";
import { registerPluginCommand } from "./commands.js";
import type { PluginUiContribution } from "./manifest.js";
import type { PluginContributes, PluginPermissions } from "./manifest-v2.js";
import type { PluginAppearanceManifest } from "./appearance.js";
import type { ContributionItem, PluginImporter } from "./contributions.js";
import type { PluginListing } from "./listing.js";
import { withPluginLogCapture } from "./plugin-logs.js";
import type { VoiceProvider } from "../gateway/voice/provider-registry.js";
import type { PanelKindDef } from "../chat-panels/types.js";
import type { SetupCheckDefinition } from "../gateway/setup-status/types.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { HookEntry } from "../hooks/types.js";
import path from "node:path";
import { normalizePluginHttpPath } from "./http-path.js";
import {
  cloudSelfHostOnlyHttp,
  cloudSelfHostOnlyMethod,
  cloudSelfHostOnlyTool,
  selfHostOnlyMessage,
} from "../saas/fleet-plugins.js";
import { ErrorCodes, errorShape } from "../gateway/protocol/schema/error-codes.js";
import type { MediaGenerationProvider } from "../media-generation/types.js";

export type PluginToolRegistration = {
  pluginId: string;
  factory: InfiniBotPluginToolFactory;
  names: string[];
  optional: boolean;
  source: string;
};

export type PluginCliRegistration = {
  pluginId: string;
  register: InfiniBotPluginCliRegistrar;
  commands: string[];
  source: string;
};

export type PluginHttpRegistration = {
  pluginId: string;
  handler: InfiniBotPluginHttpHandler;
  source: string;
};

export type PluginHttpRouteRegistration = {
  pluginId?: string;
  path: string;
  handler: InfiniBotPluginHttpRouteHandler;
  source?: string;
  /** True only for manifest-declared browser-importable UI entry modules. */
  publicAsset?: boolean;
  /** Declared in manifest contributes.selfAuthHttp: served before the shared-secret gate. */
  selfAuth?: boolean;
};

export type PluginChannelRegistration = {
  pluginId: string;
  plugin: ChannelPlugin;
  dock?: ChannelDock;
  source: string;
};

export type PluginProviderRegistration = {
  pluginId: string;
  provider: ProviderPlugin;
  source: string;
};

export type PluginVoiceProviderRegistration = {
  pluginId: string;
  provider: VoiceProvider;
  source: string;
};

export type PluginMediaProviderRegistration = {
  pluginId: string;
  provider: MediaGenerationProvider;
  source: string;
};

export type PluginHookRegistration = {
  pluginId: string;
  entry: HookEntry;
  events: string[];
  source: string;
};

export type PluginServiceRegistration = {
  pluginId: string;
  service: InfiniBotPluginService;
  source: string;
  /** Owning plugin's contribution catalog (set by startPluginServices). */
  catalog?: PluginRecord["catalog"];
};

export type PluginCommandRegistration = {
  pluginId: string;
  command: InfiniBotPluginCommandDefinition;
  source: string;
};

export type PluginRecord = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  kind?: PluginKind;
  source: string;
  origin: PluginOrigin;
  workspaceDir?: string;
  enabled: boolean;
  status: "loaded" | "disabled" | "error";
  error?: string;
  toolNames: string[];
  hookNames: string[];
  channelIds: string[];
  providerIds: string[];
  gatewayMethods: string[];
  cliCommands: string[];
  services: string[];
  commands: string[];
  httpHandlers: number;
  hookCount: number;
  configSchema: boolean;
  configUiHints?: Record<string, PluginConfigUiHint>;
  configJsonSchema?: Record<string, unknown>;
  ui?: PluginUiContribution;
  /** 2 for declared-capability manifests; undefined for legacy v1. */
  manifestVersion?: 2;
  contributes?: PluginContributes;
  permissions?: PluginPermissions;
  publisher?: string;
  license?: string;
  homepage?: string;
  /** Manifest engines["infinibot-plugin-api"] range (v2). */
  pluginApiRange?: string;
  /** Oldest InfiniBot that runs the plugin (manifest `minHostVersion`). */
  minHostVersion?: string;
  /** Manifest `update.registryUrl`: registry this plugin's updates come from. */
  updateRegistryUrl?: string;
  appearance?: PluginAppearanceManifest;
  catalog?: { items: ContributionItem[]; importers: PluginImporter[] };
  /** Plugin folder (listing assets are served from here, declared files only). */
  rootDir?: string;
  manifestPath?: string;
  /** Optional store listing (listing.ts) + fields dropped as malformed. */
  listing?: PluginListing;
  listingWarnings?: string[];
  /** Manifest `access` block (paid / desktop-only, restrict-only; entitlements/access.ts). */
  manifestAccess?: unknown;
  /** Paid / desktop gate decision made at load time. */
  access?: import("./entitlements/access.js").PluginAccessDecision;
  /** Store category: listing.category or inferred (derivePluginCategory). */
  category?: string;
  /** Channels / model providers the manifest declares (known even when off). */
  declaredChannels?: string[];
  declaredProviders?: string[];
};

export type PluginRegistry = {
  plugins: PluginRecord[];
  tools: PluginToolRegistration[];
  hooks: PluginHookRegistration[];
  typedHooks: TypedPluginHookRegistration[];
  channels: PluginChannelRegistration[];
  providers: PluginProviderRegistration[];
  /** Voice backends (see src/gateway/voice/provider-registry.ts). Optional so
   *  hand-built registries (tests, empty registry) stay valid. */
  voiceProviders?: PluginVoiceProviderRegistration[];
  /** Media generation providers (see src/media-generation/registry.ts). Optional
   *  for the same reason as voiceProviders. */
  mediaProviders?: PluginMediaProviderRegistration[];
  gatewayHandlers: GatewayRequestHandlers;
  httpHandlers: PluginHttpRegistration[];
  httpRoutes: PluginHttpRouteRegistration[];
  cliRegistrars: PluginCliRegistration[];
  services: PluginServiceRegistration[];
  commands: PluginCommandRegistration[];
  /** Chat panel kinds contributed by v2 plugins (show_panel / chat.panel.*).
   *  Optional so registry literals built elsewhere (tests, mocks) stay valid. */
  panelKinds?: PluginPanelKindRegistration[];
  /** "Needs setup" checks from v2 plugins (api.registerSetupCheck). Optional
   *  for the same reason as panelKinds. */
  setupChecks?: PluginSetupCheckRegistration[];
  diagnostics: PluginDiagnostic[];
};

export type PluginSetupCheckRegistration = {
  pluginId: string;
  def: SetupCheckDefinition;
  source: string;
};

export type PluginPanelKindRegistration = {
  pluginId: string;
  def: PanelKindDef;
  source: string;
};

export type PluginRegistryParams = {
  logger: PluginLogger;
  coreGatewayHandlers?: GatewayRequestHandlers;
  runtime: PluginRuntime;
};

export function createPluginRegistry(registryParams: PluginRegistryParams) {
  const registry: PluginRegistry = {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    channels: [],
    providers: [],
    voiceProviders: [],
    mediaProviders: [],
    gatewayHandlers: {},
    httpHandlers: [],
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    panelKinds: [],
    setupChecks: [],
    diagnostics: [],
  };
  const coreGatewayMethods = new Set(Object.keys(registryParams.coreGatewayHandlers ?? {}));

  const pushDiagnostic = (diag: PluginDiagnostic) => {
    registry.diagnostics.push(diag);
  };

  const registerTool = (
    record: PluginRecord,
    tool: AnyAgentTool | InfiniBotPluginToolFactory,
    opts?: { name?: string; names?: string[]; optional?: boolean },
  ) => {
    const names = opts?.names ?? (opts?.name ? [opts.name] : []);
    const optional = opts?.optional === true;
    const baseFactory: InfiniBotPluginToolFactory =
      typeof tool === "function" ? tool : (_ctx: InfiniBotPluginToolContext) => tool;
    // InfiniBot Cloud: withhold tools of features that stay self-hosted only
    // (src/saas/fleet-plugins.ts selfHostOnly). Checked per resolve; no-op off-fleet.
    const factory: InfiniBotPluginToolFactory = (ctx) => {
      const out = baseFactory(ctx);
      if (!out) return out;
      const keep = (t: AnyAgentTool) => !cloudSelfHostOnlyTool(record.id, t.name);
      if (Array.isArray(out)) return out.filter(keep);
      return keep(out) ? out : null;
    };

    if (typeof tool !== "function") {
      names.push(tool.name);
    }

    const normalized = names.map((name) => name.trim()).filter(Boolean);
    // v2: every tool name the plugin can state up front must be declared in
    // contributes.tools (factories without names are checked when resolved).
    if (record.contributes) {
      const undeclared = normalized.filter((n) => !record.contributes!.tools.includes(n));
      if (undeclared.length > 0) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `tool not declared in manifest contributes.tools: ${undeclared.join(", ")}`,
        });
        return;
      }
    }
    if (normalized.length > 0) {
      record.toolNames.push(...normalized);
    }
    registry.tools.push({
      pluginId: record.id,
      factory,
      names: normalized,
      optional,
      source: record.source,
    });
  };

  /**
   * v2 only: a chat panel kind for show_panel. The kind must be declared in
   * contributes.panels and may only call the plugin's own READ-scoped RPCs
   * (chat.panel.* are read methods and must never proxy writes).
   */
  const registerPanelKind = (record: PluginRecord, def: PanelKindDef) => {
    const fail = (message: string) =>
      pushDiagnostic({ level: "error", pluginId: record.id, source: record.source, message });
    if (!record.contributes) {
      fail("registerPanelKind requires a manifest v2 plugin");
      return;
    }
    if (!record.contributes.panels.includes(def.id)) {
      fail(`panel kind not declared in manifest contributes.panels: ${def.id}`);
      return;
    }
    const readMethods = new Set(
      record.contributes.rpc.filter((r) => r.scope === "read").map((r) => r.method),
    );
    const bad = def.methods.filter((m) => !readMethods.has(m));
    if (bad.length > 0) {
      fail(
        `panel kind ${def.id} may only call the plugin's read-scoped rpc (not: ${bad.join(", ")})`,
      );
      return;
    }
    const kinds = (registry.panelKinds ??= []);
    if (kinds.some((p) => p.def.id === def.id)) {
      fail(`panel kind already registered: ${def.id}`);
      return;
    }
    kinds.push({ pluginId: record.id, def, source: record.source });
  };

  /**
   * v2 only: a "needs setup" check. The id must be declared in
   * contributes.setupChecks, which fixes its title, pages and default action;
   * the plugin supplies only the (cheap, local) evaluate function.
   */
  const registerSetupCheck = (record: PluginRecord, check: InfiniBotPluginSetupCheck) => {
    const fail = (message: string) =>
      pushDiagnostic({ level: "error", pluginId: record.id, source: record.source, message });
    if (!record.contributes) {
      fail("registerSetupCheck requires a manifest v2 plugin");
      return;
    }
    const decl = record.contributes.setupChecks?.find((c) => c.id === check?.id);
    if (!decl) {
      fail(`setup check not declared in manifest contributes.setupChecks: ${String(check?.id)}`);
      return;
    }
    if (typeof check.evaluate !== "function") {
      fail(`setup check ${decl.id} needs an evaluate function`);
      return;
    }
    const checks = (registry.setupChecks ??= []);
    if (checks.some((c) => c.def.id === decl.id)) {
      fail(`setup check already registered: ${decl.id}`);
      return;
    }
    checks.push({
      pluginId: record.id,
      source: record.source,
      def: {
        id: decl.id,
        title: decl.title,
        tabs: [...decl.tabs],
        ...(decl.action ? { action: decl.action } : {}),
        ...(typeof check.priority === "number" ? { priority: check.priority } : {}),
        ...(check.localOnly ? { localOnly: true } : {}),
        evaluate: async (ctx) => {
          const out = await check.evaluate(ctx);
          // A plugin may retarget its action, but only to its own pages.
          if (
            out?.action &&
            !(
              out.action.tab &&
              decl.tabs
                .concat(record.contributes?.pages.map((p) => p.tab) ?? [])
                .includes(out.action.tab)
            )
          ) {
            const { action: _drop, ...rest } = out;
            return rest;
          }
          return out;
        },
      },
    });
  };

  const registerHook = (
    record: PluginRecord,
    events: string | string[],
    handler: Parameters<typeof registerInternalHook>[1],
    opts: InfiniBotPluginHookOptions | undefined,
    config: InfiniBotPluginApi["config"],
  ) => {
    const eventList = Array.isArray(events) ? events : [events];
    const normalizedEvents = eventList.map((event) => event.trim()).filter(Boolean);
    const entry = opts?.entry ?? null;
    const name = entry?.hook.name ?? opts?.name?.trim();
    if (!name) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: "hook registration missing name",
      });
      return;
    }

    const description = entry?.hook.description ?? opts?.description ?? "";
    const hookEntry: HookEntry = entry
      ? {
          ...entry,
          hook: {
            ...entry.hook,
            name,
            description,
            source: "infinibot-plugin",
            pluginId: record.id,
          },
          metadata: {
            ...entry.metadata,
            events: normalizedEvents,
          },
        }
      : {
          hook: {
            name,
            description,
            source: "infinibot-plugin",
            pluginId: record.id,
            filePath: record.source,
            baseDir: path.dirname(record.source),
            handlerPath: record.source,
          },
          frontmatter: {},
          metadata: { events: normalizedEvents },
          invocation: { enabled: true },
        };

    record.hookNames.push(name);
    registry.hooks.push({
      pluginId: record.id,
      entry: hookEntry,
      events: normalizedEvents,
      source: record.source,
    });

    const hookSystemEnabled = config?.hooks?.internal?.enabled === true;
    if (!hookSystemEnabled || opts?.register === false) {
      return;
    }

    for (const event of normalizedEvents) {
      registerInternalHook(event, handler);
    }
  };

  const registerGatewayMethod = (
    record: PluginRecord,
    method: string,
    handler: GatewayRequestHandler,
  ) => {
    const trimmed = method.trim();
    if (!trimmed) return;
    // v2: only methods declared in contributes.rpc may be registered.
    if (
      record.contributes &&
      !record.contributes.rpc.some((r) => r.method === trimmed || r.aliases?.includes(trimmed))
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `gateway method not declared in manifest contributes.rpc: ${trimmed}`,
      });
      return;
    }
    if (coreGatewayMethods.has(trimmed) || registry.gatewayHandlers[trimmed]) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `gateway method already registered: ${trimmed}`,
      });
      return;
    }
    // InfiniBot Cloud: a self-host-only feature's methods answer UNAVAILABLE
    // on a tenant Machine (src/saas/fleet-plugins.ts selfHostOnly).
    const guarded: GatewayRequestHandler = (opts) => {
      const feature = cloudSelfHostOnlyMethod(record.id, trimmed);
      if (feature) {
        opts.respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, selfHostOnlyMessage(feature), {
            details: { selfHostOnly: true, feature: feature.feature },
          }),
        );
        return;
      }
      return handler(opts);
    };
    registry.gatewayHandlers[trimmed] = guarded;
    record.gatewayMethods.push(trimmed);
  };

  /**
   * v2: after register(), point each declared legacy alias at the handler the
   * plugin registered for its target. Never shadows a core or another
   * plugin's method; a missing target just skips the alias (with a warning).
   */
  const wireRpcAliases = (record: PluginRecord) => {
    for (const alias of record.contributes?.rpcAliases ?? []) {
      const target = registry.gatewayHandlers[alias.target];
      if (!target || !record.gatewayMethods.includes(alias.target)) {
        pushDiagnostic({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: `rpc alias ${alias.method} skipped: target ${alias.target} was not registered`,
        });
        continue;
      }
      if (coreGatewayMethods.has(alias.method) || registry.gatewayHandlers[alias.method]) {
        pushDiagnostic({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: `rpc alias ${alias.method} skipped: method already registered`,
        });
        continue;
      }
      registry.gatewayHandlers[alias.method] = target;
      record.gatewayMethods.push(alias.method);
    }
  };

  const registerHttpHandler = (record: PluginRecord, handler: InfiniBotPluginHttpHandler) => {
    // v2: catch-all handlers would bypass the declared route list.
    if (record.contributes) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message:
          "v2 plugins must use registerHttpRoute with declared routes, not registerHttpHandler",
      });
      return;
    }
    record.httpHandlers += 1;
    registry.httpHandlers.push({
      pluginId: record.id,
      handler,
      source: record.source,
    });
  };

  const registerHttpRoute = (
    record: PluginRecord,
    params: {
      path: string;
      handler: InfiniBotPluginHttpRouteHandler;
      publicAsset?: boolean;
    },
  ) => {
    const normalizedPath = normalizePluginHttpPath(params.path);
    if (!normalizedPath) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: "http route registration missing path",
      });
      return;
    }
    // v2: only routes declared in contributes.http may be registered.
    if (record.contributes && !record.contributes.http.includes(normalizedPath)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `http route not declared in manifest contributes.http: ${normalizedPath}`,
      });
      return;
    }
    if (registry.httpRoutes.some((entry) => entry.path === normalizedPath)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `http route already registered: ${normalizedPath}`,
      });
      return;
    }
    const declaredUiAsset =
      record.ui?.entry === normalizedPath ||
      record.contributes?.pages.some((page) => page.entry === normalizedPath) === true;
    if (params.publicAsset && !declaredUiAsset) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `public http asset must be a manifest-declared UI entry: ${normalizedPath}`,
      });
      return;
    }
    record.httpHandlers += 1;
    const routeHandler: InfiniBotPluginHttpRouteHandler = (req, res) => {
      const feature = cloudSelfHostOnlyHttp(record.id, normalizedPath);
      if (feature) {
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "self_host_only", message: selfHostOnlyMessage(feature) }));
        return;
      }
      return params.handler(req, res);
    };
    registry.httpRoutes.push({
      pluginId: record.id,
      path: normalizedPath,
      handler: routeHandler,
      source: record.source,
      publicAsset: params.publicAsset === true,
      ...(record.contributes?.selfAuthHttp?.includes(normalizedPath) ? { selfAuth: true } : {}),
    });
  };

  const registerChannel = (
    record: PluginRecord,
    registration: InfiniBotPluginChannelRegistration | ChannelPlugin,
  ) => {
    const normalized =
      typeof (registration as InfiniBotPluginChannelRegistration).plugin === "object"
        ? (registration as InfiniBotPluginChannelRegistration)
        : { plugin: registration as ChannelPlugin };
    const plugin = normalized.plugin;
    const id = typeof plugin?.id === "string" ? plugin.id.trim() : String(plugin?.id ?? "").trim();
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "channel registration missing id",
      });
      return;
    }
    record.channelIds.push(id);
    registry.channels.push({
      pluginId: record.id,
      plugin,
      dock: normalized.dock,
      source: record.source,
    });
  };

  const registerProvider = (record: PluginRecord, provider: ProviderPlugin) => {
    const id = typeof provider?.id === "string" ? provider.id.trim() : "";
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "provider registration missing id",
      });
      return;
    }
    const existing = registry.providers.find((entry) => entry.provider.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `provider already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    record.providerIds.push(id);
    registry.providers.push({
      pluginId: record.id,
      provider,
      source: record.source,
    });
  };

  const registerVoiceProvider = (record: PluginRecord, provider: VoiceProvider) => {
    const id = typeof provider?.id === "string" ? provider.id.trim() : "";
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "voice provider registration missing id",
      });
      return;
    }
    // v2: only voice providers declared in contributes.voiceProviders.
    if (record.contributes && !(record.contributes.voiceProviders ?? []).includes(id)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `voice provider not declared in manifest contributes.voiceProviders: ${id}`,
      });
      return;
    }
    const list = (registry.voiceProviders ??= []);
    const existing = list.find((entry) => entry.provider.id === id);
    if (existing || id === "local") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `voice provider already registered: ${id} (${existing?.pluginId ?? "builtin"})`,
      });
      return;
    }
    list.push({ pluginId: record.id, provider, source: record.source });
  };

  const registerMediaProvider = (record: PluginRecord, provider: MediaGenerationProvider) => {
    const id = typeof provider?.id === "string" ? provider.id.trim() : "";
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "media provider registration missing id",
      });
      return;
    }
    const list = (registry.mediaProviders ??= []);
    const existing = list.find((entry) => entry.provider.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `media provider already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    record.providerIds.push(id);
    list.push({ pluginId: record.id, provider, source: record.source });
  };

  const registerCli = (
    record: PluginRecord,
    registrar: InfiniBotPluginCliRegistrar,
    opts?: { commands?: string[] },
  ) => {
    const commands = (opts?.commands ?? []).map((cmd) => cmd.trim()).filter(Boolean);
    record.cliCommands.push(...commands);
    registry.cliRegistrars.push({
      pluginId: record.id,
      register: registrar,
      commands,
      source: record.source,
    });
  };

  const registerService = (record: PluginRecord, service: InfiniBotPluginService) => {
    const id = service.id.trim();
    if (!id) return;
    record.services.push(id);
    registry.services.push({
      pluginId: record.id,
      service,
      source: record.source,
    });
  };

  const registerCommand = (record: PluginRecord, command: InfiniBotPluginCommandDefinition) => {
    const name = command.name.trim();
    if (!name) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "command registration missing name",
      });
      return;
    }

    // Register with the plugin command system (validates name and checks for duplicates)
    const result = registerPluginCommand(record.id, command);
    if (!result.ok) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `command registration failed: ${result.error}`,
      });
      return;
    }

    record.commands.push(name);
    registry.commands.push({
      pluginId: record.id,
      command,
      source: record.source,
    });
  };

  const registerTypedHook = <K extends PluginHookName>(
    record: PluginRecord,
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number },
  ) => {
    record.hookCount += 1;
    registry.typedHooks.push({
      pluginId: record.id,
      hookName,
      handler,
      priority: opts?.priority,
      source: record.source,
    } as TypedPluginHookRegistration);
  };

  const normalizeLogger = (logger: PluginLogger): PluginLogger => ({
    info: logger.info,
    warn: logger.warn,
    error: logger.error,
    debug: logger.debug,
  });

  const createApi = (
    record: PluginRecord,
    params: {
      config: InfiniBotPluginApi["config"];
      pluginConfig?: Record<string, unknown>;
    },
  ): InfiniBotPluginApi => {
    return {
      id: record.id,
      name: record.name,
      version: record.version,
      description: record.description,
      source: record.source,
      config: params.config,
      pluginConfig: params.pluginConfig,
      runtime: registryParams.runtime,
      logger: normalizeLogger(withPluginLogCapture(record.id, registryParams.logger)),
      registerTool: (tool, opts) => registerTool(record, tool, opts),
      registerHook: (events, handler, opts) =>
        registerHook(record, events, handler, opts, params.config),
      registerHttpHandler: (handler) => registerHttpHandler(record, handler),
      registerHttpRoute: (params) => registerHttpRoute(record, params),
      registerChannel: (registration) => registerChannel(record, registration),
      registerProvider: (provider) => registerProvider(record, provider),
      registerVoiceProvider: (provider) => registerVoiceProvider(record, provider),
      registerMediaProvider: (provider) => registerMediaProvider(record, provider),
      registerGatewayMethod: (method, handler) => registerGatewayMethod(record, method, handler),
      registerCli: (registrar, opts) => registerCli(record, registrar, opts),
      registerService: (service) => registerService(record, service),
      registerCommand: (command) => registerCommand(record, command),
      registerPanelKind: (def) => registerPanelKind(record, def),
      registerSetupCheck: (check) => registerSetupCheck(record, check),
      resolvePath: (input: string) => resolveUserPath(input),
      on: (hookName, handler, opts) => registerTypedHook(record, hookName, handler, opts),
    };
  };

  return {
    registry,
    createApi,
    pushDiagnostic,
    wireRpcAliases,
    registerTool,
    registerChannel,
    registerProvider,
    registerVoiceProvider,
    registerMediaProvider,
    registerGatewayMethod,
    registerCli,
    registerService,
    registerCommand,
    registerHook,
    registerTypedHook,
  };
}
