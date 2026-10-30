/**
 * In-memory ring buffer of incoming `/v1/chat/completions` requests.
 * Surfaced to the Glasses panel so the user can SEE their phone connecting
 * — the most reassuring feedback for "is it working" without trawling logs.
 *
 * Holds the last 25 events. Each entry has timestamp, source IP (from the
 * trusted-proxy resolver), masked agent id, and the user's prompt (first
 * 80 chars). No body content beyond the prompt is stored.
 */

const MAX_ENTRIES = 25;

export interface ActivityEntry {
  ts: number;
  source: string; // e.g. "192.168.1.142"
  agentId: string;
  userAgent?: string;
  prompt?: string; // first 80 chars
  ok: boolean;
  status?: number;
  durationMs?: number;
}

const buf: ActivityEntry[] = [];

export function recordActivity(entry: ActivityEntry): void {
  buf.unshift(entry);
  if (buf.length > MAX_ENTRIES) buf.length = MAX_ENTRIES;
}

export function listActivity(): ActivityEntry[] {
  return [...buf];
}

export function clearActivity(): void {
  buf.length = 0;
}
