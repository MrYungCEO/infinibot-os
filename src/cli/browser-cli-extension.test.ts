import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const copyToClipboard = vi.fn();
const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../infra/clipboard.js", () => ({
  copyToClipboard,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtime,
}));

describe("browser extension install", () => {
  it("installs into the state dir (never node_modules)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "infinibot-ext-"));
    const { installChromeExtension } = await import("./browser-cli-extension.js");

    const sourceDir = path.resolve(process.cwd(), "assets/chrome-extension");
    const result = await installChromeExtension({ stateDir: tmp, sourceDir });

    expect(result.path).toBe(path.join(tmp, "browser", "chrome-extension"));
    expect(fs.existsSync(path.join(result.path, "manifest.json"))).toBe(true);
    expect(result.path.includes("node_modules")).toBe(false);
  });

  it("installs into a visible folder when one is given", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "infinibot-ext-vis-"));
    const visibleDir = path.join(tmp, "InfiniBot", "browser-extension");
    const { installChromeExtension } = await import("./browser-cli-extension.js");
    const sourceDir = path.resolve(process.cwd(), "assets/chrome-extension");
    const result = await installChromeExtension({ stateDir: tmp, visibleDir, sourceDir });
    expect(result.path).toBe(visibleDir);
    expect(fs.existsSync(path.join(visibleDir, "manifest.json"))).toBe(true);
  });

  it("copies extension path to clipboard", async () => {
    const prev = process.env.INFINIBOT_STATE_DIR;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "infinibot-ext-path-"));
    process.env.INFINIBOT_STATE_DIR = tmp;
    const prevVisible = process.env.INFINIBOT_BROWSER_EXTENSION_VISIBLE_DIR;
    process.env.INFINIBOT_BROWSER_EXTENSION_VISIBLE_DIR = path.join(tmp, "no-visible-copy");

    try {
      copyToClipboard.mockReset();
      copyToClipboard.mockResolvedValue(true);
      runtime.log.mockReset();
      runtime.error.mockReset();
      runtime.exit.mockReset();

      const dir = path.join(tmp, "browser", "chrome-extension");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3 }));

      vi.resetModules();
      const { Command } = await import("commander");
      const { registerBrowserExtensionCommands } = await import("./browser-cli-extension.js");

      const program = new Command();
      const browser = program.command("browser").option("--json", false);
      registerBrowserExtensionCommands(
        browser,
        (cmd) => cmd.parent?.opts?.() as { json?: boolean },
      );

      await program.parseAsync(["browser", "extension", "path"], { from: "user" });

      expect(copyToClipboard).toHaveBeenCalledWith(dir);
    } finally {
      if (prev === undefined) delete process.env.INFINIBOT_STATE_DIR;
      else process.env.INFINIBOT_STATE_DIR = prev;
      if (prevVisible === undefined) delete process.env.INFINIBOT_BROWSER_EXTENSION_VISIBLE_DIR;
      else process.env.INFINIBOT_BROWSER_EXTENSION_VISIBLE_DIR = prevVisible;
    }
  });
});
