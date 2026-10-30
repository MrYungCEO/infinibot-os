import { describe, expect, it } from "vitest";
import { applyPluginList, resetPluginHostForTests } from "../plugin-host";
import { createSolanaChartState, effectiveChartSource, renderSolanaChartOverlay } from "./solana-chart";

describe("control-bar chart source", () => {
  it("uses the native Solatrix chart only while the plugin is available", () => {
    expect(effectiveChartSource("solatrix", true)).toBe("solatrix");
    expect(effectiveChartSource("solatrix", false)).toBe("dexscreener");
    expect(effectiveChartSource("dexscreener", true)).toBe("dexscreener");
  });

  it("renders nothing while closed and keeps DexScreener as the default source", () => {
    resetPluginHostForTests();
    applyPluginList([]);
    const state = createSolanaChartState();
    expect(state.isOpen).toBe(false);
    const tpl = renderSolanaChartOverlay(state, () => {}, () => {});
    expect(tpl.strings.join("").trim()).toBe("");
  });
});
