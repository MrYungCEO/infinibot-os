import { generateUUID } from "./uuid";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../../../src/gateway/protocol/client-info.js";
import { buildDeviceAuthPayload } from "../../../src/gateway/device-auth.js";
import { loadOrCreateDeviceIdentity, signDevicePayload } from "./device-identity";
import { clearDeviceAuthToken, loadDeviceAuthToken, storeDeviceAuthToken } from "./device-auth";
import { getClerkToken, isSaasMode, noteSaasConnected, noteSaasConnectRejected } from "./saas-clerk";
import { isCloudBuild } from "./cloud/cloud-env";
import {
  isGatewaySleeping,
  noteGatewayClosed,
  noteGatewayConnected,
  noteSleepAnnounced,
  onSleepChange,
  setActivityPinger,
} from "./cloud/gateway-sleep";

/** The socket closed while a request was in flight (not an answer from the gateway). */
class GatewayClosedError extends Error {
  constructor(readonly code: number, reason: string) {
    super(`gateway closed (${code}): ${reason}`);
  }
}

export type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: { presence: number; health: number };
};

export type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
};

export type GatewayHelloOk = {
  type: "hello-ok";
  protocol: number;
  features?: { methods?: string[]; events?: string[] };
  snapshot?: unknown;
  auth?: {
    deviceToken?: string;
    role?: string;
    scopes?: string[];
    issuedAtMs?: number;
  };
  policy?: { tickIntervalMs?: number };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

export type GatewayBrowserClientOptions = {
  url: string;
  token?: string;
  password?: string;
  /** One-time invite token from a ?invite= URL — single-use, no password needed. */
  inviteToken?: string;
  clientName?: GatewayClientName;
  clientVersion?: string;
  platform?: string;
  mode?: GatewayClientMode;
  instanceId?: string;
  onHello?: (hello: GatewayHelloOk) => void;
  onEvent?: (evt: GatewayEventFrame) => void;
  /** `sleeping` = a hosted wake-mode workspace went to sleep; no reconnect follows. */
  onClose?: (info: { code: number; reason: string; sleeping?: boolean }) => void;
  onReconnecting?: (info: { attempt: number; delayMs: number }) => void;
  onGap?: (info: { expected: number; received: number }) => void;
};

// 4008 = application-defined code (browser rejects 1008 "Policy Violation")
const CONNECT_FAILED_CLOSE_CODE = 4008;

export class GatewayBrowserClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private closed = false;
  private lastSeq: number | null = null;
  private connectNonce: string | null = null;
  private connectSent = false;
  private connectTimer: number | null = null;
  private connectGeneration = 0;
  /** SaaS: the last connect was refused, so the next one re-mints the Clerk token. */
  private saasRejected = false;
  /** The gateway answered hello on the current socket: other requests may go out. */
  private handshakeDone = false;
  private backoffMs = 800;
  private reconnectAttempt = 0;
  private eventSubscribers = new Set<(evt: GatewayEventFrame) => void>();
  /** Hosted wake-mode workspace asleep: no reconnect until it is woken (cloud/gateway-sleep.ts). */
  private parked = false;
  private unsubscribeSleep: (() => void) | null = null;

  /**
   * Method names the gateway advertised in its `hello-ok` handshake.
   *
   * Surfaces that depend on RPCs which may not exist on this build (a newer
   * engine landing behind the UI, or an older gateway) use `supports()` to say
   * so honestly instead of firing a call that comes back "method not found".
   */
  private advertisedMethods: ReadonlySet<string> | null = null;

  // RPC concurrency cap: when a dozen panels mount at once they can fire 100+
  // requests synchronously and flood the gateway. Bound in-flight requests and
  // queue the rest; each settled response frees a slot and pumps the queue.
  private maxConcurrentRpc = 12;
  /** Generous by default so genuinely slow work (backups, model calls, invoice
   *  parsing) still completes; pass timeoutMs per call to tighten or disable. */
  private defaultRequestTimeoutMs = 60_000;
  private inFlightRpc = 0;
  private rpcQueue: Array<() => void> = [];

  constructor(private opts: GatewayBrowserClientOptions) {}

  /** Current reconnection attempt number (0 = not reconnecting) */
  get reconnecting(): number {
    return this.reconnectAttempt;
  }

  /** The gateway's ws(s):// URL this client connects to — used to derive an
   *  http(s) base for fetching plugin-served assets (e.g. plugin UI bundles). */
  get url(): string {
    return this.opts.url;
  }

  /**
   * Subscribe to gateway events. Returns an unsubscribe function.
   */
  /**
   * Every method this gateway says it serves, or `null` before the handshake
   * has landed. `null` means "unknown", never "none" — callers must not treat
   * a pre-handshake read as proof a method is missing.
   */
  get serverMethods(): ReadonlySet<string> | null {
    return this.advertisedMethods;
  }

  /**
   * Capability probe. Returns `true` while the method list is still unknown so
   * a surface rendered before the handshake offers the control and lets the
   * call itself fail loudly, rather than hiding a feature that does exist.
   */
  supports(method: string): boolean {
    return this.advertisedMethods ? this.advertisedMethods.has(method) : true;
  }

  /** First advertised name from `candidates`, or null when none are served. */
  resolveMethod(candidates: readonly string[]): string | null {
    if (!this.advertisedMethods) return candidates[0] ?? null;
    return candidates.find((name) => this.advertisedMethods?.has(name)) ?? null;
  }

  subscribe(handler: (evt: GatewayEventFrame) => void): () => void {
    this.eventSubscribers.add(handler);
    return () => this.eventSubscribers.delete(handler);
  }

  start() {
    this.closed = false;
    this.unsubscribeSleep ??= onSleepChange((phase) => {
      // Woken (the orchestrator started the Machine again): reconnect at once.
      if (phase !== "awake" || !this.parked || this.closed) return;
      this.parked = false;
      this.backoffMs = 800;
      this.connect();
    });
    this.connect();
  }

  stop() {
    this.closed = true;
    this.parked = false;
    this.unsubscribeSleep?.();
    this.unsubscribeSleep = null;
    this.ws?.close();
    this.ws = null;
    this.handshakeDone = false;
    this.flushPending(new Error("gateway client stopped"));
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connect() {
    if (this.closed) return;
    if (isGatewaySleeping()) {
      this.parked = true;
      return;
    }
    this.connectGeneration++;
    this.handshakeDone = false;
    this.ws = new WebSocket(this.opts.url);
    this.ws.onopen = () => this.queueConnect();
    this.ws.onmessage = (ev) => this.handleMessage(String(ev.data ?? ""));
    this.ws.onclose = (ev) => {
      const reason = String(ev.reason ?? "");
      this.ws = null;
      this.handshakeDone = false;
      // Cancel any pending connect timer from this generation
      if (this.connectTimer !== null) {
        window.clearTimeout(this.connectTimer);
        this.connectTimer = null;
      }
      this.flushPending(new GatewayClosedError(ev.code, reason));
      // A sleeping workspace is not reconnected: any new connection would wake
      // its Machine again. The next click or key press wakes it instead.
      const sleeping = !this.closed && noteGatewayClosed(ev.code);
      this.opts.onClose?.({ code: ev.code, reason, sleeping });
      this.scheduleReconnect();
    };
    this.ws.onerror = () => {
      // ignored; close handler will fire
    };
  }

  private scheduleReconnect() {
    if (this.closed) return;
    if (isGatewaySleeping()) {
      this.parked = true;
      return;
    }
    this.reconnectAttempt++;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.7, 15_000);
    this.opts.onReconnecting?.({ attempt: this.reconnectAttempt, delayMs: delay });
    window.setTimeout(() => this.connect(), delay);
  }

  private flushPending(err: Error) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private async sendConnect() {
    if (this.connectSent) return;
    this.connectSent = true;
    const generation = this.connectGeneration;
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }

    // crypto.subtle is only available in secure contexts (HTTPS, localhost).
    // Over plain HTTP, we skip device identity and fall back to token-only auth.
    // Gateways may reject this unless gateway.controlUi.allowInsecureAuth is enabled.
    const isSecureContext = typeof crypto !== "undefined" && !!crypto.subtle;

    const scopes = ["operator.admin", "operator.approvals", "operator.pairing"];
    const role = "operator";
    let deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null = null;
    let canFallbackToShared = false;
    let authToken = this.opts.token;

    // A workspace-user session (multi-user, `ibus_` token) must win over a
    // device token stored by an earlier OWNER login in this browser —
    // otherwise signing in as a user would silently reconnect as the owner.
    const userSession = isUserSessionToken(this.opts.token);
    if (isSecureContext) {
      deviceIdentity = await loadOrCreateDeviceIdentity();
      const storedToken = userSession
        ? undefined
        : loadDeviceAuthToken({
            deviceId: deviceIdentity.deviceId,
            role,
          })?.token;
      authToken = storedToken ?? this.opts.token;
      canFallbackToShared = Boolean(storedToken && this.opts.token);
    }

    // SaaS mode: authenticate with the Clerk session token. The gateway verifies
    // it and resolves the tenant (see server-side message-handler). Takes
    // precedence over any stored device/shared token.
    // Never falls back to a stored device/shared token: that could reconnect a
    // new Clerk identity as the previous one. After a rejected connect the
    // token is re-minted, bypassing Clerk's cache.
    if (isSaasMode()) {
      const clerkToken = await getClerkToken({ fresh: this.saasRejected });
      if (generation !== this.connectGeneration) return;
      // getClerkToken can transiently return null right after boot (the Clerk
      // session isn't ready in this context yet), so fall back to the token the
      // caller passed (fleet-connect hands over the one it just used to resolve
      // the gateway). Only refuse when neither is available.
      const token = clerkToken ?? this.opts.token;
      if (!token) {
        noteSaasConnectRejected("no-session", "No active sign-in session to authenticate with.");
        this.ws?.close(CONNECT_FAILED_CLOSE_CODE, "no session");
        return;
      }
      authToken = token;
      canFallbackToShared = false;
    }
    const auth =
      authToken || this.opts.password || this.opts.inviteToken
        ? {
            token: authToken,
            password: this.opts.password,
            inviteToken: this.opts.inviteToken,
          }
        : undefined;

    let device:
      | {
          id: string;
          publicKey: string;
          signature: string;
          signedAt: number;
          nonce: string | undefined;
        }
      | undefined;

    if (isSecureContext && deviceIdentity) {
      const signedAtMs = Date.now();
      const nonce = this.connectNonce ?? undefined;
      const payload = buildDeviceAuthPayload({
        deviceId: deviceIdentity.deviceId,
        clientId: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.CONTROL_UI,
        clientMode: this.opts.mode ?? GATEWAY_CLIENT_MODES.WEBCHAT,
        role,
        scopes,
        signedAtMs,
        token: authToken ?? null,
        nonce,
      });
      const signature = await signDevicePayload(deviceIdentity.privateKey, payload);
      device = {
        id: deviceIdentity.deviceId,
        publicKey: deviceIdentity.publicKey,
        signature,
        signedAt: signedAtMs,
        nonce,
      };
    }
    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.CONTROL_UI,
        version: this.opts.clientVersion ?? "dev",
        platform: this.opts.platform ?? navigator.platform ?? "web",
        mode: this.opts.mode ?? GATEWAY_CLIENT_MODES.WEBCHAT,
        instanceId: this.opts.instanceId,
      },
      role,
      scopes,
      device,
      caps: [],
      auth,
      userAgent: navigator.userAgent,
      locale: navigator.language,
    };

    // If the WS closed and a new connect() started while we were awaiting
    // crypto, this sendConnect is stale — bail out to avoid sending a
    // rogue "connect" frame on the new WebSocket.
    if (generation !== this.connectGeneration) return;

    void this.request<GatewayHelloOk>("connect", params)
      .then((hello) => {
        if (generation !== this.connectGeneration) return;
        if (hello?.auth?.deviceToken && deviceIdentity) {
          storeDeviceAuthToken({
            deviceId: deviceIdentity.deviceId,
            role: hello.auth.role ?? role,
            token: hello.auth.deviceToken,
            scopes: hello.auth.scopes ?? [],
          });
        }
        if (Array.isArray(hello?.features?.methods)) {
          this.advertisedMethods = new Set(hello.features.methods);
        }
        this.backoffMs = 800;
        this.reconnectAttempt = 0;
        this.handshakeDone = true;
        if (isSaasMode()) {
          this.saasRejected = false;
          noteSaasConnected();
        }
        // Hosted wake-mode workspace: this client reports real user input, which
        // (not the open socket) is what holds off idle sleep.
        if (this.advertisedMethods?.has("fleet.activity")) {
          setActivityPinger(() => {
            if (this.connected) void this.request("fleet.activity", {}).catch(() => {});
          });
          noteGatewayConnected();
        }
        this.opts.onHello?.(hello);
      })
      .catch((err) => {
        if (generation !== this.connectGeneration) return;
        console.warn("[gateway] connect failed:", err?.message ?? err);
        // Hosted cloud: a socket that closed before the gateway answered (its
        // handshake timer, a network drop) is not a refusal of the session. A new
        // tenant's first connect can outlast the gateway's 10s handshake window
        // while it provisions the workspace, so keep reconnecting instead of
        // halting on "Session rejected". Real refusals arrive as 1008 / an error reply.
        const transient = isCloudBuild() && err instanceof GatewayClosedError && err.code !== 1008;
        if (isSaasMode() && !transient) {
          this.saasRejected = true;
          noteSaasConnectRejected("auth", String(err?.message ?? err));
        }
        if (canFallbackToShared && deviceIdentity) {
          clearDeviceAuthToken({ deviceId: deviceIdentity.deviceId, role });
        }
        this.ws?.close(CONNECT_FAILED_CLOSE_CODE, "connect failed");
      });
  }

  private handleMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const frame = parsed as { type?: unknown };
    if (frame.type === "event") {
      const evt = parsed as GatewayEventFrame;
      if (evt.event === "connect.challenge") {
        const payload = evt.payload as { nonce?: unknown } | undefined;
        const nonce = payload && typeof payload.nonce === "string" ? payload.nonce : null;
        if (nonce) {
          this.connectNonce = nonce;
          void this.sendConnect();
        }
        return;
      }
      if (evt.event === "fleet.sleep") noteSleepAnnounced();
      const seq = typeof evt.seq === "number" ? evt.seq : null;
      if (seq !== null) {
        if (this.lastSeq !== null && seq > this.lastSeq + 1) {
          this.opts.onGap?.({ expected: this.lastSeq + 1, received: seq });
        }
        this.lastSeq = seq;
      }
      try {
        this.opts.onEvent?.(evt);
      } catch (err) {
        console.error("[gateway] event handler error:", err);
      }
      // Also dispatch to subscribers
      for (const handler of this.eventSubscribers) {
        try {
          handler(evt);
        } catch (err) {
          console.error("[gateway] subscriber handler error:", err);
        }
      }
      return;
    }

    if (frame.type === "res") {
      const res = parsed as GatewayResponseFrame;
      const pending = this.pending.get(res.id);
      if (!pending) return;
      this.pending.delete(res.id);
      if (res.ok) pending.resolve(res.payload);
      else pending.reject(new Error(res.error?.message ?? "request failed"));
      return;
    }
  }

  private releaseRpcSlot() {
    this.inFlightRpc = Math.max(0, this.inFlightRpc - 1);
    while (this.inFlightRpc < this.maxConcurrentRpc && this.rpcQueue.length) {
      const next = this.rpcQueue.shift()!;
      this.inFlightRpc++;
      next();
    }
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway not connected"));
    }
    // An open socket is not a connected one. Until hello, the gateway answers
    // any other frame with "first request must be connect" and closes the
    // socket (1008), which the SaaS flow counts as a refused session. A hosted
    // handshake takes seconds (token check + tenant lookup), so a poller firing
    // in that window used to kill every reconnect.
    if (method !== "connect" && !this.handshakeDone) {
      return Promise.reject(new Error("gateway not connected"));
    }
    // The gateway runs SQLite synchronously, so a single pathological query
    // stalls every response. Without a deadline those requests never settle,
    // never release their concurrency slot, and after maxConcurrentRpc of them
    // the client stops issuing requests for every view at once.
    const timeoutMs = options.timeoutMs ?? this.defaultRequestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const dispatch = () => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          this.releaseRpcSlot();
          reject(new Error("gateway not connected"));
          return;
        }
        const id = generateUUID();
        const frame = { type: "req", id, method, params };
        let timer: number | null = null;
        const settle = (fn: () => void) => {
          if (timer !== null) window.clearTimeout(timer);
          this.releaseRpcSlot();
          fn();
        };
        this.pending.set(id, {
          resolve: (v) => settle(() => resolve(v as T)),
          reject: (e) => settle(() => reject(e)),
        });
        if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
          timer = window.setTimeout(() => {
            if (!this.pending.delete(id)) return;
            this.releaseRpcSlot();
            reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
          }, timeoutMs);
        }
        try {
          this.ws.send(JSON.stringify(frame));
        } catch (e) {
          this.pending.delete(id);
          if (timer !== null) window.clearTimeout(timer);
          this.releaseRpcSlot();
          reject(e as Error);
        }
      };
      if (this.inFlightRpc < this.maxConcurrentRpc) {
        this.inFlightRpc++;
        dispatch();
      } else {
        this.rpcQueue.push(dispatch);
      }
    });
  }

  /** Alias for request() - many controllers use this name */
  call<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    return this.request<T>(method, params, options);
  }

  private queueConnect() {
    this.connectNonce = null;
    this.connectSent = false;
    if (this.connectTimer !== null) window.clearTimeout(this.connectTimer);
    this.connectTimer = window.setTimeout(() => {
      void this.sendConnect();
    }, 750);
  }
}

/** Multi-user workspace session tokens (issued by POST /api/access/login). */
export function isUserSessionToken(token: string | undefined | null): boolean {
  return typeof token === "string" && token.startsWith("ibus_");
}
