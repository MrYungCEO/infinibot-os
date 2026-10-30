/**
 * Artifact Telegram delivery — auto-send a finished run's visual artifacts
 * (screenshots under its artifacts dir) to the operator's Telegram DM.
 *
 * Integration point: the spawn-ledger ndjson (`~/.infinibot/subagents/
 * spawn-ledger.ndjson`). Run finalize appends a `run.ended` event there for
 * every spawned run (any node, any backend), so a small tail-watcher on that
 * file observes run completion WITHOUT touching the finalize code paths in
 * subagent-registry / claude-coder-tool / subagents.handlers. Started from
 * `server-startup.ts` alongside the other notification sidecars.
 *
 * Reliability rules:
 *   - per-runId dedupe persisted to `<stateDir>/subagents/
 *     artifact-delivery-ledger.json` — a runId is recorded BEFORE the first
 *     send attempt (at-most-once), so a gateway restart never double-sends.
 *   - everything is best-effort: a Telegram failure is logged and swallowed;
 *     nothing here can affect run finalize (we only observe the ledger file).
 *   - config kill-switch: `coder.artifactTelegramDelivery: false` in
 *     infinibot.json disables delivery without code changes (default true).
 *   - Telegram sendPhoto caps uploads around 10MB — images over 9MB are
 *     skipped with a note in the caption.
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ARTIFACT_FILES, resolveRunArtifactsDir } from "./artifacts/contract.js";

const log = createSubsystemLogger("agents/artifact-delivery");

/** Max images sent per run (newest first). */
export const MAX_IMAGES_PER_RUN = 8;
/** Telegram sendPhoto rejects near 10MB — skip anything over this. */
export const MAX_IMAGE_BYTES = 9 * 1024 * 1024;
/** Image extensions we deliver. */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
/** How far back a run.ended event may lie and still be delivered on catch-up. */
const MAX_EVENT_AGE_MS = 15 * 60 * 1000;
/** Tail-poll cadence for the spawn ledger. */
const DEFAULT_POLL_MS = 4000;
/** Recursion guard for the artifacts-dir image scan. */
const MAX_SCAN_DEPTH = 4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunEndedEvent {
  ts: number;
  runId: string;
  outcome: "ok" | "error" | "interrupted" | "timeout";
  /** Best-effort, folded from the run's spawn.intent line when present. */
  label?: string;
}

export interface TelegramPhotoRequest {
  botToken: string;
  chatId: string;
  filePath: string;
  caption: string;
}

export interface TelegramSendResult {
  ok: boolean;
  error?: string;
}

/** Injectable seams so the manual test script can fake everything. */
export interface DeliveryDeps {
  /** State dir root (default: resolveStateDir()). */
  stateDir?: string;
  /** infinibot.json path (default: resolveConfigPath()). */
  configPath?: string;
  /** Photo sender (default: real Telegram Bot API sendPhoto). */
  sendPhoto?: (req: TelegramPhotoRequest) => Promise<TelegramSendResult>;
  /** Clock, for age filtering in tests. */
  now?: () => number;
}

export interface DeliveryOutcome {
  status: "sent" | "skipped" | "failed";
  /** Photos successfully delivered. */
  sent: number;
  reason?: string;
}

interface DedupeLedger {
  v: 1;
  runs: Record<string, { ts: number; status: string; sent?: number; note?: string }>;
}

interface FoundImage {
  path: string;
  rel: string;
  size: number;
  mtimeMs: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface TelegramChannelConfig {
  enabled?: boolean;
  botToken?: string;
  defaultChatId?: string | number;
}

function loadDeliveryConfig(configPath: string): {
  deliveryEnabled: boolean;
  telegram: TelegramChannelConfig | null;
} {
  try {
    const raw = readFileSync(configPath, "utf8");
    const cfg = JSON.parse(raw) as {
      coder?: { artifactTelegramDelivery?: boolean };
      channels?: { telegram?: TelegramChannelConfig };
    };
    return {
      deliveryEnabled: cfg.coder?.artifactTelegramDelivery !== false,
      telegram: cfg.channels?.telegram ?? null,
    };
  } catch {
    return { deliveryEnabled: true, telegram: null };
  }
}

// ---------------------------------------------------------------------------
// Dedupe ledger
// ---------------------------------------------------------------------------

function dedupeLedgerPath(stateDir: string): string {
  return join(stateDir, "subagents", "artifact-delivery-ledger.json");
}

function readDedupeLedger(path: string): DedupeLedger {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DedupeLedger;
    if (parsed && parsed.v === 1 && typeof parsed.runs === "object" && parsed.runs !== null) {
      return parsed;
    }
  } catch {
    // Missing or corrupt — start fresh.
  }
  return { v: 1, runs: {} };
}

