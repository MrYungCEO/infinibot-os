/**
 * Shared Agent-Run-Review renderer.
 *
 * ONE component, THREE surfaces: the dedicated Reviews page (/reviews), the
 * activity-page agent detail modal (subagent-detail-modal → "Review" tab), and
 * the proactive completion modal (proactive-media "agent-review" kind) all
 * render the exact same in-depth review through `renderAgentRunReview()`.
 *
 * DATA CONTRACT (produced by the backend `agents.reviews.*` gateway methods —
 * we only CONSUME it here, never build/store it):
 *
 *   AgentRunReview = {
 *     id, runId, taskId?, projectId?, title, agentKind, backend?, model?,
 *     status: 'built'|'not_built'|'partial'|'failed'|'in_progress',
 *     startedAt, finishedAt?, durationMs?, summaryMarkdown,
 *     filesTouched: [{ path, changeKind, linesAdded?, linesRemoved? }],
 *     actions:      [{ ts, kind, detail }],
 *     issues:       [{ severity, text }],
 *     built: boolean, buildEvidence?,
 *     forwardActions: [{ label, kind, payload? }],
 *     tokensUsed?, cost?
 *   }
 *
 * The render output carries its OWN <style> block so it drops cleanly into
 * both light-DOM app views and shadow-DOM Lit components (proactive-media).
 */

import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../markdown/render.js";
import type { GatewayBrowserClient } from "../gateway";

// ── Data contract ─────────────────────────────────────────────────────────────

export type ReviewStatus =
  | "built"
  | "not_built"
  | "partial"
  | "failed"
  | "in_progress";

export type FileChangeKind = "add" | "modify" | "delete" | "rename" | string;

export interface ReviewFileTouched {
  path: string;
  changeKind: FileChangeKind;
  linesAdded?: number;
  linesRemoved?: number;
}

export interface ReviewAction {
  ts: number;
  kind: string;
  detail: string;
}

export type IssueSeverity = "critical" | "high" | "medium" | "low" | "info" | string;

export interface ReviewIssue {
  severity: IssueSeverity;
  text: string;
}

export type ForwardActionKind =
  | "respawn"
  | "verify"
  | "open_pr"
  | "openpr"
  | "followup"
  | "follow_up"
  | string;

export interface ForwardAction {
  label: string;
  kind: ForwardActionKind;
  payload?: Record<string, unknown>;
}

export interface AgentRunReview {
  id: string;
  runId: string;
  taskId?: string;
  projectId?: string;
  title: string;
  agentKind: string;
  backend?: string;
  model?: string;
  status: ReviewStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  summaryMarkdown: string;
  filesTouched: ReviewFileTouched[];
  actions: ReviewAction[];
  issues: ReviewIssue[];
  built: boolean;
  buildEvidence?: string;
  forwardActions: ForwardAction[];
  tokensUsed?: number;
  cost?: number;
}

// ── RPC helpers (consume the backend methods; graceful on missing backend) ─────

function rpc(
  client: GatewayBrowserClient | null,
  method: string,
  params?: unknown,
): Promise<unknown> {
  if (!client) return Promise.reject(new Error("no client"));
  return (
    client as unknown as { request: (m: string, p?: unknown) => Promise<unknown> }
  ).request(method, params);
}

function coerceReview(x: unknown): AgentRunReview | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Partial<AgentRunReview>;
  if (!r.id && !r.runId) return null;
  return {
    id: String(r.id ?? r.runId),
    runId: String(r.runId ?? r.id),
    taskId: r.taskId,
    projectId: r.projectId,
    title: String(r.title ?? r.runId ?? "Agent run"),
    agentKind: String(r.agentKind ?? "agent"),
    backend: r.backend,
    model: r.model,
    status: (r.status as ReviewStatus) ?? (r.built ? "built" : "partial"),
    startedAt: Number(r.startedAt ?? 0),
    finishedAt: r.finishedAt != null ? Number(r.finishedAt) : undefined,
    durationMs: r.durationMs != null ? Number(r.durationMs) : undefined,
    summaryMarkdown: String(r.summaryMarkdown ?? ""),
    filesTouched: Array.isArray(r.filesTouched) ? r.filesTouched : [],
    actions: Array.isArray(r.actions) ? r.actions : [],
    issues: Array.isArray(r.issues) ? r.issues : [],
    built: r.built === true,
    buildEvidence: r.buildEvidence,
    forwardActions: Array.isArray(r.forwardActions) ? r.forwardActions : [],
    tokensUsed: r.tokensUsed != null ? Number(r.tokensUsed) : undefined,
    cost: r.cost != null ? Number(r.cost) : undefined,
  };
}

