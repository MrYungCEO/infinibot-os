/**
 * Server-side calendar event store.
 *
 * Caches events by source so the UI can render instantly on reload while a
 * background sync repopulates from upstream (Google, Calendly, ...).
 *
 * Per-source files:
 *   <CONFIG_DIR>/calendar/events-google.json
 *   <CONFIG_DIR>/calendar/events-calendly.json
 */

import fs from "node:fs/promises";
import path from "node:path";

import { CONFIG_DIR } from "../utils.js";

export type CalendarSource = "google" | "calendly";

export interface StoredCalendarEvent {
  /** Provider event id. Unique within (source, calendarId). */
  id: string;
  source: CalendarSource;
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  startIso?: string;
  endIso?: string;
  startDate?: string; // YYYY-MM-DD for all-day
  endDate?: string;
  status?: string;
  htmlLink?: string;
  /** Provider's last-modified timestamp (ms). Used for last-write-wins conflict resolution. */
  remoteUpdatedAtMs?: number;
  /** Local cache timestamp (ms). */
  cachedAtMs: number;
  /** When this event was deleted upstream (ms). Tombstone — keep briefly so deletes propagate. */
  deletedAtMs?: number;
}

interface StoreFile {
  version: 1;
  source: CalendarSource;
  events: StoredCalendarEvent[];
  lastSyncAtMs?: number;
}

const STORE_DIR = path.join(CONFIG_DIR, "calendar");

function pathFor(source: CalendarSource): string {
  return path.join(STORE_DIR, `events-${source}.json`);
}

const writeQueue = new Map<CalendarSource, Promise<void>>();

export async function loadEvents(source: CalendarSource): Promise<StoreFile> {
  try {
    const raw = await fs.readFile(pathFor(source), "utf-8");
    const parsed = JSON.parse(raw) as Partial<StoreFile>;
    return {
      version: 1,
      source,
      events: Array.isArray(parsed?.events) ? parsed!.events! : [],
      lastSyncAtMs: typeof parsed?.lastSyncAtMs === "number" ? parsed!.lastSyncAtMs : undefined,
    };
  } catch {
    return { version: 1, source, events: [] };
  }
}

export async function saveEvents(file: StoreFile): Promise<void> {
  const prev = writeQueue.get(file.source) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(async () => {
    await fs.mkdir(STORE_DIR, { recursive: true });
    const target = pathFor(file.source);
    const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
    await fs.writeFile(tmp, JSON.stringify(file, null, 2), "utf-8");
    await fs.rename(tmp, target);
  });
  writeQueue.set(file.source, next);
  await next;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
  skipped: number;
  deleted: number;
}

/**
 * Last-write-wins merge: incoming events with newer remoteUpdatedAtMs replace local.
 * Events not present in `incoming` keep their local copy unless `markMissingDeleted` is set.
 */
export async function mergeEvents(
  source: CalendarSource,
  incoming: StoredCalendarEvent[],
  opts?: { markMissingDeleted?: boolean; rangeStartIso?: string; rangeEndIso?: string },
): Promise<UpsertResult> {
  const file = await loadEvents(source);
  const byId = new Map(file.events.map((e) => [e.id, e]));
  const result: UpsertResult = { inserted: 0, updated: 0, skipped: 0, deleted: 0 };

  for (const next of incoming) {
    const prev = byId.get(next.id);
    if (!prev) {
      byId.set(next.id, next);
      result.inserted += 1;
      continue;
    }
    const prevTs = prev.remoteUpdatedAtMs ?? prev.cachedAtMs;
    const nextTs = next.remoteUpdatedAtMs ?? next.cachedAtMs;
    if (nextTs >= prevTs) {
      byId.set(next.id, { ...prev, ...next });
      result.updated += 1;
    } else {
      result.skipped += 1;
    }
  }

  if (opts?.markMissingDeleted && opts.rangeStartIso && opts.rangeEndIso) {
    const start = opts.rangeStartIso;
    const end = opts.rangeEndIso;
    const incomingIds = new Set(incoming.map((e) => e.id));
    for (const e of byId.values()) {
      if (e.deletedAtMs) continue;
      const evStart = e.startIso || e.startDate;
      if (!evStart) continue;
      if (evStart < start || evStart > end) continue;
      if (!incomingIds.has(e.id)) {
        e.deletedAtMs = Date.now();
        result.deleted += 1;
      }
    }
  }

  // Prune tombstones older than 7 days.
  const tombstoneCutoff = Date.now() - 7 * 86400_000;
  const merged = [...byId.values()].filter((e) => !e.deletedAtMs || e.deletedAtMs > tombstoneCutoff);

  await saveEvents({ version: 1, source, events: merged, lastSyncAtMs: Date.now() });
  return result;
}

/** List events from the store, optionally filtered to a time window. */
export async function listStoredEvents(opts?: {
  source?: CalendarSource;
  fromIso?: string;
  toIso?: string;
  includeDeleted?: boolean;
}): Promise<StoredCalendarEvent[]> {
  const sources: CalendarSource[] = opts?.source ? [opts.source] : ["google", "calendly"];
  const out: StoredCalendarEvent[] = [];
  for (const s of sources) {
    const file = await loadEvents(s);
    for (const e of file.events) {
      if (e.deletedAtMs && !opts?.includeDeleted) continue;
      const evStart = e.startIso || e.startDate || "";
      if (opts?.fromIso && evStart && evStart < opts.fromIso) continue;
      if (opts?.toIso && evStart && evStart > opts.toIso) continue;
      out.push(e);
    }
  }
  return out.sort((a, b) => (a.startIso || a.startDate || "").localeCompare(b.startIso || b.startDate || ""));
}

/** Delete a specific event (tombstone it). */
export async function deleteStoredEvent(source: CalendarSource, id: string): Promise<boolean> {
  const file = await loadEvents(source);
  const e = file.events.find((x) => x.id === id);
  if (!e) return false;
  e.deletedAtMs = Date.now();
  await saveEvents(file);
  return true;
}
