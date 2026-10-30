/**
 * Secure Mode client store.
 *
 * One tiny module-level store (status / loading / error) shared by every
 * surface. It is loaded with `secure.status` on each gateway hello and kept in
 * sync by the `secure.mode.changed` WS event. Changes are re-broadcast as the
 * window CustomEvent `infinibot:secure-mode` (detail = SecureState) so any
 * view — Lit element or render function — can listen without importing the
 * app. `secure.lane.changed` becomes `infinibot:secure-lane` (detail =
 * `{kind, at}`, never content); open secure views refetch on it.
 *
 * The reducer (`reduceSecure`) and payload parsers are pure for unit tests.
 */

import type { ReactiveController, ReactiveControllerHost } from "lit";

export type SecureKeySource = "secret-tool" | "libsecret-gi" | "env" | "file";
export type SecureCounts = {
  projects: number;
  tasks: number;
  docs: number;
  nodes: number;
  edges: number;
  sessions: number;
};
export type SecureStatus = {
  enabled: boolean;
  unlocked: boolean;
  keySource?: SecureKeySource;
  keyAccount: string;
  updatedAt: number;
  error?: string;
  counts?: SecureCounts;
  seededAt?: number;
  allowedTools: string[];
  /** The gateway enforces the per-agent `secureOnly` policy (newer builds). */
  agentPolicy?: boolean;
  /** Remote models auto-switch to a local one; secure.models + secure.defaultModel.set exist. */
  modelSwitch?: boolean;
  /** secureMode.defaultModel ("provider/model"); null = automatic. */
  defaultModel?: string | null;
  /** secure_research capability (newer builds). */
  research?: SecureResearchInfo;
};
export type SecureResearchInfo = {
  enabled: boolean;
  approval: "ask" | "auto-sanitized";
  searxngUrl: string;
  proxy: boolean;
};
/** `secure.research.changed`: ids + status only, never queries or content. */
export type SecureResearchEvent = { id: string; sessionKey: string | null; status: string; at: number };
export type SecureLaneKind = "kanban" | "docs" | "graph" | "sessions" | "files";
export type SecureLaneEvent = { kind: SecureLaneKind; at: number };

export type SecureState = {
  status: SecureStatus | null;
  /** null = unknown yet; false = the gateway does not serve secure.* (older build). */
  supported: boolean | null;
  loading: boolean;
  /** A secure.set is in flight. */
  busy: boolean;
  /** Last toggle / load error, shown inline next to the toggle. */
  error: string | null;
  /** The chat session currently on screen (for the "secure session locked" indicator). */
  chatSessionKey: string | null;
};

export type SecureAction =
  | { type: "loading" }
  | { type: "status"; status: unknown }
  | { type: "error"; error: string | null }
  | { type: "busy"; busy: boolean }
  | { type: "unsupported" }
  | { type: "chat-session"; key: string | null }
  | { type: "reset" };

export const SECURE_MODE_EVENT = "infinibot:secure-mode";
export const SECURE_LANE_EVENT = "infinibot:secure-lane";
export const GATEWAY_SECURE_MODE_CHANGED = "secure.mode.changed";
export const GATEWAY_SECURE_LANE_CHANGED = "secure.lane.changed";
export const SECURE_RESEARCH_EVENT = "infinibot:secure-research";
export const GATEWAY_SECURE_RESEARCH_CHANGED = "secure.research.changed";

const LANE_KINDS: readonly SecureLaneKind[] = ["kanban", "docs", "graph", "sessions", "files"];
const KEY_SOURCES: readonly SecureKeySource[] = ["secret-tool", "libsecret-gi", "env", "file"];

export function initialSecureState(): SecureState {
  return { status: null, supported: null, loading: false, busy: false, error: null, chatSessionKey: null };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Parse a secure.status / secure.set / secure.mode.changed payload. */
export function normalizeSecureStatus(raw: unknown, prev: SecureStatus | null = null): SecureStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== "boolean") return null;
  const c = r.counts && typeof r.counts === "object" ? (r.counts as Record<string, unknown>) : null;
  const tools = Array.isArray(r.allowedTools)
    ? r.allowedTools.filter((t): t is string => typeof t === "string")
    : (prev?.allowedTools ?? []);
  return {
    enabled: r.enabled,
    unlocked: r.unlocked === true,
    ...(KEY_SOURCES.includes(r.keySource as SecureKeySource) ? { keySource: r.keySource as SecureKeySource } : {}),
    keyAccount: typeof r.keyAccount === "string" ? r.keyAccount : (prev?.keyAccount ?? ""),
    updatedAt: num(r.updatedAt),
    ...(typeof r.error === "string" && r.error ? { error: r.error } : {}),
    ...(c
      ? {
          counts: {
            projects: num(c.projects),
            tasks: num(c.tasks),
            docs: num(c.docs),
            nodes: num(c.nodes),
            edges: num(c.edges),
            sessions: num(c.sessions),
          },
        }
      : {}),
    ...(typeof r.seededAt === "number" && r.seededAt > 0 ? { seededAt: r.seededAt } : {}),
    allowedTools: tools,
    ...(r.agentPolicy === true || (r.agentPolicy === undefined && prev?.agentPolicy) ? { agentPolicy: true } : {}),
    // secure.set / secure.mode.changed carry runtime status only: keep the
    // capability + default model learned from secure.status.
    ...(r.modelSwitch === true || (r.modelSwitch === undefined && prev?.modelSwitch) ? { modelSwitch: true } : {}),
    ...(parseResearchInfo(r.research)
      ? { research: parseResearchInfo(r.research)! }
      : prev?.research
        ? { research: prev.research }
        : {}),
    ...(typeof r.defaultModel === "string" || r.defaultModel === null
      ? { defaultModel: (r.defaultModel as string | null) || null }
      : prev?.defaultModel !== undefined
        ? { defaultModel: prev.defaultModel }
        : {}),
  };
}

