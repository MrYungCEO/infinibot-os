/**
 * Desktop app tool — lets an agent launch/move/close desktop apps on the host
 * by user-defined aliases. Aliases are stored in apps.json and can be managed
 * by the user via the /apps slash command or by the agent via this tool.
 *
 * Security: launch only accepts aliases; raw executable paths are never
 * executed. The user must define the alias first (either through chat with the
 * agent or via a slash command), which records the path for future reuse.
 */

import { Type } from "@sinclair/typebox";

import {
    APP_POSITIONS,
    type AppAlias,
    type AppPosition,
    getAlias,
    listAliases,
    normalizeAlias,
    removeAlias,
    setAlias,
} from "../../desktop/apps-store.js";
import {
    closeApp,
    fullscreenApp,
    launchApp,
    listDisplays,
    minimizeApp,
    moveApp,
    restoreApp,
    type WindowTarget,
} from "../../desktop/launcher.js";
import { stringEnum } from "../schema/typebox.js";
import {
    type AnyAgentTool,
    jsonResult,
    readNumberParam,
    readStringParam,
} from "./common.js";

const DesktopAppToolSchema = Type.Object({
    action: stringEnum([
        "list_apps",
        "list_displays",
        "set_alias",
        "remove_alias",
        "launch",
        "close",
        "minimize",
        "restore",
        "fullscreen",
        "move",
    ]),
    alias: Type.Optional(Type.String({ description: "Short app name (used as key)" })),
    path: Type.Optional(
        Type.String({ description: "Absolute path to the executable (set_alias only)" }),
    ),
    args: Type.Optional(
        Type.String({ description: "Default command-line args to pass when launching" }),
    ),
    display: Type.Optional(
        Type.Number({
            description:
                "1-based monitor index to place the window on. Omit to use the alias's defaultDisplay or primary.",
        }),
    ),
    position: Type.Optional(
        stringEnum([...APP_POSITIONS]),
    ),
    pid: Type.Optional(Type.Number({ description: "Process id to close (close only)" })),
});

function resolveWindowTarget(params: Record<string, unknown>): WindowTarget | { error: string } {
    const pid = readNumberParam(params, "pid", { integer: true });
    if (typeof pid === "number") return { pid };
    const aliasRaw = readStringParam(params, "alias");
    if (!aliasRaw) return { error: "pid or alias is required" };
    const entry = getAlias(aliasRaw);
    if (!entry) return { error: `alias not found: ${aliasRaw}` };
    const base = entry.path.split(/[\\/]/).pop() ?? "";
    const procName = base.replace(/\.exe$/i, "");
    if (!procName) return { error: "could not infer process name from alias path" };
    return { process: procName };
}

function serializeAlias(a: AppAlias) {
    return {
        alias: a.alias,
        path: a.path,
        args: a.args,
        defaultDisplay: a.defaultDisplay,
        defaultPosition: a.defaultPosition,
        addedAt: a.addedAt,
        updatedAt: a.updatedAt,
    };
}

