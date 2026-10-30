import { describe, expect, it } from "vitest";

import { defaultSettings } from "../../../../../extensions/community-manager/src/defaults.js";
import type { StatusResponse } from "../../../../../extensions/community-manager/src/contract.js";
import { compact, modeLabel, parseList, parseStep, slaLabel, sparkPoints, stepStates, weightTotal, withStep } from "./logic.js";

const status = (patch: Partial<StatusResponse["connection"]> = {}) =>
  ({ mode: "setup", paused: false, connection: { tokenConfigured: false, ...patch } }) as unknown as StatusResponse;

describe("community wizard logic", () => {
  it("parses and writes ?step=", () => {
    expect(parseStep("?step=4")).toBe(4);
    expect(parseStep("?step=11")).toBeNull();
    expect(parseStep("?step=x")).toBeNull();
    expect(parseStep("")).toBeNull();
    expect(withStep("http://h/community?a=1", 3)).toBe("/community?a=1&step=3");
    expect(withStep("http://h/community?step=3", null)).toBe("/community");
  });

  it("marks steps done from saved settings", () => {
    const s = defaultSettings();
    expect(stepStates(s, status(), 1)).toEqual(["current", ...Array(9).fill("todo")]);
    const s2 = { ...s, guildId: "1", channelMap: { "start-here": "2" }, roleMap: { verified: "3" }, setupStep: 7, testRun: { ok: true, at: 1, steps: [] } };
    const st = stepStates(s2, status({ tokenConfigured: true }), 7);
    expect(st.slice(0, 6)).toEqual(["done", "done", "done", "done", "done", "done"]);
    expect(st[6]).toBe("current");
    expect(st[8]).toBe("done");
    expect(st[9]).toBe("todo");
  });

  it("formats weights, SLA, mode, numbers and lists", () => {
    expect(weightTotal(defaultSettings().questions)).toBe(100);
    expect(slaLabel(null).text).toBe("—");
    expect(slaLabel(1_000 + 4 * 60_000 + 12_000, 1_000)).toEqual({ text: "04:12", late: false });
    expect(slaLabel(1_000, 1_000 + 3 * 60_000)).toEqual({ text: "late 3m", late: true });
    expect(modeLabel({ mode: "live", paused: true }).tone).toBe("paused");
    expect(modeLabel({ mode: "shadow", paused: false }).label).toBe("Shadow");
    expect(modeLabel({ mode: "shadow", paused: false, liveModules: ["greeting"] }).label).toBe("Shadow · Welcome greeting live");
    expect(modeLabel({ mode: "shadow", paused: true, liveModules: ["greeting"] }).label).toBe("Paused");
    expect(compact(15204)).toBe("15.2k");
    expect(compact(null)).toBe("—");
    expect(parseList("a, b\nb\n\n c")).toEqual(["a", "b", "c"]);
    expect(sparkPoints([0, 5, 10], 100, 10)).toBe("0.0,10.0 50.0,5.0 100.0,0.0");
  });
});
