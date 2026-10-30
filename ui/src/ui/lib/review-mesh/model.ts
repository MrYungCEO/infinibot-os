/**
 * Review mesh — pure logic for the visible agent-to-agent review on the mesh
 * map (packet colours, thread store merge/dedupe, replay scheduling, LOD caps,
 * screenshot-orbit geometry and gallery filtering).
 *
 * No DOM, no Pixi, no gateway: everything here is unit-tested in model.test.ts
 * and consumed by the client feed (feed.ts), the Pixi layer
 * (views/agent-ops/review-mesh-layer.ts) and the panels.
 */

import {
  REVIEWER_ID,
  type ReviewMessage,
  type ReviewMessageEvent,
  type ReviewThread,
  type ReviewThreadSummary,
  type ScreenshotEntry,
} from "./types";

// ── Packet colours ──────────────────────────────────────────────────────────

export type PacketTone = "gold" | "amber" | "red" | "cyan" | "green" | "magenta" | "violet" | "slate";

/** Pixi fill colours per tone. */
export const TONE_HEX: Record<PacketTone, number> = {
  gold: 0xf5c542,
  amber: 0xf59e0b,
  red: 0xef4444,
  cyan: 0x22d3ee,
  green: 0x22c55e,
  magenta: 0xe879f9,
  violet: 0xa78bfa,
  slate: 0x94a3b8,
};

/** CSS colours per tone (chips, borders, the panel's kind badges). */
export const TONE_CSS: Record<PacketTone, string> = {
  gold: "#f5c542",
  amber: "#f59e0b",
  red: "#ef4444",
  cyan: "#22d3ee",
  green: "#22c55e",
  magenta: "#e879f9",
  violet: "#a78bfa",
  slate: "#94a3b8",
};

/** A challenge "lists failures" when any cited evidence or self-check failed. */
export function messageListsFailures(msg: Pick<ReviewMessage, "evidence" | "actions">): boolean {
  if (msg.evidence?.some((e) => e.status === "fail")) return true;
  if (msg.actions?.some((a) => a.status === "fail")) return true;
  return false;
}

/** Colour of a message's packet / chip. */
export function packetTone(msg: Pick<ReviewMessage, "kind" | "verdict" | "evidence" | "actions">): PacketTone {
  switch (msg.kind) {
    case "submission":
      return "gold";
    case "challenge":
      return messageListsFailures(msg) ? "red" : "amber";
    case "response":
      return "cyan";
    case "verdict":
      return verdictTone(msg.verdict ?? null);
    case "action":
      return "violet";
    default:
      return "slate";
  }
}

export function verdictTone(verdict: string | null | undefined): PacketTone {
  switch (verdict) {
    case "VERIFIED":
      return "green";
    case "FAILED":
    case "changes_needed":
      return "red";
    case "escalate":
      return "magenta";
    default:
      return "slate";
  }
}

export function verdictLabel(verdict: string | null | undefined): string {
  switch (verdict) {
    case "VERIFIED":
      return "Verified";
    case "FAILED":
      return "Failed";
    case "changes_needed":
      return "Changes needed";
    case "escalate":
      return "Owner decision";
    default:
      return "In review";
  }
}

export const KIND_LABEL: Record<string, string> = {
  submission: "Submission",
  challenge: "Challenge",
  response: "Response",
  verdict: "Verdict",
  action: "Reviewer action",
};

/** Actions are a pulse on the reviewer, never a travelling packet. */
export function isPacketMessage(msg: Pick<ReviewMessage, "kind">): boolean {
  return msg.kind !== "action";
}

/** True when the packet travels worker → reviewer. */
export function travelsToReviewer(msg: Pick<ReviewMessage, "to" | "toAgent">): boolean {
  return msg.to === "reviewer" || msg.toAgent === REVIEWER_ID;
}

/** The worker side of a message (whichever end is not the reviewer). */
export function workerOf(msg: Pick<ReviewMessage, "fromAgent" | "toAgent" | "runId">): string {
  if (msg.fromAgent && msg.fromAgent !== REVIEWER_ID) return msg.fromAgent;
  if (msg.toAgent && msg.toAgent !== REVIEWER_ID) return msg.toAgent;
  return msg.runId;
}

