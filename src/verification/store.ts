/**
 * Completion records + event inbox for verified completion.
 *
 * Files under `<stateDir>/verification/`:
 *   records.json   runId → CompletionRecord (attempts, RESULT, review, terminal state)
 *   events.jsonl   append-only completion events with a monotonic `seq` cursor
 *   <runId>/       visual_verify screenshots + reports for that run
 *
 * The event log is the delivery guarantee for orchestrators that cannot be
 * pushed to (MCP clients, CLIs): every terminal state is written here before
 * any push is attempted, and `subagents_events` / `subagents_wait` read it by
 * cursor. Terminal transitions are idempotent — a run ends in exactly one
 * terminal state per round (an operator Continue/Retry opens a new round).
 */

import { EventEmitter } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";
import type { RunResult } from "./contract.js";
import type { ExitClass } from "./classifier.js";
import type { EvidenceItem } from "./evidence.js";
import type { LlmReview, Verdict } from "./reviewer.js";

export type CompletionState =
  | "running"
  | "reviewing"
  | "continuing"
  /** The current attempt died with a gateway restart/shutdown — rechecked after boot. */
  | "interrupted"
  | "verified"
  | "unverified"
  | "failed"
  | "stalled"
  | "blocked"
  | "needs_input"
  /** Auto-continuation stopped: the same review reasons came back twice — a human must look. */
  | "needs_owner"
  | "accepted"
  | "rejected";

export const TERMINAL_STATES: ReadonlySet<CompletionState> = new Set([
  "verified",
  "unverified",
  "failed",
  "stalled",
  "blocked",
  "needs_input",
  "needs_owner",
  "accepted",
  "rejected",
]);

export interface CompletionAttempt {
  n: number;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  kind: ExitClass | null;
  reasons: string[];
  sessionId: string | null;
  /** Durable tmux key the attempt ran under (runId for attempt 1, runId-cN after). */
  durableKey: string | null;
  /** Prompt that started this attempt (continuations only). */
  prompt?: string;
  verdict?: Verdict;
  /** Record round this attempt belongs to (continuation budget is per round). */
  round?: number;
  /** Review reasons for this attempt (drives the repeated-reasons continuation guard). */
  reviewReasons?: string[];
  /** Directories the agent worked in this attempt (from its transcript). */
  workdirs?: string[];
}

export interface CompletionReview {
  verdict: Verdict;
  reasons: string[];
  evidence: EvidenceItem[];
  visualFiles: string[];
  visualSatisfied: boolean;
  screenshots: string[];
  llm: LlmReview | null;
  changedFiles: string[];
  commits: string[];
  reviewedAt: number;
  /** Non-blocking notes (checks the gateway could not re-run for environmental reasons). */
  warnings?: string[];
  /** The tree the review ran against (the run's own worktree when it used one). */
  workspace?: { top: string | null; branch: string | null; source: string };
}

export interface CompletionRecord {
  runId: string;
  /** Short id used in Telegram callback data. */
  token: string;
  childSessionKey: string;
  requesterSessionKey: string;
  label: string;
  task: string;
  backend: string | null;
  model: string | null;
  workdir: string | null;
  baseCommit: string | null;
  startedAt: number;
  updatedAt: number;
  state: CompletionState;
  attempts: CompletionAttempt[];
  maxContinuations: number;
  result: RunResult | null;
  review: CompletionReview | null;
  terminalAt: number | null;
  /** Round counter — bumped when an operator reopens a terminal run. */
  round: number;
  /** Operator decision (Continue / Retry / Accept / Reject). */
  decision?: { action: string; by: string | null; at: number; note?: string };
  delivered?: { telegram?: number; ui?: number; push?: number };
  goalId?: string | null;
  /** Arbitrary caller tags (scheduled tasks put their task id here). */
  tags?: Record<string, string>;
  /** Directories the agent worked in across attempts (transcript cwd / cd targets / edited files). */
  agentWorkdirs?: string[];
  /** visual_verify capture dirs the agent produced (from tool results). */
  visualDirs?: string[];
}

