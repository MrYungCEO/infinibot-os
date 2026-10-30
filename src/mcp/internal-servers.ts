/**
 * Internal MCP Servers
 *
 * Reads `mcpServers` out of the InfiniBot config (same shape as Claude Code's
 * `~/.claude.json`) and mirrors enabled entries into Claude Code so they
 * become callable from Claude Coder. Bidirectional source-of-truth lives in
 * the InfiniBot config — Claude Code is just a derived sink.
 *
 * Compatible with the existing `infinibot` entry registered via
 * `claude-code-register.ts`; we simply write additional sibling keys under
 * the same `mcpServers` object.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { InfinibotConfig, McpServerEntry } from "../config/types.infinibot.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { INFINIBOT_MCP_ENTRY_KEY } from "./claude-code-register.js";

const log = createSubsystemLogger("mcp").child("internal-servers");

interface ConfigShape {
  mcpServers?: Record<string, unknown>;
  [extra: string]: unknown;
}

function defaultClaudeCodeConfigPath(): string {
  return join(homedir(), ".claude.json");
}

function readConfigFile(path: string): ConfigShape {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as ConfigShape;
  } catch (err) {
    log.warn("Failed to read Claude Code config; treating as empty", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

function writeConfigFile(path: string, data: ConfigShape): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/** Convert an InfiniBot config entry into the shape Claude Code expects. */
function buildEntry(entry: McpServerEntry): Record<string, unknown> | null {
  const type = entry.type ?? "stdio";
  if (type === "stdio") {
    if (!entry.command) return null;
    const out: Record<string, unknown> = {
      type: "stdio",
      command: entry.command,
    };
    if (entry.args && entry.args.length > 0) out.args = entry.args;
    if (entry.env && Object.keys(entry.env).length > 0) out.env = entry.env;
    return out;
  }
  if (type === "http" || type === "sse") {
    if (!entry.url) return null;
    const out: Record<string, unknown> = { type, url: entry.url };
    if (entry.headers && Object.keys(entry.headers).length > 0) out.headers = entry.headers;
    return out;
  }
  return null;
}

export interface ListInternalServersResult {
  name: string;
  entry: McpServerEntry;
  syncedToClaudeCode: boolean;
}

/** List internal MCP servers declared in the InfiniBot config. */
export function listInternalMcpServers(
  cfg: InfinibotConfig,
): ListInternalServersResult[] {
  const servers = cfg.mcpServers ?? {};
  return Object.entries(servers).map(([name, entry]) => ({
    name,
    entry,
    syncedToClaudeCode: entry.syncToClaudeCode !== false && entry.enabled !== false,
  }));
}

export interface SyncResult {
  /** Path that was written to. */
  path: string;
  /** Names that were upserted into Claude Code's mcpServers. */
  added: string[];
  /** Names that were removed from Claude Code's mcpServers. */
  removed: string[];
  /** Names that were skipped (disabled or invalid). */
  skipped: string[];
  /** Whether the file was modified. */
  changed: boolean;
}

/**
 * Mirror enabled servers from the InfiniBot config into Claude Code's
 * `mcpServers` block. Anything we previously synced and is no longer enabled
 * gets removed. Other entries (the canonical `infinibot` server, and any
 * Claude-Code-managed entries) are left untouched.
 *
 * Tracks which keys we own via the `__infinibotManaged` array in the config
 * file so we don't accidentally remove servers the user added by hand.
 */
export function syncInternalMcpToClaudeCode(
  cfg: InfinibotConfig,
  opts: { configPath?: string } = {},
): SyncResult {
  const path = opts.configPath ?? defaultClaudeCodeConfigPath();
  const existing = readConfigFile(path);
  const claudeServers: Record<string, unknown> =
    existing.mcpServers && typeof existing.mcpServers === "object" && !Array.isArray(existing.mcpServers)
      ? { ...(existing.mcpServers as Record<string, unknown>) }
      : {};
  const managedKey = "__infinibotManagedKeys";
  const previouslyManaged = Array.isArray((existing as { [k: string]: unknown })[managedKey])
    ? ((existing as { [k: string]: unknown })[managedKey] as string[])
    : [];

  const added: string[] = [];
  const skipped: string[] = [];
  const newlyManaged: string[] = [];

  const declared = cfg.mcpServers ?? {};
  for (const [name, entry] of Object.entries(declared)) {
    // Reserved name: the canonical infinibot stdio server.
    if (name === INFINIBOT_MCP_ENTRY_KEY) {
      skipped.push(name);
      continue;
    }
    const enabled = entry.enabled !== false;
    const sync = entry.syncToClaudeCode !== false;
    if (!enabled || !sync) {
      skipped.push(name);
      continue;
    }
    const built = buildEntry(entry);
    if (!built) {
      skipped.push(name);
      continue;
    }
    claudeServers[name] = built;
    added.push(name);
    newlyManaged.push(name);
  }

  // Remove keys we previously managed but are no longer declared/enabled.
  const removed: string[] = [];
  for (const name of previouslyManaged) {
    if (newlyManaged.includes(name)) continue;
    if (name === INFINIBOT_MCP_ENTRY_KEY) continue;
    if (name in claudeServers) {
      delete claudeServers[name];
      removed.push(name);
    }
  }

  const next: ConfigShape = {
    ...existing,
    mcpServers: claudeServers,
    [managedKey]: newlyManaged,
  };

  // Detect whether anything actually changed.
  const before = JSON.stringify(existing);
  const after = JSON.stringify(next);
  const changed = before !== after;
  if (changed) {
    writeConfigFile(path, next);
    log.info("Synced internal MCP servers to Claude Code", {
      path,
      added: added.length,
      removed: removed.length,
      skipped: skipped.length,
    });
  }
  return { path, added, removed, skipped, changed };
}

/**
 * Upsert a single internal MCP server into the InfiniBot config.
 * Mutates `cfg` in place. Caller is responsible for persisting.
 */
export function upsertInternalMcpServer(
  cfg: InfinibotConfig,
  name: string,
  entry: McpServerEntry,
): void {
  if (!cfg.mcpServers) cfg.mcpServers = {};
  cfg.mcpServers[name] = entry;
}

export function removeInternalMcpServer(cfg: InfinibotConfig, name: string): boolean {
  if (!cfg.mcpServers || !(name in cfg.mcpServers)) return false;
  delete cfg.mcpServers[name];
  return true;
}