export function createDesktopAppTool(): AnyAgentTool {
    return {
        label: "Desktop Apps",
        name: "desktop_app",
        description: [
            "Launch, move, and close desktop applications on the user's host machine by alias, targeting a specific monitor and window position.",
            "Aliases are user-defined name → exe-path mappings stored in apps.json. The launch action ONLY accepts aliases — never raw executable paths — so the user must register an app via set_alias before it can be launched.",
            "Actions:",
            "  list_apps — list all registered aliases.",
            "  list_displays — enumerate connected monitors with their bounds (display index follows Windows Display Settings order).",
            "  set_alias — create or update an alias (requires alias + path; path must exist). Optional: args, display (defaultDisplay), position (defaultPosition).",
            "  remove_alias — delete an alias.",
            "  launch — start the app by alias. Optional: display (overrides defaultDisplay), position (fullscreen|maximized|normal|left-half|right-half|top-half|bottom-half|top-left|top-right|bottom-left|bottom-right|center).",
            "  close — terminate a running process by pid or alias.",
            "  minimize — minimize a running app's window(s) by alias or pid.",
            "  restore — un-minimize / un-maximize a running app's window(s) back to normal and bring to front.",
            "  fullscreen — move a running app's window to fullscreen on a given display (alias or pid).",
            "  move — move a running app's window to a display+position without relaunching (alias or pid).",
            "If the user asks to launch something without a registered alias, ask them for the .exe path and then call set_alias before launching.",
            "Windows only.",
        ].join(" "),

        parameters: DesktopAppToolSchema,

        execute: async (_toolCallId, args) => {
            const params = args as Record<string, unknown>;
            const action = readStringParam(params, "action", { required: true });

            try {
                switch (action) {
                    case "list_apps": {
                        const items = listAliases().map(serializeAlias);
                        return jsonResult({
                            count: items.length,
                            aliases: items,
                        });
                    }

                    case "list_displays": {
                        const displays = await listDisplays();
                        return jsonResult({ count: displays.length, displays });
                    }

                    case "set_alias": {
                        const aliasRaw = readStringParam(params, "alias", { required: true });
                        const exePath = readStringParam(params, "path", { required: true });
                        const extraArgs = readStringParam(params, "args");
                        const display = readNumberParam(params, "display", { integer: true });
                        const position = readStringParam(params, "position") as
                            | AppPosition
                            | undefined;

                        const result = setAlias({
                            alias: aliasRaw,
                            path: exePath,
                            args: extraArgs,
                            defaultDisplay: typeof display === "number" ? display : undefined,
                            defaultPosition: position,
                        });
                        if (!result.ok) return jsonResult({ error: result.error });
                        return jsonResult({ success: true, alias: serializeAlias(result.alias) });
                    }

                    case "remove_alias": {
                        const aliasRaw = readStringParam(params, "alias", { required: true });
                        const result = removeAlias(aliasRaw);
                        if (!result.ok) return jsonResult({ error: result.error });
                        return jsonResult({
                            success: true,
                            removed: serializeAlias(result.removed),
                        });
                    }

                    case "launch": {
                        const aliasRaw = readStringParam(params, "alias", { required: true });
                        const key = normalizeAlias(aliasRaw);
                        const entry = getAlias(key);
                        if (!entry) {
                            return jsonResult({
                                error: `alias not found: ${key}. Use set_alias to register it first, or ask the user for the .exe path.`,
                            });
                        }
                        const displayOverride = readNumberParam(params, "display", {
                            integer: true,
                        });
                        const positionOverride = readStringParam(params, "position") as
                            | AppPosition
                            | undefined;

                        const display =
                            typeof displayOverride === "number"
                                ? displayOverride
                                : entry.defaultDisplay ?? 1;
                        const position: AppPosition =
                            positionOverride ?? entry.defaultPosition ?? "normal";

                        // Always force renderer accessibility so screen-reader / UIA
                        // tools can introspect Chromium/Electron app UIs. Non-Chromium
                        // apps will ignore the unknown flag.
                        const baseArgs = entry.args?.trim() ?? "";
                        const accessibilityFlag = "--force-renderer-accessibility";
                        const launchArgs = baseArgs.includes(accessibilityFlag)
                            ? baseArgs
                            : baseArgs
                                ? `${baseArgs} ${accessibilityFlag}`
                                : accessibilityFlag;

                        const result = await launchApp({
                            path: entry.path,
                            args: launchArgs,
                            display,
                            position,
                        });
                        return jsonResult({
                            alias: entry.alias,
                            display,
                            position,
                            ...result,
                        });
                    }

                    case "close": {
                        const target = resolveWindowTarget(params);
                        if ("error" in target) return jsonResult({ error: target.error });
                        const result = await closeApp(target);
                        return jsonResult(result);
                    }

                    case "minimize": {
                        const target = resolveWindowTarget(params);
                        if ("error" in target) return jsonResult({ error: target.error });
                        const result = await minimizeApp(target);
                        return jsonResult(result);
                    }

                    case "restore": {
                        const target = resolveWindowTarget(params);
                        if ("error" in target) return jsonResult({ error: target.error });
                        const result = await restoreApp(target);
                        return jsonResult(result);
                    }

                    case "fullscreen": {
                        const target = resolveWindowTarget(params);
                        if ("error" in target) return jsonResult({ error: target.error });
                        const display = readNumberParam(params, "display", { integer: true });
                        const result = await fullscreenApp({
                            ...target,
                            display: typeof display === "number" ? display : undefined,
                        });
                        return jsonResult(result);
                    }

                    case "move": {
                        const target = resolveWindowTarget(params);
                        if ("error" in target) return jsonResult({ error: target.error });
                        const display = readNumberParam(params, "display", { integer: true });
                        const position = readStringParam(params, "position") as
                            | AppPosition
                            | undefined;
                        const result = await moveApp({
                            ...target,
                            display: typeof display === "number" ? display : undefined,
                            position,
                        });
                        return jsonResult(result);
                    }

                    default:
                        return jsonResult({ error: `unknown action: ${action}` });
                }
            } catch (err: any) {
                return jsonResult({ error: err?.message ?? String(err), action });
            }
        },
    };
}
