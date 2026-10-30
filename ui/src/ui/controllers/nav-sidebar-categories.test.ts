import { describe, it, expect, beforeEach } from "vitest";
import {
  loadNavSidebarState,
  saveNavSidebarState,
  createNavCategory,
  isCustomCategory,
  NAV_LAYOUT_VERSION,
} from "./nav-sidebar";

const STORAGE_KEY = "infinibot-nav-sidebar";
const VERSION_KEY = "infinibot-nav-version";

describe("nav sidebar category persistence", () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(VERSION_KEY);
  });

  it("keeps a freshly created (still empty) category across a reload", () => {
    const created = createNavCategory(loadNavSidebarState(), "Revenue");
    const cat = created.categories.find((c) => c.label === "Revenue");
    expect(cat).toBeTruthy();
    expect(cat!.tabs).toHaveLength(0);
    expect(isCustomCategory(cat!)).toBe(true);

    // A reload re-runs the merge path — the empty category must survive it,
    // twice (the second load reads back what the first one may have rewritten).
    expect(loadNavSidebarState().categories.map((c) => c.label)).toContain("Revenue");
    expect(loadNavSidebarState().categories.map((c) => c.label)).toContain("Revenue");
  });

  it("keeps a legacy custom category that predates the isCustom flag", () => {
    const base = loadNavSidebarState();
    saveNavSidebarState({
      ...base,
      categories: [
        ...base.categories,
        { id: "custom-legacy-1", label: "Legacy", collapsed: false, position: 98, tabs: [] },
      ],
    });
    expect(loadNavSidebarState().categories.map((c) => c.id)).toContain("custom-legacy-1");
  });

  it("survives a nav version bump", () => {
    createNavCategory(loadNavSidebarState(), "Revenue");
    localStorage.setItem(VERSION_KEY, "stale-version");
    expect(loadNavSidebarState().categories.map((c) => c.label)).toContain("Revenue");
  });

  it("still prunes default groups that lost every tab", () => {
    const base = loadNavSidebarState();
    saveNavSidebarState({
      ...base,
      categories: [
        ...base.categories,
        { id: "default-ghost", label: "Ghost", collapsed: false, position: 99, tabs: [], isCustom: false },
      ],
    });
    expect(loadNavSidebarState().categories.map((c) => c.id)).not.toContain("default-ghost");
  });

  it("migrates a pre-consolidation sidebar to the new groups, keeping custom categories", () => {
    // Shape of a real saved sidebar from before the regroup (no layoutVersion).
    localStorage.setItem(VERSION_KEY, "2026.07.31a");
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        categories: [
          { id: "default-home", label: "Home", collapsed: false, position: 0, tabs: ["dashboard", "agency-daily"], isCustom: false },
          { id: "custom-1-rev", label: "Revenue", collapsed: true, position: 1, tabs: ["clients", "business"], isCustom: true },
          { id: "default-business", label: "Business", collapsed: false, position: 2, tabs: ["command-ceo", "command-ops", "projects", "databases", "inbox", "email"], isCustom: false },
          { id: "default-agent", label: "Agent", collapsed: true, position: 3, tabs: ["agents", "inficode", "terminals"], isCustom: false },
          { id: "default-media", label: "Media", collapsed: false, position: 4, tabs: ["whiteboard", "image-studio"], isCustom: false },
        ],
        hiddenTabs: ["docs", "decisions"],
        tabCustomNames: { projects: "My Projects", "command-ops": "Ops" },
      }),
    );

    const state = loadNavSidebarState();
    const labels = state.categories.map((c) => c.label);
    // "Revenue" held only clients + business, which the business-agency
    // plugin now owns (its own section), so the empty custom category goes;
    // the core "Business" group left with it.
    expect(labels).toEqual(["Home", "Chat & Voice", "Work", "Agents", "Settings"]);

    const all = state.categories.flatMap((c) => c.tabs);
    // No duplicates, no retired tabs, custom category keeps its tabs.
    expect(new Set(all).size).toBe(all.length);
    for (const retired of ["agency-daily", "command-ops", "databases", "email", "inficode"]) {
      expect(all).not.toContain(retired);
    }
    expect(all).not.toContain("clients");
    expect(all).not.toContain("business");
    // Hidden tabs stay hidden (and out of the categories); retired ones are
    // pruned. `decisions` is now a plugin page, so the user's hide survives.
    expect(state.hiddenTabs).toEqual(["docs", "decisions"]);
    expect(all).not.toContain("docs");
    // Built-in collapsed flag carried over by id; renames for live and plugin
    // tabs kept (command-ops is a Business & Agency page now).
    expect(state.categories.find((c) => c.id === "default-home")!.collapsed).toBe(false);
    expect(state.tabCustomNames).toEqual({ projects: "My Projects", "command-ops": "Ops" });
    expect(state.layoutVersion).toBe(NAV_LAYOUT_VERSION);

    // Migration runs once: a user reorder after it survives the next load.
    const reordered = {
      ...state,
      categories: state.categories.map((c) =>
        c.label === "Work" ? { ...c, tabs: [...c.tabs].reverse() } : c,
      ),
    };
    saveNavSidebarState(reordered);
    const again = loadNavSidebarState();
    expect(again.categories.find((c) => c.label === "Work")!.tabs).toEqual(
      reordered.categories.find((c) => c.label === "Work")!.tabs,
    );
  });
});
