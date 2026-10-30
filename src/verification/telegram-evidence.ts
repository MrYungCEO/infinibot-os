/**
 * Verification screenshots on Telegram — every completion / verdict message
 * about a run gets that run's best screenshots as a reply-threaded album.
 *
 * Sources, best first:
 *   1. `<stateDir>/verification/<runId>/result-shots/` (screenshots the run
 *      listed in its RESULT, copied there by the screenshot index);
 *   2. screenshots the review recorded (`rec.review.screenshots`);
 *   3. `<runId>/visual-*` visual_verify captures, newest first.
 *
 * Skipped: sign-in / login walls (by filename), tiny or blank images.
 * "after" / "live" / "final" shots rank above "before". Near-identical images
 * collapse into one (exact sha256 + 64-bit dHash). At most
 * `notifications.telegram.maxVerificationScreenshots` (default 6) go out.
 *
 * Secure Mode runs never send screenshots. Image sending is best effort: it
 * never throws and never delays the text message it belongs to.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { secureOnlyBlockReason } from "../secure-mode/agent-policy.js";
import { isSecureSessionKey } from "../secure-mode/session-key.js";
import { getRecord, verificationRunDir, type CompletionRecord } from "./store.js";

const log = createSubsystemLogger("verification.telegram-evidence");

export const DEFAULT_MAX_SCREENSHOTS = 6;
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const SIGN_IN_RE = /(^|[^a-z])(sign[_\s-]?in|log[_\s-]?in|login|signin|auth[_\s-]?wall)/i;
/** Telegram photo limits: 10 MB, width + height ≤ 10000, aspect ratio ≤ 20. */
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PHOTO_MAX_SIDE = 2560;
const PHOTO_MAX_RATIO = 20;
const MIN_FILE_BYTES = 1500;
const MIN_SIDE_PX = 64;
const DHASH_NEAR = 4;

export interface EvidenceCandidate {
  path: string;
  source: "result" | "review" | "visual";
  name: string;
  mtimeMs: number;
  size: number;
}

export interface EvidenceShot extends EvidenceCandidate {
  caption: string;
  sha256: string;
  dhash: bigint | null;
  width: number | null;
  height: number | null;
}

export interface EvidenceSelection {
  picked: EvidenceShot[];
  /** Usable distinct screenshots found (picked + the rest past the cap). */
  total: number;
  more: number;
  skipped: Array<{
    path: string;
    reason: "sign_in" | "tiny" | "blank" | "duplicate" | "unreadable";
  }>;
}

export interface EvidenceSettings {
  enabled: boolean;
  max: number;
}

export function readEvidenceSettings(): EvidenceSettings {
  try {
    const raw = (loadConfig() as { notifications?: { telegram?: Record<string, unknown> } })
      .notifications?.telegram;
    const max =
      typeof raw?.maxVerificationScreenshots === "number" ? raw.maxVerificationScreenshots : 0;
    return {
      enabled: raw?.attachVerificationScreenshots !== false,
      max: max >= 1 ? Math.min(10, Math.floor(max)) : DEFAULT_MAX_SCREENSHOTS,
    };
  } catch {
    return { enabled: true, max: DEFAULT_MAX_SCREENSHOTS };
  }
}

/** Secure-lane run: nothing about it — least of all screenshots — leaves the machine. */
export function isSecureRun(
  rec:
    | Pick<CompletionRecord, "childSessionKey" | "requesterSessionKey" | "tags">
    | null
    | undefined,
  extraSessionKeys: Array<string | null | undefined> = [],
): boolean {
  const keys = [rec?.childSessionKey, rec?.requesterSessionKey, ...extraSessionKeys];
  if (keys.some((k) => isSecureSessionKey(k))) return true;
  // A run of an agent set to always run in Secure Mode (fail closed).
  try {
    const cfg = loadConfig();
    if (keys.some((k) => k && secureOnlyBlockReason(cfg, k) !== null)) return true;
  } catch {
    /* config unreadable: session keys decide */
  }
  const lane = rec?.tags?.lane ?? rec?.tags?.secure;
  return lane === "secure" || lane === "1" || lane === "true";
}

