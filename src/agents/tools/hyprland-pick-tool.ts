/**
 * Hyprland pick tool — Vimium-for-the-desktop.
 *
 * The agent calls this once, the overlay daemon paints numbered badges on
 * every visible window/workspace/monitor, and the tool returns the badge
 * map: `{ "1": "0xaddress1", "2": "0xaddress2", ... }`. The agent's next
 * turn (after the user says a number) calls hyprland_window with the
 * resolved address.
 *
 * The pick mode persists until exited. To dismiss without action, call this
 * tool again with action="exit".
 *
 * If the overlay daemon isn't installed (gtk-layer-shell typelib missing),
 * the badge map is still returned so voice flows work — the agent just
 * speaks the labels via TTS instead of relying on visual hints. We also
 * fire a hyprctl notify per window as a low-tech visual fallback.
 */

import { Type } from "@sinclair/typebox";

import { notifySimple } from "../../desktop/backends/hyprland/ipc.js";
import {
  getOverlayClient,
  type PickTheme,
  type PickWindow,
} from "../../desktop/backends/hyprland/overlay-client.js";
import { getSharedWorld, normalizeAddress } from "../../desktop/backends/hyprland/state.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";

const HyprlandPickSchema = Type.Object({
  action: stringEnum(["enter", "exit"]),
  mode: Type.Optional(stringEnum(["windows", "workspaces", "monitors"])),
  monitor: Type.Optional(Type.String({ description: "Limit pick to one monitor (name)" })),
  workspace: Type.Optional(Type.Number({ description: "Limit pick to one workspace id" })),
  excludeFloating: Type.Optional(
    Type.Boolean({ description: "Skip floating windows (default false)" }),
  ),
  maxItems: Type.Optional(Type.Number({ description: "Cap on items shown (default 26)" })),
  notify: Type.Optional(
    Type.Boolean({
      description: "Also fire hyprctl notify per item (default true when overlay unavailable)",
    }),
  ),
  // Optional theme override for the numbered badges. Defaults to
  // InfiniBot Gold pill in the top-left corner of each target — matches
  // the rest of the HUD. Most agents leave this alone; brand-specific
  // pickers can pass a different gold/accent to fit their context.
  theme: Type.Optional(
    Type.Object({
      color: Type.Optional(Type.String({ description: "Hex color, e.g. #fbbf24" })),
      thickness: Type.Optional(Type.Number({ description: "Ring thickness in px (default 3)" })),
      fill_alpha: Type.Optional(
        Type.Number({ description: "Window-fill alpha 0–1 (default 0.10)" }),
      ),
      badge_position: Type.Optional(stringEnum(["corner", "center"])),
      badge_style: Type.Optional(stringEnum(["pill", "flat"])),
    }),
  ),
});

const ALPHABET = "1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function nextLabel(idx: number): string {
  if (idx < ALPHABET.length) return ALPHABET[idx];
  const a = Math.floor(idx / ALPHABET.length) - 1;
  const b = idx % ALPHABET.length;
  return ALPHABET[a] + ALPHABET[b];
}