/** List reviews. Returns [] (never throws) so callers can show empty state. */
export async function listReviews(
  client: GatewayBrowserClient | null,
  params: { status?: string; projectId?: string; since?: number; limit?: number } = {},
): Promise<{ reviews: AgentRunReview[]; backendMissing: boolean }> {
  try {
    const res = (await rpc(client, "agents.reviews.list", params)) as
      | { reviews?: unknown[] }
      | unknown[]
      | undefined;
    const raw = Array.isArray(res)
      ? res
      : Array.isArray((res as { reviews?: unknown[] })?.reviews)
        ? (res as { reviews: unknown[] }).reviews
        : [];
    return {
      reviews: raw.map(coerceReview).filter((r): r is AgentRunReview => r !== null),
      backendMissing: false,
    };
  } catch {
    // Method not registered yet (backend agent hasn't landed) or transient.
    return { reviews: [], backendMissing: true };
  }
}

/** Fetch a single review by id or runId. Returns null (never throws). */
export async function getReview(
  client: GatewayBrowserClient | null,
  ref: { id?: string; runId?: string },
): Promise<AgentRunReview | null> {
  try {
    const res = (await rpc(client, "agents.reviews.get", ref)) as
      | { review?: unknown }
      | unknown;
    const payload =
      res && typeof res === "object" && "review" in (res as object)
        ? (res as { review?: unknown }).review
        : res;
    return coerceReview(payload);
  } catch {
    return null;
  }
}

/** Ask the backend to regenerate the markdown summary for a run. */
export async function regenerateSummary(
  client: GatewayBrowserClient | null,
  id: string,
): Promise<AgentRunReview | null> {
  try {
    const res = (await rpc(client, "agents.reviews.regenerateSummary", { id })) as
      | { review?: unknown }
      | unknown;
    const payload =
      res && typeof res === "object" && "review" in (res as object)
        ? (res as { review?: unknown }).review
        : res;
    return coerceReview(payload);
  } catch {
    return null;
  }
}

/**
 * Dispatch a forward action (Respawn / Verify / Open PR / Follow-up).
 * Best-effort: an explicit `payload.method` wins, else map known kinds to
 * sensible existing gateway methods, else fire a window event that host
 * surfaces (or the backend agent's wiring) can pick up. Never throws.
 */
export async function dispatchForwardAction(
  client: GatewayBrowserClient | null,
  review: AgentRunReview,
  action: ForwardAction,
): Promise<{ ok: boolean; note?: string }> {
  const kind = String(action.kind || "").toLowerCase();
  const payload = { runId: review.runId, id: review.id, ...(action.payload ?? {}) };

  const explicitMethod =
    typeof action.payload?.method === "string" ? (action.payload.method as string) : null;

  const methodFor = (): string | null => {
    if (explicitMethod) return explicitMethod;
    switch (kind) {
      case "respawn":
        return "subagents.respawn";
      case "verify":
        return "subagent_review_force";
      case "open_pr":
      case "openpr":
        return "agents.reviews.openPr";
      case "followup":
      case "follow_up":
        return "agents.reviews.followUp";
      default:
        return null;
    }
  };

  // Open PR with a bare URL in the payload → just open it.
  if ((kind === "open_pr" || kind === "openpr") && typeof action.payload?.url === "string") {
    try {
      window.open(action.payload.url as string, "_blank", "noopener");
      return { ok: true };
    } catch {
      /* fall through to RPC / event */
    }
  }

  const method = methodFor();
  if (method) {
    try {
      await rpc(client, method, payload);
      return { ok: true };
    } catch (e) {
      // Method may not exist yet — fall back to the event bus below.
      void e;
    }
  }

  try {
    window.dispatchEvent(
      new CustomEvent("infinibot:review-action", {
        detail: { review, action, payload },
      }),
    );
    return { ok: true, note: "queued via event bus" };
  } catch {
    return { ok: false, note: "no handler available" };
  }
}