export function parseResearchInfo(raw: unknown): SecureResearchInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== "boolean") return null;
  return {
    enabled: r.enabled,
    approval: r.approval === "auto-sanitized" ? "auto-sanitized" : "ask",
    searxngUrl: typeof r.searxngUrl === "string" ? r.searxngUrl : "",
    proxy: r.proxy === true,
  };
}

/** Parse a secure.research.changed payload; null for anything malformed. */
export function parseResearchEvent(raw: unknown): SecureResearchEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.status !== "string") return null;
  return {
    id: r.id,
    sessionKey: typeof r.sessionKey === "string" ? r.sessionKey : null,
    status: r.status,
    at: num(r.at) || Date.now(),
  };
}

/** Parse a secure.lane.changed payload; null for anything malformed. */
export function parseLaneEvent(raw: unknown): SecureLaneEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!LANE_KINDS.includes(r.kind as SecureLaneKind)) return null;
  return { kind: r.kind as SecureLaneKind, at: num(r.at) || Date.now() };
}

export function reduceSecure(state: SecureState, action: SecureAction): SecureState {
  switch (action.type) {
    case "loading":
      return state.loading ? state : { ...state, loading: true };
    case "status": {
      const status = normalizeSecureStatus(action.status, state.status);
      if (!status) return { ...state, loading: false };
      // A status that reports the lane open clears a stale toggle error; a
      // status with its own error (keyring unreachable) surfaces it.
      const error = status.enabled && !status.unlocked ? (status.error ?? state.error) : null;
      return { ...state, status, supported: true, loading: false, error };
    }
    case "error":
      return { ...state, error: action.error, loading: false, busy: false };
    case "busy":
      return state.busy === action.busy ? state : { ...state, busy: action.busy, ...(action.busy ? { error: null } : {}) };
    case "unsupported":
      return { ...state, supported: false, loading: false, status: null };
    case "chat-session":
      return state.chatSessionKey === action.key ? state : { ...state, chatSessionKey: action.key };
    case "reset":
      return { ...initialSecureState(), chatSessionKey: state.chatSessionKey };
  }
}

/** The secure lane is usable right now (toggle on AND key unlocked). */
export function secureActive(s: SecureState | null | undefined): boolean {
  return Boolean(s?.status?.enabled && s.status.unlocked);
}

/** Turn a gateway error into a short sentence for inline display. */
export function friendlySecureError(err: unknown): string {
  const msg = String((err as Error)?.message ?? err ?? "").replace(/^Error:\s*/, "").trim();
  if (!msg) return "Secure Mode request failed.";
  if (/unknown method|not found.*secure\./i.test(msg)) return "This gateway does not support Secure Mode yet — restart it onto the new build.";
  return msg;
}

/** True when the error says the secure lane is locked (Secure Mode off). */
export function isSecureLockedError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err ?? "");
  return /SECURE_MODE_LOCKED|Secure Mode is off|secure lane is locked/i.test(msg);
}

// ── runtime singleton ──────────────────────────────────────────────────────

type RequestClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  supports?: (method: string) => boolean;
};

let current: SecureState = initialSecureState();
let client: RequestClient | null = null;
let loadSeq = 0;

