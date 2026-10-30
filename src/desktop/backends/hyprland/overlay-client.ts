/**
 * Client for the Python overlay daemon (extensions/infinibot-overlay).
 *
 * Speaks newline-delimited JSON over a Unix socket at
 * `$XDG_RUNTIME_DIR/infinibot-overlay.sock`. Auto-spawns the daemon if it's
 * not already running. Surfaces a structured error including the apt/pacman
 * install hint when the gtk-layer-shell typelib is missing.
 *
 * Public API: `getOverlayClient()` returns a singleton client; tools call
 * `addHighlight`, `clearHighlight`, `clearAll`, `enterPickMode`,
 * `exitPickMode`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as url from "node:url";

export interface HighlightGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HighlightStyle {
  type?: "ring" | "fill" | "label" | "pulse";
  color?: string;
  thickness?: number;
  label?: string;
  fill_alpha?: number;
  /** Where to draw the label/number badge: "corner" (default — top-left
   *  inset of the target, doesn't cover content) or "center". */
  badge_position?: "corner" | "center";
  /** Badge container styling: "pill" (rounded glass + gold gradient
   *  stroke, drop shadow — InfiniBot HUD look) or "flat" (legacy). */
  badge_style?: "pill" | "flat";
}

export interface PickWindow {
  id: string;
  label: string;
  geometry: HighlightGeometry;
}

/**
 * Pick-mode theme override. Applied uniformly to every numbered badge
 * the daemon paints during a single enter_pick_mode call. Defaults inside
 * the daemon are InfiniBot Gold + pill + corner; callers can override per
 * call for branded contexts or to fall back to the legacy look.
 */
export interface PickTheme {
  color?: string;
  thickness?: number;
  fill_alpha?: number;
  badge_position?: "corner" | "center";
  badge_style?: "pill" | "flat";
}

export class OverlayInstallError extends Error {
  readonly code = "OVERLAY_INSTALL_REQUIRED" as const;
  constructor(readonly hint: string) {
    super(`infinibot-overlay daemon requires gtk-layer-shell. ${hint}`);
    this.name = "OverlayInstallError";
  }
}

export class OverlayUnavailableError extends Error {
  readonly code = "OVERLAY_UNAVAILABLE" as const;
  constructor(message: string) {
    super(message);
    this.name = "OverlayUnavailableError";
  }
}

const SOCK_NAME = "infinibot-overlay.sock";

function socketPath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR ?? "/tmp";
  return path.join(runtime, SOCK_NAME);
}

function findOverlayScript(): string {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const candidates = [
    // From dist/desktop/backends/hyprland/ → ../../../../extensions/infinibot-overlay/
    path.resolve(
      here,
      "..",
      "..",
      "..",
      "..",
      "extensions",
      "infinibot-overlay",
      "overlay-daemon.py",
    ),
    // From src/desktop/backends/hyprland/ → ../../../../extensions/infinibot-overlay/
    path.resolve(
      here,
      "..",
      "..",
      "..",
      "..",
      "extensions",
      "infinibot-overlay",
      "overlay-daemon.py",
    ),
    path.resolve(process.cwd(), "extensions", "infinibot-overlay", "overlay-daemon.py"),
  ];
  for (const c of candidates) {
    if (fsSync.existsSync(c)) return c;
  }
  return candidates[0];
}

