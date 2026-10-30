/**
 * Shared CLI binary detection for coder backends.
 *
 * Root cause this fixes: every backend's `checkInstalled()` used a bare
 * `execFileSync("claude" | "codex" | "opencode", ["--version"])`, which
 * inherits the GATEWAY process's PATH. When the gateway is launched from a
 * context whose PATH is missing the dir the CLI actually lives in (e.g.
 * `claude` in ~/.local/bin, or an npm-global / nvm / bun bin not exported to
 * the daemon), the spawn throws ENOENT and the setup page reports the CLI as
 * "not installed" even though it is on the user's interactive-shell PATH.
 *
 * The helpers here:
 *   - candidateBinDirs() → OS-appropriate user bin dirs a daemon PATH omits.
 *   - enrichedPath()     → PATH augmented with those dirs so we detect (and
 *                          later spawn) CLIs the daemon PATH misses.
 *   - resolveBin()       → which-like absolute-path resolution against that PATH.
 *   - describeBinSearch()→ the ordered list of every path the resolver tried
 *                          plus the winning path (for the wizard's Re-check UI).
 *   - checkCliInstalled()→ resolve + run `--version`, returning binPath too.
 *   - osInstallHint()    → pick a platform-appropriate install command.
 *
 * Windows note: on Windows a service/daemon PATH frequently omits the npm /
 * pnpm / yarn / bun / deno / cargo / winget / scoop / choco / Python shim
 * folders where the coder CLIs actually install their launchers, so
 * candidateBinDirs() returns a Windows-flavored list (existsSync-filtered)
 * rather than the Unix dirs that would never match.
 *
 * COORDINATION: gemini-backend / coder-detect-fix / win-bin-detect — new file.
 */

import { existsSync, accessSync, constants as fsConstants, statSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, win32 as winPath, dirname } from "node:path";
import { execFileSync } from "node:child_process";

import { codersBinDir } from "../coder-install/paths.js";
import type { BackendInstallStatus } from "./types.js";

const isWin = platform() === "win32";

/**
 * Injectable environment for binary detection. Production code uses the real
 * OS/env/fs; tests pass overrides so they can pretend to be Windows on Linux
 * without monkey-patching global modules.
 */
export interface BinSearchCtx {
  /** true → use Windows dir layout + PATHEXT resolution. */
  isWin: boolean;
  /** User home directory. */
  home: string;
  /** Environment variables (read for APPDATA/LOCALAPPDATA/ProgramFiles/…). */
  env: NodeJS.ProcessEnv;
  /** Directory of the node binary running us (holds nvm/volta global CLIs). */
  nodeBin: string;
  /** existsSync-equivalent; lets tests fake a filesystem. */
  exists: (p: string) => boolean;
  /** True if `p` is a regular file. Defaults to a statSync probe. */
  isFile: (p: string) => boolean;
  /** readdirSync-equivalent returning [] on error; used for Python3* globbing. */
  readdir: (p: string) => string[];
  /**
   * Shim dir of coders installed from Setup › Coders (`<state>/coders/bin`,
   * cloud: `/data/coders/bin`). Searched FIRST so a coder the owner installed
   * through InfiniBot wins over an older system copy, and a fresh install
   * resolves on the next spawn with no restart. null disables it.
   */
  managedBinDir: string | null;
}

function defaultManagedBinDir(): string | null {
  try {
    return codersBinDir();
  } catch {
    return null;
  }
}

/** PATH list separator for the (simulated) platform. */
function pathSep(ctx: BinSearchCtx): string {
  return ctx.isWin ? ";" : ":";
}

function resolveCtx(over?: Partial<BinSearchCtx>): BinSearchCtx {
  return {
    isWin: over?.isWin ?? isWin,
    home: over?.home ?? homedir(),
    env: over?.env ?? process.env,
    nodeBin: over?.nodeBin ?? dirname(process.execPath),
    exists: over?.exists ?? existsSync,
    managedBinDir:
      over && "managedBinDir" in over ? (over.managedBinDir ?? null) : defaultManagedBinDir(),
    isFile:
      over?.isFile ??
      ((p: string) => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      }),
    readdir:
      over?.readdir ??
      ((p: string) => {
        try {
          return readdirSync(p);
        } catch {
          return [];
        }
      }),
  };
}

/**
 * Resolve `%LOCALAPPDATA%\Programs\Python\Python3*\Scripts` by globbing the
 * Python install root. Best-effort: returns [] if the root is absent.
 */
function pythonScriptDirs(localAppData: string, ctx: BinSearchCtx): string[] {
  const pyRoot = winPath.join(localAppData, "Programs", "Python");
  if (!ctx.exists(pyRoot)) return [];
  return ctx
    .readdir(pyRoot)
    .filter((name) => /^Python3/i.test(name))
    .map((name) => winPath.join(pyRoot, name, "Scripts"));
}

