import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadDotEnv } from "../infra/dotenv.js";
import { normalizeEnv } from "../infra/env.js";
import { isMainModule } from "../infra/is-main.js";
import { ensureInfiniBotCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import {
  installUncaughtExceptionHandler,
  installUnhandledRejectionHandler,
} from "../infra/unhandled-rejections.js";
import { enableConsoleCapture } from "../logging.js";
import { getCommandPath, getPrimaryCommand, hasHelpOrVersion } from "./argv.js";
import { tryRouteCli } from "./route.js";

export function rewriteUpdateFlagArgv(argv: string[]): string[] {
  const index = argv.indexOf("--update");
  if (index === -1) return argv;

  const next = [...argv];
  next.splice(index, 1, "update");
  return next;
}

/**
 * One-shot commands that must terminate once their action resolves.
 *
 * Importing the command graph pulls in gateway modules, some of which arm
 * timers/watchers at import time (e.g. the discipline auto-log). In a
 * long-running gateway that is intended; in a one-shot command it keeps the
 * event loop alive forever, so `onboard --non-interactive` or `doctor` finish
 * their work and then hang. For these commands we exit explicitly once the
 * action is done. Long-running commands (gateway, tui, node, logs, acp, …)
 * are deliberately NOT listed.
 */
const EXIT_AFTER_COMMANDS = new Set([
  "onboard",
  "setup",
  "configure",
  "doctor",
  "status",
  "health",
  "config",
  "models",
  "sessions",
  "queue",
  // Robovoice plugin CLI: every subcommand (login/status/call/…) returns when done.
  "robovoice",
]);

/**
 * One-shot subcommands of otherwise long-running commands. `gateway` itself
 * (and `gateway run`) serve forever; these only talk to a gateway and return.
 */
const EXIT_AFTER_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  gateway: new Set([
    "status",
    "install",
    "uninstall",
    "start",
    "stop",
    "restart",
    "call",
    "usage-cost",
    "health",
    "probe",
    "discover",
  ]),
};

export function shouldExitAfterCommand(argv: string[]): boolean {
  if (hasHelpOrVersion(argv)) return true;
  const [primary, sub] = getCommandPath(argv, 2);
  if (!primary) return false;
  if (EXIT_AFTER_COMMANDS.has(primary)) return true;
  return sub !== undefined && EXIT_AFTER_SUBCOMMANDS[primary]?.has(sub) === true;
}

function exitIfOneShot(argv: string[]): void {
  if (!shouldExitAfterCommand(argv)) return;
  process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
}

export async function runCli(argv: string[] = process.argv) {
  const normalizedArgv = stripWindowsNodeExec(argv);
  loadDotEnv({ quiet: true });
  normalizeEnv();
  ensureInfiniBotCliOnPath();

  // Enforce the minimum supported runtime before doing any work.
  assertSupportedRuntime();

  if (await tryRouteCli(normalizedArgv)) {
    exitIfOneShot(normalizedArgv);
    return;
  }

  // Capture all console output into structured logs while keeping stdout/stderr behavior.
  enableConsoleCapture();

  const { buildProgram } = await import("./program.js");
  const program = buildProgram();

  // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
  // These log the error and exit gracefully instead of crashing without trace.
  installUnhandledRejectionHandler();
  installUncaughtExceptionHandler();

  const parseArgv = rewriteUpdateFlagArgv(normalizedArgv);
  // Register the primary subcommand if one exists (for lazy-loading)
  const primary = getPrimaryCommand(parseArgv);
  if (primary) {
    const { registerSubCliByName } = await import("./program/register.subclis.js");
    await registerSubCliByName(program, primary);
  }

  const shouldSkipPluginRegistration = !primary && hasHelpOrVersion(parseArgv);
  if (!shouldSkipPluginRegistration) {
    // Register plugin CLI commands before parsing
    const { registerPluginCliCommands } = await import("../plugins/cli.js");
    const { loadConfig } = await import("../config/config.js");
    registerPluginCliCommands(program, loadConfig());
  }

  await program.parseAsync(parseArgv);
  exitIfOneShot(parseArgv);
}

function stripWindowsNodeExec(argv: string[]): string[] {
  if (process.platform !== "win32") return argv;
  const stripControlChars = (value: string): string => {
    let out = "";
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code >= 32 && code !== 127) {
        out += value[i];
      }
    }
    return out;
  };
  const normalizeArg = (value: string): string =>
    stripControlChars(value)
      .replace(/^['"]+|['"]+$/g, "")
      .trim();
  const normalizeCandidate = (value: string): string =>
    normalizeArg(value).replace(/^\\\\\\?\\/, "");
  const execPath = normalizeCandidate(process.execPath);
  const execPathLower = execPath.toLowerCase();
  const execBase = path.basename(execPath).toLowerCase();
  const isExecPath = (value: string | undefined): boolean => {
    if (!value) return false;
    const normalized = normalizeCandidate(value);
    if (!normalized) return false;
    const lower = normalized.toLowerCase();
    return (
      lower === execPathLower ||
      path.basename(lower) === execBase ||
      lower.endsWith("\\node.exe") ||
      lower.endsWith("/node.exe") ||
      lower.includes("node.exe") ||
      (path.basename(lower) === "node.exe" && fs.existsSync(normalized))
    );
  };
  const filtered = argv.filter((arg, index) => index === 0 || !isExecPath(arg));
  if (filtered.length < 3) return filtered;
  const cleaned = [...filtered];
  if (isExecPath(cleaned[1])) {
    cleaned.splice(1, 1);
  }
  if (isExecPath(cleaned[2])) {
    cleaned.splice(2, 1);
  }
  return cleaned;
}

export function isCliMainModule(): boolean {
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
