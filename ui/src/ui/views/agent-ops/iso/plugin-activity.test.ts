import { describe, expect, it } from "vitest";

import { activityTokens, buildPluginActivityIndex, type PluginActivityListItem } from "./plugin-activity";

const PLUGINS: PluginActivityListItem[] = [
  {
    id: "infinitrade",
    name: "Infinitrade",
    status: "loaded",
    manifestVersion: 2,
    contributes: {
      pages: [{ tab: "infinitrade", route: "/infinitrade" }, { tab: "infinitrade-scanner", route: "/infinitrade/scanner" }],
      tools: ["infinitrade_market", "infinitrade_panel", { name: "infinitrade_order" }],
      rpc: [{ method: "infinitrade.orders.list" }, { method: "infinitrade.pine.get", aliases: ["aurum.pine.get"] }],
      rpcAliases: [{ method: "aurum.signal.evaluate" }],
    },
    rosterAgentIds: ["infinitrade-analyst"],
  },
  {
    id: "solatrix",
    name: "Solatrix",
    status: "loaded",
    manifestVersion: 2,
    contributes: {
      pages: [{ tab: "solatrix", route: "/solatrix" }, { tab: "solatrix-wallets", route: "/solatrix/wallets" }],
      tools: ["solana_market", "solana_portfolio", "solana_trade"],
      rpc: [{ method: "solatrix.market.price" }],
    },
  },
  {
    id: "omniclinic",
    name: "OmniClinic",
    status: "loaded",
    manifestVersion: 2,
    contributes: { pages: [{ tab: "omniclinic", route: "/omniclinic" }], tools: ["omniclinic_research"], rpc: [] },
    rosterAgentIds: ["oc-literature-scout", "oc-clinical-reasoner"],
  },
  {
    id: "products",
    name: "Products",
    status: "loaded",
    manifestVersion: 2,
    contributes: { pages: [{ tab: "products", route: "/products" }, { tab: "product-portfolio", route: "/product-portfolio" }], rpc: [{ method: "products.list" }] },
  },
  {
    id: "content-studio",
    name: "Content Studio",
    status: "loaded",
    manifestVersion: 2,
    contributes: { pages: [{ tab: "content-intel", route: "/content-intel" }], tools: ["content_intel", "script"], rpc: [{ method: "content-studio.intel.list", aliases: ["content.intel.list"] }] },
    rosterAgentIds: ["cmo", "scriptwriter"],
  },
  { id: "disabled-one", name: "Disabled", status: "disabled", manifestVersion: 2, contributes: { tools: ["ghost_tool"] } },
  { id: "legacy", name: "Legacy", status: "loaded", manifestVersion: 1, contributes: { tools: ["legacy_tool"] } },
];

const index = buildPluginActivityIndex(PLUGINS);

