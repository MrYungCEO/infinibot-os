import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ensureInstalledExtension,
  installedExtensionDir,
  visibleExtensionDir,
  readExtensionManifest,
  resolveBundledExtensionDir,
  resolveBundledExtensionZip,
} from "./extension-assets.js";

const tmpDirs: string[] = [];
function tmp(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
function writeExtension(dir: string, version: string) {
  fs.mkdirSync(path.join(dir, "icons"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ manifest_version: 3, name: "InfiniBot Browser Relay", version }),
  );
  fs.writeFileSync(path.join(dir, "background.js"), `// v${version}\n`);
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("browser extension assets", () => {
  it("finds the bundled copy under the app root when cwd is elsewhere (packaged desktop app)", () => {
    // resources/app/{package.json,assets/chrome-extension}; gateway cwd = state dir.
    const appRoot = tmp("ib-app-");
    fs.writeFileSync(path.join(appRoot, "package.json"), JSON.stringify({ name: "infinibot" }));
    writeExtension(path.join(appRoot, "assets", "chrome-extension"), "9.9.9");
    fs.writeFileSync(path.join(appRoot, "assets", "infinibot-browser-relay.zip"), "zip");
    const prevCwd = process.cwd();
    process.chdir(tmp("ib-state-"));
    try {
      const dir = resolveBundledExtensionDir({ INFINIBOT_REPO_ROOT: appRoot });
      expect(dir).toBe(path.join(appRoot, "assets", "chrome-extension"));
      expect(resolveBundledExtensionZip(dir)).toBe(
        path.join(appRoot, "assets", "infinibot-browser-relay.zip"),
      );
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("ignores folders without a manifest v3", () => {
    const bad = tmp("ib-bad-");
    fs.writeFileSync(path.join(bad, "manifest.json"), JSON.stringify({ manifest_version: 2 }));
    expect(readExtensionManifest(bad)).toBeNull();
  });

  it("copies into the stable state-dir folder and refreshes it when the bundle changes", () => {
    const src = tmp("ib-src-");
    const stateDir = tmp("ib-statedir-");
    writeExtension(src, "1.0.0");

    const first = ensureInstalledExtension({ stateDir, sourceDir: src });
    expect(first).toMatchObject({
      path: installedExtensionDir(stateDir),
      version: "1.0.0",
      copied: true,
    });
    expect(fs.existsSync(path.join(first!.path, "background.js"))).toBe(true);

    const again = ensureInstalledExtension({ stateDir, sourceDir: src });
    expect(again?.copied).toBe(false);

    writeExtension(src, "1.0.1");
    const updated = ensureInstalledExtension({ stateDir, sourceDir: src });
    expect(updated).toMatchObject({ version: "1.0.1", copied: true });
    expect(fs.readFileSync(path.join(updated!.path, "background.js"), "utf-8")).toContain("1.0.1");
    // No temp folders left behind next to the install.
    expect(fs.readdirSync(path.dirname(updated!.path))).toEqual(["chrome-extension"]);
  });

  it("keeps an existing install when there is no bundled copy", () => {
    const stateDir = tmp("ib-statedir-");
    writeExtension(installedExtensionDir(stateDir), "2.0.0");
    expect(ensureInstalledExtension({ stateDir, sourceDir: null })).toMatchObject({
      version: "2.0.0",
      copied: false,
    });
    expect(ensureInstalledExtension({ stateDir: tmp("ib-empty-"), sourceDir: null })).toBeNull();
  });

  it("resolves the visible folder per OS", () => {
    expect(visibleExtensionDir({ platform: "linux", home: "/home/u", env: {} })).toBe(
      "/home/u/InfiniBot/browser-extension",
    );
    expect(visibleExtensionDir({ platform: "darwin", home: "/Users/u", env: {} })).toBe(
      "/Users/u/InfiniBot/Browser Extension",
    );
    expect(visibleExtensionDir({ platform: "win32", home: "C:\\Users\\u", env: {} })).toBe(
      "C:\\Users\\u\\Documents\\InfiniBot\\browser-extension",
    );
    const override = path.resolve("/tmp/custom-ext");
    expect(
      visibleExtensionDir({
        platform: "linux",
        home: "/home/u",
        env: { INFINIBOT_BROWSER_EXTENSION_VISIBLE_DIR: "/tmp/custom-ext" },
      }),
    ).toBe(override);
  });

  it("installs to the visible folder, keeps the legacy copy in sync, and migrates legacy-only installs", () => {
    const src = tmp("ib-src-");
    const stateDir = tmp("ib-statedir-");
    const visibleDir = path.join(tmp("ib-home-"), "InfiniBot", "browser-extension");
    writeExtension(src, "1.0.0");

    // Fresh install: only the visible folder is created.
    const fresh = ensureInstalledExtension({ stateDir, visibleDir, sourceDir: src });
    expect(fresh).toMatchObject({ path: visibleDir, version: "1.0.0", copied: true });
    expect(fresh?.legacyPath).toBeUndefined();
    expect(fs.existsSync(installedExtensionDir(stateDir))).toBe(false);

    // Existing install with a hidden copy and no bundle: migrate by copying.
    const state2 = tmp("ib-statedir-");
    const visible2 = path.join(tmp("ib-home-"), "InfiniBot", "browser-extension");
    writeExtension(installedExtensionDir(state2), "0.9.0");
    const migrated = ensureInstalledExtension({
      stateDir: state2,
      visibleDir: visible2,
      sourceDir: null,
    });
    expect(migrated).toMatchObject({ path: visible2, version: "0.9.0" });
    expect(fs.existsSync(path.join(visible2, "background.js"))).toBe(true);
    expect(fs.existsSync(installedExtensionDir(state2))).toBe(true);

    // Upgrade updates both so the old Chrome registration keeps working.
    const upgraded = ensureInstalledExtension({
      stateDir: state2,
      visibleDir: visible2,
      sourceDir: src,
    });
    expect(upgraded).toMatchObject({ path: visible2, version: "1.0.0", copied: true });
    expect(readExtensionManifest(installedExtensionDir(state2))?.version).toBe("1.0.0");
    expect(
      ensureInstalledExtension({ stateDir: state2, visibleDir: visible2, sourceDir: src })?.copied,
    ).toBe(false);
  });

  it("ships a branded manifest v3 extension in assets/", () => {
    const dir = path.resolve(__dirname, "..", "..", "assets", "chrome-extension");
    const manifest = readExtensionManifest(dir);
    expect(manifest?.name).toMatch(/^InfiniBot/);
    for (const size of [16, 32, 48, 128]) {
      expect(fs.existsSync(path.join(dir, "icons", `icon${size}.png`))).toBe(true);
    }
  });
});
