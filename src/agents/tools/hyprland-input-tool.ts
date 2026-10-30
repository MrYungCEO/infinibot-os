/**
 * Hyprland input tool — type Unicode text into the focused widget, send
 * hotkeys to a target window via the compositor, move/click the mouse.
 *
 * The hotkey path uses Hyprland's native `dispatch sendshortcut` which means
 * it can target a specific window by address — focus changes mid-flight don't
 * steal the keypress.
 *
 * Mouse clicks fall back to ydotool only if the compositor refuses; for that
 * to work the user must have ydotool installed and uinput permitted (udev
 * rule + `input` group). The error message points the user at that.
 */

import { Type } from "@sinclair/typebox";

import {
  clickAt,
  moveCursor,
  sendHotkey,
  typeText,
} from "../../desktop/backends/hyprland/input.js";
import {
  getSharedWorld,
  normalizeAddress,
  type WindowSelector,
} from "../../desktop/backends/hyprland/state.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";

const HyprlandInputSchema = Type.Object({
  action: stringEnum([
    "type",
    "hotkey",
    "mouse_move",
    "mouse_click",
    "click_at",
    "click_window",
    "click_relative",
  ]),
  text: Type.Optional(Type.String({ description: "Text to type (action=type)" })),
  forceWtype: Type.Optional(
    Type.Boolean({
      description:
        "Force the wtype keycode path instead of the default clipboard paste. Default false. Use only when the destination refuses paste (some games, some terminal modes). wtype types through the active keymap, so on non-US layouts text comes out as wrong characters — and wtype does NOT error in those cases, it just silently mistypes. Keep this off unless you have a specific paste-hostile target.",
    }),
  ),
  useClipboard: Type.Optional(
    Type.Boolean({
      description:
        "Legacy/explicit alias for the clipboard path (now the default when wl-copy is installed). Kept for callers that want to be explicit; equivalent to leaving the flag unset.",
    }),
  ),
  keys: Type.Optional(
    Type.String({
      description:
        "Hyprland hotkey expression in 'MODS,KEY' form. Mods: SUPER, CTRL, ALT, SHIFT (combine with +). Examples: 'CTRL,c', 'CTRL+SHIFT,T', 'SUPER,RETURN'.",
    }),
  ),
  address: Type.Optional(
    Type.String({ description: "Target window address for hotkey (default: active window)" }),
  ),
  pid: Type.Optional(Type.Number({ description: "Target window pid (alternative to address)" })),
  classExact: Type.Optional(
    Type.String({ description: "Target window by class (alternative to address/pid)" }),
  ),
  titleContains: Type.Optional(Type.String({ description: "Target window by title substring" })),
  activeWindow: Type.Optional(Type.Boolean({ description: "Target the focused window" })),
  x: Type.Optional(Type.Number({ description: "Mouse X (mouse_move, click_at)" })),
  y: Type.Optional(Type.Number({ description: "Mouse Y (mouse_move, click_at)" })),
  fx: Type.Optional(
    Type.Number({
      description:
        "Fractional X (0.0–1.0) inside a window for click_relative. 0.5 = horizontal center.",
    }),
  ),
  fy: Type.Optional(
    Type.Number({
      description:
        "Fractional Y (0.0–1.0) inside a window for click_relative. 0.5 = vertical center.",
    }),
  ),
  focusFirst: Type.Optional(
    Type.Boolean({
      description:
        "For click_window / click_relative: focus the target window before the click (default true).",
    }),
  ),
  button: Type.Optional(stringEnum(["left", "right", "middle"])),
});

function buildSelector(params: Record<string, unknown>): WindowSelector | undefined {
  const sel: WindowSelector = {};
  const addr = readStringParam(params, "address");
  if (addr) sel.address = addr;
  const pid = readNumberParam(params, "pid", { integer: true });
  if (typeof pid === "number") sel.pid = pid;
  const classExact = readStringParam(params, "classExact");
  if (classExact) sel.classExact = classExact;
  const titleContains = readStringParam(params, "titleContains");
  if (titleContains) sel.titleContains = titleContains;
  if (params.activeWindow === true) sel.activeWindow = true;
  if (Object.keys(sel).length === 0) return undefined;
  return sel;
}

