/**
 * Desktop UI automation tool — lets an agent inspect and interact with the
 * controls of any running Windows app via the OS UI Automation API.
 *
 * Flow: model calls `snapshot` to get a ref'd tree of controls for a target
 * window, then calls `invoke` / `set_value` / `focus` / etc. with a selector
 * derived from the snapshot (name, automationId, controlType, or ref).
 *
 * Targets: pass `alias` (maps to the registered app's process name), `pid`
 * directly, or omit to operate on the currently focused window.
 */

import { Type } from "@sinclair/typebox";

import { getAlias } from "../../desktop/apps-store.js";
import {
    uiFind,
    uiFocus,
    uiInvoke,
    uiKeys,
    uiListWindows,
    uiScreenshot,
    uiSetValue,
    uiSnapshot,
    uiWaitFor,
    type UIInvokeAction,
    type UISelector,
    type UITarget,
} from "../../desktop/ui-automation.js";
import { stringEnum } from "../schema/typebox.js";
import {
    type AnyAgentTool,
    imageResultFromFile,
    jsonResult,
    readNumberParam,
    readStringParam,
} from "./common.js";

const UI_INVOKE_ACTIONS: UIInvokeAction[] = [
    "invoke",
    "toggle",
    "expand",
    "collapse",
    "select",
];

const DesktopUiToolSchema = Type.Object({
    action: stringEnum([
        "list_windows",
        "snapshot",
        "find",
        "invoke",
        "set_value",
        "focus",
        "wait_for",
        "keys",
        "screenshot",
    ]),
    // Target selectors — one of these identifies the window
    alias: Type.Optional(Type.String({ description: "Registered app alias (resolved to process name)" })),
    pid: Type.Optional(Type.Number({ description: "Specific process id" })),
    focused: Type.Optional(Type.Boolean({ description: "Use the currently foreground window" })),
    // Element selectors
    ref: Type.Optional(Type.String({ description: "Ref from a previous snapshot (e.g. e12)" })),
    name: Type.Optional(Type.String({ description: "Exact element Name property" })),
    nameContains: Type.Optional(Type.String({ description: "Substring match on element name" })),
    automationId: Type.Optional(Type.String({ description: "Exact AutomationId (stable across runs when set)" })),
    controlType: Type.Optional(Type.String({ description: "Localized control type label, e.g. 'button', 'text', 'check box'" })),
    index: Type.Optional(Type.Number({ description: "Pick the Nth match when multiple elements satisfy the selector (default 0)" })),
    // Action-specific
    uiAction: Type.Optional(stringEnum([...UI_INVOKE_ACTIONS])),
    text: Type.Optional(Type.String({ description: "Value to write (set_value only)" })),
    keys: Type.Optional(Type.String({ description: "SendKeys string, e.g. '^s' for Ctrl+S, '{TAB}', '%{F4}'" })),
    timeoutMs: Type.Optional(Type.Number({ description: "Timeout for wait_for in milliseconds (default 5000)" })),
    maxDepth: Type.Optional(Type.Number({ description: "Snapshot tree depth limit (default 16)" })),
    maxNodes: Type.Optional(Type.Number({ description: "Snapshot node count limit (default 400)" })),
});

function resolveTarget(params: Record<string, unknown>): UITarget | { error: string } {
    const aliasRaw = readStringParam(params, "alias");
    const pid = readNumberParam(params, "pid", { integer: true });
    const focused = params.focused === true;

    if (typeof pid === "number") return { pid };
    if (focused) return { focused: true };
    if (aliasRaw) {
        const entry = getAlias(aliasRaw);
        if (!entry) return { error: `alias not found: ${aliasRaw}` };
        const base = entry.path.split(/[\\/]/).pop() ?? "";
        const processName = base.replace(/\.exe$/i, "");
        if (!processName) {
            return { error: "could not infer process name from alias path" };
        }
        return { processName };
    }
    // No target specified → default to focused window
    return { focused: true };
}

function buildSelector(
    target: UITarget,
    params: Record<string, unknown>,
): UISelector {
    const ref = readStringParam(params, "ref");
    const name = readStringParam(params, "name");
    const nameContains = readStringParam(params, "nameContains");
    const automationId = readStringParam(params, "automationId");
    const controlType = readStringParam(params, "controlType");
    const index = readNumberParam(params, "index", { integer: true });
    return {
        ...target,
        ref,
        name,
        nameContains,
        automationId,
        controlType,
        index: typeof index === "number" ? index : undefined,
    };
}

