/**
 * Content Studio posting store — the per-page video posting queue.
 *
 * Lives in the same per-tenant studio.db as the pipeline (schema step v2 in
 * pipeline-store.ts), so it survives restarts and is sized / exported /
 * cleared with the rest of the plugin data.
 *
 *   cs_post_config   one row per content page: the Droid Swarm device and the
 *                    platform account(s) bound on it, the schedule, the
 *                    caption template, approval + dry-run switches
 *   cs_post_queue    ordered queue entries (dense 0..n-1 positions per page)
 *   cs_post_history  append-only log of everything that happened
 *
 * Every status change goes through transition(), which enforces the queue
 * state machine (QUEUE_TRANSITIONS) so a stray RPC cannot, say, mark a
 * posted video as queued again.
 */

import crypto from "node:crypto";

import type Database from "better-sqlite3";

import { normalizeHashtags, DEFAULT_CAPTION_TEMPLATE } from "./posting-caption.js";
import { DEFAULT_SCHEDULE, normalizeSchedule, type PostingSchedule } from "./posting-schedule.js";
import { ContentStudioError } from "./pipeline-store.js";

export const POSTING_PLATFORMS = ["instagram", "tiktok"] as const;
export type PostingPlatform = (typeof POSTING_PLATFORMS)[number];

export type QueueStatus =
  | "queued"
  | "scheduled"
  | "awaiting_approval"
  | "posting"
  | "posted"
  | "failed"
  | "skipped"
  | "paused";

/** Allowed status changes. Anything else is refused with CONFLICT. */
export const QUEUE_TRANSITIONS: Record<QueueStatus, readonly QueueStatus[]> = {
  queued: ["scheduled", "paused", "skipped", "posting"],
  // scheduled → failed: refused before posting (account not verified on the phone).
  scheduled: ["queued", "awaiting_approval", "posting", "paused", "skipped", "failed"],
  awaiting_approval: ["posting", "failed", "queued", "paused", "skipped"],
  posting: ["posted", "failed", "scheduled"],
  posted: [],
  failed: ["queued", "skipped"],
  skipped: ["queued"],
  paused: ["queued", "skipped"],
};

/** Statuses the scheduler still has to act on, in queue order. */
export const ACTIVE_STATUSES: readonly QueueStatus[] = [
  "queued",
  "scheduled",
  "awaiting_approval",
  "posting",
];

/**
 * Whether the bound account was confirmed on the phone:
 *   verified    the latest on-phone detection lists this handle
 *   mismatch    the app is logged in, but not as (and not switchable to) it
 *   logged_out / challenge / app_missing / error  — the detection's health
 *   offline     the phone was not reachable at the last check
 *   unverified  never checked since this binding was made
 */
export type BindingVerification =
  | "unverified"
  | "verified"
  | "mismatch"
  | "logged_out"
  | "challenge"
  | "app_missing"
  | "error"
  | "offline";

const BINDING_VERIFICATIONS: readonly string[] = [
  "unverified",
  "verified",
  "mismatch",
  "logged_out",
  "challenge",
  "app_missing",
  "error",
  "offline",
];

export type PlatformBinding = {
  platform: PostingPlatform;
  /** Handle without "@". */
  handle: string;
  /** Droid Swarm (Android Ops) account row id, when the handle is registered. */
  accountId: string | null;
  verification: BindingVerification;
  /** When the phone was last checked for this binding. */
  verifiedAt: number | null;
  /** Human-readable reason for a non-verified state. */
  verificationNote: string | null;
};

export type PostingConfig = {
  pageId: string;
  enabled: boolean;
  deviceId: string | null;
  deviceLabel: string | null;
  bindings: PlatformBinding[];
  schedule: PostingSchedule;
  template: string;
  defaultHashtags: string[];
  cta: string;
  /** true = every post waits for an operator approval; false = auto-post. */
  requireApproval: boolean;
  /** true = run the whole device flow but stop before the final Share tap. */
  dryRun: boolean;
  updatedAt: number;
};

export type VerifyStatus = "verifying" | "verified" | "unverified";

/** What a verification run saw — kept on the entry as proof. */
export type VerifyEvidence = {
  /** "device" (profile on the phone) and/or "instagram_api" (Graph media list). */
  sources: string[];
  captionMatched: boolean;
  seenCaption: string | null;
  steps: string[];
  screenshots: string[];
  checkedAt: number;
};

