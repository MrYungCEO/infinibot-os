/**
 * Hyprland highlight tool — paint visual identification marks on the screen.
 *
 * Targets:
 *   window         — by address. Uses native Hyprland windowrulev2 bordercolor
 *                    (zero deps) for ring; uses overlay for fill/label/pulse.
 *   region         — explicit { x, y, width, height }. Always overlay.
 *   monitor        — full monitor outline. Overlay.
 *   waybar_module  — { name } resolves to module bounds via Waybar IPC if
 *                    the user has output-to-stdout configured; else falls
 *                    back to estimated bar geometry. Overlay.
 *
 * Each highlight returns { highlight_id }. Pass clear with that id, or use
 * action="clear_all" to wipe everything. duration_ms auto-clears after a
 * delay.
 *
 * Style: 'ring' (border only), 'fill' (translucent fill + ring), 'label'
 * (centered text caption), 'pulse' (animated attention — overlay only).
 */

import { Type } from "@sinclair/typebox";

import { dispatch, setKeyword, windowRuleKeyword } from "../../desktop/backends/hyprland/ipc.js";
import {
  getOverlayClient,
  type HighlightGeometry,
  type HighlightStyle,
} from "../../desktop/backends/hyprland/overlay-client.js";
import { getSharedWorld, normalizeAddress } from "../../desktop/backends/hyprland/state.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";

interface ActiveHighlight {
  id: string;
  kind: "overlay" | "border" | "both";
  address?: string;
  autoClearTimer?: NodeJS.Timeout;
}
const ACTIVE: Map<string, ActiveHighlight> = new Map();

const HyprlandHighlightSchema = Type.Object({
  action: Type.Optional(stringEnum(["add", "clear", "clear_all", "list"])),
  target: Type.Optional(
    Type.Object({
      kind: stringEnum(["window", "region", "monitor", "waybar_module"]),
      address: Type.Optional(Type.String({ description: "kind=window: window address" })),
      geometry: Type.Optional(
        Type.Object({
          x: Type.Number(),
          y: Type.Number(),
          width: Type.Number(),
          height: Type.Number(),
        }),
      ),
      monitorName: Type.Optional(Type.String({ description: "kind=monitor: monitor name" })),
      display: Type.Optional(
        Type.Number({
          description: "kind=monitor: monitor id (0-based, matches Hyprland monitor.id / waybar)",
        }),
      ),
      waybarModule: Type.Optional(
        Type.String({ description: "kind=waybar_module: module name (e.g. 'pulseaudio')" }),
      ),
      waybarMonitor: Type.Optional(
        Type.String({ description: "Monitor the bar is on (defaults to focused monitor)" }),
      ),
    }),
  ),
  style: Type.Optional(
    Type.Object({
      type: Type.Optional(stringEnum(["ring", "fill", "label", "pulse"])),
      color: Type.Optional(Type.String({ description: "Hex color, e.g. #7AE3F4" })),
      thickness: Type.Optional(Type.Number({ description: "Border thickness in px (default 4)" })),
      label: Type.Optional(Type.String({ description: "Caption text (centered)" })),
      fill_alpha: Type.Optional(Type.Number({ description: "Alpha 0–1 for fill (default 0.15)" })),
    }),
  ),
  duration_ms: Type.Optional(
    Type.Number({ description: "Auto-clear after this many ms (omit for until-cleared)" }),
  ),
  highlight_id: Type.Optional(Type.String({ description: "For action=clear" })),
});

function genId(): string {
  return `h_${Date.now().toString(36)}_${Math.floor(Math.random() * 1_000).toString(36)}`;
}

function hexToHyprColor(hex: string, alpha = 1): string {
  // Hyprland colors are AARRGGBB hex (with rgba(...) syntax also valid).
  const s = hex.replace("#", "").trim();
  const r = s.length >= 2 ? s.slice(0, 2) : "ff";
  const g = s.length >= 4 ? s.slice(2, 4) : "ff";
  const b = s.length >= 6 ? s.slice(4, 6) : "ff";
  const a = Math.max(0, Math.min(255, Math.round(alpha * 255)))
    .toString(16)
    .padStart(2, "0");
  return `0x${a}${r}${g}${b}`.toLowerCase();
}