export interface CompletionEvent {
  seq: number;
  ts: number;
  type: "run.started" | "run.attempt" | "run.continued" | "run.terminal" | "run.decision";
  runId: string;
  requesterSessionKey: string;
  label: string;
  state: CompletionState;
  verdict?: Verdict;
  summary?: string;
  reasons?: string[];
  attempt?: number;
  round?: number;
}

const MAX_RECORDS = 2000;
const MAX_EVENTS_IN_MEMORY = 5000;

let records: Map<string, CompletionRecord> | null = null;
let events: CompletionEvent[] = [];
let seq = 0;
let loadedDir: string | null = null;
const bus = new EventEmitter();
bus.setMaxListeners(0);

export function verificationDir(): string {
  return path.join(resolveStateDir(), "verification");
}

export function verificationRunDir(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(verificationDir(), safe);
}

function recordsPath(): string {
  return path.join(verificationDir(), "records.json");
}

function eventsPath(): string {
  return path.join(verificationDir(), "events.jsonl");
}

function ensureLoaded(): Map<string, CompletionRecord> {
  const dir = verificationDir();
  if (records && loadedDir === dir) return records;
  records = new Map();
  events = [];
  seq = 0;
  loadedDir = dir;
  try {
    const raw = JSON.parse(readFileSync(recordsPath(), "utf8")) as { records?: CompletionRecord[] };
    for (const r of raw.records ?? []) if (r?.runId) records.set(r.runId, r);
  } catch {
    /* fresh */
  }
  try {
    const lines = readFileSync(eventsPath(), "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as CompletionEvent;
        events.push(ev);
        if (ev.seq > seq) seq = ev.seq;
      } catch {
        /* torn line */
      }
    }
    if (events.length > MAX_EVENTS_IN_MEMORY) events = events.slice(-MAX_EVENTS_IN_MEMORY);
  } catch {
    /* fresh */
  }
  return records;
}

