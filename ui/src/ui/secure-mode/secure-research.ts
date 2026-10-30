/**
 * Secure research UI.
 *
 * <ib-secure-research-card>  inline in a secure chat, in place of the
 *   `secure_research` tool block. While the tool runs it shows the approval
 *   card for that session's pending batch (editable queries, Approve / Edit /
 *   Deny, "Only these words will leave this machine"), then progress, then
 *   the result: value ranges, summary, the queries that were sent and the
 *   source URLs. With `all` it lists pending batches from every session
 *   (used in the Secure Mode popover).
 *
 * <ib-secure-research-log>  the Secure Research log panel: every batch that
 *   was proposed, which exact queries left the machine and when, and which
 *   hosts were contacted. Reads the encrypted log over secure.research.log.
 *
 * WS events (`secure.research.changed`) carry ids + status only; the queries
 * are fetched over the authenticated RPCs.
 */
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icons } from "../icons";
import { onSecureResearch, secureRequest, type SecureResearchEvent } from "./store";
import { ensureSecureGlobalStyles, secureBaseStyles } from "./styles";

export type ResearchPending = {
  id: string;
  sessionKey?: string;
  goal: string;
  queries: string[];
  createdAt: number;
  expiresAt: number;
  maxQueries: number;
};

export type ResearchEstimate = {
  item: string;
  low: number | null;
  high: number | null;
  currency: string;
  basis?: string;
  confidence?: "low" | "medium" | "high";
  sources: string[];
};

export type ResearchResult = {
  id: string;
  status: string;
  approvalMode?: string;
  queriesSent: string[];
  summary?: string;
  estimates?: ResearchEstimate[];
  sources: Array<{ n: number; url: string; title?: string; kind?: "page" | "snippet" }>;
  model?: string;
  egressHosts: string[];
  removedCount?: number;
  error?: string;
};

export type ResearchLogRow = {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: string;
  approvalMode: string;
  sessionKey?: string;
  queries: Array<{ query: string; sentAt?: number }>;
  sources: number;
  hosts: string[];
};

/** Parse the `secure_research` tool output (JSON text) into a result, or null. */
export function parseResearchResult(raw: unknown): ResearchResult | null {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.status !== "string" || !Array.isArray(r.queriesSent)) return null;
  return {
    id: r.id,
    status: r.status,
    approvalMode: typeof r.approvalMode === "string" ? r.approvalMode : undefined,
    queriesSent: r.queriesSent.filter((q): q is string => typeof q === "string"),
    summary: typeof r.summary === "string" ? r.summary : undefined,
    estimates: Array.isArray(r.estimates) ? (r.estimates as ResearchEstimate[]) : undefined,
    sources: Array.isArray(r.sources) ? (r.sources as ResearchResult["sources"]) : [],
    model: typeof r.model === "string" ? r.model : undefined,
    egressHosts: Array.isArray(r.egressHosts) ? r.egressHosts.filter((h): h is string => typeof h === "string") : [],
    removedCount: typeof r.removedCount === "number" ? r.removedCount : undefined,
    error: typeof r.error === "string" ? r.error : undefined,
  };
}

export function formatMoney(n: number | null, currency: string): string {
  if (n === null || !Number.isFinite(n)) return "?";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: Number.isInteger(n) || n >= 100 ? 0 : 2 }).format(n);
  } catch {
    return `${n.toLocaleString("en-US")} ${currency}`;
  }
}

export function formatRange(e: ResearchEstimate): string {
  if (e.low === null && e.high === null) return "Not enough data";
  if (e.low !== null && e.high !== null && e.low !== e.high)
    return `${formatMoney(e.low, e.currency)} – ${formatMoney(e.high, e.currency)}`;
  return formatMoney(e.low ?? e.high, e.currency);
}

const SOURCES_SHOWN = 8;