async function applyBorderHighlight(
  address: string,
  color: string,
  thickness: number,
): Promise<void> {
  // Hyprland has two ways to set per-window border style:
  //   1. windowrulev2 — only applied at window MAP time. Does nothing for
  //      already-open windows, which is the entire point of "highlight an
  //      active window". This is the bug users hit when their theme has
  //      `general:border_size = 0` and the rule "looks" set in `hyprctl
  //      rules` but the existing window keeps its zero-width border.
  //   2. dispatch setprop — applies at runtime to already-mapped windows.
  //      Supported since Hyprland 0.30 via `setprop address:0x... <prop>
  //      <value>` and `bordersize` / `bordercolor` are the relevant props.
  //
  // We try setprop first (runtime path that actually works on visible
  // windows), then layer a windowrulev2 on top so the highlight survives
  // a window unmap/remap. The runtime setprop on bordersize is what makes
  // the border appear when the user's global border_size is 0.
  const addr = normalizeAddress(address);
  const thicknessClamped = Math.max(2, Math.floor(thickness));
  const colorActive = hexToHyprColor(color);
  const colorInactive = hexToHyprColor(color, 0.55);

  // Runtime — affects the currently-mapped window.
  try {
    await dispatch("setprop", [`address:${addr}`, "bordersize", String(thicknessClamped)]);
  } catch {
    /* older Hyprland — windowrulev2 below is the only path */
  }
  try {
    await dispatch("setprop", [`address:${addr}`, "activebordercolor", colorActive]);
    await dispatch("setprop", [`address:${addr}`, "inactivebordercolor", colorInactive]);
  } catch {
    /* setprop bordercolor variants may not exist on this version */
  }

  // Window-rule layer — survives re-map (e.g. switching workspace away
  // and back). Stays in place until clearBorderHighlight runs.
  const ruleKw = await windowRuleKeyword();
  await setKeyword(ruleKw, `bordercolor ${colorActive} ${colorInactive},address:${addr}`);
  await setKeyword(ruleKw, `bordersize ${thicknessClamped},address:${addr}`);
}

async function clearBorderHighlight(address: string): Promise<void> {
  const addr = normalizeAddress(address);
  // Reset runtime props first (this is what actually clears the visible
  // border on an open window). `-1` is Hyprland's sentinel for "inherit
  // default" on these setprop fields.
  try {
    await dispatch("setprop", [`address:${addr}`, "bordersize", "-1"]);
  } catch {
    /* ignore */
  }
  try {
    await dispatch("setprop", [`address:${addr}`, "activebordercolor", "-1"]);
    await dispatch("setprop", [`address:${addr}`, "inactivebordercolor", "-1"]);
  } catch {
    /* ignore */
  }
  // Window-rule layer cleanup. Hyprland 0.40+ supports `unset:`.
  const ruleKw = await windowRuleKeyword();
  try {
    await setKeyword(ruleKw, `unset:bordercolor,address:${addr}`);
  } catch {
    /* older Hyprland */
  }
  try {
    await setKeyword(ruleKw, `unset:bordersize,address:${addr}`);
  } catch {
    /* ignore */
  }
}

