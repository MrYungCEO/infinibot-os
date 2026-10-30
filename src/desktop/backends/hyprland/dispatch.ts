/**
 * High-level Hyprland dispatch helpers.
 *
 * Wraps the lower-level hyprctl primitives in operations that the desktop
 * facade and tools call: launchWithPlacement, focusWindow, moveToMonitor,
 * applyPosition (translates AppPosition → geometry → resize/move dispatches).
 *
 * launchWithPlacement uses Hyprland's `windowrulev2 oncestart` to apply
 * placement rules to the next window matching a class/pid pattern. This is
 * race-free: the rule fires when the window opens, no need for sleep loops.
 */

import { spawn } from "node:child_process";

import type { AppPosition } from "../../apps-store.js";
import { batchDispatch, dispatch, type HyprMonitor, type HyprWindow, listClients } from "./ipc.js";
import { type HyprlandWorld, normalizeAddress } from "./state.js";

export interface PlacementGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Translate an AppPosition into a target geometry within a monitor's bounds.
 * Mirrors the Windows backend's positioning so the same `position` parameter
 * means the same thing on both hosts.
 */
export function positionToGeometry(
  position: AppPosition,
  monitor: HyprMonitor,
): PlacementGeometry | "fullscreen" | "maximized" | null {
  const bounds = {
    x: monitor.x,
    y: monitor.y,
    width: monitor.width,
    height: monitor.height,
  };
  switch (position) {
    case "fullscreen":
      return "fullscreen";
    case "maximized":
      return "maximized";
    case "normal":
      return null;
    case "left-half":
      return {
        x: bounds.x,
        y: bounds.y,
        width: Math.floor(bounds.width / 2),
        height: bounds.height,
      };
    case "right-half":
      return {
        x: bounds.x + Math.ceil(bounds.width / 2),
        y: bounds.y,
        width: Math.floor(bounds.width / 2),
        height: bounds.height,
      };
    case "top-half":
      return {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: Math.floor(bounds.height / 2),
      };
    case "bottom-half":
      return {
        x: bounds.x,
        y: bounds.y + Math.ceil(bounds.height / 2),
        width: bounds.width,
        height: Math.floor(bounds.height / 2),
      };
    case "top-left":
      return {
        x: bounds.x,
        y: bounds.y,
        width: Math.floor(bounds.width / 2),
        height: Math.floor(bounds.height / 2),
      };
    case "top-right":
      return {
        x: bounds.x + Math.ceil(bounds.width / 2),
        y: bounds.y,
        width: Math.floor(bounds.width / 2),
        height: Math.floor(bounds.height / 2),
      };
    case "bottom-left":
      return {
        x: bounds.x,
        y: bounds.y + Math.ceil(bounds.height / 2),
        width: Math.floor(bounds.width / 2),
        height: Math.floor(bounds.height / 2),
      };
    case "bottom-right":
      return {
        x: bounds.x + Math.ceil(bounds.width / 2),
        y: bounds.y + Math.ceil(bounds.height / 2),
        width: Math.floor(bounds.width / 2),
        height: Math.floor(bounds.height / 2),
      };
    case "center":
      return {
        x: bounds.x + Math.floor(bounds.width / 4),
        y: bounds.y + Math.floor(bounds.height / 4),
        width: Math.floor(bounds.width / 2),
        height: Math.floor(bounds.height / 2),
      };
  }
}

/**
 * Apply a position to an already-open window by address.
 *
 * Hyprland's `fullscreen`, `setfloating`, and the `moveactive` / `resizeactive`
 * dispatchers operate on the FOCUSED window only — the `address:` selector
 * we used to pass on these is silently ignored. The reliable pattern is to
 * focus the target first in the same `--batch` call, so the focus change
 * and the subsequent action land atomically.
 *
 * `movewindowpixel` / `resizewindowpixel` DO support `,address:0x...` and
 * stay address-targeted because they're the "passive" variants.
 */