/** Thread needs the owner (escalated verdict, or the run is waiting on the owner). */
export function needsOwner(summary: Pick<ReviewThreadSummary, "escalated" | "verdict" | "state"> | null | undefined): boolean {
  if (!summary) return false;
  return Boolean(summary.escalated) || summary.verdict === "escalate" || summary.state === "needs_owner";
}

// ── Thread store ────────────────────────────────────────────────────────────

/** Merge two message lists: dedupe by seq (incoming wins), ascending seq. */
export function mergeMessages(existing: readonly ReviewMessage[], incoming: readonly ReviewMessage[]): ReviewMessage[] {
  if (!incoming.length) return existing.slice();
  const bySeq = new Map<number, ReviewMessage>();
  for (const m of existing) bySeq.set(m.seq, m);
  for (const m of incoming) bySeq.set(m.seq, m);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Summary synthesized from messages when the gateway sent none. */
export function summaryFromMessages(runId: string, messages: readonly ReviewMessage[], base?: Partial<ReviewThreadSummary>): ReviewThreadSummary {
  const last = messages[messages.length - 1];
  let lastVerdict: ReviewMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind === "verdict") {
      lastVerdict = messages[i];
      break;
    }
  }
  const worker = last ? workerOf(last) : base?.workerAgent ?? runId;
  const shots = new Set<string>();
  for (const m of messages) for (const s of m.screenshots ?? []) shots.add(s);
  const escalation = lastVerdict?.escalation ?? base?.escalation;
  return {
    runId,
    label: base?.label ?? runId,
    workerAgent: base?.workerAgent ?? worker,
    childSessionKey: base?.childSessionKey ?? worker,
    requesterSessionKey: base?.requesterSessionKey ?? "",
    backend: base?.backend ?? null,
    state: base?.state ?? "running",
    verdict: lastVerdict?.verdict ?? base?.verdict ?? null,
    rounds: messages.filter((m) => m.kind === "submission" || m.kind === "response").length,
    messageCount: messages.length,
    startedAt: base?.startedAt ?? messages[0]?.ts ?? 0,
    lastTs: Math.max(last?.ts ?? 0, base?.lastTs ?? 0),
    lastKind: last?.kind ?? base?.lastKind ?? null,
    lastTitle: last?.title ?? base?.lastTitle ?? "",
    escalated: Boolean(escalation) || Boolean(base?.escalated) || lastVerdict?.verdict === "escalate",
    ...(escalation ? { escalation } : {}),
    screenshots: Math.max(shots.size, base?.screenshots ?? 0),
  };
}

export interface StoredThread {
  summary: ReviewThreadSummary;
  messages: ReviewMessage[];
  /** True once review.thread.get (or a full demo thread) filled the history. */
  complete: boolean;
}

export interface IngestResult {
  /** The message was not seen before (animate it). */
  fresh: boolean;
  thread: StoredThread;
}

/**
 * Bounded in-memory store of review threads. Pure data — the feed owns the
 * gateway wiring and calls into this.
 */
export class ThreadStore {
  private threads = new Map<string, StoredThread>();

  constructor(
    readonly maxThreads = 60,
    readonly maxMessagesPerThread = 200,
  ) {}

  get size(): number {
    return this.threads.size;
  }

  get(runId: string): StoredThread | undefined {
    return this.threads.get(runId);
  }

  /** Threads newest-first by lastTs. */
  list(): StoredThread[] {
    return [...this.threads.values()].sort((a, b) => b.summary.lastTs - a.summary.lastTs);
  }

  /** Apply a live `review.message`. Duplicate seqs are ignored (fresh=false). */
  ingest(ev: ReviewMessageEvent): IngestResult {
    const msg = ev.message;
    const prev = this.threads.get(msg.runId);
    const seen = prev?.messages.some((m) => m.seq === msg.seq) ?? false;
    const messages = this.cap(mergeMessages(prev?.messages ?? [], [msg]));
    const summary = ev.summary
      ? { ...ev.summary, lastTs: Math.max(ev.summary.lastTs ?? 0, msg.ts) }
      : summaryFromMessages(msg.runId, messages, prev?.summary);
    const thread: StoredThread = { summary, messages, complete: prev?.complete ?? false };
    this.threads.set(msg.runId, thread);
    this.evict();
    return { fresh: !seen, thread };
  }