const PHASE_LABEL: Record<string, string> = {
  approval: "Waiting for your approval of the outbound queries…",
  plan: "Planning generic queries on your local model…",
  sanitize: "Checking queries for personal details…",
  approved: "Approved. Searching…",
  search: "Searching through your local SearXNG…",
  read: "Reading result pages on your local model…",
  summarize: "Writing the estimate on your local model…",
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

function clock(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const STATUS_LABEL: Record<string, string> = {
  pending_approval: "Waiting for approval",
  approved: "Approved",
  running: "Running",
  done: "Done",
  denied: "Denied — nothing sent",
  expired: "Expired — nothing sent",
  blocked: "Blocked — nothing sent",
  failed: "Failed",
};

const sharedStyles = css`
  .sr {
    display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; border-radius: var(--sm-radius);
    background: linear-gradient(180deg, color-mix(in srgb, var(--sm-accent) 7%, var(--sm-surface)), var(--sm-surface));
    border: 1px solid var(--sm-ring); box-shadow: var(--ib-secure-glow, none);
    max-width: 720px;
  }
  .sr-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .sr-seal {
    display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 10px; flex: none;
    color: var(--sm-accent); background: var(--sm-soft); border: 1px solid var(--sm-ring);
  }
  .sr-seal svg { width: 16px; height: 16px; }
  .sr-title { font-weight: 700; font-size: 14px; letter-spacing: 0.01em; }
  .sr-sub { font-size: 12px; color: var(--sm-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sr-titles { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .sr-out {
    display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--sm-radius-sm);
    font-size: 12.5px; font-weight: 650; color: var(--sm-accent);
    background: var(--sm-soft); border: 1px dashed var(--sm-ring);
  }
  .sr-out svg { width: 14px; height: 14px; }
  .sr-qs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .sr-q {
    display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--sm-radius-sm);
    background: color-mix(in srgb, currentColor 4%, transparent); border: 1px solid var(--sm-border);
    font-family: var(--font-mono, ui-monospace, monospace); font-size: 12.5px; min-width: 0;
  }
  .sr-q svg { color: var(--sm-muted); }
  .sr-q .sm-input { flex: 1; font-family: inherit; }
  .sr-q-text { overflow-wrap: anywhere; }
  .sr-q-warn { font-family: var(--glass-font, inherit); font-size: 11.5px; color: #fbbf24; margin-left: auto; white-space: nowrap; }
  .sr-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .sr-actions .grow { flex: 1; }
  .sr-meta { font-size: 11.5px; color: var(--sm-muted); line-height: 1.45; }
  .sr-meta b { color: inherit; font-weight: 650; }
  .sr-progress { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--sm-muted); }
  .sr-spin svg { animation: sr-spin 1s linear infinite; }
  @keyframes sr-spin { to { transform: rotate(360deg); } }
  .sm-error { line-height: 1.4; }
  a { color: var(--sm-accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  @media (prefers-reduced-motion: reduce) { .sr-spin svg { animation: none; } }
`;

@customElement("ib-secure-research-card")
export class SecureResearchCard extends LitElement {
  /** Secure session whose pending batch this card shows. */
  @property() sessionKey: string | null = null;
  /** The secure_research tool call is still running. */
  @property({ type: Boolean }) running = false;
  /** Tool output (JSON text) once finished. */
  @property() result: string | null = null;
  /** Show pending batches from every session (Secure Mode popover). */
  @property({ type: Boolean }) all = false;
  /**
   * "tool" (default): stands in for the secure_research tool block —
   * progress, then the result. "session": the approval slot above a secure
   * chat's composer — pending batches for `sessionKey`, loaded from the
   * gateway so they survive reloads and other devices.
   */
  @property() mode: "tool" | "session" = "tool";

  private get listsPending(): boolean {
    return this.all || this.mode === "session";
  }

  @state() private pending: ResearchPending[] = [];
  @state() private drafts: Record<string, string[]> = {};
  @state() private editing: Record<string, boolean> = {};
  @state() private warnings: Record<string, string[]> = {};
  @state() private errors: Record<string, string> = {};
  @state() private busy: Record<string, boolean> = {};
  @state() private phase: string | null = null;
  @state() private now = Date.now();
  @state() private loaded = false;
  @state() private allSources = false;

  private off: (() => void) | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    ensureSecureGlobalStyles();
    this.off = onSecureResearch((e) => this.onEvent(e));
    this.tick = setInterval(() => {
      if (this.pending.length) this.now = Date.now();
    }, 1000);
    if (this.listsPending) void this.load();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.off?.();
    this.off = null;
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has("sessionKey") && this.listsPending && changed.get("sessionKey") !== undefined) {
      this.pending = [];
      void this.load();
    }
  }

  private onEvent(e: SecureResearchEvent): void {
    if (!this.all && this.sessionKey && e.sessionKey !== this.sessionKey) return;
    if (e.status.startsWith("running:")) this.phase = e.status.slice("running:".length);
    else if (e.status === "approved") this.phase = "approved";
    else if (e.status === "pending_approval") this.phase = "approval";
    if (this.listsPending) void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await secureRequest<{ pending?: ResearchPending[] }>(
        "secure.research.pending",
        this.all || !this.sessionKey ? {} : { sessionKey: this.sessionKey },
      );
      const list = Array.isArray(res?.pending) ? res.pending : [];
      this.pending = list;
      const drafts = { ...this.drafts };
      for (const p of list) if (!drafts[p.id]) drafts[p.id] = [...p.queries];
      this.drafts = drafts;
      this.loaded = true;
    } catch {
      this.loaded = true;
    }
  }

  private setDraft(id: string, i: number, value: string): void {
    const d = [...(this.drafts[id] ?? [])];
    d[i] = value;
    this.drafts = { ...this.drafts, [id]: d };
  }

  private removeDraft(id: string, i: number): void {
    const d = [...(this.drafts[id] ?? [])];
    d.splice(i, 1);
    this.drafts = { ...this.drafts, [id]: d };
  }

  private async decide(p: ResearchPending, decision: "approve" | "deny"): Promise<void> {
    this.busy = { ...this.busy, [p.id]: true };
    this.errors = { ...this.errors, [p.id]: "" };
    try {
      const edited = this.editing[p.id];
      const queries = (this.drafts[p.id] ?? p.queries).map((q) => q.trim()).filter(Boolean);
      const res = await secureRequest<{
        ok?: boolean;
        needsReview?: boolean;
        sanitized?: Array<{ query: string; ok: boolean; removed: string[] }>;
      }>("secure.research.resolve", {
        id: p.id,
        decision,
        ...(decision === "approve" && edited ? { queries } : {}),
      });
      if (res?.needsReview && Array.isArray(res.sanitized)) {
        // The edit still had personal details: show the sanitized words to approve instead.
        const kept = res.sanitized.filter((x) => x.query);
        this.drafts = { ...this.drafts, [p.id]: kept.map((x) => x.query) };
        this.warnings = {
          ...this.warnings,
          [p.id]: kept.map((x) => (x.removed.length ? `removed ${[...new Set(x.removed)].join(", ")}` : "")),
        };
        this.errors = { ...this.errors, [p.id]: "Personal details were removed from your edit. Check the words and approve again." };
        return;
      }
      this.pending = this.pending.filter((x) => x.id !== p.id);
      this.phase = decision === "approve" ? "approved" : null;
    } catch (err) {
      this.errors = { ...this.errors, [p.id]: String((err as Error)?.message ?? err).replace(/^Error:\s*/, "") };
    } finally {
      this.busy = { ...this.busy, [p.id]: false };
    }
  }

  private renderApproval(p: ResearchPending): TemplateResult {
    const editing = Boolean(this.editing[p.id]);
    const drafts = this.drafts[p.id] ?? p.queries;
    const warn = this.warnings[p.id] ?? [];
    const busy = Boolean(this.busy[p.id]);
    const left = Math.max(0, Math.round((p.expiresAt - this.now) / 1000));
    return html`
      <section class="sr" data-secure-research-approval=${p.id} aria-label="Secure research approval">
        <div class="sr-head">
          <span class="sr-seal">${icons.lock}</span>
          <div class="sr-titles">
            <span class="sr-title">Secure research needs your approval</span>
            <span class="sr-sub" title=${p.goal}>For: ${p.goal}</span>
          </div>
          <span class="sm-chip">${icons.clock}${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}</span>
        </div>
        <div class="sr-out">${icons.shieldCheck}<span>Only these words will leave this machine</span></div>
        <ul class="sr-qs">
          ${drafts.map(
            (q, i) => html`<li class="sr-q">
              ${icons.search}
              ${editing
                ? html`<input
                      class="sm-input"
                      aria-label=${`Query ${i + 1}`}
                      .value=${q}
                      maxlength="120"
                      @input=${(e: Event) => this.setDraft(p.id, i, (e.target as HTMLInputElement).value)}
                    />
                    <button class="sm-btn sm-btn--icon" type="button" title="Remove this query" aria-label="Remove this query" @click=${() => this.removeDraft(p.id, i)}>
                      ${icons.x}
                    </button>`
                : html`<span class="sr-q-text">${q}</span>`}
              ${warn[i] ? html`<span class="sr-q-warn">${warn[i]}</span>` : nothing}
            </li>`,
          )}
        </ul>
        <div class="sr-meta">
          Sent to your <b>local SearXNG</b>, which forwards them to public search engines. Result pages are fetched without
          cookies or scripts and read by your <b>local model</b>. Your files, names and numbers stay here.
        </div>
        ${this.errors[p.id] ? html`<div class="sm-error" role="alert">${this.errors[p.id]}</div>` : nothing}
        <div class="sr-actions">
          <button class="sm-btn sm-btn--danger" type="button" ?disabled=${busy} @click=${() => void this.decide(p, "deny")}>
            ${icons.xCircle}Deny
          </button>
          <button
            class="sm-btn"
            type="button"
            aria-pressed=${editing ? "true" : "false"}
            ?disabled=${busy}
            @click=${() => (this.editing = { ...this.editing, [p.id]: !editing })}
          >
            ${icons.penLine}${editing ? "Done editing" : "Edit"}
          </button>
          <span class="grow"></span>
          <button
            class="sm-btn sm-btn--primary"
            type="button"
            data-secure-research-approve
            ?disabled=${busy || !drafts.some((q) => q.trim())}
            @click=${() => void this.decide(p, "approve")}
          >
            ${busy ? icons.loader : icons.check}Approve and search
          </button>
        </div>
      </section>
    `;
  }

  private renderResult(r: ResearchResult): TemplateResult {
    const done = r.status === "done";
    const est = r.estimates ?? [];
    const nOf = (url: string) => r.sources.find((s) => s.url === url)?.n;
    return html`
      <section class="sr sr--result" data-secure-research-result=${r.id} aria-label="Secure research result">
        <div class="sr-head">
          <span class="sr-seal">${done ? icons.shieldCheck : icons.alertCircle}</span>
          <div class="sr-titles">
            <span class="sr-title">${done ? "Secure research" : (STATUS_LABEL[r.status] ?? r.status)}</span>
            <span class="sr-sub">
              ${r.model ? html`Read by ${r.model} on this machine` : "Local only"}${r.approvalMode === "auto-sanitized" ? " · auto-sanitized" : ""}
            </span>
          </div>
          ${done ? html`<span class="sm-chip">${icons.lock}local model</span>` : nothing}
        </div>
        ${r.error && !done ? html`<div class="sm-error">${r.error}</div>` : nothing}
        ${est.length
          ? html`<div class="sr-table" role="table" aria-label="Value estimates">
              <div class="sr-tr sr-th" role="row">
                <span role="columnheader">Item</span><span role="columnheader">Estimated value</span><span role="columnheader">Sources</span>
              </div>
              ${est.map(
                (e) => html`<div class="sr-tr" role="row">
                  <span role="cell" class="sr-item">
                    <strong>${e.item}</strong>
                    ${e.basis ? html`<small>${e.basis}</small>` : nothing}
                  </span>
                  <span role="cell" class="sr-range">
                    <strong>${formatRange(e)}</strong>
                    <small class="sr-conf sr-conf--${e.confidence ?? "low"}">${e.confidence ?? "low"} confidence</small>
                  </span>
                  <span role="cell" class="sr-cites">
                    ${e.sources.length
                      ? e.sources.map((u) => html`<a href=${u} target="_blank" rel="noreferrer noopener" title=${u}>[${nOf(u) ?? "·"}]</a>`)
                      : html`<small class="sm-muted">none</small>`}
                  </span>
                </div>`,
              )}
            </div>`
          : nothing}
        ${r.summary ? html`<p class="sr-summary">${r.summary}</p>` : nothing}
        ${r.sources.length
          ? html`<ol class="sr-sources" aria-label="Sources">
              ${(this.allSources ? r.sources : r.sources.slice(0, SOURCES_SHOWN)).map(
                (s) => html`<li>
                  <span class="sr-n">${s.n}</span>
                  <span class="sr-src">
                    <span class="sr-src-title">
                      <a href=${s.url} target="_blank" rel="noreferrer noopener">${s.title || hostOf(s.url)}</a>
                      ${s.kind === "snippet" ? html`<small class="sr-kind" title="Only the search result snippet was used; the page itself was not read">snippet</small>` : nothing}
                    </span>
                    <span class="sr-url">${s.url}</span>
                  </span>
                  ${icons.externalLink}
                </li>`,
              )}
            </ol>
            ${r.sources.length > SOURCES_SHOWN
              ? html`<button class="sm-btn sr-more" type="button" @click=${() => (this.allSources = !this.allSources)}>
                  ${this.allSources ? icons.chevronUp : icons.chevronDown}${this.allSources ? "Show fewer sources" : `Show all ${r.sources.length} sources`}
                </button>`
              : nothing}`
          : nothing}
        <details class="sr-sent">
          <summary>${icons.lock}${r.queriesSent.length ? `${r.queriesSent.length} quer${r.queriesSent.length === 1 ? "y" : "ies"} left this machine` : "Nothing left this machine"}${r.removedCount ? html` · ${r.removedCount} personal detail${r.removedCount === 1 ? "" : "s"} removed` : nothing}</summary>
          <ul class="sr-qs">${r.queriesSent.map((q) => html`<li class="sr-q">${icons.search}<span class="sr-q-text">${q}</span></li>`)}</ul>
          ${r.egressHosts.length ? html`<div class="sr-meta">Hosts contacted: ${r.egressHosts.join(", ")}</div>` : nothing}
        </details>
      </section>
    `;
  }

  render() {
    const parsed = this.result ? parseResearchResult(this.result) : null;
    if (parsed) return this.renderResult(parsed);
    if (this.listsPending) {
      if (this.pending.length) return html`<div class="sr-stack">${this.pending.map((p) => this.renderApproval(p))}</div>`;
      return this.all ? html`<div class="sm-muted">No research is waiting for approval.</div>` : nothing;
    }
    if (this.running)
      return html`<div class="sr sr--progress">
        <div class="sr-progress">
          <span class="sr-spin">${icons.loader}</span>${PHASE_LABEL[this.phase ?? "plan"] ?? "Working on your local model…"}
        </div>
      </div>`;
    return nothing;
  }

  static styles = [
    secureBaseStyles,
    sharedStyles,
    css`
      :host { display: block; margin: 6px 0; }
      .sr-stack { display: flex; flex-direction: column; gap: 10px; }
      .sr--progress { padding: 10px 14px; }
      .sr-table { display: flex; flex-direction: column; border: 1px solid var(--sm-border); border-radius: var(--sm-radius-sm); overflow: hidden; }
      .sr-tr { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) auto; gap: 12px; padding: 10px 12px; align-items: start; }
      .sr-tr + .sr-tr { border-top: 1px solid var(--sm-border); }
      .sr-th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--sm-muted); padding-block: 7px; background: color-mix(in srgb, currentColor 4%, transparent); }
      .sr-item, .sr-range { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
      .sr-item strong { font-size: 13px; }
      .sr-item small { font-size: 11.5px; color: var(--sm-muted); line-height: 1.4; }
      .sr-range strong { font-size: 15px; color: var(--sm-accent); font-variant-numeric: tabular-nums; }
      .sr-conf { font-size: 11px; text-transform: capitalize; color: var(--sm-muted); }
      .sr-conf--high { color: var(--sm-accent); }
      .sr-conf--medium { color: #fbbf24; }
      .sr-cites { display: flex; gap: 4px; flex-wrap: wrap; font-size: 12px; font-variant-numeric: tabular-nums; }
      .sr-summary { margin: 0; font-size: 13px; line-height: 1.55; }
      .sr-sources { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
      .sr-sources li { display: flex; align-items: flex-start; gap: 10px; font-size: 12.5px; min-width: 0; }
      .sr-sources li > svg { width: 12px; height: 12px; color: var(--sm-muted); margin-top: 3px; }
      .sr-n {
        display: inline-grid; place-items: center; min-width: 20px; height: 20px; border-radius: 6px; flex: none;
        font-size: 11px; font-weight: 700; color: var(--sm-accent); background: var(--sm-soft);
      }
      .sr-src { display: flex; flex-direction: column; min-width: 0; flex: 1; }
      .sr-more { align-self: flex-start; min-height: 28px; font-size: 12px; }
      .sr-src-title { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
      .sr-kind { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--sm-muted); border: 1px solid var(--sm-border); border-radius: 999px; padding: 0 6px; }
      .sr-url { font-size: 11px; color: var(--sm-muted); overflow-wrap: anywhere; font-family: var(--font-mono, ui-monospace, monospace); }
      .sr-sent summary { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; color: var(--sm-muted); list-style: none; }
      .sr-sent summary::-webkit-details-marker { display: none; }
      .sr-sent summary svg { width: 13px; height: 13px; color: var(--sm-accent); }
      .sr-sent[open] summary { margin-bottom: 8px; }
      @media (max-width: 640px) {
        .sr-tr { grid-template-columns: 1fr; gap: 4px; }
        .sr-th { display: none; }
      }
    `,
  ];
}

