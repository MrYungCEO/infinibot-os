/**
 * Real Agent Management Controller
 * Connects to actual InfiniBot Gateway API to manage agents
 * Replaces mock data with real config + state
 */

import type { GatewayBrowserClient } from "../gateway";
import { gatewayHttpUrl } from "../gateway-endpoint";

// ============================================================
// Types
// ============================================================

export interface AgentIdentityConfig {
  avatar?: string;
  description?: string;
}

export interface InfiniBotAgent {
  id: string;
  name?: string;
  workspace: string;
  agentDir?: string;
  model?: string;
  default?: boolean;
  disabled?: boolean;
  identity?: AgentIdentityConfig;
}

export interface AgentListEntry {
  id: string;
  name: string;
  workspace: string;
  model: string;
  isDefault: boolean;
  isDisabled: boolean;
  status: "active" | "inactive" | "error";
  sessionCount: number;
  /**
   * Resolved avatar URL for the gallery card thumbnail. Empty string when
   * the agent has no custom avatar set — the card UI then renders a
   * deterministic gradient tile derived from the agent id.
   */
  avatarUrl: string;
}

export interface AgentBinding {
  agentId: string;
  match: {
    channel?: string;
    accountId?: string;
    peer?: {
      kind: "dm" | "group" | "channel";
      id: string;
    };
  };
}

export interface InfinibotConfig {
  agents?: {
    list?: InfiniBotAgent[];
    defaults?: {
      workspace?: string;
      model?: string;
    };
  };
  bindings?: AgentBinding[];
}

export interface AgentsRealState {
  agents: AgentListEntry[];
  bindings: AgentBinding[];
  loading: boolean;
  error: string | null;
  selectedAgentId: string | null;
  editingAgent: Partial<InfiniBotAgent> | null;
  showCreateDialog: boolean;
}

// ============================================================
// State Management
// ============================================================

let currentState: AgentsRealState = {
  agents: [],
  bindings: [],
  loading: false,
  error: null,
  selectedAgentId: null,
  editingAgent: null,
  showCreateDialog: false,
};

export function getAgentsRealState(): AgentsRealState {
  return currentState;
}

export function setAgentsRealState(partial: Partial<AgentsRealState>) {
  currentState = { ...currentState, ...partial };
}

// ============================================================
// Config access
// ============================================================

/**
 * Shape returned by `config.get` — the raw config-file snapshot. (The old
 * `gateway:config.get` / `gateway:config.patch` names this controller used
 * were never served, so every agent create/update/delete hard-errored.)
 */
type ConfigSnapshot = { config: InfinibotConfig; hash?: string };

/**
 * Write `agents` back through `config.patch`. That RPC takes a raw JSON5
 * merge-patch string plus the current snapshot hash for optimistic
 * concurrency, so the hash is re-read on every call to avoid stale-hash
 * rejections. Throws on failure — the client rejects on a gateway error.
 */
async function patchAgentsConfig(
  client: GatewayBrowserClient,
  agents: unknown,
): Promise<void> {
  const snapshot = await client.request<ConfigSnapshot>("config.get", {});
  const baseHash = snapshot?.hash;
  if (!baseHash) throw new Error("could not read config snapshot hash");
  await client.request("config.patch", {
    raw: JSON.stringify({ agents }),
    baseHash,
  });
}

// ============================================================
// API Calls
// ============================================================

