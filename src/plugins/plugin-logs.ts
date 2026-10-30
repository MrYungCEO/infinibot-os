/**
 * Per-plugin log ring buffer for Setup › Plugins › Health & Logs.
 *
 * The registry wraps each plugin's `api.logger` so every line a plugin logs
 * (plus host events about it: load errors, service failures, toggles) lands
 * here as well as in the normal subsystem log. In memory only; capped.
 */

import type { PluginLogger } from "./types.js";

export type PluginLogLevel = "debug" | "info" | "warn" | "error";
export type PluginLogLine = {
  ts: number;
  level: PluginLogLevel;
  message: string;
  source?: "plugin" | "host";
};

const MAX_LINES = 300;
const KEY = Symbol.for("infinibot.pluginLogs");

function buffers(): Map<string, PluginLogLine[]> {
  const g = globalThis as typeof globalThis & { [KEY]?: Map<string, PluginLogLine[]> };
  if (!g[KEY]) g[KEY] = new Map();
  return g[KEY];
}

export function appendPluginLog(
  pluginId: string,
  level: PluginLogLevel,
  message: string,
  source: "plugin" | "host" = "host",
): void {
  const map = buffers();
  let buf = map.get(pluginId);
  if (!buf) {
    buf = [];
    map.set(pluginId, buf);
  }
  buf.push({ ts: Date.now(), level, message: String(message).slice(0, 2000), source });
  if (buf.length > MAX_LINES) buf.splice(0, buf.length - MAX_LINES);
}

export function readPluginLogs(
  pluginId: string,
  opts: { limit?: number; level?: PluginLogLevel } = {},
): PluginLogLine[] {
  const order: PluginLogLevel[] = ["debug", "info", "warn", "error"];
  const min = opts.level ? order.indexOf(opts.level) : 0;
  const lines = (buffers().get(pluginId) ?? []).filter((l) => order.indexOf(l.level) >= min);
  const limit = Math.max(1, Math.min(MAX_LINES, opts.limit ?? 100));
  return lines.slice(-limit);
}

export function lastPluginErrors(pluginId: string, limit = 5): PluginLogLine[] {
  return (buffers().get(pluginId) ?? []).filter((l) => l.level === "error").slice(-limit);
}

export function clearPluginLogs(pluginId?: string): void {
  if (pluginId) buffers().delete(pluginId);
  else buffers().clear();
}

/** Wrap a logger so a plugin's own lines are also captured per plugin. */
export function withPluginLogCapture(pluginId: string, logger: PluginLogger): PluginLogger {
  const tap = (level: PluginLogLevel, fn?: (msg: string) => void) => (msg: string) => {
    appendPluginLog(pluginId, level, msg, "plugin");
    fn?.(msg);
  };
  return {
    info: tap("info", logger.info),
    warn: tap("warn", logger.warn),
    error: tap("error", logger.error),
    debug: tap("debug", logger.debug),
  };
}
