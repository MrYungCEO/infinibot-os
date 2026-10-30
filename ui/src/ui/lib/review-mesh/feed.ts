/**
 * Review feed — the live client for visible agent-to-agent review.
 *
 *   review.threads.list  → recent thread summaries (mount)
 *   review.thread.get    → one full thread (panel / replay / warm-up)
 *   verification.screenshots.list → screenshot gallery
 *   WS review.message / verification.completion / verification.screenshots
 *
 * Holds a bounded ThreadStore + screenshot list and fans changes out to
 * listeners (the Pixi layer animates `message` events, panels re-render).
 * One feed per mesh surface; demo mode (?reviewDemo=1) feeds it synthetic data.
 */

import { gatewayHttpBase } from "../../gateway-http-auth";
import { ThreadStore, mergeScreenshots, needsOwner, type StoredThread } from "./model";
import type { CompletionRecordLite } from "./completed";
import {
  DEFAULT_REVIEWER,
  type CompletionBroadcast,
  type ReviewMessage,
  type ReviewMessageEvent,
  type ReviewThread,
  type ReviewThreadSummary,
  type ReviewerIdentity,
  type ScreenshotEntry,
} from "./types";

export type FeedRequester = {
  request: <T = unknown>(method: string, params?: unknown) => Promise<T>;
  subscribe?: (handler: (evt: { event?: string; payload?: unknown }) => void) => () => void;
  supports?: (method: string) => boolean;
};

export type FeedEvent =
  | { type: "message"; message: ReviewMessage; thread: StoredThread; fresh: boolean; live: boolean }
  | { type: "threads" }
  | { type: "thread"; thread: StoredThread }
  | { type: "screenshots"; items: ScreenshotEntry[]; live: boolean }
  | { type: "completion"; runId: string; state: string; verdict: string | null }
  | { type: "viewed"; runId: string }
  | { type: "completed" };

export interface ScreenshotQuery {
  limit?: number;
  cursor?: string | null;
  verdict?: "pass" | "fail";
  route?: string;
  viewport?: string;
  agent?: string;
  runId?: string;
  q?: string;
  since?: number;
}

export interface ScreenshotPage {
  items: ScreenshotEntry[];
  total: number;
  nextCursor: string | null;
}

const VIEWED_KEY = "infinibot.review.viewedEscalations.v1";

