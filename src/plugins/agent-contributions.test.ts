import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { grantTestPluginEntitlements } from "../test-utils/plugin-entitlements.js";
import { useBundledPlugins } from "../../test/helpers/bundled-plugins.js";

import type { InfinibotConfig } from "../config/config.js";
import { validateConfigObject } from "../config/config.js";
import { resolvePluginLanding } from "../gateway/server-methods/plugins.js";
import {
  loadPluginAgentContributions,
  reconcilePluginAgents,
  type PluginAgentContribution,
} from "./agent-contributions.js";
import { loadPluginManifest } from "./manifest.js";
import { parseManifestV2 } from "./manifest-v2.js";

useBundledPlugins();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const contribution = (version = "1"): PluginAgentContribution => ({
  pluginId: "clinic",
  seedVersion: `clinic:${version}`,
  agents: [
    {
      id: "oc-scout",
      name: "SCOUT",
      systemPrompt: `prompt v${version}`,
      toolsAllow: ["web_search"],
      delegatesTo: ["oc-analyst"],
    },
  ],
});

const list = (cfg: InfinibotConfig) =>
  (cfg as { agents?: { list?: Array<Record<string, unknown>> } }).agents?.list ?? [];

describe("reconcilePluginAgents", () => {
  it("inserts a plugin's agents tagged with the owning plugin", () => {
    const cfg = reconcilePluginAgents({ agents: { list: [{ id: "main" }] } } as InfinibotConfig, [
      contribution(),
    ]);
    const added = list(cfg).find((a) => a.id === "oc-scout")!;
    expect(added._plugin).toBe("clinic");
    expect(added._seedVersion).toBe("clinic:1");
    expect(added.systemPrompt).toBe("prompt v1");
    expect((added.tools as { allow: string[] }).allow).toContain("web_search");
    expect(added.subagents).toEqual({ allowAgents: ["oc-analyst"] });
    expect(list(cfg).map((a) => a.id)).toEqual(["main", "oc-scout"]);
  });

  it("is a no-op when nothing changed (same object back)", () => {
    const cfg = reconcilePluginAgents({} as InfinibotConfig, [contribution()]);
    const snapshot = JSON.stringify(cfg);
    expect(reconcilePluginAgents(cfg, [contribution()])).toBe(cfg);
    expect(JSON.stringify(cfg)).toBe(snapshot);
  });

  it("refreshes on a version bump but keeps operator-owned fields", () => {
    const cfg = reconcilePluginAgents({} as InfinibotConfig, [contribution("1")]);
    list(cfg)[0].model = "my-model";
    list(cfg)[0].disabled = true;
    reconcilePluginAgents(cfg, [contribution("2")]);
    const entry = list(cfg)[0];
    expect(entry.systemPrompt).toBe("prompt v2");
    expect(entry.model).toBe("my-model");
    expect(entry.disabled).toBe(true);
  });

  it("removes managed agents when the plugin is disabled, keeps customised ones", () => {
    const cfg = reconcilePluginAgents({} as InfinibotConfig, [contribution()]);
    reconcilePluginAgents(cfg, []);
    expect(list(cfg)).toEqual([]);

    const custom = reconcilePluginAgents({} as InfinibotConfig, [contribution()]);
    delete list(custom)[0]._seedVersion; // operator took ownership
    reconcilePluginAgents(custom, []);
    expect(list(custom).map((a) => a.id)).toEqual(["oc-scout"]);
  });

  it("never overwrites an agent id owned by core or the operator", () => {
    const cfg = { agents: { list: [{ id: "oc-scout", systemPrompt: "mine" }] } } as InfinibotConfig;
    reconcilePluginAgents(cfg, [contribution()]);
    expect(list(cfg)).toEqual([{ id: "oc-scout", systemPrompt: "mine" }]);
  });

  it("seeded entries pass config validation", () => {
    const cfg = reconcilePluginAgents({} as InfinibotConfig, [contribution()]);
    expect(validateConfigObject(cfg).ok).toBe(true);
  });
});

describe("manifest v2: agents, landing, phi", () => {
  const base = {
    engines: { "infinibot-plugin-api": "^2.0.0" },
    contributes: {
      pages: [{ tab: "clinic", route: "/clinic", builtin: "clinic" }],
      landing: "clinic",
      agents: ["agents/roster.json"],
    },
    permissions: { phi: true },
  };

  it("parses the new fields", () => {
    const res = parseManifestV2("clinic", base);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fields.contributes.landing).toBe("clinic");
    expect(res.fields.contributes.agents).toEqual(["agents/roster.json"]);
    expect(res.fields.permissions.phi).toBe(true);
  });

  it("rejects a landing tab without a page and agent files outside the plugin", () => {
    expect(
      parseManifestV2("clinic", { ...base, contributes: { ...base.contributes, landing: "nope" } })
        .ok,
    ).toBe(false);
    expect(
      parseManifestV2("clinic", {
        ...base,
        contributes: { ...base.contributes, agents: ["../x.json"] },
      }).ok,
    ).toBe(false);
  });

  it("resolves the landing page only when opted in and the plugin is loaded", () => {
    const parsed = parseManifestV2("clinic", base);
    if (!parsed.ok) throw new Error(parsed.error);
    const plugin = {
      id: "clinic",
      status: "loaded" as const,
      contributes: parsed.fields.contributes,
    };
    expect(resolvePluginLanding([plugin], undefined)).toBeNull();
    expect(resolvePluginLanding([plugin], "clinic")).toEqual({
      pluginId: "clinic",
      tab: "clinic",
      route: "/clinic",
    });
    expect(resolvePluginLanding([{ ...plugin, status: "disabled" }], "clinic")).toBeNull();
  });
});

describe("bundled omniclinic plugin", () => {
  const root = path.join(repoRoot, "extensions", "omniclinic");

  it("ships a valid v2 manifest: omniclinic.* RPCs, PHI flag, landing page", () => {
    const res = loadPluginManifest(root);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const v2 = res.manifest.v2!;
    expect(res.manifest.id).toBe("omniclinic");
    expect(v2.permissions.phi).toBe(true);
    expect(v2.contributes.landing).toBe("omniclinic");
    expect(v2.contributes.rpc.every((r) => r.method.startsWith("omniclinic."))).toBe(true);
    expect(
      v2.contributes.rpc
        .filter((r) => r.method.startsWith("omniclinic.import."))
        .map((r) => r.scope),
    ).toEqual(["admin", "admin"]);
  });

  it("contributes its roster only while enabled (disabled by default)", () => {
    const off = loadPluginAgentContributions({ config: {} as InfinibotConfig });
    expect(off.some((c) => c.pluginId === "omniclinic")).toBe(false);
    // Paid plugin: switched on but not purchased → still no roster.
    const unpaid = loadPluginAgentContributions({
      config: { plugins: { entries: { omniclinic: { enabled: true } } } } as InfinibotConfig,
    });
    expect(unpaid.some((c) => c.pluginId === "omniclinic")).toBe(false);
    const revoke = grantTestPluginEntitlements(["omniclinic"]);
    onTestFinished(revoke);
    const on = loadPluginAgentContributions({
      config: { plugins: { entries: { omniclinic: { enabled: true } } } } as InfinibotConfig,
    });
    const mine = on.find((c) => c.pluginId === "omniclinic");
    expect(mine?.agents.length).toBeGreaterThan(0);
    expect(mine?.agents.every((a) => a.id.startsWith("oc-"))).toBe(true);
    expect(mine?.agents.every((a) => /not clinical decision support/.test(a.systemPrompt))).toBe(
      true,
    );
  });
});
