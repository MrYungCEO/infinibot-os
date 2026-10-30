/**
 * AI War Room — Message Bus
 *
 * Structured inter-agent message bus for the war room system.
 * Manages message routing, subscriptions, and broadcasts to
 * connected monitors and gateway clients.
 */

import { EventEmitter } from "events";
import type {
  WarRoomBusEvent,
  WarRoomBusEventType,
  WarRoomMessage,
  WarRoomProposal,
  WarRoomSession,
  WarRoomPhase,
  WarRoomSessionStatus,
  WarRoomMonitorState,
} from "./types.js";

// ─── Subscriber Types ─────────────────────────────────────────────────────────

export type MessageBusSubscriber = (event: WarRoomBusEvent) => void;

export interface MessageBusSubscription {
  id: string;
  sessionId?: string; // undefined = subscribe to all sessions
  eventTypes?: WarRoomBusEventType[]; // undefined = subscribe to all event types
  monitorIndex?: number; // undefined = not filtered by monitor
  unsubscribe: () => void;
}

// ─── Message Bus ─────────────────────────────────────────────────────────────

export class WarRoomMessageBus extends EventEmitter {
  private static _instance: WarRoomMessageBus | null = null;

  private _subscriptions: Map<
    string,
    {
      sessionId?: string;
      eventTypes?: Set<WarRoomBusEventType>;
      monitorIndex?: number;
      handler: MessageBusSubscriber;
    }
  > = new Map();

  private _subIdCounter = 0;

  /** Singleton accessor — war room is a single global instance */
  static getInstance(): WarRoomMessageBus {
    if (!WarRoomMessageBus._instance) {
      WarRoomMessageBus._instance = new WarRoomMessageBus();
    }
    return WarRoomMessageBus._instance;
  }

  /** Subscribe to bus events. Returns an unsubscribe function. */
  subscribe(opts: {
    sessionId?: string;
    eventTypes?: WarRoomBusEventType[];
    monitorIndex?: number;
    handler: MessageBusSubscriber;
  }): MessageBusSubscription {
    const id = `sub_${++this._subIdCounter}`;
    this._subscriptions.set(id, {
      sessionId: opts.sessionId,
      eventTypes: opts.eventTypes ? new Set(opts.eventTypes) : undefined,
      monitorIndex: opts.monitorIndex,
      handler: opts.handler,
    });

    const unsubscribe = () => {
      this._subscriptions.delete(id);
    };

    return { id, ...opts, unsubscribe };
  }

  /** Publish an event to all matching subscribers */
  publish(event: WarRoomBusEvent): void {
    for (const [, sub] of this._subscriptions) {
      // Filter by sessionId
      if (sub.sessionId && sub.sessionId !== event.sessionId) continue;
      // Filter by event type
      if (sub.eventTypes && !sub.eventTypes.has(event.type)) continue;
      // Filter by monitor index
      if (
        sub.monitorIndex !== undefined &&
        event.targetMonitors &&
        !event.targetMonitors.includes(sub.monitorIndex)
      )
        continue;

      try {
        sub.handler(event);
      } catch {
        // Subscriber errors must not crash the bus
      }
    }

    // Also emit on the EventEmitter for any Node.js internal listeners
    this.emit("event", event);
    this.emit(event.type, event);
  }

  // ─── Convenience Publishers ───────────────────────────────────────────────

  /** Emit a new message event */
  publishMessage(sessionId: string, message: WarRoomMessage): void {
    this.publish({
      type: "message.new",
      sessionId,
      payload: message,
      timestamp: Date.now(),
      targetMonitors: message.targetMonitor !== undefined ? [message.targetMonitor] : undefined,
    });
  }

  /** Emit a streaming delta for a message */
  publishMessageStream(
    sessionId: string,
    messageId: string,
    delta: string,
    targetMonitor?: number,
  ): void {
    this.publish({
      type: "message.stream",
      sessionId,
      payload: { messageId, delta },
      timestamp: Date.now(),
      targetMonitors: targetMonitor !== undefined ? [targetMonitor] : undefined,
    });
  }

  /** Emit that streaming is complete for a message */
  publishMessageDone(sessionId: string, message: WarRoomMessage): void {
    this.publish({
      type: "message.done",
      sessionId,
      payload: message,
      timestamp: Date.now(),
      targetMonitors: message.targetMonitor !== undefined ? [message.targetMonitor] : undefined,
    });
  }

