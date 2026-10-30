/**
 * Hyprland capture tool — screenshot a monitor, region, or specific window
 * via grim/slurp. Returns a first-class image attachment so the model can
 * see the pixels.
 *
 * Modes:
 *   monitor     — full screen of one monitor (by display index or name)
 *   active      — full screen of the focused monitor
 *   all         — every monitor stitched into one image (grim default)
 *   region      — explicit { x, y, width, height } in compositor coords
 *   window      — crop to a window's geometry by address (uses world cache)
 *   interactive — slurp blocks for user to drag a region (timeoutMs)
 */

import * as os from "node:os";
import * as path from "node:path";

import { Type } from "@sinclair/typebox";

import {
  captureAll,
  captureMonitor,
  captureRegion,
  slurpRegion,
} from "../../desktop/backends/hyprland/capture.js";
import { getSharedWorld } from "../../desktop/backends/hyprland/state.js";
import { stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  imageResultFromFile,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./common.js";

const HyprlandCaptureSchema = Type.Object({
  mode: stringEnum(["monitor", "active", "all", "region", "window", "interactive"]),
  display: Type.Optional(
    Type.Number({
      description: "Monitor id (mode=monitor; 0-based, matches Hyprland monitor.id / waybar)",
    }),
  ),
  monitorName: Type.Optional(Type.String({ description: "Monitor name (mode=monitor)" })),
  address: Type.Optional(Type.String({ description: "Window address (mode=window)" })),
  region: Type.Optional(
    Type.Object(
      {
        x: Type.Number(),
        y: Type.Number(),
        width: Type.Number(),
        height: Type.Number(),
      },
      { description: "Region geometry (mode=region)" },
    ),
  ),
  timeoutMs: Type.Optional(
    Type.Number({ description: "Slurp wait time in ms (mode=interactive, default 30000)" }),
  ),
  note: Type.Optional(Type.String({ description: "Free-form note attached as caption" })),
});

export function createHyprlandCaptureTool(): AnyAgentTool {
  return {
    label: "Hyprland Capture",
    name: "hyprland_capture",
    description: [
      "Take a screenshot on the Linux Hyprland desktop and receive it as a first-class image attachment for visual reasoning.",
      "Modes:",
      "  monitor — full screen of one monitor (display: monitor id, 0-based, matches Hyprland monitor.id / waybar; or monitorName).",
      "  active — full screen of the focused monitor.",
      "  all — composite image of every monitor.",
      "  region — explicit { x, y, width, height } in compositor coordinates.",
      "  window — crop to a specific window by address (use hyprland_window list to get addresses).",
      "  interactive — invoke slurp to let the user drag-select a region. Blocks until the user makes a selection.",
      "Linux/Hyprland only. Use screen_analyze on Windows.",
    ].join(" "),
    parameters: HyprlandCaptureSchema,
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      const mode = readStringParam(params, "mode", { required: true }) as
        | "monitor"
        | "active"
        | "all"
        | "region"
        | "window"
        | "interactive";
      try {
        const world = await getSharedWorld();
        const ts = Date.now();
        const outPath = path.join(os.tmpdir(), `infinibot-hypr-${mode}-${ts}.png`);
        const note = readStringParam(params, "note");

        let captionPrefix = "";
        let details: Record<string, unknown> = { mode };

        if (mode === "monitor") {
          const display = readNumberParam(params, "display", { integer: true });
          const monName = readStringParam(params, "monitorName");
          let monitor = monName
            ? world.findMonitor({ name: monName })
            : typeof display === "number"
              ? world.monitorByDisplayIndex(display)
              : world.primaryMonitor();
          if (!monitor) return jsonResult({ error: "no matching monitor" });
          await captureMonitor(monitor, outPath);
          captionPrefix = `Screenshot of monitor ${monitor.name} (${monitor.width}x${monitor.height}).`;
          details = {
            mode,
            monitor: monitor.name,
            display: monitor.id + 1,
            width: monitor.width,
            height: monitor.height,
          };
        } else if (mode === "active") {
          const monitor =
            world.snapshot().monitors.find((m) => m.focused) ?? world.primaryMonitor();
          if (!monitor) return jsonResult({ error: "no focused monitor" });
          await captureMonitor(monitor, outPath);
          captionPrefix = `Screenshot of focused monitor ${monitor.name} (${monitor.width}x${monitor.height}).`;
          details = {
            mode,
            monitor: monitor.name,
            width: monitor.width,
            height: monitor.height,
          };
        } else if (mode === "all") {
          await captureAll(outPath);
          captionPrefix = "Screenshot of all monitors.";
        } else if (mode === "region") {
          const region = params.region as
            | { x: number; y: number; width: number; height: number }
            | undefined;
          if (!region) return jsonResult({ error: "region { x, y, width, height } required" });
          await captureRegion(region, outPath);
          captionPrefix = `Screenshot of region ${region.width}x${region.height} at (${region.x},${region.y}).`;
          details = { mode, region };
        } else if (mode === "window") {
          const addr = readStringParam(params, "address", { required: true });
          const w = world.findWindow({ address: addr });
          if (!w) return jsonResult({ error: "window not found" });
          const region = {
            x: w.at[0],
            y: w.at[1],
            width: w.size[0],
            height: w.size[1],
          };
          await captureRegion(region, outPath);
          captionPrefix = `Screenshot of window "${w.title}" (${w.class}, ${region.width}x${region.height}).`;
          details = {
            mode,
            address: w.address,
            class: w.class,
            title: w.title,
            region,
          };
        } else if (mode === "interactive") {
          const timeoutMs = readNumberParam(params, "timeoutMs", { integer: true }) ?? 30_000;
          const region = await slurpRegion(timeoutMs);
          await captureRegion(region, outPath);
          captionPrefix = `Screenshot of user-selected region ${region.width}x${region.height} at (${region.x},${region.y}).`;
          details = { mode, region };
        }

        const caption = [
          captionPrefix,
          note ? `User context: ${note}` : undefined,
          "Analyze what you see in this image.",
        ]
          .filter(Boolean)
          .join(" ");

        return await imageResultFromFile({
          label: "Hyprland Capture",
          path: outPath,
          extraText: caption,
          details: { ...details, path: outPath },
        });
      } catch (err: unknown) {
        const e = err as { code?: string; capability?: string; message?: string };
        return jsonResult({
          error: e?.message ?? String(err),
          code: e?.code,
          capability: e?.capability,
          mode,
        });
      }
    },
  };
}
