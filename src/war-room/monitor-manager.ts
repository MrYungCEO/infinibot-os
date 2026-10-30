/**
 * AI War Room — Monitor Manager
 *
 * Manages the state of 5 monitors, each showing a different agent's
 * perspective and workspace. Handles monitor-specific WebSocket routing,
 * animation state, and performance-optimized updates.
 */

import type {
  WarRoomMonitorState,
  WarRoomMessage,
  WarRoomSession,
  WarRoomAgentRole,
  MonitorAnimState,
  WarRoomBusEvent,
} from "./types.js";
import { getWarRoomBus } from "./message-bus.js";

// ─── Monitor Configuration ────────────────────────────────────────────────────

export const MONITOR_COUNT = 5;

export const MONITOR_ROLES: WarRoomAgentRole[] = ["ceo", "cto", "cmo", "cfo", "ops"];

/** Maps monitor index → agent role */
export function getMonitorRole(index: number): WarRoomAgentRole {
  return MONITOR_ROLES[index] ?? "ceo";
}

/** Maps agent role → monitor index */
export function getMonitorIndex(role: WarRoomAgentRole): number {
  return MONITOR_ROLES.indexOf(role);
}

// ─── Monitor State Factory ────────────────────────────────────────────────────

export function createMonitorState(index: number): WarRoomMonitorState {
  return {
    index,
    agentRole: getMonitorRole(index),
    isActive: false,
    highlighted: false,
    messages: [],
    streamBuffer: "",
    animState: "idle",
    lastActivityAt: 0,
  };
}

export function createAllMonitorStates(): WarRoomMonitorState[] {
  return Array.from({ length: MONITOR_COUNT }, (_, i) => createMonitorState(i));
}

// ─── Monitor Manager ──────────────────────────────────────────────────────────

export class WarRoomMonitorManager {
  private _sessionMonitors: Map<string, WarRoomMonitorState[]> = new Map();
  private _busSubscriptions: Map<string, () => void> = new Map();

  /** Initialize monitors for a session */
  initSession(session: WarRoomSession): WarRoomMonitorState[] {
    const monitors = createAllMonitorStates();
    this._sessionMonitors.set(session.id, monitors);

    // Subscribe to bus events for this session
    const bus = getWarRoomBus();
    const sub = bus.subscribe({
      sessionId: session.id,
      handler: (event) => this._handleBusEvent(session.id, event),
    });
    this._busSubscriptions.set(session.id, sub.unsubscribe);

    return monitors;
  }

  /** Get all monitor states for a session */
  getMonitors(sessionId: string): WarRoomMonitorState[] | undefined {
    return this._sessionMonitors.get(sessionId);
  }

  /** Get a specific monitor for a session */
  getMonitor(sessionId: string, index: number): WarRoomMonitorState | undefined {
    return this._sessionMonitors.get(sessionId)?.[index];
  }

  /** Clean up session monitors */
  destroySession(sessionId: string): void {
    this._sessionMonitors.delete(sessionId);
    const unsub = this._busSubscriptions.get(sessionId);
    if (unsub) {
      unsub();
      this._busSubscriptions.delete(sessionId);
    }
  }

  /** Update a specific monitor's animation state */
  setMonitorAnimState(sessionId: string, index: number, animState: MonitorAnimState): void {
    const monitor = this.getMonitor(sessionId, index);
    if (!monitor) return;
    monitor.animState = animState;
    monitor.lastActivityAt = Date.now();
    getWarRoomBus().publishMonitorUpdate(sessionId, monitor);
  }

  /** Highlight a monitor (agent is speaking) */
  highlightMonitor(sessionId: string, index: number, highlighted: boolean): void {
    const monitors = this.getMonitors(sessionId);
    if (!monitors) return;

    for (const m of monitors) {
      if (m.index === index) {
        m.highlighted = highlighted;
        m.isActive = highlighted;
        m.animState = highlighted ? "speaking" : "idle";
        m.lastActivityAt = Date.now();
      } else if (highlighted) {
        // Dim others when one is highlighted
        m.highlighted = false;
      }
    }

    getWarRoomBus().publishMonitorHighlight(sessionId, index, highlighted);
  }

  /** Push a message to the appropriate monitor */
  pushMessage(sessionId: string, message: WarRoomMessage): void {
    const monitorIndex = message.targetMonitor ?? getMonitorIndex(message.fromRole);
    const monitor = this.getMonitor(sessionId, monitorIndex);
    if (!monitor) return;

    monitor.messages.push(message);
    monitor.lastActivityAt = Date.now();

    // Keep monitor message buffer bounded (last 50 messages)
    if (monitor.messages.length > 50) {
      monitor.messages = monitor.messages.slice(-50);
    }
  }

