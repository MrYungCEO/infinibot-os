import { beforeEach, describe, expect, it } from "vitest";

import disciplineManifest from "../../../extensions/discipline/infinibot.plugin.json";
import { NAV_CATALOG_GROUPS, TAB_GROUPS } from "./navigation";
import {
  applyPluginList,
  isPluginGatedTab,
  isTabAvailable,
  pluginNavLabel,
  pluginNavSections,
  pluginOwnerOfTab,
  resetPluginHostForTests,
  type PluginListItem,
} from "./plugin-host";

const discipline = (status: PluginListItem["status"]): PluginListItem => ({
  id: disciplineManifest.id,
  name: disciplineManifest.name,
  origin: "bundled",
  enabled: status === "loaded",
  status,
  manifestVersion: disciplineManifest.manifestVersion,
  contributes: disciplineManifest.contributes as unknown as PluginListItem["contributes"],
});

beforeEach(() => resetPluginHostForTests());

describe("Discipline is a plugin-gated surface", () => {
  it("is not in the core sidebar or catalogue (launchpad / ui_control / wake words)", () => {
    const core = TAB_GROUPS.flatMap((g) => g.tabs as readonly string[]);
    expect(core).not.toContain("discipline");
    const catalogue = NAV_CATALOG_GROUPS.flatMap((g) => g.tabs as readonly string[]);
    expect(catalogue).not.toContain("discipline");
    expect(catalogue).not.toContain("focus");
  });

  it("Day and Focus board are gated until the plugin loads", () => {
    expect(isPluginGatedTab("discipline")).toBe(true);
    expect(isPluginGatedTab("focus")).toBe(true);
    applyPluginList([discipline("disabled")]);
    expect(isTabAvailable("discipline")).toBe(false);
    expect(isTabAvailable("focus")).toBe(false);
    expect(pluginNavSections()).toEqual([]);
    expect(pluginOwnerOfTab("focus")).toMatchObject({ pluginId: "discipline", status: "disabled" });
  });

  it("enabled: its own sidebar section (Day + Focus board) + both pages routable", () => {
    applyPluginList([discipline("loaded")]);
    expect(isTabAvailable("discipline")).toBe(true);
    expect(isTabAvailable("focus")).toBe(true);
    const sections = pluginNavSections();
    expect(sections.map((s) => [s.pluginId, s.title, s.items.map((i) => [i.tab, i.label])])).toEqual([
      ["discipline", "Discipline", [["discipline", "Day"], ["focus", "Focus board"]]],
    ]);
    expect(pluginNavLabel("discipline")).toBe("Day");
  });

  it("no gateway answer yet (plugins.list not synced) → still gated", () => {
    expect(isTabAvailable("discipline")).toBe(false);
  });
});
