/**
 * Hyprland launch tool — spawn a process and place its window.
 *
 * Two launch modes:
 *   exec   — direct executable + args, like the Windows launchApp.
 *   desktop_entry — launch a .desktop application via gtk-launch (preserves
 *                   environment, uses Exec= line). Recommended for GUI apps.
 *
 * Placement is applied after the window appears (Hyprland event-driven, not
 * fixed-sleep). Returns address/pid so subsequent hyprland_window calls can
 * operate on the launched window.
 */

import { spawn } from "node:child_process";

import { Type } from "@sinclair/typebox";

import { launchWithPlacement } from "../../desktop/backends/hyprland/dispatch.js";
import { listClients } from "../../desktop/backends/hyprland/ipc.js";
import { getSharedWorld, normalizeAddress } from "../../desktop/backends/hyprland/state.js";
import { APP_POSITIONS, type AppPosition } from "../../desktop/apps-store.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";

const HyprlandLaunchSchema = Type.Object({
  mode: Type.Optional(stringEnum(["exec", "desktop_entry", "url"])),
  path: Type.Optional(Type.String({ description: "Executable path or shell command (mode=exec)" })),
  desktopEntry: Type.Optional(
    Type.String({
      description: "Desktop file id (mode=desktop_entry), e.g. 'firefox' or 'org.gnome.Calculator'",
    }),
  ),
  url: Type.Optional(
    Type.String({
      description:
        "URL to open in a new browser window (mode=url). Wraps the common 'open URL on screen N' use case — handles the single-instance browser handoff so the new window lands on the requested monitor even when the browser is already running.",
    }),
  ),
  browser: Type.Optional(stringEnum(["firefox", "chrome", "auto"])),
  args: Type.Optional(Type.String({ description: "Extra command-line args to pass" })),
  display: Type.Optional(
    Type.Number({
      description: "Monitor id for placement (0-based, matches Hyprland monitor.id / waybar)",
    }),
  ),
  workspace: Type.Optional(
    Type.Union([Type.Number(), Type.String()], {
      description: "Workspace id, name, or 'special:<name>'",
    }),
  ),
  position: Type.Optional(stringEnum([...APP_POSITIONS])),
  waitForWindow: Type.Optional(
    Type.Boolean({
      description:
        "Wait for window to appear before returning (default true). Set false for fire-and-forget.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({ description: "How long to wait for the window (default 6000ms)" }),
  ),
});

async function launchDesktopEntry(entry: string, args?: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const argv = ["gtk-launch", entry];
    if (args) argv.push(...splitArgs(args));
    const child = spawn(argv[0], argv.slice(1), {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", (err) => reject(err));
    // gtk-launch exits quickly; the spawned app continues. We capture
    // gtk-launch's pid, which is not the app pid — but Hyprland matches
    // by class via listClients and our caller uses workspace/title to
    // identify the launched window post-hoc.
    child.unref();
    resolve(child.pid);
  });
}

/** Wrap a value in single quotes for POSIX shell, escaping any embedded single quotes. */
function shellQuoteSingle(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function splitArgs(args: string): string[] {
  // Minimal POSIX shell-style splitter: handles single/double quotes.
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (quote) {
      if (c === quote) {
        quote = undefined;
      } else {
        cur += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === " " || c === "\t") {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function createHyprlandLaunchTool(): AnyAgentTool {
  return {
    label: "Hyprland Launch",
    name: "hyprland_launch",
    description: [
      "Launch an application on the Linux Hyprland desktop and place its window.",
      "Modes:",
      "  exec — spawn an arbitrary executable or shell command. Required: path. Optional: args.",
      "  desktop_entry — launch a .desktop application (recommended for GUI apps). Required: desktopEntry (e.g. 'firefox', 'org.gnome.Calculator').",
      "  url — open a URL in a new browser window and place it. Required: url. Optional: browser ('firefox'|'chrome'|'auto', default 'auto'). Handles the single-instance browser handoff so the new window lands on the requested monitor even when the browser is already running.",
      "Placement (optional, all modes): display (monitor id, 0-based, matches Hyprland monitor.id / waybar), workspace (id/name/'special:<name>'), position (fullscreen, maximized, normal, left-half, right-half, top-half, bottom-half, top-left, top-right, bottom-left, bottom-right, center).",
      "When `display` is given without `position`, the window is moved to that monitor AND defaulted to 'center' so single-instance apps (firefox/chrome/discord) don't stick to their previous monitor.",
      "Returns the launched window's address and pid once it appears (default behavior). Pass waitForWindow=false for fire-and-forget.",
      "Linux/Hyprland only.",
    ].join(" "),
    parameters: HyprlandLaunchSchema,
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      // `mode` covers three modes documented in the description above:
      // exec, desktop_entry, and url. The runtime block at line ~151
      // handles url by translating it to an exec firefox/chrome command,
      // so the type must include url even though the rest of this function
      // narrows to exec/desktop_entry after that branch returns.
      const mode = (readStringParam(params, "mode") ?? "exec") as "exec" | "desktop_entry" | "url";
      try {
        const world = await getSharedWorld();
        const display = readNumberParam(params, "display", { integer: true });
        const monitor =
          typeof display === "number" ? world.monitorByDisplayIndex(display) : undefined;
        // When a target monitor is supplied without an explicit position,
        // default to 'center' so the window actually lands inside the
        // requested monitor at a sensible size. Without this, single-
        // instance browsers/discord drop the new window onto whichever
        // monitor the existing process last lived on.
        const positionRaw = readStringParam(params, "position") as AppPosition | undefined;
        const position: AppPosition | undefined =
          positionRaw ?? (monitor ? ("center" as AppPosition) : undefined);
        const workspace = params.workspace as number | string | undefined;
        const waitForWindow = params.waitForWindow !== false;
        const timeoutMs = readNumberParam(params, "timeoutMs", { integer: true }) ?? 6_000;

        // Resolve url mode to an exec command — Firefox/Chrome with --new-window.
        // The pre-snapshot fallback in launchWithPlacement handles the
        // single-instance fork case so placement still hits the right monitor.
        if (mode === "url") {
          const url = readStringParam(params, "url", { required: true });
          const requested = (readStringParam(params, "browser") ?? "auto") as
            | "firefox"
            | "chrome"
            | "auto";
          const which = requested === "auto" ? "firefox" : requested;
          const exe = which === "chrome" ? "google-chrome" : "firefox";
          const launchArgs = `--new-window ${shellQuoteSingle(url)}`;
          const result = await launchWithPlacement({
            path: exe,
            args: launchArgs,
            monitor,
            workspace,
            position,
            timeoutMs: waitForWindow ? timeoutMs : 0,
          });
          return jsonResult({
            ok: true,
            mode,
            browser: which,
            url,
            pid: result.pid,
            address: result.address,
            title: result.title,
            appliedPosition: result.appliedPosition,
            rect: result.rect,
            note: result.note,
          });
        }

        if (mode === "exec") {
          const path = readStringParam(params, "path", { required: true });
          const result = await launchWithPlacement({
            path,
            args: readStringParam(params, "args"),
            monitor,
            workspace,
            position,
            timeoutMs: waitForWindow ? timeoutMs : 0,
          });
          return jsonResult({
            ok: true,
            mode,
            pid: result.pid,
            address: result.address,
            title: result.title,
            appliedPosition: result.appliedPosition,
            rect: result.rect,
            note: result.note,
          });
        }

        if (mode === "desktop_entry") {
          const entry = readStringParam(params, "desktopEntry", { required: true });
          const launcherPid = await launchDesktopEntry(entry, readStringParam(params, "args"));
          let foundAddress: string | undefined;
          let foundPid: number | undefined;
          let foundTitle: string | undefined;
          if (waitForWindow) {
            const deadline = Date.now() + timeoutMs;
            const before = new Set(
              world.snapshot().windows.map((w) => normalizeAddress(w.address)),
            );
            while (Date.now() < deadline) {
              try {
                const clients = await listClients();
                const newWin = clients.find((c) => !before.has(normalizeAddress(c.address)));
                if (newWin) {
                  foundAddress = normalizeAddress(newWin.address);
                  foundPid = newWin.pid;
                  foundTitle = newWin.title;
                  if (monitor) {
                    const { applyPositionToWindow } =
                      await import("../../desktop/backends/hyprland/dispatch.js");
                    const { dispatch } = await import("../../desktop/backends/hyprland/ipc.js");
                    if (workspace !== undefined) {
                      await dispatch(`movetoworkspacesilent ${workspace},address:${foundAddress}`);
                    } else if (!position) {
                      // No explicit workspace AND no position to imply one →
                      // just move it onto the requested monitor by name.
                      // Previously this branch was a no-op, leaving the
                      // window on whatever monitor the launcher chose.
                      await dispatch(`movewindow mon:${monitor.name},address:${foundAddress}`);
                    }
                    if (position) {
                      await applyPositionToWindow(newWin.address, position, monitor);
                    }
                  }
                  break;
                }
              } catch {
                /* keep polling */
              }
              await new Promise((r) => setTimeout(r, 200));
            }
          }
          return jsonResult({
            ok: true,
            mode,
            launcherPid,
            pid: foundPid,
            address: foundAddress,
            title: foundTitle,
            note: foundAddress ? undefined : "window did not appear within timeout",
          });
        }

        return jsonResult({ error: `unknown mode: ${mode}` });
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