export type QueueEntry = {
  id: string;
  pageId: string;
  platform: PostingPlatform;
  position: number;
  status: QueueStatus;
  mediaId: string | null;
  title: string;
  hook: string;
  series: string;
  episode: string;
  hashtags: string[];
  captionOverride: string | null;
  sourceKind: string | null;
  sourceId: string | null;
  scheduledAt: number | null;
  /**
   * Owner-chosen exact posting time. Wins over the page cadence (window,
   * grid, jitter); only the hard safety limits (min interval, daily cap) and
   * the phone's own readiness can delay it — always with a visible reason.
   */
  designatedAt: number | null;
  /** How late the post went out vs. its designated time (catch-up), ms. */
  lateByMs: number | null;
  /** Post-publish check: verifying → verified | unverified (null = not checked / dry run). */
  verifyStatus: VerifyStatus | null;
  verifyNote: string | null;
  verifiedAt: number | null;
  /** Next verification attempt while verifyStatus is "verifying". */
  verifyNextAt: number | null;
  verifyAttempts: number;
  /** Public link of the published reel/video (instagram.com/reel/…, tiktok.com/…). */
  permalink: string | null;
  verifyEvidence: VerifyEvidence | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  approvalId: string | null;
  postedAt: number | null;
  postUrl: string | null;
  postRef: string | null;
  dryRun: boolean | null;
  /**
   * Instagram only: share as a Trial reel (non-followers first). Always false
   * for other platforms. If the phone's Instagram has no Trial switch the
   * attempt fails "trial_unavailable" instead of posting a regular reel.
   */
  trialReel: boolean;
  createdAt: number;
  updatedAt: number;
};

/** lastError prefix of an attempt refused because the Trial switch was missing. */
export const TRIAL_UNAVAILABLE = "trial_unavailable";

export type HistoryEvent = {
  id: number;
  pageId: string;
  entryId: string | null;
  at: number;
  event: string;
  status: string | null;
  message: string;
  meta: Record<string, unknown>;
};

type ConfigRow = {
  page_id: string;
  enabled: number;
  device_id: string | null;
  device_label: string | null;
  bindings: string;
  schedule: string;
  template: string;
  default_hashtags: string;
  cta: string;
  require_approval: number;
  dry_run: number;
  updated_at: number;
};

type QueueRow = {
  id: string;
  page_id: string;
  platform: string;
  position: number;
  status: string;
  media_id: string | null;
  title: string;
  hook: string;
  series: string;
  episode: string;
  hashtags: string;
  caption_override: string | null;
  source_kind: string | null;
  source_id: string | null;
  scheduled_at: number | null;
  designated_at?: number | null;
  late_by_ms?: number | null;
  verify_status?: string | null;
  verify_note?: string | null;
  verified_at?: number | null;
  verify_next_at?: number | null;
  verify_attempts?: number | null;
  permalink?: string | null;
  verify_evidence?: string | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  approval_id: string | null;
  posted_at: number | null;
  post_url: string | null;
  post_ref: string | null;
  dry_run: number | null;
  trial_reel: number | null;
  created_at: number;
  updated_at: number;
};

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function normalizeHandle(v: unknown): string {
  return typeof v === "string"
    ? v
        .trim()
        .replace(/^@+/, "")
        .toLowerCase()
        .replace(/[^a-z0-9._]/g, "")
        .slice(0, 60)
    : "";
}

export function isPostingPlatform(v: unknown): v is PostingPlatform {
  return typeof v === "string" && (POSTING_PLATFORMS as readonly string[]).includes(v);
}

function cleanBindings(v: unknown): PlatformBinding[] {
  if (!Array.isArray(v)) return [];
  const out: PlatformBinding[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const platform = typeof r.platform === "string" ? r.platform.toLowerCase() : "";
    const handle = normalizeHandle(r.handle);
    if (!isPostingPlatform(platform) || !handle) continue;
    if (out.some((b) => b.platform === platform)) continue; // one account per platform
    out.push({
      platform,
      handle,
      accountId: typeof r.accountId === "string" && r.accountId ? r.accountId : null,
      verification:
        typeof r.verification === "string" && BINDING_VERIFICATIONS.includes(r.verification)
          ? (r.verification as BindingVerification)
          : "unverified",
      verifiedAt: typeof r.verifiedAt === "number" ? r.verifiedAt : null,
      verificationNote:
        typeof r.verificationNote === "string" ? r.verificationNote.slice(0, 400) : null,
    });
  }
  return out;
}

const str = (v: unknown, max = 500): string =>
  typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "";