// ── Formatting ─────────────────────────────────────────────────────────────────

const STATUS_META: Record<
  ReviewStatus,
  { label: string; color: string; glyph: string }
> = {
  built: { label: "BUILT", color: "#22c55e", glyph: "✓" },
  not_built: { label: "NOT BUILT", color: "#f59e0b", glyph: "○" },
  partial: { label: "PARTIAL", color: "#eab308", glyph: "◐" },
  failed: { label: "FAILED", color: "#ef4444", glyph: "✕" },
  in_progress: { label: "IN PROGRESS", color: "#38bdf8", glyph: "◔" },
};

function statusMeta(s: ReviewStatus) {
  return STATUS_META[s] ?? { label: String(s).toUpperCase(), color: "#a78bfa", glyph: "•" };
}

function severityColor(sev: IssueSeverity): string {
  switch (String(sev).toLowerCase()) {
    case "critical":
      return "#ef4444";
    case "high":
      return "#f97316";
    case "medium":
      return "#eab308";
    case "low":
      return "#38bdf8";
    default:
      return "#94a3b8";
  }
}

function changeKindMeta(kind: FileChangeKind): { glyph: string; color: string } {
  switch (String(kind).toLowerCase()) {
    case "add":
    case "added":
    case "create":
    case "created":
      return { glyph: "A", color: "#22c55e" };
    case "delete":
    case "deleted":
    case "remove":
    case "removed":
      return { glyph: "D", color: "#ef4444" };
    case "rename":
    case "renamed":
      return { glyph: "R", color: "#a78bfa" };
    default:
      return { glyph: "M", color: "#eab308" };
  }
}

