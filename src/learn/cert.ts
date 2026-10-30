/**
 * Certification engine — mint an "InfiniBot AI Agent Systems Master"
 * certificate when the user completes every cert-required walkthrough
 * they have access to.
 *
 * Tiers:
 *   • **Apprentice** — finished every `tier: "beginner"` cert track
 *   • **Practitioner** — finished beginner + every `tier: "intermediate"`
 *   • **Master** — finished beginner + intermediate + every accessible
 *     `tier: "advanced"` cert track
 *
 * Non-admin users skip tracks marked `audience: "admin"`. They can still
 * earn Master if they complete every advanced track they're eligible for.
 *
 * Persistence: a small SQLite table (`certificates`) in the same
 * `learn.sqlite` file. We hash (userId + tier + awardedAt) so the
 * certificate SVG can include a verification fingerprint.
 */

import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { loadAllTracks, type Walkthrough, type UserProgress } from "./store.js";

// ── Types ─────────────────────────────────────────────────────

export type CertTier = "apprentice" | "practitioner" | "master";

export interface CertEligibility {
  tier: CertTier;
  /** Track ids the user still needs to complete to earn this tier. */
  missing: string[];
  /** Track ids already counted toward this tier. */
  earned: string[];
  /** Total accessible cert-required tracks at this tier. */
  total: number;
  /** Percent toward this tier. */
  percent: number;
  /** Already awarded (don't re-mint). */
  awarded: boolean;
}

export interface Certificate {
  id: string;
  userId: string;
  tier: CertTier;
  awardedAt: number;
  /** SHA-256 of `${id}:${userId}:${tier}:${awardedAt}` for verification. */
  hash: string;
  /** Snapshot of the user's display name at award time. */
  displayName: string;
}

// ── Schema ────────────────────────────────────────────────────

let _db: Database.Database | null = null;
let _dbStateDir: string | null = null;

