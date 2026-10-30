/**
 * Unified Approval Registry
 *
 * ONE primitive for "something is blocked until the operator says yes". Every
 * approval source funnels through here:
 *
 *   • subagent-checkpoint — gated report_checkpoint (requireCheckpointApproval)
 *   • exec               — exec.approval.request (node-host / bash ask mode)
 *   • tool-gate          — a tool that wants an explicit OK before acting
 *   • orchestrator       — request_approval tool (agents / MCP orchestrators)
 *   • autopilot          — autonomy.approval.request (autonomous task gate)
 *   • custom             — anything else (CLI, plugins)
 *
 * Guarantees:
 *   • Persisted to <stateDir>/approvals/approvals.json (survives a gateway
 *     restart). Every create / resolve / expiry is appended to audit.jsonl.
 *   • Resolvable from ANY surface (telegram / ui / cli / discord / chat / mcp)
 *     — first resolution wins; later attempts return `already_resolved` with
 *     the winning record so the caller can say "already approved by X".
 *   • Never auto-approves. Expiry resolves as a DENY (reason "expired").
 *   • `details` is secret-redacted + truncated at creation time, so nothing
 *     downstream (Telegram, UI, audit log) ever sees the raw secret.
 *
 * Delivery (Telegram etc.) is NOT done here — surfaces subscribe via
 * onApprovalEvent(). See src/approvals/telegram-approvals.ts.
 *
 * Backwards compatibility: createApproval / resolveApproval / getApproval /
 * listPendingApprovals keep their old signatures + record fields (taskId,
 * context, criticality, decision "approved"|"denied", reason) for the
 * autopilot gate and sessions.ts.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";
import { redactSensitiveText } from "../logging/redact.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type ApprovalSource =
  | "subagent-checkpoint"
  | "exec"
  | "tool-gate"
  | "orchestrator"
  | "autopilot"
  | "custom";

/** Options offered to the operator. approve/deny are always present. */
export type ApprovalOption =
  | "approve"
  | "deny"
  | "approve-with-note"
  | "redirect"
  | "approve-always";

export type ApprovalRisk = "low" | "medium" | "high" | "critical";

/** Input decision from a surface. */
export type ApprovalAction = "approve" | "deny" | "redirect" | "approve-always";

/** Legacy decision vocabulary (kept for autopilot + sessions.ts). */
export type ApprovalDecision = "approved" | "denied";

export type ApprovalStatus = "pending" | "approved" | "denied" | "redirected";

/** Where a resolution came from. */
export type ApprovalVia = "telegram" | "ui" | "cli" | "discord" | "chat" | "mcp" | "system";

export interface ApprovalRequester {
  agentId?: string | null;
  sessionKey?: string | null;
  runId?: string | null;
  /** Human label shown to the operator ("claude_coder · fix login"). */
  label?: string | null;
}

export interface ApprovalTelegramMessage {
  chatId: string;
  messageId: number;
  /** "single" = the dedicated card, "digest" = one line in a batch message. */
  kind: "single" | "digest";
  /** Digest messages are shared by several approvals. */
  digestId?: string;
}

export interface ApprovalRecord {
  id: string;
  source: ApprovalSource;
  requester: ApprovalRequester;
  title: string;
  summary: string;
  /** Redacted + truncated command / diff / plan. */
  details: string;
  risk: ApprovalRisk;
  options: ApprovalOption[];
  /** Opaque source reference (e.g. {runId, checkpointId} / {execId}). */
  sourceRef?: Record<string, string>;
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  /** Legacy-compatible decision ("redirected" for redirect). */
  decision: ApprovalDecision | "redirected" | null;
  /** Raw action taken (distinguishes approve vs approve-always). */
  action: ApprovalAction | null;
  /** Operator note / redirect instructions. */
  note: string | null;
  decidedAt: number | null;
  /** Who decided (Telegram @user, UI client name, or "system"). */
  decidedBy: string | null;
  decidedVia: ApprovalVia | null;
  /** "expired" | "gateway_restart" | free text. */
  reason: string | null;
  /**
   * When false the requester can't survive a gateway restart (exec / checkpoint
   * waiters live in-process), so a pending record found on boot is closed.
   */
  resumable: boolean;
  /** Telegram messages that render this request (edited on resolve). */
  telegram?: ApprovalTelegramMessage[];
  /**
   * Who may APPROVE (deny is always allowed — it is the safe direction).
   * Persisted so the rule survives a restart. Absent = legacy behaviour.
   */
  resolverPolicy?: ApprovalResolverPolicy;

