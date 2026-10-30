import type { IncomingMessage, ServerResponse } from "node:http";

import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { isPluginHttpRouteActive } from "../../plugins/host-state.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export type PluginHttpRequestHandler = {
  (req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  isPublicAsset(pathname: string, method?: string): boolean;
  /** True for a plugin route declared in contributes.selfAuthHttp (served before the auth gate). */
  isSelfAuthRoute?: (pathname: string) => boolean;
};

export function createGatewayPluginRequestHandler(params: {
  registry: PluginRegistry;
  log: SubsystemLogger;
}): PluginHttpRequestHandler {
  const { registry, log } = params;
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const routes = registry.httpRoutes ?? [];
    const handlers = registry.httpHandlers ?? [];
    if (routes.length === 0 && handlers.length === 0) return false;

    if (routes.length > 0) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = routes.find((entry) => entry.path === url.pathname);
      if (route && !isPluginHttpRouteActive(route.pluginId, route.path)) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("This plugin route is turned off.");
        return true;
      }
      if (route) {
        try {
          await route.handler(req, res);
          return true;
        } catch (err) {
          log.warn(`plugin http route failed (${route.pluginId ?? "unknown"}): ${String(err)}`);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end("Internal Server Error");
          }
          return true;
        }
      }
    }

    for (const entry of handlers) {
      try {
        const handled = await entry.handler(req, res);
        if (handled) return true;
      } catch (err) {
        log.warn(`plugin http handler failed (${entry.pluginId}): ${String(err)}`);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Internal Server Error");
        }
        return true;
      }
    }
    return false;
  };
  handler.isPublicAsset = (pathname: string, method = "GET") => {
    const verb = method.toUpperCase();
    if (verb !== "GET" && verb !== "HEAD") return false;
    return (registry.httpRoutes ?? []).some(
      (entry) => entry.path === pathname && entry.publicAsset === true,
    );
  };
  handler.isSelfAuthRoute = (pathname: string) =>
    (registry.httpRoutes ?? []).some((r) => r.selfAuth === true && r.path === pathname);
  return handler;
}
