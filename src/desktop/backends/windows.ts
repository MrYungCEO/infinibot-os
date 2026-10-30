/**
 * Windows desktop backend.
 *
 * This is the existing PowerShell + Windows UI Automation bridge, moved out of
 * src/desktop/launcher.ts and src/desktop/ui-automation.ts so the public
 * facades can route by host. The PowerShell scripts themselves live in
 * scripts/desktop-control.ps1 and scripts/desktop-ui.ps1 — unchanged.
 *
 * Behavior on Windows is preserved bit-for-bit: same spawn args, same stdin
 * JSON protocol, same response normalization.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import {
  type BackendKind,
  type Capability,
  type CloseResult,
  type DesktopBackend,
  type DisplayInfo,
  type LaunchResult,
  NotSupportedError,
  type ScreenshotResult,
  type UIElement,
  type UIInvokeAction,
  type UISelector,
  type UITarget,
  type UIWindowInfo,
  type WindowOpResult,
  type WindowTarget,
} from "../backend.js";
import type { AppPosition } from "../apps-store.js";

const WINDOWS_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "list_displays",
  "launch_app",
  "close_app",
  "minimize_window",
  "restore_window",
  "fullscreen_window",
  "move_window",
  "screenshot_display",
  "ui_automation",
]);

function resolveScriptPath(scriptName: string): string {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const candidates = [
    // From dist/desktop/backends/windows.js → ../../../scripts
    path.resolve(here, "..", "..", "..", "scripts", scriptName),
    // From src/desktop/backends/windows.ts → ../../../scripts
    path.resolve(here, "..", "..", "..", "scripts", scriptName),
    // Fallback: relative to cwd
    path.resolve(process.cwd(), "scripts", scriptName),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return candidates[0];
}

async function runPowerShellScript(
  scriptName: string,
  input: object,
  timeoutMs: number,
  capability: Capability,
  normalize?: (value: unknown) => unknown,
): Promise<unknown> {
  if (process.platform !== "win32") {
    throw new NotSupportedError(capability, "windows");
  }
  const scriptPath = resolveScriptPath(scriptName);
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`powershell timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(
          new Error(
            `powershell exited ${code} with no output${stderr ? `; stderr: ${stderr.trim()}` : ""}`,
          ),
        );
        return;
      }
      try {
        const parsed = JSON.parse(trimmed);
        resolve(normalize ? normalize(parsed) : parsed);
      } catch (err) {
        reject(
          new Error(
            `failed to parse powershell output: ${(err as Error).message}\nstdout: ${trimmed}\nstderr: ${stderr.trim()}`,
          ),
        );
      }
    });

    try {
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

/**
 * PowerShell 5.1's ConvertTo-Json renders empty arrays as `null` and
 * single-element arrays as scalars. Normalize so downstream callers can rely
 * on `patterns: string[]`, `elements: UIElement[]`, etc.
 *
 * Preserved verbatim from the prior ui-automation.ts implementation.
 */
