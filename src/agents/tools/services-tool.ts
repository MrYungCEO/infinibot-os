/**
 * Services Tool — Agent interface for managing federation API servers
 *
 * Allows agents to start, stop, monitor, and register API services.
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const serviceAction = stringEnum([
  "list",
  "get",
  "start",
  "stop",
  "restart",
  "health",
  "register",
  "unregister",
  "instances",
  "capabilities",
] as const);

const serviceType = stringEnum([
  "python",
  "node",
  "docker",
  "binary",
  "external",
] as const);

const ServicesToolSchema = Type.Object({
  action: serviceAction,
  serviceId: Type.Optional(Type.String({ description: "Service ID" })),
  // Filters for list
  tag: Type.Optional(Type.String({ description: "Filter by tag" })),
  capability: Type.Optional(Type.String({ description: "Filter by capability" })),
  runningOnly: Type.Optional(Type.Boolean({ description: "Only show running services" })),
  // Start options
  waitForHealthy: Type.Optional(Type.Boolean({ description: "Wait for healthy" })),
  timeoutMs: Type.Optional(Type.Number({ description: "Timeout in ms" })),
  // Stop options
  force: Type.Optional(Type.Boolean({ description: "Force kill" })),
  // Register fields
  id: Type.Optional(Type.String({ description: "Service ID (register)" })),
  name: Type.Optional(Type.String({ description: "Service name (register)" })),
  description: Type.Optional(Type.String({ description: "Description (register)" })),
  type: Type.Optional(serviceType),
  workdir: Type.Optional(Type.String({ description: "Working directory" })),
  startCommand: Type.Optional(Type.String({ description: "Start command" })),
  startArgs: Type.Optional(Type.Array(Type.String())),
  port: Type.Optional(Type.Number({ description: "Port number" })),
  host: Type.Optional(Type.String({ description: "Host to bind" })),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  federationEnabled: Type.Optional(Type.Boolean()),
  tags: Type.Optional(Type.Array(Type.String())),
  // Capabilities query
  nodeId: Type.Optional(Type.String({ description: "Node ID" })),
});

export const servicesTool: AnyAgentTool = {
  label: "Services",
  name: "services",
  description: `Manage federation-compatible API servers. Start, stop, monitor health, and register new services.

**Actions:**
- list: List all registered services (filter by tag, capability, or running status)
- get: Get details for a specific service
- start: Start a service
- stop: Stop a service
- restart: Restart a service
- health: Check service health
- register: Register a new service
- unregister: Remove a service
- instances: List all running service instances
- capabilities: Get federation capabilities from running services

**Common Services:**
- image-api: Image generation via ComfyUI (port 8899)
- stt-server: Speech-to-text via Whisper (port 8877)

**Examples:**
- List all: services({ action: "list" })
- Start image API: services({ action: "start", serviceId: "image-api" })
- Check health: services({ action: "health", serviceId: "image-api" })`,

  parameters: ServicesToolSchema,

  execute: async (_toolCallId, args) => {
    const params = args as Record<string, unknown>;
    const action = readStringParam(params, "action", { required: true });

    // Lazy-load gateway call
    const { callGateway } = await import("../../gateway/call.js");

    try {
      let result: unknown;

      switch (action) {
        case "list":
          result = await callGateway({ method: "services.list", params: {
            tag: params.tag,
            capability: params.capability,
            runningOnly: params.runningOnly,
          }});
          break;

        case "get": {
          const serviceId = readStringParam(params, "serviceId", { required: true });
          result = await callGateway({ method: "services.get", params: { serviceId }});
          break;
        }

        case "start": {
          const serviceId = readStringParam(params, "serviceId", { required: true });
          result = await callGateway({ method: "services.start", params: {
            serviceId,
            waitForHealthy: params.waitForHealthy,
            timeoutMs: params.timeoutMs,
            env: params.env,
          }});
          break;
        }

        case "stop": {
          const serviceId = readStringParam(params, "serviceId", { required: true });
          result = await callGateway({ method: "services.stop", params: {
            serviceId,
            force: params.force,
          }});
          break;
        }

        case "restart": {
          const serviceId = readStringParam(params, "serviceId", { required: true });
          result = await callGateway({ method: "services.restart", params: { serviceId }});
          break;
        }

        case "health": {
          const serviceId = readStringParam(params, "serviceId", { required: true });
          result = await callGateway({ method: "services.health", params: { serviceId }});
          break;
        }

        case "register": {
          const id = readStringParam(params, "id", { required: true });
          const name = readStringParam(params, "name", { required: true });
          const type = readStringParam(params, "type", { required: true });
          const workdir = readStringParam(params, "workdir", { required: true });
          const startCommand = readStringParam(params, "startCommand", { required: true });
          if (typeof params.port !== "number") {
            return jsonResult({ status: "error", error: "port required (number)" });
          }
          result = await callGateway({ method: "services.register", params: {
            id,
            name,
            description: params.description,
            type,
            workdir,
            startCommand,
            startArgs: params.startArgs,
            port: params.port,
            host: params.host,
            env: params.env,
            federationEnabled: params.federationEnabled,
            tags: params.tags,
          }});
          break;
        }

        case "unregister": {
          const serviceId = readStringParam(params, "serviceId", { required: true });
          result = await callGateway({ method: "services.unregister", params: { serviceId }});
          break;
        }

        case "instances":
          result = await callGateway({ method: "services.instances", params: {}});
          break;

        case "capabilities":
          result = await callGateway({ method: "services.capabilities", params: { nodeId: params.nodeId }});
          break;

        default:
          return jsonResult({ status: "error", error: `Unknown action: ${action}` });
      }

      return jsonResult({ status: "ok", ...result as object });
    } catch (error) {
      return jsonResult({
        status: "error",
        error: String(error),
      });
    }
  },
};
