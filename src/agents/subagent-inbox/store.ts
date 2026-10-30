/**
 * In-flight operator inbox for coder sub-agents — durable, file-backed store.
 *
 * WHY FILES (not the in-memory registry): delivery happens OUTSIDE the gateway.
 * A Claude Code child drains its inbox from a PostToolUse / Stop hook, an
 * OpenCode child from a `tool.execute.after` plugin — both run inside the CLI
 * process, which (on the durable tmux path) outlives a gateway restart. The
 * hook reads and writes these files directly, so messages queued before a
 * restart are still delivered while the gateway is down, and the gateway picks
 * the delivery/ack trail back up when it boots.
 *
 * Layout: `<stateDir>/subagents/inbox/<runId>/`
 *   messages.jsonl — one {@link InboxMessageRecord} per operator message (append-only)
 *   events.jsonl   — one {@link InboxEventRecord} per state change (append-only)
 *   .lock/         — mkdir-based mutex held while claiming (atomic on POSIX + Windows)
 *
 * Status is a fold over the event log: queued → delivered → acknowledged, or
 * queued → expired when the run ends before anything drained it. Append-only
 * logs mean concurrent writers (gateway + hook + plugin) never clobber each
 * other; the lock only serialises *claiming* so a message is delivered once.
 *
 * The standalone hook script (hook-scripts.ts) reimplements claim/format in
 * dependency-free JS against this exact layout — keep the two in sync; the
 * unit tests execute the real hook script against a store written here.
 */

import crypto from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../../config/paths.js";

export type InboxMessageStatus = "queued" | "delivered" | "acknowledged" | "expired";

/** How a message reached (or will reach) the running agent. */
export type InboxDeliveryVia =
  | "claude-hook:PostToolUse"
  | "claude-hook:Stop"
  | "opencode-plugin"
  | "mcp-piggyback"
  | "inbox-tool";

export interface InboxMessageRecord {
  id: string;
  runId: string;
  text: string;
  /** Free-form sender label (requester session key, "operator", "ui"). */
  from: string;
  createdAt: number;
  childSessionKey?: string;
}

export interface InboxEventRecord {
  id: string;
  type: "delivered" | "acked" | "expired";
  at: number;
  via?: string;
  note?: string;
}

export interface InboxMessage extends InboxMessageRecord {
  status: InboxMessageStatus;
  deliveredAt?: number;
  deliveredVia?: string;
  ackedAt?: number;
  ackedVia?: string;
  expiredAt?: number;
  expiredNote?: string;
}

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;

/** Root that holds every run's inbox dir. */
export function inboxRootDir(): string {
  return path.join(resolveStateDir(), "subagents", "inbox");
}

/** Per-run inbox dir. Keyed on the CANONICAL runId (never a `-cN` continuation key). */
export function inboxDirForRun(runId: string): string {
  return path.join(inboxRootDir(), sanitizeRunId(runId));
}

function sanitizeRunId(runId: string): string {
  // runIds are uuid-ish / slug-ish; strip anything that could escape the dir.
  return runId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
}

function readJsonl<T>(file: string): T[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      // a torn trailing line from a crashed writer — skip it
    }
  }
  return out;
}

