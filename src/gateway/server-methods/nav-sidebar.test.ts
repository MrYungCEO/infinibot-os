import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { navSidebarHandlers, parseNavSidebarFile } from "./nav-sidebar.js";

const cat = (id: string, label: string, tabs: string[], isCustom = false) => ({
  id,
  label,
  collapsed: false,
  position: 0,
  tabs,
  isCustom,
});
const SHORT = {
  categories: [
    cat("default-home", "Home", ["dashboard"]),
    cat("custom-1", "Revenue", ["clients", "business"], true),
  ],
  hiddenTabs: [],
  tabCustomNames: { business: "Sales Pipeline" },
  layoutVersion: "2026.09.26-consolidated",
};
const LONG = {
  categories: [
    cat("default-home", "Home", ["dashboard", "learn"]),
    cat("default-chat", "Chat", ["voicecommands", "webchat", "grid"]),
    cat("default-media", "Media", ["image-studio", "storyboard", "design"]),
    cat("default-system", "System", [
      "credits",
      "mobilepage",
      "config",
      "components",
      "plugins",
      "debug",
    ]),
  ],
  hiddenTabs: ["docs"],
  tabCustomNames: { "command-ops": 'Ops "quoted" {brace}' },
};

const prevState = process.env.INFINIBOT_STATE_DIR;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  if (prevState === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = prevState;
});

function call(method: string, params: Record<string, unknown> = {}, authUser?: string) {
  return new Promise<{ ok: boolean; payload: unknown }>((resolve) => {
    void navSidebarHandlers[method]!({
      req: { type: "req", id: "1", method },
      params,
      client: authUser ? ({ authUser, connId: `test-${authUser}`, connect: {} } as never) : null,
      isWebchatConnect: () => false,
      respond: (ok: boolean, payload: unknown) => resolve({ ok, payload }),
      context: {} as never,
    } as never);
  });
}

describe("nav sidebar persistence", () => {
  it("recovers the current layout from a file torn by two overlapping writes", () => {
    // What a short write over a longer file left behind (seen on a live install).
    const long = JSON.stringify(LONG, null, 2);
    const short = JSON.stringify(SHORT, null, 2);
    const torn = short + long.slice(short.length);
    expect(() => JSON.parse(torn)).toThrow();
    expect(parseNavSidebarFile(torn)).toEqual(SHORT);
  });

  it("parses clean files and rejects garbage", () => {
    expect(parseNavSidebarFile(JSON.stringify(LONG))).toEqual(LONG);
    expect(parseNavSidebarFile("not json")).toBeNull();
    expect(parseNavSidebarFile('{"categories": 1} trailing')).toBeNull();
  });

  it("concurrent saves never interleave bytes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nav-sb-"));
    dirs.push(dir);
    process.env.INFINIBOT_STATE_DIR = dir;
    await Promise.all([
      call("nav.sidebar.set", { state: LONG }),
      call("nav.sidebar.set", { state: SHORT }),
      call("nav.sidebar.set", { state: LONG }),
      call("nav.sidebar.set", { state: SHORT }),
    ]);
    const raw = fs.readFileSync(path.join(dir, "ui", "nav-sidebar.json"), "utf8");
    expect(JSON.parse(raw)).toEqual(SHORT); // last write wins, whole
    expect(fs.readdirSync(path.join(dir, "ui")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect((await call("nav.sidebar.get")).payload).toEqual({ state: SHORT });
  });

  it("round-trips favorites and hierarchy, then backs up before reset", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nav-sb-roundtrip-"));
    dirs.push(dir);
    process.env.INFINIBOT_STATE_DIR = dir;
    const extended = {
      ...SHORT,
      layoutVersion: "2026.09.30-favorites-hierarchy",
      favorites: ["dashboard", "infinitrade"],
      favoritesCollapsed: true,
      sectionOrder: ["default-home", "plugin:infinitrade", "custom-1"],
      sectionParents: { "plugin:infinitrade": "custom-1" },
      tabSectionOverrides: { infinitrade: "custom-1" },
    };
    expect((await call("nav.sidebar.set", { state: extended })).ok).toBe(true);
    expect((await call("nav.sidebar.get")).payload).toEqual({ state: extended });

    const reset = { ...LONG, favorites: [], sectionOrder: LONG.categories.map((c) => c.id) };
    const response = await call("nav.sidebar.reset", { state: reset });
    expect(response.ok).toBe(true);
    expect((response.payload as { backup: string }).backup).toMatch(/^nav-sidebar\..+\.json$/);
    const backups = fs.readdirSync(path.join(dir, "ui", "backups"));
    expect(backups).toHaveLength(1);
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, "ui", "backups", backups[0]!), "utf8")),
    ).toEqual(extended);
    expect((await call("nav.sidebar.get")).payload).toEqual({ state: reset });
  });

  it("scopes authenticated users independently and inherits the legacy layout once", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nav-sb-users-"));
    dirs.push(dir);
    process.env.INFINIBOT_STATE_DIR = dir;
    await call("nav.sidebar.set", { state: LONG });
    // Alice gets a private copy of the legacy layout on first read.
    expect((await call("nav.sidebar.get", {}, "alice@example.com")).payload).toEqual({
      state: LONG,
    });
    await call("nav.sidebar.set", { state: SHORT }, "alice@example.com");
    await call(
      "nav.sidebar.set",
      { state: { ...SHORT, favorites: ["dashboard"] } },
      "bob@example.com",
    );
    expect((await call("nav.sidebar.get", {}, "alice@example.com")).payload).toEqual({
      state: SHORT,
    });
    expect((await call("nav.sidebar.get", {}, "bob@example.com")).payload).toEqual({
      state: { ...SHORT, favorites: ["dashboard"] },
    });
    // The old single-user file remains untouched for password/token installs.
    expect((await call("nav.sidebar.get")).payload).toEqual({ state: LONG });
  });
});
