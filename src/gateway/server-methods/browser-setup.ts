/**
 * Server method for the /browser setup view.
 *
 * `browser.setup.status` returns everything the UI needs to paint the
 * page in one round-trip: Chrome binary detection, Playwright presence,
 * relay-extension manifest location, infini profile state, list of all
 * profiles, list of snapshots.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";

import type { GatewayRequestHandlers } from "./types.js";
import {
  chromeProfileRoot,
  describeProfile,
  listProfiles,
  listSnapshots,
} from "../../browser/manager.js";
import {
  chromeWebStoreUrl,
  ensureInstalledExtension,
  installedExtensionDir,
  visibleExtensionDir,
  readExtensionManifest,
  resolveBundledExtensionDir,
  resolveBundledExtensionZip,
} from "../../browser/extension-assets.js";
import { INFINI_PROFILE_NAME } from "../../browser/profiles/types.js";

const CHROME_BINARIES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "brave-browser",
  "microsoft-edge",
  "thorium-browser",
];

interface ChromeDetection {
  found: boolean;
  path?: string;
  version?: string;
  brand?: string;
}

async function detectChrome(): Promise<ChromeDetection> {
  for (const bin of CHROME_BINARIES) {
    const full = await which(bin);
    if (!full) continue;
    const version = await safeVersion(bin);
    return {
      found: true,
      path: full,
      version,
      brand: brandFromBin(bin),
    };
  }
  return { found: false };
}

function brandFromBin(bin: string): string {
  if (bin.startsWith("google-chrome")) return "Google Chrome";
  if (bin.startsWith("chromium")) return "Chromium";
  if (bin.startsWith("brave")) return "Brave";
  if (bin.startsWith("microsoft-edge")) return "Microsoft Edge";
  if (bin.startsWith("thorium")) return "Thorium";
  return bin;
}

async function which(bin: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("which", [bin], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf-8");
    });
    child.on("error", () => resolve(undefined));
    child.on("exit", (code) => {
      resolve(code === 0 ? stdout.trim() || undefined : undefined);
    });
  });
}

async function safeVersion(bin: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf-8");
    });
    child.on("error", () => resolve(undefined));
    child.on("exit", () => {
      resolve(stdout.trim().split("\n")[0] || undefined);
    });
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 3_000);
  });
}

function detectPlaywright(): { found: boolean; version?: string } {
  // Resolve from the gateway's own module graph first: the desktop app runs
  // the gateway with cwd = the state dir, so cwd/node_modules is empty there.
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("playwright-core/package.json");
    const raw = JSON.parse(fs.readFileSync(pkg, "utf-8")) as { version?: string };
    return { found: true, version: raw.version };
  } catch {
    /* fall back to cwd */
  }
  try {
    const pkg = path.join(process.cwd(), "node_modules", "playwright-core", "package.json");
    if (fs.existsSync(pkg)) {
      const raw = JSON.parse(fs.readFileSync(pkg, "utf-8")) as { version?: string };
      return { found: true, version: raw.version };
    }
  } catch {
    /* ignore */
  }
  return { found: false };
}

export type RelayExtensionStatus = {
  found: boolean;
  /** Folder to give Chrome's "Load unpacked" (the stable copy when it exists). */
  path?: string;
  version?: string;
  /** Read-only copy that ships with this install. */
  bundledPath?: string;
  /** Stable, user-visible copy (e.g. ~/InfiniBot/browser-extension). */
  installedPath?: string;
  /** Old hidden copy under the state dir, when it still exists. */
  legacyPath?: string;
  /** Chrome Web Store listing, when one is configured (preferred install route). */
  webStoreUrl?: string;
  installed?: boolean;
  zipPath?: string;
  error?: string;
};

