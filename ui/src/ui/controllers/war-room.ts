/**
 * AI War Room — UI State Controller
 *
 * Manages client-side state for the war room dashboard.
 * Handles WebSocket event routing, session data, and monitor states.
 */

import type { GatewayBrowserClient } from "../gateway";

// ─── Types (mirrored from backend for UI use) ─────────────────────────────────

export type WarRoomAgentRole = "ceo" | "cto" | "cmo" | "cfo" | "ops";
export type WarRoomScenario =
  | "website-upgrade"
  | "product-launch"
  | "growth-strategy"
  | "technical-review"
  | "financial-planning"
  | "crisis-management"
  | "custom";

export type WarRoomSessionStatus =
  | "initializing"
  | "active"
  | "deliberating"
  | "executing"
  | "reviewing"
  | "paused"
  | "completed"
  | "failed";

export type WarRoomPhase =
  | "briefing"
  | "analysis"
  | "debate"
  | "proposal"
  | "voting"
  | "decision"
  | "execution"
  | "review"
  | "reporting";

export type WarRoomMessageType =
  | "proposal"
  | "analysis"
  | "vote"
  | "challenge"
  | "decision"
  | "execution"
  | "review"
  | "status"
  | "system";

export type MonitorAnimState =
  | "idle"
  | "typing"
  | "speaking"
  | "reviewing"
  | "voting"
  | "executing"
  | "approved"
  | "rejected";

export interface WarRoomMessageUI {
  id: string;
  sessionId: string;
  fromAgentId: string;
  fromRole: WarRoomAgentRole;
  toRole?: WarRoomAgentRole;
  type: WarRoomMessageType;
  content: string;
  streamContent?: string;
  streaming?: boolean;
  timestamp: number;
  targetMonitor?: number;
  artifacts?: Array<{
    id: string;
    type: string;
    title: string;
    content: string;
    language?: string;
    createdByRole: WarRoomAgentRole;
    reviewStatus?: string;
  }>;
}

export interface WarRoomProposalUI {
  id: string;
  sessionId: string;
  proposedByRole: WarRoomAgentRole;
  title: string;
  description: string;
  votes: Record<WarRoomAgentRole, string | undefined>;
  status: "open" | "voting" | "approved" | "rejected" | "executed" | "abandoned";
  ceoOverride?: string;
  createdAt: number;
}

export interface WarRoomAgentUI {
  id: string;
  role: WarRoomAgentRole;
  name: string;
  title: string;
  monitorIndex: number;
  accentColor: string;
  icon: string;
}

export interface WarRoomSessionUI {
  id: string;
  title: string;
  scenario: WarRoomScenario;
  status: WarRoomSessionStatus;
  agents: WarRoomAgentUI[];
  messages: WarRoomMessageUI[];
  proposals: WarRoomProposalUI[];
  currentPhase: WarRoomPhase;
  activeAgentId?: string;
  turnOrder: WarRoomAgentRole[];
  currentTurnIndex: number;
  maxRounds: number;
  currentRound: number;
  createdAt: number;
  updatedAt: number;
}

export interface WarRoomMonitorUI {
  index: number;
  agentRole: WarRoomAgentRole;
  isActive: boolean;
  highlighted: boolean;
  messages: WarRoomMessageUI[];
  streamBuffer: string;
  animState: MonitorAnimState;
  lastActivityAt: number;
}

// ─── State ────────────────────────────────────────────────────────────────────

export interface WarRoomState {
  // Session list
  sessions: Array<{
    id: string;
    title: string;
    scenario: WarRoomScenario;
    status: WarRoomSessionStatus;
    currentPhase: WarRoomPhase;
    messageCount: number;
    createdAt: number;
  }>;
  sessionsLoading: boolean;
  sessionsError: string | null;

  // Active session
  activeSessionId: string | null;
  activeSession: WarRoomSessionUI | null;
  sessionLoading: boolean;
  sessionError: string | null;

  // Monitor state (5 monitors)
  monitors: WarRoomMonitorUI[];

  // Create session form
  createForm: {
    open: boolean;
    title: string;
    scenario: WarRoomScenario;
    scenarioContext: string;
    maxRounds: number;
    submitting: boolean;
    error: string | null;
  };

  // View mode
  viewMode: "grid" | "focus" | "list";
  focusedMonitor: number | null;

  // Live stream buffers per monitor (updated by WebSocket events)
  streamBuffers: string[];

