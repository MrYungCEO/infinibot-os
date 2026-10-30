/**
 * Desktop backend detection.
 *
 * Order: win32 → Windows backend; linux + Hyprland session signature → Hyprland
 * backend; everything else → NoneBackend (every method throws NotSupportedError
 * with a clear message so the agent surfaces it cleanly).
 */

import {
  type BackendKind,
  type Capability,
  type DesktopBackend,
  NotSupportedError,
} from "./backend.js";

export interface BackendDetection {
  backend: DesktopBackend;
  reason: string;
}

export async function detectBackend(): Promise<DesktopBackend> {
  if (process.platform === "win32") {
    const mod = await import("./backends/windows.js");
    return mod.createWindowsBackend();
  }

  if (
    process.platform === "linux" &&
    typeof process.env.HYPRLAND_INSTANCE_SIGNATURE === "string" &&
    process.env.HYPRLAND_INSTANCE_SIGNATURE.length > 0
  ) {
    const mod = await import("./backends/hyprland/index.js");
    return mod.createHyprlandBackend();
  }

  return new NoneBackend();
}

export function describeBackend(backend: DesktopBackend): string {
  return `desktop backend: ${backend.kind} (capabilities: ${[...backend.capabilities].join(", ") || "none"})`;
}

class NoneBackend implements DesktopBackend {
  readonly kind: BackendKind = "none";
  readonly capabilities: ReadonlySet<Capability> = new Set();

  private fail(cap: Capability): never {
    const detail = describeUnsupported();
    throw new NotSupportedError(cap, "none", detail);
  }

  listDisplays() {
    return this.fail("list_displays");
  }
  launchApp() {
    return this.fail("launch_app");
  }
  closeApp() {
    return this.fail("close_app");
  }
  minimizeApp() {
    return this.fail("minimize_window");
  }
  restoreApp() {
    return this.fail("restore_window");
  }
  fullscreenApp() {
    return this.fail("fullscreen_window");
  }
  moveApp() {
    return this.fail("move_window");
  }
  screenshotDisplay() {
    return this.fail("screenshot_display");
  }
  uiListWindows() {
    return this.fail("ui_automation");
  }
  uiSnapshot() {
    return this.fail("ui_automation");
  }
  uiFind() {
    return this.fail("ui_automation");
  }
  uiInvoke() {
    return this.fail("ui_automation");
  }
  uiSetValue() {
    return this.fail("ui_automation");
  }
  uiFocus() {
    return this.fail("ui_automation");
  }
  uiWaitFor() {
    return this.fail("ui_automation");
  }
  uiKeys() {
    return this.fail("ui_automation");
  }
  uiScreenshot() {
    return this.fail("ui_automation");
  }
}

function describeUnsupported(): string {
  if (process.platform === "win32") return "Windows backend failed to load";
  if (process.platform === "linux") {
    const sessionType = process.env.XDG_SESSION_TYPE ?? "unknown";
    const wayland = process.env.WAYLAND_DISPLAY
      ? `wayland=${process.env.WAYLAND_DISPLAY}`
      : "no-wayland";
    return `desktop control on Linux requires a Hyprland session (XDG_SESSION_TYPE=${sessionType}, ${wayland}, HYPRLAND_INSTANCE_SIGNATURE=${process.env.HYPRLAND_INSTANCE_SIGNATURE ? "set" : "unset"})`;
  }
  return `desktop control is not supported on platform=${process.platform}`;
}
