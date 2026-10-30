/**
 * Cross-view intent: "open this agent in the Agents page detail drawer".
 *
 * The mesh map's agent inspector (agent-focus-modal) and any other surface
 * call `requestAgentDrawer(id)`; the app shell switches to the Agents tab on
 * AGENTS_DRAWER_EVENT and the Agents page consumes the pending intent on its
 * next render. Kept dependency-free so callers don't pull in the (lazy) page.
 */

export const AGENTS_DRAWER_EVENT = "infinibot:agents-open-drawer";

export type AgentDrawerTab = "overview" | "performance" | "tools" | "memory" | "channels" | "settings" | "voice" | "logs";

export interface AgentDrawerIntent {
  agentId: string;
  tab?: AgentDrawerTab;
}

let pending: AgentDrawerIntent | null = null;

/**
 * Roster agent id for a mesh/focus agent: its agentId, else the `<id>` of an
 * `agent:<id>:…` session key (sub-agent runs belong to their parent agent).
 */
export function rosterAgentIdOf(agent: { agentId?: string | null; sessionKey?: string | null } | null | undefined): string | null {
  if (!agent) return null;
  const fromKey = /^agent:([^:]+):/.exec(agent.sessionKey ?? "")?.[1] ?? null;
  const id = agent.agentId?.trim();
  // A bare run/session id passed as agentId isn't a roster id; prefer the key.
  if (id && !id.startsWith("agent:") && !/^[0-9a-f-]{32,}$/i.test(id)) return id;
  return fromKey;
}

export function requestAgentDrawer(agentId: string, tab?: AgentDrawerTab): void {
  pending = { agentId, tab };
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<AgentDrawerIntent>(AGENTS_DRAWER_EVENT, { detail: pending }));
  }
}

/** Take (and clear) the pending intent. */
export function takeAgentDrawerIntent(): AgentDrawerIntent | null {
  const p = pending;
  pending = null;
  return p;
}

let mounted = false;

/** App shell: switch to the Agents tab whenever a drawer intent is requested. Idempotent. */
export function mountAgentsDrawerIntent(openAgentsTab: () => void): void {
  if (mounted || typeof window === "undefined") return;
  mounted = true;
  window.addEventListener(AGENTS_DRAWER_EVENT, () => openAgentsTab());
}
