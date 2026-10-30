/**
 * Desktop control backend interface.
 *
 * launcher.ts and ui-automation.ts are thin facades that forward to whichever
 * backend matches the current host: Windows (PowerShell + UIA) on win32,
 * Hyprland (hyprctl + grim + wtype) on Linux+Hyprland Wayland sessions.
 *
 * Methods that have no equivalent on a given backend throw NotSupportedError
 * with `capability` set so callers can render a useful agent-facing message.
 */

import type { AppPosition } from "./apps-store.js";

export interface DisplayInfo {
  index: number;
  primary: boolean;
  device: string;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
}

export interface LaunchResult {
  ok: boolean;
  launched?: boolean;
  positioned?: boolean;
  pid?: number;
  title?: string;
  display?: number;
  position?: AppPosition;
  rect?: { x: number; y: number; width: number; height: number };
  error?: string;
  note?: string;
}

export interface CloseResult {
  ok: boolean;
  closed?: number[];
  error?: string;
}

export interface WindowOpResult {
  ok: boolean;
  minimized?: Array<{ pid: number; title: string }>;
  restored?: Array<{ pid: number; title: string }>;
  fullscreen?: Array<{
    pid: number;
    title: string;
    display: number;
    rect: { x: number; y: number; width: number; height: number };
  }>;
  moved?: Array<{
    pid: number;
    title: string;
    display: number;
    position: AppPosition;
    rect: { x: number; y: number; width: number; height: number };
  }>;
  error?: string;
}

export type WindowTarget = { pid?: number; process?: string };

export interface ScreenshotResult {
  ok: boolean;
  path?: string;
  display?: number;
  width?: number;
  height?: number;
  bounds?: { x: number; y: number; width: number; height: number };
  error?: string;
}

export interface UIWindowInfo {
  hwnd: number;
  pid: number;
  processName: string;
  title: string;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface UIElement {
  ref: string;
  role: string;
  name: string;
  automationId: string;
  class: string;
  depth: number;
  enabled: boolean;
  offscreen: boolean;
  bounds: { x: number; y: number; width: number; height: number } | null;
  patterns: string[];
}

export interface UITarget {
  pid?: number;
  processName?: string;
  focused?: boolean;
}

export interface UISelector extends UITarget {
  ref?: string;
  name?: string;
  nameContains?: string;
  automationId?: string;
  controlType?: string;
  index?: number;
}

export type UIInvokeAction = "invoke" | "toggle" | "expand" | "collapse" | "select";

export type BackendKind = "windows" | "hyprland" | "none";

export type Capability =
  | "list_displays"
  | "launch_app"
  | "close_app"
  | "minimize_window"
  | "restore_window"
  | "fullscreen_window"
  | "move_window"
  | "screenshot_display"
  | "ui_automation";

export class NotSupportedError extends Error {
  readonly code = "DESKTOP_BACKEND_UNSUPPORTED" as const;
  constructor(
    readonly capability: Capability,
    readonly backend: BackendKind,
    message?: string,
  ) {
    super(message ?? `${capability} is not supported on the ${backend} desktop backend`);
    this.name = "NotSupportedError";
  }
}

export interface DesktopBackend {
  readonly kind: BackendKind;
  readonly capabilities: ReadonlySet<Capability>;

  listDisplays(): Promise<DisplayInfo[]>;
  launchApp(params: {
    path: string;
    args?: string;
    display?: number;
    position?: AppPosition;
  }): Promise<LaunchResult>;
  closeApp(params: { pid?: number; process?: string }): Promise<CloseResult>;
  minimizeApp(target: WindowTarget): Promise<WindowOpResult>;
  restoreApp(target: WindowTarget): Promise<WindowOpResult>;
  fullscreenApp(target: WindowTarget & { display?: number }): Promise<WindowOpResult>;
  moveApp(
    target: WindowTarget & { display?: number; position?: AppPosition },
  ): Promise<WindowOpResult>;
  screenshotDisplay(params: { display: number; out: string }): Promise<ScreenshotResult>;

  // UI automation (Windows-only today). Linux/Hyprland will throw
  // NotSupportedError; the agent should fall back to vision-based control.
  uiListWindows(): Promise<UIWindowInfo[]>;
  uiSnapshot(
    target: UITarget,
    opts?: { maxDepth?: number; maxNodes?: number },
  ): Promise<{ window: UIWindowInfo | null; elements: UIElement[]; truncated: boolean }>;
  uiFind(selector: UISelector): Promise<UIElement[]>;
  uiInvoke(
    selector: UISelector,
    action?: UIInvokeAction,
  ): Promise<{ ok: boolean; error?: string; element?: UIElement }>;
  uiSetValue(
    selector: UISelector,
    text: string,
  ): Promise<{ ok: boolean; error?: string; element?: UIElement }>;
  uiFocus(selector: UISelector): Promise<{ ok: boolean; error?: string; element?: UIElement }>;
  uiWaitFor(
    selector: UISelector,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; error?: string; element?: UIElement }>;
  uiKeys(target: UITarget, keys: string): Promise<{ ok: boolean; error?: string }>;
  uiScreenshot(
    target: UITarget,
    outPath?: string,
  ): Promise<{ ok: boolean; path?: string; width?: number; height?: number; error?: string }>;
}

let cachedBackend: DesktopBackend | undefined;

/**
 * Resolve the desktop backend for this process. Cached after first call.
 * Pass `force` to re-detect (mostly useful in tests).
 */
export async function getBackend(force = false): Promise<DesktopBackend> {
  if (cachedBackend && !force) return cachedBackend;
  const { detectBackend } = await import("./detect.js");
  cachedBackend = await detectBackend();
  return cachedBackend;
}

export function clearCachedBackend(): void {
  cachedBackend = undefined;
}
