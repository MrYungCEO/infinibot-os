/**
 * Content Studio posting runner — the scheduler that drains each content
 * page's video queue through Droid Swarm.
 *
 * Runs as the plugin's own ticker (a `content-studio-posting` service, every
 * POSTING_TICK_MS) rather than core cron: the queue state lives in the plugin
 * store, the ticker stops when the plugin is disabled, and one tick is a few
 * SQLite reads when nothing is due.
 *
 * Per page, per tick (one post in flight per page, ever):
 *   1. awaiting_approval → approved: post · denied/expired: failed · pending: wait
 *   2. posting disabled or nothing bound → leave the queue alone
 *   3. head queued → compute its slot (posting-schedule.ts) → scheduled
 *   4. head scheduled and due → re-check min interval / daily cap / window
 *      → "require approval" pages file an approval (Telegram + inbox);
 *        auto-post pages hand off to Droid Swarm right away
 *
 * A publish result maps onto the queue state machine:
 *   posted / dry_run_complete   → posted (dry runs are flagged dryRun)
 *   busy / paced / offline      → scheduled again shortly, attempt not counted
 *   retryable failure           → scheduled at now + backoff (attempt counted)
 *   wrong_account / logged_out / blocked / non-retryable / out of attempts
 *                               → failed, and the owner is alerted; the first
 *                                 three also switch the page's auto-posting off
 *
 * Designated times: an entry with an owner-chosen `designatedAt` gets that
 * exact slot (no window / grid / jitter), independent of the cadence head —
 * it never waits behind the queue and a stuck head never blocks it. Only the
 * hard limits (min interval, daily cap) or the phone (offline / busy /
 * paced) can delay it, always with "delayed: <reason>" + the next attempt on
 * the entry. A time missed while the gateway was down is posted on catch-up
 * and flagged late. While auto-posting is off nothing posts, and every due
 * entry says so (the Upcoming list used to keep showing times regardless).
 *
 * Verification: a live post is marked verifying, then checked (Instagram
 * Graph media list when the page has it connected, else on the phone via
 * droid-swarm.publisher.verifyPost: newest reel, caption match, permalink
 * from the share sheet) → verified (+ permalink) | unverified (+ reason).
 * Transient phone states retry a few times; the owner can re-verify.
 *
 * Restart: an entry found in `posting` at startup may or may not have been
 * published, so it is marked failed ("interrupted") and never retried on its
 * own — re-posting the same video twice is worse than asking.
 */

import { CONTENT_STUDIO_PLUGIN_ID } from "./methods.js";
import { clampCaption, mergeHashtags, renderCaption } from "./posting-caption.js";
import {
  DroidUnavailableError,
  type DroidPublisher,
  type DroidPublishResult,
} from "./posting-droid.js";
import {
  LATE_GRACE_MS,
  designatedBlockReason,
  designatedSlot,
  nextSlot,
  postBlockReason,
  upcomingSlots,
  type PostingSchedule,
} from "./posting-schedule.js";
import {
  TRIAL_UNAVAILABLE,
  type PostingConfig,
  type PostingStore,
  type QueueEntry,
} from "./posting-store.js";
import { preflight, type PreflightResult } from "./posting-verify.js";
import type { ContentStudio } from "./studio.js";
import { captionKey, normalizeCaption } from "./posting-match.js";
import type { VerifyEvidence } from "./posting-store.js";

export const POSTING_TICK_MS = 15_000;
export const APPROVAL_TIMEOUT_MS = 6 * 3600_000;
/** Give the app a moment to process the upload before the first check. */
export const VERIFY_FIRST_DELAY_MS = 60_000;
/** Device / API checks before a post is reported unverified. */
export const VERIFY_MAX_ATTEMPTS = 4;
const VERIFY_BACKOFF_MS = [2 * 60_000, 5 * 60_000, 10 * 60_000];
/** lastError of a designated entry that came due while auto-posting was off. */
export const HELD_AUTO_OFF =
  "auto-posting is off for this page — nothing posts until it is switched on";
/** lastError of a designated entry that came due while no phone / account was bound. */
export const HELD_UNBOUND = "no phone / account is bound to this page — nothing posts";
const HELD_REASONS = new Set([HELD_AUTO_OFF, HELD_UNBOUND]);

/**
 * Why nothing on this page can auto-post right now, or null when it can.
 * Binding comes first: the Auto-posting switch cannot be turned on until a
 * phone + account are bound, so "turn auto-posting on" would be advice the
 * owner cannot follow.
 */
export function postingBlocker(
  cfg: Pick<PostingConfig, "enabled" | "deviceId" | "bindings">,
): { kind: "unbound" | "off"; text: string } | null {
  if (!cfg.deviceId || cfg.bindings.length === 0) {
    return {
      kind: "unbound",
      text: !cfg.deviceId
        ? "no phone is bound to this page — choose one under Phone & account"
        : "no account is bound to this page — pick the account under Phone & account and save the binding, then switch Auto-posting on",
    };
  }
  if (!cfg.enabled) {
    return {
      kind: "off",
      text: "auto-posting is off — switch it on to post at the scheduled times",
    };
  }
  return null;
}

/** One recent post of the account, as read from the platform's API. */
export type RecentMedia = { permalink: string; caption: string; timestamp: number };

type ApprovalRecordLike = {
  id: string;
  status: "pending" | "approved" | "denied" | "redirected";
  decidedBy?: string | null;
  note?: string | null;
  reason?: string | null;
};

export type PostingHost = {
  approvals?: {
    create(input: {
      source: "tool-gate";
      requester?: { agentId?: string | null; sessionKey?: string | null; label?: string | null };
      title: string;
      summary?: string;
      details?: string;
      risk?: "low" | "medium" | "high" | "critical";
      options?: Array<"approve" | "deny">;
      sourceRef?: Record<string, string>;
      timeoutMs?: number;
      resumable?: boolean;
    }): ApprovalRecordLike;
    get(id: string): ApprovalRecordLike | null;
  } | null;
  alertOwner?:
    | ((alert: {
        title: string;
        body: string;
        severity?: "warning" | "critical";
        link?: string;
      }) => unknown)
    | null;
  runLLM?:
    | ((opts: {
        systemPrompt: string;
        userPrompt: string;
        maxTokens?: number;
        temperature?: number;
      }) => Promise<{ text: string }>)
    | null;
  log?: { info: (m: string) => void; warn: (m: string) => void };
};

export type PageInfo = { id: string; name: string; handle?: string | null };