// ── Candidate discovery ──────────────────────────────────────────────────────

function listImages(dir: string, source: EvidenceCandidate["source"]): EvidenceCandidate[] {
  try {
    return readdirSync(dir)
      .filter((f) => IMAGE_RE.test(f))
      .flatMap((f) => {
        const p = path.join(dir, f);
        try {
          const st = statSync(p);
          return st.isFile()
            ? [{ path: p, source, name: f, mtimeMs: st.mtimeMs, size: st.size }]
            : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** Every screenshot a run produced, unfiltered. */
export function collectEvidenceCandidates(
  runId: string,
  rec?: CompletionRecord | null,
): EvidenceCandidate[] {
  const runDir = verificationRunDir(runId);
  const out: EvidenceCandidate[] = [...listImages(path.join(runDir, "result-shots"), "result")];
  for (const p of rec?.review?.screenshots ?? []) {
    if (!p || !IMAGE_RE.test(p) || !path.isAbsolute(p) || !existsSync(p)) continue;
    try {
      const st = statSync(p);
      if (st.isFile())
        out.push({
          path: p,
          source: "review",
          name: path.basename(p),
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
    } catch {
      /* gone */
    }
  }
  const visualDirs = new Set<string>();
  try {
    for (const d of readdirSync(runDir))
      if (d.startsWith("visual-")) visualDirs.add(path.join(runDir, d));
  } catch {
    /* no run dir */
  }
  for (const d of rec?.visualDirs ?? []) if (d && existsSync(d)) visualDirs.add(d);
  for (const d of visualDirs) out.push(...listImages(d, "visual"));
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)));
}

// ── Ranking + captions ───────────────────────────────────────────────────────

const SOURCE_RANK: Record<EvidenceCandidate["source"], number> = {
  result: 0,
  review: 1,
  visual: 2,
};

/** after / live / final first, before last. */
export function phaseScore(name: string): number {
  const n = name.toLowerCase();
  if (/(^|[^a-z])before([^a-z]|$)/.test(n)) return 2;
  if (/(^|[^a-z])(after|live|final|fixed)([^a-z]|$)/.test(n)) return 0;
  return 1;
}

export function rankCandidates(cands: EvidenceCandidate[]): EvidenceCandidate[] {
  return [...cands].sort(
    (a, b) =>
      SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
      phaseScore(a.name) - phaseScore(b.name) ||
      b.mtimeMs - a.mtimeMs ||
      a.name.localeCompare(b.name),
  );
}

export function isSignInShot(name: string): boolean {
  return SIGN_IN_RE.test(name.replace(/\.[a-z]+$/i, ""));
}

/** "a053b8b5-api-keys-mobile.png" → "api keys · mobile"; "chat__desktop__dark.png" → "chat · desktop · dark". */
export function captionFromFilename(name: string): string {
  let base = name.replace(/\.[a-z0-9]+$/i, "");
  base = base.replace(/^[0-9a-f]{6,12}[-_]/i, "");
  const parts = base
    .split(/__+/)
    .map((p) => p.replace(/[-_]+/g, " ").trim())
    .filter(Boolean);
  const out = parts.join(" · ");
  return (out || name).slice(0, 80);
}

// ── Pixel checks (sharp, lazily; size-only when unavailable) ─────────────────

type Sharp = typeof import("sharp");
let sharpPromise: Promise<Sharp | null> | null = null;
function loadSharp(): Promise<Sharp | null> {
  sharpPromise ??= import("sharp")
    .then((m) => (m as unknown as { default?: Sharp }).default ?? (m as unknown as Sharp))
    .catch(() => null);
  return sharpPromise;
}

interface PixelInfo {
  width: number;
  height: number;
  blank: boolean;
  dhash: bigint | null;
}

async function inspectPixels(buf: Buffer): Promise<PixelInfo | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;
  const meta = await sharp(buf).metadata();
  const stats = await sharp(buf).stats();
  // Blank: every colour channel is (nearly) flat.
  const blank = stats.channels.slice(0, 3).every((c) => c.stdev < 2.5);
  // dHash: 9×8 greyscale, compare horizontal neighbours → 64 bits.
  const px = await sharp(buf).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let dhash = 0n;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      dhash = (dhash << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
    }
  return { width: meta.width ?? 0, height: meta.height ?? 0, blank, dhash };
}

function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

// ── Selection ────────────────────────────────────────────────────────────────

export async function selectVerificationEvidence(
  runId: string,
  opts: { max?: number; record?: CompletionRecord | null; exclude?: Set<string> } = {},
): Promise<EvidenceSelection> {
  const max = opts.max ?? DEFAULT_MAX_SCREENSHOTS;
  const rec = opts.record !== undefined ? opts.record : getRecord(runId);
  const ranked = rankCandidates(collectEvidenceCandidates(runId, rec));
  const kept: EvidenceShot[] = [];
  const skipped: EvidenceSelection["skipped"] = [];
  for (const c of ranked) {
    if (isSignInShot(c.name)) {
      skipped.push({ path: c.path, reason: "sign_in" });
      continue;
    }
    if (c.size < MIN_FILE_BYTES) {
      skipped.push({ path: c.path, reason: "tiny" });
      continue;
    }
    let buf: Buffer;
    try {
      buf = readFileSync(c.path);
    } catch {
      skipped.push({ path: c.path, reason: "unreadable" });
      continue;
    }
    const sha256 = createHash("sha256").update(buf).digest("hex");
    let pix: PixelInfo | null = null;
    try {
      pix = await inspectPixels(buf);
    } catch {
      skipped.push({ path: c.path, reason: "unreadable" });
      continue;
    }
    if (pix && (pix.width < MIN_SIDE_PX || pix.height < MIN_SIDE_PX)) {
      skipped.push({ path: c.path, reason: "tiny" });
      continue;
    }
    if (pix?.blank) {
      skipped.push({ path: c.path, reason: "blank" });
      continue;
    }
    const dup = kept.some(
      (k) =>
        k.sha256 === sha256 ||
        (k.dhash != null &&
          pix?.dhash != null &&
          hamming(k.dhash, pix.dhash) <= DHASH_NEAR &&
          // Same layout class: a phone and a desktop shot of one page are both worth sending.
          aspectClass(k.width, k.height) === aspectClass(pix.width, pix.height)),
    );
    if (dup || opts.exclude?.has(sha256)) {
      skipped.push({ path: c.path, reason: "duplicate" });
      continue;
    }
    kept.push({
      ...c,
      caption: captionFromFilename(c.name),
      sha256,
      dhash: pix?.dhash ?? null,
      width: pix?.width ?? null,
      height: pix?.height ?? null,
    });
  }
  const picked = kept.slice(0, Math.max(0, max));
  return { picked, total: kept.length, more: Math.max(0, kept.length - picked.length), skipped };
}

function aspectClass(w: number | null, h: number | null): string {
  if (!w || !h) return "?";
  const r = w / h;
  return r < 0.8 ? "tall" : r > 1.25 ? "wide" : "square";
}

// ── Telegram payload ─────────────────────────────────────────────────────────

const STATE_LABEL: Record<string, string> = {
  verified: "✅ VERIFIED",
  accepted: "✅ ACCEPTED",
  unverified: "🟡 UNVERIFIED — what the reviewer checked",
  failed: "❌ FAILED — what the reviewer checked",
  stalled: "⏸ STALLED — evidence so far",
  blocked: "⛔ BLOCKED — evidence so far",
  needs_input: "❓ NEEDS INPUT — evidence so far",
  needs_owner: "🙋 NEEDS YOU — evidence so far",
  rejected: "✖️ REJECTED — what was checked",
};

/** One line for the text message: what is (or is not) attached below it. */
export function evidenceSummaryLine(
  sel: Pick<EvidenceSelection, "picked" | "more"> | null,
): string {
  if (!sel || sel.picked.length === 0) return "📷 no visual evidence";
  const n = sel.picked.length;
  return `📸 ${n} screenshot${n === 1 ? "" : "s"} attached below${sel.more ? ` · +${sel.more} more in the run's evidence` : ""}`;
}

/** Compress to fit Telegram's photo limits; very tall/wide or uncompressible → document. */
export async function prepareTelegramImage(
  shot: Pick<EvidenceShot, "path" | "name" | "width" | "height">,
): Promise<{ buffer: Buffer; fileName: string; asDocument: boolean }> {
  const raw = readFileSync(shot.path);
  const w = shot.width ?? 0;
  const h = shot.height ?? 0;
  const ratio = w && h ? Math.max(w / h, h / w) : 1;
  if (ratio > PHOTO_MAX_RATIO) return { buffer: raw, fileName: shot.name, asDocument: true };
  const fits = raw.length <= PHOTO_MAX_BYTES && w + h <= 10_000 && Math.max(w, h) <= PHOTO_MAX_SIDE;
  if (fits && w && h) return { buffer: raw, fileName: shot.name, asDocument: false };
  const sharp = await loadSharp();
  if (sharp) {
    for (const quality of [85, 70, 55]) {
      try {
        const out = await sharp(raw)
          .resize({
            width: PHOTO_MAX_SIDE,
            height: PHOTO_MAX_SIDE,
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({ quality, mozjpeg: true })
          .toBuffer();
        if (out.length <= PHOTO_MAX_BYTES)
          return {
            buffer: out,
            fileName: shot.name.replace(/\.[a-z0-9]+$/i, ".jpg"),
            asDocument: false,
          };
      } catch {
        break;
      }
    }
  }
  // Could not shrink it below Telegram's photo limits: send the file itself
  // (documents allow up to 50 MB).
  return { buffer: raw, fileName: shot.name, asDocument: raw.length > PHOTO_MAX_BYTES || !w };
}

// ── Already-sent ledger (one image per chat per run) ─────────────────────────

const SENT_TTL_MS = 6 * 60 * 60_000;
const sentLedger = new Map<string, { ts: number; hashes: Set<string> }>();

function ledgerFor(chatId: string, runId: string): Set<string> {
  const now = Date.now();
  for (const [k, v] of sentLedger) if (now - v.ts > SENT_TTL_MS) sentLedger.delete(k);
  const key = `${chatId}|${runId}`;
  let entry = sentLedger.get(key);
  if (!entry) {
    entry = { ts: now, hashes: new Set() };
    sentLedger.set(key, entry);
  }
  return entry.hashes;
}

export function resetEvidenceLedgerForTests(): void {
  sentLedger.clear();
}

// ── Public helper ────────────────────────────────────────────────────────────

export interface AttachEvidenceOptions {
  chatId?: string;
  token?: string;
  accountId?: string;
  /** Verdict state for the first caption (defaults to the record's state). */
  state?: string | null;
  /** Extra session keys to test for the Secure Mode lane. */
  sessionKeys?: Array<string | null | undefined>;
  silent?: boolean;
  max?: number;
  /** A selection made earlier (so the text line and the album agree). */
  selection?: EvidenceSelection;
  /** Prefix for the first caption, e.g. "TEST: auto-attached verification screenshots". */
  captionPrefix?: string;
  /** Injected for tests. */
  send?: typeof import("../telegram/send.js").sendMediaGroupTelegram;
  api?: import("grammy").Bot["api"];
  retry?: import("../infra/retry.js").RetryConfig;
}

export interface AttachEvidenceResult {
  ok: boolean;
  sent: number;
  more: number;
  messageIds: string[];
  skipped?: "disabled" | "secure" | "no_chat" | "none" | "already_sent";
  error?: string;
}

/**
 * Pick a run's best screenshots and send them as an album replying to
 * `replyToMessageId`. Never throws; failures come back as `{ ok:false, error }`.
 */
export async function attachVerificationEvidence(
  runId: string,
  replyToMessageId: number | string | null | undefined,
  opts: AttachEvidenceOptions = {},
): Promise<AttachEvidenceResult> {
  const empty = (skipped: AttachEvidenceResult["skipped"], more = 0): AttachEvidenceResult => ({
    ok: true,
    sent: 0,
    more,
    messageIds: [],
    skipped,
  });
  try {
    const settings = readEvidenceSettings();
    if (!settings.enabled) return empty("disabled");
    const rec = getRecord(runId) ?? null;
    if (isSecureRun(rec, opts.sessionKeys)) return empty("secure");
    let chatId = opts.chatId?.trim() ?? "";
    if (!chatId) {
      const { resolveOwnerTelegramChatId } = await import("../telegram/owner-chat.js");
      chatId = resolveOwnerTelegramChatId(loadConfig().channels?.telegram) ?? "";
    }
    if (!chatId) return empty("no_chat");
    const already = ledgerFor(chatId, runId);
    const sel =
      opts.selection ??
      (await selectVerificationEvidence(runId, {
        max: opts.max ?? settings.max,
        record: rec,
      }));
    const fresh = sel.picked.filter((s) => !already.has(s.sha256));
    if (!sel.picked.length) return empty("none", sel.more);
    if (!fresh.length) return empty("already_sent", sel.more);

    const state = opts.state ?? rec?.state ?? null;
    const head = [
      opts.captionPrefix,
      state ? (STATE_LABEL[state] ?? state.toUpperCase()) : null,
      rec?.label ? rec.label.slice(0, 120) : null,
    ]
      .filter(Boolean)
      .join("\n");
    const items = [];
    for (const [i, shot] of fresh.entries()) {
      const img = await prepareTelegramImage(shot);
      const lines = [
        i === 0 && head ? head : null,
        `${i + 1}/${fresh.length} · ${shot.caption}`,
        i === fresh.length - 1 && sel.more ? `+${sel.more} more in the run's evidence` : null,
      ].filter(Boolean);
      items.push({ ...img, caption: lines.join("\n") });
    }
    const send = opts.send ?? (await import("../telegram/send.js")).sendMediaGroupTelegram;
    const replyTo = Number(replyToMessageId);
    const res = await send(chatId, items, {
      token: opts.token || undefined,
      accountId: opts.accountId,
      api: opts.api,
      retry: opts.retry,
      silent: opts.silent,
      ...(Number.isFinite(replyTo) && replyTo > 0 ? { replyToMessageId: replyTo } : {}),
    });
    for (const s of fresh) already.add(s.sha256);
    log.info("attached verification screenshots", {
      runId,
      chatId,
      replyTo: Number.isFinite(replyTo) ? replyTo : null,
      sent: fresh.length,
      more: sel.more,
      messageIds: res.messageIds.join(","),
    });
    return { ok: true, sent: fresh.length, more: sel.more, messageIds: res.messageIds };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn("attaching verification screenshots failed", { runId, error });
    return { ok: false, sent: 0, more: 0, messageIds: [], error };
  }
}

/**
 * The run a message is about: the explicit id, else a `runId: <id>` mention or
 * a bare `coder-…` id in the text — only when the gate knows that run.
 */
export function resolveEvidenceRunId(
  explicit: string | null | undefined,
  text = "",
): string | null {
  const id = explicit?.trim();
  if (id) return id;
  const found = new Set<string>();
  for (const m of text.matchAll(/run\s*id\s*[:=`\s]\s*`?([A-Za-z0-9._-]{6,})/gi)) found.add(m[1]);
  for (const m of text.matchAll(/\b(coder-[a-z0-9][a-z0-9-]{5,})\b/gi)) found.add(m[1]);
  for (const c of found) if (getRecord(c)) return c;
  return null;
}

/** True when the verification gate tracks this run or it left captures on disk. */
export function hasVerificationEvidence(runId: string): boolean {
  try {
    return Boolean(getRecord(runId)) || existsSync(verificationRunDir(runId));
  } catch {
    return false;
  }
}

/** Selection for the text line, or null for secure / disabled runs (say nothing about images). */
export async function planVerificationEvidence(
  runId: string,
  sessionKeys: Array<string | null | undefined> = [],
): Promise<EvidenceSelection | null> {
  try {
    const settings = readEvidenceSettings();
    if (!settings.enabled) return null;
    const rec = getRecord(runId) ?? null;
    if (isSecureRun(rec, sessionKeys)) return null;
    return await selectVerificationEvidence(runId, { max: settings.max, record: rec });
  } catch {
    return null;
  }
}
