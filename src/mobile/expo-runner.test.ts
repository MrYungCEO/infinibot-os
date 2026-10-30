import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Control the package-root resolution so we can exercise each branch of
// resolveDefaultProjectDir() deterministically.
const mocks = vi.hoisted(() => ({
  resolveInfiniBotPackageRootSync: vi.fn<() => string | null>(),
}));

vi.mock("../infra/infinibot-root.js", () => ({
  resolveInfiniBotPackageRootSync: mocks.resolveInfiniBotPackageRootSync,
  resolveInfiniBotPackageRoot: vi.fn().mockResolvedValue(null),
}));

// tailscale is pulled in transitively by the runner; stub the one helper the
// module imports so the test doesn't shell out.
vi.mock("../infra/tailscale.js", () => ({
  getTailnetHostname: vi.fn().mockResolvedValue(null),
}));

import { resolveDefaultProjectDir } from "./expo-runner.js";

function writeExpoProject(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "app.json"), JSON.stringify({ expo: { name: "Infinibot" } }), "utf-8");
  return dir;
}

describe("resolveDefaultProjectDir", () => {
  let tmp: string;
  const savedEnv = {
    EXPO_PROJECT_DIR: process.env.EXPO_PROJECT_DIR,
    INFINIBOT_MOBILE_DIR: process.env.INFINIBOT_MOBILE_DIR,
    HOME: process.env.HOME,
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "expo-runner-test-"));
    delete process.env.EXPO_PROJECT_DIR;
    delete process.env.INFINIBOT_MOBILE_DIR;
    // Point HOME + cwd at empty dirs so neither the home-based nor the
    // cwd-sibling legacy candidates accidentally match real dirs on this box.
    process.env.HOME = join(tmp, "home-empty");
    mkdirSync(process.env.HOME, { recursive: true });
    const cwdEmpty = join(tmp, "cwd-empty");
    mkdirSync(cwdEmpty, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(cwdEmpty);
    mocks.resolveInfiniBotPackageRootSync.mockReset().mockReturnValue(null);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns the package-relative mobile/ dir when app.json exists there", () => {
    const root = join(tmp, "pkg");
    writeExpoProject(join(root, "mobile"));
    mocks.resolveInfiniBotPackageRootSync.mockReturnValue(root);

    expect(resolveDefaultProjectDir()).toBe(join(root, "mobile"));
  });

  it("honors EXPO_PROJECT_DIR over the package-relative dir", () => {
    const override = writeExpoProject(join(tmp, "override"));
    const root = join(tmp, "pkg");
    writeExpoProject(join(root, "mobile"));
    mocks.resolveInfiniBotPackageRootSync.mockReturnValue(root);

    process.env.EXPO_PROJECT_DIR = override;
    expect(resolveDefaultProjectDir()).toBe(override);
  });

  it("honors INFINIBOT_MOBILE_DIR as an alias env override", () => {
    const override = writeExpoProject(join(tmp, "alias"));
    process.env.INFINIBOT_MOBILE_DIR = override;
    expect(resolveDefaultProjectDir()).toBe(override);
  });

  it("falls back to a legacy candidate (with deprecation warning) when no env or package dir is valid", () => {
    // package root resolves but has no mobile/app.json → not an Expo project.
    mocks.resolveInfiniBotPackageRootSync.mockReturnValue(join(tmp, "pkg-no-mobile"));
    // Legacy candidate: <home>/infinibot.
    const home = join(tmp, "legacy-home");
    process.env.HOME = home;
    const legacy = writeExpoProject(join(home, "infinibot"));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveDefaultProjectDir()).toBe(legacy);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("deprecated");
  });

  it("returns the historical default when nothing matches", () => {
    const home = join(tmp, "nothing-home");
    process.env.HOME = home;
    mkdirSync(home, { recursive: true });
    const result = resolveDefaultProjectDir();
    expect(result).toBe(join(home, "infinibot"));
  });
});
