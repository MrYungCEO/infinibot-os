import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

import { loadConfig } from "../../config/config.js";
import { createPluginRegistry, type PluginRecord } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import {
  clearBuiltinVoiceProvidersForTests,
  configuredVoiceBackend,
  isVoiceProviderError,
  listVoiceProviders,
  registerBuiltinVoiceProvider,
  resolveVoiceProvider,
  VoiceProviderError,
  type VoiceCapability,
  type VoiceProvider,
} from "./provider-registry.js";

function fakeProvider(id: string, capabilities: VoiceCapability[]): VoiceProvider {
  return {
    id,
    label: id,
    capabilities,
    status: async () => ({ ready: true }),
    createRealtimeSession: async (req) => ({
      url: `wss://${id}`,
      token: "t",
      room: req.room ?? "r",
      participant: "p",
    }),
  };
}

function record(id: string, voiceProviders?: string[]): PluginRecord {
  return {
    id,
    name: id,
    source: `/x/${id}/index.ts`,
    origin: "bundled",
    enabled: true,
    status: "loaded",
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
    configSchema: false,
    ...(voiceProviders
      ? {
          manifestVersion: 2 as const,
          contributes: { nav: [], pages: [], rpc: [], http: [], services: [], voiceProviders },
        }
      : {}),
  } as PluginRecord;
}

function pluginRegistryWith(
  providers: Array<{ pluginId: string; provider: VoiceProvider; declared?: string[] }>,
) {
  const reg = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {} },
    runtime: {} as PluginRuntime,
  });
  for (const p of providers) {
    const api = reg.createApi(record(p.pluginId, p.declared ?? [p.provider.id]), { config: {} });
    api.registerVoiceProvider(p.provider);
  }
  return reg;
}

describe("voice provider registry", () => {
  beforeEach(() => {
    clearBuiltinVoiceProvidersForTests();
    registerBuiltinVoiceProvider(fakeProvider("local", ["realtime", "stt", "tts", "wakeWord"]));
    setActivePluginRegistry(pluginRegistryWith([]).registry);
    vi.mocked(loadConfig).mockReturnValue({});
  });
  afterEach(() => {
    setActivePluginRegistry(pluginRegistryWith([]).registry);
  });

  it("serves every capability from the built-in local provider when no plugin is loaded", () => {
    for (const cap of ["realtime", "stt", "tts", "wakeWord"] as const) {
      const r = resolveVoiceProvider(cap, "auto");
      expect(r.provider?.id).toBe("local");
      expect(r.fellBack).toBe(false);
    }
  });

  it("auto stays on local voice even when a configured cloud plugin (Robovoice) is loaded", () => {
    const reg = pluginRegistryWith([
      { pluginId: "robovoice", provider: fakeProvider("robovoice", ["realtime"]) },
    ]);
    setActivePluginRegistry(reg.registry);
    for (const cap of ["realtime", "stt", "tts", "wakeWord"] as const) {
      expect(resolveVoiceProvider(cap, "auto").provider?.id).toBe("local");
    }
    // Cloud voice is opt-in: only an explicit selection uses it.
    expect(resolveVoiceProvider("realtime", "robovoice").provider?.id).toBe("robovoice");
    expect(resolveVoiceProvider("realtime", "robovoice").source).toEqual({ pluginId: "robovoice" });
  });

  it("auto never routes to Robovoice automatically, even when local voice is missing", () => {
    clearBuiltinVoiceProvidersForTests();
    setActivePluginRegistry(
      pluginRegistryWith([
        { pluginId: "robovoice", provider: fakeProvider("robovoice", ["realtime"]) },
      ]).registry,
    );
    // No silent cloud fallback: the UI shows the local fix ("Set up voice for me").
    expect(resolveVoiceProvider("realtime", "auto").provider).toBeNull();
    expect(resolveVoiceProvider("realtime", "local").provider).toBeNull();
    // An explicit choice still works.
    expect(resolveVoiceProvider("realtime", "robovoice").provider?.id).toBe("robovoice");
  });

  it("auto skips a loaded plugin provider that isn't configured yet", () => {
    const unconfigured = { ...fakeProvider("robovoice", ["realtime"]), configured: () => false };
    setActivePluginRegistry(
      pluginRegistryWith([{ pluginId: "robovoice", provider: unconfigured }]).registry,
    );
    expect(resolveVoiceProvider("realtime", "auto").provider?.id).toBe("local");
    // Explicit selection still honours it (so the user sees its setup error).
    expect(resolveVoiceProvider("realtime", "robovoice").provider?.id).toBe("robovoice");
  });

  it("explicit local wins over a loaded plugin", () => {
    setActivePluginRegistry(
      pluginRegistryWith([
        { pluginId: "robovoice", provider: fakeProvider("robovoice", ["realtime"]) },
      ]).registry,
    );
    expect(resolveVoiceProvider("realtime", "local").provider?.id).toBe("local");
  });

  it("falls back to local (and says so) when the selected plugin provider is not loaded", () => {
    const r = resolveVoiceProvider("realtime", "robovoice");
    expect(r.provider?.id).toBe("local");
    expect(r.fellBack).toBe(true);
    expect(r.reason).toMatch(/not available/);
  });

  it("uses local for a capability the selected provider lacks without flagging a fallback", () => {
    setActivePluginRegistry(
      pluginRegistryWith([
        { pluginId: "robovoice", provider: fakeProvider("robovoice", ["realtime"]) },
      ]).registry,
    );
    const r = resolveVoiceProvider("stt", "robovoice");
    expect(r.provider?.id).toBe("local");
    expect(r.fellBack).toBe(false);
  });

  it("reports no provider when nothing can serve a capability", () => {
    clearBuiltinVoiceProvidersForTests();
    const r = resolveVoiceProvider("realtime", "auto");
    expect(r.provider).toBeNull();
  });

  it("lists built-ins first and never lets a plugin shadow a built-in id", () => {
    const reg = pluginRegistryWith([
      { pluginId: "robovoice", provider: fakeProvider("robovoice", ["realtime"]) },
    ]);
    setActivePluginRegistry(reg.registry);
    expect(listVoiceProviders().map((r) => r.provider.id)).toEqual(["local", "robovoice"]);
  });

  it("reads voice.backend from config, defaulting to auto", () => {
    expect(configuredVoiceBackend()).toBe("auto");
    vi.mocked(loadConfig).mockReturnValue({ voice: { backend: "local" } } as never);
    expect(configuredVoiceBackend()).toBe("local");
  });

  it("recognises VoiceProviderError across module copies by name + status", () => {
    const e = new VoiceProviderError("no credits", 402, "insufficient_balance");
    expect(isVoiceProviderError(e)).toBe(true);
    const foreign = Object.assign(new Error("x"), { name: "VoiceProviderError", status: 503 });
    expect(isVoiceProviderError(foreign)).toBe(true);
    expect(isVoiceProviderError(new Error("plain"))).toBe(false);
  });
});

