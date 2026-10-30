/**
 * Hyprland workspace tool — list workspaces, switch to one, list monitors,
 * move windows between workspaces, manage special (named) workspaces.
 */

import { Type } from "@sinclair/typebox";

import { dispatch } from "../../desktop/backends/hyprland/ipc.js";
import {
  focusMonitor,
  moveWindowToWorkspace,
  switchWorkspace,
} from "../../desktop/backends/hyprland/dispatch.js";
import { getSharedWorld, normalizeAddress } from "../../desktop/backends/hyprland/state.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";

const HyprlandWorkspaceSchema = Type.Object({
  action: stringEnum([
    "list",
    "current",
    "switch",
    "list_monitors",
    "focus_monitor",
    "move_window",
    "toggle_special",
  ]),
  workspace: Type.Optional(
    Type.Union([Type.Number(), Type.String()], {
      description: "Workspace id, name, or 'special:<name>'",
    }),
  ),
  address: Type.Optional(Type.String({ description: "Window address for move_window" })),
  pid: Type.Optional(
    Type.Number({ description: "Window pid for move_window (alternative to address)" }),
  ),
  monitorName: Type.Optional(
    Type.String({ description: "Monitor name for focus_monitor (e.g. 'HDMI-A-1')" }),
  ),
  display: Type.Optional(
    Type.Number({
      description:
        "Monitor id (0-based, matches Hyprland monitor.id / waybar) — alternative to monitorName",
    }),
  ),
  specialName: Type.Optional(
    Type.String({ description: "Name of special workspace to toggle (default 'minimized')" }),
  ),
});

export function createHyprlandWorkspaceTool(): AnyAgentTool {
  return {
    label: "Hyprland Workspace",
    name: "hyprland_workspace",
    description: [
      "Switch and inspect Hyprland workspaces and monitors.",
      "Actions:",
      "  list — list all current workspaces with id, name, monitor, window count.",
      "  current — return the focused workspace + monitor.",
      "  switch — switch to a workspace by id, name, or 'special:<name>'.",
      "  list_monitors — list connected monitors with bounds and the workspace currently active on each.",
      "  focus_monitor — focus a monitor by name or monitor id (0-based, matches Hyprland monitor.id / waybar).",
      "  move_window — move a window (address or pid) to a workspace.",
      "  toggle_special — toggle a special (named/scratchpad) workspace into view (defaults to 'minimized').",
      "Linux/Hyprland only.",
    ].join(" "),
    parameters: HyprlandWorkspaceSchema,
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      try {
        const world = await getSharedWorld();
        const snap = world.snapshot();

        switch (action) {
          case "list": {
            return jsonResult({
              count: snap.workspaces.length,
              current: snap.activeWorkspaceId,
              focusedMonitor: snap.focusedMonitorName,
              workspaces: snap.workspaces.map((w) => ({
                id: w.id,
                name: w.name,
                monitor: w.monitor,
                windows: w.windows,
                hasFullscreen: w.hasfullscreen,
                lastWindowTitle: w.lastwindowtitle,
              })),
            });
          }

          case "current": {
            const focused = snap.monitors.find((m) => m.focused);
            return jsonResult({
              workspaceId: snap.activeWorkspaceId,
              focusedMonitor: focused
                ? {
                    id: focused.id,
                    name: focused.name,
                    activeWorkspace: focused.activeWorkspace,
                    width: focused.width,
                    height: focused.height,
                  }
                : null,
              activeWindow: snap.activeWindowAddress,
            });
          }

          case "switch": {
            const ws = params.workspace;
            if (ws === undefined) return jsonResult({ error: "workspace required" });
            await switchWorkspace(ws as number | string);
            return jsonResult({ ok: true, switchedTo: ws });
          }

          case "list_monitors": {
            const sorted = [...snap.monitors].sort((a, b) => a.id - b.id);
            return jsonResult({
              count: sorted.length,
              monitors: sorted.map((m, idx) => ({
                index: idx + 1,
                id: m.id,
                name: m.name,
                description: m.description,
                width: m.width,
                height: m.height,
                x: m.x,
                y: m.y,
                refreshRate: m.refreshRate,
                scale: m.scale,
                focused: m.focused,
                activeWorkspace: m.activeWorkspace,
                reserved: m.reserved,
              })),
            });
          }

          case "focus_monitor": {
            const monName = readStringParam(params, "monitorName");
            const display = readNumberParam(params, "display", { integer: true });
            let target: string | undefined = monName;
            if (!target && typeof display === "number") {
              const m = world.monitorByDisplayIndex(display);
              target = m?.name;
            }
            if (!target) return jsonResult({ error: "monitorName or display required" });
            await focusMonitor(target);
            return jsonResult({ ok: true, focused: target });
          }

          case "move_window": {
            const addr = readStringParam(params, "address");
            const pid = readNumberParam(params, "pid", { integer: true });
            const ws = params.workspace;
            if (ws === undefined) return jsonResult({ error: "workspace required" });
            let address = addr;
            if (!address && typeof pid === "number") {
              address = world.findWindow({ pid })?.address;
            }
            if (!address) return jsonResult({ error: "address or pid required" });
            await moveWindowToWorkspace(address, ws as number | string);
            return jsonResult({ ok: true, moved: normalizeAddress(address), to: ws });
          }

          case "toggle_special": {
            const name = readStringParam(params, "specialName") ?? "minimized";
            await dispatch(`togglespecialworkspace ${name}`);
            return jsonResult({ ok: true, toggled: `special:${name}` });
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
