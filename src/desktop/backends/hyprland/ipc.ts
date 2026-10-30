/**
 * Hyprland IPC.
 *
 * Two transport paths:
 *   1. `hyprctl` shell-out for one-shot queries / dispatches. Used because it
 *      handles JSON serialization, dispatch quoting, and version skew across
 *      Hyprland releases (the underlying socket protocol is stable but
 *      hyprctl wraps the small differences).
 *   2. Direct connect to `$XDG_RUNTIME_DIR/hypr/$HIS/.socket2.sock` for the
 *      event stream (one event per line). Required because event subscription
 *      needs a long-lived connection — there's no hyprctl equivalent.
 *
 * No external dependencies — Node's net + child_process are enough.
 */

import { spawn } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import { EventEmitter } from "node:events";

export interface HyprMonitor {
  id: number;
  name: string;
  description?: string;
  make?: string;
  model?: string;
  serial?: string;
  width: number;
  height: number;
  refreshRate?: number;
  x: number;
  y: number;
  activeWorkspace?: { id: number; name: string };
  specialWorkspace?: { id: number; name: string };
  reserved?: [number, number, number, number];
  scale: number;
  transform?: number;
  focused: boolean;
  dpmsStatus?: boolean;
  vrr?: boolean;
}

export interface HyprWorkspace {
  id: number;
  name: string;
  monitor: string;
  monitorID?: number;
  windows: number;
  hasfullscreen: boolean;
  lastwindow: string;
  lastwindowtitle: string;
}

export interface HyprWindow {
  address: string; // hex string like "0x55a..."
  mapped: boolean;
  hidden: boolean;
  at: [number, number];
  size: [number, number];
  workspace: { id: number; name: string };
  floating: boolean;
  pseudo: boolean;
  monitor: number;
  class: string;
  title: string;
  initialClass?: string;
  initialTitle?: string;
  pid: number;
  xwayland: boolean;
  pinned: boolean;
  fullscreen?: number | boolean;
  fullscreenClient?: number;
  grouped?: string[];
  tags?: string[];
  swallowing?: string;
  focusHistoryID?: number;
}

export interface HyprctlError extends Error {
  stderr?: string;
  code?: number;
}

function hyprSocketDir(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  const his = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  if (!runtime) throw new Error("XDG_RUNTIME_DIR not set; not in a Hyprland session?");
  if (!his) throw new Error("HYPRLAND_INSTANCE_SIGNATURE not set; not in a Hyprland session?");
  return path.join(runtime, "hypr", his);
}

export function hyprCommandSocketPath(): string {
  return path.join(hyprSocketDir(), ".socket.sock");
}

export function hyprEventSocketPath(): string {
  return path.join(hyprSocketDir(), ".socket2.sock");
}

/**
 * Run `hyprctl <args>` and return parsed stdout. If `json` is true we add `-j`
 * and JSON.parse. Times out at `timeoutMs` (default 5s).
 */
export async function hyprctl<T = unknown>(
  args: string[],
  opts: { json?: boolean; timeoutMs?: number; instance?: string } = {},
): Promise<T> {
  const { json = false, timeoutMs = 5_000, instance } = opts;
  const finalArgs = [...args];
  if (json) finalArgs.unshift("-j");
  if (instance) finalArgs.unshift("-i", instance);

  return new Promise((resolve, reject) => {
    const child = spawn("hyprctl", finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      const err: HyprctlError = new Error(
        `hyprctl ${args.join(" ")} timed out after ${timeoutMs}ms`,
      );
      reject(err);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      const e = err as HyprctlError;
      e.stderr = stderr;
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        const err: HyprctlError = new Error(
          `hyprctl ${args.join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`,
        );
        err.code = code;
        err.stderr = stderr;
        reject(err);
        return;
      }
      const trimmed = stdout.trim();
      if (json) {
        if (!trimmed) {
          resolve(undefined as T);
          return;
        }
        try {
          resolve(JSON.parse(trimmed) as T);
        } catch (parseErr) {
          reject(
            new Error(
              `hyprctl ${args.join(" ")} returned invalid JSON: ${(parseErr as Error).message}\nstdout: ${trimmed}`,
            ),
          );
        }
      } else {
        resolve(trimmed as unknown as T);
      }
    });
  });
}

export async function listMonitors(): Promise<HyprMonitor[]> {
  const monitors = await hyprctl<HyprMonitor[]>(["monitors"], { json: true });
  return Array.isArray(monitors) ? monitors : [];
}

export async function listWorkspaces(): Promise<HyprWorkspace[]> {
  const ws = await hyprctl<HyprWorkspace[]>(["workspaces"], { json: true });
  return Array.isArray(ws) ? ws : [];
}

