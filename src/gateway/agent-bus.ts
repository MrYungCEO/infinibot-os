/**
 * AgentBus — cross-agent messaging backbone.
 *
 * Delivers messages between agent sessions via the system-event queue
 * (same mechanism as sessions.send RPC). In-memory subscribers get
 * immediate notification; messages are also persisted to a rolling JSONL
 * log for audit and replay.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../config/paths.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";

export type AgentMessageType = "task" | "update" | "query" | "response" | "alert";

export type AgentMessage = {
  id: string;
  type: AgentMessageType;
  fromAgentId: string;
  toAgentId: string;
  payload: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  ts: number;
};

type AgentMessageHandler = (msg: AgentMessage) => void;

const MAX_LOG_LINES = 1000;

export class AgentBus {
  private subscribers = new Map<string, Set<AgentMessageHandler>>();
  private logPath: string;

  constructor(stateDir: string = STATE_DIR) {
    this.logPath = join(stateDir, "agent-bus-log.jsonl");
    try {
      mkdirSync(stateDir, { recursive: true });
    } catch {
      // state dir may already exist
    }
  }

  /**
   * Subscribe to messages addressed to `agentId`.
   * Returns an unsubscribe function.
   */
  subscribe(agentId: string, handler: AgentMessageHandler): () => void {
    let set = this.subscribers.get(agentId);
    if (!set) {
      set = new Set();
      this.subscribers.set(agentId, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  /**
   * Send a message from one agent to another.
   * Injects into the target agent's system-event queue (picked up on next
   * prompt build) and calls any registered in-memory subscribers.
   */
  send(
    fromAgentId: string,
    toAgentId: string,
    message: string,
    metadata?: {
      type?: AgentMessageType;
      correlationId?: string;
      [key: string]: unknown;
    },
  ): AgentMessage {
    const msg: AgentMessage = {
      id: randomUUID(),
      type: (metadata?.type as AgentMessageType | undefined) ?? "update",
      fromAgentId,
      toAgentId,
      payload: message,
      correlationId:
        typeof metadata?.correlationId === "string" ? metadata.correlationId : undefined,
      metadata,
      ts: Date.now(),
    };

    // Inject into the target agent's active system-event queue
    const sessionKey = buildAgentMainSessionKey({ agentId: toAgentId });
    try {
      enqueueSystemEvent(
        `[AGENT MSG from:${fromAgentId} type:${msg.type} id:${msg.id}]: ${message}`,
        { sessionKey, contextKey: `agent-bus:${msg.id}` },
      );
    } catch {
      // Target session not active — message logged but not injected live
    }

    // Notify in-memory subscribers (e.g. workflow engine)
    const subs = this.subscribers.get(toAgentId);
    if (subs) {
      for (const handler of subs) {
        try {
          handler(msg);
        } catch {
          // subscriber errors must not propagate
        }
      }
    }

    this._appendLog(msg);
    return msg;
  }

  /**
   * Broadcast a single message to multiple agents.
   * All deliveries share the same correlationId for threading.
   */
  broadcast(
    fromAgentId: string,
    toAgentIds: string[],
    message: string,
    metadata?: {
      type?: AgentMessageType;
      correlationId?: string;
      [key: string]: unknown;
    },
  ): AgentMessage[] {
    const correlationId =
      typeof metadata?.correlationId === "string" ? metadata.correlationId : randomUUID();
    return toAgentIds.map((id) =>
      this.send(fromAgentId, id, message, { ...metadata, correlationId }),
    );
  }

  private _appendLog(msg: AgentMessage): void {
    try {
      appendFileSync(this.logPath, JSON.stringify(msg) + "\n", "utf8");
    } catch {
      // best-effort — logging failure must never break delivery
    }
  }
}

// Process-scoped singleton
let _busInstance: AgentBus | null = null;

export function getAgentBus(): AgentBus {
  if (!_busInstance) {
    _busInstance = new AgentBus();
  }
  return _busInstance;
}
