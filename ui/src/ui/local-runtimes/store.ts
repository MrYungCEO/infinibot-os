/**
 * Local model runtime store (GPU widget + chat status line).
 *
 * Loaded with `localRuntimes.status` on every gateway hello and refreshed on
 * `localRuntimes.status` events (swap progress). Surfaces subscribe via
 * `onLocalRuntimes`. Against an older gateway (no localRuntimes.* methods)
 * the store reports `unsupported` and the widget renders nothing.
 */

export const LOCAL_RUNTIMES_EVENT = "localRuntimes.status";
export const LOCAL_RUNTIMES_WINDOW_EVENT = "ib:local-runtimes";

export type RuntimeState = "stopped" | "starting" | "ready" | "stopping" | "failed" | "unavailable";
export type SwapPhase = "waiting" | "draining" | "freeing" | "starting" | "loading" | "ready" | "failed";

export type SwapProgress = {
  runtimeId: string;
  label: string;
  model?: string;
  phase: SwapPhase;
  message: string;
  startedAt: number;
  elapsedSec: number;
  etaSec: number;
  fromRuntimeId?: string;
  fromLabel?: string;
  error?: string;
};

export type RuntimeStatus = {
  id: string;
  label: string;
  kind: "systemd" | "ollama";
  unit?: string;
  baseUrl: string;
  providers: string[];
  state: RuntimeState;
  healthy: boolean;
  holdsGpu: boolean;
  loadedModels: Array<{ name: string; vramMb: number }>;
  inflight: number;
  lastUsedAt?: number;
  idleStopMinutes: number;
  idleStopAt?: number;
  vramMb: number;
  etaSec: number;
  error?: string;
};

export type SwapLogEntry = {
  at: number;
  kind: string;
  runtimeId: string;
  from?: string;
  durationMs?: number;
  message: string;
};

export type LocalRuntimesStatus = {
  enabled: boolean;
  gpu: { name: string; totalMb: number; usedMb: number; freeMb: number } | null;
  runtimes: RuntimeStatus[];
  swap: SwapProgress | null;
  log: SwapLogEntry[];
};

export type LocalRuntimesState = {
  status: LocalRuntimesStatus | null;
  /** null = unknown yet; true = gateway predates localRuntimes.*. */
  unsupported: boolean | null;
  loading: boolean;
  error: string | null;
  /** Runtime id with a Start/Stop click in flight. */
  pending: string | null;
};

type RequestClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  supports?: (method: string) => boolean;
};

let client: RequestClient | null = null;
let state: LocalRuntimesState = {
  status: null,
  unsupported: null,
  loading: false,
  error: null,
  pending: null,
};
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let seq = 0;

function emit(): void {
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") return;
  window.dispatchEvent(new CustomEvent(LOCAL_RUNTIMES_WINDOW_EVENT, { detail: state }));
}

function set(patch: Partial<LocalRuntimesState>): void {
  state = { ...state, ...patch };
  emit();
  syncPoll();
}

/** While a swap runs, poll so VRAM + states stay live (events carry only progress). */
function syncPoll(): void {
  const swapping = !!state.status?.swap || state.pending !== null;
  if (swapping && !pollTimer && typeof setInterval !== "undefined") {
    pollTimer = setInterval(() => void refreshLocalRuntimes(), 3000);
  } else if (!swapping && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function getLocalRuntimesState(): LocalRuntimesState {
  return state;
}

export function onLocalRuntimes(fn: (s: LocalRuntimesState) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const h = (e: Event) => fn((e as CustomEvent<LocalRuntimesState>).detail ?? state);
  window.addEventListener(LOCAL_RUNTIMES_WINDOW_EVENT, h);
  return () => window.removeEventListener(LOCAL_RUNTIMES_WINDOW_EVENT, h);
}

/** Called on every gateway hello. */
export function attachLocalRuntimesClient(next: RequestClient | null): void {
  client = next;
  if (!next) return;
  if (typeof next.supports === "function" && !next.supports("localRuntimes.status")) {
    set({ unsupported: true, status: null });
    return;
  }
  void refreshLocalRuntimes();
}

export function normalizeStatus(raw: unknown): LocalRuntimesStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.runtimes)) return null;
  return {
    enabled: r.enabled !== false,
    gpu: (r.gpu as LocalRuntimesStatus["gpu"]) ?? null,
    runtimes: r.runtimes as RuntimeStatus[],
    swap: (r.swap as SwapProgress | null) ?? null,
    log: Array.isArray(r.log) ? (r.log as SwapLogEntry[]) : [],
  };
}

