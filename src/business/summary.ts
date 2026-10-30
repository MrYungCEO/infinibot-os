/**
 * Per-business aggregator — pulls counts and recent state from every store
 * that's already keyed by business id (landing pages, lead-router,
 * analytics KPIs, branding) and gives the UI a single shot at rendering a
 * coherent command-center overview without N+1 round-trips.
 *
 * Sources NOT yet keyed by business id (kanban, calendar, files) return
 * `null` here so the UI can show a clear "not connected" tile rather than
 * silently zero. As those subsystems grow business-scope, this function is
 * the single place to fan in their counts.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { CONFIG_DIR } from "../utils.js";
import { getBusinessBranding, listBusinessBrandingSummaries } from "./branding.js";
import { getLandingPagesStore } from "../community/landing-pages.js";
import { getBusinessKpi } from "../landing-pages/analytics.js";
import { getBusinessLeadsIndex, listBusinessSubmissions } from "../landing-pages/lead-router.js";

export interface BusinessSummary {
  businessId: string;
  business: {
    id: string;
    name: string;
    tagline?: string | null;
    logo?: string | null;
    industry?: string | null;
  } | null;

  pages: {
    total: number;
    published: number;
    draft: number;
    archived: number;
    /** Light list for the UI: top 5 by updatedAt. */
    recent: Array<{ id: string; name: string; slug: string; status: string; updatedAt: string }>;
  };

  leads: {
    total: number;
    byPage: Record<string, number>;
    byForm: Record<string, number>;
    lastSubmittedAtMs?: number;
    /** Last 5 submissions for a quick peek. */
    recent: Array<{ id: string; pageId: string; formId: string; receivedAtMs: number; data: Record<string, unknown> }>;
  };

  kpi: {
    views: number;
    uniqueSessions: number;
    formSubmits: number;
    ctaClicks: number;
    /** Conversion = formSubmits / uniqueSessions, capped at 1. */
    conversion: number;
  };

  brand: {
    hasBranding: boolean;
    primaryColor?: string;
    accentColor?: string;
    fontHeading?: string;
    fontBody?: string;
    /** Count of brand assets (logo + extras + voice tokens) — content "weight". */
    assetCount: number;
  };

  /** Per-business asset directory under <CONFIG_DIR>/business/<id>/. */
  assets: {
    /** Total file count in the business's asset roots. */
    total: number;
    /** Total bytes across all asset files (best-effort). */
    bytes: number;
    /** Type breakdown by extension family. */
    byKind: { images: number; videos: number; audio: number; docs: number; other: number };
    /** Last 5 added (by mtime). */
    recent: Array<{ name: string; relPath: string; bytes: number; modifiedAtMs: number; kind: string }>;
    /** Where the count came from — useful for the UI to show the path. */
    rootPaths: string[];
  };

  /** Wire-up status for systems that don't yet scope by business id. */
  pending: {
    projects: { available: false; reason: string };
    schedule: { available: false; reason: string };
    databases: { available: false; reason: string };
  };
}

// ── Page status counts ──────────────────────────────────────

function summarisePages(businessId: string): BusinessSummary["pages"] {
  const store = getLandingPagesStore();
  let pages: Array<{ id: string; name: string; slug: string; status: string; updatedAt: string }>;
  try {
    pages = (store.listPages(businessId) || []) as typeof pages;
  } catch {
    pages = [];
  }
  const out: BusinessSummary["pages"] = {
    total: pages.length,
    published: 0,
    draft: 0,
    archived: 0,
    recent: [],
  };
  for (const p of pages) {
    if (p.status === "published") out.published += 1;
    else if (p.status === "archived") out.archived += 1;
    else out.draft += 1;
  }
  out.recent = [...pages]
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
    .slice(0, 5)
    .map((p) => ({ id: p.id, name: p.name, slug: p.slug, status: p.status, updatedAt: p.updatedAt }));
  return out;
}

// ── KPI ─────────────────────────────────────────────────────

async function summariseKpi(businessId: string): Promise<BusinessSummary["kpi"]> {
  const k = await getBusinessKpi(businessId);
  const t = k.totals;
  return {
    views: t.views,
    uniqueSessions: t.uniqueSessions,
    formSubmits: t.formSubmits,
    ctaClicks: t.ctaClicks,
    conversion: t.uniqueSessions > 0 ? Math.min(1, t.formSubmits / t.uniqueSessions) : 0,
  };
}

// ── Leads ───────────────────────────────────────────────────

async function summariseLeads(businessId: string): Promise<BusinessSummary["leads"]> {
  const idx = await getBusinessLeadsIndex(businessId);
  const recent = await listBusinessSubmissions(businessId, { limit: 5 });
  return {
    total: idx.total,
    byPage: idx.byPage,
    byForm: idx.byForm,
    lastSubmittedAtMs: idx.lastSubmittedAtMs,
    recent,
  };
}

// ── Brand ───────────────────────────────────────────────────