export async function loadAgentsReal(
  client: GatewayBrowserClient
): Promise<void> {
  setAgentsRealState({ loading: true, error: null });

  try {
    // Get config with agents list
    const configRes = await client.request<ConfigSnapshot>("config.get", {});
    const config = configRes?.config as InfinibotConfig;
    const agentsList = config?.agents?.list || [];
    const bindings = config?.bindings || [];

    // Get status for each agent (via sessions or health)
    const agents: AgentListEntry[] = agentsList.map((a) => ({
      id: a.id,
      name: a.name || a.id,
      workspace: a.workspace,
      model: a.model || "default",
      isDefault: a.default ?? false,
      isDisabled: a.disabled ?? false,
      status: "active" as const, // TODO: check actual status
      sessionCount: 0, // TODO: fetch from sessions
      avatarUrl: resolveAvatarUrlForCard(a),
    }));

    setAgentsRealState({
      agents,
      bindings,
      loading: false,
    });
  } catch (err) {
    setAgentsRealState({
      loading: false,
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
}

export async function createAgent(
  client: GatewayBrowserClient,
  agent: Partial<InfiniBotAgent>
): Promise<boolean> {
  try {
    const configRes = await client.request<ConfigSnapshot>("config.get", {});
    const config = configRes?.config as InfinibotConfig;
    const agentsList = [...(config?.agents?.list || [])];

    // Check if agent already exists
    if (agentsList.some((a) => a.id === agent.id)) {
      setAgentsRealState({ error: `Agent "${agent.id}" already exists` });
      return false;
    }

    // Add new agent
    agentsList.push({
      id: agent.id!,
      name: agent.name || agent.id,
      workspace: agent.workspace!,
      agentDir: agent.agentDir,
      model: agent.model,
      default: agent.default,
    });

    // Patch config
    await patchAgentsConfig(client, { ...config.agents, list: agentsList });

    // Reload agents
    await loadAgentsReal(client);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    setAgentsRealState({ error: msg });
    return false;
  }
}

export async function updateAgent(
  client: GatewayBrowserClient,
  agentId: string,
  updates: Partial<InfiniBotAgent>
): Promise<boolean> {
  try {
    const configRes = await client.request<ConfigSnapshot>("config.get", {});
    const config = configRes?.config as InfinibotConfig;
    const agentsList = [...(config?.agents?.list || [])];

    // Find and update agent
    const idx = agentsList.findIndex((a) => a.id === agentId);
    if (idx === -1) {
      throw new Error(`Agent "${agentId}" not found`);
    }

    agentsList[idx] = { ...agentsList[idx], ...updates };

    // Patch config
    await patchAgentsConfig(client, { ...config.agents, list: agentsList });

    await loadAgentsReal(client);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    setAgentsRealState({ error: msg });
    return false;
  }
}

export async function deleteAgent(
  client: GatewayBrowserClient,
  agentId: string
): Promise<boolean> {
  try {
    const configRes = await client.request<ConfigSnapshot>("config.get", {});
    const config = configRes?.config as InfinibotConfig;
    const agentsList = (config?.agents?.list || []).filter(
      (a) => a.id !== agentId
    );

    // Patch config
    await patchAgentsConfig(client, { ...config.agents, list: agentsList });

    await loadAgentsReal(client);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    setAgentsRealState({ error: msg });
    return false;
  }
}

export async function setDefaultAgent(
  client: GatewayBrowserClient,
  agentId: string
): Promise<boolean> {
  try {
    const configRes = await client.request<ConfigSnapshot>("config.get", {});
    const config = configRes?.config as InfinibotConfig;
    const agentsList = [...(config?.agents?.list || [])];

    // Set all to non-default, then set target
    agentsList.forEach((a) => (a.default = false));
    const idx = agentsList.findIndex((a) => a.id === agentId);
    if (idx >= 0) {
      agentsList[idx].default = true;
    }

    await patchAgentsConfig(client, { ...config.agents, list: agentsList });

    await loadAgentsReal(client);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    setAgentsRealState({ error: msg });
    return false;
  }
}

export async function testAgentConnection(
  client: GatewayBrowserClient,
  agentId: string
): Promise<boolean> {
  try {
    // Spawn a throwaway sub-agent run against this profile. (`agent:test-run`
    // was never a served method — the colon-namespaced scheme predates the
    // current surface.) `sessions.spawn` answers `{ status: "accepted" }` once
    // the run is queued, which is exactly the reachability signal we want.
    const res = await client.request<{ status?: string }>("sessions.spawn", {
      task: "ping",
      agentId,
      label: `Connection test: ${agentId}`,
      cleanup: "delete",
    });

    return res?.status === "accepted";
  } catch {
    return false;
  }
}

// ============================================================
// Avatar helpers
// ============================================================

/** Hard cap on uploaded avatars — config is loaded into memory on every
 *  call, so embedding multi-MB data URIs would balloon the config file
 *  and slow every gateway:config.get. ~512KB compressed fits comfortably. */
const MAX_AVATAR_BYTES = 512 * 1024;

/**
 * Decide what `avatarUrl` to hand the card. Priority:
 *  1. data: URIs render inline (uploaded avatars are stored as data URIs).
 *  2. http(s) URLs render directly.
 *  3. Any other non-empty value (local file path) is served through the
 *     gateway's /avatar/<id> route which resolves it against the agent's
 *     workspace dir.
 *  4. No avatar set → empty string → the card renders the default tile.
 */
function resolveAvatarUrlForCard(a: InfiniBotAgent): string {
  const raw = a.identity?.avatar?.trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (lower.startsWith("data:") || lower.startsWith("http://") || lower.startsWith("https://")) {
    return raw;
  }
  // The gateway's avatar route resolves workspace-relative paths. Cache-bust
  // with a timestamp so re-uploads update the rendered image immediately.
  return gatewayHttpUrl(`/avatar/${encodeURIComponent(a.id)}?t=${Date.now()}`);
}

/**
 * Read a File from a <input type=file> as a data URI and patch the agent's
 * identity.avatar. Returns true on success, false otherwise (with the error
 * surfaced through agents-real state).
 */
export async function uploadAgentAvatar(
  client: GatewayBrowserClient,
  agentId: string,
  file: File,
): Promise<boolean> {
  if (!file.type.startsWith("image/")) {
    setAgentsRealState({ error: "Avatar must be an image file" });
    return false;
  }
  if (file.size > MAX_AVATAR_BYTES) {
    setAgentsRealState({
      error: `Image too large (${Math.round(file.size / 1024)} KB) — keep avatars under ${Math.round(MAX_AVATAR_BYTES / 1024)} KB`,
    });
    return false;
  }

  const dataUri = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.onload = () => {
      const out = reader.result;
      if (typeof out !== "string") {
        reject(new Error("Unexpected FileReader payload"));
        return;
      }
      resolve(out);
    };
    reader.readAsDataURL(file);
  }).catch((err: Error) => {
    setAgentsRealState({ error: err.message });
    return "";
  });
  if (!dataUri) return false;

  const ok = await updateAgentIdentity(client, agentId, { avatar: dataUri });
  if (!ok) return false;
  // Force a fresh load so the new data URI lands on the card.
  await loadAgentsReal(client);
  return true;
}

/** Clear the avatar back to the gradient default. */
export async function clearAgentAvatar(
  client: GatewayBrowserClient,
  agentId: string,
): Promise<boolean> {
  const ok = await updateAgentIdentity(client, agentId, { avatar: "" });
  if (ok) await loadAgentsReal(client);
  return ok;
}

/**
 * Patch identity.* on a single agent without overwriting other identity
 * fields. Merges into the existing identity object, then writes the whole
 * agents.list back via config.patch (same path the rest of this controller
 * uses — we don't have a per-agent patch RPC).
 */
async function updateAgentIdentity(
  client: GatewayBrowserClient,
  agentId: string,
  patch: Partial<AgentIdentityConfig>,
): Promise<boolean> {
  try {
    const configRes = await client.request<ConfigSnapshot>("config.get", {});
    const config = configRes?.config as InfinibotConfig;
    const agentsList = [...(config?.agents?.list || [])];
    const idx = agentsList.findIndex((a) => a.id === agentId);
    if (idx === -1) throw new Error(`Agent "${agentId}" not found`);

    const existing = agentsList[idx].identity ?? {};
    const nextIdentity: AgentIdentityConfig = { ...existing };
    if (patch.avatar !== undefined) {
      if (patch.avatar) nextIdentity.avatar = patch.avatar;
      else delete nextIdentity.avatar;
    }
    if (patch.description !== undefined) {
      if (patch.description) nextIdentity.description = patch.description;
      else delete nextIdentity.description;
    }

    agentsList[idx] = {
      ...agentsList[idx],
      identity: Object.keys(nextIdentity).length > 0 ? nextIdentity : undefined,
    };

    await patchAgentsConfig(client, { ...config.agents, list: agentsList });
    return true;
  } catch (err) {
    setAgentsRealState({ error: err instanceof Error ? err.message : "Unknown error" });
    return false;
  }
}

/**
 * Deterministic gradient + initial for the default card thumbnail. Hashing
 * the agent id keeps each agent's tile stable across reloads so operators
 * recognise them by colour alone.
 */
export function defaultAvatarStyle(agentId: string): { gradient: string; initial: string } {
  const id = agentId || "?";
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  const h1 = Math.abs(hash) % 360;
  const h2 = (h1 + 48) % 360;
  const gradient = `linear-gradient(135deg, hsl(${h1} 70% 38%) 0%, hsl(${h2} 65% 24%) 100%)`;
  const initial = id.charAt(0).toUpperCase();
  return { gradient, initial };
}
