/**
 * installMcpForActiveBackend — user-facing MCP install that routes to
 * whichever backend is currently active.
 *
 * The user-visible MCP catalog stays identical; this module translates
 * CC-format entries to the OC format under the hood so callers never
 * need to know which backend is active.
 *
 * COORDINATION: opencode-swap — new file; no existing code modified here.
 */

import { getCoderBackend } from "./registry.js";
import type { McpServerEntry } from "./types.js";

/**
 * Install an MCP server entry into the active backend's config file.
 * CC → writes `mcpServers.name` to ~/.claude.json
 * OC → writes `mcp.name` to ~/.config/opencode/opencode.json (translated format)
 */
export async function installMcpForActiveBackend(
  serverName: string,
  entry: McpServerEntry,
): Promise<void> {
  await getCoderBackend().installMcp(serverName, entry);
}

/**
 * Remove an MCP server entry from the active backend's config file.
 */
export async function uninstallMcpForActiveBackend(serverName: string): Promise<void> {
  await getCoderBackend().uninstallMcp(serverName);
}

/**
 * List MCP server names in the active backend's global config file.
 */
export async function listMcpsForActiveBackend(): Promise<string[]> {
  return getCoderBackend().listInstalledMcps();
}