export async function applyPositionToWindow(
  address: string,
  position: AppPosition,
  monitor: HyprMonitor,
): Promise<{ rect?: PlacementGeometry; fullscreen?: boolean; maximized?: boolean }> {
  const addr = normalizeAddress(address);
  const target = `address:${addr}`;
  const geom = positionToGeometry(position, monitor);
  if (geom === "fullscreen") {
    // 0 = real fullscreen, no gaps/bar.
    await batchDispatch([`focuswindow ${target}`, `fullscreen 0`]);
    return { fullscreen: true };
  }
  if (geom === "maximized") {
    // 1 = maximize (keeps gaps + bar visible).
    await batchDispatch([`focuswindow ${target}`, `fullscreen 1`]);
    return { maximized: true };
  }
  if (!geom) {
    // "normal" — nothing to apply.
    return {};
  }
  // Tiled windows ignore pixel-level move/resize. Force-float by toggling
  // ONLY when the window isn't already floating (toggle, not set, because
  // some Hyprland versions reject `setfloating` with a window selector).
  // We do this by focusing the target then toggling — Hyprland's
  // `togglefloating` operates on focus when no selector is given.
  await batchDispatch([
    `focuswindow ${target}`,
    `setfloating`,
    `movewindowpixel exact ${geom.x} ${geom.y},${target}`,
    `resizewindowpixel exact ${geom.width} ${geom.height},${target}`,
  ]);
  return { rect: geom };
}

/**
 * Launch a process via hyprctl dispatch exec, optionally pre-installing a
 * windowrulev2 to place the window once it appears. We then poll listClients
 * until a window matching the launched pid appears (or timeout).
 */