  /** Apply a full thread from review.thread.get. */
  setThread(t: ReviewThread): StoredThread {
    const prev = this.threads.get(t.summary.runId);
    const messages = this.cap(mergeMessages(prev?.messages ?? [], t.messages ?? []));
    const thread: StoredThread = { summary: t.summary, messages, complete: true };
    this.threads.set(t.summary.runId, thread);
    this.evict();
    return thread;
  }

  /** Apply summaries from review.threads.list (keeps any messages already held). */
  setSummaries(list: readonly ReviewThreadSummary[]): void {
    for (const s of list) {
      const prev = this.threads.get(s.runId);
      if (prev) {
        // Never let a stale list response roll back a newer live summary.
        if ((prev.summary.lastTs ?? 0) > (s.lastTs ?? 0)) continue;
        this.threads.set(s.runId, { ...prev, summary: s });
      } else {
        this.threads.set(s.runId, { summary: s, messages: [], complete: false });
      }
    }
    this.evict();
  }

  /** Patch a summary's run state (verification.completion). */
  patchState(runId: string, patch: Partial<ReviewThreadSummary>): StoredThread | undefined {
    const prev = this.threads.get(runId);
    if (!prev) return undefined;
    const next = { ...prev, summary: { ...prev.summary, ...patch } };
    this.threads.set(runId, next);
    return next;
  }

  private cap(messages: ReviewMessage[]): ReviewMessage[] {
    return messages.length > this.maxMessagesPerThread
      ? messages.slice(messages.length - this.maxMessagesPerThread)
      : messages;
  }

  private evict(): void {
    if (this.threads.size <= this.maxThreads) return;
    const ordered = this.list();
    for (const t of ordered.slice(this.maxThreads)) this.threads.delete(t.summary.runId);
  }
}

// ── Replay scheduling ──────────────────────────────────────────────────────

export interface ReplayStep {
  message: ReviewMessage;
  /** Delay from replay start, ms. */
  delayMs: number;
}

export interface ReplayOptions {
  /** Only the last N messages (mount warm-up replays a few, Replay button all). */
  lastN?: number;
  startDelayMs?: number;
  /** Compressed gap bounds between consecutive messages. */
  minGapMs?: number;
  maxGapMs?: number;
  /** Real-time → replay-time compression factor. */
  compression?: number;
}

/**
 * Order a thread for replay (ascending seq, deduped) and assign compressed
 * delays: real gaps are divided by `compression` and clamped to
 * [minGapMs, maxGapMs], so an hour-long review replays in seconds while
 * keeping its rhythm.
 */
export function scheduleReplay(messages: readonly ReviewMessage[], opts: ReplayOptions = {}): ReplayStep[] {
  const { lastN, startDelayMs = 0, minGapMs = 900, maxGapMs = 2200, compression = 60 } = opts;
  let ordered = mergeMessages([], messages);
  if (lastN != null && lastN >= 0 && ordered.length > lastN) ordered = ordered.slice(ordered.length - lastN);
  const out: ReplayStep[] = [];
  let at = startDelayMs;
  for (let i = 0; i < ordered.length; i++) {
    if (i > 0) {
      const real = Math.max(0, (ordered[i].ts ?? 0) - (ordered[i - 1].ts ?? 0));
      at += Math.min(maxGapMs, Math.max(minGapMs, real / Math.max(1, compression)));
    }
    out.push({ message: ordered[i], delayMs: Math.round(at) });
  }
  return out;
}

/** Threads touched within `windowMs` of `now`, newest first (mount warm-up replay). */
export function recentThreads<T extends { summary: Pick<ReviewThreadSummary, "lastTs"> }>(threads: readonly T[], now: number, windowMs = 10 * 60_000, max = 4): T[] {
  return threads
    .filter((t) => now - (t.summary.lastTs ?? 0) <= windowMs)
    .sort((a, b) => b.summary.lastTs - a.summary.lastTs)
    .slice(0, max);
}

/**
 * Time-ordered packet queue with a concurrency cap. Items become due at their
 * `at` time; `take` hands out at most `cap - active` due items, oldest first.
 * When the backlog exceeds `maxBacklog` the OLDEST queued items are dropped
 * (a stale packet is worse than a missing one).
 */
