/**
 * First-run getting-started checklist — state + detection.
 *
 * A brand-new install lands on a checklist (provider → first chat → channel →
 * voice → spawn an agent → learn) instead of the Business HQ dashboard. Once
 * the user finishes or dismisses it, the normal dashboard returns for good.
 *
 * "Is this a new install?" is decided ONCE per browser and persisted, from
 * gateway state: no user conversation sessions yet (cron / MCP / subagent /
 * heartbeat sessions don't count — a fresh gateway creates those on its own).
 * An existing install with real history is marked "established" and never
 * sees the checklist.
 */

import type { GatewayBrowserClient } from "../gateway";

export type FirstRunStatus = "active" | "dismissed" | "complete" | "established";
export type FirstRunItemId = "provider" | "chat" | "channel" | "voice" | "agent" | "learn";

export const FIRST_RUN_ITEMS: readonly FirstRunItemId[] = [
  "provider",
  "chat",
  "channel",
  "voice",
  "agent",
  "learn",
];

interface Persisted {
  status?: FirstRunStatus;
  /** Items the user ticked by hand (or that we saw complete once). */
  done?: FirstRunItemId[];
}

export const FIRST_RUN_STORAGE_KEY = "infinibot.firstRun.v1";

/** Session keys (after `agent:<id>:`) created by the system, not by a user. */
const SYSTEM_SESSION = /^(main$|mcp-|subagent:|claude-coder|codex|opencode|cron|heartbeat|voice$|hook|workflow|autonomy|oversight|goal)/;
/** Sessions whose key marks a spawned agent run. */
const AGENT_SESSION = /(^|:)(subagent:|claude-coder|codex-coder|opencode-coder)/;
/** Any install with this much history is established, whatever the keys say. */
const ESTABLISHED_SESSION_COUNT = 25;

function read(): Persisted {
  try {
    const raw = localStorage.getItem(FIRST_RUN_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Persisted) : {};
  } catch {
    return {};
  }
}

function write(p: Persisted): void {
  try {
    localStorage.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable — checklist just won't persist */
  }
}

function sessionRest(key: string): string {
  const parts = key.split(":");
  return parts[0] === "agent" && parts.length >= 3 ? parts.slice(2).join(":") : key;
}

/** Count sessions a person started (chat, channels, grid, docs…). Exported for tests. */
export function countUserSessions(keys: readonly string[]): number {
  return keys.filter((k) => !SYSTEM_SESSION.test(sessionRest(k))).length;
}

/** Decide first-run from gateway session keys. Exported for tests. */
export function classifyInstall(keys: readonly string[]): "new" | "established" {
  if (keys.length >= ESTABLISHED_SESSION_COUNT) return "established";
  return countUserSessions(keys) === 0 ? "new" : "established";
}

// ── Module state ──────────────────────────────────────────────────────────

let _status: FirstRunStatus | null = read().status ?? null;
let _evaluating = false;
let _evalFailedAt = 0;
let _checks: Partial<Record<FirstRunItemId, boolean>> = {};
let _checksAt = 0;
let _checking = false;

const CHECK_TTL_MS = 15_000;

export function getFirstRunStatus(): FirstRunStatus | null {
  return _status;
}

/** True when the dashboard should show the checklist instead of Business HQ. */
export function isFirstRunActive(): boolean {
  return _status === "active";
}

/**
 * Decide (once) whether this is a new install. Resolves immediately when the
 * decision is already stored. Failures leave it undecided — the normal
 * dashboard shows and we try again next load.
 */
export async function evaluateFirstRun(
  client: GatewayBrowserClient,
  onChange: () => void,
): Promise<void> {
  if (_status || _evaluating) return;
  if (_evalFailedAt && Date.now() - _evalFailedAt < 30_000) return;
  _evaluating = true;
  try {
    const res = (await client.request("sessions.list", { limit: 200 })) as {
      sessions?: Array<{ key?: string }>;
    };
    const keys = (res?.sessions ?? []).map((s) => String(s?.key ?? "")).filter(Boolean);
    _status = classifyInstall(keys) === "new" ? "active" : "established";
    write({ ...read(), status: _status });
    onChange();
  } catch {
    _evalFailedAt = Date.now(); // undecided — normal dashboard; retry later
    onChange();
  } finally {
    _evaluating = false;
  }
}

/** True while the one-time new-install check is in flight (first load only). */
export function isFirstRunEvaluating(): boolean {
  return _evaluating;
}

