/**
 * Hyprland input dispatch.
 *
 * Text typing has two paths:
 *   1. `wtype` — Wayland-native, no uinput, no root, no daemon. Fast, but
 *      its virtual-keyboard transport sends keycodes that the active keymap
 *      then interprets, so on non-US layouts a literal "Yo!" can come out
 *      as digits. Primary path when available.
 *   2. `wl-copy` + `hyprctl dispatch sendshortcut CTRL,v` — layout-
 *      independent fallback. The paste happens at the editor layer, so the
 *      original Unicode arrives regardless of the keymap. Used transparently
 *      when wtype is missing/fails, or explicitly via `useClipboard`.
 *
 * Hotkeys use `hyprctl dispatch sendshortcut` targeted at a specific window
 * address — the compositor synthesizes the keybinding, so it survives focus
 * changes mid-flight and doesn't need ydotool.
 *
 * `ydotool` is only used when neither of the above can express the intent
 * (raw mouse clicks at coordinates, low-level key events for non-text flows).
 * It requires uinput permission (udev rule + user in `input` group) — we
 * detect availability and surface a structured error if missing.
 */

import { spawn } from "node:child_process";

import { dispatch } from "./ipc.js";
import { normalizeAddress } from "./state.js";

type InputTool = "wtype" | "ydotool" | "wl-copy";
const TOOL_PACKAGE: Record<InputTool, string> = {
  wtype: "wtype",
  ydotool: "ydotool",
  "wl-copy": "wl-clipboard",
};
const KNOWN_TOOLS = new Set<string>(Object.keys(TOOL_PACKAGE));

export class InputToolMissingError extends Error {
  constructor(
    readonly tool: InputTool,
    readonly hint?: string,
  ) {
    const pkg = TOOL_PACKAGE[tool];
    super(
      `${tool} is not installed${hint ? ": " + hint : ""}. Install it (apt: ${pkg}; pacman: ${pkg}) to use this capability.`,
    );
    this.name = "InputToolMissingError";
  }
}

