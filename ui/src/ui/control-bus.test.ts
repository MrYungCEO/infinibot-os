import { describe, expect, it } from "vitest";

import { mergeControlAction } from "./control-bus";

describe("mergeControlAction", () => {
  it("keeps add_panel as the operation when callers use the legacy type argument", () => {
    expect(mergeControlAction("add_panel", { type: "canvas", options: { title: "Map" } })).toEqual({
      type: "add_panel",
      panelType: "canvas",
      options: { title: "Map" },
    });
  });

  it("accepts the collision-free panelType argument", () => {
    expect(mergeControlAction("add_panel", { panelType: "canvas" })).toEqual({
      type: "add_panel",
      panelType: "canvas",
    });
  });
});
