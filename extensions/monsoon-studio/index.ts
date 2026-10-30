/**
 * Product Studio first-party plugin (manifest v2).
 *
 * The Monsoon Digital Product Studio runs as its own local server (systemd
 * user unit `monsoon-studio`, default http://127.0.0.1:4311). This plugin adds
 * the editor page (embedded studio UI), status/tool RPCs, and the 26 studio_*
 * agent tools, each proxied to POST /api/tools/<name> so agents and the editor
 * share one project graph.
 */
import type { InfiniBotPluginApi } from "infinibot/plugin-sdk";
import { createAgentTools } from "./src/agent-tools.js";
import { StudioClient } from "./src/client.js";
import { readStudioConfig } from "./src/config.js";
import { createStudioHandlers } from "./src/rpc.js";

export default function register(api: InfiniBotPluginApi): void {
  const client = new StudioClient(() => readStudioConfig(api.pluginConfig));
  for (const [method, handler] of Object.entries(createStudioHandlers(client))) api.registerGatewayMethod(method, handler);
  for (const tool of createAgentTools(client)) api.registerTool(tool, { optional: false });
  void client.health().then((health) => {
    if (!health.ok) api.logger.warn(`monsoon-studio: studio server not reachable at ${health.url} (${health.error ?? "unknown"})`);
  });
}
