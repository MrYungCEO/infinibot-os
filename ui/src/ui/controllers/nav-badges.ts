/**
 * InfiniBar — per-tab live badge counts.
 *
 * Drives the small count chips next to nav rows (e.g. running agents beside
 * Activity / Agents). Design constraints from the rebuild brief:
 *
 *   • "Subscribe to the same WS streams the existing dashboard cards use —
 *      no new gateway polls."
 *
 * So this controller is event-driven, not a fixed polling loop:
 *   1. On init it seeds counts once via `subagents.list`.
 *   2. It subscribes to the gateway event stream (`client.subscribe`) and, on
 *      any `subagent.*` lifecycle event, schedules a single debounced re-seed.
 *      No setInterval — we only refetch when the stream says something changed.
 *
 * Counts are intentionally best-effort: if a request fails or the data isn't
 * available, the badge simply doesn't render (no fake numbers). New badge
 * sources (inbox unread, etc.) can be added by extending `seed()` + the event
 * filter — the render layer reads everything through `getNavBadge(tab)`.
 */

import type { Tab } from "../navigation";
import type { GatewayBrowserClient } from "../gateway";

interface NavBadgeState {
  runningAgents: number;
  /** Plugins: updates available + new plugins (plugins.catalog counts). */
  plugins: number;
}

const STATE: NavBadgeState = {
  runningAgents: 0,
  plugins: 0,
};

let _client: GatewayBrowserClient | null = null;
let _wsUnsub: (() => void) | null = null;
let _onChange: (() => void) | null = null;
let _seedTimer: ReturnType<typeof setTimeout> | null = null;
let _seeding = false;

const RUNNING_STATES = new Set([
  "running",
  "working",
  "starting",
  "active",
  "spawning",
]);

/** Map a tab id to its current badge count (0 = render no badge). */
export function getNavBadge(tab: Tab): number {
  switch (tab) {
    case "activity":
    case "agents":
    case "oversight":
      return STATE.runningAgents;
    case "plugins":
      return STATE.plugins;
    default:
      return 0;
  }
}

/**
 * Wire up the badge controller. Idempotent — calling again with the same client
 * is a no-op; a new client re-subscribes. `onChange` is the render hook (the
 * sidebar's requestUpdate) fired whenever a count changes.
 */
export function initNavBadges(
  client: GatewayBrowserClient | null,
  onChange: () => void,
): void {
  _onChange = onChange;
  if (!client) return;
  if (_client === client && _wsUnsub) return;

  // Re-bind to a fresh client (reconnect / first mount).
  _wsUnsub?.();
  _client = client;

  _wsUnsub = client.subscribe((evt) => {
    const name = evt.event ?? (evt as { type?: string }).type;
    if (typeof name === "string" && name.startsWith("subagent")) {
      scheduleSeed();
    }
    if (typeof name === "string" && (name.startsWith("plugins.") || name === "license.state.updated")) {
      void seedPlugins();
    }
  });

  // Initial seed.
  void seed();
  void seedPlugins();
}

export function disposeNavBadges(): void {
  _wsUnsub?.();
  _wsUnsub = null;
  _client = null;
  if (_seedTimer) {
    clearTimeout(_seedTimer);
    _seedTimer = null;
  }
}

function scheduleSeed(): void {
  if (_seedTimer) clearTimeout(_seedTimer);
  // Debounce bursts of subagent events (a fan-out spawns many at once) into a
  // single refetch.
  _seedTimer = setTimeout(() => {
    _seedTimer = null;
    void seed();
  }, 800);
}

async function seed(): Promise<void> {
  if (!_client || _seeding) return;
  _seeding = true;
  try {
    const res = (await _client.request("subagents.list", {})) as
      | { subagents?: Array<{ status?: string; state?: string }> }
      | { payload?: { subagents?: Array<{ status?: string; state?: string }> } }
      | undefined;
    // The RPC has returned `{subagents}` directly and (in some builds) wrapped
    // in `{payload:{subagents}}` — accept both.
    const list =
      (res as { subagents?: unknown })?.subagents ??
      (res as { payload?: { subagents?: unknown } })?.payload?.subagents ??
      [];
    const running = Array.isArray(list)
      ? list.filter((s) => {
          const status = String(
            (s as { status?: string; state?: string }).status ??
              (s as { state?: string }).state ??
              "",
          ).toLowerCase();
          return RUNNING_STATES.has(status);
        }).length
      : 0;
    if (running !== STATE.runningAgents) {
      STATE.runningAgents = running;
      _onChange?.();
    }
  } catch {
    // Best-effort: leave the last known count untouched on a transient failure.
  } finally {
    _seeding = false;
  }
}

/** Plugins badge: one plugins.catalog read on connect and on plugin events. */
async function seedPlugins(): Promise<void> {
  if (!_client) return;
  try {
    const res = (await _client.request("plugins.catalog", {})) as
      | { counts?: { updates?: number; new?: number } }
      | undefined;
    const next = (res?.counts?.updates ?? 0) + (res?.counts?.new ?? 0);
    if (next !== STATE.plugins) {
      STATE.plugins = next;
      _onChange?.();
    }
  } catch {
    // older gateway without plugins.catalog: no badge
  }
}
