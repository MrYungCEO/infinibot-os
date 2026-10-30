import { describe, expect, it } from "vitest";
import { useBundledPlugins } from "../../test/helpers/bundled-plugins.js";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPluginAutoEnable, hasExistingProductsData } from "./plugin-auto-enable.js";

useBundledPlugins();

describe("applyPluginAutoEnable", () => {
  it("enables Product Studio when the local studio store has projects, and respects an explicit disable", () => {
    const home = mkdtempSync(join(tmpdir(), "infinibot-monsoon-home-"));
    const stateDir = mkdtempSync(join(tmpdir(), "infinibot-monsoon-state-"));
    const env = { HOME: home, INFINIBOT_STATE_DIR: stateDir };
    expect(
      applyPluginAutoEnable({ config: {}, env }).config.plugins?.entries?.["monsoon-studio"],
    ).toBeUndefined();
    const projects = join(home, ".local", "share", "monsoon-studio", "projects");
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, "p1.json"), "{}");
    const result = applyPluginAutoEnable({ config: {}, env });
    expect(result.config.plugins?.entries?.["monsoon-studio"]?.enabled).toBe(true);
    expect(result.changes.join("\n")).toContain("Monsoon studio projects found");
    const disabled = applyPluginAutoEnable({
      config: { plugins: { entries: { "monsoon-studio": { enabled: false } } } },
      env,
    });
    expect(disabled.config.plugins?.entries?.["monsoon-studio"]?.enabled).toBe(false);
  });

  it("keeps Whiteboard off when a fresh state directory has no scenes", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "infinibot-whiteboard-fresh-"));
    const result = applyPluginAutoEnable({ config: {}, env: { INFINIBOT_STATE_DIR: stateDir } });
    expect(result.config.plugins?.entries?.whiteboard?.enabled).toBeUndefined();
    expect(result.changes.join("\n")).not.toContain("whiteboard");
  });

  it("enables Whiteboard once when legacy scene data exists", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "infinibot-whiteboard-auto-enable-"));
    const legacy = join(stateDir, "files", "whiteboards");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "existing.excalidraw"), "{}");
    const result = applyPluginAutoEnable({ config: {}, env: { INFINIBOT_STATE_DIR: stateDir } });
    expect(result.config.plugins?.entries?.whiteboard?.enabled).toBe(true);
  });

  it("enables Whiteboard when migrated plugin data already exists", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "infinibot-whiteboard-plugin-data-"));
    const boards = join(stateDir, "plugin-data", "whiteboard", "boards");
    mkdirSync(boards, { recursive: true });
    writeFileSync(join(boards, "existing.excalidraw"), "{}");
    const result = applyPluginAutoEnable({ config: {}, env: { INFINIBOT_STATE_DIR: stateDir } });
    expect(result.config.plugins?.entries?.whiteboard?.enabled).toBe(true);
  });

  it("does not re-enable Whiteboard after an explicit disable", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "infinibot-whiteboard-disabled-"));
    const legacy = join(stateDir, "files", "whiteboards");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "existing.excalidraw"), "{}");
    const result = applyPluginAutoEnable({
      config: { plugins: { entries: { whiteboard: { enabled: false } } } },
      env: { INFINIBOT_STATE_DIR: stateDir },
    });
    expect(result.config.plugins?.entries?.whiteboard?.enabled).toBe(false);
  });
  it("enables configured channel plugins and updates allowlist", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { allow: ["telegram"] },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.slack?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["telegram", "slack"]);
    expect(result.changes.join("\n")).toContain("Slack configured, not enabled yet.");
  });

  it("respects explicit disable", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { entries: { slack: { enabled: false } } },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.slack?.enabled).toBe(false);
    expect(result.changes).toEqual([]);
  });

  it("enables provider auth plugins when profiles exist", () => {
    const result = applyPluginAutoEnable({
      config: {
        auth: {
          profiles: {
            "google-antigravity:default": {
              provider: "google-antigravity",
              mode: "oauth",
            },
          },
        },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.["google-antigravity-auth"]?.enabled).toBe(true);
  });

  it("skips when plugins are globally disabled", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { enabled: false },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.slack?.enabled).toBeUndefined();
    expect(result.changes).toEqual([]);
  });

  it("keeps Products off for an empty fresh state", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "products-fresh-"));
    const result = applyPluginAutoEnable({ config: {}, env: {}, stateDir });
    expect(result.config.plugins?.entries?.products).toBeUndefined();
    expect(hasExistingProductsData(stateDir)).toBe(false);
  });

  it("auto-enables Products once for a legacy portfolio with rows", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "products-existing-"));
    const db = new Database(join(stateDir, "product.db"));
    db.exec("CREATE TABLE products (id TEXT PRIMARY KEY); INSERT INTO products VALUES ('p1')");
    db.close();

    const result = applyPluginAutoEnable({ config: {}, env: {}, stateDir });
    expect(result.config.plugins?.entries?.products?.enabled).toBe(true);
    expect(result.changes.join("\n")).toContain(
      "existing Products catalog or portfolio data found",
    );
  });

  it("never overrides an explicit Products disable even when data exists", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "products-disabled-"));
    const db = new Database(join(stateDir, "product.db"));
    db.exec("CREATE TABLE products (id TEXT PRIMARY KEY); INSERT INTO products VALUES ('p1')");
    db.close();

    const result = applyPluginAutoEnable({
      config: { plugins: { entries: { products: { enabled: false } } } },
      env: {},
      stateDir,
    });
    expect(result.config.plugins?.entries?.products?.enabled).toBe(false);
    expect(result.changes).toEqual([]);
  });

  describe("preferOver channel prioritization", () => {
    it("prefers bluebubbles: skips imessage auto-enable when both are configured", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            bluebubbles: { serverUrl: "http://localhost:1234", password: "x" },
            imessage: { cliPath: "/usr/local/bin/imsg" },
          },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.bluebubbles?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.imessage?.enabled).toBeUndefined();
      expect(result.changes.join("\n")).toContain("bluebubbles configured, not enabled yet.");
      expect(result.changes.join("\n")).not.toContain("iMessage configured, not enabled yet.");
    });

    it("keeps imessage enabled if already explicitly enabled (non-destructive)", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            bluebubbles: { serverUrl: "http://localhost:1234", password: "x" },
            imessage: { cliPath: "/usr/local/bin/imsg" },
          },
          plugins: { entries: { imessage: { enabled: true } } },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.bluebubbles?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.imessage?.enabled).toBe(true);
    });

    it("allows imessage auto-enable when bluebubbles is explicitly disabled", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            bluebubbles: { serverUrl: "http://localhost:1234", password: "x" },
            imessage: { cliPath: "/usr/local/bin/imsg" },
          },
          plugins: { entries: { bluebubbles: { enabled: false } } },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.bluebubbles?.enabled).toBe(false);
      expect(result.config.plugins?.entries?.imessage?.enabled).toBe(true);
      expect(result.changes.join("\n")).toContain("iMessage configured, not enabled yet.");
    });

    it("allows imessage auto-enable when bluebubbles is in deny list", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            bluebubbles: { serverUrl: "http://localhost:1234", password: "x" },
            imessage: { cliPath: "/usr/local/bin/imsg" },
          },
          plugins: { deny: ["bluebubbles"] },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.bluebubbles?.enabled).toBeUndefined();
      expect(result.config.plugins?.entries?.imessage?.enabled).toBe(true);
    });

    it("enables imessage normally when only imessage is configured", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: { imessage: { cliPath: "/usr/local/bin/imsg" } },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.imessage?.enabled).toBe(true);
      expect(result.changes.join("\n")).toContain("iMessage configured, not enabled yet.");
    });
  });
});