async function resolveTargetGeometry(
  target: Record<string, unknown>,
): Promise<{ geometry?: HighlightGeometry; address?: string; description: string }> {
  const kind = target.kind as string;
  const world = await getSharedWorld();
  if (kind === "window") {
    const addr = target.address as string | undefined;
    if (!addr) throw new Error("target.address required for kind=window");
    const w = world.findWindow({ address: addr });
    if (!w) throw new Error(`window not found: ${addr}`);
    return {
      address: normalizeAddress(w.address),
      geometry: { x: w.at[0], y: w.at[1], width: w.size[0], height: w.size[1] },
      description: `${w.class} — ${w.title}`,
    };
  }
  if (kind === "region") {
    const g = target.geometry as HighlightGeometry | undefined;
    if (!g) throw new Error("target.geometry required for kind=region");
    return { geometry: g, description: `region ${g.width}x${g.height} at (${g.x},${g.y})` };
  }
  if (kind === "monitor") {
    const monName = target.monitorName as string | undefined;
    const display = target.display as number | undefined;
    const m = monName
      ? world.findMonitor({ name: monName })
      : typeof display === "number"
        ? world.monitorByDisplayIndex(display)
        : undefined;
    if (!m) throw new Error("monitor not found (provide monitorName or display)");
    return {
      geometry: { x: m.x, y: m.y, width: m.width, height: m.height },
      description: `monitor ${m.name}`,
    };
  }
  if (kind === "waybar_module") {
    // Best-effort: we don't have D-Bus access to Waybar's module bounds in
    // Phase 2, so we estimate by overlaying the top bar of the requested
    // monitor. The agent can refine via region after a screen capture if
    // pixel-precise bounds are needed.
    const moduleName = target.waybarModule as string | undefined;
    if (!moduleName) throw new Error("target.waybarModule required for kind=waybar_module");
    const monName = target.waybarMonitor as string | undefined;
    const m = monName ? world.findMonitor({ name: monName }) : world.primaryMonitor();
    if (!m) throw new Error("monitor not found for waybar_module");
    // Approximate: full top bar 50px; the agent can capture & refine.
    const reservedTop = m.reserved?.[1] ?? 50;
    return {
      geometry: { x: m.x, y: m.y, width: m.width, height: reservedTop },
      description: `waybar bar on ${m.name} (module=${moduleName}, approximate full-bar bounds; refine via region after capture if needed)`,
    };
  }
  throw new Error(`unknown target kind: ${kind}`);
}

