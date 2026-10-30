/**
 * Legacy RPC names a plugin now serves under its own namespace.
 *
 * Manifest-v2 plugins may only register `<pluginId>.*` methods. When a core
 * surface moved into a plugin, callers of its old names (mobile app, agent
 * scripts, bookmarks in ui_control) keep working through this table: the
 * old name forwards to the plugin's method while the plugin is loaded, and
 * answers "turned off — enable it in Setup › Plugins" when it isn't.
 * Scope checks still apply to the old name (READ/WRITE_METHODS keep them).
 */

import type { GatewayRequestHandler, GatewayRequestHandlers } from "./server-methods/types.js";

type PluginAlias = { target: string; pluginName: string };

const FOCUS_METHODS = [
  "list",
  "status",
  "get",
  "contains",
  "add.task",
  "add.project",
  "remove",
  "reorder",
  "moveUp",
  "moveDown",
  "clear",
  "sync",
  "set",
] as const;

export const PLUGIN_METHOD_ALIASES: Readonly<Record<string, PluginAlias>> = Object.fromEntries(
  // Focus board: core focus.* → Discipline plugin discipline.focus.*
  FOCUS_METHODS.map((m) => [
    `focus.${m}`,
    { target: `discipline.focus.${m}`, pluginName: "Discipline" },
  ]),
);

export type ResolvedPluginAlias =
  | { target: string; handler: GatewayRequestHandler; off?: undefined }
  | { target: string; handler?: undefined; off: string };

/** Null when `method` isn't an alias. */
export function resolvePluginMethodAlias(
  method: string,
  pluginHandlers: GatewayRequestHandlers | undefined,
): ResolvedPluginAlias | null {
  const alias = PLUGIN_METHOD_ALIASES[method];
  if (!alias) return null;
  const handler = pluginHandlers?.[alias.target];
  if (handler) return { target: alias.target, handler };
  return {
    target: alias.target,
    off: `${method} is provided by the ${alias.pluginName} plugin, which is turned off — enable it in Setup › Plugins.`,
  };
}