export class PacketScheduler<T> {
  private queue: Array<{ at: number; n: number; item: T }> = [];
  private counter = 0;

  constructor(readonly maxBacklog = 24) {}

  get length(): number {
    return this.queue.length;
  }

  enqueue(item: T, at: number): void {
    this.queue.push({ at, n: this.counter++, item });
    this.queue.sort((a, b) => a.at - b.at || a.n - b.n);
    if (this.queue.length > this.maxBacklog) this.queue.splice(0, this.queue.length - this.maxBacklog);
  }

  /** Due items (at <= now) up to the free capacity, oldest first. */
  take(now: number, active: number, cap: number, out: T[] = []): T[] {
    out.length = 0;
    let free = cap - active;
    while (free > 0 && this.queue.length && this.queue[0].at <= now) {
      out.push(this.queue.shift()!.item);
      free--;
    }
    return out;
  }

  /** Drop queued items matching `pred` (e.g. a replay being restarted). */
  remove(pred: (item: T) => boolean): void {
    this.queue = this.queue.filter((q) => !pred(q.item));
  }

  clear(): void {
    this.queue.length = 0;
  }
}

// ── LOD ─────────────────────────────────────────────────────────────────────

export interface LodInput {
  zoom: number;
  lowPower: boolean;
  mobile?: boolean;
  reducedMotion?: boolean;
}

export interface LodCaps {
  maxPackets: number;
  maxThumbs: number;
  /** Trail dots drawn behind each packet (0 = no trail). */
  trailDots: number;
  /** Speech-bubble hover targets over packets. */
  packetTargets: boolean;
}

export const MAX_PACKETS = 12;
export const MAX_THUMBS = 12;

export function lodCaps(input: LodInput): LodCaps {
  const { zoom, lowPower, mobile = false, reducedMotion = false } = input;
  let maxPackets = MAX_PACKETS;
  let maxThumbs = MAX_THUMBS;
  let trailDots = 6;
  if (lowPower || reducedMotion) {
    maxPackets = 4;
    maxThumbs = 4;
    trailDots = 0;
  } else if (mobile) {
    maxPackets = 8;
    maxThumbs = 6;
    trailDots = 3;
  }
  if (zoom < 0.32) {
    maxThumbs = 0;
    trailDots = 0;
    maxPackets = Math.min(maxPackets, 6);
  } else if (zoom < 0.55) {
    maxThumbs = Math.min(maxThumbs, 4);
    trailDots = Math.min(trailDots, 3);
  }
  return { maxPackets, maxThumbs, trailDots, packetTargets: zoom >= 0.32 };
}

// ── Geometry ────────────────────────────────────────────────────────────────

export interface MutablePoint {
  x: number;
  y: number;
}

/**
 * Point on the arced packet path a→b at t∈[0,1]: a quadratic bezier whose
 * control point is the midpoint lifted by `lift` px (writes into `out`, no
 * allocation — called per packet per frame).
 */
export function arcPoint(ax: number, ay: number, bx: number, by: number, lift: number, t: number, out: MutablePoint): MutablePoint {
  const cx = (ax + bx) / 2;
  const cy = (ay + by) / 2 - lift;
  const u = 1 - t;
  out.x = u * u * ax + 2 * u * t * cx + t * t * bx;
  out.y = u * u * ay + 2 * u * t * cy + t * t * by;
  return out;
}

/** Arc lift scaled to the distance so short hops don't loop wildly. */
export function arcLift(ax: number, ay: number, bx: number, by: number): number {
  const d = Math.hypot(bx - ax, by - ay);
  return Math.min(220, Math.max(40, d * 0.28));
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * Orbit slots for the screenshot gallery around the island: index 0 (newest)
 * sits on the inner ring nearest the island; later items fill the inner ring
 * then the outer ring. Slots spread across an upper arc (the island's lower
 * side is the bridge to the HQ).
 */
export function orbitSlots(count: number, opts: { innerRadius?: number; outerRadius?: number; perRing?: number; squash?: number } = {}): MutablePoint[] {
  const { innerRadius = 190, outerRadius = 290, perRing = 6, squash = 0.62 } = opts;
  const out: MutablePoint[] = [];
  const start = Math.PI * 1.02; // left
  const end = Math.PI * 1.98; // right, through the top
  for (let i = 0; i < count; i++) {
    const ring = Math.floor(i / perRing);
    const k = i % perRing;
    const r = ring === 0 ? innerRadius : outerRadius + (ring - 1) * 90;
    const n = Math.min(perRing, count - ring * perRing);
    // Alternate around the top centre so the newest is closest to "up".
    const order = k === 0 ? 0 : k % 2 === 1 ? -Math.ceil(k / 2) : Math.ceil(k / 2);
    const span = end - start;
    const step = span / Math.max(perRing, n + 1);
    const a = (start + end) / 2 + order * step + (ring % 2 ? step / 2 : 0);
    out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r * squash });
  }
  return out;
}

