/**
 * Windows-hardened-mode bootstrap.
 *
 * Call `applyWindowsHardenedBoot()` once near the top of the desktop main
 * process (before the gateway child is spawned).  On Windows it writes a
 * sentinel that the gateway reads to enable:
 *   - verbose logging on federation reconnect cycles
 *   - named-pipe IPC preference over loopback TCP
 *   - structured preflight check output in the gateway log
 *
 * On any non-Windows platform the call is a no-op so it is safe to call
 * unconditionally.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const SENTINEL_DIR = join(homedir(), ".infinibot");
const SENTINEL_PATH = join(SENTINEL_DIR, "windows-hardened-mode.json");

export interface WindowsHardenedSentinel {
  enabled: boolean;
  timestamp: number;
  electronVersion: string;
  nodeVersion: string;
}

/**
 * Write the sentinel file and set INFINIBOT_WINDOWS_HARDENED_MODE=1 so the
 * gateway child process inherits the flag.  Non-fatal on write failure.
 */
export function applyWindowsHardenedBoot(): void {
  if (platform() !== "win32") return;

  process.env["INFINIBOT_WINDOWS_HARDENED_MODE"] = "1";

  try {
    mkdirSync(SENTINEL_DIR, { recursive: true });
    const sentinel: WindowsHardenedSentinel = {
      enabled: true,
      timestamp: Date.now(),
      electronVersion: process.versions.electron ?? "unknown",
      nodeVersion: process.version,
    };
    writeFileSync(SENTINEL_PATH, JSON.stringify(sentinel, null, 2), "utf8");
  } catch {
    // Non-fatal: sentinel write failure does not block startup.
    // The env var is already set so the gateway will still see the flag.
  }
}

/**
 * True when the current process is running in Windows-hardened-mode.
 * Readable by gateway code that imports this module.
 */
export function isWindowsHardenedMode(): boolean {
  return process.env["INFINIBOT_WINDOWS_HARDENED_MODE"] === "1";
}
