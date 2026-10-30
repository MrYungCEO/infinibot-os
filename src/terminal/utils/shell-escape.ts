/**
 * Shell Escape Utilities
 * Functions for escaping shell arguments and commands on Windows and Unix
 */

import { platform } from "os";

const isWindows = platform() === "win32";

/**
 * Escape a string for use as a shell argument (Bash style)
 */
export function escapeShellArg(arg: string): string {
    if (!arg) return "''";
    if (/^[a-zA-Z0-9_,./-]+$/.test(arg)) return arg;
    return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Escape a string for use in Windows cmd.exe inside double quotes
 * Only " needs escaping as ""
 */
export function escapeForWindowsDoubleQuote(arg: string): string {
    return arg.replace(/"/g, '""');
}

/**
 * Build a CD command for the current platform
 */
export function buildCdCommand(cwd: string | undefined): string {
    if (!cwd) return "";

    if (isWindows) {
        return `cd /d "${escapeForWindowsDoubleQuote(cwd)}" && `;
    }

    return `cd ${escapeShellArg(cwd)} && `;
}
