/**
 * `voice up` mode auto-pick.
 *
 *   explicit flag           → that mode
 *   any cloud key in env     → cloud
 *   Mac (Apple Silicon)      → native
 *   Linux + NVIDIA GPU       → native
 *   otherwise                → wizard  (prompt for cloud keys)
 *
 * Never silently picks CPU Whisper: a keyless, GPU-less machine goes to the
 * wizard, not to a slow CPU native install.
 */

import { execFileSync } from "node:child_process";

import { anyCloudKeyInEnv } from "./config.js";
import { isAppleSilicon } from "./native/paths.js";

export type PickedMode = "cloud" | "native" | "docker" | "wizard";

export interface ModeDecision {
  mode: PickedMode;
  reason: string;
}

export function hasNvidiaGpu(): boolean {
  if (process.platform !== "linux") return false;
  try {
    execFileSync("nvidia-smi", ["-L"], { stdio: "pipe", timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

export function autoPickMode(flag?: "cloud" | "native" | "docker"): ModeDecision {
  if (flag) return { mode: flag, reason: `--${flag} flag` };
  if (anyCloudKeyInEnv()) return { mode: "cloud", reason: "cloud API key found in environment" };
  if (isAppleSilicon()) return { mode: "native", reason: "Apple Silicon (Metal) detected" };
  if (hasNvidiaGpu()) return { mode: "native", reason: "Linux + NVIDIA GPU detected" };
  return { mode: "wizard", reason: "no cloud keys and no supported GPU — running setup wizard" };
}