export function createHyprlandHighlightTool(): AnyAgentTool {
  return {
    label: "Hyprland Highlight",
    name: "hyprland_highlight",
    description: [
      "Paint a visual identification mark on the Linux Hyprland desktop — ring, filled rect, label, or pulse — over a window, region, monitor, or Waybar bar.",
      "Actions:",
      "  add — paint a highlight; returns { highlight_id }. Required: target. Optional: style, duration_ms.",
      "  clear — remove a highlight by id. Required: highlight_id.",
      "  clear_all — remove every active highlight.",
      "  list — list active highlights and their targets.",
      "Targets:",
      "  { kind: 'window', address: '0x...' } — uses native Hyprland border for ring (zero deps); uses overlay for fill/label/pulse.",
      "  { kind: 'region', geometry: {x,y,width,height} } — overlay only.",
      "  { kind: 'monitor', monitorName | display } — outlines the whole monitor.",
      "  { kind: 'waybar_module', waybarModule: 'pulseaudio', waybarMonitor?: 'HDMI-A-1' } — currently approximates the full bar bounds; refine with a region after screen capture for pixel precision.",
      "Style: type ('ring' | 'fill' | 'label' | 'pulse'), color (#hex), thickness (px), label (caption), fill_alpha (0–1).",
      "If overlay daemon (gtk-layer-shell) isn't installed, window-ring highlights still work via native Hyprland border tinting; other modes return a structured install hint.",
    ].join(" "),
    parameters: HyprlandHighlightSchema,
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      const action = (readStringParam(params, "action") ?? "add") as
        | "add"
        | "clear"
        | "clear_all"
        | "list";
      try {
        if (action === "list") {
          return jsonResult({
            count: ACTIVE.size,
            highlights: [...ACTIVE.values()].map((h) => ({
              id: h.id,
              kind: h.kind,
              address: h.address,
            })),
          });
        }

        if (action === "clear") {
          const id = readStringParam(params, "highlight_id", { required: true });
          const h = ACTIVE.get(id);
          if (!h) return jsonResult({ ok: false, error: `unknown highlight_id: ${id}` });
          if (h.autoClearTimer) clearTimeout(h.autoClearTimer);
          if (h.kind === "overlay" || h.kind === "both") {
            try {
              const overlay = await getOverlayClient();
              await overlay.clearHighlight(id);
            } catch {
              /* overlay may have died — ignore */
            }
          }
          if ((h.kind === "border" || h.kind === "both") && h.address) {
            await clearBorderHighlight(h.address).catch(() => {});
          }
          ACTIVE.delete(id);
          return jsonResult({ ok: true, cleared: id });
        }

        if (action === "clear_all") {
          const ids = [...ACTIVE.keys()];
          for (const id of ids) {
            const h = ACTIVE.get(id);
            if (!h) continue;
            if (h.autoClearTimer) clearTimeout(h.autoClearTimer);
            if ((h.kind === "border" || h.kind === "both") && h.address) {
              await clearBorderHighlight(h.address).catch(() => {});
            }
            ACTIVE.delete(id);
          }
          try {
            const overlay = await getOverlayClient();
            await overlay.clearAll();
          } catch {
            /* overlay may have died */
          }
          return jsonResult({ ok: true, cleared: ids.length });
        }

        // action === "add"
        const target = params.target as Record<string, unknown> | undefined;
        if (!target || typeof target !== "object") {
          return jsonResult({ error: "target required for add" });
        }
        const styleIn = (params.style as Record<string, unknown> | undefined) ?? {};
        const style: HighlightStyle = {
          type: (styleIn.type as HighlightStyle["type"]) ?? "ring",
          // High-saturation lime — visible against both dark and light
          // window content, and against any default Hyprland border color.
          // The previous cyan (#7AE3F4) blended with several popular dark
          // themes (Catppuccin, Tokyo Night) and looked invisible.
          color: (styleIn.color as string) ?? "#00FF7F",
          // 6px is the smallest size that's reliably visible from a
          // normal viewing distance with the user's compositor scaling.
          // Window borders below ~4px also tend to be clipped by GPU
          // rounding on some Hyprland versions, so we floor at 6.
          thickness: (styleIn.thickness as number) ?? 6,
          label: styleIn.label as string | undefined,
          fill_alpha: (styleIn.fill_alpha as number) ?? 0.18,
        };

        const resolved = await resolveTargetGeometry(target);
        const id = genId();
        const kind = target.kind as string;
        const isWindow = kind === "window";
        const styleType = style.type ?? "ring";

        let overlayUsed = false;
        let borderUsed = false;
        let overlayError: string | undefined;

        // Strategy:
        //   - For windows + style=ring: prefer native border (zero deps).
        //     Also try overlay for the label/secondary mark if requested.
        //   - For everything else: overlay required.
        if (isWindow && resolved.address && styleType === "ring") {
          await applyBorderHighlight(
            resolved.address,
            style.color ?? "#7AE3F4",
            style.thickness ?? 4,
          );
          borderUsed = true;
        }

        const needsOverlay =
          !isWindow ||
          styleType === "fill" ||
          styleType === "label" ||
          styleType === "pulse" ||
          !!style.label;

        if (needsOverlay && resolved.geometry) {
          try {
            const overlay = await getOverlayClient();
            await overlay.addHighlight(id, resolved.geometry, style);
            overlayUsed = true;
          } catch (err) {
            overlayError = (err as Error).message;
            // If we already painted the native border, that's still a useful result.
            if (!borderUsed) {
              return jsonResult({
                ok: false,
                error: `overlay unavailable and no native fallback for kind=${kind} style=${styleType}: ${overlayError}`,
                hint: "Install gtk-layer-shell typelib (Debian/Ubuntu: sudo apt install gir1.2-gtklayershell-0.1; Arch: sudo pacman -S gtk-layer-shell).",
                target: kind,
              });
            }
          }
        }

        const highlight: ActiveHighlight = {
          id,
          kind: borderUsed && overlayUsed ? "both" : borderUsed ? "border" : "overlay",
          address: resolved.address,
        };

        const duration = readNumberParam(params, "duration_ms", { integer: true });
        if (typeof duration === "number" && duration > 0) {
          highlight.autoClearTimer = setTimeout(() => {
            const h = ACTIVE.get(id);
            if (!h) return;
            if ((h.kind === "border" || h.kind === "both") && h.address) {
              clearBorderHighlight(h.address).catch(() => {});
            }
            if (h.kind === "overlay" || h.kind === "both") {
              getOverlayClient()
                .then((o) => o.clearHighlight(id).catch(() => {}))
                .catch(() => {});
            }
            ACTIVE.delete(id);
          }, duration);
        }

        ACTIVE.set(id, highlight);

        return jsonResult({
          ok: true,
          highlight_id: id,
          target: { kind, ...resolved },
          overlayUsed,
          borderUsed,
          overlayError,
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
