#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";

// @hyperframes/producer bundles CJS require() calls but declares "type": "module".
globalThis.require = createRequire(import.meta.url);
import { backfillStateFromRepo, ensureStateDirEnv, migrateLegacyStateDir } from "./config/paths.js";
import { applySaasDataRoot, sealPlatformSecrets } from "./saas/config.js";
import { isTruthyEnvValue } from "./infra/env.js";
import { installProcessWarningFilter } from "./infra/warnings.js";
import { attachChildProcessBridge } from "./process/child-process-bridge.js";

process.title = "infinibot";
installProcessWarningFilter();
migrateLegacyStateDir();
// One-shot rescue of stale repo-local state/ data (business.json + databases.db)
// for installs that historically wrote to <cwd>/state via the old bare-env
// `?? "state"` fallback. Never overwrites existing canonical files.
backfillStateFromRepo();
// SaaS mode: redirect the state-dir base to the durable data volume
// (SAAS_DATA_ROOT) BEFORE it gets pinned below, so per-tenant SQLite lives on
// persistent storage. No-op when SAAS_MODE is off or the dir is already set.
applySaasDataRoot();
// Definitive MCP↔UI split-brain fix: pin INFINIBOT_STATE_DIR to the canonical
// resolved state dir when unset, so the legacy `?? "state"` readers (notes,
// research, workflows, projects→kanban, etc.) and the canonical
// resolveStateDir() callers open the SAME on-disk store. Must run before any
// store initializes; the pinned value is inherited by every child process
// (detached coder agents and their MCP stdio servers) via `env: process.env`.
ensureStateDirEnv();

if (process.argv.includes("--no-color")) {
  process.env.NO_COLOR = "1";
  process.env.FORCE_COLOR = "0";
}

const EXPERIMENTAL_WARNING_FLAG = "--disable-warning=ExperimentalWarning";

function hasExperimentalWarningSuppressed(nodeOptions: string): boolean {
  if (!nodeOptions) return false;
  return nodeOptions.includes(EXPERIMENTAL_WARNING_FLAG) || nodeOptions.includes("--no-warnings");
}

function ensureExperimentalWarningSuppressed(): boolean {
  if (isTruthyEnvValue(process.env.INFINIBOT_NO_RESPAWN)) return false;
  if (isTruthyEnvValue(process.env.INFINIBOT_NODE_OPTIONS_READY)) return false;
  const nodeOptions = process.env.NODE_OPTIONS ?? "";
  if (hasExperimentalWarningSuppressed(nodeOptions)) return false;

  process.env.INFINIBOT_NODE_OPTIONS_READY = "1";
  process.env.NODE_OPTIONS = `${nodeOptions} ${EXPERIMENTAL_WARNING_FLAG}`.trim();

  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: process.env,
  });

  attachChildProcessBridge(child);

  child.once("exit", (code, signal) => {
    if (signal) {
      process.exitCode = 1;
      return;
    }
    process.exit(code ?? 1);
  });

  child.once("error", (error) => {
    console.error(
      "[infinibot] Failed to respawn CLI:",
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exit(1);
  });

  // Parent must not continue running the CLI.
  return true;
}

function normalizeWindowsArgv(argv: string[]): string[] {
  if (process.platform !== "win32") return argv;
  if (argv.length < 2) return argv;
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
    const lower = normalizeCandidate(value).toLowerCase();
    return (
      lower === execPathLower ||
      path.basename(lower) === execBase ||
      lower.endsWith("\\node.exe") ||
      lower.endsWith("/node.exe") ||
      lower.includes("node.exe")
    );
  };
  const next = [...argv];
  for (let i = 1; i <= 3 && i < next.length; ) {
    if (isExecPath(next[i])) {
      next.splice(i, 1);
      continue;
    }
    i += 1;
  }
  const filtered = next.filter((arg, index) => index === 0 || !isExecPath(arg));
  if (filtered.length < 3) return filtered;
  const cleaned = [...filtered];
  for (let i = 2; i < cleaned.length; ) {
    const arg = cleaned[i];
    if (!arg || arg.startsWith("-")) {
      i += 1;
      continue;
    }
    if (isExecPath(arg)) {
      cleaned.splice(i, 1);
      continue;
    }
    break;
  }
  return cleaned;
}

process.argv = normalizeWindowsArgv(process.argv);

if (!ensureExperimentalWarningSuppressed()) {
  // Hosted fleet tenant Machine: platform secrets never reach child processes
  // (exec, terminals, coder CLIs, MCP, plugins). After the respawn decision so
  // a respawned child still receives them. No-op outside the fleet.
  sealPlatformSecrets();
  const parsed = parseCliProfileArgs(process.argv);
  if (!parsed.ok) {
    // Keep it simple; Commander will handle rich help/errors after we strip flags.
    console.error(`[infinibot] ${parsed.error}`);
    process.exit(2);
  }

  if (parsed.profile) {
    applyCliProfileEnv({ profile: parsed.profile });
    // Keep Commander and ad-hoc argv checks consistent.
    process.argv = parsed.argv;
  }

  import("./cli/run-main.js")
    .then(({ runCli }) => runCli(process.argv))
    .catch((error) => {
      console.error(
        "[infinibot] Failed to start CLI:",
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      process.exitCode = 1;
    });
}
