/**
 * How much text a spawned CLI's command line can carry, per platform.
 *
 * - Linux/macOS: each argv string is capped at MAX_ARG_STRLEN = 128 KiB and
 *   argv + env together at ARG_MAX (~2 MB). Above either, exec fails E2BIG.
 * - Windows: CreateProcess takes the WHOLE command line (program + every
 *   quoted argument) as one string of at most 32,767 chars; above it spawn
 *   fails ENAMETOOLONG. Through cmd.exe (a `.cmd`/`.bat` shim we couldn't
 *   resolve to its real target) the cap is 8,191 chars after escaping.
 *
 * Callers build the inline argv first, ask `commandLineFits`, and move big
 * text (system prompt, task) to a file flag or stdin when it doesn't fit.
 */

import {
  escapeArgument,
  escapeCommand,
  isWindowsBatchCommand,
  resolveCmdShimTarget,
} from "./win-spawn.js";

/** POSIX: largest single argv string we pass inline (MAX_ARG_STRLEN is 128 KiB). */
export const POSIX_ARG_MAX_BYTES = 100_000;
/** POSIX: total argv bytes we pass inline (ARG_MAX is ~2 MB, shared with env). */
export const POSIX_ARGV_TOTAL_MAX_BYTES = 1_000_000;
/** Windows: whole CreateProcess command line (hard cap 32,767), with headroom. */
export const WIN_COMMAND_LINE_MAX = 30_000;
/** Windows: whole command line through `cmd.exe /d /s /c` (hard cap 8,191). */
export const WIN_SHELL_COMMAND_LINE_MAX = 8_000;

/** One argument as libuv quotes it for CreateProcess (quote_cmd_arg). */
export function quoteWindowsArg(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"]/.test(arg)) return arg;
  if (!/["\\]/.test(arg)) return `"${arg}"`;
  let out = "";
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      out += "\\".repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  return `"${out}${"\\".repeat(backslashes * 2)}"`;
}

/**
 * True when spawnCli() would run this command through cmd.exe on Windows: a
 * `.cmd`/`.bat` shim we can't resolve to its real target. A bare name
 * (`"grok"`) may still resolve to a shim at spawn time, so it counts too
 * unless `bareNameIsExe` says the caller already resolved it.
 */
export function windowsSpawnUsesShell(
  command: string,
  opts: { platform?: NodeJS.Platform; bareNameIsExe?: boolean } = {},
): boolean {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return false;
  if (isWindowsBatchCommand(command, platform)) return resolveCmdShimTarget(command) === null;
  // No extension: unresolved bare name (could become name.cmd at spawn).
  if (!/\.[a-z0-9]{1,4}$/i.test(command)) return opts.bareNameIsExe !== true;
  return false;
}

/** Length of the Windows command line spawn would hand to CreateProcess. */
export function windowsCommandLineLength(
  command: string,
  args: readonly string[],
  viaShell: boolean,
): number {
  if (viaShell) {
    // cmd.exe /d /s /c "<escaped command> <double-escaped args>"
    const inner = [escapeCommand(command), ...args.map((a) => escapeArgument(a, true))].join(" ");
    return "cmd.exe /d /s /c ".length + inner.length + 2;
  }
  let total = quoteWindowsArg(command).length;
  for (const arg of args) total += 1 + quoteWindowsArg(arg).length;
  return total;
}

export type CommandLineCheck = {
  fits: boolean;
  /** Measured size: Windows command-line chars, or POSIX total argv bytes. */
  length: number;
  /** The budget it was measured against. */
  budget: number;
  platform: NodeJS.Platform;
  viaShell: boolean;
};

/** Measure an argv against this platform's command-line budget. */
export function checkCommandLine(params: {
  command: string;
  args: readonly string[];
  platform?: NodeJS.Platform;
  /** Override cmd.exe detection (default: windowsSpawnUsesShell). */
  viaShell?: boolean;
}): CommandLineCheck {
  const platform = params.platform ?? process.platform;
  if (platform === "win32") {
    const viaShell = params.viaShell ?? windowsSpawnUsesShell(params.command, { platform });
    const length = windowsCommandLineLength(params.command, params.args, viaShell);
    const budget = viaShell ? WIN_SHELL_COMMAND_LINE_MAX : WIN_COMMAND_LINE_MAX;
    return { fits: length <= budget, length, budget, platform, viaShell };
  }
  let length = Buffer.byteLength(params.command, "utf8") + 1;
  let perArgOk = true;
  for (const arg of params.args) {
    const bytes = Buffer.byteLength(arg, "utf8");
    if (bytes > POSIX_ARG_MAX_BYTES) perArgOk = false;
    length += bytes + 1;
  }
  return {
    fits: perArgOk && length <= POSIX_ARGV_TOTAL_MAX_BYTES,
    length,
    budget: POSIX_ARGV_TOTAL_MAX_BYTES,
    platform,
    viaShell: false,
  };
}

/** Shorthand for `checkCommandLine(...).fits`. */
export function commandLineFits(params: Parameters<typeof checkCommandLine>[0]): boolean {
  return checkCommandLine(params).fits;
}
