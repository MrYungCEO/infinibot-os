/**
 * Calendar sync engine.
 *
 * Pulls events from configured sources (Calendly today; Google Calendar
 * is currently OAuth'd browser-side so the gateway doesn't pull it), merges
 * them into the local store using last-write-wins on remoteUpdatedAtMs.
 */

import { listScheduledEvents } from "./calendly.js";
import { mergeEvents, type StoredCalendarEvent } from "./store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("calendar-sync");

export interface SyncSummary {
  source: string;
  ok: boolean;
  inserted?: number;
  updated?: number;
  deleted?: number;
  error?: string;
  durationMs: number;
}

export async function syncCalendly(opts?: { fromMs?: number; toMs?: number }): Promise<SyncSummary> {
  const t0 = Date.now();
  const from = new Date(opts?.fromMs ?? Date.now() - 30 * 86400_000);
  const to = new Date(opts?.toMs ?? Date.now() + 90 * 86400_000);
  try {
    const items = await listScheduledEvents({ minTimeIso: from.toISOString(), maxTimeIso: to.toISOString() });
    const stored: StoredCalendarEvent[] = items.map((e) => ({
      id: e.id,
      source: "calendly",
      calendarId: "calendly",
      summary: e.name,
      status: e.status,
      startIso: e.startTimeIso,
      endIso: e.endTimeIso,
      location: e.location?.location || e.location?.join_url,
      htmlLink: e.htmlLink,
      remoteUpdatedAtMs: Date.now(),
      cachedAtMs: Date.now(),
    }));
    const r = await mergeEvents("calendly", stored, {
      markMissingDeleted: true,
      rangeStartIso: from.toISOString(),
      rangeEndIso: to.toISOString(),
    });
    log.info(`calendly sync: +${r.inserted} ~${r.updated} -${r.deleted} (skipped ${r.skipped})`);
    return { source: "calendly", ok: true, inserted: r.inserted, updated: r.updated, deleted: r.deleted, durationMs: Date.now() - t0 };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (!error.toLowerCase().includes("not connected")) log.warn(`calendly sync failed: ${error}`);
    return { source: "calendly", ok: false, error, durationMs: Date.now() - t0 };
  }
}

/**
 * Run all configured syncs. Returns per-source results.
 * Today only Calendly is server-side; Google Calendar is browser-driven and the
 * UI pushes updates into the store via `calendar.events.upsert`.
 */
export async function syncAll(): Promise<SyncSummary[]> {
  const results: SyncSummary[] = [];
  results.push(await syncCalendly());
  return results;
}

/**
 * Background loop. Returns a cancel function.
 */
export function startBackgroundSync(intervalMs: number = 5 * 60_000): () => void {
  let cancelled = false;
  void (async () => {
    while (!cancelled) {
      try { await syncAll(); } catch (e) { log.warn(`sync loop error: ${e}`); }
      const t = setTimeout(() => {}, intervalMs);
      await new Promise<void>((res) => { t.unref(); setTimeout(res, intervalMs); });
    }
  })();
  return () => { cancelled = true; };
}