async function spawnSimple(
  cmd: string,
  args: string[],
  stdin: string | undefined,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf-8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf-8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT" && KNOWN_TOOLS.has(cmd)) {
        reject(new InputToolMissingError(cmd as InputTool));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${cmd} exited ${code}: ${stderr.trim() || stdout.trim()}`));
      }
    });

    if (stdin !== undefined) {
      try {
        child.stdin.write(stdin);
        child.stdin.end();
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    } else {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
    }
  });
}

let wlCopyChecked = false;
let wlCopyOk = false;
async function hasWlCopy(): Promise<boolean> {
  if (wlCopyChecked) return wlCopyOk;
  try {
    await spawnSimple("which", ["wl-copy"], undefined, 2_000);
    wlCopyOk = true;
  } catch {
    wlCopyOk = false;
  }
  wlCopyChecked = true;
  return wlCopyOk;
}

export interface TypeTextOptions {
  /**
   * Force the wtype keycode-injection path. By default we prefer the
   * clipboard path because wtype types via the **active keymap** — on
   * non-US layouts it produces wrong characters (`Yo!` arrives as digits),
   * and worse, it doesn't error in those cases. The clipboard path is
   * layout-independent.
   *
   * Set this true only when the destination won't accept paste (some
   * games, some terminal modes) and you genuinely want simulated
   * keystrokes through the user's current keymap.
   */
  forceWtype?: boolean;
  /**
   * Force the clipboard path (wl-copy + Ctrl+V via sendshortcut).
   * Equivalent to leaving both flags unset on a system with wl-copy
   * installed — kept for explicit/legacy callers. If `forceWtype` is
   * also true, `forceWtype` wins.
   */
  useClipboard?: boolean;
  /** Window address for the paste shortcut; defaults to the active window. */
  windowAddress?: string;
}

/**
 * Type text into the focused widget. Defaults to the clipboard path
 * (layout-independent) whenever wl-copy is installed. Falls back to wtype
 * only if wl-copy is unavailable, or when the caller explicitly forces
 * wtype with `forceWtype: true`.
 */
export async function typeText(
  text: string,
  opts?: TypeTextOptions,
): Promise<"wtype" | "clipboard"> {
  if (text.length === 0) return "clipboard";

  // Explicit wtype request — useful for paste-hostile contexts.
  if (opts?.forceWtype) {
    await spawnSimple("wtype", ["--", text], undefined, 15_000);
    return "wtype";
  }

  // Default path: clipboard, when available. wtype is too unreliable on
  // non-US layouts to use as the default — it silently emits wrong
  // characters, which is the failure mode the user actually hits.
  if (await hasWlCopy()) {
    await typeViaClipboard(text, opts?.windowAddress);
    return "clipboard";
  }

  // wl-copy not installed: legacy fallback to wtype.
  try {
    await spawnSimple("wtype", ["--", text], undefined, 15_000);
    return "wtype";
  } catch (err) {
    if (err instanceof InputToolMissingError && err.tool === "wtype") {
      throw new InputToolMissingError(
        "wtype",
        "and wl-clipboard is also missing — install wl-clipboard (preferred, layout-independent) or wtype",
      );
    }
    throw err;
  }
}

/**
 * Type text by stuffing it into the wayland selection and sending Ctrl+V via
 * Hyprland's sendshortcut. Layout-independent because the paste is interpreted
 * by the editor, not the keymap.
 *
 * `wl-copy` daemonizes (it has to stay alive to serve the selection until
 * a client pastes it), so we **don't await its exit** — we spawn it,
 * stream the text via stdin, close stdin, then resolve as soon as we've
 * confirmed the child accepted our input. Trying to `await` the process
 * would hang for the full timeout in every clipboard-only flow.
 */
export async function typeViaClipboard(text: string, windowAddress?: string): Promise<void> {
  if (text.length === 0) return;
  if (!(await hasWlCopy())) {
    throw new InputToolMissingError("wl-copy");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("wl-copy", [], {
      stdio: ["pipe", "ignore", "pipe"],
      detached: true,
    });
    let settled = false;
    let stderr = "";
    const settle = () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    };
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf-8");
    });
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    // If wl-copy exits before we settle, it's a failure (it should
    // daemonize and stay alive). Most distros' wl-copy backgrounds itself
    // immediately so the child handle's "exit" fires fast; that's still
    // success because the selection is set.
    child.once("exit", (code) => {
      if (settled) return;
      if (code === 0) settle();
      else reject(new Error(`wl-copy exited ${code}: ${stderr.trim()}`));
    });
    try {
      child.stdin.write(text, () => {
        child.stdin.end(() => {
          // wl-copy backgrounds itself once stdin closes. The selection
          // is registered with the compositor before the child returns,
          // so we can move on immediately.
          settle();
        });
      });
    } catch (err) {
      if (!settled) {
        settled = true;
        reject(err as Error);
      }
    }
  });
  // Brief settle so the compositor sees the new selection before the paste
  // shortcut races it.
  await new Promise((r) => setTimeout(r, 40));
  const target = windowAddress ? `address:${normalizeAddress(windowAddress)}` : "activewindow";
  await dispatch(`sendshortcut CTRL,v,${target}`);
}

/**
 * Send a hotkey to the compositor. `keys` is in Hyprland's keysym format,
 * e.g. "CTRL,c" for Ctrl+C, "SUPER,RETURN" for Super+Return, "CTRL+SHIFT,T".
 * `windowAddress` (optional) targets a specific window; otherwise the
 * shortcut goes to whatever has focus.
 *
 * Hyprland's `sendshortcut` dispatcher signature:
 *   sendshortcut MOD,KEY,WINDOW
 * where WINDOW is "address:0x..." or empty for active.
 */
export async function sendHotkey(keys: string, windowAddress?: string): Promise<void> {
  const target = windowAddress ? `address:${normalizeAddress(windowAddress)}` : "activewindow";
  // Translate "CTRL,c" → "CTRL,c" (already in expected format) → final
  // "MOD,KEY,WINDOW" form.
  const parts = keys.split(",");
  if (parts.length < 2) {
    throw new Error(
      `invalid hotkey "${keys}" — expected "MODS,KEY" e.g. "CTRL,c" or "SUPER,RETURN"`,
    );
  }
  const arg = `${keys},${target}`;
  await dispatch(`sendshortcut ${arg}`);
}

/**
 * Move the mouse cursor to absolute compositor coordinates. Uses
 * `hyprctl dispatch movecursor`.
 */
export async function moveCursor(x: number, y: number): Promise<void> {
  await dispatch(`movecursor ${Math.round(x)} ${Math.round(y)}`);
}

/**
 * Click the mouse at the current cursor position. Tries Hyprland's native
 * `mouse:LMB`/`mouse:RMB` via sendshortcut first; falls back to ydotool if the
 * compositor refuses (older versions). Most users have ydotool not installed,
 * so we prefer the compositor path.
 */
export async function click(button: "left" | "right" | "middle" = "left"): Promise<void> {
  // Hyprland exposes mouse buttons via the "submap"/"mouse:" syntax in
  // sendshortcut. The simplest reliable path is `dispatch exec` to ydotool
  // OR `dispatch click`. Hyprland 0.40+ added a `clickwindow`/native click
  // dispatcher for some events; we try the most portable option first.
  try {
    // Attempt: hyprctl dispatch sendshortcut with mouse: prefix.
    const code = button === "left" ? "mouse:272" : button === "right" ? "mouse:273" : "mouse:274";
    await dispatch(`sendshortcut ,${code},activewindow`);
  } catch {
    // Fall back to ydotool if available; surface InputToolMissingError if
    // it isn't installed.
    const codeNum = button === "left" ? 0xc0 : button === "right" ? 0xc1 : 0xc2;
    await spawnSimple(
      "ydotool",
      ["click", `0x${codeNum.toString(16).toUpperCase()}`],
      undefined,
      5_000,
    );
  }
}

export async function clickAt(
  x: number,
  y: number,
  button: "left" | "right" | "middle" = "left",
): Promise<void> {
  await moveCursor(x, y);
  // Tiny settle delay so the compositor moves the cursor before the click.
  await new Promise((r) => setTimeout(r, 30));
  await click(button);
}
