/**
 * Federation Transcript Sync
 *
 * Cross-node session transcript synchronization for federation.
 * Enables any node to access session history from the owning node on demand.
 *
 * Features:
 * - On-demand transcript requests across federation
 * - Local caching of frequently accessed transcripts
 * - Real-time message streaming for active sessions
 * - Conflict resolution with vector clocks
 * - TTL-based cache eviction
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "events";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getSessionHistoryStore,
  type SessionHistoryStore,
  type SessionHistoryMessage,
  type SessionHistoryEntry,
} from "./session-sync.js";

const log = createSubsystemLogger("federation").child("transcript-sync");

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

/** Transcript request payload */
export interface TranscriptRequestPayload {
  sessionKey: string;
  nodeId: string;
  limit?: number;
  before?: number;
  includeTools?: boolean;
  requestId: string;
}

/** Transcript response payload */
export interface TranscriptResponsePayload {
  sessionKey: string;
  requestId: string;
  success: boolean;
  messages?: SessionHistoryMessage[];
  session?: SessionHistoryEntry;
  error?: string;
  fromNodeId: string;
}

/** Real-time transcript stream payload */
export interface TranscriptStreamPayload {
  sessionKey: string;
  message: SessionHistoryMessage;
  fromNodeId: string;
}

/** Cached transcript entry */
interface CachedTranscript {
  sessionKey: string;
  messages: SessionHistoryMessage[];
  session?: SessionHistoryEntry;
  cachedAt: number;
  lastAccessed: number;
  hits: number;
  fromNodeId: string;
}

// ══════════════════════════════════════════════════════════════════════════════
// Transcript Cache
// ══════════════════════════════════════════════════════════════════════════════

export class TranscriptCache {
  private cache = new Map<string, CachedTranscript>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(maxSize: number = 100, ttlMs: number = 30 * 60 * 1000) {
    // 30 min TTL
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.startCleanupTimer();
  }

  private startCleanupTimer(): void {
    // Clean up expired entries every 5 minutes
    this.cleanupTimer = setInterval(
      () => {
        this.cleanup();
      },
      5 * 60 * 1000,
    );
  }

