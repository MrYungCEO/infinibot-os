/**
 * Hyprland screen capture via grim (and optionally slurp for region select).
 *
 * grim writes PNG to a file path or stdout. We always write to a file because
 * the existing screen_analyze tool consumes a path via imageResultFromFile.
 *
 * Region selection is interactive — slurp blocks for user input. The capture
 * tool exposes an `interactive_region` mode for that, but the screen_analyze
 * facade only uses non-interactive monitor capture.
 */

import { spawn } from "node:child_process";

import type { HyprMonitor } from "./ipc.js";

export interface GrimCaptureOpts {
  output?: string; // monitor name (HDMI-A-1, eDP-1, etc.) → grim -o
  geometry?: { x: number; y: number; width: number; height: number };
  cursor?: boolean;
  scale?: number;
  quality?: number; // for jpg only; ignored for png
}

export class GrimError extends Error {
  constructor(
    message: string,
    readonly stderr?: string,
  ) {
    super(message);
    this.name = "GrimError";
  }
}

export async function grim(
  outPath: string,
  opts: GrimCaptureOpts = {},
  timeoutMs = 8_000,
): Promise<void> {
  const args: string[] = [];
  if (opts.output) {
    args.push("-o", opts.output);
  }
  if (opts.geometry) {
    const g = opts.geometry;
    args.push("-g", `${g.x},${g.y} ${g.width}x${g.height}`);
  }
  if (typeof opts.scale === "number") {
    args.push("-s", String(opts.scale));
  }
  if (opts.cursor) {
    args.push("-c");
  }
  args.push(outPath);

  return new Promise((resolve, reject) => {
    const child = spawn("grim", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new GrimError(`grim timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new GrimError(err.message, stderr));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new GrimError(`grim exited ${code}: ${stderr.trim()}`, stderr));
      }
    });
  });
}

export async function slurpRegion(
  timeoutMs = 30_000,
): Promise<{ x: number; y: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("slurp", [], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`slurp timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`slurp exited ${code}: ${stderr.trim()}`));
        return;
      }
      // slurp output: "X,Y WxH"
      const match = stdout.trim().match(/^(-?\d+),(-?\d+)\s+(\d+)x(\d+)$/);
      if (!match) {
        reject(new Error(`unparseable slurp output: ${stdout.trim()}`));
        return;
      }
      resolve({
        x: parseInt(match[1], 10),
        y: parseInt(match[2], 10),
        width: parseInt(match[3], 10),
        height: parseInt(match[4], 10),
      });
    });
  });
}

export async function captureMonitor(monitor: HyprMonitor, outPath: string): Promise<void> {
  await grim(outPath, { output: monitor.name });
}

export async function captureRegion(
  geometry: { x: number; y: number; width: number; height: number },
  outPath: string,
): Promise<void> {
  await grim(outPath, { geometry });
}

export async function captureAll(outPath: string): Promise<void> {
  await grim(outPath, {});
}