describe("PluginActivityIndex", () => {
  it("indexes only loaded v2 plugins", () => {
    expect(index.ids().sort()).toEqual(["content-studio", "infinitrade", "omniclinic", "products", "solatrix"]);
    expect(index.resolve({ toolKind: "ghost_tool" })).toBeNull();
    expect(index.resolve({ toolKind: "legacy_tool" })).toBeNull();
  });

  it("maps declared tool names (case-insensitive)", () => {
    expect(index.resolve({ toolKind: "solana_market" })).toBe("solatrix");
    expect(index.resolve({ toolKind: "Infinitrade_Order" })).toBe("infinitrade");
    expect(index.resolve({ toolKind: "omniclinic_research" })).toBe("omniclinic");
    expect(index.resolve({ toolKind: "script" })).toBe("content-studio");
  });

  it("maps RPC methods, aliases and namespaces mentioned in the tool label", () => {
    expect(index.resolve({ toolKind: "gateway", toolLabel: "gateway: infinitrade.orders.list" })).toBe("infinitrade");
    expect(index.resolve({ toolKind: "gateway", toolLabel: "call aurum.pine.get(ema)" })).toBe("infinitrade");
    expect(index.resolve({ toolKind: "gateway", toolLabel: "aurum.signal.evaluate" })).toBe("infinitrade");
    expect(index.resolve({ toolKind: "gateway", toolLabel: "solatrix.wallets.export" })).toBe("solatrix"); // namespace
    expect(index.resolve({ toolKind: "gateway", toolLabel: "content.intel.list" })).toBe("content-studio");
    expect(index.resolve({ toolKind: "gateway", toolLabel: "content.other.thing" })).toBeNull(); // alias ns ≠ prefix grant
  });

  it("maps page routes, longest match first", () => {
    expect(index.resolve({ route: "/infinitrade/scanner" })).toBe("infinitrade");
    expect(index.resolve({ route: "/solatrix/wallets?x=1" })).toBe("solatrix");
    expect(index.resolve({ route: "/solatrix/unknown-sub" })).toBe("solatrix");
    expect(index.resolve({ route: "/product-portfolio" })).toBe("products");
    expect(index.resolve({ route: "/productsx" })).toBeNull();
    expect(index.resolve({ text: "polish the /omniclinic research page" })).toBe("omniclinic");
  });

  it("maps explicit tags and plugin ids", () => {
    expect(index.resolve({ pluginId: "solatrix" })).toBe("solatrix");
    expect(index.resolve({ pluginId: "nope", toolKind: "solana_trade" })).toBe("solatrix");
    expect(index.resolve({ text: "Weekly review #infinitrade" })).toBe("infinitrade");
    expect(index.resolve({ text: "goal plugin:omniclinic literature sweep" })).toBe("omniclinic");
    expect(index.resolve({ text: "[products] restock", })).toBe("products");
    expect(index.resolve({ tags: ["content-studio"] })).toBe("content-studio");
  });

  it("maps roster agents by declared id, plugin id or `<id>-` prefix", () => {
    expect(index.resolve({ agentId: "oc-literature-scout" })).toBe("omniclinic");
    expect(index.resolve({ agentId: "cmo" })).toBe("content-studio");
    expect(index.resolve({ agentId: "infinitrade-analyst" })).toBe("infinitrade");
    expect(index.resolve({ agentId: "solatrix-sniper" })).toBe("solatrix");
    expect(index.resolve({ agentId: "main" })).toBeNull();
  });

  it("maps whole-word mentions of the plugin name/id in task text, but not fragments", () => {
    expect(index.resolve({ text: "Scan Solatrix launches for the morning brief" })).toBe("solatrix");
    expect(index.resolve({ text: "Reconcile Infinitrade journal" })).toBe("infinitrade");
    expect(index.resolve({ text: "update the products catalogue" })).toBe("products");
    expect(index.resolve({ text: "byproducts of the build" })).toBeNull();
    expect(index.resolve({ text: "refactor the gateway websocket handler" })).toBeNull();
  });

  it("prefers the live tool signal over static text", () => {
    expect(index.resolve({ toolKind: "solana_market", text: "Infinitrade weekly review" })).toBe("solatrix");
    expect(index.resolve({ toolKind: "bash", text: "Infinitrade weekly review", agentId: "cmo" })).toBe("infinitrade");
    expect(index.resolve({ toolKind: "bash", text: "fix flaky test", agentId: "cmo" })).toBe("content-studio");
  });

  it("returns null with no plugins or no signal", () => {
    expect(buildPluginActivityIndex([]).resolve({ toolKind: "solana_market" })).toBeNull();
    expect(index.resolve({})).toBeNull();
    expect(index.resolve({ toolKind: "bash", text: "run tests" })).toBeNull();
  });

  it("tokenises labels keeping dotted methods and routes", () => {
    expect(activityTokens('gateway: "infinitrade.orders.list" (/solatrix/wallets)')).toEqual(["gateway", "infinitrade.orders.list", "/solatrix/wallets"]);
  });
});