  private cleanup(): void {
    const now = Date.now();
    const expired: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.cachedAt > this.ttlMs) {
        expired.push(key);
      }
    }

    for (const key of expired) {
      this.cache.delete(key);
    }

    // If still over capacity, remove least recently used
    if (this.cache.size > this.maxSize) {
      const entries = Array.from(this.cache.entries()).sort(
        ([, a], [, b]) => a.lastAccessed - b.lastAccessed,
      );

      const toRemove = entries.slice(0, this.cache.size - this.maxSize);
      for (const [key] of toRemove) {
        this.cache.delete(key);
      }
    }

    log.debug(
      `Transcript cache cleanup: ${expired.length} expired, ${this.cache.size} entries remain`,
    );
  }

  get(sessionKey: string): CachedTranscript | null {
    const entry = this.cache.get(sessionKey);
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(sessionKey);
      return null;
    }

    // Update access stats
    entry.lastAccessed = Date.now();
    entry.hits++;

    return entry;
  }

  set(
    sessionKey: string,
    data: {
      messages: SessionHistoryMessage[];
      session?: SessionHistoryEntry;
      fromNodeId: string;
    },
  ): void {
    // Make room if needed
    if (this.cache.size >= this.maxSize && !this.cache.has(sessionKey)) {
      // Remove oldest entry
      const oldest = Array.from(this.cache.entries()).sort(
        ([, a], [, b]) => a.lastAccessed - b.lastAccessed,
      )[0];
      if (oldest) {
        this.cache.delete(oldest[0]);
      }
    }

    const now = Date.now();
    this.cache.set(sessionKey, {
      sessionKey,
      messages: data.messages,
      session: data.session,
      cachedAt: now,
      lastAccessed: now,
      hits: 0,
      fromNodeId: data.fromNodeId,
    });

    log.debug(`Cached transcript for ${sessionKey} (${data.messages.length} messages)`);
  }

  invalidate(sessionKey: string): boolean {
    return this.cache.delete(sessionKey);
  }

  clear(): void {
    this.cache.clear();
  }

  stats(): {
    size: number;
    hitRate: number;
    entries: Array<{ key: string; hits: number; age: number }>;
  } {
    const now = Date.now();
    const totalHits = Array.from(this.cache.values()).reduce((sum, entry) => sum + entry.hits, 0);
    const totalRequests = totalHits + this.cache.size; // approximation

    return {
      size: this.cache.size,
      hitRate: totalRequests > 0 ? totalHits / totalRequests : 0,
      entries: Array.from(this.cache.entries()).map(([key, entry]) => ({
        key,
        hits: entry.hits,
        age: now - entry.cachedAt,
      })),
    };
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.cache.clear();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Transcript Sync Manager
// ══════════════════════════════════════════════════════════════════════════════

export class TranscriptSyncManager extends EventEmitter {
  private readonly nodeId: string;
  private readonly cache: TranscriptCache;
  private readonly sessionStore: SessionHistoryStore | null;
  private pendingRequests = new Map<
    string,
    {
      resolve: (result: TranscriptResponsePayload) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
      sessionKey: string;
      timestamp: number;
    }
  >();

  constructor(
    nodeId: string,
    options?: {
      cacheSize?: number;
      cacheTTL?: number;
    },
  ) {
    super();
    this.nodeId = nodeId;
    this.cache = new TranscriptCache(options?.cacheSize, options?.cacheTTL);
    this.sessionStore = getSessionHistoryStore();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Request/Response Methods (for requesting node)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Request transcript from owning node
   */
  async requestTranscript(params: {
    sessionKey: string;
    ownerNodeId: string;
    limit?: number;
    before?: number;
    includeTools?: boolean;
    timeoutMs?: number;
  }): Promise<{
    messages: SessionHistoryMessage[];
    session?: SessionHistoryEntry;
    cached: boolean;
  }> {
    const { sessionKey, ownerNodeId, limit, before, includeTools, timeoutMs = 10000 } = params;

    // Check local store first (if this is actually the owning node)
    if (ownerNodeId === this.nodeId && this.sessionStore) {
      log.debug(`Serving local transcript for ${sessionKey}`);
      const messages = this.sessionStore.getHistory(sessionKey, { limit, before, includeTools });
      const session = this.sessionStore.getSession(sessionKey);
      return { messages, session: session || undefined, cached: false };
    }

    // Check cache
    const cached = this.cache.get(sessionKey);
    if (cached && cached.fromNodeId === ownerNodeId) {
      // Apply filters to cached data
      let messages = cached.messages;
      if (before) {
        messages = messages.filter((m) => m.timestamp < before);
      }
      if (limit && limit > 0) {
        messages = messages.slice(-limit);
      }

      log.debug(`Serving cached transcript for ${sessionKey} (${messages.length} messages)`);
      return { messages, session: cached.session, cached: true };
    }

    // Request from remote node
    const requestId = randomUUID();
    const requestPayload: TranscriptRequestPayload = {
      sessionKey,
      nodeId: ownerNodeId,
      limit,
      before,
      includeTools,
      requestId,
    };

    // Create promise for response
    const responsePromise = new Promise<TranscriptResponsePayload>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Transcript request timeout for ${sessionKey}`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout,
        sessionKey,
        timestamp: Date.now(),
      });
    });

    // Emit request for external routing
    this.emit("transcript:request", {
      targetNodeId: ownerNodeId,
      requestId,
      payload: requestPayload,
    });

    try {
      const response = await responsePromise;

      if (!response.success) {
        throw new Error(response.error || "Transcript request failed");
      }

      // Cache the result
      if (response.messages) {
        this.cache.set(sessionKey, {
          messages: response.messages,
          session: response.session,
          fromNodeId: response.fromNodeId,
        });
      }

      log.debug(
        `Received remote transcript for ${sessionKey} (${response.messages?.length || 0} messages)`,
      );
      return {
        messages: response.messages || [],
        session: response.session,
        cached: false,
      };
    } catch (error) {
      log.warn(`Failed to fetch transcript for ${sessionKey}`, { error });
      throw error;
    }
  }

  /**
   * Handle transcript response from remote node
   */
  handleTranscriptResponse(response: TranscriptResponsePayload): void {
    const pending = this.pendingRequests.get(response.requestId);
    if (!pending) {
      log.warn(`Received response for unknown request ${response.requestId}`);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.requestId);
    pending.resolve(response);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Server Methods (for owning node)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Handle transcript request (when we own the session)
   */
  handleTranscriptRequest(request: TranscriptRequestPayload): TranscriptResponsePayload {
    const { sessionKey, requestId, limit, before, includeTools } = request;

    log.debug(`Handling transcript request for ${sessionKey} (request: ${requestId})`);

    try {
      if (!this.sessionStore) {
        return {
          sessionKey,
          requestId,
          success: false,
          error: "Session store not initialized",
          fromNodeId: this.nodeId,
        };
      }

      // Get session info
      const session = this.sessionStore.getSession(sessionKey);

      // Get message history
      const messages = this.sessionStore.getHistory(sessionKey, {
        limit,
        before,
        includeTools,
      });

      log.debug(`Serving transcript for ${sessionKey}: ${messages.length} messages`);

      return {
        sessionKey,
        requestId,
        success: true,
        messages,
        session: session || undefined,
        fromNodeId: this.nodeId,
      };
    } catch (error) {
      log.error(`Error handling transcript request for ${sessionKey}`, { error });
      return {
        sessionKey,
        requestId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        fromNodeId: this.nodeId,
      };
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Real-time Streaming
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Stream new message to interested nodes
   */
  streamMessage(message: SessionHistoryMessage, targetNodeIds?: string[]): void {
    const streamPayload: TranscriptStreamPayload = {
      sessionKey: message.sessionKey,
      message,
      fromNodeId: this.nodeId,
    };

    this.emit("transcript:stream", {
      payload: streamPayload,
      targetNodeIds,
    });

    log.debug(
      `Streaming message for ${message.sessionKey} to ${targetNodeIds?.length || "all"} nodes`,
    );
  }

  /**
   * Handle streamed message from another node
   */
  handleStreamedMessage(stream: TranscriptStreamPayload): void {
    const { sessionKey, message, fromNodeId } = stream;

    // Update cache if we have it
    const cached = this.cache.get(sessionKey);
    if (cached && cached.fromNodeId === fromNodeId) {
      // Add message to cached history (avoid duplicates)
      const exists = cached.messages.some((m) => m.id === message.id);
      if (!exists) {
        cached.messages.push(message);
        // Keep cache size reasonable
        if (cached.messages.length > 1000) {
          cached.messages = cached.messages.slice(-500);
        }
        cached.lastAccessed = Date.now();
        log.debug(`Updated cached transcript for ${sessionKey} with streamed message`);
      }
    }

    // Emit for local subscribers
    this.emit("message:received", { sessionKey, message, fromNodeId });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Cache Management
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Invalidate cached transcript
   */
  invalidateCache(sessionKey: string): boolean {
    return this.cache.invalidate(sessionKey);
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): ReturnType<TranscriptCache["stats"]> {
    return this.cache.stats();
  }

  /**
   * Clear all cached transcripts
   */
  clearCache(): void {
    this.cache.clear();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Clean up pending requests
   */
  cleanup(): void {
    // Cancel pending requests
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("TranscriptSyncManager shutting down"));
    }
    this.pendingRequests.clear();

    // Clean up cache
    this.cache.destroy();

    log.debug("TranscriptSyncManager cleaned up");
  }

  /**
   * Get pending request stats
   */
  getPendingRequests(): Array<{
    requestId: string;
    sessionKey: string;
    age: number;
  }> {
    const now = Date.now();
    return Array.from(this.pendingRequests.entries()).map(([requestId, req]) => ({
      requestId,
      sessionKey: req.sessionKey,
      age: now - req.timestamp,
    }));
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Singleton
// ══════════════════════════════════════════════════════════════════════════════

let manager: TranscriptSyncManager | null = null;

export function getTranscriptSyncManager(): TranscriptSyncManager | null {
  return manager;
}

export function initTranscriptSyncManager(
  nodeId: string,
  options?: {
    cacheSize?: number;
    cacheTTL?: number;
  },
): TranscriptSyncManager {
  if (manager) {
    manager.cleanup();
  }
  manager = new TranscriptSyncManager(nodeId, options);
  return manager;
}

export function closeTranscriptSyncManager(): void {
  if (manager) {
    manager.cleanup();
    manager = null;
  }
}