  /** Update stream buffer for a monitor */
  updateStreamBuffer(sessionId: string, index: number, delta: string): void {
    const monitor = this.getMonitor(sessionId, index);
    if (!monitor) return;
    monitor.streamBuffer += delta;
    monitor.lastActivityAt = Date.now();
    if (monitor.animState !== "typing") {
      monitor.animState = "typing";
    }
  }

  /** Clear stream buffer for a monitor (after stream complete) */
  clearStreamBuffer(sessionId: string, index: number): void {
    const monitor = this.getMonitor(sessionId, index);
    if (!monitor) return;
    monitor.streamBuffer = "";
    monitor.animState = "idle";
  }

  /** Get a snapshot of monitor states for a session */
  getSnapshot(sessionId: string): WarRoomMonitorState[] {
    return this.getMonitors(sessionId) ?? createAllMonitorStates();
  }

  // ─── Bus Event Handler ──────────────────────────────────────────────────────

  private _handleBusEvent(sessionId: string, event: WarRoomBusEvent): void {
    switch (event.type) {
      case "message.new": {
        const msg = event.payload as WarRoomMessage;
        this.pushMessage(sessionId, msg);
        break;
      }
      case "message.stream": {
        const { messageId: _messageId, delta } = event.payload as {
          messageId: string;
          delta: string;
        };
        if (event.targetMonitors?.length) {
          for (const idx of event.targetMonitors) {
            this.updateStreamBuffer(sessionId, idx, delta);
          }
        }
        break;
      }
      case "message.done": {
        const msg = event.payload as WarRoomMessage;
        const idx = msg.targetMonitor ?? getMonitorIndex(msg.fromRole);
        this.clearStreamBuffer(sessionId, idx);
        break;
      }
      case "monitor.highlight": {
        const { monitorIndex, highlighted } = event.payload as {
          monitorIndex: number;
          highlighted: boolean;
        };
        this.highlightMonitor(sessionId, monitorIndex, highlighted);
        break;
      }
      case "agent.turn.start": {
        const { monitorIndex, agentRole: _agentRole } = event.payload as {
          monitorIndex: number;
          agentRole: string;
        };
        this.setMonitorAnimState(sessionId, monitorIndex, "typing");
        break;
      }
      case "agent.turn.end": {
        const { monitorIndex } = event.payload as { monitorIndex: number };
        this.setMonitorAnimState(sessionId, monitorIndex, "idle");
        break;
      }
      case "proposal.vote": {
        const { agentRole } = event.payload as { agentRole: string };
        const idx = getMonitorIndex(agentRole as WarRoomAgentRole);
        this.setMonitorAnimState(sessionId, idx, "voting");
        setTimeout(() => {
          this.setMonitorAnimState(sessionId, idx, "idle");
        }, 2000);
        break;
      }
      case "review.result": {
        const { reviewerRole, decision } = event.payload as {
          reviewerRole: string;
          decision: string;
        };
        const idx = getMonitorIndex(reviewerRole as WarRoomAgentRole);
        const animState: MonitorAnimState =
          decision === "approved" ? "approved" : decision === "rejected" ? "rejected" : "reviewing";
        this.setMonitorAnimState(sessionId, idx, animState);
        setTimeout(() => {
          this.setMonitorAnimState(sessionId, idx, "idle");
        }, 3000);
        break;
      }
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _managerInstance: WarRoomMonitorManager | null = null;

export function getMonitorManager(): WarRoomMonitorManager {
  if (!_managerInstance) {
    _managerInstance = new WarRoomMonitorManager();
  }
  return _managerInstance;
}

// ─── CSS Animation Helpers (used by UI) ──────────────────────────────────────

/** Map animation state to CSS class names for GPU-accelerated transitions */
export function animStateToClasses(state: MonitorAnimState): string {
  const base = "war-room-monitor";
  const states: Record<MonitorAnimState, string> = {
    idle: `${base}--idle`,
    typing: `${base}--typing`,
    speaking: `${base}--speaking`,
    reviewing: `${base}--reviewing`,
    voting: `${base}--voting`,
    executing: `${base}--executing`,
    approved: `${base}--approved`,
    rejected: `${base}--rejected`,
  };
  return states[state] ?? `${base}--idle`;
}

/** Performance hint: whether a monitor needs a repaint this frame */
export function monitorNeedsUpdate(monitor: WarRoomMonitorState, lastRenderedAt: number): boolean {
  return monitor.lastActivityAt > lastRenderedAt;
}

/** Get the role-specific accent color for CSS variables */
export const ROLE_ACCENT_COLORS: Record<WarRoomAgentRole, string> = {
  ceo: "#f59e0b",
  cto: "#3b82f6",
  cmo: "#ec4899",
  cfo: "#10b981",
  ops: "#8b5cf6",
};