describe("plugin registerVoiceProvider", () => {
  it("rejects v2 plugins registering an undeclared voice provider", () => {
    const reg = pluginRegistryWith([
      { pluginId: "sneaky", provider: fakeProvider("sneaky-voice", ["realtime"]), declared: [] },
    ]);
    expect(reg.registry.voiceProviders).toHaveLength(0);
    expect(reg.registry.diagnostics.map((d) => d.message).join("\n")).toMatch(
      /not declared in manifest contributes.voiceProviders: sneaky-voice/,
    );
  });

  it("rejects a plugin claiming the built-in 'local' id and duplicate ids", () => {
    const reg = pluginRegistryWith([
      { pluginId: "a", provider: fakeProvider("local", ["realtime"]) },
      { pluginId: "b", provider: fakeProvider("dup", ["realtime"]) },
      { pluginId: "c", provider: fakeProvider("dup", ["realtime"]) },
    ]);
    expect(reg.registry.voiceProviders?.map((r) => `${r.pluginId}:${r.provider.id}`)).toEqual([
      "b:dup",
    ]);
    expect(reg.registry.diagnostics.filter((d) => d.level === "error")).toHaveLength(2);
  });
});

describe("hostedVoiceBackend (InfiniBot Cloud)", () => {
  it("maps auto/local to Robovoice only on a fleet tenant Machine", async () => {
    const { hostedVoiceBackend } = await import("./provider-registry.js");
    const fleet = { FLEET_TENANT_ID: "t_1" } as NodeJS.ProcessEnv;
    expect(hostedVoiceBackend("auto", fleet)).toBe("robovoice");
    expect(hostedVoiceBackend("local", fleet)).toBe("robovoice");
    expect(hostedVoiceBackend("other", fleet)).toBe("other");
    expect(hostedVoiceBackend("auto", {} as NodeJS.ProcessEnv)).toBe("auto");
    expect(hostedVoiceBackend("local", {} as NodeJS.ProcessEnv)).toBe("local");
  });
});
