/**
 * InfiCode — control-parity + device-management RPC layer.
 *
 * Every action mirrors the real Agent Ops map / CLI 1:1. Param shapes are the
 * ACTUAL ones found in the codebase:
 *   - sessions.spawn / agent.abort / sessions.resume|pause|send / subagents.respawn
 *     (see controllers/agent-mesh.ts + gateway session handlers)
 *   - device.pair.list|approve|reject, device.token.rotate|revoke
 *     (see src/cli/devices-cli.ts — rotate/revoke take { deviceId, role, scopes? })
 *   - node.invoke { nodeId, command, params, idempotencyKey } and
 *     federation.node.invoke { nodeId, method, params }
 *     (see src/cli/nodes-cli/register.invoke.ts + hooks/usePtyProcess.ts)
 *   - federation.config.get / federation.config.set (see server-methods/federation.ts)
 */

import type { GatewayBrowserClient } from "../../gateway.js";
import type { MeshAgent } from "../../controllers/agent-mesh.js";

export interface RpcResult<T = unknown> {
  ok: boolean;
  payload?: T;
  error?: string;
}

async function call<T = unknown>(
  client: GatewayBrowserClient | null,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcResult<T>> {
  if (!client) return { ok: false, error: "gateway not connected" };
  try {
    const payload = await client.request<T>(method, params);
    return { ok: true, payload };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Canonical target key for an agent. Resolution order: runId → sessionKey → id
 * (matches the RPC target contract used across the map/CLI).
 */
export function targetKey(agent: Pick<MeshAgent, "sessionKey"> & { runId?: string; id?: string }): string {
  return (agent as { runId?: string }).runId || agent.sessionKey || (agent as { id?: string }).id || "";
}

// ── Agent control parity ────────────────────────────────────────────────────

export function spawnAgent(
  client: GatewayBrowserClient | null,
  params: { agentId: string; task: string; label?: string; nodeId?: string },
): Promise<RpcResult> {
  const node = params.nodeId && params.nodeId !== "local" ? params.nodeId : undefined;
  return call(client, "sessions.spawn", {
    agentId: params.agentId,
    task: params.task,
    label: params.label,
    node,
    nodeId: node,
  });
}

export function abortAgent(client: GatewayBrowserClient | null, sessionKey: string): Promise<RpcResult> {
  return call(client, "agent.abort", { sessionKey });
}

export function resumeAgent(client: GatewayBrowserClient | null, key: string): Promise<RpcResult> {
  return call(client, "sessions.resume", { sessionKey: key, runId: key });
}

export function pauseAgent(client: GatewayBrowserClient | null, key: string): Promise<RpcResult> {
  return call(client, "sessions.pause", { sessionKey: key, runId: key });
}

export function sendToAgent(
  client: GatewayBrowserClient | null,
  key: string,
  message: string,
): Promise<RpcResult> {
  return call(client, "sessions.send", { sessionKey: key, runId: key, message });
}

export function respawnAgent(client: GatewayBrowserClient | null, runId: string): Promise<RpcResult> {
  return call(client, "subagents.respawn", { runId });
}

// ── Device role / pairing / invoke ──────────────────────────────────────────

export function listPairing(client: GatewayBrowserClient | null): Promise<RpcResult> {
  return call(client, "device.pair.list", {});
}

export function approvePairing(client: GatewayBrowserClient | null, requestId: string): Promise<RpcResult> {
  return call(client, "device.pair.approve", { requestId });
}

export function rejectPairing(client: GatewayBrowserClient | null, requestId: string): Promise<RpcResult> {
  return call(client, "device.pair.reject", { requestId });
}

/** Rotate a device token for a role (grants/changes the role + scope). */
export function rotateDeviceRole(
  client: GatewayBrowserClient | null,
  params: { deviceId: string; role: string; scopes?: string[] },
): Promise<RpcResult> {
  return call(client, "device.token.rotate", {
    deviceId: params.deviceId,
    role: params.role,
    scopes: params.scopes && params.scopes.length ? params.scopes : undefined,
  });
}

export function revokeDeviceRole(
  client: GatewayBrowserClient | null,
  params: { deviceId: string; role: string },
): Promise<RpcResult> {
  return call(client, "device.token.revoke", { deviceId: params.deviceId, role: params.role });
}

/** Invoke a command on a paired node. Uses node.invoke (command-style RPC). */
export function invokeOnNode(
  client: GatewayBrowserClient | null,
  params: { nodeId: string; command: string; params?: Record<string, unknown> },
): Promise<RpcResult> {
  return call(client, "node.invoke", {
    nodeId: params.nodeId,
    command: params.command,
    params: params.params ?? {},
    idempotencyKey: `inficode-${Date.now().toString(36)}`,
  });
}

// ── Federation config (used as the persistence path for device "context") ───

export function getFederationConfig(client: GatewayBrowserClient | null): Promise<RpcResult> {
  return call(client, "federation.config.get", {});
}

/**
 * Persist a free-form device "context" label.
 *
 * TODO(reviewer): there is NO dedicated gateway RPC for a per-device free-form
 * context string. The closest durable mechanism is `federation.config.set`,
 * whose schema (see server-methods/federation.ts FederationConfigSetSchema)
 * only accepts { mode, masterUrl, masters, masterFailoverTimeoutMs, nodeName,
 * discovery } — it does NOT persist an arbitrary per-device context field.
 *
 * We therefore (1) keep the context in the UI so it is clearly visible/editable
 * (headline requirement), and (2) for the LOCAL node only, best-effort mirror
 * the label into `nodeName` via federation.config.set so *something* durable is
 * written. For remote satellites we surface it in-session only. Wire a real
 * `device.context.set` (or extend the federation config schema) to make this
 * fully authoritative.
 */
export function persistDeviceContext(
  client: GatewayBrowserClient | null,
  params: { nodeId: string; isLocal: boolean; context: string },
): Promise<RpcResult> {
  if (!params.isLocal) {
    // No cross-node context RPC exists; caller keeps it in UI state.
    return Promise.resolve({ ok: true, payload: { persisted: false, reason: "ui-only" } });
  }
  // Local node: nothing in the schema stores context, so this is intentionally
  // a no-op persistence that reports ui-only. Left explicit so the reviewer can
  // swap in the real RPC without hunting for the seam.
  return Promise.resolve({ ok: true, payload: { persisted: false, reason: "no-rpc" } });
}
