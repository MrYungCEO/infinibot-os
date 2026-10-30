import type { PluginRegistry } from "./registry.js";
import { setActivePluginMediaProviders } from "../media-generation/registry.js";

const createEmptyRegistry = (): PluginRegistry => ({
  plugins: [],
  tools: [],
  hooks: [],
  typedHooks: [],
  channels: [],
  providers: [],
  mediaProviders: [],
  gatewayHandlers: {},
  httpHandlers: [],
  httpRoutes: [],
  cliRegistrars: [],
  services: [],
  commands: [],
  panelKinds: [],
  diagnostics: [],
});

const REGISTRY_STATE = Symbol.for("infinibot.pluginRegistryState");

type RegistryState = {
  registry: PluginRegistry | null;
  key: string | null;
};

const state: RegistryState = (() => {
  const globalState = globalThis as typeof globalThis & {
    [REGISTRY_STATE]?: RegistryState;
  };
  if (!globalState[REGISTRY_STATE]) {
    globalState[REGISTRY_STATE] = {
      registry: createEmptyRegistry(),
      key: null,
    };
  }
  return globalState[REGISTRY_STATE] as RegistryState;
})();

export function setActivePluginRegistry(registry: PluginRegistry, cacheKey?: string) {
  state.registry = registry;
  state.key = cacheKey ?? null;
  setActivePluginMediaProviders(registry.mediaProviders ?? []);
}

export function getActivePluginRegistry(): PluginRegistry | null {
  return state.registry;
}

export function requireActivePluginRegistry(): PluginRegistry {
  if (!state.registry) {
    state.registry = createEmptyRegistry();
  }
  return state.registry;
}

export function getActivePluginRegistryKey(): string | null {
  return state.key;
}

/**
 * Scope a loaded v2 plugin declared for one of its RPC methods
 * (manifest contributes.rpc). Undeclared/v1 methods return undefined and
 * stay admin-only.
 */
export function resolvePluginMethodScope(method: string): "read" | "write" | "admin" | undefined {
  for (const plugin of state.registry?.plugins ?? []) {
    if (plugin.status !== "loaded" || !plugin.contributes) continue;
    const decl = plugin.contributes.rpc.find(
      (r) => r.method === method || r.aliases?.includes(method),
    );
    if (decl) return decl.scope;
    // Aliases only count once wired (registered) — a skipped alias stays admin-only.
    const alias = plugin.contributes.rpcAliases?.find((a) => a.method === method);
    if (alias && plugin.gatewayMethods.includes(method)) return alias.scope;
  }
  return undefined;
}

/** Chat panel kinds registered by loaded v2 plugins (see registerPanelKind). */
export function getPluginPanelKinds(): NonNullable<PluginRegistry["panelKinds"]> {
  return state.registry?.panelKinds ?? [];
}

/** Gateway handlers registered by loaded plugins (for in-process dispatch). */
export function getPluginGatewayHandlers(): PluginRegistry["gatewayHandlers"] {
  return state.registry?.gatewayHandlers ?? {};
}
