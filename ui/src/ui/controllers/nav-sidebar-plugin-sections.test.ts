import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NAV_LAYOUT_VERSION,
  hideTab,
  isPluginSectionCollapsed,
  isPluginSectionHidden,
  mergeNavSidebarState,
  setPluginSectionHidden,
  togglePluginSectionCollapsed,
  unhideTab,
  type NavSidebarState,
} from "./nav-sidebar";
import type { Tab } from "../navigation";

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    dump: () => m,
  };
}

/** A user's saved sidebar: custom category, rename, hidden core tab, and a
 *  stale plugin tab left inside a core group by the old nav-group placement. */
function savedLayout(extra: Partial<NavSidebarState> = {}): Partial<NavSidebarState> {
  return {
    layoutVersion: NAV_LAYOUT_VERSION,
    categories: [
      { id: "default-home", label: "Home", collapsed: false, position: 0, tabs: ["dashboard", "learn"] },
      { id: "custom-1", label: "My stuff", collapsed: true, position: 1, tabs: ["notes"], isCustom: true },
      { id: "default-agents", label: "Agents", collapsed: false, position: 2, tabs: ["agents", "inficode" as Tab] },
    ],
    hiddenTabs: ["logs", "oc-research"] as Tab[],
    tabCustomNames: { notes: "Scratch", inficode: "Code Mesh" },
    ...extra,
  };
}

describe("nav sidebar: plugin sections vs saved layouts", () => {
  let storage: ReturnType<typeof memoryStorage>;
  beforeEach(() => {
    storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps custom categories, renames and hides; plugin tabs never sit in a category", () => {
    const merged = mergeNavSidebarState(savedLayout({ pluginSections: { omniclinic: { collapsed: true } } }));
    const custom = merged.categories.find((c) => c.id === "custom-1");
    expect(custom).toMatchObject({ label: "My stuff", collapsed: true, tabs: ["notes"] });
    expect(merged.categories.flatMap((c) => c.tabs)).not.toContain("inficode");
    // Hidden/renamed plugin pages survive the prune (they live in plugin sections).
    expect(merged.hiddenTabs).toEqual(["logs", "oc-research"]);
    expect(merged.tabCustomNames).toEqual({ notes: "Scratch", inficode: "Code Mesh" });
    expect(merged.pluginSections).toEqual({ omniclinic: { collapsed: true } });
  });

  it("a layoutVersion migration keeps plugin-section prefs and user customisations", () => {
    const merged = mergeNavSidebarState(
      savedLayout({ layoutVersion: "2025.01-old", pluginSections: { robovoice: { hidden: true } } }),
    );
    expect(merged.layoutVersion).toBe(NAV_LAYOUT_VERSION);
    expect(merged.categories.some((c) => c.id === "custom-1")).toBe(true);
    expect(merged.pluginSections).toEqual({ robovoice: { hidden: true } });
    expect(merged.tabCustomNames.inficode).toBe("Code Mesh");
  });

  it("drops malformed plugin-section prefs from older/foreign states", () => {
    const merged = mergeNavSidebarState(
      savedLayout({ pluginSections: { a: { collapsed: "yes" }, b: null, c: { hidden: true, junk: 1 } } as never }),
    );
    expect(merged.pluginSections).toEqual({ c: { hidden: true } });
    expect(mergeNavSidebarState(savedLayout()).pluginSections).toEqual({});
  });

  it("collapse/hide prefs toggle per plugin, honour collapsedByDefault, and persist", () => {
    let s = mergeNavSidebarState(savedLayout());
    expect(isPluginSectionCollapsed(s, "omniclinic")).toBe(false);
    expect(isPluginSectionCollapsed(s, "omniclinic", true)).toBe(true);
    s = togglePluginSectionCollapsed(s, "omniclinic", true);
    expect(isPluginSectionCollapsed(s, "omniclinic", true)).toBe(false);
    s = togglePluginSectionCollapsed(s, "infinicode");
    expect(isPluginSectionCollapsed(s, "infinicode")).toBe(true);
    s = setPluginSectionHidden(s, "robovoice", true);
    expect(isPluginSectionHidden(s, "robovoice")).toBe(true);
    const stored = JSON.parse(storage.getItem("infinibot-nav-sidebar")!);
    expect(stored.pluginSections).toEqual({
      omniclinic: { collapsed: false },
      infinicode: { collapsed: true },
      robovoice: { hidden: true },
    });
    s = setPluginSectionHidden(s, "robovoice", false);
    expect(isPluginSectionHidden(s, "robovoice")).toBe(false);
    // Custom categories untouched by any of it.
    expect(s.categories.find((c) => c.id === "custom-1")?.tabs).toEqual(["notes"]);
  });

  it("un-hiding a plugin page returns it to its section, not to a category", () => {
    let s = mergeNavSidebarState(savedLayout());
    s = hideTab(s, "inficode");
    expect(s.hiddenTabs).toContain("inficode");
    s = unhideTab(s, "inficode");
    expect(s.hiddenTabs).not.toContain("inficode");
    expect(s.categories.flatMap((c) => c.tabs)).not.toContain("inficode");
    // Core tabs still go back into the first category.
    s = unhideTab(s, "logs");
    expect(s.categories[0].tabs).toContain("logs");
  });
});