function db(stateDir: string): Database.Database {
  if (_db && _dbStateDir === stateDir) return _db;
  const p = resolve(stateDir, "learn.sqlite");
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
  _db = new Database(p);
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS certificates (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      tier TEXT NOT NULL,
      awardedAt INTEGER NOT NULL,
      hash TEXT NOT NULL,
      displayName TEXT NOT NULL DEFAULT '',
      UNIQUE(userId, tier)
    );
    CREATE INDEX IF NOT EXISTS idx_cert_user ON certificates(userId);
  `);
  _dbStateDir = stateDir;
  return _db;
}

// ── Tier resolution ──────────────────────────────────────────

const TIER_ORDER: Record<CertTier, number> = { apprentice: 1, practitioner: 2, master: 3 };

/**
 * Pick which tracks count toward a given tier for a specific user.
 * Filters out admin-audience tracks for non-admin users so they aren't
 * permanently locked out of higher tiers.
 */
function tracksForTier(allTracks: Walkthrough[], tier: CertTier, isAdmin: boolean): Walkthrough[] {
  const rank = TIER_ORDER[tier];
  return allTracks.filter((t) => {
    if (!t.certRequired) return false;
    const trackRank = TIER_ORDER[(t.tier as CertTier) ?? "beginner"];
    if (trackRank > rank) return false;
    if (t.audience === "admin" && !isAdmin) return false;
    return true;
  });
}

/**
 * Compute eligibility for every tier given the user's progress.
 * Returns ordered apprentice → master so the UI can render a ladder.
 */
export function computeEligibility(params: {
  stateDir: string;
  userId: string;
  isAdmin: boolean;
  /** All progress records for the user. */
  progress: UserProgress[];
  /** Optional override (test harness). */
  tracks?: Walkthrough[];
}): CertEligibility[] {
  const tracks = params.tracks ?? loadAllTracks(params.stateDir);
  const completedTrackIds = new Set(
    params.progress.filter((p) => p.completedAt != null).map((p) => p.trackId),
  );
  const tiers: CertTier[] = ["apprentice", "practitioner", "master"];
  const awarded = listCertificates(params.stateDir, params.userId);
  const out: CertEligibility[] = [];
  for (const tier of tiers) {
    const required = tracksForTier(tracks, tier, params.isAdmin);
    const earned = required.filter((t) => completedTrackIds.has(t.id)).map((t) => t.id);
    const missing = required.filter((t) => !completedTrackIds.has(t.id)).map((t) => t.id);
    const total = required.length;
    const percent = total === 0 ? 100 : Math.round((earned.length / total) * 100);
    out.push({
      tier,
      missing,
      earned,
      total,
      percent,
      awarded: awarded.some((c) => c.tier === tier),
    });
  }
  return out;
}

// ── Mint + read ──────────────────────────────────────────────

/**
 * Award a certificate if the user is eligible and hasn't been awarded
 * yet. Returns the certificate (existing or new) or null when not yet
 * eligible.
 */
export function mintIfEligible(params: {
  stateDir: string;
  userId: string;
  displayName: string;
  isAdmin: boolean;
  progress: UserProgress[];
  tier: CertTier;
}): Certificate | null {
  const eligibility = computeEligibility({
    stateDir: params.stateDir,
    userId: params.userId,
    isAdmin: params.isAdmin,
    progress: params.progress,
  });
  const targetEligibility = eligibility.find((e) => e.tier === params.tier);
  if (!targetEligibility) return null;

  // Already awarded — return the existing record.
  const existing = getCertificate(params.stateDir, params.userId, params.tier);
  if (existing) return existing;

  // Not yet eligible.
  if (targetEligibility.missing.length > 0 || targetEligibility.total === 0) return null;

  return awardCertificate(params.stateDir, params.userId, params.tier, params.displayName);
}

/**
 * Insert a certificate (idempotent per user + tier) and return it. Callers
 * decide eligibility — the legacy track ladder above, or the guided Learn
 * ladder (src/learn/guided/status.ts).
 */
export function awardCertificate(
  stateDir: string,
  userId: string,
  tier: CertTier,
  displayName: string,
): Certificate | null {
  const existing = getCertificate(stateDir, userId, tier);
  if (existing) return existing;
  const id = `cert_${randomUUID()}`;
  const awardedAt = Date.now();
  const hash = createHash("sha256").update(`${id}:${userId}:${tier}:${awardedAt}`).digest("hex");
  db(stateDir)
    .prepare(
      "INSERT OR IGNORE INTO certificates (id, userId, tier, awardedAt, hash, displayName) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, userId, tier, awardedAt, hash, displayName);
  return getCertificate(stateDir, userId, tier);
}

export function getCertificate(
  stateDir: string,
  userId: string,
  tier: CertTier,
): Certificate | null {
  const row = db(stateDir)
    .prepare("SELECT * FROM certificates WHERE userId = ? AND tier = ?")
    .get(userId, tier) as Record<string, unknown> | undefined;
  return row ? rowToCert(row) : null;
}

export function listCertificates(stateDir: string, userId: string): Certificate[] {
  const rows = db(stateDir)
    .prepare("SELECT * FROM certificates WHERE userId = ? ORDER BY awardedAt DESC")
    .all(userId) as Array<Record<string, unknown>>;
  return rows.map(rowToCert);
}

export function listAllCertificates(stateDir: string): Certificate[] {
  const rows = db(stateDir)
    .prepare("SELECT * FROM certificates ORDER BY awardedAt DESC")
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToCert);
}

function rowToCert(row: Record<string, unknown>): Certificate {
  return {
    id: String(row.id),
    userId: String(row.userId),
    tier: String(row.tier) as CertTier,
    awardedAt: Number(row.awardedAt),
    hash: String(row.hash),
    displayName: String(row.displayName ?? ""),
  };
}

// ── SVG renderer ─────────────────────────────────────────────

const TIER_LABEL: Record<CertTier, string> = {
  apprentice: "Apprentice",
  practitioner: "Practitioner",
  master: "Master",
};

const TIER_LINE: Record<CertTier, string> = {
  apprentice: "InfiniBot Apprentice — foundation track",
  practitioner: "InfiniBot Practitioner — daily-driver track",
  master: "InfiniBot AI Agent Systems Master",
};

/**
 * Render the certificate as a self-contained SVG string. The dashboard
 * either inlines this directly or wraps it in `<a download>` so the user
 * can save the SVG. SVG converts cleanly to PDF on download.
 */
export function renderCertificateSvg(cert: Certificate): string {
  const tierLabel = TIER_LABEL[cert.tier];
  const headline = TIER_LINE[cert.tier];
  const dateStr = new Date(cert.awardedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const fingerprint =
    cert.hash
      .slice(0, 16)
      .match(/.{1,4}/g)
      ?.join(" ") ?? cert.hash.slice(0, 16);
  // Escape for XML.
  const safeName = (cert.displayName || "InfiniBot Operator").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] ?? c,
  );
  // Tier-specific accent so the cert looks visibly "leveled up" tier→tier.
  const accent =
    cert.tier === "master" ? "#fbbf24" : cert.tier === "practitioner" ? "#a78bfa" : "#6ee7b7";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 850" width="1200" height="850" font-family="ui-serif, Georgia, 'Times New Roman', serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0a0a0f"/>
      <stop offset="1" stop-color="#1a1a2e"/>
    </linearGradient>
    <linearGradient id="border" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.1"/>
      <stop offset="0.5" stop-color="${accent}" stop-opacity="1"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0.1"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="850" fill="url(#bg)"/>
  <rect x="40" y="40" width="1120" height="770" fill="none" stroke="${accent}" stroke-opacity="0.35" stroke-width="2"/>
  <rect x="56" y="56" width="1088" height="738" fill="none" stroke="url(#border)" stroke-width="3"/>

  <!-- Crest -->
  <g transform="translate(600, 170)">
    <circle r="60" fill="none" stroke="${accent}" stroke-width="2"/>
    <path d="M -38 0 L -10 28 L 38 -22" fill="none" stroke="${accent}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  </g>

  <!-- Tier ribbon -->
  <text x="600" y="270" text-anchor="middle" font-size="16" letter-spacing="6" fill="${accent}" font-family="ui-monospace, 'SF Mono', Menlo, monospace">CERTIFICATE OF ${tierLabel.toUpperCase()}</text>

  <!-- Headline -->
  <text x="600" y="340" text-anchor="middle" font-size="42" font-weight="700" fill="#f5f5f7">${headline}</text>

  <!-- Awarded text -->
  <text x="600" y="410" text-anchor="middle" font-size="18" fill="#9ca3af">This is to certify that</text>

  <!-- Recipient -->
  <text x="600" y="475" text-anchor="middle" font-size="50" font-style="italic" fill="${accent}">${safeName}</text>

  <!-- Body -->
  <text x="600" y="540" text-anchor="middle" font-size="17" fill="#d1d5db">has demonstrated proficiency across the InfiniBot agent systems,</text>
  <text x="600" y="565" text-anchor="middle" font-size="17" fill="#d1d5db">completing every required walkthrough at the ${tierLabel} tier.</text>

  <!-- Footer line -->
  <line x1="200" y1="680" x2="500" y2="680" stroke="${accent}" stroke-opacity="0.5"/>
  <line x1="700" y1="680" x2="1000" y2="680" stroke="${accent}" stroke-opacity="0.5"/>

  <text x="350" y="710" text-anchor="middle" font-size="14" fill="#9ca3af">Awarded on</text>
  <text x="350" y="730" text-anchor="middle" font-size="16" fill="#f5f5f7">${dateStr}</text>

  <text x="850" y="710" text-anchor="middle" font-size="14" fill="#9ca3af">Verification fingerprint</text>
  <text x="850" y="730" text-anchor="middle" font-size="13" fill="#f5f5f7" font-family="ui-monospace, monospace">${fingerprint}</text>

  <!-- Brand mark -->
  <text x="600" y="785" text-anchor="middle" font-size="11" letter-spacing="4" fill="#6b7280">INFINIBOT · AI AGENT CONTROL ROOM</text>
</svg>`;
}
