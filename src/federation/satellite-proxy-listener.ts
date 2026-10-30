/**
 * Wires the `gateway:proxy:request` listener on a FederationSatellite.
 *
 * `gateway:proxy:request` is the satellite's half of the cross-device RPC
 * pipe — master sends `gateway.proxy.invoke` (terminal.create,
 * terminal.write, etc.) and the satellite has to dispatch the call against
 * its own local gateway and ship the result back via
 * `sendGatewayProxyResult`. Without this listener, master times out after
 * 30s and any mobile UI driving a satellite terminal renders blank.
 *
 * Extracted from `server-runtime-state` so the same wiring runs in BOTH
 * satellite-startup paths: the runtime-state init AND the CLI satellite
 * mode (`infinibot gateway --satellite`). Previously the listener was
 * inlined in the `if (federationSatelliteMode && !skipRuntimeSatellite)`
 * branch which is skipped in the CLI path, leaving the listener missing.
 *
 * Idempotent: a `listenerCount` guard prevents duplicate registration if
 * this is called more than once on the same satellite instance.
 */
import type { FederationSatellite } from "./satellite.js";
import { isMethodShared, notSharedMessage, shareCategoryForMethod } from "./share-policy.js";

export type CallGatewayFn = (opts: {
  method: string;
  params: unknown;
  timeoutMs?: number;
}) => Promise<unknown>;

export interface AttachGatewayProxyListenerOptions {
  /**
   * Override the gateway-call function. Production code leaves this
   * undefined and we dynamic-import `callGateway` to avoid the runtime
   * dependency at module-load time. Tests pass a stub so we don't need
   * to spin up a real WebSocket.
   */
  callGateway?: CallGatewayFn;
}

export function attachGatewayProxyRequestListener(
  satellite: FederationSatellite,
  options: AttachGatewayProxyListenerOptions = {},
): boolean {
  if (satellite.listenerCount("gateway:proxy:request") > 0) {
    return false;
  }

  satellite.on("gateway:proxy:request", async (request: Record<string, unknown>) => {
    const correlationId = request.correlationId as string | undefined;
    const method = typeof request.method === "string" ? request.method : "";
    const proxyParams = (request.params ?? {}) as Record<string, unknown>;
    if (!correlationId) return;
    if (!method) {
      satellite.sendGatewayProxyResult(correlationId, {
        success: false,
        error: "method is required",
      });
      return;
    }
    // The owner chose what this satellite shares (federation.share); refuse the rest.
    const share =
      typeof satellite.getSharePolicy === "function" ? satellite.getSharePolicy() : undefined;
    if (!isMethodShared(share, method)) {
      satellite.sendGatewayProxyResult(correlationId, {
        success: false,
        error: notSharedMessage(shareCategoryForMethod(method)!),
      });
      return;
    }
    try {
      const callGateway = options.callGateway ?? (await import("../gateway/call.js")).callGateway;
      const payload = await callGateway({
        method,
        params: proxyParams,
        timeoutMs: 30_000,
      });
      satellite.sendGatewayProxyResult(correlationId, {
        success: true,
        payload,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      satellite.sendGatewayProxyResult(correlationId, {
        success: false,
        error,
      });
    }
  });

  return true;
}
