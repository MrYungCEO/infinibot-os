import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildContributionCatalog } from "./contributions.js";
import {
  pluginAliasTarget,
  pluginMethodBlockedReason,
  resetPluginHostStateForTests,
  syncPluginHostStateFromConfig,
} from "./host-state.js";
import { parseManifestV2 } from "./manifest-v2.js";
import type { PluginRegistry } from "./registry.js";
import { setActivePluginRegistry } from "./runtime.js";

// HOST-API-NEEDS #18: a legacy alias (contributes.rpcAliases, rpc[].aliases)
// must pass the same owner toggle / `requires` permission gates as its target.

function createEmptyPluginRegistry(): PluginRegistry {
  return { plugins: [], gatewayHandlers: {}, mediaProviders: [] } as unknown as PluginRegistry;
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "extensions/infinitrade/infinibot.plugin.json"), "utf8"),
) as Record<string, unknown>;

const TARGET = "infinitrade.tradelocker.place";
const ALIAS = "tradelocker.place";

function loadInfinitradeRecord(extra?: { rpcDeclAlias?: boolean }) {
  const raw = structuredClone(MANIFEST) as any;
  if (extra?.rpcDeclAlias) {
    raw.contributes.rpc.push({
      method: "infinitrade.demo.order",
      scope: "write",
      aliases: ["legacydemo.order"],
      requires: ["gated:orders"],
    });
  }
  const parsed = parseManifestV2("infinitrade", raw);
  if (!parsed.ok) throw new Error(parsed.error);
  const registry = createEmptyPluginRegistry();
  const methods = [
    TARGET,
    ALIAS,
    "infinitrade.journal.list",
    "journal.list",
    ...(extra?.rpcDeclAlias ? ["infinitrade.demo.order", "legacydemo.order"] : []),
  ];
  registry.plugins.push({
    id: "infinitrade",
    name: "Infinitrade",
    source: "test",
    origin: "bundled",
    enabled: true,
    status: "loaded",
    gatewayMethods: methods,
    contributes: parsed.fields.contributes,
    permissions: raw.permissions,
    catalog: buildContributionCatalog(raw),
  } as any);
  setActivePluginRegistry(registry);
}

describe("rpc aliases inherit their target's gates", () => {
  beforeEach(() => resetPluginHostStateForTests());
  afterEach(() => {
    resetPluginHostStateForTests();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("manifest: the target requires gated:orders and the alias points at it", () => {
    const rpc = (MANIFEST.contributes as any).rpc.find((r: any) => r.method === TARGET);
    expect(rpc.requires).toContain("gated:orders");
    expect(
      (MANIFEST.contributes as any).rpcAliases.find((a: any) => a.method === ALIAS)?.target,
    ).toBe(TARGET);
  });

  it("refuses the aliased order method without gated:orders (same as the target)", () => {
    loadInfinitradeRecord();
    syncPluginHostStateFromConfig({ entries: { infinitrade: {} } });
    expect(pluginAliasTarget({ contributes: undefined }, ALIAS)).toBe(ALIAS);
    expect(pluginMethodBlockedReason(TARGET)).toMatch(/turned off/);
    expect(pluginMethodBlockedReason(ALIAS)).toMatch(/turned off/);
    // Read aliases are unaffected.
    expect(pluginMethodBlockedReason("journal.list")).toBeNull();
  });

  it("allows the alias once the owner grants gated:orders (and secrets stay granted)", () => {
    loadInfinitradeRecord();
    syncPluginHostStateFromConfig({
      entries: { infinitrade: { permissions: { granted: ["gated:orders"] } } },
    });
    expect(pluginMethodBlockedReason(TARGET)).toBeNull();
    expect(pluginMethodBlockedReason(ALIAS)).toBeNull();
  });

  it("an owner toggle on the target switches the alias off too", () => {
    loadInfinitradeRecord();
    syncPluginHostStateFromConfig({
      entries: {
        infinitrade: {
          permissions: { granted: ["gated:orders"] },
          contributions: { disabled: [`rpc:${TARGET}`] },
        },
      },
    });
    expect(pluginMethodBlockedReason(ALIAS)).toMatch(/turned off/);
  });

  it("rpc[].aliases names are gated like their declared method", () => {
    loadInfinitradeRecord({ rpcDeclAlias: true });
    syncPluginHostStateFromConfig({ entries: { infinitrade: {} } });
    expect(pluginMethodBlockedReason("legacydemo.order")).toMatch(/turned off/);
  });

  it("the gateway dispatcher refuses the aliased order RPC without the permission", async () => {
    loadInfinitradeRecord();
    syncPluginHostStateFromConfig({ entries: { infinitrade: {} } });
    const { handleGatewayRequest } = await import("../gateway/server-methods.js");
    let called = false;
    const run = async () => {
      let res: any;
      await handleGatewayRequest({
        req: { type: "req", id: "1", method: ALIAS, params: {} },
        client: { connect: { role: "operator", scopes: ["operator.admin"] } },
        isWebchatConnect: () => false,
        context: {},
        extraHandlers: {
          [ALIAS]: ({ respond }: any) => {
            called = true;
            respond(true, { placed: true });
          },
        },
        respond: (ok: boolean, payload?: unknown, error?: any) => {
          res = { ok, payload, error };
        },
      } as any);
      return res;
    };
    const refused = await run();
    expect(refused.ok).toBe(false);
    expect(refused.error.message).toMatch(/turned off/);
    expect(called).toBe(false);

    syncPluginHostStateFromConfig({
      entries: { infinitrade: { permissions: { granted: ["gated:orders"] } } },
    });
    const allowed = await run();
    expect(allowed.ok).toBe(true);
    expect(called).toBe(true);
  });
});