  // ── legacy (autopilot) fields ──
  taskId: string | null;
  context: string;
  criticality: "low" | "medium" | "critical";
}

export type ApprovalEvent =
  | { type: "requested"; record: ApprovalRecord }
  | { type: "resolved"; record: ApprovalRecord };

export type ApprovalListener = (event: ApprovalEvent) => void | Promise<void>;

/**
 * Restricts who can approve a request (used for money-moving approvals such
 * as Solatrix trades). The registry enforces it on every resolve path, so a
 * surface can't forget to.
 */
export interface ApprovalResolverPolicy {
  /**
   * Surfaces that may approve: "telegram" = the in-process Telegram callback
   * (operator-checked), "ui" = an interactive UI/webchat WebSocket client.
   * Agents (backend/cli/MCP clients, chat) never qualify.
   */
  approveVia: Array<"telegram" | "ui">;
  /**
   * SaaS: only the tenant's owner, authenticated with Clerk into this
   * tenant, may approve from the UI.
   */
  saasOwnerOfTenant?: string;
}

/**
 * Verified facts about whoever is resolving, supplied by the surface (never
 * taken from request params). `kind` says which code path resolved it.
 */
export interface ApprovalActor {
  kind: "telegram-callback" | "rpc" | "system" | "in-process";
  clientMode?: string;
  authMethod?: string;
  saasTenantId?: string;
  saasRole?: string;
}

export interface CreateApprovalRequestInput {
  /** Optional explicit id (exec approvals reuse their exec id). */
  id?: string;
  source: ApprovalSource;
  requester?: ApprovalRequester;
  title: string;
  summary?: string;
  details?: string;
  risk?: ApprovalRisk;
  options?: ApprovalOption[];
  sourceRef?: Record<string, string>;
  timeoutMs?: number;
  resumable?: boolean;
  /**
   * In-process callback fired once, after the record is resolved (by any
   * surface or expiry). Used to unblock the source (checkpoint / exec).
   */
  onResolve?: (record: ApprovalRecord) => void;
  /** Restrict who may approve (see ApprovalResolverPolicy). */
  resolverPolicy?: ApprovalResolverPolicy;
  // legacy
  taskId?: string | null;
}

export interface ResolveApprovalInput {
  action: ApprovalAction;
  note?: string | null;
  by?: string | null;
  via: ApprovalVia;
  reason?: string | null;
  /** Verified resolver facts; required to approve a policy-restricted request. */
  actor?: ApprovalActor;
}

export type ResolveApprovalResult =
  | { ok: true; record: ApprovalRecord }
  | {
      ok: false;
      error: "not_found" | "already_resolved" | "option_not_allowed" | "not_authorized";
      record: ApprovalRecord | null;
      message?: string;
    };

const INTERACTIVE_MODES = new Set(["ui", "webchat"]);

/**
 * Null when `actor` may approve under `policy`, else the reason. Pure, so the
 * rule is unit-testable on its own.
 */
export function approvalActorRejection(
  policy: ApprovalResolverPolicy,
  actor: ApprovalActor | undefined,
): string | null {
  if (!actor) return "approver identity unknown";
  if (actor.kind === "telegram-callback") {
    return policy.approveVia.includes("telegram") ? null : "Telegram cannot approve this request";
  }
  if (actor.kind !== "rpc") return "only a person can approve this request";
  if (!policy.approveVia.includes("ui")) return "the web UI cannot approve this request";
  if (!INTERACTIVE_MODES.has(String(actor.clientMode ?? ""))) {
    return "only an interactive UI session can approve this request (agents cannot)";
  }
  if (policy.saasOwnerOfTenant) {
    if (actor.authMethod !== "clerk") return "sign in with your InfiniBot Cloud account to approve";
    if (actor.saasTenantId !== policy.saasOwnerOfTenant)
      return "this approval belongs to another workspace";
    if (actor.saasRole !== "owner") return "only the workspace owner can approve this request";
  }
  return null;
}