function emit(name: string, detail: unknown): void {
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function dispatchSecure(action: SecureAction): SecureState {
  const next = reduceSecure(current, action);
  if (next !== current) {
    current = next;
    emit(SECURE_MODE_EVENT, current);
  }
  return current;
}

export function getSecureState(): SecureState {
  return current;
}

export function isSecureModeActive(): boolean {
  return secureActive(current);
}

/** Called on every gateway hello: remember the client and (re)load status. */
export function attachSecureClient(next: RequestClient | null): void {
  client = next;
  if (!next) return;
  if (typeof next.supports === "function" && !next.supports("secure.status")) {
    dispatchSecure({ type: "unsupported" });
    return;
  }
  void loadSecureStatus();
}

export async function loadSecureStatus(): Promise<SecureState> {
  if (!client) return current;
  const seq = ++loadSeq;
  dispatchSecure({ type: "loading" });
  try {
    const res = await client.request<unknown>("secure.status", {});
    if (seq !== loadSeq) return current;
    // Hosts without local models (InfiniBot Cloud) report available: false — hide every Secure Mode surface.
    if (res && typeof res === "object" && (res as { available?: unknown }).available === false) {
      return dispatchSecure({ type: "unsupported" });
    }
    return dispatchSecure({ type: "status", status: res });
  } catch (err) {
    if (seq !== loadSeq) return current;
    const msg = friendlySecureError(err);
    if (/does not support Secure Mode/.test(msg)) return dispatchSecure({ type: "unsupported" });
    return dispatchSecure({ type: "error", error: msg });
  }
}

/** secure.set — resolves true when the gateway reports the requested state. */
export async function setSecureMode(enabled: boolean): Promise<boolean> {
  if (!client) {
    dispatchSecure({ type: "error", error: "Not connected to the gateway." });
    return false;
  }
  loadSeq++; // a racing status load must not overwrite the toggle result
  dispatchSecure({ type: "busy", busy: true });
  try {
    const res = await client.request<unknown>("secure.set", { enabled });
    dispatchSecure({ type: "busy", busy: false });
    const s = dispatchSecure({ type: "status", status: res });
    if (enabled && !secureActive(s)) {
      dispatchSecure({
        type: "error",
        error: s.status?.error || "Secure Mode could not unlock: no OS keyring key is reachable.",
      });
      return false;
    }
    return enabled ? true : !s.status?.enabled;
  } catch (err) {
    dispatchSecure({ type: "error", error: friendlySecureError(err) });
    return false;
  }
}

/** Ensure the lane is open (turning Secure Mode on if needed). */
export async function ensureSecureMode(): Promise<boolean> {
  if (secureActive(current)) return true;
  return setSecureMode(true);
}

/** Route a gateway event; returns true when it was a Secure Mode event. */
export function handleSecureGatewayEvent(event: string, payload: unknown): boolean {
  if (event === GATEWAY_SECURE_MODE_CHANGED) {
    loadSeq++;
    dispatchSecure({ type: "status", status: payload });
    return true;
  }
  if (event === GATEWAY_SECURE_RESEARCH_CHANGED) {
    const ev = parseResearchEvent(payload);
    if (ev) emit(SECURE_RESEARCH_EVENT, ev);
    return true;
  }
  if (event === GATEWAY_SECURE_LANE_CHANGED) {
    const lane = parseLaneEvent(payload);
    if (lane) emit(SECURE_LANE_EVENT, lane);
    return true;
  }
  return false;
}

/** Call a secure.* RPC on the attached client. */
export async function secureRequest<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!client) throw new Error("Not connected to the gateway.");
  return client.request<T>(method, params);
}

export function setSecureChatSession(key: string | null): void {
  dispatchSecure({ type: "chat-session", key });
}

export function onSecureChange(fn: (s: SecureState) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const h = (e: Event) => fn((e as CustomEvent<SecureState>).detail ?? current);
  window.addEventListener(SECURE_MODE_EVENT, h);
  return () => window.removeEventListener(SECURE_MODE_EVENT, h);
}

export function onSecureLane(fn: (e: SecureLaneEvent) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const h = (e: Event) => {
    const d = (e as CustomEvent<SecureLaneEvent>).detail;
    if (d) fn(d);
  };
  window.addEventListener(SECURE_LANE_EVENT, h);
  return () => window.removeEventListener(SECURE_LANE_EVENT, h);
}

export function onSecureResearch(fn: (e: SecureResearchEvent) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const h = (e: Event) => {
    const d = (e as CustomEvent<SecureResearchEvent>).detail;
    if (d) fn(d);
  };
  window.addEventListener(SECURE_RESEARCH_EVENT, h);
  return () => window.removeEventListener(SECURE_RESEARCH_EVENT, h);
}

/** Test seam: drop the singleton back to its initial state. */
export function __resetSecureStoreForTests(): void {
  current = initialSecureState();
  client = null;
  loadSeq = 0;
}

/**
 * Lit controller: re-renders the host on every Secure Mode change and (when
 * given) runs `onLane` for lane events of the listed kinds.
 */
export class SecureModeController implements ReactiveController {
  private offMode: (() => void) | null = null;
  private offLane: (() => void) | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly opts: { kinds?: SecureLaneKind[]; onLane?: (e: SecureLaneEvent) => void; onChange?: (s: SecureState) => void } = {},
  ) {
    host.addController(this);
  }

  get state(): SecureState {
    return current;
  }

  get active(): boolean {
    return secureActive(current);
  }

  hostConnected(): void {
    this.offMode = onSecureChange((s) => {
      this.opts.onChange?.(s);
      this.host.requestUpdate();
    });
    if (this.opts.onLane) {
      const kinds = this.opts.kinds;
      this.offLane = onSecureLane((e) => {
        if (!kinds || kinds.includes(e.kind)) this.opts.onLane?.(e);
      });
    }
  }

  hostDisconnected(): void {
    this.offMode?.();
    this.offLane?.();
    this.offMode = null;
    this.offLane = null;
  }
}
