/**
 * Upserts an "infinibot" entry under the top-level `mcpServers` object in
 * ~/.claude.json (the file modern Claude Code reads for user-scope MCP
 * servers). Safe to re-run — we merge with existing entries and only touch
 * our own key. We also keep the legacy ~/.claude/mcp.json in sync for any
 * older Claude Code builds still consuming that path.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("mcp").child("claude-code-register");

export const INFINIBOT_MCP_ENTRY_KEY = "infinibot";

export interface ClaudeCodeRegisterOptions {
  /** WebSocket URL the MCP process will dial to reach the gateway. */
  gatewayUrl: string;
  /** Auth token — used when the gateway is in token mode. */
  gatewayToken?: string;
  /** Shared password — used when the gateway is in password mode. */
  gatewayPassword?: string;
  /** Default session key the MCP server should use for tool invocations. */
  defaultSessionKey?: string;
  /** Primary config path. Defaults to ~/.claude.json. */
  configPath?: string;
  /** If true, overwrite an existing entry even when contents differ. */
  force?: boolean;
  /** If true, also mirror into ~/.claude/mcp.json. Default true. */
  legacyMirror?: boolean;
}

export interface ClaudeCodeRegisterResult {
  /** Absolute path written to. */
  path: string;
  /** True if the file was modified. */
  changed: boolean;
  /** The entry that was written. */
  entry: Record<string, unknown>;
}

interface McpConfigShape {
  mcpServers?: Record<string, unknown>;
  // Permits additional top-level keys that Claude Code may add.
  [extra: string]: unknown;
}

function resolveRepoRoot(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, "..", "..");
  } catch {
    return process.cwd();
  }
}

function defaultConfigPath(): string {
  // Modern Claude Code reads ~/.claude.json (top-level mcpServers).
  return join(homedir(), ".claude.json");
}

function legacyConfigPath(): string {
  return join(homedir(), ".claude", "mcp.json");
}

function readConfig(path: string): McpConfigShape {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as McpConfigShape;
  } catch (err) {
    log.warn("Failed to read Claude Code mcp.json; treating as empty", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

function writeConfig(path: string, data: McpConfigShape): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    const av = a[ak[i]!];
    const bv = b[bk[i]!];
    if (typeof av !== typeof bv) return false;
    if (av && typeof av === "object") {
      if (JSON.stringify(av) !== JSON.stringify(bv)) return false;
    } else if (av !== bv) {
      return false;
    }
  }
  return true;
}

export function buildInfinibotEntry(opts: ClaudeCodeRegisterOptions): Record<string, unknown> {
  const repoRoot = resolveRepoRoot();
  // Dedicated stdio entry — runs runMcpServer() directly from main().
  // `mcp-cli.js` only REGISTERS a subcommand and isn't directly executable.
  const distEntry = join(repoRoot, "dist", "cli", "mcp-stdio.js");
  const env: Record<string, string> = {
    MOLTBOT_GATEWAY_URL: opts.gatewayUrl,
  };
  if (opts.gatewayToken) env.MOLTBOT_GATEWAY_TOKEN = opts.gatewayToken;
  if (opts.gatewayPassword) env.MOLTBOT_GATEWAY_PASSWORD = opts.gatewayPassword;
  if (opts.defaultSessionKey) env.MOLTBOT_DEFAULT_SESSION_KEY = opts.defaultSessionKey;
  // Packaged desktop app: process.execPath is the Electron binary.
  if (process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) env.ELECTRON_RUN_AS_NODE = "1";

  return {
    // Claude Code requires a "type" field to distinguish stdio from http.
    type: "stdio",
    command: process.execPath, // current node binary
    args: [distEntry],
    env,
  };
}

/**
 * Upsert the "infinibot" server entry in Claude Code's mcp.json.
 * Returns { changed } so callers can log whether anything was written.
 */
