import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Tab } from "../navigation";
import {
  NAV_LAYOUT_VERSION,
  addFavorite,
  isFavorite,
  mergeNavSidebarState,
  moveFavorite,
  moveSection,
  moveTabToSection,
  nestSection,
  pluginSectionId,
  removeFavorite,
  saveNavSidebarState,
  loadNavSidebarState,
  sectionParent,
  unnestSection,
  visibleFavorites,
} from "./nav-sidebar";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const ownerLayout = JSON.parse(
  readFileSync(new URL("./__fixtures__/nav-sidebar-owner-2026-09-30.json", import.meta.url), "utf8"),
);
const liveOwnerLayoutPath = process.env.INFINIBOT_LIVE_NAV_SIDEBAR ?? "";

describe("nav sidebar favorites and hierarchy", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("adds, removes and keyboard-reorders favorites without duplicates", () => {
    let state = mergeNavSidebarState(ownerLayout);
    state = addFavorite(state, "dashboard");
    state = addFavorite(state, "notes");
    state = addFavorite(state, "dashboard");
    expect(state.favorites).toEqual(["dashboard", "notes"]);
    expect(isFavorite(state, "dashboard")).toBe(true);
    state = moveFavorite(state, "notes", -1);
    expect(state.favorites).toEqual(["notes", "dashboard"]);
    state = removeFavorite(state, "notes");
    expect(state.favorites).toEqual(["dashboard"]);
  });

  it("hides an unavailable plugin favorite without deleting it", () => {
    const state = mergeNavSidebarState({ ...ownerLayout, favorites: ["dashboard", "infinitrade"] as Tab[] });
    expect(visibleFavorites(state, (tab) => tab !== "infinitrade")).toEqual(["dashboard"]);
    expect(state.favorites).toEqual(["dashboard", "infinitrade"]);
    expect(visibleFavorites(state, () => true)).toEqual(["dashboard", "infinitrade"]);
  });

  it("moves, nests and un-nests mixed core/plugin sections one level deep", () => {
    let state = mergeNavSidebarState(ownerLayout);
    const plugin = pluginSectionId("infinitrade");
    const ids = [...state.categories.map((category) => category.id), plugin];
    state = moveSection(state, "default-home", "down", ids);
    expect(state.sectionOrder.indexOf("default-home")).toBeGreaterThan(state.sectionOrder.indexOf("default-chat-&-voice"));
    state = nestSection(state, plugin, "default-work", ids);
    expect(sectionParent(state, plugin, ids)).toBe("default-work");
    // A nested section cannot become a parent; the one-level invariant holds.
    const unchanged = nestSection(state, "default-home", plugin, ids);
    expect(sectionParent(unchanged, "default-home", ids)).toBeNull();
    state = unnestSection(state, plugin);
    expect(sectionParent(state, plugin, ids)).toBeNull();
  });

  it("moves a plugin page into a core section using a durable override", () => {
    const state = moveTabToSection(
      mergeNavSidebarState(ownerLayout),
      "infinitrade",
      "default-work",
    );
    expect(state.categories.find((category) => category.id === "default-work")?.tabs).toContain("infinitrade");
    expect(state.tabSectionOverrides.infinitrade).toBe("default-work");
  });

  it("migrates the owner's real prior layout and round-trips all legacy and new fields", () => {
    let state = mergeNavSidebarState(ownerLayout);
    expect(state.layoutVersion).toBe(NAV_LAYOUT_VERSION);
    expect(state.tabCustomNames).toEqual(ownerLayout.tabCustomNames);
    expect(state.pluginSections).toEqual(ownerLayout.pluginSections);
    expect(state.categories.map((category) => category.id)).toEqual(ownerLayout.categories.map((category: { id: string }) => category.id));
    state = addFavorite(state, "dashboard");
    state = nestSection(state, "default-settings", "default-agents", state.categories.map((category) => category.id));
    saveNavSidebarState(state);
    const loaded = loadNavSidebarState();
    expect(loaded.favorites).toEqual(["dashboard"]);
    expect(loaded.sectionParents).toEqual({ "default-settings": "default-agents" });
    expect(loaded.tabCustomNames).toEqual(ownerLayout.tabCustomNames);
    expect(loaded.pluginSections).toEqual(ownerLayout.pluginSections);
  });

  it.runIf(existsSync(liveOwnerLayoutPath))(
    "migrates a read-only copy of the owner's current saved layout from a temporary state dir",
    () => {
      const stateDir = mkdtempSync(path.join(os.tmpdir(), "nav-owner-copy-"));
      try {
        const copied = path.join(stateDir, "ui", "nav-sidebar.json");
        mkdirSync(path.dirname(copied), { recursive: true });
        copyFileSync(liveOwnerLayoutPath, copied);
        const raw = JSON.parse(readFileSync(copied, "utf8"));
        const migrated = mergeNavSidebarState(raw);
        expect(migrated.layoutVersion).toBe(NAV_LAYOUT_VERSION);
        expect(migrated.tabCustomNames).toEqual(raw.tabCustomNames);
        expect(migrated.pluginSections).toEqual(raw.pluginSections);
        expect(migrated.categories.length).toBeGreaterThan(0);
        expect(readFileSync(liveOwnerLayoutPath, "utf8")).toBe(readFileSync(copied, "utf8"));
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );
});
