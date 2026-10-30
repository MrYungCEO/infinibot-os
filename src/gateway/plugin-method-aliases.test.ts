import { describe, expect, it } from "vitest";

import { PLUGIN_METHOD_ALIASES, resolvePluginMethodAlias } from "./plugin-method-aliases.js";

describe("plugin method aliases", () => {
  it("forwards focus.* to discipline.focus.* while the plugin serves it", () => {
    const handler = () => {};
    const res = resolvePluginMethodAlias("focus.list", { "discipline.focus.list": handler });
    expect(res).toEqual({ target: "discipline.focus.list", handler });
  });

  it("answers 'turned off' when the plugin is off", () => {
    const res = resolvePluginMethodAlias("focus.set", {});
    expect(res?.handler).toBeUndefined();
    expect(res?.off).toMatch(/Discipline plugin.*Setup › Plugins/);
  });

  it("ignores non-aliased methods", () => {
    expect(resolvePluginMethodAlias("discipline.state", {})).toBeNull();
  });

  it("every legacy focus method has a target in the manifest namespace", () => {
    for (const [from, a] of Object.entries(PLUGIN_METHOD_ALIASES)) {
      expect(a.target).toBe(from.replace(/^focus\./, "discipline.focus."));
    }
  });
});