export function createHyprlandPickTool(): AnyAgentTool {
  return {
    label: "Hyprland Pick",
    name: "hyprland_pick",
    description: [
      "Voice-first picker — paint numbered badges on every visible Hyprland window (or workspace/monitor) and return a badge → address map.",
      "Workflow: agent calls action='enter' → tool returns { badge_map: { '1': '0xaddr1', '2': '0xaddr2', ... } } and paints badges → user says a number → agent calls hyprland_window action='focus' with target.address from the map.",
      "Action 'exit' clears all badges (call this if the user cancels or after the action is taken).",
      "Modes:",
      "  windows — badges on every visible window (default).",
      "  workspaces — badges on each workspace's representative monitor area.",
      "  monitors — one badge per monitor.",
      "Optional: monitor (limit to one monitor name), workspace (limit to one workspace id), excludeFloating, maxItems (default 26), notify (also fire hyprctl notify with the label per item).",
      "If the gtk-layer-shell overlay daemon isn't installed, the badge_map is still returned so voice flows work; visualization gracefully degrades to hyprctl notify toasts.",
    ].join(" "),
    parameters: HyprlandPickSchema,
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const mode = (readStringParam(params, "mode") ?? "windows") as
        | "windows"
        | "workspaces"
        | "monitors";
      const notify = params.notify !== false;
      const maxItems = readNumberParam(params, "maxItems", { integer: true }) ?? 26;
      try {
        if (action === "exit") {
          let overlayCleared = false;
          try {
            const overlay = await getOverlayClient();
            await overlay.exitPickMode();
            overlayCleared = true;
          } catch {
            /* no overlay running, that's fine */
          }
          return jsonResult({ ok: true, exited: true, overlayCleared });
        }

        if (action !== "enter") {
          return jsonResult({ error: `unknown action: ${action}` });
        }

        const world = await getSharedWorld();
        const snap = world.snapshot();

        interface Item {
          id: string;
          label: string;
          address?: string;
          workspaceId?: number;
          monitorName?: string;
          geometry: { x: number; y: number; width: number; height: number };
          description: string;
        }
        const items: Item[] = [];
        const monitorFilter = readStringParam(params, "monitor");
        const workspaceFilter = readNumberParam(params, "workspace", { integer: true });
        const excludeFloating = params.excludeFloating === true;

        if (mode === "windows") {
          let visible = snap.windows.filter((w) => w.mapped && !w.hidden);
          if (monitorFilter) {
            const m = world.findMonitor({ name: monitorFilter });
            if (m) visible = visible.filter((w) => w.monitor === m.id);
          }
          if (typeof workspaceFilter === "number") {
            visible = visible.filter((w) => w.workspace.id === workspaceFilter);
          }
          if (excludeFloating) {
            visible = visible.filter((w) => !w.floating);
          }
          visible = visible.slice(0, maxItems);
          visible.forEach((w, i) => {
            items.push({
              id: String(i + 1),
              label: nextLabel(i),
              address: normalizeAddress(w.address),
              workspaceId: w.workspace.id,
              monitorName: snap.monitors.find((m) => m.id === w.monitor)?.name,
              geometry: { x: w.at[0], y: w.at[1], width: w.size[0], height: w.size[1] },
              description: `${w.class} — ${w.title}`,
            });
          });
        } else if (mode === "monitors") {
          snap.monitors.slice(0, maxItems).forEach((m, i) => {
            items.push({
              id: String(i + 1),
              label: nextLabel(i),
              monitorName: m.name,
              geometry: { x: m.x, y: m.y, width: m.width, height: m.height },
              description: `${m.name} ${m.width}x${m.height}`,
            });
          });
        } else if (mode === "workspaces") {
          // For each workspace, find its monitor's geometry. We badge on the
          // top-left corner of that monitor.
          snap.workspaces.slice(0, maxItems).forEach((ws, i) => {
            const m = snap.monitors.find((mn) => mn.name === ws.monitor);
            if (!m) return;
            const badgeSize = 120;
            items.push({
              id: String(i + 1),
              label: nextLabel(i),
              workspaceId: ws.id,
              monitorName: m.name,
              geometry: {
                x: m.x + 20,
                y: m.y + 60,
                width: badgeSize,
                height: badgeSize,
              },
              description: `workspace ${ws.id} (${ws.name}) on ${m.name}`,
            });
          });
        }

        const badgeMap: Record<
          string,
          { address?: string; workspaceId?: number; monitorName?: string; description: string }
        > = {};
        for (const it of items) {
          badgeMap[it.label] = {
            address: it.address,
            workspaceId: it.workspaceId,
            monitorName: it.monitorName,
            description: it.description,
          };
        }

        let overlayUsed = false;
        let overlayError: string | undefined;
        try {
          const overlay = await getOverlayClient();
          const pickWindows: PickWindow[] = items.map((it) => ({
            id: it.label,
            label: it.label,
            geometry: it.geometry,
          }));
          const theme = params.theme as PickTheme | undefined;
          await overlay.enterPickMode(pickWindows, theme);
          overlayUsed = true;
        } catch (err) {
          overlayError = (err as Error).message;
        }

        if (notify || !overlayUsed) {
          // Fire one hyprctl notify per item (low-tech fallback so
          // the user can see them when the overlay is unavailable).
          for (const it of items) {
            await notifySimple(`[${it.label}] ${it.description}`, 6_000).catch(() => {});
          }
        }

        return jsonResult({
          ok: true,
          mode,
          count: items.length,
          overlayUsed,
          overlayError,
          badge_map: badgeMap,
          items: items.map(
            ({ label, address, workspaceId, monitorName, description, geometry }) => ({
              label,
              address,
              workspaceId,
              monitorName,
              description,
              geometry,
            }),
          ),
        });
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
