/**
 * Launch-time wiring that lets a coder CLI drain its operator inbox by itself.
 * Called by the backend launchers with the CANONICAL runId (continuations and
 * restart-resumes pass the same runId, so they reconnect to the same inbox).
 *
 * `INFINIBOT_SUBAGENT_INBOX=0` disables the in-CLI shims (messages then only
 * reach the agent through the MCP piggyback / subagent_inbox tool).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { shQuote } from "../coder-backend/durable-spawn.js";
import { ensureClaudeInboxHookScript, ensureOpencodeInboxPlugin } from "./hook-scripts.js";
import { inboxDirForRun } from "./store.js";

export function isInboxShimEnabled(): boolean {
  return process.env.INFINIBOT_SUBAGENT_INBOX !== "0";
}

function quoteArg(value: string): string {
  // Claude runs hook commands through the platform shell.
  return process.platform === "win32" ? `"${value.replace(/"/g, '\\"')}"` : shQuote(value);
}

/**
 * Build the Claude Code `--settings` file registering the inbox hooks for this
 * run and return its path, or null when disabled / on any failure (the run
 * then still launches — only mid-run delivery degrades to the MCP fallback).
 */
export function prepareClaudeInboxSettings(runId: string | undefined): string | null {
  if (!runId || !isInboxShimEnabled()) return null;
  try {
    const script = ensureClaudeInboxHookScript();
    const dir = inboxDirForRun(runId);
    mkdirSync(dir, { recursive: true });
    const cmd = (event: string) =>
      [process.execPath, script, event, dir].map((a) => quoteArg(a)).join(" ");
    const settings = {
      hooks: {
        PostToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: cmd("PostToolUse"), timeout: 10 }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: cmd("Stop"), timeout: 10 }] }],
      },
    };
    const file = path.join(dir, "claude-settings.json");
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    return file;
  } catch {
    return null;
  }
}

/**
 * OpenCode wiring: the plugin file URL to add to OPENCODE_CONFIG_CONTENT's
 * `plugin` list plus the env var telling it which inbox to drain.
 */
export function prepareOpencodeInboxPlugin(
  runId: string | undefined,
): { pluginUrl: string; env: Record<string, string> } | null {
  if (!runId || !isInboxShimEnabled()) return null;
  try {
    const plugin = ensureOpencodeInboxPlugin();
    const dir = inboxDirForRun(runId);
    mkdirSync(dir, { recursive: true });
    return {
      pluginUrl: pathToFileURL(plugin).href,
      env: { INFINIBOT_SUBAGENT_INBOX_DIR: dir },
    };
  } catch {
    return null;
  }
}