function summariseBrand(businessId: string): BusinessSummary["brand"] {
  const b = getBusinessBranding(businessId);
  if (!b) return { hasBranding: false, assetCount: 0 };
  const colors = b.branding?.colors ?? {};
  const fonts = b.branding?.fonts ?? {};
  const assets = b.branding?.assets ?? {};
  // Asset weight = primary identity + branded surfaces + custom assets + voice tokens.
  let assetCount = 0;
  if (b.logo) assetCount += 1;
  if (assets.coverImage) assetCount += 1;
  if (assets.favicon) assetCount += 1;
  if (assets.ogImage) assetCount += 1;
  if (b.branding?.voice?.tone) assetCount += 1;
  if (b.branding?.voice?.audience) assetCount += 1;
  return {
    hasBranding: true,
    primaryColor: colors.primary,
    accentColor: colors.accent,
    fontHeading: fonts.heading,
    fontBody: fonts.body,
    assetCount,
  };
}

// ── Assets ──────────────────────────────────────────────────

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".svg", ".heic"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);
const DOC_EXTS = new Set([".pdf", ".doc", ".docx", ".txt", ".md", ".rtf", ".csv", ".xlsx", ".xls", ".ppt", ".pptx"]);

function classifyExt(ext: string): "images" | "videos" | "audio" | "docs" | "other" {
  const e = ext.toLowerCase();
  if (IMAGE_EXTS.has(e)) return "images";
  if (VIDEO_EXTS.has(e)) return "videos";
  if (AUDIO_EXTS.has(e)) return "audio";
  if (DOC_EXTS.has(e)) return "docs";
  return "other";
}

async function* walkFiles(dir: string, base: string): AsyncGenerator<{ name: string; relPath: string; bytes: number; modifiedAtMs: number; ext: string }> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(abs, base);
    } else {
      try {
        const stat = await fs.stat(abs);
        const rel = path.relative(base, abs).split(path.sep).join("/");
        const ext = path.extname(entry.name);
        yield { name: entry.name, relPath: rel, bytes: stat.size, modifiedAtMs: stat.mtimeMs, ext };
      } catch {
        // skip unreadable
      }
    }
  }
}

async function summariseAssets(businessId: string): Promise<BusinessSummary["assets"]> {
  const safe = businessId.replace(/[^a-zA-Z0-9_.-]/g, "_") || "default";
  // Candidate roots — we walk whichever exist.
  const roots = [
    path.join(CONFIG_DIR, "business", safe),
    path.join(CONFIG_DIR, "businesses", safe),
    path.join(CONFIG_DIR, "landing-pages", "leads", safe), // submission JSONLs are content too
    path.join(CONFIG_DIR, "landing-pages", "analytics", safe),
  ];
  const out: BusinessSummary["assets"] = {
    total: 0,
    bytes: 0,
    byKind: { images: 0, videos: 0, audio: 0, docs: 0, other: 0 },
    recent: [],
    rootPaths: [],
  };
  const recent: BusinessSummary["assets"]["recent"] = [];
  for (const root of roots) {
    try {
      await fs.access(root);
    } catch {
      continue;
    }
    out.rootPaths.push(root);
    for await (const f of walkFiles(root, root)) {
      out.total += 1;
      out.bytes += f.bytes;
      const kind = classifyExt(f.ext);
      out.byKind[kind] += 1;
      recent.push({ name: f.name, relPath: f.relPath, bytes: f.bytes, modifiedAtMs: f.modifiedAtMs, kind });
    }
  }
  out.recent = recent.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs).slice(0, 5);
  return out;
}

// ── Public API ──────────────────────────────────────────────

export async function getBusinessSummary(businessId: string): Promise<BusinessSummary> {
  const profile = getBusinessBranding(businessId);
  const businessIdResolved = profile?.id || businessId;
  const [pages, kpi, leads, assets] = await Promise.all([
    Promise.resolve(summarisePages(businessIdResolved)),
    summariseKpi(businessIdResolved),
    summariseLeads(businessIdResolved),
    summariseAssets(businessIdResolved),
  ]);
  return {
    businessId: businessIdResolved,
    business: profile
      ? { id: profile.id, name: profile.name, tagline: profile.tagline, logo: profile.logo, industry: profile.industry }
      : null,
    pages,
    leads,
    kpi,
    brand: summariseBrand(businessIdResolved),
    assets,
    pending: {
      projects: { available: false, reason: "Kanban tasks aren't yet scoped by businessId. Add `businessId` to task schema or filter by an assignee/project tag." },
      schedule: { available: false, reason: "Calendar events aren't yet scoped by businessId. Add a businessId column on event creation to enable per-business filtering." },
      databases: { available: false, reason: "Notion DBs aren't yet enumerated per business. Wire `business.notionDatabaseId` + `crmDatabaseId` lookups when surfacing." },
    },
  };
}

/** Lightweight: list businesses with summary stub (id, name, logo). */
export function listBusinessesLight(): Array<{ id: string; name: string; tagline?: string | null; logo?: string | null }> {
  return listBusinessBrandingSummaries();
}