/**
 * Candidate user bin directories that a daemon PATH frequently omits.
 *
 * Windows: every entry is existsSync-checked before inclusion (silently
 * dropped if missing) so the enriched PATH never carries phantom dirs.
 * Non-Windows: the original Unix list, returned verbatim (no regression).
 */
export function candidateBinDirs(over?: Partial<BinSearchCtx>): string[] {
  const ctx = resolveCtx(over);
  const { home, env, nodeBin } = ctx;

  if (ctx.isWin) {
    const j = winPath.join;
    const appData = env.APPDATA ?? j(home, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA ?? j(home, "AppData", "Local");
    const userProfile = env.USERPROFILE ?? home;
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const choco = env.ChocolateyInstall ?? "C:\\ProgramData\\chocolatey";
    const scoop = env.SCOOP ?? j(userProfile, "scoop");

    // Ordered, most-specific-first. Duplicates (e.g. %APPDATA%\npm vs
    // %USERPROFILE%\AppData\Roaming\npm) are harmless — enrichedPath() dedups.
    const raw = [
      nodeBin, // nvm/volta/fnm-managed node ships its global CLIs here
      env.INFINIBOT_CODER_BIN ?? "C:\\node22", // CLI coder .cmd shims (claude/codex/opencode); master runs as Electron so nodeBin != here
      j(appData, "npm"), // npm -g shims (claude.cmd, codex.cmd, …)
      j(localAppData, "pnpm"), // pnpm global bin
      j(localAppData, "Yarn", "bin"), // yarn global bin
      j(localAppData, "bun", "bin"), // bun (LOCALAPPDATA layout)
      j(userProfile, ".bun", "bin"), // bun (home layout)
      j(userProfile, ".deno", "bin"), // deno
      j(userProfile, ".cargo", "bin"), // cargo / rust CLIs
      j(userProfile, "AppData", "Roaming", "npm"), // npm -g when APPDATA unset
      j(localAppData, "Programs"), // per-user installers (e.g. opencode)
      j(programFiles, "nodejs"), // machine-wide node
      j(programFilesX86, "nodejs"),
      ...pythonScriptDirs(localAppData, ctx), // pip-installed console_scripts
      j(localAppData, "Microsoft", "WinGet", "Links"), // winget shims
      j(localAppData, "Microsoft", "WindowsApps"), // winget/Store app aliases
      j(choco, "bin"), // Chocolatey shims
      j(scoop, "shims"), // Scoop shims
      j(programFiles, "Git", "cmd"), // Git for Windows helpers (gemini installer)
    ];

    // existsSync-filter, then dedupe (e.g. %APPDATA%\npm and the
    // %USERPROFILE%\AppData\Roaming\npm fallback collapse to one path).
    const out: string[] = [];
    const seen = new Set<string>();
    for (const dir of raw) {
      const key = dir.replace(/[\\/]+$/, "").toLowerCase();
      if (seen.has(key) || !ctx.exists(dir)) continue;
      seen.add(key);
      out.push(dir);
    }
    return out;
  }

  return [
    join(home, ".infinibot", "android-build-tools", "adb-compat", "platform-tools-35.0.2"),
    join(home, ".infinibot", "android-build-tools", "android-sdk", "platform-tools"),
    join(
      home,
      ".infinibot",
      "android-build-tools",
      "android-sdk",
      "cmdline-tools",
      "latest",
      "bin",
    ),
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".deno", "bin"),
    join(home, ".local", "share", "pnpm"),
    join(home, ".yarn", "bin"),
    join(home, ".cargo", "bin"),
    nodeBin,
    "/usr/local/bin",
    "/opt/homebrew/bin", // Apple-silicon Homebrew
    "/usr/bin",
    "/bin",
  ];
}

/**
 * PATH augmented with common user bin dirs (existing entries kept first),
 * with the managed coders shim dir (when it exists) in front of everything.
 */
export function enrichedPath(over?: Partial<BinSearchCtx>): string {
  const ctx = resolveCtx(over);
  const sep = pathSep(ctx);
  const managed = ctx.managedBinDir && ctx.exists(ctx.managedBinDir) ? [ctx.managedBinDir] : [];
  const current = [
    ...managed,
    ...(ctx.env.PATH ?? "")
      .split(sep)
      .filter((d) => d && d.replace(/[\\/]+$/, "") !== managed[0]?.replace(/[\\/]+$/, "")),
  ];
  const seen = new Set(current.map((d) => d.replace(/[\\/]+$/, "")));
  const extra: string[] = [];
  for (const dir of candidateBinDirs(ctx)) {
    const norm = dir.replace(/[\\/]+$/, "");
    if (!seen.has(norm)) {
      seen.add(norm);
      extra.push(dir);
    }
  }
  return [...current, ...extra].join(sep);
}