@customElement("ib-secure-research-log")
export class SecureResearchLog extends LitElement {
  @property({ type: Number }) limit = 30;
  @state() private rows: ResearchLogRow[] = [];
  @state() private error: string | null = null;
  @state() private loading = false;

  private off: (() => void) | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    ensureSecureGlobalStyles();
    this.off = onSecureResearch((e) => {
      if (!e.status.startsWith("running:")) void this.load();
    });
    void this.load();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.off?.();
    this.off = null;
  }

  async load(): Promise<void> {
    this.loading = true;
    try {
      const res = await secureRequest<{ rows?: ResearchLogRow[] }>("secure.research.log", { limit: this.limit });
      this.rows = Array.isArray(res?.rows) ? res.rows : [];
      this.error = null;
    } catch (err) {
      this.error = String((err as Error)?.message ?? err).replace(/^Error:\s*/, "");
    } finally {
      this.loading = false;
    }
  }

  render() {
    return html`
      <div class="lg" data-secure-research-log>
        <div class="lg-head">
          ${icons.scrollText}<strong>Secure Research log</strong>
          <span class="grow"></span>
          <button class="sm-btn sm-btn--icon" type="button" title="Refresh" aria-label="Refresh research log" @click=${() => void this.load()}>
            ${this.loading ? icons.loader : icons.refresh}
          </button>
        </div>
        ${this.error ? html`<div class="sm-error">${this.error}</div>` : nothing}
        ${!this.error && !this.rows.length && !this.loading
          ? html`<div class="sm-muted">No secure research yet. Queries appear here with the time they were sent.</div>`
          : nothing}
        <ul class="lg-rows">
          ${this.rows.map(
            (r) => html`<li class="lg-row lg-row--${r.status}">
              <div class="lg-meta">
                <span class="lg-status">${STATUS_LABEL[r.status] ?? r.status}</span>
                <span class="sm-muted" title=${new Date(r.createdAt).toLocaleString()}>${timeAgo(r.createdAt)}</span>
                ${r.approvalMode === "auto-sanitized" ? html`<span class="sm-muted">· auto</span>` : nothing}
              </div>
              <ul class="lg-qs">
                ${r.queries.map(
                  (q) => html`<li>
                    <span class="lg-q">${q.query}</span>
                    <span class="lg-when">${q.sentAt ? html`${icons.send}sent ${clock(q.sentAt)}` : html`not sent`}</span>
                  </li>`,
                )}
              </ul>
              ${r.hosts.length ? html`<div class="lg-hosts" title=${r.hosts.join(", ")}>${icons.globe}${r.hosts.length} host${r.hosts.length === 1 ? "" : "s"}: ${r.hosts.slice(0, 4).join(", ")}${r.hosts.length > 4 ? "…" : ""}</div>` : nothing}
            </li>`,
          )}
        </ul>
      </div>
    `;
  }

  static styles = [
    secureBaseStyles,
    css`
      :host { display: block; }
      .lg { display: flex; flex-direction: column; gap: 8px; }
      .lg-head { display: flex; align-items: center; gap: 8px; color: var(--sm-accent); }
      .lg-head strong { font-size: 13px; }
      .grow { flex: 1; }
      .lg-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; max-height: 300px; overflow: auto; }
      .lg-row { padding: 8px 10px; border-radius: var(--sm-radius-sm); border: 1px solid var(--sm-border); background: color-mix(in srgb, currentColor 3%, transparent); display: flex; flex-direction: column; gap: 5px; }
      .lg-meta { display: flex; gap: 6px; align-items: baseline; font-size: 11.5px; }
      .lg-status { font-weight: 700; }
      .lg-row--done .lg-status { color: var(--sm-accent); }
      .lg-row--pending_approval .lg-status { color: #fbbf24; }
      .lg-row--denied .lg-status, .lg-row--failed .lg-status, .lg-row--blocked .lg-status, .lg-row--expired .lg-status { color: var(--sm-muted); }
      .lg-qs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
      .lg-qs li { display: flex; gap: 8px; justify-content: space-between; align-items: baseline; font-size: 12px; }
      .lg-q { font-family: var(--font-mono, ui-monospace, monospace); overflow-wrap: anywhere; }
      .lg-when { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--sm-muted); white-space: nowrap; }
      .lg-when svg { width: 11px; height: 11px; }
      .lg-hosts { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--sm-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .lg-hosts svg { width: 11px; height: 11px; }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-secure-research-card": SecureResearchCard;
    "ib-secure-research-log": SecureResearchLog;
  }
}