function fmtDuration(ms?: number): string {
  if (!ms || ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtCost(usd?: number): string {
  if (usd == null) return "";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(3)}`;
}

function fmtClock(ts?: number): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "—";
  }
}

function fmtTime(ts?: number): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

// ── Render options ─────────────────────────────────────────────────────────────

export interface RenderReviewOpts {
  client: GatewayBrowserClient | null;
  requestUpdate: () => void;
  /** Compact = fewer sections (used inside toasts / small surfaces). */
  compact?: boolean;
  /** Called after a forward action resolves (host can toast / refresh). */
  onAction?: (action: ForwardAction, result: { ok: boolean; note?: string }) => void;
  /** Optional regenerate-summary handler override (page swaps the record). */
  onRegenerated?: (review: AgentRunReview) => void;
}

// ── Public renderer ─────────────────────────────────────────────────────────────

export function renderAgentRunReview(
  review: AgentRunReview,
  opts: RenderReviewOpts,
): TemplateResult {
  const sm = statusMeta(review.status);
  const summaryHtml = review.summaryMarkdown
    ? toSanitizedMarkdownHtml(review.summaryMarkdown, { breaks: true })
    : "";

  const runForward = async (a: ForwardAction) => {
    const res = await dispatchForwardAction(opts.client, review, a);
    opts.onAction?.(a, res);
    opts.requestUpdate();
  };

  const runRegen = async () => {
    const updated = await regenerateSummary(opts.client, review.id);
    if (updated) opts.onRegenerated?.(updated);
    opts.requestUpdate();
  };

  return html`
    ${AGENT_RUN_REVIEW_STYLES}
    <div class="arr" data-status=${review.status}>
      <!-- Status + build banner -->
      <div class="arr-banner" style="--arr-c:${sm.color}">
        <span class="arr-status">${sm.glyph} ${sm.label}</span>
        <span class="arr-build ${review.built ? "arr-build-ok" : "arr-build-no"}">
          ${review.built ? "✓ Build verified" : "○ Not built"}
        </span>
        ${review.buildEvidence
          ? html`<span class="arr-build-ev" title=${review.buildEvidence}>${review.buildEvidence}</span>`
          : nothing}
      </div>

      <!-- Meta chips -->
      <div class="arr-meta">
        <span class="arr-chip">${review.agentKind}</span>
        ${review.backend ? html`<span class="arr-chip">${review.backend}</span>` : nothing}
        ${review.model ? html`<span class="arr-chip">${review.model}</span>` : nothing}
        <span class="arr-chip">${fmtDuration(review.durationMs)}</span>
        ${review.tokensUsed
          ? html`<span class="arr-chip">${review.tokensUsed.toLocaleString()} tok</span>`
          : nothing}
        ${review.cost != null ? html`<span class="arr-chip">${fmtCost(review.cost)}</span>` : nothing}
        ${review.projectId ? html`<span class="arr-chip arr-chip-dim">proj ${review.projectId}</span>` : nothing}
      </div>

      <!-- Summary (stylish rendered markdown) -->
      <section class="arr-section">
        <div class="arr-label">
          <span>Summary</span>
          <button class="arr-mini" title="Regenerate summary" @click=${() => void runRegen()}>↻</button>
        </div>
        ${summaryHtml
          ? html`<div class="arr-md">${unsafeHTML(summaryHtml)}</div>`
          : html`<p class="arr-empty-line">No summary was recorded for this run.</p>`}
      </section>

      <!-- Issues -->
      ${review.issues.length
        ? html`
            <section class="arr-section">
              <div class="arr-label">Issues (${review.issues.length})</div>
              <div class="arr-issues">
                ${review.issues.map(
                  (i) => html`
                    <div
                      class="arr-issue"
                      style="--arr-sev:${severityColor(i.severity)}"
                    >
                      <span class="arr-issue-sev">${String(i.severity).toUpperCase()}</span>
                      <span class="arr-issue-text">${i.text}</span>
                    </div>
                  `,
                )}
              </div>
            </section>
          `
        : nothing}

      <!-- Files touched -->
      ${review.filesTouched.length
        ? html`
            <section class="arr-section">
              <div class="arr-label">Files touched (${review.filesTouched.length})</div>
              <div class="arr-files">
                ${review.filesTouched.map((f) => {
                  const ck = changeKindMeta(f.changeKind);
                  return html`
                    <div class="arr-file">
                      <span class="arr-file-kind" style="color:${ck.color};border-color:${ck.color}55;"
                        >${ck.glyph}</span
                      >
                      <code class="arr-file-path">${f.path}</code>
                      <span class="arr-file-lines">
                        ${f.linesAdded != null
                          ? html`<span class="arr-add">+${f.linesAdded}</span>`
                          : nothing}
                        ${f.linesRemoved != null
                          ? html`<span class="arr-del">−${f.linesRemoved}</span>`
                          : nothing}
                      </span>
                    </div>
                  `;
                })}
              </div>
            </section>
          `
        : nothing}

      <!-- Actions timeline -->
      ${!opts.compact && review.actions.length
        ? html`
            <section class="arr-section">
              <div class="arr-label">Activity (${review.actions.length})</div>
              <div class="arr-timeline">
                ${[...review.actions]
                  .sort((a, b) => (a.ts || 0) - (b.ts || 0))
                  .map(
                    (a) => html`
                      <div class="arr-tl-row">
                        <span class="arr-tl-time">${fmtTime(a.ts)}</span>
                        <span class="arr-tl-kind">${a.kind}</span>
                        <span class="arr-tl-detail">${a.detail}</span>
                      </div>
                    `,
                  )}
              </div>
            </section>
          `
        : nothing}

      <!-- Run details -->
      ${!opts.compact
        ? html`
            <section class="arr-section">
              <div class="arr-label">Run details</div>
              <div class="arr-details">
                <div class="arr-drow"><span>Run ID</span><code>${review.runId}</code></div>
                ${review.taskId
                  ? html`<div class="arr-drow"><span>Task</span><code>${review.taskId}</code></div>`
                  : nothing}
                <div class="arr-drow"><span>Started</span><span>${fmtClock(review.startedAt)}</span></div>
                <div class="arr-drow">
                  <span>Finished</span><span>${fmtClock(review.finishedAt)}</span>
                </div>
              </div>
            </section>
          `
        : nothing}

      <!-- Forward actions -->
      ${review.forwardActions.length
        ? html`
            <div class="arr-actions">
              ${review.forwardActions.map(
                (a, i) => html`
                  <button
                    class="arr-btn ${i === 0 ? "arr-btn-primary" : ""}"
                    @click=${() => void runForward(a)}
                  >
                    ${a.label}
                  </button>
                `,
              )}
            </div>
          `
        : nothing}
    </div>
  `;
}

// ── Styles (portable across light + shadow DOM) ─────────────────────────────────

const AGENT_RUN_REVIEW_STYLES = html`
  <style>
    .arr {
      display: flex;
      flex-direction: column;
      gap: 14px;
      color: var(--g-fg, #f5eacd);
      font-size: 0.86rem;
      line-height: 1.5;
    }
    .arr-banner {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      padding: 8px 12px;
      border-radius: 10px;
      border: 1px solid color-mix(in srgb, var(--arr-c, #d4af37) 40%, transparent);
      background: color-mix(in srgb, var(--arr-c, #d4af37) 12%, transparent);
    }
    .arr-status {
      font-weight: 900;
      letter-spacing: 0.08em;
      font-size: 0.74rem;
      color: var(--arr-c, #d4af37);
    }
    .arr-build {
      font-size: 0.66rem;
      font-weight: 800;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      border-radius: 5px;
      padding: 2px 8px;
      border: 1px solid rgba(255, 255, 255, 0.16);
    }
    .arr-build-ok {
      color: #22c55e;
      border-color: rgba(34, 197, 94, 0.4);
      background: rgba(34, 197, 94, 0.12);
    }
    .arr-build-no {
      color: #f59e0b;
      border-color: rgba(245, 158, 11, 0.4);
      background: rgba(245, 158, 11, 0.12);
    }
    .arr-build-ev {
      font-size: 0.68rem;
      color: rgba(245, 234, 205, 0.6);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 260px;
    }
    .arr-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .arr-chip {
      font-size: 0.66rem;
      font-weight: 700;
      letter-spacing: 0.03em;
      border-radius: 6px;
      padding: 2px 8px;
      border: 1px solid rgba(212, 175, 55, 0.28);
      background: rgba(212, 175, 55, 0.08);
      color: var(--g-fg, #f5eacd);
    }
    .arr-chip-dim {
      border-color: rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.05);
      color: rgba(245, 234, 205, 0.65);
    }
    .arr-section {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .arr-label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 0.64rem;
      font-weight: 800;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: rgba(245, 234, 205, 0.55);
    }
    .arr-mini {
      background: none;
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: rgba(245, 234, 205, 0.7);
      border-radius: 6px;
      width: 22px;
      height: 22px;
      cursor: pointer;
      font-size: 0.8rem;
      line-height: 1;
    }
    .arr-mini:hover {
      color: #f5eacd;
      border-color: rgba(212, 175, 55, 0.5);
    }
    .arr-empty-line {
      margin: 0;
      opacity: 0.5;
      font-style: italic;
    }
    /* rendered markdown */
    .arr-md {
      font-size: 0.86rem;
      line-height: 1.6;
      color: rgba(245, 234, 205, 0.92);
      background: rgba(0, 0, 0, 0.22);
      border: 1px solid rgba(212, 175, 55, 0.16);
      border-left: 3px solid var(--g-primary, #d4af37);
      border-radius: 10px;
      padding: 12px 14px;
      overflow-wrap: anywhere;
    }
    .arr-md :first-child {
      margin-top: 0;
    }
    .arr-md :last-child {
      margin-bottom: 0;
    }
    .arr-md h1,
    .arr-md h2,
    .arr-md h3 {
      color: #f5eacd;
      margin: 0.8em 0 0.4em;
      font-size: 1em;
      letter-spacing: 0.01em;
    }
    .arr-md code {
      background: rgba(255, 255, 255, 0.09);
      padding: 1px 5px;
      border-radius: 4px;
      font-size: 0.92em;
    }
    .arr-md pre {
      background: rgba(0, 0, 0, 0.42);
      padding: 10px 12px;
      border-radius: 8px;
      overflow: auto;
    }
    .arr-md pre code {
      background: none;
      padding: 0;
    }
    .arr-md a {
      color: #d4af37;
    }
    .arr-md ul,
    .arr-md ol {
      padding-left: 1.2em;
      margin: 0.4em 0;
    }
    /* issues */
    .arr-issues {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .arr-issue {
      display: flex;
      align-items: flex-start;
      gap: 9px;
      padding: 7px 10px;
      border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--arr-sev, #94a3b8) 40%, transparent);
      border-left: 3px solid var(--arr-sev, #94a3b8);
      background: color-mix(in srgb, var(--arr-sev, #94a3b8) 10%, transparent);
    }
    .arr-issue-sev {
      flex: 0 0 auto;
      font-size: 0.58rem;
      font-weight: 900;
      letter-spacing: 0.06em;
      color: var(--arr-sev, #94a3b8);
      padding-top: 1px;
    }
    .arr-issue-text {
      font-size: 0.82rem;
      color: rgba(245, 234, 205, 0.9);
    }
    /* files */
    .arr-files {
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 340px;
      overflow: auto;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
    }
    .arr-file {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 5px 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }
    .arr-file:last-child {
      border-bottom: none;
    }
    .arr-file-kind {
      flex: 0 0 auto;
      width: 18px;
      height: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.62rem;
      font-weight: 900;
      border-radius: 4px;
      border: 1px solid;
    }
    .arr-file-path {
      flex: 1 1 auto;
      font-size: 0.76rem;
      color: rgba(245, 234, 205, 0.85);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      direction: rtl;
      text-align: left;
    }
    .arr-file-lines {
      flex: 0 0 auto;
      display: flex;
      gap: 6px;
      font-size: 0.7rem;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .arr-add {
      color: #22c55e;
    }
    .arr-del {
      color: #ef4444;
    }
    /* timeline */
    .arr-timeline {
      display: flex;
      flex-direction: column;
      gap: 3px;
      max-height: 260px;
      overflow: auto;
    }
    .arr-tl-row {
      display: flex;
      gap: 9px;
      align-items: baseline;
      font-size: 0.76rem;
      padding: 3px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }
    .arr-tl-time {
      flex: 0 0 auto;
      color: rgba(245, 234, 205, 0.4);
      font-variant-numeric: tabular-nums;
      font-size: 0.68rem;
    }
    .arr-tl-kind {
      flex: 0 0 auto;
      color: #d4af37;
      font-weight: 700;
      font-size: 0.68rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .arr-tl-detail {
      color: rgba(245, 234, 205, 0.82);
    }
    /* details */
    .arr-details {
      display: grid;
      gap: 4px;
    }
    .arr-drow {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      font-size: 0.74rem;
    }
    .arr-drow > span:first-child {
      color: rgba(245, 234, 205, 0.5);
    }
    .arr-drow code {
      font-size: 0.72rem;
      color: rgba(245, 234, 205, 0.8);
    }
    /* forward actions */
    .arr-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding-top: 4px;
    }
    .arr-btn {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: #f5eacd;
      border-radius: 9px;
      padding: 8px 15px;
      font-size: 0.8rem;
      font-weight: 700;
      cursor: pointer;
    }
    .arr-btn:hover {
      background: rgba(255, 255, 255, 0.14);
      border-color: rgba(212, 175, 55, 0.45);
    }
    .arr-btn-primary {
      background: linear-gradient(135deg, var(--g-primary, #d4af37), #b8902f);
      color: #1a1206;
      border-color: var(--g-primary, #d4af37);
      box-shadow: 0 4px 16px rgba(212, 175, 55, 0.26);
    }
    .arr-btn-primary:hover {
      background: linear-gradient(135deg, #e6c252, var(--g-primary, #d4af37));
    }
  </style>
`;

// ── Mock fixture (build/verify before the backend agent lands) ──────────────────
// Gated behind `?reviewsDemo=1` in the Reviews page — never shown as real data.

export const MOCK_REVIEWS: AgentRunReview[] = [
  {
    id: "rev_demo_1",
    runId: "run_a1b2c3d4e5",
    taskId: "task_9f8e",
    projectId: "proj_infinibot",
    title: "Add Reviews page + enrich activity & proactive modals",
    agentKind: "claude_coder",
    backend: "claude",
    model: "claude-opus-4-8",
    status: "built",
    startedAt: Date.now() - 1000 * 60 * 42,
    finishedAt: Date.now() - 1000 * 60 * 3,
    durationMs: 1000 * 60 * 39,
    summaryMarkdown: [
      "## What was built",
      "",
      "Added a dedicated **Reviews** page (`/reviews`) that lists every agent run and",
      "renders an in-depth review — status, files touched, issues, and a build indicator.",
      "",
      "### Highlights",
      "- New shared `renderAgentRunReview()` component reused across **three** surfaces",
      "- Deep-linkable `/reviews/:runId`",
      "- Graceful empty / loading states",
      "",
      "```ts",
      "renderAgentRunReview(review, { client, requestUpdate })",
      "```",
    ].join("\n"),
    filesTouched: [
      { path: "ui/src/ui/views/reviews/index.ts", changeKind: "add", linesAdded: 420 },
      { path: "ui/src/ui/components/agent-run-review.ts", changeKind: "add", linesAdded: 640 },
      { path: "ui/src/ui/navigation.ts", changeKind: "modify", linesAdded: 8, linesRemoved: 1 },
      { path: "ui/src/ui/app-render.ts", changeKind: "modify", linesAdded: 5 },
    ],
    actions: [
      { ts: Date.now() - 1000 * 60 * 40, kind: "spawn", detail: "Agent spawned on branch perf/visibility-scheduler" },
      { ts: Date.now() - 1000 * 60 * 30, kind: "edit", detail: "Wrote agent-run-review.ts" },
      { ts: Date.now() - 1000 * 60 * 12, kind: "build", detail: "pnpm ui:build succeeded" },
      { ts: Date.now() - 1000 * 60 * 3, kind: "complete", detail: "Run finished, review ready" },
    ],
    issues: [
      { severity: "low", text: "Backend agents.reviews.* methods not yet registered — page shows empty state until then." },
    ],
    built: true,
    buildEvidence: "control-ui/assets/reviews-*.js emitted",
    forwardActions: [
      { label: "Verify", kind: "verify" },
      { label: "Respawn", kind: "respawn" },
      { label: "Open PR", kind: "open_pr" },
      { label: "Follow-up", kind: "followup" },
    ],
    tokensUsed: 184320,
    cost: 0.82,
  },
  {
    id: "rev_demo_2",
    runId: "run_f6g7h8i9j0",
    projectId: "proj_infinibot",
    title: "Wire Gmail inline OAuth in wizard",
    agentKind: "codex_coder",
    backend: "codex",
    model: "gpt-5-codex",
    status: "partial",
    startedAt: Date.now() - 1000 * 60 * 120,
    finishedAt: Date.now() - 1000 * 60 * 88,
    durationMs: 1000 * 60 * 32,
    summaryMarkdown:
      "Connected the wizard to the `gmail.oauth.*` RPCs, but the popup fallback still needs a redirect-URI whitelist entry before it works end-to-end.",
    filesTouched: [
      { path: "src/gateway/gmail-oauth-http.ts", changeKind: "modify", linesAdded: 24, linesRemoved: 6 },
      { path: "ui/src/ui/views/inbox.ts", changeKind: "modify", linesAdded: 40, linesRemoved: 12 },
    ],
    actions: [
      { ts: Date.now() - 1000 * 60 * 118, kind: "spawn", detail: "Agent spawned" },
      { ts: Date.now() - 1000 * 60 * 88, kind: "blocked", detail: "Needs redirect-URI whitelist" },
    ],
    issues: [
      { severity: "high", text: "Popup OAuth fallback blocked on missing redirect-URI whitelist entry." },
      { severity: "medium", text: "No tests added for the token-exchange path." },
    ],
    built: false,
    forwardActions: [
      { label: "Respawn with fix", kind: "respawn" },
      { label: "Follow-up", kind: "followup" },
    ],
    tokensUsed: 96110,
    cost: 0.41,
  },
];
