/**
 * Session History Gateway Methods
 * 
 * Provides persistent session history with federation sync.
 */

import type { GatewayRequestHandlerOptions } from "./types.js";
import {
  getSessionHistoryStore,
  initSessionHistoryStore,
  type SessionHistoryMessage,
} from "../../federation/session-sync.js";
import { loadConfig } from "../../config/config.js";
import { STATE_DIR } from "../../config/paths.js";

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════

function ensureStore(): ReturnType<typeof getSessionHistoryStore> {
  let store = getSessionHistoryStore();
  if (!store) {
    const config = loadConfig();
    const nodeId = config.federation?.nodeId || "local";
    store = initSessionHistoryStore(STATE_DIR, nodeId);
  }
  return store;
}

// ══════════════════════════════════════════════════════════════════════════════
// Gateway Methods
// ══════════════════════════════════════════════════════════════════════════════

export const sessionHistoryHandlers: Record<string, (opts: GatewayRequestHandlerOptions) => Promise<void> | void> = {
  
  /**
   * Append a message to session history
   */
  "session.history.append": async (opts) => {
    const { sessionKey, role, content, mediaUrls, toolCalls, toolResults } = opts.req.params as {
      sessionKey: string;
      role: "user" | "assistant" | "system";
      content: string;
      mediaUrls?: string[];
      toolCalls?: unknown[];
      toolResults?: unknown[];
    };
    
    if (!sessionKey || !role) {
      opts.respond(false, { error: "sessionKey and role required" });
      return;
    }
    
    const store = ensureStore();
    if (!store) {
      opts.respond(false, { error: "Session history store not available" });
      return;
    }
    
    const message = store.appendMessage({
      sessionKey,
      role,
      content: content || "",
      mediaUrls,
      toolCalls,
      toolResults,
    });
    
    opts.respond(true, { success: true, message });
  },
  
  /**
   * Get session history
   */
  "session.history.get": async (opts) => {
    const { sessionKey, limit, before, includeTools } = opts.req.params as {
      sessionKey: string;
      limit?: number;
      before?: number;
      includeTools?: boolean;
    };
    
    if (!sessionKey) {
      opts.respond(false, { error: "sessionKey required" });
      return;
    }
    
    const store = ensureStore();
    if (!store) {
      opts.respond(false, { error: "Session history store not available" });
      return;
    }
    
    const messages = store.getHistory(sessionKey, { limit, before, includeTools });
    const session = store.getSession(sessionKey);
    
    opts.respond(true, {
      success: true,
      session,
      messages,
      count: messages.length,
    });
  },
  
  /**
   * List all sessions with history
   */
  "session.history.list": async (opts) => {
    const { nodeId, channel, limit, since } = opts.req.params as {
      nodeId?: string;
      channel?: string;
      limit?: number;
      since?: number;
    };
    
    const store = ensureStore();
    if (!store) {
      opts.respond(false, { error: "Session history store not available" });
      return;
    }
    
    const sessions = store.listSessions({ nodeId, channel, limit, since });
    
    opts.respond(true, {
      success: true,
      sessions,
      count: sessions.length,
    });
  },
  
  /**
   * Get unsynced messages for federation
   */
  "session.history.unsynced": async (opts) => {
    const { targetNodeId } = opts.req.params as { targetNodeId: string };
    
    if (!targetNodeId) {
      opts.respond(false, { error: "targetNodeId required" });
      return;
    }
    
    const store = ensureStore();
    if (!store) {
      opts.respond(false, { error: "Session history store not available" });
      return;
    }
    
    const messages = store.getUnsyncedMessages(targetNodeId);
    
    opts.respond(true, {
      success: true,
      messages,
      count: messages.length,
    });
  },
  
  /**
   * Merge messages from another node (federation sync)
   */
  "session.history.merge": async (opts) => {
    const { messages, fromNodeId } = opts.req.params as {
      messages: SessionHistoryMessage[];
      fromNodeId: string;
    };
    
    if (!messages || !fromNodeId) {
      opts.respond(false, { error: "messages and fromNodeId required" });
      return;
    }
    
    const store = ensureStore();
    if (!store) {
      opts.respond(false, { error: "Session history store not available" });
      return;
    }
    
    const merged = store.mergeRemoteMessages(messages, fromNodeId);
    
    opts.respond(true, {
      success: true,
      merged,
    });
  },
  
  /**
   * Mark messages as synced
   */
  "session.history.markSynced": async (opts) => {
    const { toNodeId, upToTimestamp } = opts.req.params as {
      toNodeId: string;
      upToTimestamp: number;
    };
    
    if (!toNodeId || !upToTimestamp) {
      opts.respond(false, { error: "toNodeId and upToTimestamp required" });
      return;
    }
    
    const store = ensureStore();
    if (!store) {
      opts.respond(false, { error: "Session history store not available" });
      return;
    }
    
    store.markSynced(toNodeId, upToTimestamp);
    
    opts.respond(true, { success: true });
  },
  
  /**
   * Get sync status
   */
  "session.history.syncStatus": async (opts) => {
    const store = ensureStore();
    if (!store) {
      opts.respond(false, { error: "Session history store not available" });
      return;
    }
    
    const syncStates = store.getSyncStatus();
    
    opts.respond(true, {
      success: true,
      syncStates,
    });
  },
  
  /**
   * Prune old messages
   */
  "session.history.prune": async (opts) => {
    const { keepDays } = opts.req.params as { keepDays?: number };
    
    const store = ensureStore();
    if (!store) {
      opts.respond(false, { error: "Session history store not available" });
      return;
    }
    
    const pruned = store.prune(keepDays);
    
    opts.respond(true, {
      success: true,
      pruned,
    });
  },
};

export default sessionHistoryHandlers;
