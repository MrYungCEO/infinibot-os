/**
 * Alerts Backlog controller — a persistent, restart-surviving list of the most
 * recent proactive alerts, surfaced through the EXISTING global notification
 * bell (see ui/src/ui/views/notifications.ts + components/notifications-panel.ts).
 *
 * This is NOT a parallel store: it is a thin client-side cache over the already
 * persisted Proactive Pop-Up System (SQLite `proactive_events` table via the
 * `proactive.list` / `proactive.ack` / `proactive.dismiss` RPCs and the
 * `proactive.event` / `proactive.updated` WS broadcasts). The overlay host
 * (proactive-overlay-host.ts) drives the *floating* surfaces; this module drives
 * the *backlog list* hanging off the bell so cleared/old alerts remain
 * reviewable and survive a gateway restart.
 */

import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway";
import type { PopupEvent } from "../components/proactive-popup-shared";

/** Cache of recent backlog events (dismissed ones filtered out), newest first. */
let events: PopupEvent[] = [];
let client: GatewayBrowserClient | null = null;
let unsub: (() => void) | null = null;
let loadedOnce = false;

/** Listeners (bell + panel) re-render when the backlog changes. */
const listeners = new Set<() => void>();

/** Optimistic tombstones so a click/clear feels instant before the server echo. */
const locallyAcked = new Set<string>();
const locallyDismissed = new Set<string>();

const BACKLOG_LIMIT = 60;

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* listener threw — keep the rest alive */
    }
  }
}

function mergeEvent(ev: PopupEvent): void {
  if (!ev?.id) return;
  if (locallyDismissed.has(ev.id) || ev.state === "dismissed") {
    events = events.filter((e) => e.id !== ev.id);
    return;
  }
  // Honour an in-flight optimistic ack until the server confirms a newer state.
  const merged =
    locallyAcked.has(ev.id) && ev.state === "pending"
      ? { ...ev, state: "acted" as const }
      : ev;
  const idx = events.findIndex((e) => e.id === ev.id);
  if (idx >= 0) events[idx] = merged;
  else events = [merged, ...events];
  events.sort((a, b) => b.createdAt - a.createdAt);
  if (events.length > BACKLOG_LIMIT) events = events.slice(0, BACKLOG_LIMIT);
}

function onFrame(frame: GatewayEventFrame): void {
  if (frame.event !== "proactive.event" && frame.event !== "proactive.updated") return;
  const ev = (frame.payload as { event?: PopupEvent })?.event;
  if (!ev?.id) return;
  mergeEvent(ev);
  notify();
}

/**
 * Bind the backlog to a live gateway client and register a change listener.
 * Idempotent per client; safe to call from every panel/bell mount.
 */
export function initAlertsBacklog(
  c: GatewayBrowserClient | null,
  onChange: () => void,
): () => void {
  listeners.add(onChange);
  if (c && c !== client) {
    client = c;
    unsub?.();
    unsub = client.subscribe(onFrame);
    void loadBacklog();
  } else if (c && !loadedOnce) {
    void loadBacklog();
  }
  return () => {
    listeners.delete(onChange);
  };
}

/** Load (or reload) the persisted backlog snapshot. */
export async function loadBacklog(): Promise<void> {
  if (!client) return;
  try {
    const res = (await client.request("proactive.list", {
      limit: BACKLOG_LIMIT,
    })) as { events?: PopupEvent[] };
    if (!Array.isArray(res?.events)) return;
    loadedOnce = true;
    events = res.events
      .filter((e) => e.state !== "dismissed" && !locallyDismissed.has(e.id))
      .map((e) =>
        locallyAcked.has(e.id) && e.state === "pending"
          ? { ...e, state: "acted" as const }
          : e,
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, BACKLOG_LIMIT);
    notify();
  } catch (e) {
    console.error("[alerts-backlog] load failed:", e);
  }
}

/** All backlog events, newest first (already dismissed-filtered). */
export function getBacklogEvents(): PopupEvent[] {
  return events;
}

/** Count of unread (still-pending) alerts — feeds the bell's unread badge. */
export function getUnackedCount(): number {
  return events.reduce((n, e) => (e.state === "pending" ? n + 1 : n), 0);
}

/** Mark a single alert read via the existing ack RPC (optimistic). */
export async function ackAlert(id: string): Promise<void> {
  if (!client) return;
  locallyAcked.add(id);
  const idx = events.findIndex((e) => e.id === id);
  if (idx >= 0) events[idx] = { ...events[idx], state: "acted" };
  notify();
  try {
    await client.request("proactive.ack", { id, action: "ack" });
  } catch (e) {
    console.error("[alerts-backlog] ack failed:", e);
  }
}

/** Clear the whole backlog — dismisses every currently-shown alert (optimistic). */
export async function clearAllAlerts(): Promise<void> {
  if (!client) return;
  const ids = events.map((e) => e.id);
  for (const id of ids) locallyDismissed.add(id);
  events = [];
  notify();
  await Promise.all(
    ids.map((id) =>
      client!
        .request("proactive.dismiss", { id, reason: "cleared from backlog" })
        .catch((e) => console.error("[alerts-backlog] dismiss failed:", e)),
    ),
  );
}
