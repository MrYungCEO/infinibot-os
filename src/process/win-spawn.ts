/**
 * Windows-safe process spawn for CLI shims (`claude.cmd`, `opencode.cmd`, …).
 *
 * Since the CVE-2024-27980 fix (Node ≥18.20 / 20.12 / 22), `child_process.spawn`
 * of a `.cmd`/`.bat` with `shell:false` throws **EINVAL**. npm installs CLIs as
 * `.cmd` shims on Windows, so spawning a resolved `claude.cmd` directly fails.
 *
 * `spawnCli` routes a `.cmd`/`.bat` target through `cmd.exe /d /s /c` with
 * cross-spawn-grade argument escaping (so a task prompt containing spaces,
 * quotes, or newlines survives intact) and `windowsVerbatimArguments`. On
 * non-Windows hosts, or for non-batch targets, it's a straight passthrough to
 * `child_process.spawn` — callers keep full control of `shell`, `stdio`, etc.
 *
 * The escaping mirrors `cross-spawn` (lib/util/escape.js) verbatim; that logic
 * is the de-facto standard (npm itself uses it) and handles the cmd.exe
 * double-parse / quote / caret rules correctly.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  dirname,
  isAbsolute,
  normalize,
  resolve as resolvePath,
  sep,
  win32 as winPath,
} from "node:path";

// http://www.robvanderwoude.com/escapechars.php — cross-spawn's exact set.
const META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

export function escapeCommand(command: string): string {
  return command.replace(META_CHARS, "^$1");
}

export function escapeArgument(arg: string, doubleEscapeMetaChars: boolean): string {
  // Algorithm: https://qntm.org/cmd (matches cross-spawn).
  let a = `${arg}`;
  // Double up backslashes that precede a double quote, then escape the quote.
  a = a.replace(/(\\*)"/g, '$1$1\\"');
  // Double up backslashes at the end (they precede the closing quote we add).
  a = a.replace(/(\\*)$/, "$1$1");
  // Wrap the whole argument in double quotes.
  a = `"${a}"`;
  // Escape cmd meta chars with a caret.
  a = a.replace(META_CHARS, "^$1");
  // npm cmd-shims re-invoke cmd.exe, which parses meta chars a second time.
  if (doubleEscapeMetaChars) a = a.replace(META_CHARS, "^$1");
  return a;
}

/** True for a Windows batch shim that bare spawn() refuses (EINVAL). */
export function isWindowsBatchCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

/**
 * Resolve a `.cmd` npm shim to the real target it invokes so we can spawn that
 * directly — avoiding BOTH the .cmd EINVAL and cmd.exe's 8191-char command-line
 * cap (CreateProcess allows 32767, so large task/system-prompt args fit).
 *
 * Handles the two common shim shapes:
 *   exe target:   "%dp0%\...\claude.exe" %*            → { command: claude.exe, prefixArgs: [] }
 *   node script:  "%dp0%\node.exe" "%dp0%\cli.js" %*   → { command: node.exe, prefixArgs: [cli.js] }
 *
 * Bails (returns null) on complex shims that use other %VARS%/loops (e.g.
 * npm.cmd) — the caller then falls back to the cmd.exe wrapper.
 */