function detectRelayExtension(opts?: { install?: boolean; force?: boolean }): RelayExtensionStatus {
  // The extension ships in assets/chrome-extension/ (repo, npm package, and
  // resources/app/ in the desktop app). Mirror it into a visible folder in the
  // user's home (dot folders / AppData are hidden in Chrome's folder picker),
  // keeping the old hidden state-dir copy in sync for existing installs.
  const bundledPath = resolveBundledExtensionDir() ?? undefined;
  const installedPath = visibleExtensionDir();
  const legacy = installedExtensionDir();
  const webStoreUrl = chromeWebStoreUrl();
  let error: string | undefined;
  if (opts?.install) {
    try {
      ensureInstalledExtension({ sourceDir: bundledPath ?? null, force: opts.force });
    } catch (err) {
      error = (err as Error).message ?? String(err);
    }
  }
  const visible = readExtensionManifest(installedPath);
  const hidden = readExtensionManifest(legacy);
  const bundled = bundledPath ? readExtensionManifest(bundledPath) : null;
  const zipPath = resolveBundledExtensionZip(bundledPath ?? null) ?? undefined;
  const legacyPath = hidden ? legacy : undefined;
  const chosen = visible ? installedPath : hidden ? legacy : null;
  const chosenManifest = visible ?? hidden;
  if (chosen && chosenManifest) {
    return {
      found: true,
      path: chosen,
      version: chosenManifest.version,
      bundledPath,
      installedPath: chosen,
      legacyPath,
      webStoreUrl,
      installed: true,
      zipPath,
      error,
    };
  }
  if (bundled && bundledPath) {
    return {
      found: true,
      path: bundledPath,
      version: bundled.version,
      bundledPath,
      installedPath,
      webStoreUrl,
      installed: false,
      zipPath,
      error,
    };
  }
  return { found: false, installedPath, webStoreUrl, installed: false, error };
}

/** Open a folder in the OS file manager (gateway host). */
function revealFolder(dir: string): Promise<void> {
  const [cmd, args] =
    process.platform === "win32"
      ? ["explorer.exe", [dir]]
      : process.platform === "darwin"
        ? ["open", [dir]]
        : ["xdg-open", [dir]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", reject);
    child.unref();
    // explorer.exe exits 1 even on success; only a spawn failure counts.
    setTimeout(resolve, 300);
  });
}