/** Prefix gateway-relative paths the way completion-verdict does. */
export function gatewayUrl(path: string | null | undefined): string {
  if (!path) return "";
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  return `${gatewayHttpBase()}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** Screenshot path (from a review message) → thumbnail URL. */
export function screenshotThumbUrl(path: string): string {
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  return `${gatewayHttpBase()}/api/verification/file?path=${encodeURIComponent(path)}&thumb=1`;
}

export function screenshotFullUrl(path: string): string {
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  return `${gatewayHttpBase()}/api/verification/file?path=${encodeURIComponent(path)}`;
}

export function isReviewDemo(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("reviewDemo") === "1";
  } catch {
    return false;
  }
}

function readViewed(): Set<string> {
  try {
    const raw = localStorage.getItem(VIEWED_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string").slice(-200) : []);
  } catch {
    return new Set();
  }
}

export class ReviewFeed {
  readonly store = new ThreadStore(60, 200);
  screenshots: ScreenshotEntry[] = [];
  screenshotsTotal = 0;
  reviewer: ReviewerIdentity = DEFAULT_REVIEWER;
  loading = false;
  error: string | null = null;
  /** Completion records (verification.list) — the recently-completed rail + halos. */
  completed: CompletionRecordLite[] = [];
  /** Demo-only screenshots (kept apart so a gateway refresh never drops them). */
  private demoShots: ScreenshotEntry[] = [];
  private demoCompleted: CompletionRecordLite[] = [];
  private completedTimer: ReturnType<typeof setInterval> | null = null;
  private completedDebounce: ReturnType<typeof setTimeout> | null = null;
  private viewed = readViewed();
  private listeners = new Set<(ev: FeedEvent) => void>();
  private unsub: (() => void) | null = null;
  private threadInflight = new Map<string, Promise<StoredThread | null>>();
  private started = false;

  constructor(private client: FeedRequester | null) {}

  setClient(client: FeedRequester | null): void {
    if (client === this.client) return;
    this.stop();
    this.client = client;
    if (this.startedOnce) void this.start();
  }

  private startedOnce = false;

  on(fn: (ev: FeedEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(ev: FeedEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch (err) {
        console.warn("[review-feed] listener failed", err);
      }
    }
  }

  private can(method: string): boolean {
    const c = this.client;
    if (!c) return false;
    return typeof c.supports === "function" ? c.supports(method) : true;
  }

  async start(): Promise<void> {
    this.startedOnce = true;
    if (this.started) return;
    this.started = true;
    const c = this.client;
    if (c && typeof c.subscribe === "function" && !this.unsub) {
      this.unsub = c.subscribe((evt) => this.onGatewayEvent(evt));
    }
    if (!this.completedTimer) {
      this.completedTimer = setInterval(() => {
        if (typeof document === "undefined" || !document.hidden) void this.refreshCompleted();
      }, 60_000);
    }
    await Promise.all([this.refreshThreads(), this.refreshScreenshots(), this.refreshCompleted()]);
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.completedTimer) clearInterval(this.completedTimer);
    this.completedTimer = null;
    if (this.completedDebounce) clearTimeout(this.completedDebounce);
    this.completedDebounce = null;
    this.started = false;
  }

  destroy(): void {
    this.stop();
    this.listeners.clear();
  }

  private onGatewayEvent(evt: { event?: string; payload?: unknown }): void {
    const name = evt?.event;
    if (!name) return;
    if (name === "review.message") {
      const p = evt.payload as ReviewMessageEvent | undefined;
      if (p?.message?.runId) this.ingest(p, true);
    } else if (name === "verification.completion") {
      const p = evt.payload as CompletionBroadcast | undefined;
      if (!p?.runId) return;
      this.store.patchState(p.runId, { state: p.state, ...(p.state === "needs_owner" ? { escalated: true } : {}) });
      this.emit({ type: "completion", runId: p.runId, state: p.state, verdict: p.verdict ?? null });
      if (this.completedDebounce) clearTimeout(this.completedDebounce);
      this.completedDebounce = setTimeout(() => void this.refreshCompleted(), 800);
    } else if (name === "verification.screenshots") {
      const p = evt.payload as { items?: ScreenshotEntry[] } | undefined;
      if (Array.isArray(p?.items) && p.items.length) this.ingestScreenshots(p.items, true);
    }
  }

  /** Apply one review message (live WS, or demo). */
  ingest(ev: ReviewMessageEvent, live: boolean): void {
    const { fresh, thread } = this.store.ingest(ev);
    if (needsOwner(thread.summary) && fresh && live) this.viewed.delete(thread.summary.runId);
    this.emit({ type: "message", message: ev.message, thread, fresh, live });
  }

  ingestThread(t: ReviewThread): StoredThread {
    if (t.reviewer) this.reviewer = { ...DEFAULT_REVIEWER, ...t.reviewer };
    const thread = this.store.setThread(t);
    this.emit({ type: "thread", thread });
    return thread;
  }

  ingestScreenshots(items: ScreenshotEntry[], live: boolean, demo = false): void {
    if (demo) this.demoShots = mergeScreenshots(this.demoShots, items, 60);
    const before = this.screenshots.length;
    this.screenshots = mergeScreenshots(this.screenshots, items, 240);
    this.screenshotsTotal = Math.max(this.screenshotsTotal + (this.screenshots.length - before), this.screenshots.length);
    this.emit({ type: "screenshots", items, live });
  }

  async refreshThreads(): Promise<void> {
    if (!this.can("review.threads.list")) return;
    this.loading = true;
    try {
      const res = await this.client!.request<{ threads?: ReviewThreadSummary[]; reviewer?: ReviewerIdentity }>(
        "review.threads.list",
        { limit: 30 },
      );
      if (res?.reviewer) this.reviewer = { ...DEFAULT_REVIEWER, ...res.reviewer };
      if (Array.isArray(res?.threads)) this.store.setSummaries(res.threads);
      this.error = null;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
      this.emit({ type: "threads" });
    }
  }

  /** Full thread, cached; refetches when `force` or the cached copy is partial. */
  loadThread(runId: string, force = false): Promise<StoredThread | null> {
    const cached = this.store.get(runId);
    if (cached?.complete && !force) return Promise.resolve(cached);
    if (!this.can("review.thread.get")) return Promise.resolve(cached ?? null);
    const inflight = this.threadInflight.get(runId);
    if (inflight) return inflight;
    const p = this.client!
      .request<ReviewThread | null>("review.thread.get", { runId })
      .then((t) => (t && t.summary ? this.ingestThread(t) : cached ?? null))
      .catch(() => cached ?? null)
      .finally(() => this.threadInflight.delete(runId));
    this.threadInflight.set(runId, p);
    return p;
  }

  async refreshCompleted(): Promise<void> {
    if (!this.can("verification.list")) {
      if (this.demoCompleted.length) this.emit({ type: "completed" });
      return;
    }
    try {
      const res = await this.client!.request<{ records?: CompletionRecordLite[] }>("verification.list", { limit: 80 });
      const live = Array.isArray(res?.records) ? res.records : [];
      const ids = new Set(live.map((r) => r.runId));
      this.completed = [...this.demoCompleted.filter((r) => !ids.has(r.runId)), ...live];
      this.emit({ type: "completed" });
    } catch {
      /* older gateway: rail stays on demo/empty */
    }
  }

  /** Demo / local injection of completion records. */
  ingestCompleted(records: CompletionRecordLite[], demo = false): void {
    if (demo) this.demoCompleted = [...records, ...this.demoCompleted.filter((r) => !records.some((x) => x.runId === r.runId))];
    const ids = new Set(records.map((r) => r.runId));
    this.completed = [...records, ...this.completed.filter((r) => !ids.has(r.runId))];
    this.emit({ type: "completed" });
  }

  async refreshScreenshots(): Promise<void> {
    const page = await this.queryScreenshots({ limit: 48 });
    if (!page) return;
    this.screenshots = mergeScreenshots(this.demoShots, page.items, 240);
    this.screenshotsTotal = Math.max(page.total + this.demoShots.length, this.screenshots.length);
    this.emit({ type: "screenshots", items: page.items, live: false });
  }

  async queryScreenshots(q: ScreenshotQuery): Promise<ScreenshotPage | null> {
    if (!this.can("verification.screenshots.list")) return null;
    try {
      const params: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== "") params[k] = v;
      const res = await this.client!.request<ScreenshotPage>("verification.screenshots.list", params);
      return {
        items: Array.isArray(res?.items) ? res.items : [],
        total: Number(res?.total ?? 0) || 0,
        nextCursor: res?.nextCursor ?? null,
      };
    } catch {
      return null;
    }
  }

  // ── Escalation "viewed" tracking ────────────────────────────────────────

  isAttentionPending(runId: string): boolean {
    const t = this.store.get(runId);
    return Boolean(t && needsOwner(t.summary) && !this.viewed.has(runId));
  }

  pendingAttention(): StoredThread[] {
    return this.store.list().filter((t) => needsOwner(t.summary) && !this.viewed.has(t.summary.runId));
  }

  markViewed(runId: string): void {
    if (this.viewed.has(runId)) return;
    this.viewed.add(runId);
    try {
      localStorage.setItem(VIEWED_KEY, JSON.stringify([...this.viewed].slice(-200)));
    } catch {
      /* storage blocked */
    }
    this.emit({ type: "viewed", runId });
  }
}
