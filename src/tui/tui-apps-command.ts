/**
 * /apps slash-command handler for the TUI.
 *
 * Usage:
 *   /apps                                  — same as /apps list
 *   /apps list                             — list registered aliases
 *   /apps displays                         — enumerate monitors
 *   /apps set <alias> <path> [--args="..."] [--display=N] [--position=P]
 *   /apps remove <alias>
 *   /apps launch <alias> [--display=N] [--position=P]
 *   /apps close <alias|pid>
 */

import {
    APP_POSITIONS,
    type AppAlias,
    type AppPosition,
    getAlias,
    listAliases,
    removeAlias,
    setAlias,
} from "../desktop/apps-store.js";
import {
    closeApp,
    fullscreenApp,
    launchApp,
    listDisplays,
    minimizeApp,
    moveApp,
    restoreApp,
    type WindowTarget,
} from "../desktop/launcher.js";

interface ParsedArgs {
    positional: string[];
    flags: Record<string, string>;
}

function parseArgs(raw: string): ParsedArgs {
    const positional: string[] = [];
    const flags: Record<string, string> = {};
    // Tokenize respecting double-quoted strings so paths with spaces work.
    const tokens = Array.from(raw.matchAll(/"([^"]*)"|(\S+)/g)).map((m) => m[1] ?? m[2] ?? "");
    for (const tok of tokens) {
        if (!tok) continue;
        const m = /^--([a-zA-Z0-9_-]+)(?:=(.*))?$/.exec(tok);
        if (m) {
            flags[m[1]] = m[2] ?? "true";
        } else {
            positional.push(tok);
        }
    }
    return { positional, flags };
}

function formatAlias(a: AppAlias): string {
    const extras: string[] = [];
    if (a.args) extras.push(`args="${a.args}"`);
    if (a.defaultDisplay) extras.push(`display=${a.defaultDisplay}`);
    if (a.defaultPosition) extras.push(`position=${a.defaultPosition}`);
    return `  ${a.alias.padEnd(16)}  ${a.path}${extras.length ? `  [${extras.join(", ")}]` : ""}`;
}

function isValidPosition(s: string | undefined): s is AppPosition {
    return typeof s === "string" && (APP_POSITIONS as readonly string[]).includes(s);
}

const USAGE = [
    "/apps commands:",
    "  /apps list                     — show registered aliases",
    "  /apps displays                 — list monitors (numbering follows Windows Display Settings)",
    "  /apps set <alias> <path> [--args=\"...\"] [--display=N] [--position=P]",
    "  /apps remove <alias>",
    "  /apps launch <alias> [--display=N] [--position=P]",
    "  /apps fullscreen <alias|pid> [--display=N]",
    "  /apps minimize <alias|pid>",
    "  /apps restore <alias|pid>",
    "  /apps move <alias|pid> [--display=N] [--position=P]",
    "  /apps close <alias|pid>",
    `  positions: ${APP_POSITIONS.join(" | ")}`,
];

function resolveWindowTargetFromArg(arg: string): WindowTarget | { error: string } {
    if (!arg) return { error: "alias or pid required" };
    const asPid = Number(arg);
    if (Number.isInteger(asPid) && asPid > 0) return { pid: asPid };
    const entry = getAlias(arg);
    if (!entry) return { error: `alias not found: ${arg}` };
    const base = entry.path.split(/[\\/]/).pop() ?? "";
    const procName = base.replace(/\.exe$/i, "");
    if (!procName) return { error: "could not infer process name from alias path" };
    return { process: procName };
}