// ── Screenshot gallery ─────────────────────────────────────────────────────

export interface GalleryFilter {
  verdict?: "pass" | "fail" | "all";
  route?: string;
  viewport?: string;
  agent?: string;
  q?: string;
  since?: number;
  until?: number;
  runId?: string;
}

export function filterScreenshots(items: readonly ScreenshotEntry[], f: GalleryFilter): ScreenshotEntry[] {
  const q = (f.q ?? "").trim().toLowerCase();
  return items.filter((it) => {
    if (f.verdict && f.verdict !== "all" && it.verdict !== f.verdict) return false;
    if (f.route && it.route !== f.route) return false;
    if (f.viewport && it.viewport !== f.viewport) return false;
    if (f.agent && it.agent !== f.agent) return false;
    if (f.runId && it.runId !== f.runId) return false;
    if (f.since && it.ts < f.since) return false;
    if (f.until && it.ts > f.until) return false;
    if (q) {
      const hay = [it.label, it.route, it.viewport, it.theme, it.agent, it.runId, it.assessment?.summary, ...(it.assessment?.issues ?? [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export interface ScreenshotGroup {
  runId: string;
  label: string;
  agent: string;
  ts: number;
  pass: number;
  fail: number;
  items: ScreenshotEntry[];
}

/** Group by run (newest run first, newest shot first inside). */
export function groupScreenshotsByRun(items: readonly ScreenshotEntry[]): ScreenshotGroup[] {
  const groups = new Map<string, ScreenshotGroup>();
  for (const it of items) {
    let g = groups.get(it.runId);
    if (!g) {
      g = { runId: it.runId, label: it.label || it.runId, agent: it.agent, ts: it.ts, pass: 0, fail: 0, items: [] };
      groups.set(it.runId, g);
    }
    g.items.push(it);
    g.ts = Math.max(g.ts, it.ts);
    if (it.verdict === "pass") g.pass++;
    else if (it.verdict === "fail") g.fail++;
  }
  const out = [...groups.values()];
  for (const g of out) g.items.sort((a, b) => b.ts - a.ts);
  return out.sort((a, b) => b.ts - a.ts);
}

/** Merge screenshot lists (dedupe by id, newest first, capped). */
export function mergeScreenshots(existing: readonly ScreenshotEntry[], incoming: readonly ScreenshotEntry[], cap = 200): ScreenshotEntry[] {
  const byId = new Map<string, ScreenshotEntry>();
  for (const it of existing) byId.set(it.id, it);
  for (const it of incoming) byId.set(it.id, it);
  return [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, cap);
}

/** Distinct non-empty values of a field, sorted (filter dropdowns). */
export function distinctValues(items: readonly ScreenshotEntry[], key: "route" | "viewport" | "agent" | "theme"): string[] {
  const set = new Set<string>();
  for (const it of items) {
    const v = it[key];
    if (typeof v === "string" && v) set.add(v);
  }
  return [...set].sort();
}

// ── Formatting ─────────────────────────────────────────────────────────────

export function relativeTime(ts: number, now: number): string {
  const d = Math.max(0, now - ts);
  if (d < 45_000) return "just now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

export function clockTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** Readable name for an agent id ("auditor" / "agent:main:subagent:abc"). */
export function agentDisplayName(agentId: string, label?: string): string {
  if (agentId === REVIEWER_ID) return "Auditor";
  if (label) return label.length > 28 ? `${label.slice(0, 27)}…` : label;
  const parts = agentId.split(":");
  const tail = parts[parts.length - 1] || agentId;
  return tail.length > 18 ? `${tail.slice(0, 17)}…` : tail;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
