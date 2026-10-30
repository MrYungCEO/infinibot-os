/**
 * Linux overlay notifications — the missing peer of the macOS `system.notify`
 * overlay handler.
 *
 * `deliverNotification()` renders a gold-on-black InfiniBot notification panel
 * as a floating layer-shell window on Hyprland (via the short-lived
 * `extensions/infinibot-overlay/notify-overlay.py` script) and falls back to
 * `notify-send` (libnotify) when gtk-layer-shell isn't available or when the
 * caller asks for plain `system` delivery.
 *
 * Delivery modes (mirrors the macOS handler + the `--delivery` CLI flag):
 *   - "overlay"  → always render the layer-shell panel; structured install
 *                  hint if neither overlay nor libnotify is available.
 *   - "system"   → always use notify-send (libnotify).
 *   - "auto"     → prefer overlay when this node is the focused user device
 *                  (Hyprland session active), else fall back to system.
 *
 * This module is intentionally framework-free and shares one implementation
 * between the agent tool (`overlay_notify`) and the node-host `system.notify`
 * command handler. Spawn / environment probes are injectable so the dispatch
 * logic is unit-testable without a GTK display.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

export type NotifyPriority = "passive" | "active" | "timeSensitive";
export type NotifyDelivery = "system" | "overlay" | "auto";
export type NotifyAnchor = "top-right" | "top-left" | "bottom-right" | "bottom-left" | "top-center";

export interface NotifyOptions {
  title?: string;
  body?: string;
  /** canberra sound event id (overlay) / hint only (libnotify). */
  sound?: string;
  priority?: NotifyPriority;
  delivery?: NotifyDelivery;
  /** Auto-dismiss after this many ms. Default depends on priority (12000). */
  timeoutMs?: number;
  anchor?: NotifyAnchor;
  /** Same key within the dedupe window (60s) suppresses duplicates. */
  idempotencyKey?: string;
}

export interface NotifyResult {
  ok: boolean;
  /** Which channel actually delivered (or would have). */
  delivery: "overlay" | "system" | "none";
  deduped?: boolean;
  pid?: number;
  error?: string;
  code?: string;
  hint?: string;
}

export const OVERLAY_INSTALL_HINT =
  "Install gtk-layer-shell for overlay notifications " +
  "(Debian/Ubuntu: sudo apt install gir1.2-gtklayershell-0.1 python3-gi python3-gi-cairo; " +
  "Arch: sudo pacman -S gtk-layer-shell python-gobject), " +
  "or libnotify for system fallback (Debian/Ubuntu: sudo apt install libnotify-bin; Arch: sudo pacman -S libnotify).";

const DEDUPE_WINDOW_MS = 60_000;
const READY_MARKER = "notify-overlay ready";
const OVERLAY_INSTALL_EXIT = 2;

/** idempotencyKey → last-delivery timestamp. Module-scoped on purpose: dedupe
 *  is per gateway/node-host process, matching how the macOS handler dedupes. */
const lastDelivered = new Map<string, number>();

export function isHyprlandSession(): boolean {
  return (
    process.platform === "linux" &&
    typeof process.env.HYPRLAND_INSTANCE_SIGNATURE === "string" &&
    process.env.HYPRLAND_INSTANCE_SIGNATURE.length > 0
  );
}

export function findNotifyScript(): string {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const candidates = [
    // dist/desktop/backends/hyprland/ OR src/desktop/backends/hyprland/
    // → ../../../../extensions/infinibot-overlay/notify-overlay.py
    path.resolve(
      here,
      "..",
      "..",
      "..",
      "..",
      "extensions",
      "infinibot-overlay",
      "notify-overlay.py",
    ),
    path.resolve(process.cwd(), "extensions", "infinibot-overlay", "notify-overlay.py"),
  ];
  for (const c of candidates) {
    if (fsSync.existsSync(c)) return c;
  }
  return candidates[0];
}

function resolveTimeoutMs(opts: NotifyOptions): number {
  if (typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) {
    return Math.floor(opts.timeoutMs);
  }
  switch (opts.priority) {
    case "timeSensitive":
      return 20_000;
    case "passive":
      return 8_000;
    default:
      return 12_000;
  }
}

function shouldPlaySound(opts: NotifyOptions): boolean {
  if (opts.priority === "active" || opts.priority === "timeSensitive") return true;
  return Boolean(opts.sound);
}

function resolveSoundId(opts: NotifyOptions): string {
  if (opts.sound && opts.sound.trim()) return opts.sound.trim();
  return opts.priority === "timeSensitive" ? "dialog-warning" : "message";
}

function notifySendUrgency(priority?: NotifyPriority): string {
  if (priority === "timeSensitive") return "critical";
  if (priority === "passive") return "low";
  return "normal";
}

export interface NotifyDeps {
  spawn: typeof nodeSpawn;
  isHyprland: () => boolean;
  /** Resolve a binary on PATH; returns absolute path or null. */
  whichBin: (bin: string) => string | null;
  now: () => number;
  scriptPath: () => string;
}

function defaultWhich(bin: string): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        if (fsSync.existsSync(candidate)) return candidate;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

const defaultDeps: NotifyDeps = {
  spawn: nodeSpawn,
  isHyprland: isHyprlandSession,
  whichBin: defaultWhich,
  now: () => Date.now(),
  scriptPath: findNotifyScript,
};