export async function handleAppsCommand(raw: string): Promise<string[]> {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "list") {
        const items = listAliases();
        if (items.length === 0) {
            return [
                "No app aliases registered.",
                "Register one with: /apps set <alias> <exe-path>",
            ];
        }
        return [`Registered apps (${items.length}):`, ...items.map(formatAlias)];
    }

    const firstSpace = trimmed.indexOf(" ");
    const subcmd = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
    const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);
    const { positional, flags } = parseArgs(rest);

    switch (subcmd) {
        case "list":
            return handleAppsCommand("list");

        case "displays": {
            const displays = await listDisplays();
            if (displays.length === 0) return ["No displays detected."];
            return [
                `Displays (${displays.length}):`,
                ...displays.map(
                    (d) =>
                        `  [${d.index}]${d.primary ? " ★" : "  "} ${d.device}  ` +
                        `bounds=${d.bounds.width}x${d.bounds.height}@(${d.bounds.x},${d.bounds.y})` +
                        `  work=${d.workArea.width}x${d.workArea.height}@(${d.workArea.x},${d.workArea.y})`,
                ),
            ];
        }

        case "set": {
            const [alias, ...pathParts] = positional;
            const exePath = pathParts.join(" ");
            if (!alias || !exePath) {
                return ["usage: /apps set <alias> <path> [--args=\"...\"] [--display=N] [--position=P]"];
            }
            const position = flags.position;
            if (position && !isValidPosition(position)) {
                return [`invalid position: ${position}. Valid: ${APP_POSITIONS.join(", ")}`];
            }
            const displayNum = flags.display ? Number(flags.display) : undefined;
            if (displayNum !== undefined && !Number.isFinite(displayNum)) {
                return [`invalid display: ${flags.display}`];
            }
            const result = setAlias({
                alias,
                path: exePath,
                args: flags.args,
                defaultDisplay: displayNum,
                defaultPosition: isValidPosition(position) ? position : undefined,
            });
            if (!result.ok) return [`error: ${result.error}`];
            return [`✓ registered ${result.alias.alias} → ${result.alias.path}`];
        }

        case "remove":
        case "rm":
        case "delete": {
            const alias = positional[0];
            if (!alias) return ["usage: /apps remove <alias>"];
            const result = removeAlias(alias);
            if (!result.ok) return [`error: ${result.error}`];
            return [`✓ removed ${result.removed.alias}`];
        }

        case "launch":
        case "open": {
            const alias = positional[0];
            if (!alias) return ["usage: /apps launch <alias> [--display=N] [--position=P]"];
            const entry = getAlias(alias);
            if (!entry) return [`alias not found: ${alias}. Use /apps set to register it first.`];
            const displayOverride = flags.display ? Number(flags.display) : undefined;
            const positionOverride = flags.position;
            if (positionOverride && !isValidPosition(positionOverride)) {
                return [`invalid position: ${positionOverride}`];
            }
            const display =
                typeof displayOverride === "number"
                    ? displayOverride
                    : entry.defaultDisplay ?? 1;
            const position: AppPosition = isValidPosition(positionOverride)
                ? positionOverride
                : entry.defaultPosition ?? "normal";

            const result = await launchApp({
                path: entry.path,
                args: entry.args,
                display,
                position,
            });
            if (!result.ok) return [`launch failed: ${result.error ?? "unknown"}`];
            const placed = result.positioned
                ? ` @ display ${display} (${position})`
                : ` (window placement ${result.note ?? "skipped"})`;
            return [`✓ launched ${entry.alias} pid=${result.pid}${placed}`];
        }

        case "close":
        case "kill": {
            const target = positional[0];
            if (!target) return ["usage: /apps close <alias|pid>"];
            const resolved = resolveWindowTargetFromArg(target);
            if ("error" in resolved) return [`error: ${resolved.error}`];
            const result = await closeApp(resolved);
            if (!result.ok) return [`close failed: ${result.error ?? "unknown"}`];
            if (resolved.pid) return [`✓ closed pid ${resolved.pid}`];
            return [`✓ closed ${resolved.process} (killed pids: ${(result.closed ?? []).join(", ") || "none"})`];
        }

        case "minimize":
        case "min": {
            const target = positional[0];
            if (!target) return ["usage: /apps minimize <alias|pid>"];
            const resolved = resolveWindowTargetFromArg(target);
            if ("error" in resolved) return [`error: ${resolved.error}`];
            const result = await minimizeApp(resolved);
            if (!result.ok) return [`minimize failed: ${result.error ?? "unknown"}`];
            const names = (result.minimized ?? []).map((h) => `pid ${h.pid}`).join(", ");
            return [`✓ minimized ${names || "(no windows)"}`];
        }

        case "restore":
        case "unmin": {
            const target = positional[0];
            if (!target) return ["usage: /apps restore <alias|pid>"];
            const resolved = resolveWindowTargetFromArg(target);
            if ("error" in resolved) return [`error: ${resolved.error}`];
            const result = await restoreApp(resolved);
            if (!result.ok) return [`restore failed: ${result.error ?? "unknown"}`];
            const names = (result.restored ?? []).map((h) => `pid ${h.pid}`).join(", ");
            return [`✓ restored ${names || "(no windows)"}`];
        }

        case "fullscreen":
        case "full": {
            const target = positional[0];
            if (!target) return ["usage: /apps fullscreen <alias|pid> [--display=N]"];
            const resolved = resolveWindowTargetFromArg(target);
            if ("error" in resolved) return [`error: ${resolved.error}`];
            const displayNum = flags.display ? Number(flags.display) : undefined;
            if (displayNum !== undefined && !Number.isFinite(displayNum)) {
                return [`invalid display: ${flags.display}`];
            }
            const result = await fullscreenApp({ ...resolved, display: displayNum });
            if (!result.ok) return [`fullscreen failed: ${result.error ?? "unknown"}`];
            const lines = (result.fullscreen ?? []).map(
                (h) => `  pid ${h.pid} → display ${h.display} (${h.rect.width}x${h.rect.height})`,
            );
            return [`✓ fullscreen applied:`, ...lines];
        }

        case "move": {
            const target = positional[0];
            if (!target) return ["usage: /apps move <alias|pid> [--display=N] [--position=P]"];
            const resolved = resolveWindowTargetFromArg(target);
            if ("error" in resolved) return [`error: ${resolved.error}`];
            const displayNum = flags.display ? Number(flags.display) : undefined;
            if (displayNum !== undefined && !Number.isFinite(displayNum)) {
                return [`invalid display: ${flags.display}`];
            }
            const positionOverride = flags.position;
            if (positionOverride && !isValidPosition(positionOverride)) {
                return [`invalid position: ${positionOverride}`];
            }
            const result = await moveApp({
                ...resolved,
                display: displayNum,
                position: isValidPosition(positionOverride) ? positionOverride : undefined,
            });
            if (!result.ok) return [`move failed: ${result.error ?? "unknown"}`];
            const lines = (result.moved ?? []).map(
                (h) =>
                    `  pid ${h.pid} → display ${h.display} ${h.position} (${h.rect.width}x${h.rect.height})`,
            );
            return [`✓ moved:`, ...lines];
        }

        case "help":
        case "":
            return USAGE;

        default:
            return [`unknown /apps subcommand: ${subcmd}`, ...USAGE];
    }
}
