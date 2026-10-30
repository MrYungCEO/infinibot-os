/**
 * Hyprland window tool — query and manipulate Hyprland windows by stable
 * address. Operates on the cached HyprlandWorld so list/info are O(1).
 *
 * Verbs:
 *   list       — current visible windows + addresses + workspace + monitor
 *   info       — full record for one window (selected by address/pid/regex)
 *   focus      — focus window by address/class/title
 *   close      — close window
 *   move       — move to monitor / workspace / apply AppPosition
 *   fullscreen — fullscreen on current or specified monitor
 *   pin        — toggle pinned (always-visible)
 *   resize     — explicit pixel geometry
 *
 * Linux/Hyprland only. Returns NotSupportedError on other platforms.
 */

import { Type } from "@sinclair/typebox";

import {
  applyPositionToWindow,
  closeWindowByAddress,
  focusWindow,
  forceFloating,
  forceTiled,
  fullscreenWindow,
  moveWindowToMonitor,
  moveWindowToWorkspace,
  pinWindow,
  toggleFloating,
} from "../../desktop/backends/hyprland/dispatch.js";
import { batchDispatch } from "../../desktop/backends/hyprland/ipc.js";
import {
  getSharedWorld,
  normalizeAddress,
  type WindowSelector,
} from "../../desktop/backends/hyprland/state.js";
import { APP_POSITIONS, type AppPosition } from "../../desktop/apps-store.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";

const HyprlandWindowSchema = Type.Object({
  action: stringEnum([
    "list",
    "info",
    "focus",
    "close",
    "move",
    "place",
    "fullscreen",
    "maximize",
    "pin",
    "resize",
    "toggleFloating",
    "float",
    "tile",
  ]),
  address: Type.Optional(
    Type.String({ description: "Window address (hex, e.g. 0x55a...) from a previous list result" }),
  ),
  pid: Type.Optional(Type.Number({ description: "Process id of the target window" })),
  classExact: Type.Optional(
    Type.String({ description: "Match window by exact class name (e.g. 'firefox')" }),
  ),
  classRegex: Type.Optional(Type.String({ description: "Match window class by JS regex" })),
  titleContains: Type.Optional(
    Type.String({ description: "Substring match against window title (case-insensitive)" }),
  ),
  titleRegex: Type.Optional(Type.String({ description: "Match window title by JS regex" })),
  activeWindow: Type.Optional(
    Type.Boolean({ description: "Operate on the currently focused window" }),
  ),
  workspace: Type.Optional(
    Type.Union([Type.Number(), Type.String()], {
      description: "Workspace id, name, or relative ('+1', '-1') for move",
    }),
  ),
  display: Type.Optional(
    Type.Number({
      description:
        "Monitor id for move/fullscreen/place (0-based Hyprland monitor.id — same value `hyprctl monitors` prints)",
    }),
  ),
  screen: Type.Optional(
    Type.Number({
      description: "Alias for `display`. 0-based Hyprland monitor.id. Use with action='place'.",
    }),
  ),
  position: Type.Optional(stringEnum([...APP_POSITIONS])),
  verify: Type.Optional(
    Type.Boolean({
      description:
        "For action='place': re-read window state after dispatch and report whether the window actually landed on the target monitor (default true). Set false for fire-and-forget.",
    }),
  ),
  geometry: Type.Optional(
    Type.Object(
      {
        x: Type.Number(),
        y: Type.Number(),
        width: Type.Number(),
        height: Type.Number(),
      },
      { description: "Absolute pixel geometry for resize" },
    ),
  ),
  fullscreenMode: Type.Optional(stringEnum(["real", "maximize", "off"])),
  pinned: Type.Optional(
    Type.Boolean({ description: "true to pin, false to unpin (pin is a toggle on Hyprland)" }),
  ),
  floating: Type.Optional(
    Type.Boolean({
      description:
        "For toggleFloating: true forces floating, false forces tiled, omitted toggles current state",
    }),
  ),
});