function appendJsonl(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

export function newInboxMessageId(): string {
  return `im_${crypto.randomBytes(5).toString("hex")}`;
}

/** Fold messages + events into current per-message state. */
export function foldInbox(
  messages: InboxMessageRecord[],
  events: InboxEventRecord[],
): InboxMessage[] {
  const byId = new Map<string, InboxMessage>();
  for (const m of messages) {
    if (!m || typeof m.id !== "string") continue;
    byId.set(m.id, { ...m, status: "queued" });
  }
  for (const ev of events) {
    const m = ev && byId.get(ev.id);
    if (!m) continue;
    if (ev.type === "delivered" && m.deliveredAt == null) {
      m.deliveredAt = ev.at;
      m.deliveredVia = ev.via;
    } else if (ev.type === "acked" && m.ackedAt == null) {
      m.ackedAt = ev.at;
      m.ackedVia = ev.via;
    } else if (ev.type === "expired" && m.expiredAt == null) {
      m.expiredAt = ev.at;
      m.expiredNote = ev.note;
    }
  }
  for (const m of byId.values()) {
    // An ack implies delivery even if the delivery event was lost/raced.
    if (m.ackedAt != null) m.status = "acknowledged";
    else if (m.deliveredAt != null) m.status = "delivered";
    else if (m.expiredAt != null) m.status = "expired";
    else m.status = "queued";
  }
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function readInbox(runId: string): InboxMessage[] {
  const dir = inboxDirForRun(runId);
  return foldInbox(
    readJsonl<InboxMessageRecord>(path.join(dir, "messages.jsonl")),
    readJsonl<InboxEventRecord>(path.join(dir, "events.jsonl")),
  );
}

export function getInboxMessage(runId: string, messageId: string): InboxMessage | undefined {
  return readInbox(runId).find((m) => m.id === messageId);
}

/** Queue a message for a run. Never blocks on the agent. */
export function enqueueInboxMessage(params: {
  runId: string;
  text: string;
  from: string;
  childSessionKey?: string;
  now?: number;
}): InboxMessage {
  const record: InboxMessageRecord = {
    id: newInboxMessageId(),
    runId: params.runId,
    text: params.text,
    from: params.from,
    createdAt: params.now ?? Date.now(),
    ...(params.childSessionKey ? { childSessionKey: params.childSessionKey } : {}),
  };
  appendJsonl(path.join(inboxDirForRun(params.runId), "messages.jsonl"), record);
  return { ...record, status: "queued" };
}

export function appendInboxEvent(runId: string, event: InboxEventRecord): void {
  appendJsonl(path.join(inboxDirForRun(runId), "events.jsonl"), event);
}

// ── Lock ────────────────────────────────────────────────────────────────────

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` holding the run's inbox lock. mkdir is atomic, so exactly one of the
 * gateway / Claude hook / OpenCode plugin claims a given message. A lock older
 * than LOCK_STALE_MS is treated as abandoned (crashed holder) and broken.
 * Returns undefined when the lock could not be acquired in time — callers
 * treat that as "nothing claimed this round"; the next boundary retries.
 */
export function withInboxLock<T>(runId: string, fn: () => T): T | undefined {
  const dir = inboxDirForRun(runId);
  mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, ".lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // vanished between mkdir and stat — retry immediately
      }
      if (Date.now() > deadline) return undefined;
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmSync(lock, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Atomically take every still-queued message for delivery via `via`, marking
 * each delivered. Returns the claimed messages (empty when nothing pending or
 * the lock was busy).
 */
export function claimPendingInboxMessages(
  runId: string,
  via: InboxDeliveryVia,
  now = Date.now(),
): InboxMessage[] {
  if (!existsSync(path.join(inboxDirForRun(runId), "messages.jsonl"))) return [];
  return (
    withInboxLock(runId, () => {
      const pending = readInbox(runId).filter((m) => m.status === "queued");
      for (const m of pending) {
        appendInboxEvent(runId, { id: m.id, type: "delivered", at: now, via });
        m.status = "delivered";
        m.deliveredAt = now;
        m.deliveredVia = via;
      }
      return pending;
    }) ?? []
  );
}

/** Record acknowledgement(s). Unknown ids / already-acked ids are ignored. */
export function ackInboxMessages(
  runId: string,
  ids: readonly string[],
  via: string,
  now = Date.now(),
): string[] {
  if (ids.length === 0) return [];
  const current = new Map(readInbox(runId).map((m) => [m.id, m]));
  const acked: string[] = [];
  for (const id of new Set(ids)) {
    const m = current.get(id);
    if (!m || m.ackedAt != null) continue;
    appendInboxEvent(runId, { id, type: "acked", at: now, via });
    acked.push(id);
  }
  return acked;
}

/** Mark every still-queued message expired (run ended before it drained). */
export function expireQueuedInboxMessages(runId: string, note: string, now = Date.now()): string[] {
  if (!existsSync(path.join(inboxDirForRun(runId), "messages.jsonl"))) return [];
  return (
    withInboxLock(runId, () => {
      const queued = readInbox(runId).filter((m) => m.status === "queued");
      for (const m of queued) appendInboxEvent(runId, { id: m.id, type: "expired", at: now, note });
      return queued.map((m) => m.id);
    }) ?? []
  );
}

/** Run ids that have an inbox on disk (used to resume watching after a restart). */
export function listInboxRunIds(): string[] {
  try {
    return readdirSync(inboxRootDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// ── Formatting (mirrored verbatim in hook-scripts.ts) ──────────────────────

/**
 * Render claimed messages as the block injected into the agent's context.
 *
 * NOTE: the text deliberately never contains `ACK` immediately followed by a
 * message id — the gateway scans the child's output for that token to detect
 * acknowledgement, so the instruction itself must not self-acknowledge when a
 * backend echoes tool results into its stream.
 */
export function formatInboxMessages(messages: readonly InboxMessageRecord[]): string {
  if (messages.length === 0) return "";
  const blocks = messages.map(
    (m) =>
      `[OPERATOR MESSAGE id=${m.id} from=${m.from} sent=${new Date(m.createdAt).toISOString()}]\n${m.text}\n[/OPERATOR MESSAGE]`,
  );
  return [
    ...blocks,
    `The ${messages.length === 1 ? "message above is" : "messages above are"} live input from your operator, sent while you are working. ` +
      "Treat it as an authoritative amendment to your task and act on it now — it overrides any conflicting part of the original brief. " +
      'Confirm receipt by writing the token ACK followed by the message id in your next reply (or call the subagent_inbox tool with action "ack").',
  ].join("\n\n");
}

/** Extract acknowledged message ids from agent output (`ACK im_abc123`). */
export function extractInboxAckIds(text: string): string[] {
  if (!text || !text.includes("ACK")) return [];
  const ids: string[] = [];
  // No leading \b: in a raw stream-json line the token often follows an
  // escaped newline ("...done.\\nACK im_…"), i.e. the letter `n`.
  const re = /ACK[\s:#,-]*(im_[a-f0-9]{10})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) ids.push(m[1]!);
  return ids;
}