function persist(): void {
  const map = ensureLoaded();
  try {
    mkdirSync(verificationDir(), { recursive: true });
    let list = [...map.values()].sort((a, b) => a.startedAt - b.startedAt);
    if (list.length > MAX_RECORDS) {
      // Drop the oldest terminal records first.
      const drop = list
        .filter((r) => TERMINAL_STATES.has(r.state))
        .slice(0, list.length - MAX_RECORDS);
      for (const r of drop) map.delete(r.runId);
      list = [...map.values()];
    }
    const tmp = `${recordsPath()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, records: list }, null, 1));
    renameSync(tmp, recordsPath());
  } catch {
    /* best effort — in-memory state still serves waiters */
  }
}

function shortToken(runId: string): string {
  let h = 0;
  for (let i = 0; i < runId.length; i++) h = (Math.imul(31, h) + runId.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}${Date.now().toString(36).slice(-3)}`;
}

export function getRecord(runId: string): CompletionRecord | undefined {
  return ensureLoaded().get(runId);
}

export function getRecordByToken(token: string): CompletionRecord | undefined {
  for (const r of ensureLoaded().values()) if (r.token === token) return r;
  return undefined;
}

export function listRecords(filter?: {
  requesterSessionKey?: string;
  states?: CompletionState[];
  limit?: number;
}): CompletionRecord[] {
  let list = [...ensureLoaded().values()];
  if (filter?.requesterSessionKey)
    list = list.filter((r) => r.requesterSessionKey === filter.requesterSessionKey);
  if (filter?.states?.length) list = list.filter((r) => filter.states!.includes(r.state));
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list.slice(0, filter?.limit ?? 100);
}

export function createRecord(init: {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  label: string;
  task: string;
  backend?: string | null;
  model?: string | null;
  workdir?: string | null;
  baseCommit?: string | null;
  startedAt?: number;
  maxContinuations?: number;
  goalId?: string | null;
  tags?: Record<string, string>;
}): CompletionRecord {
  const map = ensureLoaded();
  const existing = map.get(init.runId);
  if (existing) return existing;
  const now = Date.now();
  const rec: CompletionRecord = {
    runId: init.runId,
    token: shortToken(init.runId),
    childSessionKey: init.childSessionKey,
    requesterSessionKey: init.requesterSessionKey,
    label: init.label,
    task: init.task,
    backend: init.backend ?? null,
    model: init.model ?? null,
    workdir: init.workdir ?? null,
    baseCommit: init.baseCommit ?? null,
    startedAt: init.startedAt ?? now,
    updatedAt: now,
    state: "running",
    attempts: [
      {
        n: 1,
        startedAt: init.startedAt ?? now,
        endedAt: null,
        exitCode: null,
        kind: null,
        reasons: [],
        sessionId: null,
        durableKey: init.runId,
      },
    ],
    maxContinuations: init.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS,
    result: null,
    review: null,
    terminalAt: null,
    round: 1,
    goalId: init.goalId ?? null,
    tags: init.tags,
  };
  map.set(rec.runId, rec);
  persist();
  appendEvent({ type: "run.started", rec });
  return rec;
}

export const DEFAULT_MAX_CONTINUATIONS = 3;

export function updateRecord(
  runId: string,
  patch: (rec: CompletionRecord) => void,
): CompletionRecord | undefined {
  const rec = ensureLoaded().get(runId);
  if (!rec) return undefined;
  patch(rec);
  rec.updatedAt = Date.now();
  persist();
  bus.emit("record", rec);
  return rec;
}

function appendEvent(p: {
  type: CompletionEvent["type"];
  rec: CompletionRecord;
  summary?: string;
  reasons?: string[];
}): CompletionEvent {
  ensureLoaded();
  seq += 1;
  const ev: CompletionEvent = {
    seq,
    ts: Date.now(),
    type: p.type,
    runId: p.rec.runId,
    requesterSessionKey: p.rec.requesterSessionKey,
    label: p.rec.label,
    state: p.rec.state,
    verdict: p.rec.review?.verdict,
    summary: p.summary,
    reasons: p.reasons,
    attempt: p.rec.attempts.length,
    round: p.rec.round,
  };
  events.push(ev);
  if (events.length > MAX_EVENTS_IN_MEMORY) events.splice(0, events.length - MAX_EVENTS_IN_MEMORY);
  try {
    mkdirSync(verificationDir(), { recursive: true });
    appendFileSync(eventsPath(), `${JSON.stringify(ev)}\n`);
  } catch {
    /* best effort */
  }
  bus.emit("event", ev);
  return ev;
}

export function recordEvent(
  runId: string,
  type: CompletionEvent["type"],
  extra?: { summary?: string; reasons?: string[] },
): CompletionEvent | null {
  const rec = getRecord(runId);
  if (!rec) return null;
  return appendEvent({ type, rec, ...extra });
}

/**
 * Move a record into a terminal state exactly once per round. Returns the
 * event when this call made the transition, null when it was already terminal.
 */
export function markTerminal(
  runId: string,
  state: CompletionState,
  extra?: { summary?: string; reasons?: string[] },
): CompletionEvent | null {
  const rec = getRecord(runId);
  if (!rec) return null;
  if (!TERMINAL_STATES.has(state)) throw new Error(`not a terminal state: ${state}`);
  if (TERMINAL_STATES.has(rec.state) && rec.terminalAt) return null;
  rec.state = state;
  rec.terminalAt = Date.now();
  rec.updatedAt = rec.terminalAt;
  persist();
  bus.emit("record", rec);
  return appendEvent({ type: "run.terminal", rec, ...extra });
}

/**
 * Correct a terminal state after an owner-requested re-review (e.g. the
 * original review had no working judge). Same round; appends a run.terminal
 * event so inbox readers see the new verdict. Owner decisions are final.
 */
export function resettleRecord(
  runId: string,
  state: CompletionState,
  extra?: { summary?: string; reasons?: string[] },
): CompletionEvent | null {
  const rec = getRecord(runId);
  if (!rec) return null;
  if (!TERMINAL_STATES.has(state)) throw new Error(`not a terminal state: ${state}`);
  if (rec.state === "accepted" || rec.state === "rejected") return null;
  if (rec.state === state && rec.terminalAt) return null;
  rec.state = state;
  rec.terminalAt = Date.now();
  rec.updatedAt = rec.terminalAt;
  persist();
  bus.emit("record", rec);
  return appendEvent({ type: "run.terminal", rec, ...extra });
}

/** Reopen a terminal record for another round (operator Continue / Retry). */
export function reopenRecord(runId: string): CompletionRecord | undefined {
  return updateRecord(runId, (rec) => {
    rec.state = "continuing";
    rec.terminalAt = null;
    rec.round += 1;
  });
}

export function isTerminal(rec: CompletionRecord | undefined): boolean {
  return Boolean(rec && TERMINAL_STATES.has(rec.state) && rec.terminalAt);
}

export function listEvents(params: {
  cursor?: number;
  requesterSessionKey?: string;
  runIds?: string[];
  types?: CompletionEvent["type"][];
  limit?: number;
}): { events: CompletionEvent[]; cursor: number } {
  ensureLoaded();
  const from = params.cursor ?? 0;
  const runIds = params.runIds?.length ? new Set(params.runIds) : null;
  const out: CompletionEvent[] = [];
  for (const ev of events) {
    if (ev.seq <= from) continue;
    if (params.requesterSessionKey && ev.requesterSessionKey !== params.requesterSessionKey)
      continue;
    if (runIds && !runIds.has(ev.runId)) continue;
    if (params.types?.length && !params.types.includes(ev.type)) continue;
    out.push(ev);
    if (out.length >= (params.limit ?? 100)) break;
  }
  // Truncated by limit → resume after the last returned event; otherwise
  // nothing else matched up to the head, so the caller can skip to it.
  const truncated = out.length >= (params.limit ?? 100);
  return { events: out, cursor: truncated ? out[out.length - 1].seq : Math.max(from, seq) };
}

export function currentCursor(): number {
  ensureLoaded();
  return seq;
}

export function onCompletionEvent(fn: (ev: CompletionEvent) => void): () => void {
  bus.on("event", fn);
  return () => bus.off("event", fn);
}

/**
 * Block until the given runs are terminal. `mode: "any"` resolves on the
 * first terminal run; `"all"` when every run is terminal (unknown runIds are
 * reported as `unknown` immediately so a typo never hangs the caller).
 */
export async function waitForRuns(params: {
  runIds: string[];
  mode?: "any" | "all";
  timeoutMs: number;
  /** Resolver for runs with no completion record (e.g. legacy registry runs). */
  fallback?: (runId: string) => CompletionRecord | "running" | "unknown";
}): Promise<{ done: CompletionRecord[]; pending: string[]; unknown: string[]; timedOut: boolean }> {
  const mode = params.mode ?? "all";
  const ids = [...new Set(params.runIds)];
  const evaluate = () => {
    const done: CompletionRecord[] = [];
    const pending: string[] = [];
    const unknown: string[] = [];
    for (const id of ids) {
      const rec = getRecord(id);
      if (rec) {
        if (isTerminal(rec)) done.push(rec);
        else pending.push(id);
        continue;
      }
      const fb = params.fallback?.(id) ?? "unknown";
      if (fb === "unknown") unknown.push(id);
      else if (fb === "running") pending.push(id);
      else done.push(fb);
    }
    const satisfied =
      mode === "any" ? done.length > 0 || pending.length === 0 : pending.length === 0;
    return { done, pending, unknown, satisfied };
  };
  const first = evaluate();
  if (first.satisfied || params.timeoutMs <= 0) {
    return {
      done: first.done,
      pending: first.pending,
      unknown: first.unknown,
      timedOut: !first.satisfied,
    };
  }
  return await new Promise((resolve) => {
    let finished = false;
    const finish = (timedOut: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(poll);
      bus.off("record", onRecord);
      const r = evaluate();
      resolve({
        done: r.done,
        pending: r.pending,
        unknown: r.unknown,
        timedOut: timedOut && !r.satisfied,
      });
    };
    const onRecord = (rec: CompletionRecord) => {
      if (ids.includes(rec.runId) && evaluate().satisfied) finish(false);
    };
    bus.on("record", onRecord);
    // Fallback runs (no record) do not emit — poll them cheaply.
    const poll = setInterval(() => {
      if (evaluate().satisfied) finish(false);
    }, 2000);
    const timer = setTimeout(() => finish(true), params.timeoutMs);
  });
}

export function resetVerificationStoreForTests(): void {
  records = null;
  events = [];
  seq = 0;
  loadedDir = null;
  bus.removeAllListeners();
  bus.setMaxListeners(0);
  if (existsSync(verificationDir())) {
    /* tests use a temp state dir */
  }
}
