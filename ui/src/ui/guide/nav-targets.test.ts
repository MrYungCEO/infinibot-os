import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { TAB_PATHS, matchRoute } from "../navigation";
import { deriveNavTargets } from "./derive-nav-targets";

const here = dirname(fileURLToPath(import.meta.url));
const JSON_PATH = resolve(here, "../../../../src/ui-targets/generated/nav-targets.json");

describe("nav-derived UI targets", () => {
  const targets = deriveNavTargets();

  it("committed nav-targets.json matches navigation.ts (regenerate with UPDATE_UI_TARGETS=1)", () => {
    const body = `${JSON.stringify({ generatedFrom: "ui/src/ui/guide/derive-nav-targets.ts", targets }, null, 2)}\n`;
    if (process.env.UPDATE_UI_TARGETS === "1" || !existsSync(JSON_PATH)) writeFileSync(JSON_PATH, body);
    // Structural compare: the repo formatter may re-wrap the committed JSON.
    expect(JSON.parse(readFileSync(JSON_PATH, "utf8"))).toEqual(JSON.parse(body));
  });

  it("ids and aliases are unique", () => {
    const seen = new Map<string, string>();
    for (const t of targets) {
      for (const k of [t.id, ...(t.aliases ?? [])]) {
        expect(seen.get(k), `${k} claimed by ${seen.get(k)} and ${t.id}`).toBeUndefined();
        seen.set(k, t.id);
      }
    }
  });

  it("every page / sub-tab route resolves to its own tab", () => {
    const pages = targets.filter((t) => t.route);
    expect(pages.length).toBeGreaterThan(60);
    for (const t of pages) {
      const url = new URL(`http://x${t.route}`);
      const m = matchRoute(url.pathname);
      expect(m.tab, `${t.id} → ${t.route}`).toBeTruthy();
      expect(Object.values(TAB_PATHS)).toContain(url.pathname);
    }
  });

  it("covers plugins, setup coders, api keys, sidebar and topbar chat", () => {
    const ids = new Set(targets.map((t) => t.id));
    for (const id of ["page:plugins", "nav:sidebar/plugins", "page:setup/coders", "page:apikeys", "nav:sidebar/mesh", "control:topbar/chat", "control:topbar/approvals"]) {
      expect(ids.has(id), id).toBe(true);
    }
    // Plugins is its own Home page (no longer a Setup sub-tab).
    const plugins = targets.find((t) => t.id === "page:plugins")!;
    expect(plugins.route).toBe("/plugins");
  });
});