export function createDesktopUiTool(): AnyAgentTool {
    return {
        label: "Desktop UI",
        name: "desktop_ui",
        description: [
            "Inspect and interact with the controls of any running Windows app via the UI Automation API (the same API screen readers use). Works with ~90% of apps: Win32, WinUI, UWP, Electron (with accessibility enabled), Chromium browsers, Explorer, Settings, Office, VS Code, Notion, Slack, Discord, etc.",
            "Standard flow: (1) snapshot to get a ref'd tree of controls; (2) pick a control by name / automationId / controlType; (3) call invoke / set_value / focus with a selector. Selectors can use any of: ref (e.g. 'e12' from the most recent snapshot of the same window), name (exact), nameContains (substring), automationId (exact), controlType (exact localized label). Use index when the selector matches multiple elements (0 by default).",
            "Actions:",
            "  list_windows — enumerate top-level windows with pid/title/process.",
            "  snapshot — build a ref'd tree for the target window (takes alias, pid, or focused).",
            "  find — return all elements in the target window matching the selector.",
            "  invoke — click/activate an element. uiAction: invoke (default, button click), toggle (checkbox), expand/collapse (combobox/tree), select (list item).",
            "  set_value — write text into a value-pattern element (text box, combobox).",
            "  focus — move keyboard focus to an element.",
            "  wait_for — poll until a matching element exists (timeoutMs, default 5000).",
            "  keys — send a keyboard shortcut via SendKeys syntax (^=Ctrl, %=Alt, +=Shift, {TAB}, {ENTER}). Window is brought to front first.",
            "  screenshot — capture the target window as a PNG and return it inline.",
            "Target selection: pass alias (preferred, resolves to process name), pid (exact), focused=true (foreground window), or nothing (defaults to focused).",
            "Windows only.",
        ].join(" "),

        parameters: DesktopUiToolSchema,

        execute: async (_toolCallId, args) => {
            const params = args as Record<string, unknown>;
            const action = readStringParam(params, "action", { required: true });

            try {
                switch (action) {
                    case "list_windows": {
                        const windows = await uiListWindows();
                        return jsonResult({ count: windows.length, windows });
                    }

                    case "snapshot": {
                        const target = resolveTarget(params);
                        if ("error" in target) return jsonResult({ error: target.error });
                        const maxDepth = readNumberParam(params, "maxDepth", { integer: true });
                        const maxNodes = readNumberParam(params, "maxNodes", { integer: true });
                        const result = await uiSnapshot(target, { maxDepth, maxNodes });
                        return jsonResult(result);
                    }

                    case "find": {
                        const target = resolveTarget(params);
                        if ("error" in target) return jsonResult({ error: target.error });
                        const selector = buildSelector(target, params);
                        const matches = await uiFind(selector);
                        return jsonResult({ count: matches.length, matches });
                    }

                    case "invoke": {
                        const target = resolveTarget(params);
                        if ("error" in target) return jsonResult({ error: target.error });
                        const selector = buildSelector(target, params);
                        const uiActionRaw = readStringParam(params, "uiAction");
                        const uiAction = (uiActionRaw &&
                        (UI_INVOKE_ACTIONS as readonly string[]).includes(uiActionRaw)
                            ? (uiActionRaw as UIInvokeAction)
                            : "invoke");
                        const result = await uiInvoke(selector, uiAction);
                        return jsonResult({ uiAction, ...result });
                    }

                    case "set_value": {
                        const target = resolveTarget(params);
                        if ("error" in target) return jsonResult({ error: target.error });
                        const text = readStringParam(params, "text", { allowEmpty: true });
                        if (typeof text !== "string") {
                            return jsonResult({ error: "text is required" });
                        }
                        const selector = buildSelector(target, params);
                        const result = await uiSetValue(selector, text);
                        return jsonResult(result);
                    }

                    case "focus": {
                        const target = resolveTarget(params);
                        if ("error" in target) return jsonResult({ error: target.error });
                        const selector = buildSelector(target, params);
                        const result = await uiFocus(selector);
                        return jsonResult(result);
                    }

                    case "wait_for": {
                        const target = resolveTarget(params);
                        if ("error" in target) return jsonResult({ error: target.error });
                        const timeoutMs = readNumberParam(params, "timeoutMs", { integer: true });
                        const selector = buildSelector(target, params);
                        const result = await uiWaitFor(
                            selector,
                            typeof timeoutMs === "number" ? timeoutMs : 5000,
                        );
                        return jsonResult(result);
                    }

                    case "keys": {
                        const target = resolveTarget(params);
                        if ("error" in target) return jsonResult({ error: target.error });
                        const keys = readStringParam(params, "keys", { required: true });
                        const result = await uiKeys(target, keys);
                        return jsonResult(result);
                    }

                    case "screenshot": {
                        const target = resolveTarget(params);
                        if ("error" in target) return jsonResult({ error: target.error });
                        const result = await uiScreenshot(target);
                        if (!result.ok || !result.path) {
                            return jsonResult({ error: result.error ?? "screenshot failed" });
                        }
                        return imageResultFromFile({
                            label: "desktop-ui screenshot",
                            path: result.path,
                            extraText: `${result.width}x${result.height} PNG`,
                            details: {
                                path: result.path,
                                width: result.width,
                                height: result.height,
                            },
                        });
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