export type RunnerDeps = {
  studio: ContentStudio;
  posting: PostingStore;
  droid: DroidPublisher;
  host: PostingHost;
  /** Resolves a content page (null = page gone → its queue is ignored). */
  page: (pageId: string) => PageInfo | null;
  /**
   * Recent posts of the page's account via the platform API (Instagram Graph
   * when the page has it connected); null = no API source for this page.
   */
  recentMedia?: (pageId: string, platform: string) => Promise<RecentMedia[] | null>;
  now?: () => number;
};

/** What the scheduler will do with an entry next, for the queue UI + agents. */
export type NextRun = {
  at: number | null;
  /** ok = on track · wait = delayed (phone/limits) · late = catch-up · held = will not post until fixed */
  tone: "ok" | "wait" | "late" | "held";
  reason: string;
};

export type PostAttemptReport = {
  entryId: string;
  status: string;
  reason: string | null;
};

/** "Tue, Oct 6, 20:54" in the page's timezone, for history lines the owner reads. */
function localTime(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

const REASON_TEXT: Record<string, string> = {
  "next-open": "next open slot",
  "min-interval": "after the minimum interval",
  "window-open": "when the posting window opens",
  "daily-cap": "daily cap reached, next day",
  designated: "at its designated time",
  "catch-up": "missed its designated time — catching up now",
  grid: "next slot in the daily spread",
  fallback: "fallback",
};

/** "1h 05m" / "12m" / "40s". */
export function fmtLate(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

function backoffMs(attempt: number, dryRun: boolean): number {
  const base = dryRun ? 30_000 : 5 * 60_000;
  return base * 2 ** Math.max(0, attempt - 1);
}

export class PostingRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly inflight = new Set<string>();
  private readonly now: () => number;

  constructor(readonly deps: RunnerDeps) {
    this.now = deps.now ?? Date.now;
  }

  get posting(): PostingStore {
    return this.deps.posting;
  }

  start(intervalMs = POSTING_TICK_MS): void {
    if (this.timer) return;
    this.recoverAfterRestart();
    this.timer = setInterval(() => {
      void this.tick().catch((err) =>
        this.deps.host.log?.warn(`posting tick failed: ${String(err)}`),
      );
    }, intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Called after every config change. When the page goes from held (off or
   * unbound) to able to post, held entries are released — their "held"
   * note is cleared and logged — and a tick runs right away, so the queue
   * moves without waiting for the next interval (or a restart).
   */
  onConfigChanged(pageId: string, before: PostingConfig, after: PostingConfig): number {
    if (postingBlocker(after) || !postingBlocker(before)) return 0;
    let released = 0;
    for (const e of this.deps.posting.listQueue(pageId)) {
      if (e.status !== "queued" && e.status !== "scheduled") continue;
      released++;
      if (e.lastError && HELD_REASONS.has(e.lastError)) {
        this.deps.posting.transition(e.id, e.status, { lastError: null });
      }
    }
    if (released) {
      this.deps.posting.log(
        pageId,
        null,
        "released",
        null,
        `Auto-posting on — ${released} held ${released === 1 ? "entry" : "entries"} released to the schedule`,
        { released },
      );
    }
    void this.tick().catch((err) =>
      this.deps.host.log?.warn(`posting tick (config change) failed: ${String(err)}`),
    );
    return released;
  }

  /** Entries left in `posting` by a crash/restart: fail them, never auto-retry. */
  recoverAfterRestart(): number {
    let n = 0;
    for (const pageId of this.deps.posting.pagesWithActiveEntries()) {
      for (const e of this.deps.posting.listQueue(pageId)) {
        if (e.status !== "posting" || this.inflight.has(e.id)) continue;
        this.deps.posting.transition(
          e.id,
          "failed",
          {
            lastError:
              "interrupted by a gateway restart while posting — check the phone, then retry",
          },
          {
            event: "interrupted",
            message: "Interrupted mid-post by a restart; not retried automatically",
          },
        );
        n++;
      }
    }
    return n;
  }

  // ── Context helpers ─────────────────────────────────────────────────────

  private times(cfg: PostingConfig, platform: string) {
    const since = this.now() - 3 * 86_400_000;
    const postedAts = this.deps.posting.postedTimes(cfg.pageId, platform, since, cfg.dryRun);
    return { postedAts, lastPostAt: postedAts.length ? postedAts[postedAts.length - 1]! : null };
  }

  /** The caption a queue entry will post with (override wins). */
  captionFor(cfg: PostingConfig, entry: QueueEntry, at = this.now()) {
    const page = this.deps.page(cfg.pageId);
    const binding = cfg.bindings.find((b) => b.platform === entry.platform);
    if (entry.captionOverride) {
      const r = renderCaption(entry.captionOverride, {}, entry.platform);
      return {
        ...r,
        text: clampCaption(entry.captionOverride, entry.platform),
        source: "override" as const,
      };
    }
    const r = renderCaption(
      cfg.template,
      {
        title: entry.title,
        hook: entry.hook,
        hashtags: mergeHashtags(cfg.defaultHashtags, entry.hashtags),
        cta: cfg.cta,
        series: entry.series,
        episode: entry.episode,
        date: at,
        timezone: cfg.schedule.timezone,
        page: page?.name ?? "",
        handle: binding?.handle ?? "",
      },
      entry.platform,
    );
    return { ...r, text: clampCaption(r.text, entry.platform), source: "template" as const };
  }

  /**
   * Upcoming schedule preview: the next `limit` pending entries with slots.
   * `held` says why none of it will fire (auto-posting off / nothing bound)
   * — the times are what WOULD happen once that is fixed.
   */
  preview(pageId: string, limit = 10) {
    const cfg = this.deps.posting.getConfig(pageId);
    const pending = this.deps.posting
      .listQueue(pageId)
      .filter(
        (e) =>
          e.status === "queued" || e.status === "scheduled" || e.status === "awaiting_approval",
      );
    const out: Array<{
      entryId: string;
      title: string;
      platform: string;
      at: number;
      reason: string;
    }> = [];
    const now = this.now();
    const byPlatform = new Map<string, QueueEntry[]>();
    for (const e of pending.slice(0, limit)) {
      byPlatform.set(e.platform, [...(byPlatform.get(e.platform) ?? []), e]);
    }
    for (const [platform, list] of byPlatform) {
      const { postedAts, lastPostAt } = this.times(cfg, platform);
      // Designated entries keep their own time and never shift the cadence.
      for (const e of list.filter((x) => x.designatedAt !== null)) {
        const at =
          e.status !== "queued" && e.scheduledAt
            ? e.scheduledAt
            : designatedSlot({
                schedule: cfg.schedule,
                dryRun: cfg.dryRun,
                now,
                lastPostAt,
                postedAts,
                designatedAt: e.designatedAt!,
              }).at;
        out.push({ entryId: e.id, title: e.title, platform, at, reason: "designated" });
      }
      // A head already holding a slot keeps it; the rest are projected after it.
      let startNow = now;
      let last = lastPostAt;
      const posted = [...postedAts];
      const rest: QueueEntry[] = [];
      for (const e of list.filter((x) => x.designatedAt === null)) {
        if (
          (e.status === "scheduled" || e.status === "awaiting_approval") &&
          e.scheduledAt &&
          rest.length === 0
        ) {
          out.push({
            entryId: e.id,
            title: e.title,
            platform,
            at: e.scheduledAt,
            reason: e.status,
          });
          last = e.scheduledAt;
          posted.push(e.scheduledAt);
          startNow = Math.max(startNow, e.scheduledAt);
        } else rest.push(e);
      }
      for (const s of upcomingSlots(
        {
          schedule: cfg.schedule,
          dryRun: cfg.dryRun,
          now: startNow,
          lastPostAt: last,
          postedAts: posted,
        },
        rest.map((e) => e.id),
      )) {
        const e = rest.find((x) => x.id === s.seed)!;
        out.push({ entryId: e.id, title: e.title, platform, at: s.at, reason: s.reason });
      }
    }
    out.sort((a, b) => a.at - b.at);
    const blocker = postingBlocker(cfg);
    const held = !blocker
      ? null
      : blocker.kind === "off"
        ? "Auto-posting is off — none of these times will fire until you switch it on."
        : !cfg.deviceId
          ? "No phone is bound — nothing will post. Choose one under Phone & account."
          : "No account is bound — nothing will post, and Auto-posting can't be switched on until you pick the account under Phone & account and save the binding.";
    return { next: out[0] ?? null, upcoming: out, held };
  }

  // ── Tick ────────────────────────────────────────────────────────────────

  async tick(): Promise<PostAttemptReport[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const reports: PostAttemptReport[] = [];
    try {
      for (const pageId of this.deps.posting.pagesWithActiveEntries()) {
        try {
          const r = await this.tickPage(pageId);
          if (r) reports.push(r);
        } catch (err) {
          this.deps.host.log?.warn(`posting: page ${pageId}: ${String(err)}`);
        }
      }
      for (const e of this.deps.posting.verifyDue(this.now(), 2)) {
        try {
          await this.verifyEntry(e.id);
        } catch (err) {
          this.deps.host.log?.warn(`posting: verify ${e.id}: ${String(err)}`);
        }
      }
    } finally {
      this.ticking = false;
    }
    return reports;
  }

  async tickPage(pageId: string): Promise<PostAttemptReport | null> {
    if (!this.deps.page(pageId)) return null;
    const { posting } = this.deps;
    const cfg = posting.getConfig(pageId);
    const entries = posting.listQueue(pageId);
    if (entries.some((e) => e.status === "posting")) return null;

    // 1. Approvals in flight.
    const waiting = entries.find((e) => e.status === "awaiting_approval");
    if (waiting) return this.checkApproval(cfg, waiting);

    if (!cfg.enabled || !cfg.deviceId || cfg.bindings.length === 0) {
      this.markHeld(cfg, entries);
      return null;
    }

    const now = this.now();
    // 2. Slots. Designated entries hold their own time; the cadence head
    // (first entry without one) gets the page schedule's next slot.
    for (const e of entries) {
      if (e.designatedAt === null) continue;
      if (e.status !== "queued" && !(e.status === "scheduled" && e.scheduledAt === null)) continue;
      if (!this.bindingFor(cfg, e)) continue;
      this.slotDesignated(cfg, e, now);
    }
    const cadenceHead = entries.find(
      (e) => (e.status === "queued" || e.status === "scheduled") && e.designatedAt === null,
    );
    if (cadenceHead && (cadenceHead.status === "queued" || cadenceHead.scheduledAt === null)) {
      if (!this.bindingFor(cfg, cadenceHead)) {
        posting.transition(cadenceHead.id, "failed", {
          lastError: `no ${cadenceHead.platform} account is bound to this page`,
        });
        return {
          entryId: cadenceHead.id,
          status: "failed",
          reason: `no ${cadenceHead.platform} binding`,
        };
      }
      const { postedAts, lastPostAt } = this.times(cfg, cadenceHead.platform);
      const slot = nextSlot({
        schedule: cfg.schedule,
        dryRun: cfg.dryRun,
        now,
        lastPostAt,
        postedAts,
        seed: cadenceHead.id,
      });
      posting.transition(
        cadenceHead.id,
        "scheduled",
        { scheduledAt: slot.at, lastError: null },
        {
          event: "scheduled",
          message: `Scheduled for ${localTime(slot.at, cfg.schedule.timezone)} — ${REASON_TEXT[slot.reason] ?? slot.reason}`,
        },
      );
    }

    // 3. Due: the earliest scheduled entry whose time has come (a failed or
    // backed-off entry never blocks one that is due).
    const head = posting
      .listQueue(pageId)
      .filter((e) => e.status === "scheduled" && e.scheduledAt !== null && e.scheduledAt <= now)
      .sort((a, b) => a.scheduledAt! - b.scheduledAt! || a.position - b.position)[0];
    if (!head) return null;
    const binding = this.bindingFor(cfg, head);
    if (!binding) {
      posting.transition(head.id, "failed", {
        lastError: `no ${head.platform} account is bound to this page`,
      });
      return { entryId: head.id, status: "failed", reason: `no ${head.platform} binding` };
    }
    const { postedAts, lastPostAt } = this.times(cfg, head.platform);

    // Re-check the hard limits right before posting.
    const designated = head.designatedAt !== null;
    const limits = { schedule: cfg.schedule, dryRun: cfg.dryRun, now, lastPostAt, postedAts };
    const block = designated ? designatedBlockReason(limits) : postBlockReason(limits);
    if (block) {
      const slot = designated
        ? designatedSlot({ ...limits, designatedAt: head.designatedAt! })
        : nextSlot({ ...limits, seed: head.id });
      posting.transition(
        head.id,
        "scheduled",
        { scheduledAt: slot.at, lastError: designated ? `delayed: ${block}` : head.lastError },
        {
          event: "deferred",
          message: `${designated ? "Delayed" : "Deferred"} (${block}) to ${localTime(slot.at, cfg.schedule.timezone)}`,
        },
      );
      return null;
    }

    if (cfg.requireApproval) {
      // Don't ask the owner to approve a post the phone can't make.
      const pf = await this.preflight(cfg, head.platform);
      if (!pf.ok) return this.refuse(cfg, head, pf);
      return this.requestApproval(cfg, head);
    }
    return this.execute(cfg, head, "auto-post");
  }

  private bindingFor(cfg: PostingConfig, e: QueueEntry) {
    return cfg.bindings.find((b) => b.platform === e.platform) ?? null;
  }

  /** Gives a designated entry its slot (exact time, or catch-up / pushed by a hard limit). */
  private slotDesignated(cfg: PostingConfig, e: QueueEntry, now: number): void {
    const { postedAts, lastPostAt } = this.times(cfg, e.platform);
    const slot = designatedSlot({
      schedule: cfg.schedule,
      dryRun: cfg.dryRun,
      now,
      lastPostAt,
      postedAts,
      designatedAt: e.designatedAt!,
    });
    const tz = cfg.schedule.timezone;
    const late = slot.reason === "catch-up";
    const pushed = slot.reason !== "designated" && slot.reason !== "catch-up";
    this.deps.posting.transition(
      e.id,
      "scheduled",
      {
        scheduledAt: slot.at,
        lastError: pushed
          ? `delayed: ${slot.reason === "daily-cap" ? "daily cap reached" : "minimum interval after the last post"}`
          : e.lastError && HELD_REASONS.has(e.lastError)
            ? null
            : e.lastError,
      },
      {
        event: late ? "late" : pushed ? "deferred" : "scheduled",
        message: late
          ? `Missed its designated time ${localTime(e.designatedAt!, tz)} by ${fmtLate(slot.lateByMs)} — posting now (catch-up)`
          : pushed
            ? `Designated ${localTime(e.designatedAt!, tz)}, delayed to ${localTime(slot.at, tz)} — ${REASON_TEXT[slot.reason] ?? slot.reason}`
            : `Scheduled for its designated time ${localTime(slot.at, tz)}`,
      },
    );
  }

  /**
   * Auto-posting off / nothing bound: nothing may post, but a designated
   * entry that comes due says so (once) instead of silently sitting there.
   */
  private markHeld(cfg: PostingConfig, entries: QueueEntry[]): void {
    const now = this.now();
    const why = postingBlocker(cfg)?.kind === "unbound" ? HELD_UNBOUND : HELD_AUTO_OFF;
    for (const e of entries) {
      if (e.status !== "queued" && e.status !== "scheduled") continue;
      const due = e.designatedAt ?? (e.status === "scheduled" ? e.scheduledAt : null);
      if (due === null || due > now || e.lastError === why) continue;
      this.deps.posting.transition(
        e.id,
        e.status,
        { lastError: why },
        {
          event: "held",
          message: `Due ${localTime(due, cfg.schedule.timezone)} but not posted: ${why}. It posts (marked late) once that is fixed.`,
        },
      );
    }
  }

  /** What happens to an entry next — shown per item in the queue and to agents. */
  nextRun(entry: QueueEntry, projected?: number | null): NextRun | null {
    const cfg = this.deps.posting.getConfig(entry.pageId);
    const now = this.now();
    const tz = cfg.schedule.timezone;
    const approval = cfg.requireApproval ? " · then waits for your approval" : "";
    const delayed = (e: QueueEntry) =>
      e.lastError && !HELD_REASONS.has(e.lastError)
        ? e.lastError.replace(/^delayed:\s*/i, "")
        : null;
    switch (entry.status) {
      case "posted":
      case "skipped":
      case "failed":
      case "paused":
        return null;
      case "posting":
        return {
          at: null,
          tone: "ok",
          reason: `posting now on ${cfg.deviceLabel ?? cfg.deviceId ?? "the phone"}`,
        };
      case "awaiting_approval":
        return {
          at: entry.scheduledAt,
          tone: entry.lastError ? "wait" : "held",
          reason: entry.lastError
            ? `approved, delayed: ${entry.lastError}`
            : "waiting for your approval",
        };
      default:
        break;
    }
    const blocker = postingBlocker(cfg);
    if (blocker) {
      const missed = entry.designatedAt !== null && entry.designatedAt <= now;
      return {
        at: null,
        tone: "held",
        reason: missed
          ? `missed ${localTime(entry.designatedAt!, tz)} — ${blocker.text} (it posts late once fixed)`
          : blocker.text,
      };
    }
    if (!this.bindingFor(cfg, entry)) {
      return {
        at: null,
        tone: "held",
        reason: `bind a phone and a ${entry.platform} account first`,
      };
    }
    const at = entry.status === "scheduled" ? entry.scheduledAt : (projected ?? entry.designatedAt);
    const why = delayed(entry);
    if (why) return { at, tone: "wait", reason: `delayed: ${why}${approval}` };
    if (entry.designatedAt !== null) {
      const late = (at ?? now) - entry.designatedAt;
      if (late > LATE_GRACE_MS) {
        return {
          at,
          tone: "late",
          reason: `late by ${fmtLate(late)} (designated ${localTime(entry.designatedAt, tz)}) — catching up${approval}`,
        };
      }
      return { at, tone: "ok", reason: `at its designated time${approval}` };
    }
    if (at !== null && at < now - LATE_GRACE_MS) {
      return {
        at,
        tone: "late",
        reason: `overdue by ${fmtLate(now - at)} — posts on the next tick${approval}`,
      };
    }
    return { at, tone: "ok", reason: `next slot in the page schedule${approval}` };
  }

  // ── Verification ────────────────────────────────────────────────────────

  /** Marks a live post as verifying; the tick runs the check (survives restarts). */
  startVerification(entryId: string, delayMs = VERIFY_FIRST_DELAY_MS): QueueEntry {
    return this.deps.posting.setVerification(
      entryId,
      {
        status: "verifying",
        note: "waiting for the app to finish processing, then checking the profile",
        nextAt: this.now() + delayMs,
        attempts: 0,
        verifiedAt: null,
      },
      { event: "verifying", message: "Verifying the post (profile check scheduled)" },
    );
  }

  /** Owner / agent "re-verify": runs the check now. */
  async verifyNow(entryId: string): Promise<QueueEntry> {
    const e = this.deps.posting.requireEntry(entryId);
    if (e.status !== "posted" || e.dryRun) {
      throw new Error(
        e.dryRun
          ? "a dry run published nothing — nothing to verify"
          : `entry is ${e.status}, not posted`,
      );
    }
    this.deps.posting.setVerification(
      e.id,
      { status: "verifying", note: "re-verify requested", nextAt: this.now(), attempts: 0 },
      { event: "verifying", message: "Re-verify requested" },
    );
    return this.verifyEntry(e.id);
  }

  /**
   * One verification attempt: platform API first (no phone time), then the
   * phone. Never marks verified without a caption match from one of them.
   */
  async verifyEntry(entryId: string): Promise<QueueEntry> {
    const { posting, droid } = this.deps;
    const e = posting.requireEntry(entryId);
    if (e.status !== "posted" || e.verifyStatus !== "verifying") return e;
    const cfg = posting.getConfig(e.pageId);
    const binding = this.bindingFor(cfg, e);
    const attempt = e.verifyAttempts + 1;
    const caption = this.captionFor(cfg, e, e.postedAt ?? this.now()).text;
    const key = captionKey(caption);
    const evidence: VerifyEvidence = {
      sources: [],
      captionMatched: false,
      seenCaption: null,
      steps: [],
      screenshots: [],
      checkedAt: this.now(),
    };
    let permalink: string | null = e.permalink;
    let transient: string | null = null;
    let reason: string | null = null;

    // a. Platform API (Instagram Graph) — the account's own recent media.
    if (this.deps.recentMedia) {
      try {
        const media = await this.deps.recentMedia(e.pageId, e.platform);
        if (media) {
          evidence.sources.push("instagram_api");
          const since = (e.postedAt ?? 0) - 15 * 60_000;
          const hit = media.find(
            (m) => m.timestamp >= since && key && normalizeCaption(m.caption).includes(key),
          );
          evidence.steps.push(
            hit
              ? `✓ api: ${hit.permalink} (${new Date(hit.timestamp).toISOString()})`
              : `✗ api: no post since ${new Date(since).toISOString()} starting "${key}" among ${media.length}`,
          );
          if (hit) {
            evidence.captionMatched = true;
            evidence.seenCaption = hit.caption.slice(0, 160);
            permalink = hit.permalink;
          } else reason = "the account's recent posts (API) do not include it yet";
        }
      } catch (err) {
        evidence.steps.push(`✗ api: ${String(err).slice(0, 200)}`);
      }
    }

    // b. On the phone — when the API did not prove it (or gave no link).
    if ((!evidence.captionMatched || !permalink) && droid.verifyPost && cfg.deviceId && binding) {
      try {
        const res = await droid.verifyPost({
          deviceId: cfg.deviceId,
          platform: e.platform,
          handle: binding.handle,
          caption,
          requestId: `${e.id}-v${attempt}`,
          actor: `content-studio:posting:${cfg.pageId}`,
        });
        evidence.sources.push("device");
        evidence.steps.push(
          ...res.steps.map(
            (st) => `${st.ok ? "✓" : "✗"} ${st.step}${st.detail ? `: ${st.detail}` : ""}`,
          ),
        );
        evidence.screenshots.push(
          ...(res.evidence ?? []).map((x) => x.screenshot).filter((x): x is string => Boolean(x)),
        );
        if (res.status === "verified") {
          evidence.captionMatched = true;
          evidence.seenCaption = res.seenCaption;
          permalink = permalink ?? res.permalink;
          reason = null;
        } else if (
          res.status === "busy" ||
          res.status === "offline" ||
          res.status === "unavailable"
        ) {
          transient = res.reason ?? res.status;
        } else if (!evidence.captionMatched) {
          reason = res.reason ?? res.status;
          evidence.seenCaption = res.seenCaption;
        }
      } catch (err) {
        transient = `phone check failed: ${String(err)}`;
      }
    } else if (!evidence.captionMatched && !this.deps.recentMedia && !droid.verifyPost) {
      reason =
        "no verification source (no Instagram API connection and this Droid Swarm build cannot check the phone)";
    }

    if (evidence.captionMatched) {
      return posting.setVerification(
        e.id,
        {
          status: "verified",
          note: permalink ? null : "verified on the profile — the app did not show a link",
          verifiedAt: this.now(),
          nextAt: null,
          attempts: attempt,
          permalink,
          evidence,
        },
        {
          event: "verified",
          message: `Verified on @${binding?.handle ?? "?"} (${evidence.sources.join(" + ")})${permalink ? ` — ${permalink}` : ""}`,
          meta: { permalink, sources: evidence.sources },
        },
      );
    }
    const why = transient ?? reason ?? "not found";
    if ((transient || reason) && attempt < VERIFY_MAX_ATTEMPTS) {
      const wait = VERIFY_BACKOFF_MS[Math.min(attempt - 1, VERIFY_BACKOFF_MS.length - 1)]!;
      return posting.setVerification(
        e.id,
        {
          status: "verifying",
          note: `attempt ${attempt}/${VERIFY_MAX_ATTEMPTS}: ${why} — checking again`,
          nextAt: this.now() + wait,
          attempts: attempt,
          permalink,
          evidence,
        },
        { event: "verify_retry", message: `Verify attempt ${attempt} inconclusive: ${why}` },
      );
    }
    const out = posting.setVerification(
      e.id,
      { status: "unverified", note: why, nextAt: null, attempts: attempt, permalink, evidence },
      { event: "unverified", message: `Could not verify the post: ${why}`, meta: { permalink } },
    );
    const page = this.deps.page(cfg.pageId);
    void Promise.resolve(
      this.deps.host.alertOwner?.({
        title: "Content Studio: post not verified",
        body: `${page?.name ?? cfg.pageId}: "${e.title || e.mediaId}" → ${e.platform} @${binding?.handle ?? "?"} was published but could not be confirmed: ${why}.${permalink ? ` ${permalink}` : ""} Check the profile, then Re-verify.`,
        severity: "warning",
        link: "/content-pages",
      }),
    ).catch(() => {});
    return out;
  }

  /** Phone reachable + bound account verified (see posting-verify.ts). */
  preflight(cfg: PostingConfig, platform: string): Promise<PreflightResult> {
    return preflight(
      { droid: this.deps.droid, posting: this.deps.posting, now: this.now },
      cfg,
      platform,
      { actor: `content-studio:posting:${cfg.pageId}` },
    );
  }

  /**
   * A due entry the phone can't take right now. Transient (offline / busy /
   * unavailable) → rescheduled without counting an attempt. Account not
   * verified → the entry fails and the page's auto-posting stops, exactly
   * like a wrong-account refusal from the phone.
   */
  private refuse(
    cfg: PostingConfig,
    entry: QueueEntry,
    pf: Extract<PreflightResult, { ok: false }>,
  ): PostAttemptReport {
    const { posting } = this.deps;
    if (pf.kind === "offline" || pf.kind === "busy" || pf.kind === "unavailable") {
      if (entry.status === "awaiting_approval") {
        // Approved, phone not reachable: keep the approval and try next tick.
        posting.transition(entry.id, "awaiting_approval", { lastError: pf.reason });
        return { entryId: entry.id, status: "awaiting_approval", reason: pf.reason };
      }
      const wait = pf.kind === "busy" ? 60_000 : pf.kind === "offline" ? 10 * 60_000 : 5 * 60_000;
      const repeat = entry.lastError === pf.reason && entry.status === "scheduled";
      posting.transition(
        entry.id,
        "scheduled",
        { scheduledAt: this.now() + wait, lastError: pf.reason },
        repeat
          ? undefined
          : { event: "deferred", message: `Not posted: ${pf.reason}`, meta: { refusal: pf.kind } },
      );
      return { entryId: entry.id, status: "scheduled", reason: pf.reason };
    }
    const kind =
      pf.kind === "challenge"
        ? "blocked"
        : pf.kind === "app_missing" || pf.kind === "logged_out"
          ? "logged_out"
          : pf.kind === "wrong_account"
            ? "wrong_account"
            : pf.kind;
    return this.fail(cfg, entry, entry.attempts, pf.reason, pf.transient, {
      countAttempt: false,
      kind,
      meta: { refusal: pf.kind },
    });
  }

  private requestApproval(cfg: PostingConfig, entry: QueueEntry): PostAttemptReport {
    const approvals = this.deps.host.approvals;
    const binding = cfg.bindings.find((b) => b.platform === entry.platform)!;
    if (!approvals) {
      // Fail closed: approval mode without an approval system never posts.
      this.deps.posting.transition(
        entry.id,
        "scheduled",
        {
          scheduledAt: this.now() + 10 * 60_000,
          lastError: "approval system unavailable — waiting",
        },
        {
          event: "approval_unavailable",
          message: "Approval required but the approval system is unavailable",
        },
      );
      return { entryId: entry.id, status: "scheduled", reason: "approval unavailable" };
    }
    const caption = this.captionFor(cfg, entry);
    const page = this.deps.page(cfg.pageId);
    const rec = approvals.create({
      source: "tool-gate",
      requester: { label: `Content Studio · ${page?.name ?? cfg.pageId}` },
      title: `${cfg.dryRun ? "[dry run] " : ""}Post "${entry.title || "video"}" to ${entry.platform} @${binding.handle}`,
      summary:
        `Content Studio wants to ${cfg.dryRun ? "rehearse (dry run, stops before Share)" : "publish"} a queued video ` +
        `from ${cfg.deviceLabel ?? cfg.deviceId} as @${binding.handle}. Approve to post now, deny to fail this entry.`,
      details: `Device: ${cfg.deviceLabel ?? ""} (${cfg.deviceId})\nAccount: ${entry.platform} @${binding.handle}\nVideo: ${entry.mediaId}${entry.trialReel ? "\nTrial reel: yes (shown to non-followers first)" : ""}\n\nCaption:\n${caption.text}`,
      risk: cfg.dryRun ? "low" : "medium",
      options: ["approve", "deny"],
      sourceRef: {
        plugin: CONTENT_STUDIO_PLUGIN_ID,
        kind: "posting",
        entryId: entry.id,
        pageId: cfg.pageId,
      },
      timeoutMs: APPROVAL_TIMEOUT_MS,
      resumable: true,
    });
    this.deps.posting.transition(
      entry.id,
      "awaiting_approval",
      { approvalId: rec.id },
      {
        event: "approval_requested",
        message: `Waiting for approval (${rec.id})`,
        meta: { approvalId: rec.id },
      },
    );
    return { entryId: entry.id, status: "awaiting_approval", reason: null };
  }

  private async checkApproval(
    cfg: PostingConfig,
    entry: QueueEntry,
  ): Promise<PostAttemptReport | null> {
    const rec = entry.approvalId ? (this.deps.host.approvals?.get(entry.approvalId) ?? null) : null;
    if (!rec) {
      this.deps.posting.transition(
        entry.id,
        "failed",
        { lastError: "approval request is gone (expired or cleared)" },
        { event: "approval_lost", message: "Approval request missing; entry failed" },
      );
      return { entryId: entry.id, status: "failed", reason: "approval missing" };
    }
    if (rec.status === "pending") return null;
    if (rec.status !== "approved") {
      const why = `approval ${rec.status}${rec.decidedBy ? ` by ${rec.decidedBy}` : ""}${rec.note ? `: ${rec.note}` : rec.reason ? ` (${rec.reason})` : ""}`;
      this.deps.posting.transition(
        entry.id,
        "failed",
        { lastError: why },
        { event: "approval_denied", message: why },
      );
      return { entryId: entry.id, status: "failed", reason: why };
    }
    // Approved — still honour the hard limits (never the window: the owner said go).
    const { postedAts, lastPostAt } = this.times(cfg, entry.platform);
    const block = postBlockReason({
      schedule: { ...cfg.schedule, windowStart: "00:00", windowEnd: "00:00" },
      dryRun: cfg.dryRun,
      now: this.now(),
      lastPostAt,
      postedAts,
    });
    if (block)
      return {
        entryId: entry.id,
        status: "awaiting_approval",
        reason: `approved, waiting: ${block}`,
      };
    if (!cfg.deviceId || !cfg.bindings.some((b) => b.platform === entry.platform)) {
      this.deps.posting.transition(entry.id, "failed", {
        lastError: "binding removed after approval",
      });
      return { entryId: entry.id, status: "failed", reason: "binding removed" };
    }
    return this.execute(
      cfg,
      entry,
      `approval:${rec.id}${rec.decidedBy ? `:${rec.decidedBy}` : ""}`,
    );
  }

  // ── Post now (agents / UI) ──────────────────────────────────────────────

  /**
   * Posts one entry immediately, with the same safety checks as the
   * scheduler: binding, min interval + daily cap, and — on "require approval"
   * pages — an approval first (this files it and returns awaiting_approval).
   */
  async postNow(entryId: string): Promise<PostAttemptReport> {
    const { posting } = this.deps;
    const entry = posting.requireEntry(entryId);
    const cfg = posting.getConfig(entry.pageId);
    if (!cfg.deviceId || !cfg.bindings.some((b) => b.platform === entry.platform)) {
      return {
        entryId,
        status: entry.status,
        reason: `bind a device and a ${entry.platform} account first`,
      };
    }
    if (!["queued", "scheduled", "failed", "paused"].includes(entry.status)) {
      return { entryId, status: entry.status, reason: `entry is ${entry.status}` };
    }
    if (
      posting
        .listQueue(entry.pageId)
        .some((e) => e.status === "posting" || e.status === "awaiting_approval")
    ) {
      return {
        entryId,
        status: entry.status,
        reason: "another post for this page is in flight or awaiting approval",
      };
    }
    const { postedAts, lastPostAt } = this.times(cfg, entry.platform);
    const block = postBlockReason({
      schedule: { ...cfg.schedule, windowStart: "00:00", windowEnd: "00:00" },
      dryRun: cfg.dryRun,
      now: this.now(),
      lastPostAt,
      postedAts,
    });
    if (block) return { entryId, status: entry.status, reason: block };
    const pf = await this.preflight(cfg, entry.platform);
    if (!pf.ok) return { entryId, status: entry.status, reason: pf.reason };
    let e = entry;
    if (e.status === "failed" || e.status === "paused")
      e = posting.transition(e.id, "queued", { attempts: 0, lastError: null });
    if (e.status === "queued")
      e = posting.transition(
        e.id,
        "scheduled",
        { scheduledAt: this.now() },
        { event: "post_now", message: "Post now requested" },
      );
    if (cfg.requireApproval) return this.requestApproval(cfg, e);
    return this.execute(cfg, e, "manual:post-now");
  }

  // ── Execute ─────────────────────────────────────────────────────────────

  private async resolveVideoPath(
    entry: QueueEntry,
  ): Promise<{ path: string } | { error: string; retryable: boolean }> {
    const { studio } = this.deps;
    const media = entry.mediaId ? studio.store.getMedia(entry.mediaId) : null;
    if (!media) return { error: `video ${entry.mediaId} no longer exists`, retryable: false };
    if (media.kind !== "video")
      return { error: `media ${media.id} is a ${media.kind}, not a video`, retryable: false };
    const local = studio.media.filePath(media);
    if (local) return { path: local };
    if (media.externalUrl) {
      try {
        const copy = await studio.media.importUrl({
          url: media.externalUrl,
          caption: media.caption,
          source: "url",
        });
        const p = studio.media.filePath(copy);
        if (p) return { path: p };
      } catch (err) {
        return { error: `could not download the video: ${String(err)}`, retryable: true };
      }
    }
    return { error: "the video has no stored file", retryable: false };
  }

  private async execute(
    cfg: PostingConfig,
    entry: QueueEntry,
    authorization: string,
  ): Promise<PostAttemptReport> {
    const { posting, droid } = this.deps;
    if (this.inflight.has(entry.id))
      return { entryId: entry.id, status: "posting", reason: "already posting" };
    const binding = cfg.bindings.find((b) => b.platform === entry.platform)!;
    const attempt = entry.attempts + 1;
    this.inflight.add(entry.id);
    try {
      const pf = await this.preflight(cfg, entry.platform);
      if (!pf.ok) return this.refuse(cfg, entry, pf);
      posting.transition(
        entry.id,
        "posting",
        { attempts: attempt },
        {
          event: "posting",
          message: `${cfg.dryRun ? "Dry run" : "Posting"} attempt ${attempt}/${entry.maxAttempts} → ${entry.platform} @${binding.handle}${entry.trialReel ? " as a trial reel" : ""} on ${cfg.deviceLabel ?? cfg.deviceId} (${authorization})`,
        },
      );
      const video = await this.resolveVideoPath(entry);
      if ("error" in video) return this.fail(cfg, entry, attempt, video.error, video.retryable);
      const caption = this.captionFor(cfg, entry);
      let res: DroidPublishResult;
      try {
        res = await droid.publish({
          deviceId: cfg.deviceId!,
          platform: entry.platform,
          handle: binding.handle,
          videoPath: video.path,
          caption: caption.text,
          dryRun: cfg.dryRun,
          trialReel: entry.platform === "instagram" && entry.trialReel,
          requestId: `${entry.id}-a${attempt}`,
          actor: `content-studio:posting:${cfg.pageId}`,
          authorization,
        });
      } catch (err) {
        const unavailable = err instanceof DroidUnavailableError;
        return this.fail(
          cfg,
          entry,
          attempt,
          unavailable ? err.message : `publisher error: ${String(err)}`,
          true,
          {
            countAttempt: !unavailable,
          },
        );
      }
      const meta = {
        droidStatus: res.status,
        steps: res.steps.map(
          (s) => `${s.ok ? "✓" : "✗"} ${s.step}${s.detail ? `: ${s.detail}` : ""}`,
        ),
        warnings: res.warnings,
        activeHandle: res.activeHandle,
        switched: res.switched,
        dryRun: res.dryRun,
        media: res.media ?? null,
        evidence: res.evidence ?? [],
      };
      if (res.status === "posted" || res.status === "dry_run_complete") {
        posting.transition(
          entry.id,
          "posted",
          {
            postedAt: this.now(),
            postUrl: res.postUrl,
            postRef: res.postRef,
            dryRun: res.status === "dry_run_complete",
            lastError: null,
            approvalId: entry.approvalId,
          },
          {
            event: res.status === "posted" ? "posted" : "dry_run",
            message:
              res.status === "posted"
                ? `Posted to ${entry.platform} @${binding.handle}${res.postRef ? ` (${res.postRef})` : ""}`
                : `Dry run complete — full flow ran as @${res.activeHandle}, stopped before Share (nothing published)`,
            meta,
          },
        );
        if (entry.designatedAt !== null) {
          const late = this.now() - entry.designatedAt;
          if (late > LATE_GRACE_MS) {
            posting.setLateBy(entry.id, late);
            posting.log(
              cfg.pageId,
              entry.id,
              "late",
              "posted",
              `Posted late by ${fmtLate(late)} (designated ${localTime(entry.designatedAt, cfg.schedule.timezone)})`,
            );
          }
        }
        if (res.status === "posted" && entry.platform === "instagram" && entry.trialReel) {
          // Trial reels never appear on the profile grid, so the profile check
          // cannot find them — record why instead of failing verification.
          posting.setVerification(
            entry.id,
            {
              status: "unverified",
              note: "trial reel — shared (the app left the composer and finished uploading); trial reels are not on the profile, check Professional dashboard › Trial reels",
              nextAt: null,
              attempts: 0,
              verifiedAt: null,
            },
            {
              event: "unverified",
              message:
                "Trial reel shared — not on the profile grid, so the profile check is skipped",
            },
          );
        } else if (res.status === "posted") this.startVerification(entry.id);
        return { entryId: entry.id, status: "posted", reason: null };
      }
      if (
        res.status === "busy" ||
        res.status === "paced" ||
        res.status === "offline" ||
        res.status === "unavailable"
      ) {
        const wait =
          res.status === "busy" ? 60_000 : res.status === "offline" ? 10 * 60_000 : 5 * 60_000;
        posting.transition(
          entry.id,
          "scheduled",
          { attempts: entry.attempts, scheduledAt: this.now() + wait, lastError: res.reason },
          { event: "deferred", message: `Deferred: ${res.status} — ${res.reason ?? ""}`, meta },
        );
        return { entryId: entry.id, status: "scheduled", reason: res.reason };
      }
      if (res.status === "trial_unavailable") {
        // Not retried: the same phone will not grow a Trial switch. The owner
        // turns "Trial reel" off on the item and retries (or updates the app).
        return this.fail(
          cfg,
          entry,
          attempt,
          `${TRIAL_UNAVAILABLE}: Instagram on ${cfg.deviceLabel ?? cfg.deviceId} has no Trial reel option on the share screen — nothing was posted. Turn off "Trial reel" on this video and retry to share it as a regular reel.`,
          false,
          { meta: { ...meta, publisherReason: res.reason }, kind: TRIAL_UNAVAILABLE },
        );
      }
      const hardStop =
        res.status === "wrong_account" || res.status === "logged_out" || res.status === "blocked";
      return this.fail(cfg, entry, attempt, res.reason ?? res.status, !hardStop && res.retryable, {
        meta,
        kind: res.status,
      });
    } finally {
      this.inflight.delete(entry.id);
    }
  }

  private fail(
    cfg: PostingConfig,
    entry: QueueEntry,
    attempt: number,
    reason: string,
    retryable: boolean,
    opts: { countAttempt?: boolean; meta?: Record<string, unknown>; kind?: string } = {},
  ): PostAttemptReport {
    const { posting } = this.deps;
    const attempts = opts.countAttempt === false ? entry.attempts : attempt;
    if (retryable && attempts < entry.maxAttempts) {
      const at = this.now() + backoffMs(attempts, cfg.dryRun);
      posting.transition(
        entry.id,
        "scheduled",
        { attempts, scheduledAt: at, lastError: reason },
        {
          event: "retry",
          message: `Attempt ${attempt} failed: ${reason} — retrying at ${localTime(at, cfg.schedule.timezone)}`,
          meta: opts.meta,
        },
      );
      return { entryId: entry.id, status: "scheduled", reason };
    }
    posting.transition(
      entry.id,
      "failed",
      { attempts, lastError: reason },
      {
        event:
          opts.kind === "wrong_account" || opts.kind === TRIAL_UNAVAILABLE ? opts.kind : "failed",
        message: `Failed: ${reason}`,
        meta: opts.meta,
      },
    );
    // Wrong account / logged out / human checkpoint: stop the whole page so
    // the next video does not walk into the same wall. The owner fixes the
    // phone and switches auto-posting back on.
    const hardStop =
      opts.kind === "wrong_account" ||
      opts.kind === "logged_out" ||
      opts.kind === "blocked" ||
      opts.kind === "unknown_device";
    if (hardStop && posting.getConfig(cfg.pageId).enabled) {
      posting.updateConfig(cfg.pageId, { enabled: false });
      posting.log(
        cfg.pageId,
        entry.id,
        "auto_paused",
        null,
        `Auto-posting switched off: ${opts.kind?.replace("_", " ")}`,
      );
    }
    const page = this.deps.page(cfg.pageId);
    void Promise.resolve(
      this.deps.host.alertOwner?.({
        title: `Content Studio: post failed${opts.kind === "wrong_account" ? " (wrong account — refused)" : opts.kind === TRIAL_UNAVAILABLE ? " (Trial reel unavailable)" : ""}`,
        body: `${page?.name ?? cfg.pageId}: "${entry.title || entry.mediaId}" → ${entry.platform}. ${reason}`,
        severity: opts.kind === "wrong_account" || opts.kind === "blocked" ? "critical" : "warning",
        link: "/content-pages",
      }),
    ).catch(() => {});
    return { entryId: entry.id, status: "failed", reason };
  }

  // ── AI caption ──────────────────────────────────────────────────────────

  /**
   * Drafts a caption with the owner's default model, from the template and
   * the video's fields. Returns the draft only — nothing is saved until the
   * owner (or an agent, explicitly) applies it as the entry's override.
   */
  async draftCaption(
    pageId: string,
    entryId: string | null,
    instructions = "",
  ): Promise<{ draft: string; model?: string }> {
    const run = this.deps.host.runLLM;
    if (!run) throw new Error("no LLM is available on this gateway");
    const cfg = this.deps.posting.getConfig(pageId);
    const entry = entryId ? this.deps.posting.requireEntry(entryId) : null;
    const page = this.deps.page(pageId);
    const platform = entry?.platform ?? cfg.bindings[0]?.platform ?? "instagram";
    const rendered = entry
      ? this.captionFor(cfg, { ...entry, captionOverride: null })
      : renderCaption(
          cfg.template,
          { cta: cfg.cta, hashtags: cfg.defaultHashtags, page: page?.name ?? "" },
          platform,
        );
    const res = await run({
      systemPrompt:
        "You write short-form video captions for the account owner's own content. Keep the template's structure " +
        "(hook first, then body, CTA, hashtags last). Plain text only, no markdown, no quotes around the caption, " +
        "under 2200 characters and at most 30 hashtags. Do not invent facts, giveaways or claims not in the input.",
      userPrompt: [
        `Platform: ${platform}`,
        `Page: ${page?.name ?? ""}`,
        `Template:\n${cfg.template}`,
        `Template rendered with the current fields:\n${rendered.text}`,
        entry
          ? `Video title: ${entry.title}\nHook: ${entry.hook}\nSeries: ${entry.series} ${entry.episode}`
          : "",
        instructions ? `Owner instructions: ${instructions}` : "",
        "Write the final caption.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      maxTokens: 700,
      temperature: 0.6,
    });
    return { draft: clampCaption(res.text.trim().replace(/^["']|["']$/g, ""), platform) };
  }

  scheduleSummary(schedule: PostingSchedule, dryRun: boolean): string {
    const every =
      schedule.mode === "interval"
        ? `every ${schedule.everyMinutes >= 60 && schedule.everyMinutes % 60 === 0 ? `${schedule.everyMinutes / 60}h` : `${schedule.everyMinutes}m`}`
        : `${schedule.postsPerDay}×/day`;
    const window =
      schedule.windowStart === schedule.windowEnd
        ? "all day"
        : `${schedule.windowStart}–${schedule.windowEnd}`;
    return `${every}, ${window} ${schedule.timezone}, ±${schedule.jitterMinutes}m, cap ${schedule.dailyCap}/day${dryRun ? " (dry run)" : ""}`;
  }
}