async function socketExists(): Promise<boolean> {
  try {
    const stat = await fs.stat(socketPath());
    return stat.isSocket();
  } catch {
    return false;
  }
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

class OverlayClient {
  private socket: net.Socket | undefined;
  private buffer = "";
  private pending: PendingRequest[] = [];
  private daemon: ChildProcess | undefined;
  private spawnHint: string | undefined;
  private connectPromise: Promise<void> | undefined;

  private async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connect().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async connect(): Promise<void> {
    if (!(await socketExists())) {
      await this.spawnDaemon();
    }
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(socketPath(), () => {
        this.socket = sock;
        sock.setEncoding("utf-8");
        sock.on("data", (chunk: string | Buffer) => this.onData(chunk.toString()));
        sock.on("error", () => {
          this.failPending(new Error("overlay socket error"));
          this.socket = undefined;
        });
        sock.on("close", () => {
          this.failPending(new Error("overlay socket closed"));
          this.socket = undefined;
        });
        resolve();
      });
      sock.once("error", (err) => {
        if (!this.socket) reject(err);
      });
      setTimeout(() => {
        if (!this.socket) reject(new Error("overlay connect timed out"));
      }, 5_000);
    });
  }

  private async spawnDaemon(): Promise<void> {
    const script = findOverlayScript();
    if (!fsSync.existsSync(script)) {
      throw new OverlayUnavailableError(
        `overlay daemon script not found at ${script} — did the install package the extensions/infinibot-overlay/ directory?`,
      );
    }
    return new Promise<void>((resolve, reject) => {
      const child = spawn("python3", [script], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      this.daemon = child;
      let stderr = "";
      child.stderr?.on("data", (b: Buffer) => {
        const s = b.toString("utf-8");
        stderr += s;
        if (s.includes("listening on")) {
          resolve();
        }
      });
      child.on("error", (err) => {
        reject(err);
      });
      child.on("exit", (code) => {
        if (code === 2) {
          this.spawnHint = stderr;
          reject(new OverlayInstallError(stderr.trim()));
        } else if (code !== 0 && code !== null) {
          reject(
            new OverlayUnavailableError(
              `overlay daemon exited ${code}: ${stderr.trim() || "(no stderr)"}`,
            ),
          );
        }
      });
      // Failsafe: don't hang forever if no "listening on" message appears.
      setTimeout(() => {
        if (this.daemon === child && !this.socket) {
          // Socket may already exist; try to connect anyway.
          void socketExists().then((ok) => {
            if (ok) resolve();
            else
              reject(
                new OverlayUnavailableError(
                  `overlay daemon did not start within timeout. stderr: ${stderr.trim()}`,
                ),
              );
          });
        }
      }, 4_000);
      child.unref();
    });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const req = this.pending.shift();
      if (!req) continue;
      clearTimeout(req.timer);
      try {
        req.resolve(JSON.parse(line) as Record<string, unknown>);
      } catch (err) {
        req.reject(err as Error);
      }
    }
  }

  private failPending(err: Error) {
    for (const p of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.length = 0;
  }

  private async send(
    msg: Record<string, unknown>,
    timeoutMs = 3_000,
  ): Promise<Record<string, unknown>> {
    await this.ensureConnected();
    if (!this.socket) throw new OverlayUnavailableError("overlay socket not available");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`overlay request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.push({ resolve, reject, timer });
      try {
        this.socket!.write(JSON.stringify(msg) + "\n");
      } catch (err) {
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  async ping(): Promise<boolean> {
    try {
      const r = await this.send({ op: "ping" });
      return r.ok === true;
    } catch {
      return false;
    }
  }

  async addHighlight(
    id: string,
    geometry: HighlightGeometry,
    style: HighlightStyle = {},
  ): Promise<Record<string, unknown>> {
    return this.send({ op: "add_highlight", id, geometry, style });
  }

  async clearHighlight(id: string): Promise<Record<string, unknown>> {
    return this.send({ op: "clear_highlight", id });
  }

  async clearAll(): Promise<Record<string, unknown>> {
    return this.send({ op: "clear_all" });
  }

  async enterPickMode(windows: PickWindow[], theme?: PickTheme): Promise<Record<string, unknown>> {
    return this.send({ op: "enter_pick_mode", windows, theme });
  }

  async exitPickMode(): Promise<Record<string, unknown>> {
    return this.send({ op: "exit_pick_mode" });
  }

  async shutdown(): Promise<void> {
    try {
      await this.send({ op: "shutdown" }, 1_000);
    } catch {
      /* expected on close */
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = undefined;
    }
  }
}

let shared: OverlayClient | undefined;

export async function getOverlayClient(): Promise<OverlayClient> {
  if (!shared) {
    shared = new OverlayClient();
  }
  await shared.ping().catch(() => {
    /* connect happens lazily on first real call */
  });
  return shared;
}

export async function disposeOverlayClient(): Promise<void> {
  if (shared) {
    await shared.shutdown();
    shared = undefined;
  }
}
