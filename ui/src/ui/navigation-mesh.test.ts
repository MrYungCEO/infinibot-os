import { describe, expect, it } from "vitest";

import {
  NAV_CATALOG_GROUPS,
  TAB_GROUPS,
  hostForTab,
  iconForTab,
  pathForTab,
  resolveTabRedirect,
  subtitleForTab,
  tabFromPath,
  titleForTab,
  type Tab,
} from "./navigation";

describe("Agent Mesh tab", () => {
  it("resolves /mesh and back", () => {
    expect(pathForTab("mesh")).toBe("/mesh");
    expect(tabFromPath("/mesh")).toBe("mesh");
    expect(tabFromPath("/ui/mesh", "/ui")).toBe("mesh");
    expect(resolveTabRedirect("mesh")).toBe("mesh");
    expect(hostForTab("mesh")).toBe("mesh");
  });

  it("sits in the Agents group right after Activity", () => {
    const agents = TAB_GROUPS.find((g) => g.label === "Agents")!.tabs as readonly Tab[];
    expect(agents.indexOf("mesh")).toBe(agents.indexOf("activity") + 1);
    const catalog = NAV_CATALOG_GROUPS.find((g) => g.label === "Agents")!.tabs;
    expect(catalog).toContain("mesh");
  });

  it("has a title, subtitle and icon", () => {
    expect(titleForTab("mesh")).toBe("Agent Mesh");
    expect(subtitleForTab("mesh")).toMatch(/agent/i);
    expect(iconForTab("mesh")).toBe("network");
  });
});
