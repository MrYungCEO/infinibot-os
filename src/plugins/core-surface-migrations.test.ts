import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { InfinibotConfig } from "../config/config.js";
import {
  applyCoreSurfacePluginMigrations,
  disciplineHasExistingData,
} from "./core-surface-migrations.js";

const Database = createRequire(import.meta.url)("better-sqlite3");

let stateDir: string;

function makeDisciplineDb(file: string, opts: { blocks?: number; events?: number }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`CREATE TABLE discipline_blocks (id TEXT PRIMARY KEY, label TEXT);
           CREATE TABLE discipline_logs (id TEXT PRIMARY KEY);
           CREATE TABLE discipline_templates (id TEXT PRIMARY KEY);
           CREATE TABLE discipline_routine_completions (id TEXT PRIMARY KEY);
           CREATE TABLE discipline_events (id TEXT PRIMARY KEY);`);
  for (let i = 0; i < (opts.blocks ?? 0); i++)
    db.prepare("INSERT INTO discipline_blocks VALUES (?, ?)").run(`b${i}`, "Deep work");
  for (let i = 0; i < (opts.events ?? 0); i++)
    db.prepare("INSERT INTO discipline_events VALUES (?)").run(`e${i}`);
  db.close();
}

const run = (config: InfinibotConfig = {} as InfinibotConfig) =>
  applyCoreSurfacePluginMigrations({ config, stateDir });

const markers = () =>
  JSON.parse(fs.readFileSync(path.join(stateDir, "plugin-migrations.json"), "utf-8"));

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-mig-"));
});
afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

describe("core surface → plugin migrations (discipline)", () => {
  it("fresh install: no data → stays off, recorded once", () => {
    const res = run();
    expect(res.changes).toEqual([]);
    expect(res.config.plugins?.entries?.discipline).toBeUndefined();
    expect(markers()["core-surface:discipline"].result).toBe("no-data");
  });

  it("existing install with time blocks → enabled", () => {
    makeDisciplineDb(path.join(stateDir, "discipline.db"), { blocks: 3 });
    const res = run();
    expect(res.changes).toHaveLength(1);
    expect(res.config.plugins?.entries?.discipline).toEqual({ enabled: true });
  });

  it("only auto-logged events (never used the page) → stays off", () => {
    makeDisciplineDb(path.join(stateDir, "discipline.db"), { events: 50 });
    expect(disciplineHasExistingData(stateDir)).toBe(false);
    expect(run().changes).toEqual([]);
  });

  it("data already moved into plugin-data counts too", () => {
    makeDisciplineDb(path.join(stateDir, "plugin-data", "discipline", "discipline.db"), {
      blocks: 1,
    });
    expect(disciplineHasExistingData(stateDir)).toBe(true);
  });

  it("a focus board with items counts", () => {
    fs.writeFileSync(path.join(stateDir, "focus.json"), JSON.stringify({ items: [{ id: "t1" }] }));
    expect(disciplineHasExistingData(stateDir)).toBe(true);
  });

  it("owner's explicit choice is never overridden", () => {
    makeDisciplineDb(path.join(stateDir, "discipline.db"), { blocks: 3 });
    const cfg = { plugins: { entries: { discipline: { enabled: false } } } } as InfinibotConfig;
    const res = run(cfg);
    expect(res.changes).toEqual([]);
    expect(res.config.plugins?.entries?.discipline).toEqual({ enabled: false });
    expect(markers()["core-surface:discipline"].result).toBe("explicit");
  });

  it("runs once: a later 'no-data' marker is not revisited", () => {
    run();
    makeDisciplineDb(path.join(stateDir, "discipline.db"), { blocks: 3 });
    expect(run().changes).toEqual([]);
  });

  it("adds the plugin to an existing allowlist", () => {
    makeDisciplineDb(path.join(stateDir, "discipline.db"), { blocks: 1 });
    const cfg = { plugins: { allow: ["robovoice"] } } as InfinibotConfig;
    expect(run(cfg).config.plugins?.allow).toEqual(["robovoice", "discipline"]);
  });
});

describe("core surface migrations: Canvas Library (folded in at release/docs-5)", () => {
  function makeCanvasDb(rows: number) {
    const db = new Database(path.join(stateDir, "canvas-library.db"));
    db.exec("CREATE TABLE canvas_library (id TEXT PRIMARY KEY)");
    for (let i = 0; i < rows; i++) db.prepare("INSERT INTO canvas_library VALUES (?)").run(`c${i}`);
    db.close();
  }

  it("keeps canvas-library ON when saved canvases exist; discipline stays off without data", () => {
    makeCanvasDb(2);
    const res = run();
    expect(res.config.plugins?.entries?.["canvas-library"]).toMatchObject({ enabled: true });
    expect(res.config.plugins?.entries?.discipline).toBeUndefined();
    expect(markers()["core-surface:discipline"]).toMatchObject({ result: "no-data" });
  });

  it("an empty library (table, no rows) stays off and is recorded", () => {
    makeCanvasDb(0);
    const res = run();
    expect(res.changes).toEqual([]);
    expect(markers()["core-surface:canvas-library"]).toMatchObject({ result: "no-data" });
  });
});

describe("core surface → plugin migrations (hosted fleet tenant dirs)", () => {
  it("data only in a tenant namespace dir → enabled, marker stays in the shared dir", () => {
    const tenantDir = path.join(stateDir, "users", "t_abc");
    makeDisciplineDb(path.join(tenantDir, "discipline.db"), { blocks: 1 });
    expect(run().config.plugins?.entries?.discipline).toBeUndefined();
    fs.rmSync(path.join(stateDir, "plugin-migrations.json"));
    const res = applyCoreSurfacePluginMigrations({
      config: {} as InfinibotConfig,
      stateDir,
      extraDataDirs: [tenantDir],
    });
    expect(res.config.plugins?.entries?.discipline).toEqual({ enabled: true });
    expect(fs.existsSync(path.join(tenantDir, "plugin-migrations.json"))).toBe(false);
  });
});
