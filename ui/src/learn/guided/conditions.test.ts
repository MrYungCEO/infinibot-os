import { describe, expect, it } from "vitest";
import { checkRpcValue, evaluate, isListable, pickPath, routeMatches, type ConditionEnv } from "./conditions";

function env(over: Partial<ConditionEnv> = {}): ConditionEnv {
  return {
    pluginEnabled: (id) => id === "on",
    hasMethod: (m) => m === "goals.list",
    hasSurface: (s) => s === "agents-constellation",
    elementVisible: (t) => t === "learn:here",
    route: () => "/autonomy?view=goals",
    viewportWidth: () => 1280,
    rpc: async (method) => {
      if (method === "goals.list") return { goals: [{ status: "running" }, { status: "verified" }] };
      if (method === "plugins.list") return { plugins: [{ id: "a", enabled: false }, { id: "b", enabled: true }] };
      throw new Error("unknown");
    },
    completed: (ref) => ref === "t/w",
    ...over,
  };
}

describe("guided conditions", () => {
  it("picks dotted paths, array maps and lengths", () => {
    const v = { a: { b: [{ c: 1 }, { c: 2 }] }, s: "abc" };
    expect(pickPath(v, "a.b.length")).toBe(2);
    expect(pickPath(v, "a.b.*.c")).toEqual([1, 2]);
    expect(pickPath(v, "s.length")).toBe(3);
    expect(pickPath(v, "a.missing.x")).toBeUndefined();
    expect(pickPath(v, undefined)).toBe(v);
  });

  it("checks rpc values by equals / min / includes / truthiness", () => {
    expect(checkRpcValue([1, 2], { min: 2 })).toBe(true);
    expect(checkRpcValue(3, { min: 4 })).toBe(false);
    expect(checkRpcValue(["x", "y"], { includes: "y" })).toBe(true);
    expect(checkRpcValue([false, true], {})).toBe(true);
    expect(checkRpcValue([], {})).toBe(false);
    expect(checkRpcValue("verified", { equals: "verified" })).toBe(true);
    expect(checkRpcValue(["a", "verified"], { equals: "verified" })).toBe(true);
  });

  it("matches routes by prefix and required query params", () => {
    expect(routeMatches("/infinitrade/journal", "/infinitrade")).toBe(true);
    expect(routeMatches("/infinitrades", "/infinitrade")).toBe(false);
    expect(routeMatches("/autonomy?view=goals&x=1", "/autonomy?view=goals")).toBe(true);
    expect(routeMatches("/autonomy?view=phases", "/autonomy?view=goals")).toBe(false);
    expect(routeMatches("/", "/")).toBe(true);
  });

  it("evaluates every condition kind, including nesting", async () => {
    const e = env();
    expect(await evaluate({ kind: "pluginEnabled", plugin: "on" }, e)).toBe(true);
    expect(await evaluate({ kind: "pluginEnabled", plugin: "off" }, e)).toBe(false);
    expect(await evaluate({ kind: "method", method: "goals.list" }, e)).toBe(true);
    expect(await evaluate({ kind: "surface", surface: "mesh-plugin-district" }, e)).toBe(false);
    expect(await evaluate({ kind: "element", target: "learn:here" }, e)).toBe(true);
    expect(await evaluate({ kind: "route", path: "/autonomy?view=goals" }, e)).toBe(true);
    expect(await evaluate({ kind: "viewport", maxWidth: 800 }, e)).toBe(false);
    expect(await evaluate({ kind: "viewport", minWidth: 800 }, e)).toBe(true);
    expect(await evaluate({ kind: "completed", ref: "t/w" }, e)).toBe(true);
    expect(await evaluate({ kind: "rpc", method: "goals.list", path: "goals.*.status", includes: "verified" }, e)).toBe(true);
    expect(await evaluate({ kind: "rpc", method: "plugins.list", path: "plugins.*.enabled", includes: true }, e)).toBe(true);
    expect(await evaluate({ kind: "rpc", method: "goals.list", path: "goals.length", min: 3 }, e)).toBe(false);
    expect(await evaluate({ kind: "rpc", method: "nope.list" }, e)).toBe(false); // rejected RPC → false, never throws
    expect(await evaluate({ kind: "not", condition: { kind: "pluginEnabled", plugin: "off" } }, e)).toBe(true);
    expect(
      await evaluate({ kind: "all", conditions: [{ kind: "method", method: "goals.list" }, { kind: "element", target: "learn:here" }] }, e),
    ).toBe(true);
    expect(
      await evaluate({ kind: "any", conditions: [{ kind: "pluginEnabled", plugin: "off" }, { kind: "viewport", maxWidth: 400 }] }, e),
    ).toBe(false);
    expect(await evaluate(undefined, e)).toBe(true);
  });

  it("refuses write RPCs even if a malformed track slips through", async () => {
    let called = false;
    const e = env({
      rpc: async () => {
        called = true;
        return true;
      },
    });
    expect(await evaluate({ kind: "rpc", method: "infinitrade.order.place" }, e)).toBe(false);
    expect(await evaluate({ kind: "rpc", method: "plugins.setEnabled" }, e)).toBe(false);
    expect(called).toBe(false);
  });

  it("listing only hides tracks on static facts (plugin, method, surface)", () => {
    const e = env();
    expect(isListable({ kind: "pluginEnabled", plugin: "off" }, e)).toBe(false);
    expect(isListable({ kind: "surface", surface: "agents-constellation" }, e)).toBe(true);
    expect(isListable({ kind: "surface", surface: "voice-robovoice-pipeline" }, e)).toBe(false);
    expect(isListable({ kind: "element", target: "learn:elsewhere" }, e)).toBe(true);
    expect(isListable({ kind: "route", path: "/other" }, e)).toBe(true);
    expect(isListable({ kind: "not", condition: { kind: "pluginEnabled", plugin: "on" } }, e)).toBe(false);
    expect(isListable({ kind: "not", condition: { kind: "element", target: "x" } }, e)).toBe(true);
    expect(
      isListable({ kind: "all", conditions: [{ kind: "pluginEnabled", plugin: "on" }, { kind: "method", method: "x.list" }] }, e),
    ).toBe(false);
  });
});
