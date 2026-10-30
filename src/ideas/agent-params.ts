/**
 * Agent-facing parameter helpers for dates and CRM clients, shared by the
 * ideas / notes / kanban tools so every tool reads them the same way.
 *
 *   resolveDateParam("2026-10-17" | "2026-10-17T15:00" | "next Friday at 3")
 *     → { date, time? } in the owner's timezone, or { error }
 *   resolveClientParam("c_123" | "Gengu")
 *     → { clientId, name } for an id or an unambiguous name, or { error } with
 *       candidates — never an id that isn't a real client
 */

import { loadConfig } from "../config/config.js";
import { matchClient, rankClients, type CaptureClient } from "./client-match.js";
import { loadCaptureClients } from "./client-source.js";
import { hostTimeZone, isHm, isIsoDate, isValidTimeZone, parseSpokenDate } from "./date-parse.js";
import { coerceString } from "../shared/text/coerce.js";

export function ownerTimeZone(): string {
  try {
    const tz = loadConfig().agents?.defaults?.userTimezone;
    if (isValidTimeZone(tz)) return tz;
  } catch {
    /* config unavailable */
  }
  return hostTimeZone();
}

export type DateParam = { date: string; time?: string } | { clear: true } | { error: string };

/** "" / "none" / "clear" clears; ISO date(-time) passes; anything else is parsed as words. */
export function resolveDateParam(
  raw: unknown,
  opts: { now?: Date; timeZone?: string } = {},
): DateParam | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = coerceString(raw).trim();
  if (!s || /^(none|clear|no date|null)$/i.test(s)) return { clear: true };
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  if (iso && isIsoDate(iso[1]) && (!iso[2] || isHm(iso[2])))
    return { date: iso[1], ...(iso[2] ? { time: iso[2] } : {}) };
  const hit = parseSpokenDate(s, {
    now: opts.now,
    timeZone: opts.timeZone ?? ownerTimeZone(),
    allowPast: true,
  });
  if (!hit)
    return {
      error: `could not read a date from "${s}" (use YYYY-MM-DD or words like "next Friday")`,
    };
  return { date: hit.date, ...(hit.time ? { time: hit.time } : {}) };
}

export type ClientParam =
  | { clientId: string; name: string }
  | { clear: true }
  | { error: string; candidates?: Array<{ id: string; name: string }> };

export async function resolveClientParam(
  raw: unknown,
  deps: { clients?: CaptureClient[] } = {},
): Promise<ClientParam | undefined> {
  if (raw === undefined || raw === null) return undefined;
  const s = coerceString(raw).trim();
  if (!s || /^(none|clear|null)$/i.test(s)) return { clear: true };
  const clients = deps.clients ?? (await loadCaptureClients()).clients;
  const byId = clients.find((c) => c.id === s);
  if (byId) return { clientId: byId.id, name: byId.name };
  const exact = clients.filter((c) => c.name.toLowerCase() === s.toLowerCase());
  if (exact.length === 1) return { clientId: exact[0].id, name: exact[0].name };
  const m = exact.length ? undefined : matchClient(s, clients);
  if (m && m.confidence >= 0.85) {
    const rivals = rankClients(s, clients).filter(
      (r) => r.client.id !== m.client.id && r.confidence >= m.confidence - 0.02,
    );
    if (!rivals.length) return { clientId: m.client.id, name: m.client.name };
  }
  const candidates = (exact.length ? exact : rankClients(s, clients).map((r) => r.client))
    .slice(0, 5)
    .map((c) => ({ id: c.id, name: c.name }));
  return {
    error: candidates.length
      ? `client "${s}" is ambiguous or not exact — pass one of the candidate ids`
      : `no CRM client matches "${s}"`,
    ...(candidates.length ? { candidates } : {}),
  };
}

/** "2026-10-17" or "2026-10-17T15:00" for stores that keep date + time together. */
export function whenString(d: { date: string; time?: string }): string {
  return d.time ? `${d.date}T${d.time}` : d.date;
}

/** Keep the client page / knowledge graph in line after a tool changed an item's client. */
export async function syncItemClient(
  kind: "idea" | "note" | "task" | "project",
  id: string,
  before: Array<string | null | undefined>,
  after: Array<string | null | undefined>,
  createdBy?: string,
): Promise<void> {
  try {
    const [{ defaultRelationWriter }, { defaultEntityLinker, syncClientLinks }] = await Promise.all(
      [import("./service.js"), import("./project-links.js")],
    );
    syncClientLinks(
      { kind, id, before, after, createdBy },
      {
        objrel: await defaultRelationWriter().catch(() => null),
        entity: await defaultEntityLinker().catch(() => null),
      },
    );
  } catch {
    /* indexes only */
  }
}
