/**
 * <agent-focus-panel> — slide-in inspector for the Agency World.
 *
 * Slides in from the right edge when an agent (or federation node) is
 * selected inside the 2D world. Mirrors the gold/dark agency theme.
 *
 * Driven by the gpu-animation-panel host:
 *   - on bubbled "agency-agent-select" {sessionKey, agent}
 *       panel.agent = detail.agent; panel.node = null; panel.open = true;
 *   - on bubbled "agency-node-select" {node}
 *       panel.node = detail.node; panel.agent = null; panel.open = true;
 *
 * Emits (bubbles + composed) for the host to wire to gateway calls:
 *   - "focus-open-session" {sessionKey}  -> switchSession
 *   - "focus-stop"         {sessionKey}  -> agent.abort
 *   - "focus-open-run"     {runId}       -> open run detail
 *   - "focus-close"        {}            -> host may clear selection
 *
 * Side-effect-free on import beyond the customElement registration.
 */

import "./completion-verdict";
import { LitElement, html, css, unsafeCSS, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway";

// ── Theme ──────────────────────────────────────────────────────────────────
// Lit's `css` tag only permits CSSResult/number in expressions, so the gold
// and bg colors are wrapped in unsafeCSS (trusted literal constants).

const GOLD = unsafeCSS("#d4af37");
const BG = unsafeCSS("#0a0e1a");

const STATUS_COLORS: Record<string, string> = {
  starting: "#3b82f6",
  idle: "#6a8a6a",
  working: "#ffd700",
  blocked: "#e74c3c",
  finishing: "#f59e0b",
  completed: "#22c55e",
  failed: "#ef4444",
  online: "#22c55e",
  offline: "#ef4444",
  connecting: "#f59e0b",
};

function statusColor(status: unknown): string {
  const s = String(status || "").toLowerCase();
  return STATUS_COLORS[s] || "#9aa2b1";
}

function fileName(path: string): string {
  const p = String(path || "");
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

@customElement("agent-focus-panel")
export class AgentFocusPanel extends LitElement {
  /** Full MeshAgent (+ optional lastTool {kind,label}, filesTouched, runId, model, provider). */
  @property({ type: Object }) agent: any = null;
  /** Full MeshNode (+ optional hardware {cpu,mem,gpu}). */
  @property({ type: Object }) node: any = null;
  /** Open state — reflected so [open] CSS selectors apply for the slide. */
  @property({ type: Boolean, reflect: true }) open = false;
  /** Gateway client — injected by gpu-animation-panel for review RPCs. */
  @property({ type: Object }) client: GatewayBrowserClient | null = null;
  /** Number of parallel review passes to spawn (default 3). */
  @property({ type: Number }) spawnN = 3;

  @state() private _review: any = null;
  @state() private _reviewLoading = false;
  private _lastFetchRunId: string | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.onKeydown);
  }

  disconnectedCallback(): void {
    window.removeEventListener("keydown", this.onKeydown);
    this.open = false;
    super.disconnectedCallback();
  }

  static styles = css`
    :host {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: 300px;
      max-width: 90vw;
      z-index: 9000;
      transform: translateX(110%);
      transition: transform 0.32s cubic-bezier(0.22, 1, 0.36, 1);
      font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
      color: #e4e4e7;
      pointer-events: none;
    }
    :host([open]) {
      transform: translateX(0);
      pointer-events: auto;
    }

    .panel {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: ${BG};
      border-left: 1px solid rgba(212, 175, 55, 0.55);
      box-shadow: -12px 0 40px rgba(0, 0, 0, 0.55);
      overflow: hidden;
    }

    .hdr {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 14px 14px 12px;
      border-bottom: 1px solid rgba(212, 175, 55, 0.22);
      background: linear-gradient(180deg, rgba(212, 175, 55, 0.1), transparent);
    }
    .hdr .titles {
      flex: 1;
      min-width: 0;
    }
    .kicker {
      font-size: 9px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: ${GOLD};
      opacity: 0.85;
    }
    .title {
      font-size: 15px;
      font-weight: 700;
      color: #fff;
      margin-top: 3px;
      word-break: break-word;
      line-height: 1.2;
    }
    .subtitle {
      font-size: 10px;
      color: #9aa2b1;
      margin-top: 4px;
      word-break: break-word;
    }
    .x {
      flex: none;
      width: 26px;
      height: 26px;
      border-radius: 6px;
      border: 1px solid rgba(212, 175, 55, 0.35);
      background: transparent;
      color: ${GOLD};
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      font-family: inherit;
    }
    .x:hover {
      background: rgba(212, 175, 55, 0.14);
    }

    .body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 12px 14px;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 10px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      border: 1px solid currentColor;
    }
    .chip .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
    }

    .row {
      margin-top: 14px;
    }
    .label {
      font-size: 9px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #9aa2b1;
      margin-bottom: 4px;
    }
    .value {
      font-size: 12px;
      color: #e4e4e7;
      word-break: break-word;
      line-height: 1.45;
    }
    .value.mono-id {
      font-size: 11px;
      color: ${GOLD};
    }

    .progress {
      height: 8px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.07);
      overflow: hidden;
      border: 1px solid rgba(212, 175, 55, 0.2);
    }
    .progress > i {
      display: block;
      height: 100%;
      background: linear-gradient(90deg, ${GOLD}, #f5d77a);
      transition: width 0.3s ease;
    }
    .progress-pct {
      font-size: 10px;
      color: ${GOLD};
      margin-top: 3px;
    }

    .tool {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: 8px 10px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(212, 175, 55, 0.18);
    }
    .tool .kind {
      font-size: 9px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: ${GOLD};
    }
    .tool .desc {
      font-size: 11px;
      color: #e4e4e7;
      word-break: break-word;
    }

    .files {
      max-height: 140px;
      overflow-y: auto;
      border: 1px solid rgba(212, 175, 55, 0.16);
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.25);
    }
    .files .file {
      padding: 5px 9px;
      font-size: 10px;
      color: #c6ccd6;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .files .file:last-child {
      border-bottom: none;
    }
    .files .file .dir {
      color: #6b7280;
    }

    .caps {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }
    .cap {
      font-size: 9px;
      letter-spacing: 0.04em;
      padding: 2px 7px;
      border-radius: 4px;
      background: rgba(212, 175, 55, 0.1);
      border: 1px solid rgba(212, 175, 55, 0.25);
      color: ${GOLD};
    }

    .hw {
      display: grid;
      grid-template-columns: 1fr;
      gap: 4px;
    }
    .hw .hw-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-size: 11px;
    }
    .hw .hw-row .k {
      color: #9aa2b1;
    }
    .hw .hw-row .v {
      color: #e4e4e7;
      text-align: right;
      word-break: break-word;
    }

    .actions {
      flex: none;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px 14px;
      border-top: 1px solid rgba(212, 175, 55, 0.22);
      background: rgba(0, 0, 0, 0.2);
    }
    button.act {
      width: 100%;
      padding: 9px 12px;
      border-radius: 7px;
      font-family: inherit;
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: pointer;
      border: 1px solid rgba(212, 175, 55, 0.4);
      background: rgba(212, 175, 55, 0.12);
      color: ${GOLD};
      transition: background 0.15s ease;
    }
    button.act:hover {
      background: rgba(212, 175, 55, 0.22);
    }
    button.act.primary {
      background: ${GOLD};
      color: ${BG};
      border-color: ${GOLD};
      font-weight: 700;
    }
    button.act.primary:hover {
      background: #f5d77a;
    }
    button.act.danger {
      border-color: rgba(239, 68, 68, 0.5);
      background: rgba(239, 68, 68, 0.12);
      color: #f87171;
    }
    button.act.danger:hover {
      background: rgba(239, 68, 68, 0.22);
    }
    button.act:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .empty {
      padding: 24px 14px;
      font-size: 11px;
      color: #6b7280;
      text-align: center;
    }

    /* ── Review section ── */
    .review-section {
      margin-top: 14px;
      border: 1px solid rgba(34, 197, 94, 0.22);
      border-radius: 7px;
      background: rgba(34, 197, 94, 0.04);
      overflow: hidden;
    }
    .review-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 10px;
      border-bottom: 1px solid rgba(34, 197, 94, 0.15);
      font-size: 9px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #86efac;
    }
    .review-badge {
      font-size: 9px;
      padding: 2px 7px;
      border-radius: 999px;
      border: 1px solid currentColor;
      letter-spacing: 0.06em;
    }
    .review-pending {
      padding: 10px;
      font-size: 11px;
      color: #71717a;
      text-align: center;
    }
    .review-body {
      padding: 8px 10px;
    }
    .review-summary {
      font-size: 11px;
      color: #d1fae5;
      line-height: 1.5;
      margin-bottom: 8px;
    }
    .review-stats {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 8px;
    }
    .review-stat {
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 4px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.09);
      color: #a1a1aa;
    }
    .review-links {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 8px;
    }
    .review-link {
      appearance: none;
      border: 1px solid rgba(34,197,94,0.3);
      background: rgba(34,197,94,0.08);
      color: #86efac;
      border-radius: 5px;
      padding: 5px 9px;
      font-family: inherit;
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: pointer;
      text-align: left;
    }
    .review-link:hover {
      background: rgba(34,197,94,0.16);
    }
    .spawn-row {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .spawn-n {
      width: 42px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 4px;
      color: #e4e4e7;
      font-family: inherit;
      font-size: 11px;
      text-align: center;
      padding: 4px 2px;
    }
    .spawn-btn {
      flex: 1;
      appearance: none;
      border: 1px solid rgba(125,211,252,0.3);
      background: rgba(125,211,252,0.08);
      color: #7dd3fc;
      border-radius: 5px;
      padding: 5px 8px;
      font-family: inherit;
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: pointer;
    }
    .spawn-btn:hover {
      background: rgba(125,211,252,0.16);
    }
  `;

  private emit(name: string, detail: Record<string, unknown>) {
    this.dispatchEvent(
      new CustomEvent(name, { detail, bubbles: true, composed: true }),
    );
  }

  private close = () => {
    this.open = false;
    this.emit("focus-close", {});
  };

  private onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.open && !event.defaultPrevented) {
      event.preventDefault();
      this.close();
    }
  };

  private onOpenSession = () => {
    this.emit("focus-open-session", {
      sessionKey: this.agent?.sessionKey ?? null,
    });
  };

  private onStop = () => {
    this.emit("focus-stop", { sessionKey: this.agent?.sessionKey ?? null });
  };

  private onOpenRun = () => {
    this.emit("focus-open-run", { runId: this.agent?.runId ?? null });
  };

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("agent") || changed.has("client")) {
      const runId: string | null = this.agent?.runId ?? null;
      if (runId && runId !== this._lastFetchRunId && this.client) {
        this._lastFetchRunId = runId;
        void this._fetchReview(runId);
      } else if (!runId) {
        this._review = null;
        this._lastFetchRunId = null;
      }
    }
  }

  private async _fetchReview(_runId: string): Promise<void> {
    if (!this.client) return;
    this._reviewLoading = true;
    try {
      const res = await (this.client as any).request("subagent_reviews_list", {
        sessionKey: this.agent?.sessionKey ?? undefined,
        limit: 1,
      }) as any;
      this._review = res?.reviews?.[0] ?? null;
    } catch {
      this._review = null;
    } finally {
      this._reviewLoading = false;
    }
  }

  private _onForceReview = async (): Promise<void> => {
    const runId = this.agent?.runId;
    if (!runId || !this.client) return;
    try {
      await (this.client as any).request("subagent_review_force", { runId });
      setTimeout(() => void this._fetchReview(runId), 2000);
    } catch { /* ignore */ }
  };

  private _onOpenOversight = (): void => {
    const runId = this._review?.runId ?? this._review?.run_id ?? this.agent?.runId;
    if (!runId) return;
    this.emit("focus-open-oversight", { runId: String(runId) });
  };

  private _onSpawnReviews = async (): Promise<void> => {
    const runId = this.agent?.runId;
    const n = Math.max(1, Math.min(10, this.spawnN || 3));
    if (!runId || !this.client) return;
    const ANGLES = ["correctness", "security", "UX & usability"];
    for (let i = 0; i < n; i++) {
      const angle = ANGLES[i % ANGLES.length];
      try {
        await (this.client as any).request("sessions.spawn", {
          task: `Independently review sub-agent run ${runId} from the ${angle} angle. Check quality, edge cases, and correctness. Return findings as structured JSON.`,
          agentId: "coder",
          label: `Review · ${angle} · ${String(runId).slice(0, 8)}`,
        });
      } catch { /* ignore individual failures */ }
    }
  };

  private _renderReview(agentStatus: string) {
    const isActive = agentStatus === "working" || agentStatus === "running" || agentStatus === "starting";
    if (isActive && !this._review) {
      return html`
        <div class="review-section">
          <div class="review-hdr">Review</div>
          <div class="review-pending">Review will generate on completion.</div>
        </div>
      `;
    }
    if (this._reviewLoading && !this._review) {
      return html`
        <div class="review-section">
          <div class="review-hdr">Review</div>
          <div class="review-pending">Loading…</div>
        </div>
      `;
    }
    if (!this._review) return nothing;

    const r = this._review;
    const status: string = r.status ?? "unknown";
    const BADGE_COLORS: Record<string, string> = {
      completed: "#22c55e", partial: "#f59e0b", errored: "#ef4444", aborted: "#6b7280",
    };
    const badgeColor = BADGE_COLORS[status] ?? "#9aa2b1";
    const summary: string = r.summary ?? "";
    const filesTouched: number = r.filesTouched ?? r.files_touched ?? 0;
    const nextSteps: number = Array.isArray(r.nextSteps) ? r.nextSteps.length : (r.next_steps_count ?? 0);
    const blockers: number = Array.isArray(r.blockers) ? r.blockers.length : (r.blockers_count ?? 0);
    const buildPassed: boolean | null = r.buildPassed ?? r.build_passed ?? null;

    return html`
      <div class="review-section">
        <div class="review-hdr">
          Review
          <span class="review-badge" style="color:${badgeColor};border-color:${badgeColor}40;">${status}</span>
        </div>
        <div class="review-body">
          ${r.completion
            ? html`<completion-verdict
                compact
                .completion=${r.completion}
                .runId=${String(r.runId ?? this.agent?.runId ?? "")}
                .client=${this.client}
                @verdict-decided=${() => {
                  const id = this.agent?.runId;
                  if (id) setTimeout(() => void this._fetchReview(id), 1500);
                }}
              ></completion-verdict>`
            : nothing}
          ${summary ? html`<div class="review-summary">${summary.slice(0, 160)}${summary.length > 160 ? "…" : ""}</div>` : nothing}
          <div class="review-stats">
            ${filesTouched ? html`<span class="review-stat">${filesTouched} files</span>` : nothing}
            ${buildPassed !== null ? html`<span class="review-stat" style="color:${buildPassed ? "#86efac" : "#f87171"}">Build ${buildPassed ? "✓" : "✗"}</span>` : nothing}
            ${nextSteps ? html`<span class="review-stat">${nextSteps} next steps</span>` : nothing}
            ${blockers ? html`<span class="review-stat" style="color:#f87171;">${blockers} blockers</span>` : nothing}
          </div>
          <div class="review-links">
            <button class="review-link" @click=${this._onOpenOversight}>Open in oversight →</button>
            <button class="review-link" @click=${this._onForceReview}>Force re-review</button>
          </div>
          <div class="spawn-row">
            <input class="spawn-n" type="number" min="1" max="10" .value=${String(this.spawnN)}
              @change=${(e: Event) => { this.spawnN = Number((e.target as HTMLInputElement).value) || 3; }} />
            <button class="spawn-btn" @click=${this._onSpawnReviews}>Spawn N review passes</button>
          </div>
        </div>
      </div>
    `;
  }

  render() {
    // Keep the host element mounted (for the slide transition) but render
    // nothing heavy while closed.
    if (!this.open) return html`<div class="panel"></div>`;
    if (this.agent) return this.renderAgent();
    if (this.node) return this.renderNode();
    return html`<div class="panel">
      <div class="empty">Nothing selected.</div>
    </div>`;
  }

  private renderAgent() {
    const a = this.agent || {};
    const status = String(a.status || "idle");
    const color = statusColor(status);
    const progress = Math.max(0, Math.min(100, Number(a.progress) || 0));
    const provider = a.provider || a.model || "";
    const lastTool = a.lastTool || null;
    const files: string[] = Array.isArray(a.filesTouched)
      ? a.filesTouched.filter(Boolean)
      : [];
    const name = a.label || a.agentId || a.sessionKey || "Agent";

    return html`<div class="panel">
      <div class="hdr">
        <div class="titles">
          <div class="kicker">Agent</div>
          <div class="title">${name}</div>
          ${a.agentId
            ? html`<div class="subtitle">${String(a.agentId)}</div>`
            : nothing}
        </div>
        <button class="x" title="Close" @click=${this.close}>✕</button>
      </div>

      <div class="body">
        <div class="row">
          <span class="chip" style="color:${color}">
            <span class="dot"></span>${status}
          </span>
        </div>

        ${provider
          ? html`<div class="row">
              <div class="label">Provider</div>
              <div class="value">${String(provider)}</div>
            </div>`
          : nothing}

        <div class="row">
          <div class="label">Progress</div>
          <div class="progress"><i style="width:${progress}%"></i></div>
          <div class="progress-pct">${progress}%</div>
        </div>

        ${a.currentTask
          ? html`<div class="row">
              <div class="label">Current Task</div>
              <div class="value">${String(a.currentTask)}</div>
            </div>`
          : nothing}

        ${lastTool
          ? html`<div class="row">
              <div class="label">Last Tool</div>
              <div class="tool">
                <div class="kind">${String(lastTool.kind || "tool")}</div>
                ${lastTool.label
                  ? html`<div class="desc">${String(lastTool.label)}</div>`
                  : nothing}
              </div>
            </div>`
          : nothing}

        ${files.length
          ? html`<div class="row">
              <div class="label">Files Touched · ${files.length}</div>
              <div class="files">
                ${files.map((f) => {
                  const full = String(f);
                  const base = fileName(full);
                  const dir = full.slice(0, full.length - base.length);
                  return html`<div class="file" title=${full}>
                    <span class="dir">${dir}</span>${base}
                  </div>`;
                })}
              </div>
            </div>`
          : nothing}

        ${a.runId
          ? html`<div class="row">
              <div class="label">Run ID</div>
              <div class="value mono-id">${String(a.runId)}</div>
            </div>`
          : nothing}

        ${this._renderReview(status)}
      </div>

      <div class="actions">
        <button
          class="act primary"
          ?disabled=${!a.sessionKey}
          @click=${this.onOpenSession}
        >
          Open Session
        </button>
        <button
          class="act danger"
          ?disabled=${!a.sessionKey}
          @click=${this.onStop}
        >
          Stop
        </button>
        <button class="act" ?disabled=${!a.runId} @click=${this.onOpenRun}>
          Open Run
        </button>
      </div>
    </div>`;
  }

  private renderNode() {
    const n = this.node || {};
    const status = String(n.status || "offline");
    const color = statusColor(status);
    const caps: string[] = Array.isArray(n.capabilities)
      ? n.capabilities.filter(Boolean)
      : [];
    const hw = n.hardware || null;
    const name = n.name || n.id || "Node";

    return html`<div class="panel">
      <div class="hdr">
        <div class="titles">
          <div class="kicker">Node</div>
          <div class="title">${name}</div>
          ${n.role
            ? html`<div class="subtitle">${String(n.role).toUpperCase()}</div>`
            : nothing}
        </div>
        <button class="x" title="Close" @click=${this.close}>✕</button>
      </div>

      <div class="body">
        <div class="row">
          <span class="chip" style="color:${color}">
            <span class="dot"></span>${status}
          </span>
        </div>

        <div class="row">
          <div class="label">Agents</div>
          <div class="value">${Number(n.agentCount) || 0}</div>
        </div>

        ${caps.length
          ? html`<div class="row">
              <div class="label">Capabilities · ${caps.length}</div>
              <div class="caps">
                ${caps.map((c) => html`<span class="cap">${String(c)}</span>`)}
              </div>
            </div>`
          : nothing}

        ${hw
          ? html`<div class="row">
              <div class="label">Hardware</div>
              <div class="hw">
                ${hw.cpu
                  ? html`<div class="hw-row">
                      <span class="k">CPU</span><span class="v"
                        >${String(hw.cpu)}</span
                      >
                    </div>`
                  : nothing}
                ${hw.mem
                  ? html`<div class="hw-row">
                      <span class="k">MEM</span><span class="v"
                        >${String(hw.mem)}</span
                      >
                    </div>`
                  : nothing}
                ${hw.gpu
                  ? html`<div class="hw-row">
                      <span class="k">GPU</span><span class="v"
                        >${String(hw.gpu)}</span
                      >
                    </div>`
                  : nothing}
              </div>
            </div>`
          : nothing}
      </div>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "agent-focus-panel": AgentFocusPanel;
  }
}
