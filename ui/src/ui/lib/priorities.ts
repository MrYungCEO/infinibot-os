/**
 * Business "Top Priorities" — per-business ordered list of project ids the
 * user has pinned to focus on. Max 5 entries; order is meaningful (#1 is
 * the most important).
 *
 * Persistence: lives on the BusinessProfile.priorities field on the
 * gateway. Mutations write through synchronously to the in-memory profile
 * (so the UI re-renders immediately) and fire an async gateway update.
 *
 * The previous implementation kept the list in localStorage only, which
 * looked like "not persistent across resets" any time the browser cache
 * was cleared. localStorage is now used only as a one-shot migration
 * source: on first load, if the gateway profile has no priorities but
 * localStorage does, the values get pushed up so users don't lose what
 * they pinned before the upgrade.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { BusinessState, BusinessProfile } from "../controllers/business";

const LEGACY_LS_KEY = "infinibot:business-priorities:v1";
export const MAX_PRIORITIES = 5;

function readLegacyStore(): Record<string, string[]> {
  try {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(LEGACY_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) {
        out[k] = v.filter((x): x is string => typeof x === "string").slice(0, MAX_PRIORITIES);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function clearLegacyEntry(businessId: string): void {
  try {
    if (typeof window === "undefined") return;
    const store = readLegacyStore();
    if (!(businessId in store)) return;
    delete store[businessId];
    if (Object.keys(store).length === 0) {
      window.localStorage.removeItem(LEGACY_LS_KEY);
    } else {
      window.localStorage.setItem(LEGACY_LS_KEY, JSON.stringify(store));
    }
  } catch { /* storage unavailable — best-effort */ }
}

function findProfile(bs: BusinessState | null | undefined, businessId: string): BusinessProfile | null {
  if (!bs) return null;
  return bs.businesses.find((b) => b.id === businessId) ?? null;
}

/**
 * Returns the current priority list for a business. Reads from the
 * profile on the BusinessState (already loaded by loadBusiness on app
 * start), so this stays synchronous and safe to call from a renderer.
 */
export function getPriorities(
  bs: BusinessState | null | undefined,
  businessId: string | null | undefined,
): string[] {
  if (!bs || !businessId) return [];
  const profile = findProfile(bs, businessId);
  return profile?.priorities?.slice(0, MAX_PRIORITIES) ?? [];
}

/**
 * Replace the priority list. Writes to the in-memory profile immediately
 * and fires the gateway update asynchronously. The async failure is
 * swallowed — the UI already re-rendered with the new list, and a
 * subsequent reload will surface a stale value but not crash. Returns
 * the cleaned list that was written.
 */
export function setPriorities(
  bs: BusinessState | null | undefined,
  client: GatewayBrowserClient | null | undefined,
  businessId: string | null | undefined,
  ids: string[],
): string[] {
  if (!bs || !businessId) return [];
  const profile = findProfile(bs, businessId);
  if (!profile) return [];
  const cleaned = Array.from(new Set(ids.filter((x) => typeof x === "string" && x.length > 0))).slice(0, MAX_PRIORITIES);
  profile.priorities = cleaned;
  if (client) {
    void client.request("business.priorities.set", {
      businessId,
      priorities: cleaned,
    }).catch((err: unknown) => {
      console.warn("[priorities] gateway set failed", err);
    });
  }
  return cleaned;
}

export function addPriority(
  bs: BusinessState | null | undefined,
  client: GatewayBrowserClient | null | undefined,
  businessId: string | null | undefined,
  projectId: string,
): boolean {
  if (!businessId || !projectId) return false;
  const current = getPriorities(bs, businessId);
  if (current.includes(projectId)) return false;
  if (current.length >= MAX_PRIORITIES) return false;
  setPriorities(bs, client, businessId, [...current, projectId]);
  return true;
}

export function removePriority(
  bs: BusinessState | null | undefined,
  client: GatewayBrowserClient | null | undefined,
  businessId: string | null | undefined,
  projectId: string,
): void {
  if (!businessId || !projectId) return;
  const current = getPriorities(bs, businessId);
  const next = current.filter((id) => id !== projectId);
  if (next.length === current.length) return;
  setPriorities(bs, client, businessId, next);
}

export function reorderPriority(
  bs: BusinessState | null | undefined,
  client: GatewayBrowserClient | null | undefined,
  businessId: string | null | undefined,
  fromIndex: number,
  toIndex: number,
): void {
  if (!businessId) return;
  const current = getPriorities(bs, businessId);
  if (
    fromIndex < 0 || fromIndex >= current.length ||
    toIndex < 0 || toIndex >= current.length ||
    fromIndex === toIndex
  ) return;
  const next = current.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  setPriorities(bs, client, businessId, next);
}

/**
 * One-shot migration: if a business's profile has no priorities but the
 * legacy localStorage bucket has entries for that business id, push them
 * up to the gateway and clear the local copy. Idempotent — safe to call
 * on every page load.
 */
export function migrateLegacyPriorities(
  bs: BusinessState | null | undefined,
  client: GatewayBrowserClient | null | undefined,
  businessId: string | null | undefined,
): void {
  if (!bs || !client || !businessId) return;
  const profile = findProfile(bs, businessId);
  if (!profile) return;
  if ((profile.priorities ?? []).length > 0) {
    // Already populated — drop any legacy bucket so we don't migrate twice.
    clearLegacyEntry(businessId);
    return;
  }
  const legacy = readLegacyStore()[businessId];
  if (!legacy || legacy.length === 0) return;
  setPriorities(bs, client, businessId, legacy);
  clearLegacyEntry(businessId);
}