  /** Emit a new proposal */
  publishProposalCreated(sessionId: string, proposal: WarRoomProposal): void {
    this.publish({
      type: "proposal.created",
      sessionId,
      payload: proposal,
      timestamp: Date.now(),
    });
  }

  /** Emit a vote on a proposal */
  publishProposalVote(
    sessionId: string,
    proposalId: string,
    agentRole: string,
    vote: string,
    reason?: string,
  ): void {
    this.publish({
      type: "proposal.vote",
      sessionId,
      payload: { proposalId, agentRole, vote, reason },
      timestamp: Date.now(),
    });
  }

  /** Emit proposal resolution */
  publishProposalResolved(sessionId: string, proposal: WarRoomProposal): void {
    this.publish({
      type: "proposal.resolved",
      sessionId,
      payload: proposal,
      timestamp: Date.now(),
    });
  }

  /** Emit phase change */
  publishPhaseChanged(sessionId: string, from: WarRoomPhase, to: WarRoomPhase): void {
    this.publish({
      type: "session.phase.changed",
      sessionId,
      payload: { from, to },
      timestamp: Date.now(),
    });
  }

  /** Emit session status change */
  publishStatusChanged(
    sessionId: string,
    from: WarRoomSessionStatus,
    to: WarRoomSessionStatus,
    session?: WarRoomSession,
  ): void {
    this.publish({
      type: "session.status.changed",
      sessionId,
      payload: { from, to, session },
      timestamp: Date.now(),
    });
  }

  /** Emit monitor highlight event */
  publishMonitorHighlight(sessionId: string, monitorIndex: number, highlighted: boolean): void {
    this.publish({
      type: "monitor.highlight",
      sessionId,
      payload: { monitorIndex, highlighted },
      timestamp: Date.now(),
      targetMonitors: [monitorIndex],
    });
  }

  /** Emit monitor state update */
  publishMonitorUpdate(sessionId: string, monitorState: WarRoomMonitorState): void {
    this.publish({
      type: "monitor.update",
      sessionId,
      payload: monitorState,
      timestamp: Date.now(),
      targetMonitors: [monitorState.index],
    });
  }

  /** Emit agent turn start */
  publishAgentTurnStart(
    sessionId: string,
    agentRole: string,
    agentId: string,
    monitorIndex: number,
  ): void {
    this.publish({
      type: "agent.turn.start",
      sessionId,
      payload: { agentRole, agentId, monitorIndex },
      timestamp: Date.now(),
      targetMonitors: [monitorIndex],
    });
  }

  /** Emit agent turn end */
  publishAgentTurnEnd(
    sessionId: string,
    agentRole: string,
    agentId: string,
    monitorIndex: number,
  ): void {
    this.publish({
      type: "agent.turn.end",
      sessionId,
      payload: { agentRole, agentId, monitorIndex },
      timestamp: Date.now(),
      targetMonitors: [monitorIndex],
    });
  }

  /** Emit execution progress */
  publishExecutionProgress(
    sessionId: string,
    agentRole: string,
    progress: number,
    status: string,
    monitorIndex: number,
  ): void {
    this.publish({
      type: "execution.progress",
      sessionId,
      payload: { agentRole, progress, status, monitorIndex },
      timestamp: Date.now(),
      targetMonitors: [monitorIndex],
    });
  }

  /** Emit review result */
  publishReviewResult(
    sessionId: string,
    artifactId: string,
    reviewerRole: string,
    decision: string,
    feedback: string,
  ): void {
    this.publish({
      type: "review.result",
      sessionId,
      payload: { artifactId, reviewerRole, decision, feedback },
      timestamp: Date.now(),
    });
  }

  /** Remove all subscriptions for a session (call on session cleanup) */
  unsubscribeSession(sessionId: string): void {
    for (const [id, sub] of this._subscriptions) {
      if (sub.sessionId === sessionId) {
        this._subscriptions.delete(id);
      }
    }
  }

  /** Total subscriber count */
  get subscriberCount(): number {
    return this._subscriptions.size;
  }
}

/** Module-level singleton accessor */
export function getWarRoomBus(): WarRoomMessageBus {
  return WarRoomMessageBus.getInstance();
}
