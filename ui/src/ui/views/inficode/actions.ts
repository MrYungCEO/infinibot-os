/**
 * InfiCode — action handlers (device role/context/pairing/invoke + agent
 * control parity + spawn). Split out of index.ts to keep every file < 500 LOC.
 * Each function takes the host element and drives the RPCs in rpc.ts, then
 * surfaces a toast. The host exposes gwClient()/showToast()/selectedAgent()
 * plus the device draft getters these read.
 */

import type { InfiCodeView } from "./index.js";
import type { MeshNode } from "../../controllers/agent-mesh.js";
import * as rpc from "./rpc.js";

// ── Device role / context / pairing / invoke ────────────────────────────────

export async function applyDeviceRole(host: InfiCodeView, node: MeshNode): Promise<void> {
  const role = (host.roleDraftFor(node.id) || "").trim();
  if (!role) return host.showToast("role required", true);
  const scopes = host.scopeDraftFor(node.id).split(/\s+/).filter(Boolean);
  const res = await rpc.rotateDeviceRole(host.gwClient(), { deviceId: node.id, role, scopes });
  host.showToast(res.ok ? `role '${role}' rotated on ${node.name}` : res.error || "rotate failed", !res.ok);
  void host.refreshPairing();
}

export async function revokeDeviceRole(host: InfiCodeView, node: MeshNode): Promise<void> {
  const role = (host.roleDraftFor(node.id) || "").trim();
  if (!role) return host.showToast("role required to revoke", true);
  const res = await rpc.revokeDeviceRole(host.gwClient(), { deviceId: node.id, role });
  host.showToast(res.ok ? `role '${role}' revoked on ${node.name}` : res.error || "revoke failed", !res.ok);
}

export async function saveDeviceContext(host: InfiCodeView, node: MeshNode): Promise<void> {
  const context = host.contextFor(node.id).trim();
  const res = await rpc.persistDeviceContext(host.gwClient(), {
    nodeId: node.id,
    isLocal: node.role === "hub" || node.role === "local" || node.id === "local",
    context,
  });
  const uiOnly = (res.payload as { persisted?: boolean } | undefined)?.persisted === false;
  host.showToast(
    res.ok ? `context saved for ${node.name}${uiOnly ? " (UI-only — see TODO)" : ""}` : res.error || "save failed",
    !res.ok,
  );
}

export async function invokeOnDevice(host: InfiCodeView, node: MeshNode): Promise<void> {
  const res = await rpc.invokeOnNode(host.gwClient(), { nodeId: node.id, command: "node.ping", params: {} });
  host.showToast(res.ok ? `invoked node.ping on ${node.name}` : res.error || "invoke failed", !res.ok);
}

export async function approvePair(host: InfiCodeView, requestId: string): Promise<void> {
  const res = await rpc.approvePairing(host.gwClient(), requestId);
  host.showToast(res.ok ? "device approved" : res.error || "approve failed", !res.ok);
  void host.refreshPairing();
}

export async function rejectPair(host: InfiCodeView, requestId: string): Promise<void> {
  const res = await rpc.rejectPairing(host.gwClient(), requestId);
  host.showToast(res.ok ? "device rejected" : res.error || "reject failed", !res.ok);
  void host.refreshPairing();
}

// ── Agent control parity + spawn ────────────────────────────────────────────

export async function spawnSelected(host: InfiCodeView): Promise<void> {
  const task = host.spawnTask.trim() || `InfiCode ${host.spawnAgentId} task`;
  const res = await rpc.spawnAgent(host.gwClient(), {
    agentId: host.spawnAgentId,
    task,
    label: `InfiCode ${host.spawnAgentId}`,
    nodeId: host.selectedNodeId ?? undefined,
  });
  host.showToast(
    res.ok ? `spawned ${host.spawnAgentId} → ${host.selectedDeviceLabel()}` : res.error || "spawn failed",
    !res.ok,
  );
  if (res.ok) host.spawnTask = "";
}

export async function spawnCoder(host: InfiCodeView): Promise<void> {
  const task = host.coderTask.trim() || "InfiCode embedded coder task";
  const res = await rpc.spawnAgent(host.gwClient(), {
    agentId: "coder",
    task,
    label: "InfiCode coder",
    nodeId: host.selectedNodeId ?? undefined,
  });
  host.showToast(res.ok ? `coder spawned → ${host.selectedDeviceLabel()}` : res.error || "spawn failed", !res.ok);
  if (res.ok) host.coderTask = "";
}

export async function agentAction(
  host: InfiCodeView,
  kind: "abort" | "resume" | "pause" | "respawn",
): Promise<void> {
  const a = host.selectedAgent();
  if (!a) return;
  const key = rpc.targetKey(a);
  let res: rpc.RpcResult;
  if (kind === "abort") res = await rpc.abortAgent(host.gwClient(), a.sessionKey);
  else if (kind === "resume") res = await rpc.resumeAgent(host.gwClient(), key);
  else if (kind === "pause") res = await rpc.pauseAgent(host.gwClient(), key);
  else res = await rpc.respawnAgent(host.gwClient(), key);
  host.showToast(res.ok ? `${kind} → ${a.agentId}` : res.error || `${kind} failed`, !res.ok);
}

export async function sendToSelected(host: InfiCodeView, input: HTMLInputElement): Promise<void> {
  const a = host.selectedAgent();
  if (!a || !input.value.trim()) return;
  const res = await rpc.sendToAgent(host.gwClient(), rpc.targetKey(a), input.value.trim());
  host.showToast(res.ok ? `sent → ${a.agentId}` : res.error || "send failed", !res.ok);
  if (res.ok) input.value = "";
}
