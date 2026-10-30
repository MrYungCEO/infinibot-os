/**
 * Cross-node gateway forwarding helper.
 *
 * When a gateway handler running on the master needs to delegate an RPC to a
 * specific satellite (e.g. "spawn this PTY on node X"), it goes through the
 * hub's `invokeOnNode` → `gateway.proxy.invoke` round-trip. That dance is
 * the same wire format used by `federation.node.invoke`
 * (src/gateway/server-methods/federation.ts:1193) — this helper just makes
 * it callable in one line from any handler.
 *
 * The satellite encodes its arbitrary reply as a JSON string in the
 * SessionResult `reply` field (since `handleInvokeResponse`'s shape is
 * session-shaped). We parse it back here so callers get the raw payload.
 *
 * Two variants are provided:
 * - `forwardGatewayCallToNode` — one-shot request/response (original).
 * - `forwardGatewayCallToNodeStreamed` — chunked/streaming response via an
 *   AsyncIterable. The caller sends an initial RPC with `stream: true` and
 *   the satellite responds with one or more `gateway.proxy.invoke.stream`
 *   messages keyed by a correlation id. Each chunk is yielded as it arrives.
 *   Errors cause the iterator to throw; the stream auto-cleans on consumer
 *   break or idle timeout.
 */

import { randomUUID } from "node:crypto";
import { getFederationHub } from "./hub.js";
import { getFederationSatellite } from "./satellite.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("federation").child("hub-forward");

export interface ForwardResult<T = unknown> {
  /** True if the forwarded call returned without error. */
  success: boolean;
  /** Parsed payload the remote handler responded with. */
  payload?: T;
  /** Error message, when success is false. */
  error?: string;
  /** Error code (NOT_MASTER, INVOKE_FAILED, etc). */
  code?: string;
}

/**
 * Forward a gateway RPC to a specific federation node and await its reply.
 *
 * @param nodeId Target node id (must be a connected satellite from this master's hub).
 * @param method Gateway method name to invoke on the remote node (e.g. "terminal.spawnAgent").
 * @param params Params object to pass to the remote handler.
 * @param timeoutMs Optional timeout, defaults to 30s.
 * @returns A `ForwardResult` with the parsed payload, or an error.
 */
