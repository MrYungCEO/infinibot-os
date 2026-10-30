import type { GatewayRequestHandler } from "infinibot/plugin-sdk";
import { STUDIO_TOOLS, type StudioClient } from "./client.js";

const fail = (respond: Parameters<GatewayRequestHandler>[0]["respond"], error: unknown, code = "UNAVAILABLE") =>
  respond(false, undefined, { code, message: error instanceof Error ? error.message : String(error) });

export function createStudioHandlers(client: StudioClient): Record<string, GatewayRequestHandler> {
  return {
    "monsoon-studio.status": async ({ respond }) => {
      respond(true, { ...(await client.health()), declaredTools: STUDIO_TOOLS.length });
    },
    "monsoon-studio.tools.list": async ({ respond }) => {
      respond(true, { tools: STUDIO_TOOLS.map(({ name, description }) => ({ name, description })) });
    },
    "monsoon-studio.tools.call": async ({ params, respond }) => {
      const p = (params ?? {}) as { name?: unknown; input?: unknown };
      if (typeof p.name !== "string") return fail(respond, "name required", "INVALID_PARAMS");
      try {
        respond(true, { result: await client.call(p.name, (p.input ?? {}) as Record<string, unknown>) });
      } catch (error) {
        fail(respond, error);
      }
    },
  };
}
