/**
 * Shared per-session "active business filter" used by the Projects, Tasks,
 * Databases, CRM (Clients / Leads / Contacts / Companies / Deals) and any
 * future business-scoped surface. Single source of truth so picking a
 * business in one dropdown immediately scopes every other page that reads
 * from this module.
 *
 * Why module-level instead of AppViewState: the filter is purely a UI
 * concern and shouldn't appear in any controller's persisted shape. Keeping
 * it here also means each page can subscribe without wiring a new state
 * slot through the entire render tree.
 *
 * Persistence: localStorage so the choice survives reloads. Falls back
 * silently when storage is unavailable (private mode, SSR).
 */

import { isBusinessAgencyOn } from "../business-agency-gate.js";

const STORAGE_KEY = "infinibot:biz-filter:v1";

let current: string | null = readStored();
const subscribers = new Set<() => void>();

function readStored(): string | null {
  try {
    if (typeof window === "undefined") return null;
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

function writeStored(v: string | null): void {
  try {
    if (typeof window === "undefined") return;
    if (v) window.localStorage.setItem(STORAGE_KEY, v);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable — keep in-memory value only.
  }
}

/**
 * Currently active business id, or null = "All businesses". The filter is the
 * Business & Agency plugin's agency selection: while that plugin is off it
 * scopes nothing (the stored choice is kept for when it comes back on).
 */
export function getBizFilter(): string | null {
  return isBusinessAgencyOn() ? current : null;
}

/**
 * Update the active business filter. Pass null to clear the scope.
 * Notifies every subscriber so all open pages re-render with the new scope.
 */
export function setBizFilter(next: string | null): void {
  if (current === next) return;
  current = next;
  writeStored(next);
  for (const cb of subscribers) {
    try { cb(); } catch (e) { console.error("[biz-filter] subscriber threw", e); }
  }
}

/**
 * Subscribe to filter changes. Returns an unsubscribe fn. Use from a
 * controller's loader so it can re-fetch when the user picks a different
 * business in any other view.
 */
export function subscribeBizFilter(cb: () => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}
