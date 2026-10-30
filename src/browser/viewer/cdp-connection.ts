/**
 * A long-lived CDP connection to the browser endpoint with flattened target
 * sessions (one socket, many tabs). The viewer needs events (screencast
 * frames, target lifecycle), which the request/response helpers in
 * ../cdp.helpers.ts don't keep a socket open for.
 */
import WebSocket from "ws";

import { rawDataToString } from "../../infra/ws.js";

export type CdpEvent = { method: string; params: Record<string, unknown>; sessionId?: string };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventListeners = new Set<(evt: CdpEvent) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => this.onMessage(rawDataToString(data)));
    ws.on("close", () => this.onClose());
    ws.on("error", () => this.onClose());
  }

  static connect(wsUrl: string, timeoutMs = 5000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      // Frames are base64 JPEGs: allow large messages, no per-message deflate.
      const ws = new WebSocket(wsUrl, {
        handshakeTimeout: timeoutMs,
        perMessageDeflate: false,
        maxPayload: 64 * 1024 * 1024,
      });
      const fail = (err: unknown) => reject(err instanceof Error ? err : new Error(String(err)));
      ws.once("error", fail);
      ws.once("open", () => {
        ws.off("error", fail);
        resolve(new CdpConnection(ws));
      });
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onEvent(fn: (evt: CdpEvent) => void): void {
    this.eventListeners.add(fn);
  }

  onceClosed(fn: () => void): void {
    this.closeListeners.add(fn);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs = 10_000,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("browser connection closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
    this.onClose();
  }

  private onMessage(raw: string): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? "CDP error"));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method === "string") {
      const evt: CdpEvent = {
        method: msg.method,
        params: msg.params ?? {},
        sessionId: msg.sessionId,
      };
      for (const fn of this.eventListeners) {
        try {
          fn(evt);
        } catch {
          // a listener must not break the socket pump
        }
      }
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("browser connection closed"));
    }
    this.pending.clear();
    for (const fn of this.closeListeners) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
  }
}