export async function refreshLocalRuntimes(): Promise<LocalRuntimesState> {
  if (!client) return state;
  const mine = ++seq;
  if (!state.status) set({ loading: true });
  try {
    const res = await client.request<unknown>("localRuntimes.status", {});
    if (mine !== seq) return state;
    set({ status: normalizeStatus(res), unsupported: false, loading: false, error: null });
  } catch (err) {
    if (mine !== seq) return state;
    const msg = err instanceof Error ? err.message : String(err);
    if (/unknown method|not found/i.test(msg)) set({ unsupported: true, loading: false });
    else set({ loading: false, error: msg });
  }
  return state;
}

function scheduleRefresh(ms = 500): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshLocalRuntimes();
  }, ms);
}

/** Route a gateway event; returns true when it was a runtime status event. */
export function handleLocalRuntimesEvent(event: string, payload: unknown): boolean {
  if (event !== LOCAL_RUNTIMES_EVENT) return false;
  const p = (payload ?? {}) as { swap?: SwapProgress | null };
  if (state.status) set({ status: { ...state.status, swap: p.swap ?? null } });
  scheduleRefresh(p.swap ? 1500 : 300);
  return true;
}

async function control(method: "localRuntimes.start" | "localRuntimes.stop", id: string): Promise<boolean> {
  if (!client) return false;
  set({ pending: id, error: null });
  try {
    await client.request(method, { id });
    await refreshLocalRuntimes();
    return true;
  } catch (err) {
    set({ error: err instanceof Error ? err.message : String(err) });
    return false;
  } finally {
    // Start returns at once; keep "pending" until the swap event clears it.
    setTimeout(() => {
      if (state.pending === id) set({ pending: null });
    }, 1500);
  }
}

export const startLocalRuntime = (id: string) => control("localRuntimes.start", id);
export const stopLocalRuntime = (id: string) => control("localRuntimes.stop", id);

/** Agent `notice` with kind `runtime_status` (the chat status line). */
export type RuntimeStatusNotice = {
  runId?: string;
  sessionKey?: string;
  runtimeId: string;
  label: string;
  phase: SwapPhase;
  message: string;
  etaSec: number;
  elapsedSec: number;
  fromLabel?: string;
  /** Client clock when received, minus elapsed — for a smooth local timer. */
  startedAtLocal: number;
};

export function parseRuntimeStatusNotice(payload: unknown, now = Date.now()): RuntimeStatusNotice | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { stream?: unknown; runId?: unknown; sessionKey?: unknown; data?: unknown };
  if (p.stream !== "notice" || !p.data || typeof p.data !== "object") return null;
  const d = p.data as Record<string, unknown>;
  if (d.kind !== "runtime_status" || typeof d.message !== "string") return null;
  const elapsedSec = typeof d.elapsedSec === "number" ? d.elapsedSec : 0;
  return {
    runId: typeof p.runId === "string" ? p.runId : undefined,
    sessionKey: typeof p.sessionKey === "string" ? p.sessionKey : undefined,
    runtimeId: String(d.runtimeId ?? ""),
    label: String(d.label ?? d.runtimeId ?? "local model"),
    phase: (d.phase as SwapPhase) ?? "starting",
    message: d.message,
    etaSec: typeof d.etaSec === "number" ? d.etaSec : 0,
    elapsedSec,
    ...(typeof d.fromLabel === "string" ? { fromLabel: d.fromLabel } : {}),
    startedAtLocal: now - elapsedSec * 1000,
  };
}

export function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export function resetLocalRuntimesForTests(): void {
  client = null;
  state = { status: null, unsupported: null, loading: false, error: null, pending: null };
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