export function createHyprlandInputTool(): AnyAgentTool {
  return {
    label: "Hyprland Input",
    name: "hyprland_input",
    description: [
      "Send keyboard or mouse input on the Linux Hyprland desktop.",
      "Actions:",
      "  type — type Unicode text into the focused widget. Primary path is wl-copy + Ctrl+V via Hyprland sendshortcut — layout-independent and reliable. Falls back to wtype only when wl-copy isn't installed. Required: text. Optional: forceWtype (force the keycode-injection path — only useful when the destination won't accept paste; wtype types through the active keymap and silently mistypes on non-US layouts, so avoid unless necessary); a window selector (address/pid/classExact/titleContains/activeWindow) targets the paste at a specific window instead of focus.",
      "  hotkey — send a key combination to the compositor. Required: keys (e.g. 'CTRL,c', 'SUPER,RETURN', 'CTRL+SHIFT,T'). Optional selector: address/pid/classExact/titleContains; default is active window. Hyprland synthesizes the keybinding so it survives focus changes.",
      "  mouse_move — move cursor to absolute compositor coords (x, y).",
      "  click_at — move cursor to (x, y) and click. Optional: button ('left'|'right'|'middle', default 'left').",
      "  mouse_click — click at the current cursor position. Optional: button.",
      "  click_window — focus the target window and click its CENTER (no coordinate guessing). Required: a window selector (address/pid/classExact/titleContains/activeWindow). Optional: button, focusFirst (default true).",
      "  click_relative — focus the target window and click at fractional offset (fx, fy ∈ 0.0–1.0) within its bounds. fx=0.5,fy=0.5 is the center; fx=0.95,fy=0.05 is the top-right corner. Required: a selector + fx + fy.",
      "Linux/Hyprland only. At least one of wtype or wl-clipboard must be installed for typing; ydotool is only needed if the compositor's native click path fails.",
    ].join(" "),
    parameters: HyprlandInputSchema,
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      try {
        switch (action) {
          case "type": {
            const text = readStringParam(params, "text", { required: true, allowEmpty: true });
            const forceWtype = params.forceWtype === true;
            // useClipboard is now an explicit alias for "default clipboard
            // path" — it's been the default since the wtype-mistypes-on-
            // non-US-layouts fix. Keep accepting it for back-compat.
            const sel = buildSelector(params);
            let address: string | undefined;
            if (sel) {
              const world = await getSharedWorld();
              const w = world.findWindow(sel);
              if (!w) return jsonResult({ error: "no window matched the selector" });
              address = w.address;
            }
            const method = await typeText(text, { forceWtype, windowAddress: address });
            return jsonResult({
              ok: true,
              typed: text.length,
              sample: text.slice(0, 40),
              method,
              target: address ? normalizeAddress(address) : "focus",
            });
          }

          case "hotkey": {
            const keys = readStringParam(params, "keys", { required: true });
            const sel = buildSelector(params);
            let address: string | undefined;
            if (sel) {
              const world = await getSharedWorld();
              const w = world.findWindow(sel);
              if (!w) return jsonResult({ error: "no window matched the selector" });
              address = w.address;
            }
            await sendHotkey(keys, address);
            return jsonResult({
              ok: true,
              keys,
              target: address ? normalizeAddress(address) : "activewindow",
            });
          }

          case "mouse_move": {
            const x = readNumberParam(params, "x", { required: true })!;
            const y = readNumberParam(params, "y", { required: true })!;
            await moveCursor(x, y);
            return jsonResult({ ok: true, x, y });
          }

          case "click_at": {
            const x = readNumberParam(params, "x", { required: true })!;
            const y = readNumberParam(params, "y", { required: true })!;
            const button =
              (readStringParam(params, "button") as "left" | "right" | "middle" | undefined) ??
              "left";
            await clickAt(x, y, button);
            return jsonResult({ ok: true, x, y, button });
          }

          case "mouse_click": {
            const button =
              (readStringParam(params, "button") as "left" | "right" | "middle" | undefined) ??
              "left";
            const { click } = await import("../../desktop/backends/hyprland/input.js");
            await click(button);
            return jsonResult({ ok: true, button });
          }

          case "click_window": {
            // Resolve the target window, focus it, then click its center.
            // Removes the "where exactly?" guesswork — the agent gives an
            // address (or any selector) and we land in the middle of it.
            const sel = buildSelector(params);
            if (!sel) {
              return jsonResult({
                error:
                  "click_window requires a window selector (address/pid/classExact/titleContains/activeWindow)",
              });
            }
            const world = await getSharedWorld();
            const w = world.findWindow(sel);
            if (!w) return jsonResult({ error: "no window matched the selector" });
            const button =
              (readStringParam(params, "button") as "left" | "right" | "middle" | undefined) ??
              "left";
            const focusFirst = params.focusFirst !== false;
            const cx = Math.round(w.at[0] + w.size[0] / 2);
            const cy = Math.round(w.at[1] + w.size[1] / 2);
            if (focusFirst) {
              const { focusWindow } = await import("../../desktop/backends/hyprland/dispatch.js");
              await focusWindow(w.address);
            }
            await clickAt(cx, cy, button);
            return jsonResult({
              ok: true,
              address: normalizeAddress(w.address),
              x: cx,
              y: cy,
              button,
            });
          }

          case "click_relative": {
            // Click at fractional offset (fx, fy ∈ [0,1]) inside the
            // window's bounds. Lets the agent express intent like "the
            // upper-right area" without depending on the user's monitor
            // layout or the window's current position.
            const sel = buildSelector(params);
            if (!sel) {
              return jsonResult({
                error: "click_relative requires a window selector and fx/fy",
              });
            }
            const fx = readNumberParam(params, "fx");
            const fy = readNumberParam(params, "fy");
            if (typeof fx !== "number" || typeof fy !== "number") {
              return jsonResult({ error: "fx and fy are required (0.0–1.0)" });
            }
            const clampedFx = Math.max(0, Math.min(1, fx));
            const clampedFy = Math.max(0, Math.min(1, fy));
            const world = await getSharedWorld();
            const w = world.findWindow(sel);
            if (!w) return jsonResult({ error: "no window matched the selector" });
            const button =
              (readStringParam(params, "button") as "left" | "right" | "middle" | undefined) ??
              "left";
            const focusFirst = params.focusFirst !== false;
            const cx = Math.round(w.at[0] + w.size[0] * clampedFx);
            const cy = Math.round(w.at[1] + w.size[1] * clampedFy);
            if (focusFirst) {
              const { focusWindow } = await import("../../desktop/backends/hyprland/dispatch.js");
              await focusWindow(w.address);
            }
            await clickAt(cx, cy, button);
            return jsonResult({
              ok: true,
              address: normalizeAddress(w.address),
              x: cx,
              y: cy,
              fx: clampedFx,
              fy: clampedFy,
              button,
            });
          }

          default:
            return jsonResult({ error: `unknown action: ${action}` });
        }
      } catch (err: unknown) {
        const e = err as { code?: string; capability?: string; message?: string; tool?: string };
        return jsonResult({
          error: e?.message ?? String(err),
          code: e?.code,
          capability: e?.capability,
          tool: e?.tool,
          action,
        });
      }
    },
  };
}