  // Event log for debugging
  eventLog: Array<{ type: string; payload: unknown; timestamp: number }>;
}

export function createWarRoomState(): WarRoomState {
  return {
    sessions: [],
    sessionsLoading: false,
    sessionsError: null,
    activeSessionId: null,
    activeSession: null,
    sessionLoading: false,
    sessionError: null,
    monitors: Array.from({ length: 5 }, (_, i): WarRoomMonitorUI => ({
      index: i,
      agentRole: (["ceo", "cto", "cmo", "cfo", "ops"] as WarRoomAgentRole[])[i],
      isActive: false,
      highlighted: false,
      messages: [],
      streamBuffer: "",
      animState: "idle",
      lastActivityAt: 0,
    })),
    createForm: {
      open: false,
      title: "",
      scenario: "website-upgrade",
      scenarioContext: "",
      maxRounds: 3,
      submitting: false,
      error: null,
    },
    viewMode: "grid",
    focusedMonitor: null,
    streamBuffers: ["", "", "", "", ""],
    eventLog: [],
  };
}

// ─── API Functions ────────────────────────────────────────────────────────────

export async function loadWarRoomSessions(
  state: WarRoomState,
  client: GatewayBrowserClient,
): Promise<void> {
  state.sessionsLoading = true;
  state.sessionsError = null;
  try {
    const result = await client.request<{ sessions: WarRoomState["sessions"] }>(
      "war.room.sessions.list",
      { limit: 20 },
    );
    state.sessions = result.sessions ?? [];
  } catch (err) {
    state.sessionsError = err instanceof Error ? err.message : String(err);
  } finally {
    state.sessionsLoading = false;
  }
}

export async function loadWarRoomSession(
  state: WarRoomState,
  client: GatewayBrowserClient,
  sessionId: string,
): Promise<void> {
  state.sessionLoading = true;
  state.sessionError = null;
  try {
    const result = await client.request<{ session: WarRoomSessionUI }>(
      "war.room.session.get",
      { sessionId },
    );
    state.activeSessionId = sessionId;
    state.activeSession = result.session;

    // Rebuild monitor message buffers from session messages
    rebuildMonitorBuffers(state);
  } catch (err) {
    state.sessionError = err instanceof Error ? err.message : String(err);
  } finally {
    state.sessionLoading = false;
  }
}

export async function createWarRoomSession(
  state: WarRoomState,
  client: GatewayBrowserClient,
): Promise<string | null> {
  const { createForm } = state;
  createForm.submitting = true;
  createForm.error = null;
  try {
    const result = await client.request<{ session: WarRoomSessionUI }>(
      "war.room.session.create",
      {
        title: createForm.title,
        scenario: createForm.scenario,
        scenarioContext: createForm.scenarioContext,
        maxRounds: createForm.maxRounds,
      },
    );
    const session = result.session;
    // Add to sessions list
    state.sessions.unshift({
      id: session.id,
      title: session.title,
      scenario: session.scenario,
      status: session.status,
      currentPhase: session.currentPhase,
      messageCount: 0,
      createdAt: session.createdAt,
    });
    createForm.open = false;
    createForm.title = "";
    createForm.scenarioContext = "";
    return session.id;
  } catch (err) {
    createForm.error = err instanceof Error ? err.message : String(err);
    return null;
  } finally {
    createForm.submitting = false;
  }
}

export async function startWarRoomDebate(
  state: WarRoomState,
  client: GatewayBrowserClient,
  sessionId: string,
): Promise<void> {
  await client.request("war.room.debate.start", { sessionId });
  // The actual messages will stream in via WebSocket events
}

export async function runAgentTurn(
  state: WarRoomState,
  client: GatewayBrowserClient,
  sessionId: string,
  agentRole: WarRoomAgentRole,
  prompt?: string,
): Promise<void> {
  await client.request("war.room.agent.turn", {
    sessionId,
    agentRole,
    prompt,
  });
}

export async function advancePhase(
  state: WarRoomState,
  client: GatewayBrowserClient,
  sessionId: string,
  toPhase?: WarRoomPhase,
): Promise<void> {
  const result = await client.request<{ session: WarRoomSessionUI }>(
    "war.room.phase.advance",
    { sessionId, toPhase },
  );
  if (state.activeSession && state.activeSessionId === sessionId) {
    state.activeSession.currentPhase = result.session.currentPhase;
    state.activeSession.status = result.session.status;
  }
}