function buildSelector(params: Record<string, unknown>): WindowSelector {
  const sel: WindowSelector = {};
  const addr = readStringParam(params, "address");
  if (addr) sel.address = addr;
  const pid = readNumberParam(params, "pid", { integer: true });
  if (typeof pid === "number") sel.pid = pid;
  const classExact = readStringParam(params, "classExact");
  if (classExact) sel.classExact = classExact;
  const classRegex = readStringParam(params, "classRegex");
  if (classRegex) sel.classRegex = classRegex;
  const titleContains = readStringParam(params, "titleContains");
  if (titleContains) sel.titleContains = titleContains;
  const titleRegex = readStringParam(params, "titleRegex");
  if (titleRegex) sel.titleRegex = titleRegex;
  if (params.activeWindow === true) sel.activeWindow = true;
  return sel;
}

function summarizeWindow(w: import("../../desktop/backends/hyprland/ipc.js").HyprWindow) {
  return {
    address: normalizeAddress(w.address),
    class: w.class,
    title: w.title,
    pid: w.pid,
    workspace: w.workspace,
    monitor: w.monitor,
    floating: w.floating,
    fullscreen: w.fullscreen,
    pinned: w.pinned,
    at: w.at,
    size: w.size,
    xwayland: w.xwayland,
  };
}