const configOf = (r: ConfigRow): PostingConfig => {
  const dryRun = r.dry_run === 1;
  return {
    pageId: r.page_id,
    enabled: r.enabled === 1,
    deviceId: r.device_id,
    deviceLabel: r.device_label,
    bindings: cleanBindings(parseJson(r.bindings, [])),
    schedule: normalizeSchedule(parseJson(r.schedule, {}), DEFAULT_SCHEDULE, dryRun),
    template: r.template || DEFAULT_CAPTION_TEMPLATE,
    defaultHashtags: normalizeHashtags(parseJson(r.default_hashtags, [])),
    cta: r.cta,
    requireApproval: r.require_approval === 1,
    dryRun,
    updatedAt: r.updated_at,
  };
};

const entryOf = (r: QueueRow): QueueEntry => ({
  id: r.id,
  pageId: r.page_id,
  platform: (isPostingPlatform(r.platform) ? r.platform : "instagram") as PostingPlatform,
  position: r.position,
  status: r.status as QueueStatus,
  mediaId: r.media_id,
  title: r.title,
  hook: r.hook,
  series: r.series,
  episode: r.episode,
  hashtags: normalizeHashtags(parseJson(r.hashtags, [])),
  captionOverride: r.caption_override,
  sourceKind: r.source_kind,
  sourceId: r.source_id,
  scheduledAt: r.scheduled_at,
  designatedAt: r.designated_at ?? null,
  lateByMs: r.late_by_ms ?? null,
  verifyStatus:
    r.verify_status === "verifying" ||
    r.verify_status === "verified" ||
    r.verify_status === "unverified"
      ? r.verify_status
      : null,
  verifyNote: r.verify_note ?? null,
  verifiedAt: r.verified_at ?? null,
  verifyNextAt: r.verify_next_at ?? null,
  verifyAttempts: r.verify_attempts ?? 0,
  permalink: r.permalink ?? null,
  verifyEvidence: parseJson<VerifyEvidence | null>(r.verify_evidence, null),
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  lastError: r.last_error,
  approvalId: r.approval_id,
  postedAt: r.posted_at,
  postUrl: r.post_url,
  postRef: r.post_ref,
  dryRun: r.dry_run === null ? null : r.dry_run === 1,
  trialReel: r.platform === "instagram" && r.trial_reel === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * Columns for designated times + post verification. Added by a column check
 * (not a numbered schema step) so the step list can grow on other branches
 * without the two ever colliding on a user_version.
 */
const RUN_COLUMNS: Array<[string, string]> = [
  ["designated_at", "INTEGER"],
  ["late_by_ms", "INTEGER"],
  ["verify_status", "TEXT"],
  ["verify_note", "TEXT"],
  ["verified_at", "INTEGER"],
  ["verify_next_at", "INTEGER"],
  ["verify_attempts", "INTEGER NOT NULL DEFAULT 0"],
  ["permalink", "TEXT"],
  ["verify_evidence", "TEXT"],
];

export function ensurePostingRunColumns(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(cs_post_queue)").all() as Array<{ name: string }>;
  if (!cols.length) return; // table not created yet (pipeline schema owns it)
  const have = new Set(cols.map((c) => c.name));
  for (const [name, type] of RUN_COLUMNS) {
    if (!have.has(name)) db.exec(`ALTER TABLE cs_post_queue ADD COLUMN ${name} ${type}`);
  }
}

export class PostingStore {
  constructor(
    readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {
    ensurePostingRunColumns(db);
  }

  // ── Config ──────────────────────────────────────────────────────────────

  getConfig(pageId: string): PostingConfig {
    const row = this.db.prepare("SELECT * FROM cs_post_config WHERE page_id = ?").get(pageId) as
      | ConfigRow
      | undefined;
    if (row) return configOf(row);
    return {
      pageId,
      enabled: false,
      deviceId: null,
      deviceLabel: null,
      bindings: [],
      schedule: { ...DEFAULT_SCHEDULE },
      template: DEFAULT_CAPTION_TEMPLATE,
      defaultHashtags: [],
      cta: "",
      requireApproval: true,
      dryRun: true,
      updatedAt: 0,
    };
  }

  listConfigs(): PostingConfig[] {
    return (this.db.prepare("SELECT * FROM cs_post_config").all() as ConfigRow[]).map(configOf);
  }

  /**
   * Patch a page's config. Binding changes (device / accounts) always switch
   * auto-posting back off until the owner re-enables it, so a re-pointed
   * page never starts posting from a different account on its own.
   */
  updateConfig(
    pageId: string,
    patch: {
      enabled?: unknown;
      deviceId?: unknown;
      deviceLabel?: unknown;
      bindings?: unknown;
      schedule?: unknown;
      template?: unknown;
      defaultHashtags?: unknown;
      cta?: unknown;
      requireApproval?: unknown;
      dryRun?: unknown;
    },
  ): { config: PostingConfig; bindingChanged: boolean } {
    if (!pageId) throw new ContentStudioError("BAD_REQUEST", "pageId required");
    const cur = this.getConfig(pageId);
    const dryRun = typeof patch.dryRun === "boolean" ? patch.dryRun : cur.dryRun;
    const deviceId =
      patch.deviceId === null
        ? null
        : typeof patch.deviceId === "string"
          ? patch.deviceId.trim() || null
          : cur.deviceId;
    // Verification is the phone's word, never the caller's: a binding keeps
    // its last check only while device + platform + handle are unchanged.
    const bindings =
      patch.bindings !== undefined
        ? cleanBindings(patch.bindings).map((b) => {
            const same =
              deviceId === cur.deviceId &&
              cur.bindings.find((c) => c.platform === b.platform && c.handle === b.handle);
            return same
              ? {
                  ...b,
                  verification: same.verification,
                  verifiedAt: same.verifiedAt,
                  verificationNote: same.verificationNote,
                }
              : {
                  ...b,
                  verification: "unverified" as const,
                  verifiedAt: null,
                  verificationNote: null,
                };
          })
        : deviceId !== cur.deviceId
          ? cur.bindings.map((b) => ({
              ...b,
              verification: "unverified" as const,
              verifiedAt: null,
              verificationNote: null,
            }))
          : cur.bindings;
    const bindingChanged =
      deviceId !== cur.deviceId ||
      JSON.stringify(bindings.map((b) => [b.platform, b.handle])) !==
        JSON.stringify(cur.bindings.map((b) => [b.platform, b.handle]));
    let enabled = typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled;
    if (bindingChanged && patch.enabled === undefined) enabled = false;
    if (enabled && (!deviceId || bindings.length === 0)) {
      throw new ContentStudioError(
        "BAD_REQUEST",
        "bind a device and at least one account before enabling posting",
      );
    }
    const schedule =
      patch.schedule !== undefined || dryRun !== cur.dryRun
        ? normalizeSchedule(
            (patch.schedule ?? {}) as Partial<Record<keyof PostingSchedule, unknown>>,
            cur.schedule,
            dryRun,
          )
        : cur.schedule;
    const next: PostingConfig = {
      pageId,
      enabled,
      deviceId,
      deviceLabel:
        patch.deviceLabel !== undefined ? str(patch.deviceLabel, 120) || null : cur.deviceLabel,
      bindings,
      schedule,
      template: typeof patch.template === "string" ? patch.template.slice(0, 4000) : cur.template,
      defaultHashtags:
        patch.defaultHashtags !== undefined
          ? normalizeHashtags(patch.defaultHashtags)
          : cur.defaultHashtags,
      cta: typeof patch.cta === "string" ? patch.cta.slice(0, 500) : cur.cta,
      requireApproval:
        typeof patch.requireApproval === "boolean" ? patch.requireApproval : cur.requireApproval,
      dryRun,
      updatedAt: this.now(),
    };
    this.db
      .prepare(
        `INSERT INTO cs_post_config (page_id, enabled, device_id, device_label, bindings, schedule, template, default_hashtags, cta, require_approval, dry_run, updated_at)
         VALUES (@page_id, @enabled, @device_id, @device_label, @bindings, @schedule, @template, @default_hashtags, @cta, @require_approval, @dry_run, @updated_at)
         ON CONFLICT(page_id) DO UPDATE SET enabled=@enabled, device_id=@device_id, device_label=@device_label, bindings=@bindings,
           schedule=@schedule, template=@template, default_hashtags=@default_hashtags, cta=@cta,
           require_approval=@require_approval, dry_run=@dry_run, updated_at=@updated_at`,
      )
      .run({
        page_id: pageId,
        enabled: next.enabled ? 1 : 0,
        device_id: next.deviceId,
        device_label: next.deviceLabel,
        bindings: JSON.stringify(next.bindings),
        schedule: JSON.stringify(next.schedule),
        template: next.template,
        default_hashtags: JSON.stringify(next.defaultHashtags),
        cta: next.cta,
        require_approval: next.requireApproval ? 1 : 0,
        dry_run: next.dryRun ? 1 : 0,
        updated_at: next.updatedAt,
      });
    return { config: next, bindingChanged };
  }

  /**
   * Records an on-phone check for one binding (no-op when the page is no
   * longer bound to that handle). Does not touch updatedAt / enabled.
   */
  setBindingVerification(
    pageId: string,
    platform: string,
    handle: string,
    v: { verification: BindingVerification; note?: string | null; at?: number },
  ): PlatformBinding | null {
    const cur = this.getConfig(pageId);
    const idx = cur.bindings.findIndex((b) => b.platform === platform && b.handle === handle);
    if (idx < 0) return null;
    const next: PlatformBinding = {
      ...cur.bindings[idx]!,
      verification: v.verification,
      verifiedAt: v.at ?? this.now(),
      verificationNote: v.note ? v.note.slice(0, 400) : null,
    };
    const bindings = cur.bindings.map((b, i) => (i === idx ? next : b));
    this.db
      .prepare("UPDATE cs_post_config SET bindings = ? WHERE page_id = ?")
      .run(JSON.stringify(bindings), pageId);
    return next;
  }

  // ── Queue ───────────────────────────────────────────────────────────────

  listQueue(pageId: string, opts: { includeDone?: boolean } = {}): QueueEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM cs_post_queue WHERE page_id = ? ORDER BY position, created_at")
      .all(pageId) as QueueRow[];
    const all = rows.map(entryOf);
    return opts.includeDone === false
      ? all.filter((e) => e.status !== "posted" && e.status !== "skipped")
      : all;
  }

  getEntry(id: string): QueueEntry | null {
    const row = this.db.prepare("SELECT * FROM cs_post_queue WHERE id = ?").get(id) as
      | QueueRow
      | undefined;
    return row ? entryOf(row) : null;
  }

  requireEntry(id: unknown): QueueEntry {
    const e = typeof id === "string" ? this.getEntry(id) : null;
    if (!e) throw new ContentStudioError("NOT_FOUND", `queue entry not found: ${String(id)}`);
    return e;
  }

  /**
   * Entries created from an external source (e.g. sourceKind "flypic", one
   * entry per FlyPic queue item id) — the dedupe key for re-delivered items.
   */
  findBySource(sourceKind: string, sourceIds: readonly string[]): QueueEntry[] {
    const ids = [...new Set(sourceIds.filter((s) => typeof s === "string" && s))].slice(0, 500);
    if (!sourceKind || ids.length === 0) return [];
    return (
      this.db
        .prepare(
          `SELECT * FROM cs_post_queue WHERE source_kind = ? AND source_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at`,
        )
        .all(sourceKind, ...ids) as QueueRow[]
    ).map(entryOf);
  }

  /** Pages that have at least one entry the scheduler may need to act on. */
  pagesWithActiveEntries(): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT page_id FROM cs_post_queue WHERE status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})`,
        )
        .all(...ACTIVE_STATUSES) as Array<{ page_id: string }>
    ).map((r) => r.page_id);
  }

  enqueue(
    pageId: string,
    input: {
      platform?: unknown;
      mediaId?: unknown;
      title?: unknown;
      hook?: unknown;
      series?: unknown;
      episode?: unknown;
      hashtags?: unknown;
      captionOverride?: unknown;
      sourceKind?: unknown;
      sourceId?: unknown;
      index?: unknown;
      maxAttempts?: unknown;
      trialReel?: unknown;
    },
  ): QueueEntry {
    if (!pageId) throw new ContentStudioError("BAD_REQUEST", "pageId required");
    const platform =
      typeof input.platform === "string" ? input.platform.toLowerCase() : "instagram";
    if (!isPostingPlatform(platform)) {
      throw new ContentStudioError(
        "BAD_REQUEST",
        `platform must be one of ${POSTING_PLATFORMS.join(", ")}`,
      );
    }
    const mediaId = str(input.mediaId, 80) || null;
    if (!mediaId) throw new ContentStudioError("BAD_REQUEST", "mediaId (a video) required");
    const t = this.now();
    const id = `pq_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const count = (
      this.db.prepare("SELECT COUNT(*) AS n FROM cs_post_queue WHERE page_id = ?").get(pageId) as {
        n: number;
      }
    ).n;
    const maxAttempts = Math.min(5, Math.max(1, Math.round(Number(input.maxAttempts ?? 3)) || 3));
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO cs_post_queue (id, page_id, platform, position, status, media_id, title, hook, series, episode, hashtags,
             caption_override, source_kind, source_id, attempts, max_attempts, trial_reel, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        )
        .run(
          id,
          pageId,
          platform,
          count,
          mediaId,
          str(input.title, 200),
          str(input.hook, 500),
          str(input.series, 120),
          str(input.episode, 20),
          JSON.stringify(normalizeHashtags(input.hashtags)),
          typeof input.captionOverride === "string" && input.captionOverride.trim()
            ? input.captionOverride.slice(0, 2200)
            : null,
          str(input.sourceKind, 40) || null,
          str(input.sourceId, 80) || null,
          maxAttempts,
          platform === "instagram" && input.trialReel === true ? 1 : 0,
          t,
          t,
        );
      if (typeof input.index === "number") this.reorderInto(pageId, id, input.index);
    })();
    const entry = this.getEntry(id)!;
    this.log(
      pageId,
      id,
      "queued",
      "queued",
      `Queued "${entry.title || entry.mediaId}" for ${platform}${entry.trialReel ? " (trial reel)" : ""}`,
    );
    return entry;
  }

  /** Edits the per-video caption fields (not status). */
  updateEntry(
    id: unknown,
    patch: {
      title?: unknown;
      hook?: unknown;
      series?: unknown;
      episode?: unknown;
      hashtags?: unknown;
      captionOverride?: unknown;
      trialReel?: unknown;
    },
  ): QueueEntry {
    const e = this.requireEntry(id);
    if (e.status === "posting" || e.status === "posted") {
      throw new ContentStudioError("CONFLICT", `cannot edit a ${e.status} entry`);
    }
    const t = this.now();
    this.db
      .prepare(
        `UPDATE cs_post_queue SET title=?, hook=?, series=?, episode=?, hashtags=?, caption_override=?, trial_reel=?, updated_at=? WHERE id=?`,
      )
      .run(
        patch.title !== undefined ? str(patch.title, 200) : e.title,
        patch.hook !== undefined ? str(patch.hook, 500) : e.hook,
        patch.series !== undefined ? str(patch.series, 120) : e.series,
        patch.episode !== undefined ? str(patch.episode, 20) : e.episode,
        JSON.stringify(
          patch.hashtags !== undefined ? normalizeHashtags(patch.hashtags) : e.hashtags,
        ),
        patch.captionOverride === null
          ? null
          : typeof patch.captionOverride === "string"
            ? patch.captionOverride.trim()
              ? patch.captionOverride.slice(0, 2200)
              : null
            : e.captionOverride,
        e.platform === "instagram" &&
          (typeof patch.trialReel === "boolean" ? patch.trialReel : e.trialReel)
          ? 1
          : 0,
        t,
        e.id,
      );
    if (
      typeof patch.trialReel === "boolean" &&
      patch.trialReel !== e.trialReel &&
      e.platform === "instagram"
    ) {
      this.log(
        e.pageId,
        e.id,
        "trial_reel",
        null,
        patch.trialReel ? "Trial reel on (non-followers first)" : "Trial reel off (regular reel)",
      );
    }
    return this.getEntry(e.id)!;
  }

  private reorderInto(pageId: string, id: string, index: number): void {
    const ids = this.listQueue(pageId)
      .map((e) => e.id)
      .filter((x) => x !== id);
    const at = Math.max(0, Math.min(ids.length, Math.floor(index)));
    ids.splice(at, 0, id);
    this.writePositions(ids);
  }

  private writePositions(ids: string[]): void {
    const upd = this.db.prepare("UPDATE cs_post_queue SET position = ? WHERE id = ?");
    ids.forEach((qid, i) => upd.run(i, qid));
  }

  /**
   * Reorders a page's queue. `order` lists entry ids; ids not listed keep
   * their relative order after the listed ones. A scheduled head that is no
   * longer first drops back to queued so the slot is recomputed.
   */
  reorder(pageId: string, order: unknown): QueueEntry[] {
    if (!Array.isArray(order))
      throw new ContentStudioError("BAD_REQUEST", "order must be an array");
    const current = this.listQueue(pageId);
    const wanted = order.map(String).filter((id) => current.some((e) => e.id === id));
    const rest = current.map((e) => e.id).filter((id) => !wanted.includes(id));
    this.db.transaction(() => {
      this.writePositions([...wanted, ...rest]);
      this.resetScheduled(pageId, "queue reordered");
    })();
    this.log(pageId, null, "reordered", null, "Queue reordered");
    return this.listQueue(pageId);
  }

  move(id: unknown, toIndex: unknown): QueueEntry[] {
    const e = this.requireEntry(id);
    const n = Math.floor(Number(toIndex));
    if (!Number.isFinite(n)) throw new ContentStudioError("BAD_REQUEST", "toIndex required");
    this.db.transaction(() => {
      this.reorderInto(e.pageId, e.id, n);
      this.resetScheduled(e.pageId, "queue reordered");
    })();
    this.log(e.pageId, e.id, "reordered", null, `Moved to position ${n + 1}`);
    return this.listQueue(e.pageId);
  }

  /** Scheduled (not yet due) entries go back to queued so slots get recomputed. */
  resetScheduled(pageId: string, why: string): number {
    const res = this.db
      .prepare(
        "UPDATE cs_post_queue SET status='queued', scheduled_at=NULL, updated_at=? WHERE page_id=? AND status='scheduled' AND attempts=0",
      )
      .run(this.now(), pageId);
    if (res.changes > 0) this.log(pageId, null, "rescheduled", null, `Slots recomputed (${why})`);
    return res.changes;
  }

  remove(id: unknown): { removed: string } {
    const e = this.requireEntry(id);
    if (e.status === "posting") {
      throw new ContentStudioError("CONFLICT", "entry is posting right now; wait for it to finish");
    }
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM cs_post_queue WHERE id = ?").run(e.id);
      this.writePositions(this.listQueue(e.pageId).map((x) => x.id));
    })();
    this.log(e.pageId, e.id, "removed", null, `Removed "${e.title || e.mediaId}"`);
    return { removed: e.id };
  }

  /**
   * The single choke point for status changes. Throws CONFLICT on a
   * transition QUEUE_TRANSITIONS does not allow.
   */
  transition(
    id: unknown,
    to: QueueStatus,
    fields: Partial<{
      scheduledAt: number | null;
      attempts: number;
      lastError: string | null;
      approvalId: string | null;
      postedAt: number | null;
      postUrl: string | null;
      postRef: string | null;
      dryRun: boolean | null;
    }> = {},
    note?: { event?: string; message?: string; meta?: Record<string, unknown> },
  ): QueueEntry {
    const e = this.requireEntry(id);
    if (e.status !== to && !QUEUE_TRANSITIONS[e.status].includes(to)) {
      throw new ContentStudioError("CONFLICT", `cannot move a ${e.status} entry to ${to}`);
    }
    const has = (k: keyof typeof fields) => Object.prototype.hasOwnProperty.call(fields, k);
    this.db
      .prepare(
        `UPDATE cs_post_queue SET status=?, scheduled_at=?, attempts=?, last_error=?, approval_id=?, posted_at=?, post_url=?, post_ref=?, dry_run=?, updated_at=? WHERE id=?`,
      )
      .run(
        to,
        has("scheduledAt") ? fields.scheduledAt : e.scheduledAt,
        has("attempts") ? fields.attempts : e.attempts,
        has("lastError") ? fields.lastError : e.lastError,
        has("approvalId") ? fields.approvalId : e.approvalId,
        has("postedAt") ? fields.postedAt : e.postedAt,
        has("postUrl") ? fields.postUrl : e.postUrl,
        has("postRef") ? fields.postRef : e.postRef,
        has("dryRun")
          ? fields.dryRun === null
            ? null
            : fields.dryRun
              ? 1
              : 0
          : e.dryRun === null
            ? null
            : e.dryRun
              ? 1
              : 0,
        this.now(),
        e.id,
      );
    if (note?.message !== undefined || e.status !== to) {
      this.log(
        e.pageId,
        e.id,
        note?.event ?? to,
        to,
        note?.message ?? `${e.status} → ${to}`,
        note?.meta,
      );
    }
    return this.getEntry(e.id)!;
  }

  /**
   * Sets (or clears, with null) an entry's designated posting time. A
   * scheduled entry drops back to queued so the runner re-slots it.
   */
  setDesignatedAt(id: unknown, at: unknown): QueueEntry {
    const e = this.requireEntry(id);
    if (!["queued", "scheduled", "paused", "failed"].includes(e.status)) {
      throw new ContentStudioError("CONFLICT", `cannot set a time on a ${e.status} entry`);
    }
    const ms =
      at === null || at === ""
        ? null
        : typeof at === "number"
          ? at
          : typeof at === "string"
            ? Date.parse(at)
            : Number.NaN;
    if (ms !== null && !Number.isFinite(ms)) {
      throw new ContentStudioError(
        "BAD_REQUEST",
        "postAt must be an ISO time or epoch ms (null clears it)",
      );
    }
    const t = this.now();
    this.db
      .prepare(
        `UPDATE cs_post_queue SET designated_at=?, late_by_ms=NULL, status=CASE WHEN status='scheduled' THEN 'queued' ELSE status END,
           scheduled_at=CASE WHEN status='scheduled' THEN NULL ELSE scheduled_at END, updated_at=? WHERE id=?`,
      )
      .run(ms === null ? null : Math.round(ms), t, e.id);
    this.log(
      e.pageId,
      e.id,
      "designated",
      null,
      ms === null
        ? "Designated time cleared — follows the page schedule"
        : `Designated time set: ${new Date(ms).toISOString()}`,
      { designatedAt: ms },
    );
    return this.getEntry(e.id)!;
  }

  setLateBy(id: string, ms: number | null): void {
    this.db.prepare("UPDATE cs_post_queue SET late_by_ms=? WHERE id=?").run(ms, id);
  }

  /** Post-publish verification state (posted entries only). */
  setVerification(
    id: unknown,
    patch: {
      status: VerifyStatus | null;
      note?: string | null;
      verifiedAt?: number | null;
      nextAt?: number | null;
      attempts?: number;
      permalink?: string | null;
      evidence?: VerifyEvidence | null;
    },
    note?: { event: string; message: string; meta?: Record<string, unknown> },
  ): QueueEntry {
    const e = this.requireEntry(id);
    if (e.status !== "posted") {
      throw new ContentStudioError(
        "CONFLICT",
        `only posted entries are verified (entry is ${e.status})`,
      );
    }
    const has = (k: keyof typeof patch) => Object.prototype.hasOwnProperty.call(patch, k);
    this.db
      .prepare(
        `UPDATE cs_post_queue SET verify_status=?, verify_note=?, verified_at=?, verify_next_at=?, verify_attempts=?, permalink=?, verify_evidence=?, updated_at=? WHERE id=?`,
      )
      .run(
        patch.status,
        has("note") ? (patch.note ? patch.note.slice(0, 600) : null) : e.verifyNote,
        has("verifiedAt") ? patch.verifiedAt : e.verifiedAt,
        has("nextAt") ? patch.nextAt : e.verifyNextAt,
        has("attempts") ? patch.attempts : e.verifyAttempts,
        has("permalink") ? patch.permalink : e.permalink,
        has("evidence")
          ? patch.evidence
            ? JSON.stringify(patch.evidence)
            : null
          : e.verifyEvidence
            ? JSON.stringify(e.verifyEvidence)
            : null,
        this.now(),
        e.id,
      );
    if (note) this.log(e.pageId, e.id, note.event, "posted", note.message, note.meta);
    return this.getEntry(e.id)!;
  }

  /** Posted entries whose verification is due (oldest first). */
  verifyDue(now: number, limit = 5): QueueEntry[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM cs_post_queue WHERE status='posted' AND verify_status='verifying' AND COALESCE(verify_next_at, 0) <= ? ORDER BY COALESCE(verify_next_at, 0) LIMIT ?",
        )
        .all(now, limit) as QueueRow[]
    ).map(entryOf);
  }

  /**
   * Posted instants for a page+platform — the input to caps and spacing.
   * A live page counts only live posts; a dry-run page counts its rehearsals
   * too (so the schedule can be exercised end to end).
   */
  postedTimes(pageId: string, platform: string, sinceMs: number, includeDryRun = false): number[] {
    return (
      this.db
        .prepare(
          `SELECT posted_at FROM cs_post_queue WHERE page_id=? AND platform=? AND status='posted' AND posted_at >= ?${includeDryRun ? "" : " AND COALESCE(dry_run, 0) = 0"} ORDER BY posted_at`,
        )
        .all(pageId, platform, sinceMs) as Array<{ posted_at: number }>
    ).map((r) => r.posted_at);
  }

  // ── History ─────────────────────────────────────────────────────────────

  log(
    pageId: string,
    entryId: string | null,
    event: string,
    status: string | null,
    message: string,
    meta: Record<string, unknown> = {},
  ): void {
    this.db
      .prepare(
        "INSERT INTO cs_post_history (page_id, entry_id, at, event, status, message, meta) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        pageId,
        entryId,
        this.now(),
        event,
        status,
        message.slice(0, 1000),
        JSON.stringify(meta),
      );
  }

  history(pageId: string, limit = 100): HistoryEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM cs_post_history WHERE page_id = ? ORDER BY at DESC, id DESC LIMIT ?")
      .all(pageId, Math.min(500, Math.max(1, limit))) as Array<{
      id: number;
      page_id: string;
      entry_id: string | null;
      at: number;
      event: string;
      status: string | null;
      message: string;
      meta: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      pageId: r.page_id,
      entryId: r.entry_id,
      at: r.at,
      event: r.event,
      status: r.status,
      message: r.message,
      meta: parseJson(r.meta, {}),
    }));
  }
}