// ── Limits ─────────────────────────────────────────────────────────────────

export const APPROVAL_DEFAULT_TIMEOUT_MS = 30 * 60_000;
export const APPROVAL_MAX_TIMEOUT_MS = 7 * 24 * 60 * 60_000;
export const APPROVAL_MIN_TIMEOUT_MS = 5_000;
export const APPROVAL_DETAILS_MAX_CHARS = 8_000;
const TITLE_MAX = 200;
const SUMMARY_MAX = 2_000;
const NOTE_MAX = 4_000;
/** Resolved records kept for status lookups / the UI history. */
const RESOLVED_KEEP_MS = 7 * 24 * 60 * 60_000;
const RESOLVED_KEEP_MAX = 500;

// ── State ──────────────────────────────────────────────────────────────────

interface InMemory {
  records: Map<string, ApprovalRecord>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  onResolve: Map<string, (r: ApprovalRecord) => void>;
  waiters: Map<string, Set<(r: ApprovalRecord) => void>>;
  listeners: Set<ApprovalListener>;
  loaded: boolean;
  dir: string | null;
  persist: boolean;
  now: () => number;
}

const state: InMemory = {
  records: new Map(),
  timers: new Map(),
  onResolve: new Map(),
  waiters: new Map(),
  listeners: new Set(),
  loaded: false,
  dir: null,
  persist: true,
  now: () => Date.now(),
};

function storeDir(): string {
  if (state.dir) return state.dir;
  return path.join(resolveStateDir(), "approvals");
}

// ── Sanitising ─────────────────────────────────────────────────────────────

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const suffix = `\n… [truncated ${text.length - max} chars]`;
  return `${text.slice(0, Math.max(0, max - suffix.length))}${suffix}`;
}

/** Redact secrets (tokens, keys, bearer headers, PEM) and truncate safely. */
export function sanitizeApprovalText(raw: unknown, max: number): string {
  if (typeof raw !== "string" || !raw) return "";
  // Truncate generously first so the redaction regexes never scan megabytes.
  const pre = raw.length > max * 4 ? raw.slice(0, max * 4) : raw;
  const redacted = redactSensitiveText(pre, { mode: "tools", full: true });
  return clip(redacted, max);
}

function normalizeRisk(r: unknown): ApprovalRisk {
  return r === "low" || r === "high" || r === "critical" ? r : "medium";
}

function riskToCriticality(r: ApprovalRisk): ApprovalRecord["criticality"] {
  if (r === "low") return "low";
  if (r === "critical" || r === "high") return "critical";
  return "medium";
}

function normalizeOptions(opts: ApprovalOption[] | undefined): ApprovalOption[] {
  const set = new Set<ApprovalOption>(["approve", "deny"]);
  for (const o of opts ?? []) {
    if (
      o === "approve" ||
      o === "deny" ||
      o === "approve-with-note" ||
      o === "redirect" ||
      o === "approve-always"
    ) {
      set.add(o);
    }
  }
  return [...set];
}

function newId(): string {
  return `apr_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

// ── Persistence ────────────────────────────────────────────────────────────

function audit(entry: Record<string, unknown>): void {
  if (!state.persist) return;
  try {
    const dir = storeDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(dir, "audit.jsonl"),
      `${JSON.stringify({ ts: new Date(state.now()).toISOString(), ...entry })}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* audit is best-effort; never break an approval over disk trouble */
  }
}

function prune(): void {
  const cutoff = state.now() - RESOLVED_KEEP_MS;
  const resolved = [...state.records.values()]
    .filter((r) => r.status !== "pending")
    .sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt));
  resolved.forEach((r, i) => {
    if (i >= RESOLVED_KEEP_MAX || (r.decidedAt ?? r.createdAt) < cutoff) {
      state.records.delete(r.id);
    }
  });
}

function save(): void {
  if (!state.persist) return;
  try {
    prune();
    const dir = storeDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "approvals.json");
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ version: 1, records: [...state.records.values()] }, null, 2),
      { mode: 0o600 },
    );
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort */
  }
}

