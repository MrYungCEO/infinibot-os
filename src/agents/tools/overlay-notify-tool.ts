/**
 * Overlay notify tool — push a gold-themed InfiniBot notification panel onto
 * the user's Hyprland desktop (or fall back to a libnotify system toast).
 *
 * This is the agent-facing front door for the Linux side of `system.notify`'s
 * overlay delivery. Orchestrator agents call it directly (MCP name
 * `overlay_notify`) instead of shelling out to `infinibot nodes notify`.
 *
 * The actual rendering + fallback + idempotency lives in
 * `desktop/backends/hyprland/overlay-notify.ts`, shared with the node-host
 * `system.notify` command handler.
 */

import { Type } from "@sinclair/typebox";

import {
  deliverNotification,
  type NotifyAnchor,
  type NotifyDelivery,
  type NotifyPriority,
} from "../../desktop/backends/hyprland/overlay-notify.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";

const OverlayNotifySchema = Type.Object({
  title: Type.Optional(Type.String({ description: "Notification title (bold gold heading)." })),
  body: Type.Optional(Type.String({ description: "Notification body text." })),
  delivery: Type.Optional(
    stringEnum(["overlay", "system", "auto"], {
      description:
        "overlay = floating gold layer-shell panel (Hyprland); system = libnotify toast; auto = overlay when this is the focused Hyprland device, else system. Default: auto.",
    }),
  ),
  priority: Type.Optional(
    stringEnum(["passive", "active", "timeSensitive"], {
      description:
        "passive = quiet, short (8s); active = sound, 12s (default); timeSensitive = alert sound, 20s.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: "Auto-dismiss after this many ms (overrides the priority default).",
    }),
  ),
  anchor: Type.Optional(
    stringEnum(["top-right", "top-left", "bottom-right", "bottom-left", "top-center"], {
      description: "Screen corner for the panel. Default: top-right.",
    }),
  ),
  sound: Type.Optional(
    Type.String({ description: "canberra sound event id (e.g. 'message', 'dialog-warning')." }),
  ),
  idempotencyKey: Type.Optional(
    Type.String({ description: "Same key within 60s suppresses duplicate notifications." }),
  ),
});

export function createOverlayNotifyTool(): AnyAgentTool {
  return {
    label: "Overlay Notify",
    name: "overlay_notify",
    description: [
      "Show a gold-on-black InfiniBot notification panel on the user's Linux Hyprland desktop as a floating layer-shell window that auto-dismisses (default 12s) or on click; ESC closes the focused panel.",
      "delivery: 'overlay' (always the layer-shell panel), 'system' (libnotify toast), 'auto' (overlay when this is the focused Hyprland device, else system — default).",
      "priority controls sound + auto-dismiss timing: passive (quiet, 8s), active (sound, 12s), timeSensitive (alert, 20s).",
      "Falls back to notify-send automatically if gtk-layer-shell isn't installed, and returns a structured install hint.",
      "idempotencyKey: same key within 60s suppresses duplicates.",
    ].join(" "),
    parameters: OverlayNotifySchema,
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      try {
        const result = await deliverNotification({
          title: readStringParam(params, "title"),
          body: readStringParam(params, "body"),
          delivery: readStringParam(params, "delivery") as NotifyDelivery | undefined,
          priority: readStringParam(params, "priority") as NotifyPriority | undefined,
          timeoutMs: readNumberParam(params, "timeoutMs", { integer: true }),
          anchor: readStringParam(params, "anchor") as NotifyAnchor | undefined,
          sound: readStringParam(params, "sound"),
          idempotencyKey: readStringParam(params, "idempotencyKey"),
        });
        return jsonResult(result);
      } catch (err: unknown) {
        const e = err as { code?: string; message?: string };
        return jsonResult({ ok: false, error: e?.message ?? String(err), code: e?.code });
      }
    },
  };
}