export function setFirstRunStatus(status: FirstRunStatus): void {
  _status = status;
  write({ ...read(), status });
}

/** Reopen the checklist later (e.g. from Learn). */
export function reopenFirstRun(): void {
  setFirstRunStatus("active");
}

export function markFirstRunItem(id: FirstRunItemId, done = true): void {
  const p = read();
  const set = new Set(p.done ?? []);
  if (done) set.add(id);
  else set.delete(id);
  write({ ...p, done: [...set] });
}

export function isFirstRunItemDone(id: FirstRunItemId): boolean {
  return (read().done ?? []).includes(id) || _checks[id] === true;
}

export function firstRunProgress(): { done: number; total: number } {
  const done = FIRST_RUN_ITEMS.filter((id) => isFirstRunItemDone(id)).length;
  return { done, total: FIRST_RUN_ITEMS.length };
}

const CHANNEL_KEYS_IGNORED = new Set(["webchat", "web", "defaults"]);
const NON_LLM_PROVIDERS = new Set(["telegram", "discord", "slack", "notion", "brave", "github", "gmail"]);

/**
 * Auto-detect which steps are already done from live gateway state. Cheap
 * RPCs only, each best-effort; results cached for CHECK_TTL_MS.
 */
export async function refreshFirstRunChecks(
  client: GatewayBrowserClient,
  onChange: () => void,
): Promise<void> {
  if (_checking || Date.now() - _checksAt < CHECK_TTL_MS) return;
  _checking = true;
  const next: Partial<Record<FirstRunItemId, boolean>> = {};
  const safe = async <T>(p: Promise<T>): Promise<T | null> => {
    try {
      return await p;
    } catch {
      return null;
    }
  };
  try {
    const [cfg, auth, sessions, voice, providers] = await Promise.all([
      safe(client.request("config.get", {}) as Promise<{ config?: Record<string, unknown> }>),
      safe(
        client.request("auth.profiles.list", {}) as Promise<{
          providers?: Array<{ provider?: string; profileCount?: number }>;
        }>,
      ),
      safe(client.request("sessions.list", { limit: 200 }) as Promise<{ sessions?: Array<{ key?: string }> }>),
      // Voice is "done" when local voice is ready (the default), or cloud voice (Robovoice) is linked.
      safe(client.request("robovoice.link.status", { remote: false }) as Promise<{ linked?: boolean; unlinkedAt?: string | null }>),
      safe(
        client.request("voice.providers.list", {}) as Promise<{
          backend?: string;
          providers?: Array<{ source?: string; status?: { ready?: boolean } }>;
        }>,
      ),
    ]);

    const config = (cfg?.config ?? {}) as {
      agents?: { defaults?: { model?: { primary?: unknown } | string } };
      channels?: Record<string, unknown>;
    };
    const modelField = config.agents?.defaults?.model;
    const primary =
      typeof modelField === "string" ? modelField : typeof modelField?.primary === "string" ? modelField.primary : "";
    const llmKey = (auth?.providers ?? []).some(
      (p) => (p.profileCount ?? 0) > 0 && p.provider && !NON_LLM_PROVIDERS.has(p.provider),
    );
    next.provider = llmKey || primary.startsWith("ollama/");

    const keys = (sessions?.sessions ?? []).map((s) => String(s?.key ?? ""));
    next.chat = countUserSessions(keys) > 0;
    next.agent = keys.some((k) => AGENT_SESSION.test(k));

    next.channel = Object.entries(config.channels ?? {}).some(
      ([k, v]) =>
        !CHANNEL_KEYS_IGNORED.has(k) &&
        v !== null &&
        typeof v === "object" &&
        (v as { enabled?: unknown }).enabled !== false,
    );
    const localReady = Boolean(
      providers?.backend !== "robovoice" && providers?.providers?.some((p) => p.source === "builtin" && p.status?.ready),
    );
    next.voice = localReady || Boolean(voice?.linked && !voice.unlinkedAt);

    _checks = next;
    _checksAt = Date.now();
    // Remember what we've seen complete so it stays ticked.
    for (const id of FIRST_RUN_ITEMS) if (next[id]) markFirstRunItem(id);
    onChange();
  } finally {
    _checking = false;
  }
}

/** Test hook. */
export function _resetFirstRunForTests(): void {
  _status = read().status ?? null;
  _evaluating = false;
  _evalFailedAt = 0;
  _checks = {};
  _checksAt = 0;
  _checking = false;
}