export async function listClients(): Promise<HyprWindow[]> {
  const cs = await hyprctl<HyprWindow[]>(["clients"], { json: true });
  return Array.isArray(cs) ? cs : [];
}

export async function getActiveWindow(): Promise<HyprWindow | null> {
  try {
    const w = await hyprctl<HyprWindow>(["activewindow"], { json: true });
    if (!w || typeof w !== "object" || !("address" in w)) return null;
    return w;
  } catch {
    return null;
  }
}

export async function getActiveWorkspace(): Promise<HyprWorkspace | null> {
  try {
    const ws = await hyprctl<HyprWorkspace>(["activeworkspace"], { json: true });
    if (!ws || typeof ws !== "object" || !("id" in ws)) return null;
    return ws;
  } catch {
    return null;
  }
}

export async function dispatch(cmd: string, args: string[] = []): Promise<string> {
  const argstr = args.length > 0 ? `${cmd} ${args.join(" ")}` : cmd;
  return hyprctl<string>(["dispatch", argstr]);
}

export async function batchDispatch(commands: string[]): Promise<string> {
  if (commands.length === 0) return "";
  const joined = commands.map((c) => `dispatch ${c}`).join("; ");
  return hyprctl<string>(["--batch", joined]);
}

export async function notify(
  icon: number,
  timeMs: number,
  color: string,
  fontSize: number,
  text: string,
): Promise<string> {
  return hyprctl<string>([
    "notify",
    String(icon),
    String(timeMs),
    color,
    `fontsize:${fontSize} ${text}`,
  ]);
}

export async function notifySimple(text: string, timeMs = 3_000): Promise<string> {
  return hyprctl<string>(["notify", "1", String(timeMs), "0", text]);
}

export async function setKeyword(name: string, value: string): Promise<string> {
  return hyprctl<string>(["keyword", name, value]);
}

/**
 * Hyprland 0.45+ removed the `windowrulev2` keyword — `windowrule` IS v2 now.
 * Calling `hyprctl keyword windowrulev2 ...` on those versions poisons the
 * in-memory config so the next reload drops to defaults. Resolve once per
 * process, fall back to v2 syntax only if version probe fails (older runtimes).
 */
let _ruleKeywordPromise: Promise<"windowrule" | "windowrulev2"> | undefined;
export function windowRuleKeyword(): Promise<"windowrule" | "windowrulev2"> {
  if (_ruleKeywordPromise) return _ruleKeywordPromise;
  _ruleKeywordPromise = hyprctl<string>(["version"])
    .then((out) => {
      const m = /^Hyprland\s+(\d+)\.(\d+)/m.exec(String(out));
      if (!m) return "windowrulev2" as const;
      const major = Number(m[1]);
      const minor = Number(m[2]);
      return major > 0 || minor >= 45 ? ("windowrule" as const) : ("windowrulev2" as const);
    })
    .catch(() => "windowrulev2" as const);
  return _ruleKeywordPromise;
}

/**
 * Subscribe to the Hyprland event stream. Returns an EventEmitter that emits
 * named events parsed from each line of `.socket2.sock`. Hyprland event lines
 * are formatted as `EVENT>>ARGS` where ARGS is comma-separated.
 *
 * Use `subscriber.close()` to disconnect. The emitter also emits `error` and
 * `close` for transport failures.
 */
export class HyprEventStream extends EventEmitter {
  private socket: net.Socket | undefined;
  private buffer = "";
  private closing = false;

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(hyprEventSocketPath(), () => {
        this.socket = sock;
        sock.setEncoding("utf-8");
        sock.on("data", (chunk: string | Buffer) => this.onData(chunk.toString()));
        sock.on("error", (err) => {
          if (!this.closing) this.emit("error", err);
        });
        sock.on("close", () => {
          this.socket = undefined;
          this.emit("close");
        });
        resolve();
      });
      sock.once("error", (err) => {
        if (!this.socket) reject(err);
      });
    });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      this.parseLine(line);
    }
  }

  private parseLine(line: string) {
    if (!line) return;
    const sep = line.indexOf(">>");
    if (sep < 0) return;
    const event = line.slice(0, sep);
    const argstr = line.slice(sep + 2);
    const args = argstr.length > 0 ? argstr.split(",") : [];
    this.emit(event, args, argstr);
    this.emit("event", { event, args, raw: line });
  }

  close() {
    this.closing = true;
    if (this.socket) {
      this.socket.destroy();
      this.socket = undefined;
    }
  }
}

export async function subscribe(): Promise<HyprEventStream> {
  const stream = new HyprEventStream();
  await stream.connect();
  return stream;
}