function normalizeUIResponse(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(normalizeUIResponse);
  if (typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  for (const key of ["elements", "matches", "windows", "patterns"]) {
    if (key in obj) {
      const v = obj[key];
      if (v === null || v === undefined) {
        obj[key] = [];
      } else if (!Array.isArray(v)) {
        if (typeof v === "object" && Object.keys(v as object).length === 0) {
          obj[key] = [];
        } else {
          obj[key] = [v];
        }
      }
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    obj[k] = normalizeUIResponse(v);
  }
  return obj;
}

class WindowsBackend implements DesktopBackend {
  readonly kind: BackendKind = "windows";
  readonly capabilities = WINDOWS_CAPABILITIES;

  async listDisplays(): Promise<DisplayInfo[]> {
    const res = (await runPowerShellScript(
      "desktop-control.ps1",
      { op: "displays" },
      15_000,
      "list_displays",
    )) as { ok: boolean; displays?: DisplayInfo[]; error?: string };
    if (!res.ok) throw new Error(res.error || "listDisplays failed");
    return res.displays ?? [];
  }

  async launchApp(params: {
    path: string;
    args?: string;
    display?: number;
    position?: AppPosition;
  }): Promise<LaunchResult> {
    return (await runPowerShellScript(
      "desktop-control.ps1",
      { op: "launch", ...params },
      15_000,
      "launch_app",
    )) as LaunchResult;
  }

  async closeApp(params: { pid?: number; process?: string }): Promise<CloseResult> {
    return (await runPowerShellScript(
      "desktop-control.ps1",
      { op: "close", ...params },
      15_000,
      "close_app",
    )) as CloseResult;
  }

  async minimizeApp(target: WindowTarget): Promise<WindowOpResult> {
    return (await runPowerShellScript(
      "desktop-control.ps1",
      { op: "minimize", ...target },
      15_000,
      "minimize_window",
    )) as WindowOpResult;
  }

  async restoreApp(target: WindowTarget): Promise<WindowOpResult> {
    return (await runPowerShellScript(
      "desktop-control.ps1",
      { op: "restore", ...target },
      15_000,
      "restore_window",
    )) as WindowOpResult;
  }

  async fullscreenApp(target: WindowTarget & { display?: number }): Promise<WindowOpResult> {
    return (await runPowerShellScript(
      "desktop-control.ps1",
      { op: "fullscreen", ...target },
      15_000,
      "fullscreen_window",
    )) as WindowOpResult;
  }

  async moveApp(
    target: WindowTarget & { display?: number; position?: AppPosition },
  ): Promise<WindowOpResult> {
    return (await runPowerShellScript(
      "desktop-control.ps1",
      { op: "move", ...target },
      15_000,
      "move_window",
    )) as WindowOpResult;
  }

  async screenshotDisplay(params: { display: number; out: string }): Promise<ScreenshotResult> {
    return (await runPowerShellScript(
      "desktop-control.ps1",
      { op: "screenshot", ...params },
      15_000,
      "screenshot_display",
    )) as ScreenshotResult;
  }

  async uiListWindows(): Promise<UIWindowInfo[]> {
    const r = (await runPowerShellScript(
      "desktop-ui.ps1",
      { op: "list_windows" },
      20_000,
      "ui_automation",
      normalizeUIResponse,
    )) as { ok: boolean; windows?: UIWindowInfo[]; error?: string };
    if (!r.ok) throw new Error(r.error || "list_windows failed");
    return r.windows ?? [];
  }

  async uiSnapshot(
    target: UITarget,
    opts?: { maxDepth?: number; maxNodes?: number },
  ): Promise<{ window: UIWindowInfo | null; elements: UIElement[]; truncated: boolean }> {
    const r = (await runPowerShellScript(
      "desktop-ui.ps1",
      {
        op: "snapshot",
        ...target,
        maxDepth: opts?.maxDepth,
        maxNodes: opts?.maxNodes,
      },
      20_000,
      "ui_automation",
      normalizeUIResponse,
    )) as {
      ok: boolean;
      window?: UIWindowInfo;
      elements?: UIElement[];
      truncated?: boolean;
      error?: string;
    };
    if (!r.ok) throw new Error(r.error || "snapshot failed");
    return {
      window: r.window ?? null,
      elements: r.elements ?? [],
      truncated: Boolean(r.truncated),
    };
  }

  async uiFind(selector: UISelector): Promise<UIElement[]> {
    const r = (await runPowerShellScript(
      "desktop-ui.ps1",
      { op: "find", ...selector },
      20_000,
      "ui_automation",
      normalizeUIResponse,
    )) as { ok: boolean; matches?: UIElement[]; error?: string };
    if (!r.ok) throw new Error(r.error || "find failed");
    return r.matches ?? [];
  }

  async uiInvoke(
    selector: UISelector,
    action: UIInvokeAction = "invoke",
  ): Promise<{ ok: boolean; error?: string; element?: UIElement }> {
    return (await runPowerShellScript(
      "desktop-ui.ps1",
      { op: "invoke", uiAction: action, ...selector },
      20_000,
      "ui_automation",
      normalizeUIResponse,
    )) as { ok: boolean; error?: string; element?: UIElement };
  }

  async uiSetValue(
    selector: UISelector,
    text: string,
  ): Promise<{ ok: boolean; error?: string; element?: UIElement }> {
    return (await runPowerShellScript(
      "desktop-ui.ps1",
      { op: "set_value", text, ...selector },
      20_000,
      "ui_automation",
      normalizeUIResponse,
    )) as { ok: boolean; error?: string; element?: UIElement };
  }

  async uiFocus(
    selector: UISelector,
  ): Promise<{ ok: boolean; error?: string; element?: UIElement }> {
    return (await runPowerShellScript(
      "desktop-ui.ps1",
      { op: "focus", ...selector },
      20_000,
      "ui_automation",
      normalizeUIResponse,
    )) as { ok: boolean; error?: string; element?: UIElement };
  }

  async uiWaitFor(
    selector: UISelector,
    timeoutMs = 5000,
  ): Promise<{ ok: boolean; error?: string; element?: UIElement }> {
    return (await runPowerShellScript(
      "desktop-ui.ps1",
      { op: "wait_for", timeoutMs, ...selector },
      Math.max(5_000, timeoutMs + 5_000),
      "ui_automation",
      normalizeUIResponse,
    )) as { ok: boolean; error?: string; element?: UIElement };
  }

  async uiKeys(target: UITarget, keys: string): Promise<{ ok: boolean; error?: string }> {
    return (await runPowerShellScript(
      "desktop-ui.ps1",
      { op: "keys", keys, ...target },
      20_000,
      "ui_automation",
      normalizeUIResponse,
    )) as { ok: boolean; error?: string };
  }

  async uiScreenshot(
    target: UITarget,
    outPath?: string,
  ): Promise<{ ok: boolean; path?: string; width?: number; height?: number; error?: string }> {
    return (await runPowerShellScript(
      "desktop-ui.ps1",
      { op: "screenshot", outPath, ...target },
      20_000,
      "ui_automation",
      normalizeUIResponse,
    )) as { ok: boolean; path?: string; width?: number; height?: number; error?: string };
  }
}

export function createWindowsBackend(): DesktopBackend {
  return new WindowsBackend();
}
