/**
 * Which chat a Robovoice call belongs to.
 *
 * A call started from a chat surface (webchat, the chat sidebar, a Grid chat
 * panel, a plugin chat) is bound to THAT chat's session key, so the plugin
 * runs every turn on it and the replies land in that chat — not in the
 * agent's main session. Session keys look like `agent:<agentId>:<rest>`.
 */

export type CallTarget = { agentId: string; sessionKey?: string };

/** `agent:<id>:…` → `<id>`; anything else → null. */
export function agentIdFromSessionKey(sessionKey: string | null | undefined): string | null {
  const key = sessionKey?.trim();
  if (!key) return null;
  const parts = key.split(":");
  if (parts[0] !== "agent" || parts.length < 3) return null;
  const id = parts[1]?.trim();
  return id ? id : null;
}

/** The agent's own main session (`agent:<id>:main`) — calls there need no explicit binding. */
export function isMainSessionKey(sessionKey: string | null | undefined, agentId?: string | null): boolean {
  const key = sessionKey?.trim();
  if (!key) return true;
  const id = agentIdFromSessionKey(key);
  if (!id) return key === "main";
  if (agentId && id !== agentId) return false;
  return key === `agent:${id}:main`;
}

/**
 * Normalise a call request: derive the agent from the session key when the
 * surface only knows the session, and drop a session key that belongs to a
 * different agent (the call would otherwise talk to one agent and write into
 * another's chat).
 */
export function resolveCallTarget(req: { agentId?: string | null; sessionKey?: string | null }, fallbackAgentId = "main"): CallTarget {
  const sessionKey = req.sessionKey?.trim() || undefined;
  const fromKey = agentIdFromSessionKey(sessionKey);
  const agentId = req.agentId?.trim() || fromKey || fallbackAgentId;
  if (!sessionKey) return { agentId };
  if (fromKey && fromKey !== agentId) return { agentId };
  return { agentId, sessionKey };
}

/** Short human label for a session key: `agent:main:webchat:xyz` → `webchat:xyz`. */
export function sessionLabel(sessionKey: string | null | undefined, titles?: Record<string, string | undefined>): string {
  const key = sessionKey?.trim();
  if (!key) return "main";
  const title = titles?.[key]?.trim();
  if (title) return title;
  const parts = key.split(":");
  if (parts[0] === "agent" && parts.length >= 3) return parts.slice(2).join(":") || "main";
  return key;
}

/** What the tab's current call looks like to a chat surface (the `infinibot:robovoice-call` event detail). */
export type CallBinding = { phase?: string; agentId?: string | null; sessionKey?: string | null; error?: string | null };

const LIVE_PHASES = new Set(["starting", "connecting", "active", "ending"]);

/** A chat's call button: idle, on a call in THIS chat, or blocked by a call in another chat. */
export function chatCallButtonState(sessionKey: string, call: CallBinding | null): "idle" | "this-call" | "other-call" {
  if (!call?.phase || !LIVE_PHASES.has(call.phase)) return "idle";
  return boundTo(sessionKey, call) ? "this-call" : "other-call";
}

/** Is this call (live or just failed) the one started from `sessionKey`'s chat? */
function boundTo(sessionKey: string, call: CallBinding): boolean {
  return call.sessionKey
    ? call.sessionKey === sessionKey
    : isMainSessionKey(sessionKey, call.agentId ?? "main") && agentIdFromSessionKey(sessionKey) === (call.agentId ?? "main");
}

/**
 * A call started from THIS chat that failed to start: one short line the chat
 * button shows (instead of silently going back to idle). Null otherwise.
 */
export function chatCallFailure(sessionKey: string, call: CallBinding | null): string | null {
  if (call?.phase !== "failed" || !boundTo(sessionKey, call)) return null;
  const raw = (call.error ?? "").trim();
  if (/not linked to a character|has no Robovoice voice/i.test(raw)) return "This agent has no Robovoice voice yet. Turn it on under Voice, Voice agents.";
  if (/isn't one of .*agents|not in this organization|foreign_character/i.test(raw)) return "This agent's character isn't in your Robovoice organization. Pick one of your own agents under Voice.";
  if (/not linked|unlinked|connect robovoice/i.test(raw)) return "Connect Robovoice on the Voice page to call.";
  // Cloud voice is free: a refusal is "busy", with the switch to local voice on the Voice page.
  if (/cloud_voice_busy|cloud voice is busy|insufficient_balance|credits exhausted|out of .*credit|top up/i.test(raw))
    return "Cloud voice is busy right now. Switch to local voice (Voice › Settings) to keep talking.";
  return raw ? `Call failed: ${raw.slice(0, 140)}` : "Call failed.";
}
