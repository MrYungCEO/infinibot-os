/**
 * Hyprland desktop backend.
 *
 * Implements the cross-platform DesktopBackend interface using hyprctl, grim,
 * wtype, and the cached HyprlandWorld state. UI automation (uiSnapshot, uiFind,
 * uiInvoke, etc.) currently throws NotSupportedError — vision-based control
 * via screen_analyze / hyprland_capture is the path on Linux until an AT-SPI
 * bridge is added in a later phase.
 */

import * as fs from "node:fs/promises";

import {
  type BackendKind,
  type Capability,
  type CloseResult,
  type DesktopBackend,
  type DisplayInfo,
  type LaunchResult,
  NotSupportedError,
  type ScreenshotResult,
  type WindowOpResult,
  type WindowTarget,
} from "../../backend.js";
import type { AppPosition } from "../../apps-store.js";
import {
  applyPositionToWindow,
  closeWindowByAddress,
  fullscreenWindow,
  launchWithPlacement,
} from "./dispatch.js";
import { captureMonitor } from "./capture.js";
import type { HyprMonitor, HyprWindow } from "./ipc.js";
import { dispatch } from "./ipc.js";
import { getSharedWorld, type HyprlandWorld, normalizeAddress } from "./state.js";

const HYPRLAND_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "list_displays",
  "launch_app",
  "close_app",
  "minimize_window",
  "restore_window",
  "fullscreen_window",
  "move_window",
  "screenshot_display",
  // ui_automation deliberately excluded — see facade in ui-automation.ts.
]);

class HyprlandBackend implements DesktopBackend {
  readonly kind: BackendKind = "hyprland";
  readonly capabilities = HYPRLAND_CAPABILITIES;

  private async world(): Promise<HyprlandWorld> {
    return getSharedWorld();
  }

  private async resolveMonitorByDisplay(
    displayIdx: number | undefined,
  ): Promise<HyprMonitor | undefined> {
    const world = await this.world();
    if (typeof displayIdx === "number" && displayIdx >= 0) {
      return world.monitorByDisplayIndex(displayIdx);
    }
    return world.primaryMonitor();
  }

  private monitorToDisplayInfo(m: HyprMonitor, idx: number, anyFocused: boolean): DisplayInfo {
    const reservedTop = m.reserved?.[1] ?? 0;
    const reservedBottom = m.reserved?.[3] ?? 0;
    const reservedLeft = m.reserved?.[0] ?? 0;
    const reservedRight = m.reserved?.[2] ?? 0;
    return {
      index: idx,
      primary: anyFocused ? !!m.focused : idx === 1,
      device: m.name,
      bounds: {
        x: m.x,
        y: m.y,
        width: m.width,
        height: m.height,
      },
      workArea: {
        x: m.x + reservedLeft,
        y: m.y + reservedTop,
        width: Math.max(0, m.width - reservedLeft - reservedRight),
        height: Math.max(0, m.height - reservedTop - reservedBottom),
      },
    };
  }

  async listDisplays(): Promise<DisplayInfo[]> {
    const world = await this.world();
    const monitors = [...world.snapshot().monitors].sort((a, b) => a.id - b.id);
    const anyFocused = monitors.some((m) => m.focused);
    return monitors.map((m, idx) => this.monitorToDisplayInfo(m, idx + 1, anyFocused));
  }

  async launchApp(params: {
    path: string;
    args?: string;
    display?: number;
    position?: AppPosition;
  }): Promise<LaunchResult> {
    const monitor = await this.resolveMonitorByDisplay(params.display);
    try {
      const result = await launchWithPlacement({
        path: params.path,
        args: params.args,
        monitor,
        position: params.position,
      });
      return {
        ok: true,
        launched: true,
        positioned: !!result.appliedPosition,
        pid: result.pid,
        title: result.title,
        display: params.display,
        position: params.position,
        rect: result.rect,
        note: result.note,
      };
    } catch (err) {
      return {
        ok: false,
        launched: false,
        error: (err as Error).message ?? String(err),
      };
    }
  }

  private async resolveTargetWindows(target: WindowTarget): Promise<HyprWindow[]> {
    const world = await this.world();
    if (typeof target.pid === "number") {
      return world.snapshot().windows.filter((w) => w.pid === target.pid);
    }
    if (typeof target.process === "string" && target.process) {
      const proc = target.process.toLowerCase();
      return world
        .snapshot()
        .windows.filter(
          (w) =>
            w.class.toLowerCase() === proc ||
            w.class.toLowerCase().endsWith("." + proc) ||
            w.initialClass?.toLowerCase() === proc,
        );
    }
    return [];
  }

  async closeApp(target: WindowTarget): Promise<CloseResult> {
    const wins = await this.resolveTargetWindows(target);
    if (wins.length === 0) {
      return { ok: false, error: "no matching windows" };
    }
    const closed: number[] = [];
    for (const w of wins) {
      try {
        await closeWindowByAddress(w.address);
        closed.push(w.pid);
      } catch {
        /* continue with the next */
      }
    }
    return { ok: closed.length > 0, closed };
  }

