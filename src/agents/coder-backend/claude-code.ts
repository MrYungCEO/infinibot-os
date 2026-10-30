/**
 * ClaudeCodeBackend — thin wrapper around the existing CC launcher.
 *
 * Delegates 100% to the original functions in launcher.ts so behaviour
 * is byte-for-byte identical to the pre-abstraction code.
 *
 * MCP global registration writes to ~/.claude.json (mcpServers key).
 *
 * COORDINATION: opencode-swap — new file; no existing code modified here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { checkCliInstalled, osInstallHint } from "./bin-detect.js";
import {
  spawnClaudeCodeAgent,
  spawnClaudeCodeAgentBackground,
  type SessionInfo,
  type LaunchOptions,
  type BackgroundSession,
} from "../claude-code/launcher.js";
import type { CLIAgentConfig } from "../types/agent-types.js";
import type {
  CoderBackend,
  CoderBackendCapabilities,
  BackendInstallStatus,
  McpServerEntry,
} from "./types.js";

// Path to Claude Code's global config (modern format).
const CC_GLOBAL_CONFIG = join(homedir(), ".claude.json");

function readCCConfig(): Record<string, unknown> {
  if (!existsSync(CC_GLOBAL_CONFIG)) return {};
  try {
    const raw = readFileSync(CC_GLOBAL_CONFIG, "utf8").trim();
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeCCConfig(data: Record<string, unknown>): void {
  const dir = join(homedir(), ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(CC_GLOBAL_CONFIG, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export class ClaudeCodeBackend implements CoderBackend {
  readonly id = "claude-code" as const;

  spawn(
    config: CLIAgentConfig,
    task: string,
    workdir: string,
    options?: LaunchOptions,
  ): Promise<SessionInfo> {
    return spawnClaudeCodeAgent(config, task, workdir, options);
  }

  spawnBackground(
    config: CLIAgentConfig,
    task: string,
    workdir: string,
    options?: LaunchOptions,
  ): BackgroundSession {
    return spawnClaudeCodeAgentBackground(config, task, workdir, options);
  }

  async installMcp(serverName: string, entry: McpServerEntry): Promise<void> {
    const cfg = readCCConfig();
    const servers: Record<string, unknown> =
      cfg.mcpServers && typeof cfg.mcpServers === "object" && !Array.isArray(cfg.mcpServers)
        ? { ...(cfg.mcpServers as Record<string, unknown>) }
        : {};
    servers[serverName] = entry;
    writeCCConfig({ ...cfg, mcpServers: servers });
  }

  async uninstallMcp(serverName: string): Promise<void> {
    const cfg = readCCConfig();
    const servers: Record<string, unknown> =
      cfg.mcpServers && typeof cfg.mcpServers === "object" && !Array.isArray(cfg.mcpServers)
        ? { ...(cfg.mcpServers as Record<string, unknown>) }
        : {};
    delete servers[serverName];
    writeCCConfig({ ...cfg, mcpServers: servers });
  }

  async listInstalledMcps(): Promise<string[]> {
    const cfg = readCCConfig();
    if (!cfg.mcpServers || typeof cfg.mcpServers !== "object" || Array.isArray(cfg.mcpServers)) {
      return [];
    }
    return Object.keys(cfg.mcpServers as Record<string, unknown>);
  }

  getCapabilities(): CoderBackendCapabilities {
    return {
      id: "claude-code",
      displayName: "Claude Code",
      supportsStreamJson: true,
      supportsMcpConfig: true,
      supportsSessionResume: true,
      supportsParallelSessions: false,
      modelFormat: "name",
    };
  }

  async checkInstalled(): Promise<BackendInstallStatus> {
    return checkCliInstalled(
      "claude",
      osInstallHint({
        win: "winget install Anthropic.Claude.Code   (or: npm i -g @anthropic-ai/claude-code)",
        unix: "npm install -g @anthropic-ai/claude-code",
      }),
    );
  }
}