export async function forwardGatewayCallToNode<T = unknown>(
  nodeId: string,
  method: string,
  params: unknown,
  timeoutMs = 30_000,
): Promise<ForwardResult<T>> {
  const hub = getFederationHub();
  if (!hub) {
    log.warn("forwardGatewayCallToNode: no hub (NOT_MASTER)", { method, nodeId });
    return {
      success: false,
      code: "NOT_MASTER",
      error: "forwardGatewayCallToNode requires a federation master hub",
    };
  }

  const hubAny = hub as unknown as {
    invokeOnNode: (
      n: string,
      cmd: string,
      p: unknown,
      ms?: number,
    ) => Promise<{ success: boolean; reply?: string; error?: string }>;
  };

  const startMs = Date.now();

  let proxyRes: { success: boolean; reply?: string; error?: string };
  try {
    proxyRes = await hubAny.invokeOnNode(
      nodeId,
      "gateway.proxy.invoke",
      { method, params },
      timeoutMs,
    );
  } catch (err) {
    const elapsed = Date.now() - startMs;
    log.error("forwardGatewayCallToNode: invoke threw", {
      method,
      nodeId,
      elapsed,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      success: false,
      code: "INVOKE_THREW",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!proxyRes.success) {
    const elapsed = Date.now() - startMs;
    log.warn("forwardGatewayCallToNode: remote error", {
      method,
      nodeId,
      elapsed,
      error: proxyRes.error ?? "remote invoke failed",
    });
    return {
      success: false,
      code: "INVOKE_FAILED",
      error: proxyRes.error ?? "remote invoke failed",
    };
  }

  let payload: unknown = null;
  if (typeof proxyRes.reply === "string") {
    try {
      payload = JSON.parse(proxyRes.reply);
    } catch {
      payload = proxyRes.reply;
    }
  }

  log.debug("forwardGatewayCallToNode: success", {
    method,
    nodeId,
    elapsed: Date.now() - startMs,
  });

  return { success: true, payload: payload as T };
}

/**
 * Cross-node forward that works in BOTH directions:
 *   - Master → satellite: uses the hub's invokeOnNode (same as
 *     forwardGatewayCallToNode).
 *   - Satellite → master: uses the satellite's invokeOnMaster, so the
 *     master executes the method locally and the result flows back.
 *
 * Use this in any gateway handler that accepts a remote `nodeId`
 * (sessions.spawn, terminal.spawnAgent, etc.) so cross-device works
 * regardless of which side the call originated on. The original
 * forwardGatewayCallToNode stays for master-only paths.
 *
 * The `targetIsMaster` predicate determines whether a satellite should
 * tunnel up: pass `nodeId === "master"` (placeholder) OR
 * `nodeId === satellite.getMasterNodeId()` (real id from identity.sync).
 */
export async function forwardGatewayCall<T = unknown>(
  nodeId: string,
  method: string,
  params: unknown,
  timeoutMs = 30_000,
): Promise<ForwardResult<T>> {
  // Path 1: this process is a federation master with a running hub.
  const hub = getFederationHub();
  if (hub) {
    return forwardGatewayCallToNode<T>(nodeId, method, params, timeoutMs);
  }

  // Path 2: this process is a satellite. The topology is hub-and-spoke —
  // satellites have no direct peer links — so EVERY remote call is tunnelled
  // up to the master, which is the router. The master then either:
  //   - runs the method locally (target is the master itself), or
  //   - forwards it on to the target satellite via its hub (sat → sat).
  // We re-attach `nodeId` to the tunnelled params so the master's handler
  // knows the final destination. The master treats its own id / "master" as
  // local (see isLocalNodeId), so a sat → master call runs there; any other
  // id makes the master's own forward branch fire and reach the sibling.
  const satellite = getFederationSatellite();
  if (!satellite) {
    return {
      success: false,
      code: "NOT_FEDERATED",
      error: "forwardGatewayCall called on a node with no federation hub or satellite",
    };
  }
  if (satellite.getState?.() !== "connected") {
    return {
      success: false,
      code: "MASTER_UNAVAILABLE",
      error: `Satellite is not connected to master right now (cannot route to ${nodeId}).`,
    };
  }
  try {
    const tunnelParams = { ...((params as Record<string, unknown>) ?? {}), nodeId };
    const res = await satellite.invokeOnMaster(method, tunnelParams, timeoutMs);
    if (res.success) {
      return { success: true, payload: res.data as T };
    }
    return {
      success: false,
      code: res.error?.code ?? "MASTER_INVOKE_FAILED",
      error: res.error?.message ?? `Master could not route ${method} to node ${nodeId}`,
    };
  } catch (err) {
    return {
      success: false,
      code: "INVOKE_THREW",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// =============================================================================
// Streaming variant
// =============================================================================

/** Options for the streamed variant. */
export interface StreamedCallOptions {
  /** Per-chunk timeout in ms (default 30_000). */
  chunkTimeoutMs?: number;
  /** Overall idle timeout in ms — if no chunk arrives within this window, the
   *  iterator ends (default 5 min). */
  idleTimeoutMs?: number;
}

/** A single chunk received from a streamed RPC. */
export interface StreamChunk<T = unknown> {
  /** Zero-based index of this chunk in the stream. */
  index: number;
  /** Parsed payload for this chunk. */
  payload: T;
  /** True when this is the last chunk. */
  done: boolean;
}

/**
 * Registry of active streaming listeners on the hub side. The hub's
 * `handleMessage` path routes `gateway.proxy.invoke.stream` messages here by
 * correlation id. External code should call `registerStreamListener` /
 * `unregisterStreamListener` from this module.
 */

interface StreamListener<T = unknown> {
  push(chunk: StreamChunk<T>): void;
  throwError(err: Error): void;
}

const streamListeners = new Map<string, StreamListener>();

/**
 * Register a stream listener (called by the hub when a `gateway.proxy.invoke.stream`
 * message arrives and there is an active streamed call waiting for it).
 */
export function registerStreamListener(correlationId: string, listener: StreamListener): void {
  streamListeners.set(correlationId, listener);
}

/**
 * Unregister a stream listener (called on cleanup / stream end).
 */
export function unregisterStreamListener(correlationId: string): void {
  streamListeners.delete(correlationId);
}

/**
 * Push an incoming stream chunk to the matching listener.
 * Returns true if a listener was found, false otherwise.
 */
export function pushStreamChunk(correlationId: string, chunk: StreamChunk): boolean {
  const listener = streamListeners.get(correlationId);
  if (!listener) return false;
  listener.push(chunk);
  return true;
}

/**
 * Push an incoming stream error to the matching listener (causes the
 * AsyncIterable to throw).
 */
export function pushStreamError(correlationId: string, error: Error): boolean {
  const listener = streamListeners.get(correlationId);
  if (!listener) return false;
  listener.throwError(error);
  return true;
}

/**
 * Forward a gateway RPC to a specific federation node and receive the response
 * as a chunked AsyncIterable.
 *
 * The initial RPC is sent with `{ method, params, stream: true }`. The satellite
 * side responds with one or more `gateway.proxy.invoke.stream` messages keyed by
 * the correlation id. Each chunk is yielded as it arrives.
 *
 * Errors propagate as a thrown `Error` from the iterator.
 * Per-chunk timeout (default 30s) and an overall idle timeout (default 5 min)
 * are configurable via `opts`.
 * On consumer break (or early exit), a `stream.cancel` message is sent back to
 * the satellite so it can clean up.
 */
export async function* forwardGatewayCallToNodeStreamed<T = unknown>(
  nodeId: string,
  method: string,
  params: unknown,
  opts?: StreamedCallOptions,
): AsyncIterable<StreamChunk<T>> {
  const hub = getFederationHub();
  if (!hub) {
    log.warn("forwardGatewayCallToNodeStreamed: no hub (NOT_MASTER)", { method, nodeId });
    throw new Error("forwardGatewayCallToNodeStreamed requires a federation master hub");
  }

  const hubAny = hub as unknown as {
    invokeOnNode: (
      n: string,
      cmd: string,
      p: unknown,
      ms?: number,
    ) => Promise<{ success: boolean; reply?: string; error?: string }>;
    sendToNode: (n: string, type: string, payload: unknown) => boolean;
  };

  const chunkTimeoutMs = opts?.chunkTimeoutMs ?? 30_000;
  const idleTimeoutMs = opts?.idleTimeoutMs ?? 5 * 60_000;
  const correlationId = randomUUID();

  const startMs = Date.now();
  log.debug("forwardGatewayCallToNodeStreamed: initiating", { method, nodeId, correlationId });

  // --- Set up the AsyncIterable machinery ---
  type ChunkOrEnd =
    | { kind: "chunk"; value: StreamChunk<T> }
    | { kind: "error"; error: Error }
    | { kind: "end" };
  const queue: ChunkOrEnd[] = [];
  let resolver: ((value: void) => void) | null = null;
  let finished = false;

  const wake = () => {
    if (resolver) {
      resolver();
      resolver = null;
    }
  };

  const listener: StreamListener<T> = {
    push(chunk) {
      queue.push({ kind: "chunk", value: chunk });
      wake();
    },
    throwError(err) {
      queue.push({ kind: "error", error: err });
      wake();
    },
  };

  registerStreamListener(correlationId, listener);

  // Idle / chunk timers
  let idleTimer: NodeJS.Timeout | null = null;
  let chunkTimer: NodeJS.Timeout | null = null;

  const resetTimers = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (chunkTimer) clearTimeout(chunkTimer);
    idleTimer = setTimeout(() => {
      log.warn("forwardGatewayCallToNodeStreamed: idle timeout", {
        method,
        nodeId,
        correlationId,
        elapsed: Date.now() - startMs,
      });
      queue.push({ kind: "end" });
      wake();
    }, idleTimeoutMs);
    chunkTimer = setTimeout(() => {
      log.warn("forwardGatewayCallToNodeStreamed: chunk timeout", {
        method,
        nodeId,
        correlationId,
        elapsed: Date.now() - startMs,
      });
      queue.push({
        kind: "error",
        error: new Error(`stream chunk timeout after ${chunkTimeoutMs}ms`),
      });
      wake();
    }, chunkTimeoutMs);
  };

  const cleanup = () => {
    finished = true;
    unregisterStreamListener(correlationId);
    if (idleTimer) clearTimeout(idleTimer);
    if (chunkTimer) clearTimeout(chunkTimer);
    try {
      if (typeof hubAny.sendToNode === "function") {
        hubAny.sendToNode(nodeId, "gateway.proxy.invoke.stream.cancel", {
          correlationId,
        });
      }
    } catch {
      // best-effort cancel
    }
  };

  // --- Send the initial RPC (with stream: true) ---
  try {
    const initRes = await hubAny.invokeOnNode(
      nodeId,
      "gateway.proxy.invoke",
      { method, params, stream: true, correlationId },
      chunkTimeoutMs,
    );

    if (!initRes.success) {
      log.error("forwardGatewayCallToNodeStreamed: initial invoke failed", {
        method,
        nodeId,
        correlationId,
        elapsed: Date.now() - startMs,
        error: initRes.error ?? "invoke failed",
      });
      cleanup();
      throw new Error(initRes.error ?? "stream invoke failed on remote node");
    }

    // The initial response is just an "ok, streaming started" ack. If it
    // contains a reply, that's the zero-chunk shortcut (single-response
    // case). Parse and yield it, then finish.
    if (typeof initRes.reply === "string" && initRes.reply.length > 0) {
      try {
        const parsed = JSON.parse(initRes.reply);
        // The satellite can short-circuit by returning { done: true, ... }
        // in the initial reply, falling out of the streaming path entirely.
        if (parsed && parsed.__streamDone__) {
          log.debug("forwardGatewayCallToNodeStreamed: single-chunk shortcut", {
            method,
            nodeId,
            correlationId,
          });
          cleanup();
          const chunk: StreamChunk<T> = {
            index: 0,
            payload: parsed.payload as T,
            done: true,
          };
          yield chunk;
          return;
        }
      } catch {
        // Non-JSON reply — not a streaming ack, proceed normally.
      }
    }
  } catch (err) {
    log.error("forwardGatewayCallToNodeStreamed: initial invoke threw", {
      method,
      nodeId,
      correlationId,
      elapsed: Date.now() - startMs,
      error: err instanceof Error ? err.message : String(err),
    });
    cleanup();
    throw err;
  }

  // --- Yield chunks as they arrive ---
  resetTimers();

  try {
    while (!finished) {
      // Wait for something to arrive in the queue
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          resolver = resolve;
        });
      }

      while (queue.length > 0) {
        const item = queue.shift()!;

        if (item.kind === "error") {
          cleanup();
          throw item.error;
        }
        if (item.kind === "end") {
          cleanup();
          return;
        }

        // It's a chunk
        resetTimers();
        yield item.value;
        if (item.value.done) {
          const elapsed = Date.now() - startMs;
          log.debug("forwardGatewayCallToNodeStreamed: stream complete", {
            method,
            nodeId,
            correlationId,
            lastChunkIndex: item.value.index,
            elapsed,
          });
          cleanup();
          return;
        }
      }
    }
  } finally {
    // Ensure cleanup on any early exit (consumer break, etc.)
    if (!finished) {
      cleanup();
    }
  }
}