/**
 * Spawn the layer-shell notification panel. Resolves once the panel maps
 * (the `notify-overlay ready` stderr marker) or after a short grace period if
 * the process is still alive. Rejects with an OVERLAY_INSTALL_REQUIRED-coded
 * error if the script exits 2 (gtk-layer-shell missing).
 */
function spawnOverlay(opts: NotifyOptions, deps: NotifyDeps): Promise<{ pid?: number }> {
  const script = deps.scriptPath();
  if (!fsSync.existsSync(script)) {
    const err = new Error(`notify-overlay script not found at ${script}`) as Error & {
      code?: string;
    };
    err.code = "OVERLAY_SCRIPT_MISSING";
    return Promise.reject(err);
  }
  const payload = {
    title: opts.title ?? "",
    body: opts.body ?? "",
    timeout_ms: resolveTimeoutMs(opts),
    anchor: opts.anchor ?? "top-right",
    priority: opts.priority ?? "active",
    play_sound: shouldPlaySound(opts),
    sound: resolveSoundId(opts),
  };
  return new Promise((resolve, reject) => {
    const child: ChildProcess = deps.spawn("python3", [script], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
      env: { ...process.env, INFINIBOT_NOTIFY_JSON: JSON.stringify(payload) },
    });
    let stderr = "";
    let settled = false;
    const finishOk = () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve({ pid: child.pid });
    };
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf-8");
      if (stderr.includes(READY_MARKER)) finishOk();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      if (code === OVERLAY_INSTALL_EXIT) {
        const err = new Error(stderr.trim() || "gtk-layer-shell not installed") as Error & {
          code?: string;
        };
        err.code = "OVERLAY_INSTALL_REQUIRED";
        reject(err);
      } else {
        reject(new Error(`notify-overlay exited ${code}: ${stderr.trim() || "(no stderr)"}`));
      }
    });
    // Failsafe: the panel may map without us catching the marker in time.
    // If it's still running after the grace period, treat it as delivered.
    setTimeout(() => {
      if (!settled) finishOk();
    }, 1_500);
  });
}

function spawnLibnotify(opts: NotifyOptions, deps: NotifyDeps): Promise<{ pid?: number }> {
  const bin = deps.whichBin("notify-send");
  if (!bin) {
    const err = new Error("notify-send (libnotify) not installed") as Error & { code?: string };
    err.code = "LIBNOTIFY_MISSING";
    return Promise.reject(err);
  }
  const args = [
    "--app-name",
    "InfiniBot",
    "--urgency",
    notifySendUrgency(opts.priority),
    "--expire-time",
    String(resolveTimeoutMs(opts)),
    opts.title ?? "InfiniBot",
    opts.body ?? "",
  ];
  return new Promise((resolve, reject) => {
    const child = deps.spawn(bin, args, { stdio: "ignore", detached: true });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve({ pid: child.pid });
    });
  });
}

export async function deliverNotification(
  opts: NotifyOptions,
  overrides: Partial<NotifyDeps> = {},
): Promise<NotifyResult> {
  const deps: NotifyDeps = { ...defaultDeps, ...overrides };

  if (!opts.title?.trim() && !opts.body?.trim()) {
    return { ok: false, delivery: "none", error: "missing title or body", code: "INVALID_REQUEST" };
  }

  // Idempotency: same key within the dedupe window suppresses duplicates.
  const key = opts.idempotencyKey?.trim();
  if (key) {
    const last = lastDelivered.get(key);
    const nowTs = deps.now();
    // Opportunistic GC so the map can't grow unbounded.
    for (const [k, ts] of lastDelivered) {
      if (nowTs - ts > DEDUPE_WINDOW_MS) lastDelivered.delete(k);
    }
    if (typeof last === "number" && nowTs - last < DEDUPE_WINDOW_MS) {
      return { ok: true, delivery: "none", deduped: true };
    }
    lastDelivered.set(key, nowTs);
  }

  const delivery: NotifyDelivery = opts.delivery ?? "system";
  // "auto": prefer overlay only when this is the focused Hyprland device.
  const wantOverlay = delivery === "overlay" || (delivery === "auto" && deps.isHyprland());

  if (wantOverlay) {
    try {
      const { pid } = await spawnOverlay(opts, deps);
      return { ok: true, delivery: "overlay", pid };
    } catch (err) {
      const e = err as Error & { code?: string };
      // Overlay unavailable → fall back to libnotify (mirrors highlight tool
      // posture: degrade gracefully, surface a structured install hint).
      try {
        const { pid } = await spawnLibnotify(opts, deps);
        return { ok: true, delivery: "system", pid, hint: OVERLAY_INSTALL_HINT };
      } catch (err2) {
        const e2 = err2 as Error & { code?: string };
        return {
          ok: false,
          delivery: "none",
          error: `overlay failed (${e.message}); libnotify fallback failed (${e2.message})`,
          code: e.code ?? "OVERLAY_UNAVAILABLE",
          hint: OVERLAY_INSTALL_HINT,
        };
      }
    }
  }

  // delivery === "system", or "auto" on a non-Hyprland node.
  try {
    const { pid } = await spawnLibnotify(opts, deps);
    return { ok: true, delivery: "system", pid };
  } catch (err) {
    const e = err as Error & { code?: string };
    return {
      ok: false,
      delivery: "none",
      error: e.message,
      code: e.code ?? "LIBNOTIFY_MISSING",
      hint: OVERLAY_INSTALL_HINT,
    };
  }
}

/** Test-only: reset the dedupe cache between cases. */
export function __resetNotifyDedupe(): void {
  lastDelivered.clear();
}