export async function launchWithPlacement(params: {
  path: string;
  args?: string;
  monitor?: HyprMonitor;
  workspace?: number | string;
  position?: AppPosition;
  timeoutMs?: number;
}): Promise<{
  pid?: number;
  address?: string;
  title?: string;
  appliedPosition?: PlacementGeometry | "fullscreen" | "maximized";
  rect?: PlacementGeometry;
  note?: string;
}> {
  const { path: exe, args = "", monitor, workspace, position, timeoutMs = 6_000 } = params;

  // Build the command line. Hyprland's exec uses the user's shell, so we
  // pass args verbatim but escape carefully.
  const cmd = args ? `${shellQuote(exe)} ${args}` : shellQuote(exe);
  // Snapshot windows BEFORE spawn so we can identify the new one even when
  // the spawned binary forks to an existing instance (firefox, chrome, code,
  // discord — all single-instance by default). In that case our launched pid
  // is a transient launcher that exits, and `clients.find(c => c.pid === pid)`
  // never matches the real window. Diff-against-snapshot catches it.
  let preAddrs = new Set<string>();
  try {
    preAddrs = new Set((await listClients()).map((c) => normalizeAddress(c.address)));
  } catch {
    /* listClients may fail if hyprctl is briefly busy — fall through with empty set */
  }

  // Spawn directly via Node so we get the pid back. hyprctl dispatch exec
  // doesn't return the pid, so we bypass it for this case.
  const child = spawn("/bin/sh", ["-c", cmd], {
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid;
  child.unref();
  if (!pid) {
    return { note: "spawn failed: no pid" };
  }

  // Poll for the window to appear in hyprctl clients. Prefer pid match;
  // fall back to "first window appearing that wasn't in the pre-snapshot"
  // — the single-instance browser case (the new window's pid is owned by
  // the long-running parent, not our launcher).
  const deadline = Date.now() + timeoutMs;
  let foundWindow: HyprWindow | undefined;
  while (Date.now() < deadline) {
    try {
      const clients = await listClients();
      foundWindow =
        clients.find((c) => c.pid === pid) ??
        clients.find((c) => !preAddrs.has(normalizeAddress(c.address)));
      if (foundWindow) break;
    } catch {
      /* ignore transient hyprctl errors */
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!foundWindow) {
    return { pid, note: "window did not appear within timeout" };
  }

  // Apply placement.
  let appliedPosition: PlacementGeometry | "fullscreen" | "maximized" | undefined;
  let rect: PlacementGeometry | undefined;
  const resolvedMonitor = monitor;
  if (workspace !== undefined && resolvedMonitor) {
    await dispatch(
      `movetoworkspacesilent ${workspace},address:${normalizeAddress(foundWindow.address)}`,
    );
  }
  if (position && resolvedMonitor) {
    const result = await applyPositionToWindow(foundWindow.address, position, resolvedMonitor);
    if (result.fullscreen) appliedPosition = "fullscreen";
    else if (result.maximized) appliedPosition = "maximized";
    else if (result.rect) {
      appliedPosition = result.rect;
      rect = result.rect;
    }
  } else if (resolvedMonitor) {
    // Move the window to the requested monitor without a position change.
    await dispatch(
      `movewindow mon:${resolvedMonitor.name},address:${normalizeAddress(foundWindow.address)}`,
    );
  }

  return {
    pid,
    address: normalizeAddress(foundWindow.address),
    title: foundWindow.title,
    appliedPosition,
    rect,
  };
}

export async function focusWindow(address: string): Promise<void> {
  await dispatch(`focuswindow address:${normalizeAddress(address)}`);
}

export async function closeWindowByAddress(address: string): Promise<void> {
  await dispatch(`closewindow address:${normalizeAddress(address)}`);
}

export async function moveWindowToWorkspace(
  address: string,
  workspace: number | string,
): Promise<void> {
  await dispatch(`movetoworkspace ${workspace},address:${normalizeAddress(address)}`);
}

export async function moveWindowToMonitor(address: string, monitorName: string): Promise<void> {
  await dispatch(`movewindow mon:${monitorName},address:${normalizeAddress(address)}`);
}

/**
 * Fullscreen / maximize a window. Hyprland's `fullscreen` and `fullscreenstate`
 * dispatchers only operate on the focused window, so we focus the target in
 * the same batch before issuing the state change.
 *
 *   mode="real"     → `fullscreen 0`        (full screen, no gaps/bar)
 *   mode="maximize" → `fullscreen 1`        (maximize, gaps + bar visible)
 *   mode="off"      → `fullscreenstate 0 0` (explicit "no fullscreen, no client fs")
 *
 * `fullscreen N` here means *enter* fullscreen mode N, not toggle (unlike the
 * bare `fullscreen` arg-less form which toggles). For deterministic "exit"
 * the only reliable call across Hyprland 0.40+ is `fullscreenstate 0 0`.
 */
export async function fullscreenWindow(
  address: string,
  mode: "real" | "maximize" | "off" = "real",
): Promise<void> {
  const target = `address:${normalizeAddress(address)}`;
  if (mode === "off") {
    await batchDispatch([`focuswindow ${target}`, `fullscreenstate 0 0`]);
    return;
  }
  const arg = mode === "maximize" ? "1" : "0";
  await batchDispatch([`focuswindow ${target}`, `fullscreen ${arg}`]);
}

/**
 * Toggle a window between tiled and floating. Hyprland's `togglefloating`
 * accepts an address selector directly.
 */
export async function toggleFloating(address: string): Promise<void> {
  await dispatch(`togglefloating address:${normalizeAddress(address)}`);
}

/**
 * Force a window to floating, regardless of current state. Hyprland's
 * `setfloating` dispatcher operates on the focused window; we focus first.
 */
export async function forceFloating(address: string): Promise<void> {
  const target = `address:${normalizeAddress(address)}`;
  await batchDispatch([`focuswindow ${target}`, `setfloating`]);
}

/**
 * Force a window to tiled, regardless of current state.
 */
export async function forceTiled(address: string): Promise<void> {
  const target = `address:${normalizeAddress(address)}`;
  await batchDispatch([`focuswindow ${target}`, `settiled`]);
}

export async function pinWindow(address: string, pinned = true): Promise<void> {
  if (pinned) {
    await dispatch(`pin address:${normalizeAddress(address)}`);
  } else {
    // Hyprland's pin is a toggle — we can't directly unpin via address.
    // Fall back to focuswindow + dispatch pin (toggle).
    await dispatch(`pin address:${normalizeAddress(address)}`);
  }
}

export async function switchWorkspace(workspace: number | string): Promise<void> {
  await dispatch(`workspace ${workspace}`);
}

export async function focusMonitor(monitorName: string): Promise<void> {
  await dispatch(`focusmonitor ${monitorName}`);
}

/**
 * Resolve the active monitor for a given address, using world cache to avoid
 * an extra hyprctl round-trip.
 */
export function monitorForWindow(world: HyprlandWorld, address: string): HyprMonitor | undefined {
  const win = world.findWindow({ address });
  if (!win) return undefined;
  return world.findMonitor({ id: win.monitor });
}

function shellQuote(s: string): string {
  if (!s) return "''";
  if (/^[A-Za-z0-9_\-./=:]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
