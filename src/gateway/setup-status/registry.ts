/**
 * Setup-status evaluation: core checks (core-checks.ts) + checks plugins
 * register with `api.registerSetupCheck` (declared in the manifest's
 * `contributes.setupChecks`). Results are cached a few seconds per tenant
 * namespace, and recomputed (and pushed as a `setup.status` event when they
 * changed) shortly after any write RPC — so finishing a setup clears its
 * sidebar glow within ~1s without the UI polling.
 */

import { getScopedUserId, getCurrentUserId } from "../../config/paths.js";
import { isSaasMode } from "../../saas/config.js";
import type { PluginSetupCheckRegistration } from "../../plugins/registry.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import type {
  SetupCheckContext,
  SetupCheckDefinition,
  SetupCheckResult,
  SetupStatusSnapshot,
} from "./types.js";

export const SETUP_STATUS_EVENT = "setup.status";
/** How long a snapshot is served from cache. */
export const SETUP_STATUS_TTL_MS = 5_000;
/** Per-check budget; a slow check is skipped (never glows wrongly). */
const CHECK_TIMEOUT_MS = 1_500;
/** Debounce after a write RPC before recomputing. */
const REFRESH_DEBOUNCE_MS = 400;

let coreChecksProvider: () => SetupCheckDefinition[] = () => [];

/** core-checks.ts installs the core list (kept injectable for tests). */
export function setCoreSetupChecks(provider: () => SetupCheckDefinition[]): void {
  coreChecksProvider = provider;
}

/** Hosted multi-tenant (SaaS / InfiniBot Cloud) mode — or a tenant-scoped request. */
export function isCloudSetupMode(): boolean {
  return isSaasMode() || Boolean(getScopedUserId());
}

/** Plugin checks from loaded (enabled) plugins only. */
export function activePluginSetupChecks(): PluginSetupCheckRegistration[] {
  const registry = getActivePluginRegistry();
  const loaded = new Set(
    (registry?.plugins ?? [])
      .filter((p) => p.status === "loaded" && p.enabled !== false)
      .map((p) => p.id),
  );
  return (registry?.setupChecks ?? []).filter((c) => loaded.has(c.pluginId));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("setup check timed out")), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function runCheck(
  def: SetupCheckDefinition,
  source: string,
  ctx: SetupCheckContext,
): Promise<SetupCheckResult | null> {
  if (ctx.cloud && def.localOnly) return null;
  try {
    const out = await withTimeout(
      Promise.resolve().then(() => def.evaluate(ctx)),
      CHECK_TIMEOUT_MS,
    );
    if (!out || !["ready", "needs-setup", "optional", "error"].includes(out.state)) return null;
    const action = out.action ?? def.action;
    return {
      id: def.id,
      source,
      title: def.title,
      tabs: [...def.tabs],
      state: out.state,
      reason: out.state === "ready" ? "" : (out.reason ?? "").slice(0, 200),
      ...(action ? { action } : {}),
      ...(def.priority !== undefined ? { priority: def.priority } : {}),
    };
  } catch {
    return null;
  }
}

/** Evaluate every applicable check now (no cache). */
export async function evaluateSetupChecks(
  opts: {
    cloud?: boolean;
    core?: SetupCheckDefinition[];
    plugins?: PluginSetupCheckRegistration[];
  } = {},
): Promise<SetupStatusSnapshot> {
  const ctx: SetupCheckContext = { cloud: opts.cloud ?? isCloudSetupMode() };
  const core = opts.core ?? coreChecksProvider();
  const plugins = opts.plugins ?? activePluginSetupChecks();
  const results = await Promise.all([
    ...core.map((def) => runCheck(def, "core", ctx)),
    ...plugins.map((reg) => runCheck(reg.def, reg.pluginId, ctx)),
  ]);
  return {
    checks: results.filter((r): r is SetupCheckResult => r !== null),
    cloud: ctx.cloud,
    evaluatedAt: Date.now(),
  };
}

// ── cache + change push (per tenant namespace) ─────────────────────────────

type NsState = {
  snapshot: SetupStatusSnapshot | null;
  pending: Promise<SetupStatusSnapshot> | null;
  timer: ReturnType<typeof setTimeout> | null;
  lastSig: string | null;
};

const byNamespace = new Map<string, NsState>();

function nsKey(): string {
  return getScopedUserId() ?? `local:${getCurrentUserId()}`;
}

function nsState(): NsState {
  const key = nsKey();
  let st = byNamespace.get(key);
  if (!st) {
    st = { snapshot: null, pending: null, timer: null, lastSig: null };
    byNamespace.set(key, st);
  }
  return st;
}

export function setupStatusSignature(s: SetupStatusSnapshot): string {
  return JSON.stringify(s.checks.map((c) => [c.id, c.state, c.reason, c.tabs, c.action ?? null]));
}

/** Cached snapshot for the current namespace (recomputed after TTL / force). */
export async function getSetupStatus(opts: { force?: boolean } = {}): Promise<SetupStatusSnapshot> {
  const st = nsState();
  const fresh = st.snapshot && Date.now() - st.snapshot.evaluatedAt < SETUP_STATUS_TTL_MS;
  if (fresh && !opts.force) return st.snapshot!;
  if (st.pending) return st.pending;
  st.pending = evaluateSetupChecks()
    .then((snap) => {
      st.snapshot = snap;
      if (st.lastSig === null) st.lastSig = setupStatusSignature(snap);
      return snap;
    })
    .finally(() => {
      st.pending = null;
    });
  return st.pending;
}

/**
 * A write RPC finished (or something else changed): recompute shortly and
 * push `setup.status` to this namespace's clients if the answer changed.
 * Runs inside the caller's async scope, so the timer keeps its tenant.
 */
export function scheduleSetupStatusRefresh(
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void,
  delayMs = REFRESH_DEBOUNCE_MS,
): void {
  const st = nsState();
  if (st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(() => {
    st.timer = null;
    void getSetupStatus({ force: true })
      .then((snap) => {
        const sig = setupStatusSignature(snap);
        if (sig === st.lastSig) return;
        st.lastSig = sig;
        broadcast(SETUP_STATUS_EVENT, snap, { dropIfSlow: true });
      })
      .catch(() => {});
  }, delayMs);
  st.timer.unref?.();
}

/**
 * Methods that can't change a setup answer (chat traffic, UI state, polling)
 * — skipped so a busy chat doesn't trigger recomputes.
 */
const IGNORED_PREFIXES = [
  "chat.",
  "sessions.",
  "agent.",
  "setup.status",
  "logs.",
  "ui.",
  "presence",
  "system-presence",
  "canvas.",
  "kanban.",
  "notes.",
  "documents.",
];

export function isSetupRelevantWrite(method: string): boolean {
  if (method === "agent" || method === "send" || method === "wake") return false;
  return !IGNORED_PREFIXES.some((p) => method.startsWith(p));
}

export function resetSetupStatusForTests(): void {
  for (const st of byNamespace.values()) if (st.timer) clearTimeout(st.timer);
  byNamespace.clear();
  coreChecksProvider = () => [];
}
