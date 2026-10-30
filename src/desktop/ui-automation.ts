/**
 * Desktop UI automation facade.
 *
 * Routes to the active DesktopBackend. Windows uses Windows UI Automation via
 * scripts/desktop-ui.ps1. Linux/Hyprland currently throws NotSupportedError
 * with a clear message — vision-based control via screen_analyze /
 * hyprland_capture is the agent's path on Linux until an AT-SPI bridge lands.
 *
 * Public types and function signatures are preserved so the desktop_ui tool
 * works unchanged on every supported platform.
 */

import { getBackend } from "./backend.js";

export type { UIElement, UIInvokeAction, UISelector, UITarget, UIWindowInfo } from "./backend.js";

import type { UIInvokeAction, UISelector, UITarget } from "./backend.js";

export async function uiListWindows() {
  return (await getBackend()).uiListWindows();
}

export async function uiSnapshot(
  target: UITarget,
  opts?: { maxDepth?: number; maxNodes?: number },
) {
  return (await getBackend()).uiSnapshot(target, opts);
}

export async function uiFind(selector: UISelector) {
  return (await getBackend()).uiFind(selector);
}

export async function uiInvoke(selector: UISelector, action: UIInvokeAction = "invoke") {
  return (await getBackend()).uiInvoke(selector, action);
}

export async function uiSetValue(selector: UISelector, text: string) {
  return (await getBackend()).uiSetValue(selector, text);
}

export async function uiFocus(selector: UISelector) {
  return (await getBackend()).uiFocus(selector);
}

export async function uiWaitFor(selector: UISelector, timeoutMs = 5000) {
  return (await getBackend()).uiWaitFor(selector, timeoutMs);
}

export async function uiKeys(target: UITarget, keys: string) {
  return (await getBackend()).uiKeys(target, keys);
}

export async function uiScreenshot(target: UITarget, outPath?: string) {
  return (await getBackend()).uiScreenshot(target, outPath);
}