export function resolveCmdShimTarget(
  cmdPath: string,
): { command: string; prefixArgs: string[] } | null {
  let content: string;
  try {
    content = readFileSync(cmdPath, "utf8");
  } catch {
    return null;
  }
  const dp0 = dirname(cmdPath);
  // The invocation line passes user args through via `%*` and quotes its paths.
  const line = content.split(/\r?\n/).find((l) => l.includes("%*") && l.includes('"'));
  if (!line) return null;
  const tokens = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (tokens.length === 0) return null;
  // Expand %~dp0 (batch syntax: no trailing %) / %dp0% (npm's variable) —
  // the shim's own dir — and resolve to absolute paths.
  // Other %VARS% (e.g. codex's "%_prog%") are left as-is — we identify the real
  // target by file existence below, not by expanding every shell variable.
  const resolved = tokens.map((t) => {
    // Shims always use backslashes; map them to this platform's separator so
    // the existence checks below work (a no-op on Windows).
    const e = t.replace(/%~dp0|%dp0%/gi, `${dp0}\\`).replace(/[\\/]+/g, sep);
    return isAbsolute(e) ? normalize(e) : resolvePath(dp0, e);
  });

  // exe-target shim (e.g. claude.cmd → claude.exe): spawn the exe directly.
  const exeIdx = resolved.findIndex((t) => /\.exe$/i.test(t) && existsSync(t));
  if (exeIdx >= 0) {
    return { command: resolved[exeIdx], prefixArgs: resolved.slice(exeIdx + 1) };
  }

  // node-script shim (e.g. codex.cmd → "%_prog%" "...\codex.js" %*): run the
  // script with node directly. Prefer the node.exe shipped next to the shim
  // (npm puts one there), else fall back to `node` on PATH.
  let jsIdx = resolved.findIndex((t) => /\.(?:js|cjs|mjs)$/i.test(t) && existsSync(t));
  // Extensionless node bins (opencode-ai's bin/opencode): the script is the
  // first existing file after the interpreter token ("%_prog%" / node.exe).
  if (jsIdx < 0) {
    const progIdx = tokens.findIndex((t) => /%_prog%|(?:^|[\\/])node(?:\.exe)?$/i.test(t));
    if (progIdx >= 0) {
      jsIdx = resolved.findIndex(
        (t, i) => i > progIdx && existsSync(t) && !/\.(?:cmd|bat|exe)$/i.test(t),
      );
    }
  }
  if (jsIdx >= 0) {
    const localNode = resolvePath(dp0, "node.exe");
    const node = existsSync(localNode) ? localNode : nodeExecutable();
    return { command: node, prefixArgs: [resolved[jsIdx], ...resolved.slice(jsIdx + 1)] };
  }

  return null;
}

/**
 * The node binary to run a shim's script with when npm didn't put a node.exe
 * next to it: this process's own node when we are plain Node (the desktop app
 * ships a private Node that is usually NOT on PATH), else `node` from PATH.
 */
export function nodeExecutable(execPath: string = process.execPath): string {
  return /^node(?:\.exe)?$/i.test(winPath.basename(execPath)) ? execPath : "node";
}

/**
 * The exact (command, args, options) to hand to spawn/execFile/execFileSync
 * for a CLI. On Windows a `.cmd`/`.bat` shim becomes its real target (or a
 * `cmd.exe /d /s /c` wrapper with `windowsVerbatimArguments`); everything
 * else passes through unchanged. Use this for the synchronous child_process
 * APIs, which spawnCli() can't wrap.
 */
export function resolveCliInvocation(
  command: string,
  args: readonly string[] = [],
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (!isWindowsBatchCommand(command)) return { command, args: [...args] };
  const target = resolveCmdShimTarget(command);
  if (target) return { command: target.command, args: [...target.prefixArgs, ...args] };
  const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
  const doubleEscape = /\.cmd$/i.test(command);
  const shellCommand = [
    escapeCommand(normalize(command)),
    ...args.map((a) => escapeArgument(a, doubleEscape)),
  ].join(" ");
  return {
    command: comspec,
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * spawn() that works for Windows `.cmd`/`.bat` CLI shims. Drop-in replacement
 * for `child_process.spawn(command, args, options)`.
 *
 * Strategy on Windows for a `.cmd`/`.bat` target:
 *   1. Resolve the shim to its real target (.exe or node+script) and spawn that
 *      directly — no cmd.exe (so no 8191-char limit) and no EINVAL.
 *   2. If the shim is too complex to resolve, fall back to `cmd.exe /d /s /c`
 *      with cross-spawn-grade escaping (works, but capped at ~8191 chars).
 */
export function spawnCli(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  if (!isWindowsBatchCommand(command)) {
    return nodeSpawn(command, args as string[], options);
  }
  // Preferred: the shim's real target (avoids cmd.exe's 8191 cap); fallback:
  // a cmd.exe wrapper we've already quoted (so Node must not re-mangle it).
  // npm-generated `.cmd` shims double-process meta chars; `.bat` files do not.
  const inv = resolveCliInvocation(command, args);
  return nodeSpawn(
    inv.command,
    inv.args,
    inv.windowsVerbatimArguments ? { ...options, windowsVerbatimArguments: true } : options,
  );
}
