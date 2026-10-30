/**
 * Landing-page analytics ingest + rollups.
 *
 * Public site `track.js` POSTs event batches to /api/pages/track. We persist
 * raw events per business per day, plus a small rolling KPI index per page
 * that the UI can render fast.
 *
 * Storage:
 *   <CONFIG_DIR>/landing-pages/analytics/<businessId>/<YYYY-MM-DD>.jsonl
 *   <CONFIG_DIR>/landing-pages/analytics/<businessId>/kpi.json
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { CONFIG_DIR } from "../utils.js";

const ROOT = path.join(CONFIG_DIR, "landing-pages", "analytics");

export interface TrackEventBatch {
  businessId: string;     // mirrors communityId / page owner
  pageId: string;
  pageSlug?: string;
  sessId: string;
  events: Array<{ name: string; props?: Record<string, unknown>; t?: number }>;
  ip?: string;
  userAgent?: string;
}

export interface PageKpi {
  pageId: string;
  views: number;
  uniqueSessions: number;
  formSubmits: number;
  ctaClicks: number;
  scroll25: number;
  scroll50: number;
  scroll75: number;
  scroll100: number;
  lastEventAtMs?: number;
}

export interface BusinessKpi {
  businessId: string;
  totals: {
    views: number;
    uniqueSessions: number;
    formSubmits: number;
    ctaClicks: number;
  };
  byPage: Record<string, PageKpi>;
  updatedAtMs: number;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function dirFor(businessId: string): string {
  const safe = businessId.replace(/[^a-zA-Z0-9_.-]/g, "_") || "default";
  return path.join(ROOT, safe);
}

async function loadKpi(businessId: string): Promise<BusinessKpi> {
  const p = path.join(dirFor(businessId), "kpi.json");
  try {
    const raw = await fs.readFile(p, "utf-8");
    return JSON.parse(raw) as BusinessKpi;
  } catch {
    return { businessId, totals: { views: 0, uniqueSessions: 0, formSubmits: 0, ctaClicks: 0 }, byPage: {}, updatedAtMs: 0 };
  }
}

async function saveKpi(k: BusinessKpi): Promise<void> {
  const dir = dirFor(k.businessId);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, "kpi.json");
  const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmp, JSON.stringify(k, null, 2), "utf-8");
  await fs.rename(tmp, target);
}

function ensurePageKpi(k: BusinessKpi, pageId: string): PageKpi {
  if (!k.byPage[pageId]) {
    k.byPage[pageId] = {
      pageId,
      views: 0, uniqueSessions: 0, formSubmits: 0, ctaClicks: 0,
      scroll25: 0, scroll50: 0, scroll75: 0, scroll100: 0,
    };
  }
  return k.byPage[pageId];
}

// Per-process session set so we can count "unique sessions" without scanning JSONLs.
const sessionsSeenPerPage = new Map<string, Set<string>>();

export async function ingestEventBatch(batch: TrackEventBatch): Promise<void> {
  if (!batch || !batch.businessId || !batch.pageId) return;
  // 1. Append raw events to today's JSONL.
  const dir = dirFor(batch.businessId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${dayKey(Date.now())}.jsonl`);
  const enriched = batch.events.map((e) => ({
    ...e,
    pageId: batch.pageId,
    pageSlug: batch.pageSlug,
    sessId: batch.sessId,
    t: e.t ?? Date.now(),
    ip: batch.ip,
    userAgent: batch.userAgent,
  }));
  await fs.appendFile(file, enriched.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

  // 2. Update rolling KPIs.
  const k = await loadKpi(batch.businessId);
  const pk = ensurePageKpi(k, batch.pageId);
  const sessKey = `${batch.pageId}:${batch.sessId}`;
  let sset = sessionsSeenPerPage.get(batch.pageId);
  if (!sset) { sset = new Set(); sessionsSeenPerPage.set(batch.pageId, sset); }
  if (!sset.has(sessKey)) {
    sset.add(sessKey);
    pk.uniqueSessions += 1;
    k.totals.uniqueSessions += 1;
  }
  for (const ev of batch.events) {
    pk.lastEventAtMs = Math.max(pk.lastEventAtMs ?? 0, ev.t ?? Date.now());
    switch (ev.name) {
      case "pageview":
        pk.views += 1; k.totals.views += 1; break;
      case "click":
        if (typeof ev.props?.id === "string" && (ev.props.id as string).includes("cta")) {
          pk.ctaClicks += 1; k.totals.ctaClicks += 1;
        }
        break;
      case "form_submit_ok":
        pk.formSubmits += 1; k.totals.formSubmits += 1; break;
      case "scroll_depth": {
        const d = Number((ev.props as Record<string, unknown> | undefined)?.depth);
        if (d === 25) pk.scroll25 += 1;
        else if (d === 50) pk.scroll50 += 1;
        else if (d === 75) pk.scroll75 += 1;
        else if (d === 100) pk.scroll100 += 1;
        break;
      }
    }
  }
  k.updatedAtMs = Date.now();
  await saveKpi(k);
}

export async function getBusinessKpi(businessId: string): Promise<BusinessKpi> {
  return loadKpi(businessId);
}

export async function getPageKpi(businessId: string, pageId: string): Promise<PageKpi | null> {
  const k = await loadKpi(businessId);
  return k.byPage[pageId] ?? null;
}