  async minimizeApp(target: WindowTarget): Promise<WindowOpResult> {
    const wins = await this.resolveTargetWindows(target);
    if (wins.length === 0) {
      return { ok: false, error: "no matching windows" };
    }
    const minimized: Array<{ pid: number; title: string }> = [];
    for (const w of wins) {
      // Hyprland has no real minimize. Send to special:minimized so the
      // window vanishes from the visible workspace and can be brought
      // back with togglespecialworkspace minimized.
      try {
        await dispatch(
          `movetoworkspacesilent special:minimized,address:${normalizeAddress(w.address)}`,
        );
        minimized.push({ pid: w.pid, title: w.title });
      } catch {
        /* continue */
      }
    }
    return { ok: minimized.length > 0, minimized };
  }

  async restoreApp(target: WindowTarget): Promise<WindowOpResult> {
    const world = await this.world();
    const wins = await this.resolveTargetWindows(target);
    if (wins.length === 0) {
      return { ok: false, error: "no matching windows" };
    }
    const restored: Array<{ pid: number; title: string }> = [];
    const focusedWs = world.snapshot().activeWorkspaceId;
    for (const w of wins) {
      try {
        if (focusedWs !== null) {
          await dispatch(`movetoworkspace ${focusedWs},address:${normalizeAddress(w.address)}`);
        }
        await dispatch(`focuswindow address:${normalizeAddress(w.address)}`);
        restored.push({ pid: w.pid, title: w.title });
      } catch {
        /* continue */
      }
    }
    return { ok: restored.length > 0, restored };
  }

  async fullscreenApp(target: WindowTarget & { display?: number }): Promise<WindowOpResult> {
    const wins = await this.resolveTargetWindows(target);
    if (wins.length === 0) {
      return { ok: false, error: "no matching windows" };
    }
    const monitor = await this.resolveMonitorByDisplay(target.display);
    const fullscreen: Array<{
      pid: number;
      title: string;
      display: number;
      rect: { x: number; y: number; width: number; height: number };
    }> = [];
    for (const w of wins) {
      try {
        if (monitor && w.monitor !== monitor.id) {
          await dispatch(`movewindow mon:${monitor.name},address:${normalizeAddress(w.address)}`);
        }
        await fullscreenWindow(w.address, "real");
        const m = monitor ?? (await this.world()).findMonitor({ id: w.monitor });
        if (m) {
          fullscreen.push({
            pid: w.pid,
            title: w.title,
            display: target.display ?? m.id + 1,
            rect: { x: m.x, y: m.y, width: m.width, height: m.height },
          });
        }
      } catch {
        /* continue */
      }
    }
    return { ok: fullscreen.length > 0, fullscreen };
  }

  async moveApp(
    target: WindowTarget & { display?: number; position?: AppPosition },
  ): Promise<WindowOpResult> {
    const wins = await this.resolveTargetWindows(target);
    if (wins.length === 0) {
      return { ok: false, error: "no matching windows" };
    }
    const monitor = await this.resolveMonitorByDisplay(target.display);
    if (!monitor) {
      return { ok: false, error: "no target monitor available" };
    }
    const position: AppPosition = target.position ?? "normal";
    const moved: NonNullable<WindowOpResult["moved"]> = [];
    for (const w of wins) {
      try {
        if (w.monitor !== monitor.id) {
          await dispatch(`movewindow mon:${monitor.name},address:${normalizeAddress(w.address)}`);
        }
        const result = await applyPositionToWindow(w.address, position, monitor);
        const rect = result.rect ?? {
          x: monitor.x,
          y: monitor.y,
          width: monitor.width,
          height: monitor.height,
        };
        moved.push({
          pid: w.pid,
          title: w.title,
          display: target.display ?? monitor.id + 1,
          position,
          rect,
        });
      } catch {
        /* continue */
      }
    }
    return { ok: moved.length > 0, moved };
  }

  async screenshotDisplay(params: { display: number; out: string }): Promise<ScreenshotResult> {
    const monitor = await this.resolveMonitorByDisplay(params.display);
    if (!monitor) {
      return { ok: false, error: `display ${params.display} not found` };
    }
    try {
      await captureMonitor(monitor, params.out);
      // Validate that the file got written.
      const stat = await fs.stat(params.out);
      if (stat.size <= 0) {
        return { ok: false, error: "grim wrote a zero-byte file" };
      }
      return {
        ok: true,
        path: params.out,
        display: params.display,
        width: monitor.width,
        height: monitor.height,
        bounds: {
          x: monitor.x,
          y: monitor.y,
          width: monitor.width,
          height: monitor.height,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: (err as Error).message ?? String(err),
        display: params.display,
      };
    }
  }

  private uiUnsupported(): never {
    throw new NotSupportedError(
      "ui_automation",
      "hyprland",
      "UI element automation is not yet supported on Hyprland — use hyprland_capture + vision-based reasoning, or the AT-SPI bridge once it lands. The hyprland_window/hyprland_input tools cover focus, dictation, and hotkeys.",
    );
  }

  uiListWindows() {
    return this.uiUnsupported();
  }
  uiSnapshot() {
    return this.uiUnsupported();
  }
  uiFind() {
    return this.uiUnsupported();
  }
  uiInvoke() {
    return this.uiUnsupported();
  }
  uiSetValue() {
    return this.uiUnsupported();
  }
  uiFocus() {
    return this.uiUnsupported();
  }
  uiWaitFor() {
    return this.uiUnsupported();
  }
  uiKeys() {
    return this.uiUnsupported();
  }
  uiScreenshot() {
    return this.uiUnsupported();
  }
}

export function createHyprlandBackend(): DesktopBackend {
  return new HyprlandBackend();
}
