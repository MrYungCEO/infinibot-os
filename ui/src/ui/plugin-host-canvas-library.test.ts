import { beforeEach, describe, expect, it } from "vitest";
import manifest from "../../../extensions/canvas-library/infinibot.plugin.json";
import {
  applyPluginList,
  isPluginGatedTab,
  isTabAvailable,
  pluginNavLabel,
  pluginOwnerOfTab,
  resetPluginHostForTests,
  type PluginListItem,
} from "./plugin-host.js";

const holo = (status: PluginListItem["status"]): PluginListItem => ({
  id: "canvas-library",
  name: manifest.name,
  origin: "bundled",
  enabled: status === "loaded",
  status,
  manifestVersion: 2,
  contributes: { nav: manifest.contributes.nav, pages: manifest.contributes.pages, rpc: [], http: [] },
});

describe("HoloCanvas library plugin gating (tab `canvas`)", () => {
  beforeEach(() => resetPluginHostForTests());

  it("is plugin-gated and unavailable until the plugin loads", () => {
    expect(isPluginGatedTab("canvas")).toBe(true);
    expect(isTabAvailable("canvas")).toBe(false);
    applyPluginList([holo("disabled")]);
    expect(isTabAvailable("canvas")).toBe(false);
    expect(pluginOwnerOfTab("canvas")?.pluginName).toBe("HoloCanvas");
  });

  it("contributes the HoloCanvas nav entry while loaded, and drops it when turned off", () => {
    applyPluginList([holo("loaded")]);
    expect(isTabAvailable("canvas")).toBe(true);
    expect(pluginNavLabel("canvas")).toBe("HoloCanvas");
    applyPluginList([holo("disabled")]);
    expect(isTabAvailable("canvas")).toBe(false);
  });
});
