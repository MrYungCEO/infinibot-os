/**
 * Comms Hub — client preferred-channel + per-channel handles.
 *
 * IMPORTANT: this module does NOT edit the clients schema or the off-limits
 * clients server-methods/UI files. It stores the extra fields in the client
 * `data` JSON blob under a reserved `comms` key, which `clients.update` already
 * round-trips. The top-level Client columns (email/whatsapp/telegram/discord/
 * instagram) are read as fallback handles so the two representations agree.
 */

import { getAgencyOperationsStore } from "../agency-operations/store.js";
import { resolveStateDir } from "../config/paths.js";
import {
  type ClientCommsPrefs,
  type CommsChannel,
  emptyClientCommsPrefs,
  isCommsChannel,
} from "./types.js";

function store() {
  return getAgencyOperationsStore(resolveStateDir());
}

/** Column name on the Client record that holds the native handle for a channel. */
const CHANNEL_COLUMN: Record<
  CommsChannel,
  "email" | "whatsapp" | "telegram" | "discord" | "instagram"
> = {
  email: "email",
  whatsapp: "whatsapp",
  telegram: "telegram",
  discord: "discord",
  instagram: "instagram",
};

function parsePrefs(raw: unknown): ClientCommsPrefs {
  const prefs = emptyClientCommsPrefs();
  if (!raw || typeof raw !== "object") return prefs;
  const r = raw as Record<string, unknown>;
  if (isCommsChannel(r.preferredChannel)) prefs.preferredChannel = r.preferredChannel;
  if (r.assignedAgentId != null && typeof r.assignedAgentId === "string") {
    prefs.assignedAgentId = r.assignedAgentId;
  }
  if (r.handles && typeof r.handles === "object") {
    for (const [k, v] of Object.entries(r.handles as Record<string, unknown>)) {
      if (isCommsChannel(k) && typeof v === "string" && v.trim()) prefs.handles[k] = v.trim();
    }
  }
  if (Array.isArray(r.optOut)) {
    prefs.optOut = r.optOut.filter(isCommsChannel);
  }
  return prefs;
}

/**
 * Read a client's comms prefs, merging the `data.comms` blob with the
 * top-level Client columns (columns fill in any missing handle).
 */
export function getClientCommsPrefs(clientId: string, agencyId: string): ClientCommsPrefs | null {
  const client = store().getClient(clientId, agencyId);
  if (!client) return null;
  const data = (client.data ?? {}) as Record<string, unknown>;
  const prefs = parsePrefs(data.comms);
  // Fill missing handles from the fixed columns.
  for (const channel of Object.keys(CHANNEL_COLUMN) as CommsChannel[]) {
    if (prefs.handles[channel]) continue;
    const columnValue = (client as unknown as Record<string, unknown>)[CHANNEL_COLUMN[channel]];
    if (typeof columnValue === "string" && columnValue.trim()) {
      prefs.handles[channel] = columnValue.trim();
    }
  }
  return prefs;
}

/**
 * Persist comms prefs into the client `data.comms` blob via `updateClient`,
 * preserving all other `data` keys. Does not touch the fixed columns.
 */
export function setClientCommsPrefs(
  clientId: string,
  agencyId: string,
  patch: Partial<ClientCommsPrefs>,
): ClientCommsPrefs | null {
  const s = store();
  const client = s.getClient(clientId, agencyId);
  if (!client) return null;
  const data = { ...((client.data ?? {}) as Record<string, unknown>) };
  const current = parsePrefs(data.comms);
  const next: ClientCommsPrefs = {
    preferredChannel:
      patch.preferredChannel !== undefined ? patch.preferredChannel : current.preferredChannel,
    assignedAgentId:
      patch.assignedAgentId !== undefined ? patch.assignedAgentId : current.assignedAgentId,
    handles: { ...current.handles, ...patch.handles },
    optOut: patch.optOut ?? current.optOut,
  };
  data.comms = next;
  s.updateClient(clientId, { data }, { agencyId });
  return getClientCommsPrefs(clientId, agencyId);
}

/**
 * Resolve the handle to use for a client on a given channel:
 *   explicit override → fixed column → null.
 */
export function resolveClientHandle(
  clientId: string,
  agencyId: string,
  channel: CommsChannel,
): string | null {
  const prefs = getClientCommsPrefs(clientId, agencyId);
  return prefs?.handles[channel] ?? null;
}

/**
 * Best-effort reverse lookup: find a clientId whose handle on `channel` matches
 * `peerHandle`. Used to attribute inbound messages to a client.
 */
export function findClientByHandle(
  agencyId: string,
  channel: CommsChannel,
  peerHandle: string,
): string | null {
  const handle = peerHandle.trim().toLowerCase();
  if (!handle) return null;
  const clients = store().listClients(agencyId);
  for (const c of clients) {
    const prefs = getClientCommsPrefs(c.id, agencyId);
    const candidate = prefs?.handles[channel];
    if (candidate && candidate.trim().toLowerCase() === handle) return c.id;
  }
  return null;
}