export function registerInfinibotInClaudeCode(
  opts: ClaudeCodeRegisterOptions,
): ClaudeCodeRegisterResult {
  const path = opts.configPath ?? defaultConfigPath();
  const existing = readConfig(path);
  const servers: Record<string, unknown> =
    existing.mcpServers &&
    typeof existing.mcpServers === "object" &&
    !Array.isArray(existing.mcpServers)
      ? { ...(existing.mcpServers as Record<string, unknown>) }
      : {};
  const entry = buildInfinibotEntry(opts);
  const current = servers[INFINIBOT_MCP_ENTRY_KEY];
  // Setup › AI apps writes a secret-free entry (credential read from the
  // InfiniBot config at start-up). Keep it rather than re-embedding a secret.
  const currentEnv = (current as { env?: Record<string, unknown> } | undefined)?.env;
  if (opts.force !== true && currentEnv?.INFINIBOT_MCP_AUTH === "config") {
    return { path, changed: false, entry: current as Record<string, unknown> };
  }
  const needsWrite =
    opts.force === true ||
    !current ||
    typeof current !== "object" ||
    !shallowEqual(current as Record<string, unknown>, entry);

  if (!needsWrite) {
    // Still mirror the legacy path on every call in case it was stale.
    if (opts.legacyMirror !== false) mirrorToLegacyPath(entry);
    return { path, changed: false, entry };
  }
  servers[INFINIBOT_MCP_ENTRY_KEY] = entry;
  const next: McpConfigShape = { ...existing, mcpServers: servers };
  writeConfig(path, next);
  log.info("Registered infinibot MCP entry in Claude Code config", {
    path,
    gatewayUrl: opts.gatewayUrl,
  });
  if (opts.legacyMirror !== false) mirrorToLegacyPath(entry);
  return { path, changed: true, entry };
}

function mirrorToLegacyPath(entry: Record<string, unknown>): void {
  const path = legacyConfigPath();
  try {
    const existing = readConfig(path);
    const servers: Record<string, unknown> =
      existing.mcpServers &&
      typeof existing.mcpServers === "object" &&
      !Array.isArray(existing.mcpServers)
        ? { ...(existing.mcpServers as Record<string, unknown>) }
        : {};
    const current = servers[INFINIBOT_MCP_ENTRY_KEY];
    if (
      current &&
      typeof current === "object" &&
      shallowEqual(current as Record<string, unknown>, entry)
    ) {
      return;
    }
    servers[INFINIBOT_MCP_ENTRY_KEY] = entry;
    writeConfig(path, { ...existing, mcpServers: servers });
  } catch (err) {
    log.warn("Failed to mirror infinibot entry to legacy path", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Returns whether the infinibot entry currently exists in Claude Code's
 * mcp config. Does not validate that the entry points at the current binary
 * or env — for that the caller should re-register with force:false and
 * inspect `changed`.
 */
export function isInfinibotRegisteredInClaudeCode(opts?: { configPath?: string }): {
  path: string;
  registered: boolean;
} {
  const path = opts?.configPath ?? defaultConfigPath();
  const existing = readConfig(path);
  const servers = existing.mcpServers as Record<string, unknown> | undefined;
  const registered =
    !!servers &&
    typeof servers === "object" &&
    !Array.isArray(servers) &&
    INFINIBOT_MCP_ENTRY_KEY in servers;
  return { path, registered };
}

/**
 * Remove the "infinibot" server entry. No-op when absent.
 */
export function unregisterInfinibotFromClaudeCode(opts?: { configPath?: string }): {
  path: string;
  removed: boolean;
} {
  const path = opts?.configPath ?? defaultConfigPath();
  let removed = false;
  for (const target of [path, legacyConfigPath()]) {
    try {
      const existing = readConfig(target);
      const servers =
        existing.mcpServers && typeof existing.mcpServers === "object"
          ? { ...(existing.mcpServers as Record<string, unknown>) }
          : {};
      if (!(INFINIBOT_MCP_ENTRY_KEY in servers)) continue;
      delete servers[INFINIBOT_MCP_ENTRY_KEY];
      writeConfig(target, { ...existing, mcpServers: servers });
      removed = true;
    } catch {
      /* ignore */
    }
  }
  return { path, removed };
}