/**
 * Return an env object identical to process.env but with PATH enriched, so a
 * spawned CLI is found wherever detection found it. Safe to spread over.
 */
export function enrichedPathEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(base ?? process.env) };
  env.PATH = enrichedPath();
  return env;
}

function isExecutableFile(p: string, ctx: BinSearchCtx): boolean {
  try {
    if (!ctx.exists(p)) return false;
    if (!ctx.isFile(p)) return false;
    if (ctx.isWin) return true; // X-bit isn't meaningful on Windows
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Windows executable extensions to try, in PATHEXT priority order. */
function windowsExts(ctx: BinSearchCtx): string[] {
  // PATHEXT is split on ";" (the only separator Windows uses, even when an
  // entry contains spaces). A trailing "" lets an explicitly-extensioned name
  // (e.g. "claude.exe") resolve without doubling the extension.
  const ext = (ctx.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
  return [...ext, ""];
}

/**
 * which-like search core: walk the enriched PATH, recording every absolute
 * candidate path inspected and the first one that resolves to an executable.
 * Powers both resolveBin() (caller wants just the answer) and
 * describeBinSearch() (the wizard wants the full trail for "we looked here").
 */
export function describeBinSearch(
  bin: string,
  over?: Partial<BinSearchCtx>,
): { tried: string[]; resolved?: string } {
  const ctx = resolveCtx(over);
  const tried: string[] = [];

  // Absolute / explicit path passed straight through.
  if (bin.includes("/") || (ctx.isWin && bin.includes("\\"))) {
    tried.push(bin);
    return { tried, resolved: isExecutableFile(bin, ctx) ? bin : undefined };
  }

  const exts = ctx.isWin ? windowsExts(ctx) : [""];
  const j = ctx.isWin ? winPath.join : join;
  let resolved: string | undefined;
  for (const dir of enrichedPath(ctx).split(pathSep(ctx)).filter(Boolean)) {
    for (const ext of exts) {
      const full = j(dir, bin + ext);
      tried.push(full);
      if (!resolved && isExecutableFile(full, ctx)) resolved = full;
    }
  }
  return { tried, resolved };
}

/**
 * which-like resolution: return the absolute path to `bin` by scanning the
 * enriched PATH, or undefined if not found. On Windows, tries the common
 * executable extensions (PATHEXT order) and also the name verbatim so an
 * explicit "claude.exe" still resolves.
 */
export function resolveBin(bin: string, over?: Partial<BinSearchCtx>): string | undefined {
  return describeBinSearch(bin, over).resolved;
}

/**
 * Pick a platform-appropriate install hint. Callers pass both a Windows and a
 * Unix command so Windows users never see a brew/curl line they can't run.
 */
export function osInstallHint(hints: { win: string; unix: string }): string {
  return isWin ? hints.win : hints.unix;
}

/**
 * Detect a CLI: resolve its absolute path against the enriched PATH and run
 * `<bin> <versionArgs>` to confirm it executes, capturing the reported version.
 *
 * Returns `{ installed, version, binPath }` on success, or
 * `{ installed: false, installHint }` when the binary can't be found/run.
 */
export function checkCliInstalled(
  bin: string,
  installHint: string,
  versionArgs: string[] = ["--version"],
): BackendInstallStatus {
  const binPath = resolveBin(bin);
  // Use the resolved absolute path when we have one (immune to a stripped PATH
  // in the child); otherwise fall back to the bare name with an enriched PATH.
  const target = binPath ?? bin;
  try {
    // Windows .cmd/.bat shims (npm/pnpm/yarn-global launchers like claude.cmd)
    // can't be spawned directly on Node >=18.20/20.12/22 — execFileSync throws
    // EINVAL (the CVE-2024-27980 batch-file restriction). Route those through
    // cmd.exe so detection works wherever a global CLI installs its launcher.
    const useCmd = isWin && /\.(cmd|bat)$/i.test(target);
    const out = (
      useCmd
        ? execFileSync(
            process.env.ComSpec ?? "cmd.exe",
            ["/d", "/s", "/c", target, ...versionArgs],
            {
              timeout: 5000,
              stdio: ["ignore", "pipe", "ignore"],
              env: enrichedPathEnv(),
            },
          )
        : execFileSync(target, versionArgs, {
            timeout: 5000,
            stdio: ["ignore", "pipe", "ignore"],
            env: enrichedPathEnv(),
          })
    )
      .toString()
      .trim();
    // Some CLIs print multi-line banners on --version; keep the first line.
    const version = out.split("\n")[0]?.trim() || out;
    return { installed: true, version, binPath };
  } catch {
    return { installed: false, installHint };
  }
}
