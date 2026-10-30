/**
 * Local MCP Discovery
 *
 * Discovers locally configured MCP servers from known config locations:
 * - Claude Code: ~/.claude/mcp.json
 * - Cline: VSCode globalStorage settings
 * - Custom InfiniBot MCP config
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSubsystemLogger } from "../logging/subsystem.js";

// This file compiles to dist/mcp/local-discovery.js, so climbing two levels up
// from its location lands at the repo root regardless of where the process was
// launched from. That matters because the gateway's process.cwd() is not
// guaranteed to be the infinibot root (e.g. when launched from Electron, PM2, a
// Windows service, or any wrapper shell), and a relative "state/" path would
// silently miss state/mcp-servers.json.
function resolveRepoRoot(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, "..", "..");
  } catch {
    return process.cwd();
  }
}

const log = createSubsystemLogger("mcp").child("discovery");

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export interface MCPServerConfig {
  /** Transport type. Defaults to "stdio". */
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  cwd?: string;
  /**
   * If true, the entry is kept in config files for reference but not surfaced
   * to agents or written into scoped MCP configs. Lets users toggle a server
   * off without deleting its configuration.
   */
  disabled?: boolean;
}

export interface LocalMCPServer {
  id: string;
  name: string;
  source: "claude" | "cline" | "infinibot" | "custom";
  config: MCPServerConfig;
  status: "configured" | "unknown";
  description?: string;
}

export interface MCPConfigFile {
  mcpServers?: Record<string, MCPServerConfig>;
}

// ══════════════════════════════════════════════════════════════════════════════
// Config Paths
// ══════════════════════════════════════════════════════════════════════════════

function getConfigPaths(): Array<{ path: string; source: LocalMCPServer["source"] }> {
  const home = homedir();
  const paths: Array<{ path: string; source: LocalMCPServer["source"] }> = [];

  // Claude Code config
  paths.push({ path: join(home, ".claude", "mcp.json"), source: "claude" });

  // Cline (VSCode extension) config
  const platform = process.platform;
  let appData: string;
  if (platform === "win32") {
    appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
  } else if (platform === "darwin") {
    appData = join(home, "Library", "Application Support");
  } else {
    appData = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  }
  paths.push({
    path: join(
      appData,
      "Code",
      "User",
      "globalStorage",
      "saoudrizwan.claude-dev",
      "settings",
      "cline_mcp_settings.json",
    ),
    source: "cline",
  });

  // InfiniBot custom MCP config. INFINIBOT_STATE_DIR wins (test/profile
  // overrides). Otherwise fall back to ~/.infinibot — the canonical
  // operator state dir on every OS, matching `resolveConfigDir()` in
  // src/utils.ts. Falling back to `<repo>/state` (the old default)
  // only worked when the operator happened to run from the repo with
  // a populated state/ folder; for end-users that path is empty so
  // their MCP servers never get discovered.
  const stateDir = process.env.INFINIBOT_STATE_DIR
    ? resolve(process.env.INFINIBOT_STATE_DIR)
    : join(home, ".infinibot");
  paths.push({ path: join(stateDir, "mcp-servers.json"), source: "infinibot" });

  return paths;
}

// ══════════════════════════════════════════════════════════════════════════════
// Discovery
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Read MCP servers from a config file
 */
function readMCPConfig(path: string): MCPConfigFile | null {
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content);
  } catch (err) {
    log.debug(`Failed to read MCP config from ${path}: ${err}`);
    return null;
  }
}

/**
 * Discover all locally configured MCP servers
 */
export function discoverLocalMCPServers(): LocalMCPServer[] {
  const servers: LocalMCPServer[] = [];
  const seen = new Set<string>();
  const configPaths = getConfigPaths();

  // Pass 1: build a global denylist from `disabled: true` across ALL config
  // sources. This lets a later-source config (e.g. state/mcp-servers.json)
  // suppress a server that is also defined without the flag in an earlier
  // source (e.g. ~/.claude/mcp.json), so the user has a single place to
  // toggle things off without editing every config file.
  const disabledNames = new Set<string>();
  for (const { path } of configPaths) {
    const config = readMCPConfig(path);
    if (!config?.mcpServers) continue;
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      if (serverConfig?.disabled === true) {
        disabledNames.add(name);
        log.debug(`MCP server "${name}" marked disabled in ${path}`);
      }
    }
  }

  // Pass 2: first-source-wins dedup, but skip anything on the denylist.
  for (const { path, source } of configPaths) {
    const config = readMCPConfig(path);
    if (!config?.mcpServers) continue;

    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      // Skip duplicates (prefer earlier sources)
      if (seen.has(name)) continue;
      seen.add(name);

      if (disabledNames.has(name)) {
        log.debug(`Skipping disabled MCP server "${name}" (suppressed by denylist)`);
        continue;
      }

      servers.push({
        id: `${source}:${name}`,
        name,
        source,
        config: serverConfig,
        status: "configured",
        description: getServerDescription(name, serverConfig),
      });
    }
  }

  log.info(`Discovered ${servers.length} local MCP servers`);
  return servers;
}

/**
 * Get a human-readable description for an MCP server
 */
function getServerDescription(name: string, config: MCPServerConfig): string {
  // Try to infer from name or config
  const nameLower = name.toLowerCase();

  if (nameLower.includes("excalidraw")) return "Interactive whiteboard and diagramming";
  if (nameLower.includes("notion")) return "Notion workspace integration";
  if (nameLower.includes("filesystem") || nameLower.includes("fs"))
    return "Local filesystem access";
  if (nameLower.includes("github")) return "GitHub repository integration";
  if (nameLower.includes("postgres") || nameLower.includes("db")) return "Database access";
  if (nameLower.includes("browser")) return "Browser automation";
  if (nameLower.includes("memory")) return "Persistent memory storage";
  if (nameLower.includes("canva")) return "Canva designs, assets, exports, and brand templates";

  // Fall back to command info
  if (config.command) {
    return `Command: ${config.command}`;
  }

  return "MCP Server";
}

/**
 * Get MCP servers for a specific source
 */
export function getLocalMCPServersFromSource(source: LocalMCPServer["source"]): LocalMCPServer[] {
  return discoverLocalMCPServers().filter((s) => s.source === source);
}

/**
 * Check if a specific MCP server is configured locally
 */
export function isLocalMCPConfigured(name: string): boolean {
  const servers = discoverLocalMCPServers();
  return servers.some((s) => s.name === name);
}
