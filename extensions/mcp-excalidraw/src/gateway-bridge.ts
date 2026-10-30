/**
 * Bridges the MCP server to the InfiniBot gateway.
 *
 * Every canvas mutation (create, update, delete, view-change) calls
 * `broadcastCanvasUpdate` to push the new state to the gateway, which
 * fans it out to every connected Control UI client. The UI's whiteboard
 * controller listens for these and dispatches the `excalidraw-update`
 * DOM event that the React canvas already consumes — so no UI changes
 * needed beyond the bridge.
 *
 * Connection model:
 *   - Lazy-connect on the first send. If the gateway is down we queue
 *     up to MAX_QUEUE updates and replay on reconnect; beyond that we
 *     drop the oldest. This keeps the MCP server responsive to the
 *     agent even if the operator hasn't started the gateway yet.
 *   - Auto-reconnect with exponential backoff capped at 5s. The MCP
 *     process is short-lived enough that a longer cap doesn't help.
 *   - Auth: GATEWAY_TOKEN or GATEWAY_PASSWORD env vars; we send
 *     whichever is provided. Mirrors how src/mcp/server.ts authenticates.
 */
import { WebSocket } from "ws";
import type { CanvasElement } from "./elements.js";

const PROTOCOL_VERSION = 3;
const MAX_QUEUE = 200;
const BACKOFF_MIN_MS = 100;
const BACKOFF_MAX_MS = 5000;

export interface CanvasBridgeOptions {
  url: string;
  token?: string;
  password?: string;
  verbose?: boolean;
}

interface QueuedFrame {
  type: "req";
  id: string;
  method: string;
  params: unknown;
}

let ws: WebSocket | null = null;
let connectAttempt = 0;
let connecting = false;
let connected = false;
let queue: QueuedFrame[] = [];
let opts: CanvasBridgeOptions | null = null;
let nextRequestId = 1;

type LocalCanvasBridge = {
  update: (elements: CanvasElement[]) => void;
  view: (params: { fitToContent?: boolean; scrollToElementId?: string; zoom?: number }) => void;
  clear: () => void;
};

let localBridge: LocalCanvasBridge | null = null;

/** Use the already-running gateway broadcaster for in-process plugin tools. */
export function configureLocalCanvasBridge(bridge: LocalCanvasBridge | null): void {
  localBridge = bridge;
}

function log(msg: string, meta?: unknown): void {
  if (opts?.verbose) console.error(`[mcp-excalidraw:bridge] ${msg}`, meta ?? "");
}

function logErr(msg: string, meta?: unknown): void {
  console.error(`[mcp-excalidraw:bridge] ${msg}`, meta ?? "");
}

function nextId(): string {
  return `mcp-canvas-${nextRequestId++}`;
}

function backoffMs(): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * Math.pow(2, connectAttempt));
}

export function configureBridge(options: CanvasBridgeOptions): void {
  opts = options;
}

function flushQueue(): void {
  if (!ws || ws.readyState !== ws.OPEN) return;
  const pending = queue.splice(0);
  for (const frame of pending) {
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      logErr("failed to flush frame", err);
      // Re-queue and stop; we'll try again on next reconnect.
      queue.unshift(frame);
      break;
    }
  }
}

function send(method: string, params: unknown): void {
  const frame: QueuedFrame = { type: "req", id: nextId(), method, params };
  // Guard explicitly: `ws?.readyState === ws?.OPEN` is `undefined === undefined`
  // when ws is null (truthy), which then tries to call .send on null and
  // throws inside the catch. Costs nothing now, prevents noisy stacks
  // when the gateway is offline.
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(frame));
      return;
    } catch (err) {
      logErr("send failed; queuing", err);
    }
  }
  queue.push(frame);
  if (queue.length > MAX_QUEUE) {
    // Drop the oldest — bias toward delivering recent canvas state, not
    // replaying the history of every mutation since the gateway died.
    queue.splice(0, queue.length - MAX_QUEUE);
  }
  ensureConnected();
}

function ensureConnected(): void {
  if (!opts) return;
  if (connecting || connected) return;
  connecting = true;
  const url = opts.url;
  log(`connecting to ${url} (attempt ${connectAttempt + 1})`);
  try {
    ws = new WebSocket(url);
  } catch (err) {
    logErr("websocket construct failed", err);
    connecting = false;
    scheduleReconnect();
    return;
  }
  ws.on("open", () => {
    log("ws open — handshaking");
    const handshake = {
      type: "req",
      id: nextId(),
      method: "connect",
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "infinibot-mcp",
          version: "0.1.0",
          platform: "node",
          mode: "backend",
        },
        auth: opts!.password
          ? { password: opts!.password }
          : opts!.token
            ? { token: opts!.token }
            : undefined,
        role: "operator",
      },
    };
    try {
      ws!.send(JSON.stringify(handshake));
    } catch (err) {
      logErr("handshake send failed", err);
    }
  });
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "res" && msg.payload?.type === "hello-ok") {
        connected = true;
        connecting = false;
        connectAttempt = 0;
        log("connected; flushing queue", { queued: queue.length });
        flushQueue();
      } else if (msg.type === "res" && msg.ok === false) {
        // A reqest failed — log and move on. Canvas updates are fire-and-
        // forget; the operator's source of truth is the next mutation.
        logErr("rpc error", msg.error);
      }
    } catch {
      // Non-JSON or unexpected frame — ignore.
    }
  });
  ws.on("close", () => {
    log("ws closed");
    connected = false;
    connecting = false;
    scheduleReconnect();
  });
  ws.on("error", (err) => {
    log("ws error", err.message);
    connected = false;
  });
}

function scheduleReconnect(): void {
  if (connecting || connected) return;
  const delay = backoffMs();
  connectAttempt++;
  log(`reconnect scheduled in ${delay}ms`);
  setTimeout(() => {
    ensureConnected();
  }, delay).unref();
}

// ─── Public API used by tools ─────────────────────────────────────────

/** Push the entire current scene to the UI. The whiteboard view does a
 *  full updateScene() so this is the simplest and most reliable shape. */
export function broadcastCanvasUpdate(elements: CanvasElement[]): void {
  if (localBridge) return localBridge.update(elements);
  send("whiteboard.canvas.update", { elements });
}

/** Tell the UI to fit the camera to the supplied elements (or all if
 *  empty). Optional — the operator can also do this manually. */
export function broadcastCanvasView(opts: {
  fitToContent?: boolean;
  scrollToElementId?: string;
  zoom?: number;
}): void {
  if (localBridge) return localBridge.view(opts);
  send("whiteboard.canvas.view", opts);
}

/** Convenience: explicit clear so the UI can drop element state without
 *  having to interpret an empty-array update. */
export function broadcastCanvasClear(): void {
  if (localBridge) return localBridge.clear();
  send("whiteboard.canvas.clear", {});
}