/**
 * Load persisted records (idempotent). Pending records that already expired
 * are denied; pending non-resumable records (their in-process waiter died with
 * the previous gateway) are closed as "gateway_restart". Surviving pending
 * records get their expiry timers re-armed.
 */
export function loadApprovalRegistry(): void {
  if (state.loaded) return;
  state.loaded = true;
  if (!state.persist) return;
  let raw: { records?: ApprovalRecord[] } | null = null;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(storeDir(), "approvals.json"), "utf8"));
  } catch {
    return;
  }
  const toClose: Array<{ id: string; reason: string }> = [];
  for (const rec of raw?.records ?? []) {
    if (!rec || typeof rec.id !== "string") continue;
    state.records.set(rec.id, rec);
    if (rec.status !== "pending") continue;
    if (rec.expiresAt <= state.now()) toClose.push({ id: rec.id, reason: "expired" });
    else if (rec.resumable === false) toClose.push({ id: rec.id, reason: "gateway_restart" });
    else armExpiry(rec);
  }
  for (const c of toClose) {
    resolveApprovalRequest(c.id, { action: "deny", via: "system", by: "system", reason: c.reason });
  }
}

function ensureLoaded(): void {
  if (!state.loaded) loadApprovalRegistry();
}

// ── Events ─────────────────────────────────────────────────────────────────