export function createHyprlandWindowTool(): AnyAgentTool {
  return {
    label: "Hyprland Window",
    name: "hyprland_window",
    description: [
      "Query and control individual windows on the Linux Hyprland desktop.",
      "Every window has a stable hex 'address' that survives across turns — list returns it, all other actions accept it.",
      "Selectors (any one): address, pid, classExact, classRegex, titleContains, titleRegex, activeWindow.",
      "Actions:",
      "  list — return all current windows with address/class/title/workspace/monitor.",
      "  info — full record for a single window selected by any selector.",
      "  focus — focus a window (use selector).",
      "  close — close a window (use selector).",
      "  move — move to a workspace (workspace param), monitor (display), and/or AppPosition. Low-level: silently no-ops when the window is fullscreen. Prefer 'place' for the high-level 'put window X on screen N' use case.",
      "  place — one-shot 'put this window on screen N maximized'. Resolves selector → exits fullscreen if active → moves to the target monitor → applies position (default 'maximized') → re-reads state and verifies the window landed where requested. Returns { ok, verified: { monitor, fullscreen, at } } so the caller knows whether it actually worked.",
      "  fullscreen — fullscreen with mode: 'real' (true fullscreen), 'maximize' (keeps gaps/bar), 'off'.",
      "  pin — toggle pinned (always visible across workspaces).",
      "  resize — explicit pixel geometry { x, y, width, height }.",
      "  toggleFloating — toggle floating/tiled. Pass floating:true|false for idempotent set, omit to toggle. Required before fullscreen on tiled windows.",
      "Linux/Hyprland only. Returns an error including platform/session details on Windows or non-Hyprland Linux sessions.",
    ].join(" "),
    parameters: HyprlandWindowSchema,
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      try {
        const world = await getSharedWorld();
        const snap = world.snapshot();

        switch (action) {
          case "list": {
            return jsonResult({
              count: snap.windows.length,
              activeWindow: snap.activeWindowAddress,
              windows: snap.windows.map(summarizeWindow),
            });
          }

          case "info": {
            const sel = buildSelector(params);
            const w = world.findWindow(sel);
            if (!w) return jsonResult({ error: "no window matched the selector" });
            return jsonResult({ window: summarizeWindow(w) });
          }

          case "focus": {
            const sel = buildSelector(params);
            const w = world.findWindow(sel);
            if (!w) return jsonResult({ error: "no window matched the selector" });
            await focusWindow(w.address);
            return jsonResult({ ok: true, focused: summarizeWindow(w) });
          }

          case "close": {
            const sel = buildSelector(params);
            const w = world.findWindow(sel);
            if (!w) return jsonResult({ error: "no window matched the selector" });
            await closeWindowByAddress(w.address);
            return jsonResult({ ok: true, closed: summarizeWindow(w) });
          }

          case "move": {
            const sel = buildSelector(params);
            const w = world.findWindow(sel);
            if (!w) return jsonResult({ error: "no window matched the selector" });
            const workspace = params.workspace as number | string | undefined;
            const display = readNumberParam(params, "display", { integer: true });
            const position = readStringParam(params, "position") as AppPosition | undefined;
            let movedToWorkspace: number | string | undefined;
            let movedToMonitor: string | undefined;
            let appliedPosition: Awaited<ReturnType<typeof applyPositionToWindow>> | undefined;
            if (workspace !== undefined) {
              await moveWindowToWorkspace(w.address, workspace);
              movedToWorkspace = workspace;
            }
            if (typeof display === "number") {
              const monitor = world.monitorByDisplayIndex(display);
              if (monitor) {
                await moveWindowToMonitor(w.address, monitor.name);
                movedToMonitor = monitor.name;
                if (position) {
                  appliedPosition = await applyPositionToWindow(w.address, position, monitor);
                }
              }
            } else if (position) {
              const monitor = world.findMonitor({ id: w.monitor });
              if (monitor) {
                appliedPosition = await applyPositionToWindow(w.address, position, monitor);
              }
            }
            return jsonResult({
              ok: true,
              address: normalizeAddress(w.address),
              movedToWorkspace,
              movedToMonitor,
              appliedPosition,
            });
          }

          case "place": {
            const sel = buildSelector(params);
            const w = world.findWindow(sel);
            if (!w) return jsonResult({ error: "no window matched the selector" });
            const screen =
              readNumberParam(params, "screen", { integer: true }) ??
              readNumberParam(params, "display", { integer: true });
            if (typeof screen !== "number") {
              return jsonResult({
                error: "place requires `screen` (or `display`) — 0-based Hyprland monitor.id",
                availableScreens: snap.monitors.map((m) => ({
                  id: m.id,
                  name: m.name,
                  description: m.description,
                  width: m.width,
                  height: m.height,
                })),
              });
            }
            const monitor = world.monitorByDisplayIndex(screen);
            if (!monitor) {
              return jsonResult({
                error: `no monitor with id ${screen}`,
                availableScreens: snap.monitors.map((m) => ({
                  id: m.id,
                  name: m.name,
                  description: m.description,
                })),
              });
            }
            const position =
              (readStringParam(params, "position") as AppPosition | undefined) ?? "maximized";
            const verify = params.verify !== false;

            // 1. Exit any active fullscreen state. `movewindow mon:` is silently
            //    ignored when the source window is fullscreen on its current
            //    monitor — this is the #1 reason move requests appear to "do
            //    nothing". Always exit first.
            const wasFullscreen = w.fullscreen !== 0;
            if (wasFullscreen) {
              await fullscreenWindow(w.address, "off");
            }

            // 2. Move the window to the target monitor.
            const alreadyOnTarget = w.monitor === monitor.id;
            if (!alreadyOnTarget) {
              await moveWindowToMonitor(w.address, monitor.name);
            }

            // 3. Apply the requested position on the target monitor.
            const appliedPosition = await applyPositionToWindow(w.address, position, monitor);

            // 4. Verify by re-reading hyprctl. We refresh because the cached
            //    world updates async via the event stream; for a definitive
            //    answer to "did it land?" the synchronous re-read is worth it.
            let verified:
              | {
                  monitor: number;
                  monitorName: string | undefined;
                  fullscreen: number | boolean | undefined;
                  at: [number, number];
                  size: [number, number];
                  onTarget: boolean;
                }
              | undefined;
            let okFinal = true;
            if (verify) {
              await world.refreshAll();
              const after = world.findWindow({ address: w.address });
              if (after) {
                const monName = world.snapshot().monitors.find((m) => m.id === after.monitor)?.name;
                const onTarget = after.monitor === monitor.id;
                verified = {
                  monitor: after.monitor,
                  monitorName: monName,
                  fullscreen: after.fullscreen,
                  at: after.at,
                  size: after.size,
                  onTarget,
                };
                okFinal = onTarget;
              } else {
                okFinal = false;
              }
            }

            return jsonResult({
              ok: okFinal,
              address: normalizeAddress(w.address),
              screen,
              monitor: { id: monitor.id, name: monitor.name },
              position,
              appliedPosition,
              wasFullscreen,
              alreadyOnTarget,
              verified,
            });
          }

          case "fullscreen": {
            const sel = buildSelector(params);
            const w = world.findWindow(sel);
            if (!w) return jsonResult({ error: "no window matched the selector" });
            const display = readNumberParam(params, "display", { integer: true });
            if (typeof display === "number") {
              const monitor = world.monitorByDisplayIndex(display);
              if (monitor && w.monitor !== monitor.id) {
                await moveWindowToMonitor(w.address, monitor.name);
              }
            }
            const mode =
              (readStringParam(params, "fullscreenMode") as
                | "real"
                | "maximize"
                | "off"
                | undefined) ?? "real";
            await fullscreenWindow(w.address, mode);
            return jsonResult({
              ok: true,
              address: normalizeAddress(w.address),
              mode,
            });
          }

          case "pin": {
            const sel = buildSelector(params);
            const w = world.findWindow(sel);
            if (!w) return jsonResult({ error: "no window matched the selector" });
            await pinWindow(w.address, params.pinned !== false);
            return jsonResult({ ok: true, address: normalizeAddress(w.address) });
          }

          case "resize": {
            const sel = buildSelector(params);
            const w = world.findWindow(sel);
            if (!w) return jsonResult({ error: "no window matched the selector" });
            const g = params.geometry as
              | { x: number; y: number; width: number; height: number }
              | undefined;
            if (!g) return jsonResult({ error: "geometry { x, y, width, height } required" });
            const target = `address:${normalizeAddress(w.address)}`;
            // Tiled windows reject pixel-level move/resize. Focus first
            // (so Hyprland's `setfloating` targets THIS window), float
            // if not already, then issue passive move/resize against the
            // address. All in one --batch so it's atomic.
            const batch: string[] = [`focuswindow ${target}`];
            if (!w.floating) batch.push(`setfloating`);
            batch.push(`movewindowpixel exact ${g.x} ${g.y},${target}`);
            batch.push(`resizewindowpixel exact ${g.width} ${g.height},${target}`);
            await batchDispatch(batch);
            return jsonResult({
              ok: true,
              address: normalizeAddress(w.address),
              geometry: g,
              wasFloating: w.floating,
            });
          }

          case "float": {
            const sel = buildSelector(params);
            const w = world.findWindow(sel);
            if (!w) return jsonResult({ error: "no window matched the selector" });
            if (!w.floating) await forceFloating(w.address);
            return jsonResult({
              ok: true,
              address: normalizeAddress(w.address),
              wasFloating: w.floating,
              floating: true,
            });
          }

          case "tile": {
            const sel = buildSelector(params);
            const w = world.findWindow(sel);
            if (!w) return jsonResult({ error: "no window matched the selector" });
            if (w.floating) await forceTiled(w.address);
            return jsonResult({
              ok: true,
              address: normalizeAddress(w.address),
              wasFloating: w.floating,
              floating: false,
            });
          }

          case "maximize": {
            const sel = buildSelector(params);
            const w = world.findWindow(sel);
            if (!w) return jsonResult({ error: "no window matched the selector" });
            // Maximize = full monitor bounds while keeping gaps/bar. Move
            // the window to the requested monitor if provided, then run
            // fullscreen mode 1 (Hyprland's maximize).
            const display = readNumberParam(params, "display", { integer: true });
            if (typeof display === "number") {
              const monitor = world.monitorByDisplayIndex(display);
              if (monitor && w.monitor !== monitor.id) {
                await moveWindowToMonitor(w.address, monitor.name);
              }
            }
            await fullscreenWindow(w.address, "maximize");
            return jsonResult({ ok: true, address: normalizeAddress(w.address), mode: "maximize" });
          }

          case "toggleFloating": {
            const sel = buildSelector(params);
            const w = world.findWindow(sel);
            if (!w) return jsonResult({ error: "no window matched the selector" });
            const desired = typeof params.floating === "boolean" ? params.floating : undefined;
            const wasFloating = w.floating;
            const shouldDispatch = desired === undefined || desired !== wasFloating;
            if (shouldDispatch) await toggleFloating(w.address);
            const nowFloating = shouldDispatch ? !wasFloating : wasFloating;
            return jsonResult({
              ok: true,
              address: normalizeAddress(w.address),
              wasFloating,
              floating: nowFloating,
              toggled: shouldDispatch,
            });
          }

          default:
            return jsonResult({ error: `unknown action: ${action}` });
        }
      } catch (err: unknown) {
        const e = err as { code?: string; capability?: string; message?: string };
        return jsonResult({
          error: e?.message ?? String(err),
          code: e?.code,
          capability: e?.capability,
          action,
        });
      }
    },
  };
}
