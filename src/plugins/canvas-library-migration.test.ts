import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SavedCanvasStore } from "../canvas-host/saved-canvases.js";
import type { InfinibotConfig } from "../config/config.js";
import {
  applyCanvasLibraryMigration,
  canvasLibraryHasExistingData,
} from "./canvas-library-migration.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cl-mig-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function seed(n: number) {
  const s = new SavedCanvasStore(dir);
  for (let i = 0; i < n; i++) s.save({ title: `c${i}`, payload: { nodes: [], scenes: [] } });
  s.close();
}
const markers = () =>
  JSON.parse(fs.readFileSync(path.join(dir, "plugin-migrations.json"), "utf-8")) as Record<
    string,
    { result: string }
  >;

describe("canvas-library enablement migration", () => {
  it("detects saved canvases, not an empty or missing store", () => {
    expect(canvasLibraryHasExistingData(dir)).toBe(false);
    seed(0);
    expect(canvasLibraryHasExistingData(dir)).toBe(false);
    seed(1);
    expect(canvasLibraryHasExistingData(dir)).toBe(true);
  });

  it("fresh install: stays off and records no-data, so later canvases never flip it", () => {
    const first = applyCanvasLibraryMigration({ config: {}, stateDir: dir });
    expect(first.change).toBeNull();
    expect(markers()["core-surface:canvas-library"]?.result).toBe("no-data");
    seed(2); // e.g. work-review canvases saved while the plugin is off
    const second = applyCanvasLibraryMigration({ config: {}, stateDir: dir });
    expect(second.change).toBeNull();
    expect(second.config).toEqual({});
  });

  it("existing install with canvases: enabled once, allow-list extended, other entries kept", () => {
    seed(3);
    const config = {
      plugins: { allow: ["robovoice"], entries: { robovoice: { enabled: true } } },
    } as unknown as InfinibotConfig;
    const res = applyCanvasLibraryMigration({ config, stateDir: dir });
    expect(res.change).toMatch(/kept ON/);
    expect(res.config.plugins?.allow).toEqual(["robovoice", "canvas-library"]);
    expect(res.config.plugins?.entries?.["canvas-library"]).toEqual({ enabled: true });
    expect(res.config.plugins?.entries?.robovoice).toEqual({ enabled: true });
    // Re-run on the written config: explicit → recorded, no change (idempotent).
    const again = applyCanvasLibraryMigration({ config: res.config, stateDir: dir });
    expect(again.change).toBeNull();
    expect(markers()["core-surface:canvas-library"]?.result).toBe("explicit");
  });

  it("respects an explicit owner choice", () => {
    seed(1);
    const config = {
      plugins: { entries: { "canvas-library": { enabled: false } } },
    } as InfinibotConfig;
    const res = applyCanvasLibraryMigration({ config, stateDir: dir });
    expect(res.change).toBeNull();
    expect(res.config).toBe(config);
  });

  it("shares the marker file with other surface migrations", () => {
    fs.writeFileSync(
      path.join(dir, "plugin-migrations.json"),
      JSON.stringify({ "core-surface:discipline": { at: "x", result: "no-data" } }),
    );
    applyCanvasLibraryMigration({ config: {}, stateDir: dir });
    expect(Object.keys(markers()).sort()).toEqual([
      "core-surface:canvas-library",
      "core-surface:discipline",
    ]);
  });
});
