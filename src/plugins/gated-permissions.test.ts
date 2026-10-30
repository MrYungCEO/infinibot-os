import { afterEach, describe, expect, it } from "vitest";

import { InfinibotSchema } from "../config/zod-schema.js";
import { setPermissionInEntry } from "../gateway/server-methods/plugins.js";
import { buildContributionCatalog, listPermissionItems } from "./contributions.js";
import {
  getPluginHostState,
  isContributionActive,
  isPluginPermissionGranted,
  isPluginToolActive,
  resetPluginHostStateForTests,
  syncPluginHostStateFromConfig,
} from "./host-state.js";
import { parseManifestV2 } from "./manifest-v2.js";
import type { PluginRegistry } from "./registry.js";
import { setActivePluginRegistry } from "./runtime.js";

const RAW = {
  engines: { "infinibot-plugin-api": "^2.0.0" },
  contributes: {
    rpc: [
      { method: "demo.read", scope: "read" },
      { method: "demo.orders.place", scope: "write", requires: ["gated:orders"] },
    ],
    tools: [{ name: "demo_read" }, { name: "demo_order", requires: ["gated:orders"] }],
    panels: ["demo.positions"],
  },
  permissions: {
    network: ["broker.example"],
    gated: [{ id: "orders", label: "Place orders", description: "Send orders." }],
  },
};

function activate(): void {
  const catalog = buildContributionCatalog(RAW);
  setActivePluginRegistry({
    plugins: [
      {
        id: "demo",
        name: "Demo",
        status: "loaded",
        permissions: RAW.permissions,
        catalog,
        gatewayMethods: ["demo.read", "demo.orders.place"],
      },
    ],
  } as unknown as PluginRegistry);
}

afterEach(() => {
  resetPluginHostStateForTests();
  setActivePluginRegistry({ plugins: [] } as unknown as PluginRegistry);
});

describe("gated (default-off) permissions", () => {
  it("parse: tools accept objects, panels are listed, gated needs id + label", () => {
    const res = parseManifestV2("demo", RAW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fields.contributes.tools).toEqual(["demo_read", "demo_order"]);
    expect(res.fields.contributes.panels).toEqual(["demo.positions"]);
    expect(res.fields.permissions.gated).toEqual([
      { id: "orders", label: "Place orders", description: "Send orders." },
    ]);
    const bad = parseManifestV2("demo", { ...RAW, permissions: { gated: [{ id: "x" }] } });
    expect(bad.ok).toBe(false);
    const keys = buildContributionCatalog(RAW).items.map((i) => i.key);
    expect(keys).toContain("panelKind:demo.positions");
  });

  it("lists gated permissions as default-off permission items", () => {
    const items = listPermissionItems(RAW.permissions);
    expect(items.find((p) => p.key === "gated:orders")).toMatchObject({
      category: "gated",
      label: "Place orders",
      consent: "Send orders.",
      defaultGranted: false,
    });
  });

  it("blocks dependents until granted; grant/revoke round-trips through config", () => {
    activate();
    const record = { id: "demo", catalog: buildContributionCatalog(RAW) };
    expect(isPluginPermissionGranted("demo", "gated:orders")).toBe(false);
    expect(isPluginPermissionGranted("demo", "network:broker.example")).toBe(true);
    expect(isContributionActive(record, "rpc:demo.orders.place")).toBe(false);
    expect(isContributionActive(record, "rpc:demo.read")).toBe(true);
    expect(isPluginToolActive("demo", "demo_order")).toBe(false);
    expect(isPluginToolActive("demo", "demo_read")).toBe(true);

    const granted = setPermissionInEntry({}, "gated:orders", true);
    expect(granted.permissions).toEqual({ granted: ["gated:orders"] });
    syncPluginHostStateFromConfig({ entries: { demo: granted } });
    expect(isPluginPermissionGranted("demo", "gated:orders")).toBe(true);
    expect(isContributionActive(record, "rpc:demo.orders.place")).toBe(true);
    expect(isPluginToolActive("demo", "demo_order")).toBe(true);

    const revoked = setPermissionInEntry(granted, "gated:orders", false);
    expect(revoked.permissions).toEqual({});
    syncPluginHostStateFromConfig({ entries: { demo: revoked } });
    expect(isPluginPermissionGranted("demo", "gated:orders")).toBe(false);
    // Ordinary permissions keep their revoke semantics alongside grants.
    const both = setPermissionInEntry(
      setPermissionInEntry({}, "gated:orders", true),
      "network:broker.example",
      false,
    );
    expect(both.permissions).toEqual({
      revoked: ["network:broker.example"],
      granted: ["gated:orders"],
    });
    syncPluginHostStateFromConfig({ entries: { demo: both } });
    expect([...getPluginHostState("demo").revoked]).toEqual(["network:broker.example"]);
    // The written entry is valid config (plugins.permissions.set persists it).
    const parsed = InfinibotSchema.safeParse({ plugins: { entries: { demo: both } } });
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  });
});