export async function deleteWarRoomSession(
  state: WarRoomState,
  client: GatewayBrowserClient,
  sessionId: string,
): Promise<void> {
  await client.request("war.room.session.delete", { sessionId });
  state.sessions = state.sessions.filter((s) => s.id !== sessionId);
  if (state.activeSessionId === sessionId) {
    state.activeSessionId = null;
    state.activeSession = null;
  }
}

// ─── WebSocket Event Handler ─────────────────────────────────────────────────

export function handleWarRoomEvent(
  state: WarRoomState,
  eventType: string,
  payload: unknown,
  requestUpdate: () => void,
): void {
  // Log to event log (bounded)
  state.eventLog.push({ type: eventType, payload, timestamp: Date.now() });
  if (state.eventLog.length > 100) state.eventLog = state.eventLog.slice(-100);

  const p = payload as Record<string, unknown>;
  const sessionId = p?.sessionId as string | undefined;

  // Only process events for the active session
  if (sessionId && sessionId !== state.activeSessionId) return;

  switch (eventType) {
    case "war.room.event": {
      const busEvent = payload as { type: string; sessionId: string; payload: unknown; targetMonitors?: number[] };
      handleWarRoomBusEvent(state, busEvent, requestUpdate);
      break;
    }
  }
}

function handleWarRoomBusEvent(
  state: WarRoomState,
  event: { type: string; sessionId: string; payload: unknown; targetMonitors?: number[] },
  requestUpdate: () => void,
): void {
  const p = event.payload as Record<string, unknown>;

  switch (event.type) {
    case "message.new": {
      const msg = event.payload as WarRoomMessageUI;
      // Add to active session
      if (state.activeSession) {
        state.activeSession.messages.push(msg);
      }
      // Route to monitor
      const monitorIdx = msg.targetMonitor ?? roleToMonitorIndex(msg.fromRole);
      if (monitorIdx >= 0 && monitorIdx < 5) {
        state.monitors[monitorIdx].messages.push(msg);
        state.monitors[monitorIdx].lastActivityAt = Date.now();
        if (state.monitors[monitorIdx].messages.length > 50) {
          state.monitors[monitorIdx].messages = state.monitors[monitorIdx].messages.slice(-50);
        }
      }
      requestUpdate();
      break;
    }

    case "message.stream": {
      const { delta } = p as { messageId: string; delta: string };
      if (event.targetMonitors?.length) {
        for (const idx of event.targetMonitors) {
          if (idx >= 0 && idx < 5) {
            state.streamBuffers[idx] += delta;
            state.monitors[idx].streamBuffer = state.streamBuffers[idx];
            state.monitors[idx].animState = "typing";
            state.monitors[idx].lastActivityAt = Date.now();
          }
        }
      }
      requestUpdate();
      break;
    }

    case "message.done": {
      const msg = event.payload as WarRoomMessageUI;
      const idx = msg.targetMonitor ?? roleToMonitorIndex(msg.fromRole);
      if (idx >= 0 && idx < 5) {
        state.streamBuffers[idx] = "";
        state.monitors[idx].streamBuffer = "";
        state.monitors[idx].animState = "idle";
      }
      // Update the streaming message in the session
      if (state.activeSession) {
        const existing = state.activeSession.messages.find((m) => m.id === msg.id);
        if (existing) {
          existing.content = msg.content;
          existing.streaming = false;
          existing.streamContent = undefined;
        }
      }
      requestUpdate();
      break;
    }

    case "monitor.highlight": {
      const { monitorIndex, highlighted } = p as { monitorIndex: number; highlighted: boolean };
      for (let i = 0; i < 5; i++) {
        if (i === monitorIndex) {
          state.monitors[i].highlighted = highlighted;
          state.monitors[i].isActive = highlighted;
          if (highlighted) state.monitors[i].animState = "speaking";
        } else if (highlighted) {
          state.monitors[i].highlighted = false;
        }
      }
      requestUpdate();
      break;
    }

    case "agent.turn.start": {
      const { monitorIndex } = p as { monitorIndex: number };
      if (monitorIndex >= 0 && monitorIndex < 5) {
        state.monitors[monitorIndex].animState = "typing";
        state.monitors[monitorIndex].lastActivityAt = Date.now();
      }
      requestUpdate();
      break;
    }

    case "agent.turn.end": {
      const { monitorIndex } = p as { monitorIndex: number };
      if (monitorIndex >= 0 && monitorIndex < 5) {
        state.monitors[monitorIndex].animState = "idle";
      }
      requestUpdate();
      break;
    }

    case "session.status.changed": {
      const { to } = p as { to: WarRoomSessionStatus };
      if (state.activeSession) {
        state.activeSession.status = to;
      }
      requestUpdate();
      break;
    }

    case "session.phase.changed": {
      const { to } = p as { to: WarRoomPhase };
      if (state.activeSession) {
        state.activeSession.currentPhase = to;
      }
      requestUpdate();
      break;
    }

    case "proposal.created": {
      const proposal = event.payload as WarRoomProposalUI;
      if (state.activeSession) {
        state.activeSession.proposals.push(proposal);
      }
      requestUpdate();
      break;
    }

    case "proposal.resolved": {
      const proposal = event.payload as WarRoomProposalUI;
      if (state.activeSession) {
        const idx = state.activeSession.proposals.findIndex((p) => p.id === proposal.id);
        if (idx !== -1) state.activeSession.proposals[idx] = proposal;
      }
      requestUpdate();
      break;
    }

    case "review.result": {
      const { reviewerRole, decision } = p as { reviewerRole: WarRoomAgentRole; decision: string };
      const idx = roleToMonitorIndex(reviewerRole);
      if (idx >= 0 && idx < 5) {
        state.monitors[idx].animState = decision === "approved"
          ? "approved"
          : decision === "rejected"
          ? "rejected"
          : "reviewing";
        setTimeout(requestUpdate, 3000);
      }
      requestUpdate();
      break;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function roleToMonitorIndex(role: WarRoomAgentRole): number {
  const roles: WarRoomAgentRole[] = ["ceo", "cto", "cmo", "cfo", "ops"];
  return roles.indexOf(role);
}

function rebuildMonitorBuffers(state: WarRoomState): void {
  // Clear monitors
  for (const m of state.monitors) {
    m.messages = [];
    m.streamBuffer = "";
  }

  // Redistribute messages from session
  if (!state.activeSession) return;
  for (const msg of state.activeSession.messages) {
    const idx = msg.targetMonitor ?? roleToMonitorIndex(msg.fromRole);
    if (idx >= 0 && idx < 5) {
      state.monitors[idx].messages.push(msg);
    }
  }
}

// ─── Role Metadata ────────────────────────────────────────────────────────────

export const ROLE_META: Record<WarRoomAgentRole, {
  label: string;
  accentColor: string;
  bgColor: string;
  name: string;
  title: string;
}> = {
  ceo: {
    label: "CEO",
    accentColor: "#f59e0b",
    bgColor: "rgba(245, 158, 11, 0.1)",
    name: "Alex Chen",
    title: "Chief Executive Officer",
  },
  cto: {
    label: "CTO",
    accentColor: "#3b82f6",
    bgColor: "rgba(59, 130, 246, 0.1)",
    name: "Jordan Rivers",
    title: "Chief Technology Officer",
  },
  cmo: {
    label: "CMO",
    accentColor: "#ec4899",
    bgColor: "rgba(236, 72, 153, 0.1)",
    name: "Maya Santos",
    title: "Chief Marketing Officer",
  },
  cfo: {
    label: "CFO",
    accentColor: "#10b981",
    bgColor: "rgba(16, 185, 129, 0.1)",
    name: "Oliver Reed",
    title: "Chief Financial Officer",
  },
  ops: {
    label: "OPS",
    accentColor: "#8b5cf6",
    bgColor: "rgba(139, 92, 246, 0.1)",
    name: "Sam Park",
    title: "Head of Operations",
  },
};

export const SCENARIO_LABELS: Record<WarRoomScenario, string> = {
  "website-upgrade": "Website Component Upgrade",
  "product-launch": "Product Launch",
  "growth-strategy": "Growth Strategy",
  "technical-review": "Technical Architecture Review",
  "financial-planning": "Financial Planning",
  "crisis-management": "Crisis Management",
  "custom": "Custom Scenario",
};

export const PHASE_LABELS: Record<WarRoomPhase, string> = {
  briefing: "Briefing",
  analysis: "Analysis",
  debate: "Debate",
  proposal: "Proposals",
  voting: "Voting",
  decision: "Decision",
  execution: "Execution",
  review: "Review",
  reporting: "Reporting",
};
