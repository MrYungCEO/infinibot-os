/**
 * Desktop launcher facade.
 *
 * Routes every call to the active DesktopBackend. The Windows backend wraps
 * scripts/desktop-control.ps1 (System.Drawing + Win32). The Hyprland backend
 * wraps hyprctl + grim. NoneBackend throws NotSupportedError with a clear
 * agent-facing message.
 *
 * Public types and function signatures are preserved so existing tools
 * (screen_analyze, desktop_app) work unchanged on every supported platform.
 */

import { getBackend } from "./backend.js";
import type { AppPosition } from "./apps-store.js";

export type {
  CloseResult,
  DisplayInfo,
  LaunchResult,
  ScreenshotResult,
  WindowOpResult,
  WindowTarget,
} from "./backend.js";

export async function listDisplays() {
  return (await getBackend()).listDisplays();
}

export async function launchApp(params: {
  path: string;
  args?: string;
  display?: number;
  position?: AppPosition;
}) {
  return (await getBackend()).launchApp(params);
}

export async function closeApp(params: { pid?: number; process?: string }) {
  return (await getBackend()).closeApp(params);
}

export async function minimizeApp(target: { pid?: number; process?: string }) {
  return (await getBackend()).minimizeApp(target);
}

export async function restoreApp(target: { pid?: number; process?: string }) {
  return (await getBackend()).restoreApp(target);
}

export async function fullscreenApp(target: { pid?: number; process?: string; display?: number }) {
  return (await getBackend()).fullscreenApp(target);
}

export async function moveApp(target: {
  pid?: number;
  process?: string;
  display?: number;
  position?: AppPosition;
}) {
  return (await getBackend()).moveApp(target);
}

export async function screenshotDisplay(params: { display: number; out: string }) {
  return (await getBackend()).screenshotDisplay(params);
}