export function onApprovalEvent(listener: ApprovalListener): () => void {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

function emit(event: ApprovalEvent): void {
  for (const l of state.listeners) {
    try {
      const r = l(event);
      if (r && typeof (r as Promise<void>).catch === "function") {
        (r as Promise<void>).catch(() => {});
      }
    } catch {
      /* a broken surface must never break the registry */
    }
  }
}

// ── Core API ───────────────────────────────────────────────────────────────

function armExpiry(rec: ApprovalRecord): void {
  const existing = state.timers.get(rec.id);
  if (existing) clearTimeout(existing);
  const delay = Math.max(0, rec.expiresAt - state.now());
  const timer = setTimeout(() => {
    state.timers.delete(rec.id);
    resolveApprovalRequest(rec.id, {
      action: "deny",
      via: "system",
      by: "system",
      reason: "expired",
    });
  }, delay);
  (timer as { unref?: () => void }).unref?.();
  state.timers.set(rec.id, timer);
}

export function createApprovalRequest(input: CreateApprovalRequestInput): ApprovalRecord {
  ensureLoaded();
  const now = state.now();
  const timeoutMs = Math.min(
    APPROVAL_MAX_TIMEOUT_MS,
    Math.max(APPROVAL_MIN_TIMEOUT_MS, input.timeoutMs ?? APPROVAL_DEFAULT_TIMEOUT_MS),
  );
  const explicit = typeof input.id === "string" ? input.id.trim() : "";
  const id = explicit && !state.records.has(explicit) ? explicit.slice(0, 56) : newId();
  const risk = normalizeRisk(input.risk);
  const details = sanitizeApprovalText(input.details, APPROVAL_DETAILS_MAX_CHARS);
  const requester: ApprovalRequester = {
    agentId: input.requester?.agentId ?? null,
    sessionKey: input.requester?.sessionKey ?? null,
    runId: input.requester?.runId ?? null,
    label: input.requester?.label ? sanitizeApprovalText(input.requester.label, 120) : null,
  };
  const record: ApprovalRecord = {
    id,
    source: input.source,
    requester,
    title: sanitizeApprovalText(input.title, TITLE_MAX) || "Approval required",
    summary: sanitizeApprovalText(input.summary, SUMMARY_MAX),
    details,
    risk,
    options: normalizeOptions(input.options),
    sourceRef: input.sourceRef,
    createdAt: now,
    expiresAt: now + timeoutMs,
    status: "pending",
    decision: null,
    action: null,
    note: null,
    decidedAt: null,
    decidedBy: null,
    decidedVia: null,
    reason: null,
    resumable: input.resumable ?? true,
    ...(input.resolverPolicy
      ? {
          resolverPolicy: {
            approveVia: [...input.resolverPolicy.approveVia],
            ...(input.resolverPolicy.saasOwnerOfTenant
              ? { saasOwnerOfTenant: input.resolverPolicy.saasOwnerOfTenant }
              : {}),
          },
        }
      : {}),
    taskId: input.taskId ?? null,
    context: details,
    criticality: riskToCriticality(risk),
  };
  state.records.set(id, record);
  if (input.onResolve) state.onResolve.set(id, input.onResolve);
  armExpiry(record);
  save();
  audit({
    event: "requested",
    id,
    source: record.source,
    requester: record.requester,
    title: record.title,
    risk: record.risk,
    expiresAt: record.expiresAt,
  });
  emit({ type: "requested", record });
  return record;
}

/**
 * Resolve a pending request. First resolution wins; the source callback and
 * any waiters fire exactly once.
 */
export function resolveApprovalRequest(
  id: string,
  input: ResolveApprovalInput,
): ResolveApprovalResult {
  ensureLoaded();
  const rec = state.records.get(id);
  if (!rec) return { ok: false, error: "not_found", record: null };
  if (rec.status !== "pending") return { ok: false, error: "already_resolved", record: rec };
  if (input.action === "redirect" && !rec.options.includes("redirect")) {
    return { ok: false, error: "option_not_allowed", record: rec };
  }
  if (input.action === "approve-always" && !rec.options.includes("approve-always")) {
    return { ok: false, error: "option_not_allowed", record: rec };
  }
  if (rec.resolverPolicy && input.action !== "deny") {
    const why = approvalActorRejection(rec.resolverPolicy, input.actor);
    if (why) {
      audit({ event: "resolve_rejected", id, action: input.action, via: input.via, reason: why });
      return { ok: false, error: "not_authorized", record: rec, message: why };
    }
  }
  const note = input.note ? sanitizeApprovalText(input.note.trim(), NOTE_MAX) : "";
  rec.action = input.action;
  rec.status =
    input.action === "deny" ? "denied" : input.action === "redirect" ? "redirected" : "approved";
  rec.decision = rec.status;
  rec.note = note || null;
  rec.decidedAt = state.now();
  rec.decidedBy = input.by ?? null;
  rec.decidedVia = input.via;
  rec.reason = input.reason ?? null;

  const timer = state.timers.get(id);
  if (timer) clearTimeout(timer);
  state.timers.delete(id);
  save();
  audit({
    event: "resolved",
    id,
    source: rec.source,
    status: rec.status,
    action: rec.action,
    by: rec.decidedBy,
    via: rec.decidedVia,
    reason: rec.reason,
    note: rec.note,
  });

  const cb = state.onResolve.get(id);
  state.onResolve.delete(id);
  if (cb) {
    try {
      cb(rec);
    } catch {
      /* source callback failures must not break resolution */
    }
  }
  const waiters = state.waiters.get(id);
  state.waiters.delete(id);
  for (const w of waiters ?? []) w(rec);
  emit({ type: "resolved", record: rec });
  return { ok: true, record: rec };
}

/**
 * Wait for a decision. Resolves with the record once resolved, or with the
 * still-pending record when `waitMs` elapses first (poll-friendly: callers
 * like the MCP wait_approval tool re-call instead of holding one long call).
 */
export function waitForApprovalRequest(id: string, waitMs: number): Promise<ApprovalRecord | null> {
  ensureLoaded();
  const rec = state.records.get(id);
  if (!rec) return Promise.resolve(null);
  if (rec.status !== "pending") return Promise.resolve(rec);
  return new Promise((resolve) => {
    const set = state.waiters.get(id) ?? new Set();
    const done = (r: ApprovalRecord) => {
      clearTimeout(timer);
      set.delete(done);
      resolve(r);
    };
    const timer = setTimeout(
      () => {
        set.delete(done);
        resolve(state.records.get(id) ?? null);
      },
      Math.max(0, waitMs),
    );
    (timer as { unref?: () => void }).unref?.();
    set.add(done);
    state.waiters.set(id, set);
  });
}

export function getApprovalRequest(id: string): ApprovalRecord | null {
  ensureLoaded();
  return state.records.get(id) ?? null;
}

export function listApprovalRequests(filter?: {
  status?: ApprovalStatus | "all";
  limit?: number;
}): ApprovalRecord[] {
  ensureLoaded();
  const want = filter?.status ?? "pending";
  const all = [...state.records.values()]
    .filter((r) => want === "all" || r.status === want)
    .sort((a, b) => b.createdAt - a.createdAt);
  return typeof filter?.limit === "number" ? all.slice(0, Math.max(0, filter.limit)) : all;
}

/** Record Telegram delivery metadata for later in-place edits. */
export function attachTelegramMessage(id: string, msg: ApprovalTelegramMessage): void {
  const rec = state.records.get(id);
  if (!rec) return;
  const list = rec.telegram ?? [];
  if (!list.some((m) => m.chatId === msg.chatId && m.messageId === msg.messageId)) {
    list.push(msg);
  }
  rec.telegram = list;
  save();
}

/** Read the audit log (newest last). */
export function readApprovalAudit(limit = 200): Array<Record<string, unknown>> {
  try {
    const lines = fs.readFileSync(path.join(storeDir(), "audit.jsonl"), "utf8").trim().split("\n");
    return lines
      .slice(-Math.max(1, limit))
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((x): x is Record<string, unknown> => x !== null);
  } catch {
    return [];
  }
}

// ── Legacy API (autopilot gate + sessions.ts) ──────────────────────────────

export type ApprovalRequest = Pick<
  ApprovalRecord,
  "id" | "taskId" | "title" | "summary" | "criticality" | "context" | "createdAt" | "expiresAt"
>;

export interface CreateApprovalInput {
  taskId?: string | null;
  title: string;
  summary: string;
  context: string;
  criticality?: ApprovalRecord["criticality"];
  timeoutMs?: number;
}

export interface CreateApprovalResult {
  record: ApprovalRecord;
  /** Resolves once the user decides (approve/deny) or the request expires. */
  promise: Promise<ApprovalRecord>;
}

export function createApproval(input: CreateApprovalInput): CreateApprovalResult {
  let resolveFn!: (r: ApprovalRecord) => void;
  const promise = new Promise<ApprovalRecord>((resolve) => {
    resolveFn = resolve;
  });
  const record = createApprovalRequest({
    source: "autopilot",
    title: input.title,
    summary: input.summary,
    details: input.context,
    risk:
      input.criticality === "critical"
        ? "critical"
        : input.criticality === "low"
          ? "low"
          : "medium",
    taskId: input.taskId ?? null,
    timeoutMs: input.timeoutMs,
    requester: { label: "Autopilot" },
    onResolve: (r) => resolveFn(r),
  });
  return { record, promise };
}

export function resolveApproval(
  id: string,
  decision: ApprovalDecision,
  decidedBy: string | null,
  via: ApprovalVia = "ui",
): boolean {
  return resolveApprovalRequest(id, {
    action: decision === "approved" ? "approve" : "deny",
    by: decidedBy,
    via,
  }).ok;
}

export function getApproval(id: string): ApprovalRecord | null {
  return getApprovalRequest(id);
}

export function listPendingApprovals(): ApprovalRecord[] {
  return listApprovalRequests({ status: "pending" });
}

// ── Test hooks ─────────────────────────────────────────────────────────────

/**
 * For tests: clears all in-memory state. `opts.dir` points persistence at a
 * temp dir (or `persist:false` disables disk entirely); `now` injects a clock.
 */
export function _resetApprovalRegistry(opts?: {
  dir?: string | null;
  persist?: boolean;
  now?: () => number;
  keepListeners?: boolean;
}): void {
  for (const t of state.timers.values()) clearTimeout(t);
  state.timers.clear();
  state.records.clear();
  state.onResolve.clear();
  state.waiters.clear();
  if (!opts?.keepListeners) state.listeners.clear();
  state.dir = opts?.dir ?? null;
  state.persist = opts?.persist ?? (opts?.dir ? true : false);
  state.now = opts?.now ?? (() => Date.now());
  // Tests without a dir run memory-only and are considered loaded.
  state.loaded = !state.persist;
}
