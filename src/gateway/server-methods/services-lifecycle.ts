/**
 * Federation API Service *lifecycle* gateway methods.
 *
 * These are backed by `src/services/manager.ts` (`ServiceManager`) and its
 * `ServiceRegistryStore` — the process-supervisor model that both the
 * Services view (`ui/src/ui/controllers/services.ts`, whose
 * `ServiceDefinition`/`ServiceInstance` types mirror `src/services/types.ts`)
 * and the agent services tool (`src/agents/tools/services-tool.ts`) were
 * written against. The supervisor existed but was never wired to the gateway,
 * so every start/stop/restart/health/unregister button returned
 * `unknown method`.
 *
 * NOTE on the `services.list` / `services.register` / `services.delete` name
 * collision: those three are served by `./services.ts`, which implements a
 * *different* feature (federation Docker/directory service **discovery**,
 * `FederationService`). Resolving that overlap is a product decision, so it
 * is deliberately left alone here — this module only adds the lifecycle
 * methods that had no handler at all.
 */

import { resolveStateDir } from "../../config/paths.js";
import { getServiceManager, getServiceRegistry } from "../../services/index.js";
import type { StartServiceOptions, StopServiceOptions } from "../../services/types.js";
import type { GatewayRequestHandlers } from "./types.js";

function manager() {
  return getServiceManager(resolveStateDir());
}

function registry() {
  return getServiceRegistry(resolveStateDir());
}

function readServiceId(params: Record<string, unknown>): string {
  return ((params.serviceId as string) || (params.id as string) || "").trim();
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const servicesLifecycleHandlers: GatewayRequestHandlers = {
  "services.get": async ({ params, respond }) => {
    const serviceId = readServiceId(params);
    if (!serviceId) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "serviceId required" });
      return;
    }

    const service = registry().getService(serviceId);
    if (!service) {
      respond(false, undefined, { code: "NOT_FOUND", message: `Service not found: ${serviceId}` });
      return;
    }

    respond(true, {
      success: true,
      service,
      instance: manager().getStatus(serviceId) ?? null,
    });
  },

  "services.start": async ({ params, respond }) => {
    const serviceId = readServiceId(params);
    if (!serviceId) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "serviceId required" });
      return;
    }

    const options: StartServiceOptions = {};
    if (params.env && typeof params.env === "object") {
      options.env = params.env as Record<string, string>;
    }
    if (typeof params.waitForHealthy === "boolean") options.waitForHealthy = params.waitForHealthy;
    if (typeof params.timeoutMs === "number") options.timeoutMs = params.timeoutMs;
    if (typeof params.nodeId === "string") options.nodeId = params.nodeId;

    try {
      const mgr = manager();
      await mgr.ready();
      // ServiceManager.start already short-circuits on an already-running
      // instance, so repeated clicks are idempotent.
      const instance = await mgr.start(serviceId, options);
      respond(true, { success: true, instance });
    } catch (e) {
      respond(false, undefined, { code: "SERVICE_START_FAILED", message: errorMessage(e) });
    }
  },

  "services.stop": async ({ params, respond }) => {
    const serviceId = readServiceId(params);
    if (!serviceId) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "serviceId required" });
      return;
    }

    const options: StopServiceOptions = {};
    if (typeof params.force === "boolean") options.force = params.force;
    if (typeof params.timeoutMs === "number") options.timeoutMs = params.timeoutMs;

    try {
      const mgr = manager();
      await mgr.ready();
      // No-ops when there is no live instance — safe to call twice.
      await mgr.stop(serviceId, options);
      respond(true, { success: true, serviceId, instance: mgr.getStatus(serviceId) ?? null });
    } catch (e) {
      respond(false, undefined, { code: "SERVICE_STOP_FAILED", message: errorMessage(e) });
    }
  },

  "services.restart": async ({ params, respond }) => {
    const serviceId = readServiceId(params);
    if (!serviceId) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "serviceId required" });
      return;
    }

    try {
      const mgr = manager();
      await mgr.ready();
      const instance = await mgr.restart(serviceId);
      respond(true, { success: true, instance });
    } catch (e) {
      respond(false, undefined, { code: "SERVICE_RESTART_FAILED", message: errorMessage(e) });
    }
  },

  "services.health": async ({ params, respond }) => {
    const serviceId = readServiceId(params);
    if (!serviceId) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "serviceId required" });
      return;
    }

    try {
      // Returns { healthy:false, error:"Service not found" } for an unknown
      // id rather than throwing — the UI renders that as an unhealthy probe.
      const health = await manager().checkServiceHealth(serviceId);
      respond(true, { success: true, serviceId, ...health });
    } catch (e) {
      respond(false, undefined, { code: "SERVICE_HEALTH_FAILED", message: errorMessage(e) });
    }
  },

  "services.unregister": async ({ params, respond }) => {
    const serviceId = readServiceId(params);
    if (!serviceId) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "serviceId required" });
      return;
    }

    try {
      const mgr = manager();
      await mgr.ready();
      // Stop first so unregistering never orphans a running child process.
      await mgr.stop(serviceId, { force: false });
      const removed = registry().unregisterService(serviceId);
      respond(true, { success: true, serviceId, removed });
    } catch (e) {
      respond(false, undefined, { code: "SERVICE_UNREGISTER_FAILED", message: errorMessage(e) });
    }
  },

  "services.instances": async ({ respond }) => {
    const mgr = manager();
    await mgr.ready();
    const instances = mgr.getAllStatus();
    respond(true, { success: true, instances, count: instances.length });
  },

  "services.capabilities": async ({ params, respond }) => {
    const nodeId = (params.nodeId as string) || process.env.INFINIBOT_NODE_ID || "local";
    respond(true, {
      success: true,
      nodeId,
      capabilities: registry().getCapabilitiesForNode(nodeId),
    });
  },
};

export default servicesLifecycleHandlers;