export const browserSetupHandlers: GatewayRequestHandlers = {
  "browser.setup.status": async ({ respond }) => {
    try {
      const chrome = await detectChrome();
      const playwright = detectPlaywright();
      const extension = detectRelayExtension({ install: true });
      const infini = await describeProfile(INFINI_PROFILE_NAME);
      const profiles = await listProfiles();
      const snapshots = await listSnapshots();

      // Quick install commands per platform — the UI surfaces these as
      // copy-to-clipboard hints when Chrome isn't detected.
      const installHints = !chrome.found
        ? {
            apt: "sudo apt install chromium",
            pacman: "sudo pacman -S chromium",
            dnf: "sudo dnf install chromium",
            brew: "brew install --cask google-chrome",
            note: "Any Chromium-based browser works (Chrome, Chromium, Brave, Edge, Vivaldi, Thorium).",
          }
        : undefined;

      respond(true, {
        chrome,
        playwright,
        extension,
        infini: {
          name: infini.name,
          userDataDir: infini.userDataDir,
          exists: infini.exists,
          sizeBytes: infini.sizeBytes,
          lastUsedAt: infini.lastUsedAt,
        },
        profiles: profiles.map((p) => ({
          name: p.name,
          userDataDir: p.userDataDir,
          exists: p.exists,
          sizeBytes: p.sizeBytes,
          lastUsedAt: p.lastUsedAt,
        })),
        snapshots: snapshots.map((s) => ({
          profile: s.profile,
          path: s.path,
          id: s.id,
          size: s.size,
          createdAt: s.createdAt,
          label: s.label,
        })),
        paths: {
          profilesRoot: chromeProfileRoot(),
        },
        installHints,
      });
    } catch (err) {
      respond(false, undefined, {
        code: "BROWSER_SETUP_FAILED",
        message: (err as Error).message ?? String(err),
      });
    }
  },

  // Re-copy the bundled extension into the stable folder (the "Copy
  // extension folder" button). Returns the folder for "Load unpacked".
  "browser.setup.install_extension": async ({ respond }) => {
    try {
      const extension = detectRelayExtension({ install: true, force: true });
      if (!extension.found || extension.error) {
        respond(false, undefined, {
          code: "BROWSER_EXTENSION_MISSING",
          message:
            extension.error ??
            "This install has no InfiniBot Browser Relay extension. Reinstall InfiniBot and try again.",
        });
        return;
      }
      respond(true, { extension });
    } catch (err) {
      respond(false, undefined, {
        code: "BROWSER_EXTENSION_INSTALL_FAILED",
        message: (err as Error).message ?? String(err),
      });
    }
  },

  // "Open folder": reveal the extension folder in the file manager.
  "browser.setup.reveal_extension": async ({ respond }) => {
    try {
      const extension = detectRelayExtension({ install: true });
      if (!extension.found || !extension.path) {
        respond(false, undefined, {
          code: "BROWSER_EXTENSION_MISSING",
          message: "This install has no InfiniBot Browser Relay extension folder to open.",
        });
        return;
      }
      await revealFolder(extension.path);
      respond(true, { path: extension.path });
    } catch (err) {
      respond(false, undefined, {
        code: "BROWSER_EXTENSION_REVEAL_FAILED",
        message: `Could not open the folder: ${(err as Error).message ?? String(err)}`,
      });
    }
  },

  "browser.setup.create_infini": async ({ respond }) => {
    try {
      const { ensureProfile } = await import("../../browser/manager.js");
      const info = await ensureProfile(INFINI_PROFILE_NAME);
      respond(true, { profile: info });
    } catch (err) {
      respond(false, undefined, {
        code: "PROFILE_CREATE_FAILED",
        message: (err as Error).message ?? String(err),
      });
    }
  },

  "browser.setup.snapshot": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { profileName?: string; label?: string };
      const profileName = p.profileName ?? INFINI_PROFILE_NAME;
      const { snapshotProfile } = await import("../../browser/manager.js");
      const info = await snapshotProfile(profileName, p.label);
      respond(true, { snapshot: info });
    } catch (err) {
      respond(false, undefined, {
        code: "SNAPSHOT_FAILED",
        message: (err as Error).message ?? String(err),
      });
    }
  },

  "browser.setup.restore": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { archivePath?: string; profileName?: string };
      if (!p.archivePath) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "archivePath required" });
        return;
      }
      const { restoreProfileFromSnapshot } = await import("../../browser/manager.js");
      const result = await restoreProfileFromSnapshot(p.archivePath, p.profileName);
      respond(true, result);
    } catch (err) {
      respond(false, undefined, {
        code: "RESTORE_FAILED",
        message: (err as Error).message ?? String(err),
      });
    }
  },

  "browser.setup.delete_snapshot": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { archivePath?: string };
      if (!p.archivePath) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "archivePath required" });
        return;
      }
      const { deleteSnapshot } = await import("../../browser/manager.js");
      await deleteSnapshot(p.archivePath);
      respond(true, { ok: true, deleted: p.archivePath });
    } catch (err) {
      respond(false, undefined, {
        code: "DELETE_SNAPSHOT_FAILED",
        message: (err as Error).message ?? String(err),
      });
    }
  },

  "browser.setup.delete_profile": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { profileName?: string; confirmInfini?: boolean };
      if (!p.profileName) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "profileName required" });
        return;
      }
      const { deleteProfile } = await import("../../browser/manager.js");
      const result = await deleteProfile(p.profileName, { confirmInfini: p.confirmInfini });
      respond(true, result);
    } catch (err) {
      respond(false, undefined, {
        code: "DELETE_PROFILE_FAILED",
        message: (err as Error).message ?? String(err),
      });
    }
  },
};

// Surface a tiny helper for tests so they can poke the readiness check
// without booting the gateway.
export async function _browserSetupSnapshot(): Promise<{
  chrome: ChromeDetection;
  playwright: { found: boolean; version?: string };
  extension: RelayExtensionStatus;
  infiniExists: boolean;
}> {
  const chrome = await detectChrome();
  const playwright = detectPlaywright();
  const extension = detectRelayExtension();
  const dir = path.join(chromeProfileRoot(), INFINI_PROFILE_NAME);
  let infiniExists = false;
  try {
    const stat = await fsp.stat(dir);
    infiniExists = stat.isDirectory();
  } catch {
    /* not present */
  }
  return { chrome, playwright, extension, infiniExists };
}