function writeDedupeLedger(path: string, ledger: DedupeLedger): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(ledger, null, 2), "utf8");
    renameSync(tmp, path);
  } catch (err) {
    log.warn("dedupe ledger write failed", {
      path,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Artifacts scanning
// ---------------------------------------------------------------------------

/** Resolve the run's artifacts dir: contract path first, then any agent namespace. */
export function findArtifactsDir(runId: string, stateDir: string): string | null {
  const contractDir = resolveRunArtifactsDir(runId, stateDir);
  if (existsSync(contractDir)) return contractDir;
  try {
    const agentsRoot = join(stateDir, "agents");
    for (const agent of readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!agent.isDirectory()) continue;
      const candidate = join(agentsRoot, agent.name, "runs", runId, "artifacts");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // agents root absent — nothing to deliver
  }
  return null;
}

/** Recursively collect image files under the artifacts dir, newest first. */
export function collectImages(dir: string): FoundImage[] {
  const found: FoundImage[] = [];
  const walk = (current: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && IMAGE_EXTS.has(extname(entry.name).toLowerCase())) {
        try {
          const st = statSync(full);
          found.push({ path: full, rel: relative(dir, full), size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // raced deletion — skip
        }
      }
    }
  };
  walk(dir, 0);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found;
}

/** Pull the verdict line (`SHIP` / `DO-NOT-SHIP`) out of verification.md, if present. */
export function readVerificationVerdict(artifactsDir: string): string | null {
  try {
    const raw = readFileSync(join(artifactsDir, ARTIFACT_FILES.verification), "utf8");
    const lines = raw.split("\n").map((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^`?(SHIP|DO-NOT-SHIP)`?\b/.test(lines[i])) {
        return lines[i].replace(/`/g, "");
      }
    }
  } catch {
    // verification.md absent (verifier may still be running) — best-effort only
  }
  return null;
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

const PHOTO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** Real Telegram Bot API sendPhoto. Never throws. */
export async function sendPhotoTelegram(req: TelegramPhotoRequest): Promise<TelegramSendResult> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(req.filePath);
  } catch (err) {
    return { ok: false, error: `cannot read ${req.filePath}: ${(err as Error).message}` };
  }
  try {
    const form = new FormData();
    form.append("chat_id", req.chatId);
    form.append("caption", req.caption.slice(0, 1024));
    const mime = PHOTO_MIME[extname(req.filePath).toLowerCase()] ?? "application/octet-stream";
    form.append(
      "photo",
      new Blob([new Uint8Array(bytes)], { type: mime }),
      basename(req.filePath),
    );
    const res = await fetch(`https://api.telegram.org/bot${req.botToken}/sendPhoto`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!res.ok || !json.ok) return { ok: false, error: json.description ?? `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Core delivery
// ---------------------------------------------------------------------------

/**
 * Deliver one finished run's images to Telegram. Dedupes by runId (persisted),
 * caps at MAX_IMAGES_PER_RUN newest images, skips >9MB files with a caption
 * note. Never throws.
 */
export async function deliverRunArtifacts(
  event: RunEndedEvent,
  deps: DeliveryDeps = {},
): Promise<DeliveryOutcome> {
  const stateDir = deps.stateDir ?? resolveStateDir();
  const configPath = deps.configPath ?? resolveConfigPath();
  const send = deps.sendPhoto ?? sendPhotoTelegram;

  try {
    const ledgerFile = dedupeLedgerPath(stateDir);
    const ledger = readDedupeLedger(ledgerFile);
    if (ledger.runs[event.runId]) {
      return { status: "skipped", sent: 0, reason: "already delivered (dedupe ledger)" };
    }

    const { deliveryEnabled, telegram } = loadDeliveryConfig(configPath);
    if (!deliveryEnabled) {
      return { status: "skipped", sent: 0, reason: "coder.artifactTelegramDelivery is false" };
    }
    if (!telegram || telegram.enabled === false || !telegram.botToken || !telegram.defaultChatId) {
      return { status: "skipped", sent: 0, reason: "telegram channel disabled or unconfigured" };
    }

    const artifactsDir = findArtifactsDir(event.runId, stateDir);
    if (!artifactsDir) {
      return { status: "skipped", sent: 0, reason: "no artifacts dir" };
    }

    const all = collectImages(artifactsDir);
    if (all.length === 0) {
      return { status: "skipped", sent: 0, reason: "no images in artifacts" };
    }

    const oversize = all.filter((img) => img.size > MAX_IMAGE_BYTES);
    const sendable = all.filter((img) => img.size <= MAX_IMAGE_BYTES);
    const picked = sendable.slice(0, MAX_IMAGES_PER_RUN);
    const remaining = sendable.length - picked.length;

    // Record BEFORE sending — at-most-once across restarts beats a re-send storm.
    ledger.runs[event.runId] = { ts: Date.now(), status: "sending" };
    writeDedupeLedger(ledgerFile, ledger);

    const verdict = readVerificationVerdict(artifactsDir);
    const label = event.label?.trim() || event.runId;
    const header = `🖼 ${label} — ${event.runId} [${event.outcome}]`;

    let sent = 0;
    let lastError: string | undefined;
    for (let i = 0; i < picked.length; i++) {
      const img = picked[i];
      const parts = [header, img.rel];
      if (i === 0 && verdict) parts.push(`verdict: ${verdict}`);
      if (i === picked.length - 1) {
        if (remaining > 0) parts.push(`+${remaining} more in artifacts`);
        if (oversize.length > 0) parts.push(`${oversize.length} image(s) >9MB skipped`);
      }
      const result = await send({
        botToken: telegram.botToken,
        chatId: String(telegram.defaultChatId),
        filePath: img.path,
        caption: parts.join("\n"),
      });
      if (result.ok) {
        sent++;
      } else {
        lastError = result.error;
        log.warn("sendPhoto failed", { runId: event.runId, file: img.rel, err: result.error });
      }
    }

    const status: DeliveryOutcome["status"] = sent > 0 ? "sent" : "failed";
    ledger.runs[event.runId] = {
      ts: Date.now(),
      status,
      sent,
      note: lastError,
    };
    writeDedupeLedger(ledgerFile, ledger);
    log.info("run artifacts delivered", {
      runId: event.runId,
      sent,
      total: all.length,
      oversize: oversize.length,
    });
    return { status, sent, reason: lastError };
  } catch (err) {
    // Absolute backstop — delivery must never propagate into anything.
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("artifact delivery crashed", { runId: event.runId, err: msg });
    return { status: "failed", sent: 0, reason: msg };
  }
}

// ---------------------------------------------------------------------------
// Spawn-ledger tail watcher
// ---------------------------------------------------------------------------

interface WatcherState {
  timer: NodeJS.Timeout;
  offset: number;
  partial: string;
  labels: Map<string, string>;
  processing: Promise<void>;
}

let watcher: WatcherState | null = null;

function spawnLedgerPath(stateDir: string): string {
  return join(stateDir, "subagents", "spawn-ledger.ndjson");
}

/** Read bytes [offset, size) from the ledger file. */
function readAppended(path: string, offset: number, size: number): string {
  const length = size - offset;
  if (length <= 0) return "";
  const buf = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    const bytesRead = readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Start the spawn-ledger tail watcher. Idempotent; never throws. Reads the
 * ledger from the top on boot (spawn.intent lines feed the runId→label map;
 * run.ended lines older than MAX_EVENT_AGE_MS are ignored — the persisted
 * dedupe ledger keeps the recent ones from double-sending after a restart),
 * then polls for appended lines.
 */
export function startArtifactDelivery(
  opts: { pollMs?: number } & DeliveryDeps = {},
): void {
  if (watcher) return;
  const stateDir = opts.stateDir ?? resolveStateDir();
  const ledger = spawnLedgerPath(stateDir);
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;

  const state: WatcherState = {
    timer: undefined as unknown as NodeJS.Timeout,
    offset: 0,
    partial: "",
    labels: new Map(),
    processing: Promise.resolve(),
  };

  const handleLine = (line: string): void => {
    let ev: {
      v?: number;
      ts?: number;
      event?: string;
      runId?: string;
      label?: string;
      task?: string;
      outcome?: RunEndedEvent["outcome"];
    };
    try {
      ev = JSON.parse(line);
    } catch {
      return; // torn or foreign line
    }
    if (!ev || ev.v !== 1 || typeof ev.runId !== "string") return;
    if (ev.event === "spawn.intent") {
      const label = ev.label || (typeof ev.task === "string" ? ev.task.slice(0, 80) : "");
      if (label) state.labels.set(ev.runId, label);
      return;
    }
    if (ev.event !== "run.ended") return;
    const ts = typeof ev.ts === "number" ? ev.ts : 0;
    if (now() - ts > MAX_EVENT_AGE_MS) return; // stale history — dedupe ledger has it anyway
    const event: RunEndedEvent = {
      ts,
      runId: ev.runId,
      outcome: ev.outcome ?? "ok",
      label: state.labels.get(ev.runId),
    };
    // Serialize deliveries; fire-and-forget from the poller's perspective.
    state.processing = state.processing.then(() =>
      deliverRunArtifacts(event, opts).then(() => undefined),
    );
  };

  const poll = (): void => {
    try {
      let size: number;
      try {
        size = statSync(ledger).size;
      } catch {
        return; // ledger not created yet
      }
      if (size < state.offset) {
        // Compaction rewrote the file — rescan from the top (dedupe protects us).
        state.offset = 0;
        state.partial = "";
      }
      if (size === state.offset) return;
      const chunk = state.partial + readAppended(ledger, state.offset, size);
      state.offset = size;
      const lines = chunk.split("\n");
      state.partial = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) handleLine(trimmed);
      }
    } catch (err) {
      log.warn("spawn-ledger poll failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  poll(); // catch-up pass (labels + recent run.ended)
  state.timer = setInterval(poll, pollMs);
  state.timer.unref?.();
  watcher = state;
  log.info("artifact delivery watcher started", { ledger, pollMs });
}

/** Stop the watcher and wait for in-flight deliveries (tests + shutdown). */
export async function stopArtifactDelivery(): Promise<void> {
  if (!watcher) return;
  clearInterval(watcher.timer);
  const pending = watcher.processing;
  watcher = null;
  await pending;
}
