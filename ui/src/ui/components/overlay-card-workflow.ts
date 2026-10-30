/**
 * overlay-card-workflow.ts — a running / just-finished workflow run with steps.
 *
 * Data source: the workflow run RPCs already wired in the workflows view —
 * `workflows.run.get` (when a runId is in the payload) and `workflows.run.list`
 * (to surface the most relevant active / recent run otherwise). Polls only while
 * the run is non-terminal, then settles.
 *
 * Payload: `{ runId?: string, workflowId?: string }`
 */
import { html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { OverlayCardBase } from "./overlay-card-base.js";

type RunStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

interface WorkflowIteration {
  number: number;
  startedAt: string;
  finishedAt?: string;
  status: Exclude<RunStatus, "paused">;
  result?: string;
  error?: string;
  durationMs?: number;
}

interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  agent: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  result?: string;
  iterations?: WorkflowIteration[];
  iterationCount?: number;
}

const TERMINAL: RunStatus[] = ["completed", "failed", "cancelled", "timeout"];
const POLL_MS = 3000;

const STATUS_COLOR: Record<RunStatus, string> = {
  pending: "#a1a1aa",
  running: "#22c55e",
  paused: "#eab308",
  completed: "var(--g-primary, #d4af37)",
  failed: "#ef4444",
  cancelled: "#71717a",
  timeout: "#f97316",
};

@customElement("overlay-card-workflow")
export class OverlayCardWorkflow extends OverlayCardBase {
  @state() private run: WorkflowRun | null = null;
  @state() private err: string | null = null;
  @state() private loading = true;

  private timer: number | null = null;

  override connectedCallback() {
    super.connectedCallback();
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), POLL_MS);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.timer !== null) window.clearInterval(this.timer);
  }

  private stopPolling() {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async refresh() {
    if (!this.client) return;
    try {
      let run: WorkflowRun | null = null;
      const runId = this.payload?.runId as string | undefined;
      if (runId) {
        run = (await this.client.request("workflows.run.get", { runId })) as WorkflowRun;
      } else {
        const res = (await this.client.request("workflows.run.list", {
          workflowId: this.payload?.workflowId,
          limit: 25,
        })) as { runs: WorkflowRun[] };
        const runs = res?.runs ?? [];
        // Prefer an active run, else the most recent (just-finished).
        run =
          runs.find((r) => r.status === "running" || r.status === "pending") ??
          runs.sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1))[0] ??
          null;
      }
      this.run = run;
      this.err = null;
      this.loading = false;
      if (run && TERMINAL.includes(run.status)) this.stopPolling();
    } catch (e) {
      this.err = String((e as Error)?.message ?? e);
      this.loading = false;
    }
  }

  protected accent = "#a78bfa";

  protected cardTitle() {
    return this.run?.workflowName || "Workflow";
  }

  protected headerMeta() {
    return this.run ? this.run.status.toUpperCase() : null;
  }

  private fmtDur(ms?: number): string {
    if (!ms) return "";
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  }

  protected renderBody() {
    if (this.loading) return html`<div class="muted">Loading run…</div>`;
    if (this.err) return html`<div class="err">${this.err}</div>`;
    if (!this.run) return html`<div class="muted">No workflow runs yet.</div>`;

    const r = this.run;
    const color = STATUS_COLOR[r.status] ?? "#a1a1aa";
    const iters = r.iterations ?? [];

    return html`
      <div class="head-row">
        <span class="status" style=${`color:${color};border-color:${color}`}>${r.status}</span>
        <span class="agent">${r.agent}</span>
      </div>

      ${iters.length
        ? html`
            <div class="steps">
              ${iters
                .slice(-8)
                .map(
                  (it) => html`
                    <div class="step">
                      <span class="step-dot" style=${`background:${STATUS_COLOR[it.status] ?? "#71717a"}`}></span>
                      <span class="step-n">#${it.number}</span>
                      <span class="step-status">${it.status}</span>
                      ${it.durationMs ? html`<span class="step-dur">${this.fmtDur(it.durationMs)}</span>` : null}
                    </div>
                    ${it.error ? html`<div class="step-err">${it.error}</div>` : null}
                  `,
                )}
            </div>
            ${r.iterationCount && r.iterationCount > iters.length
              ? html`<div class="muted small">+${r.iterationCount - iters.length} earlier iterations</div>`
              : null}
          `
        : html`
            <div class="steps">
              <div class="step">
                <span class="step-dot" style=${`background:${color}`}></span>
                <span class="step-status">${r.status === "running" ? "agent active" : r.status}</span>
              </div>
            </div>
          `}

      ${r.error ? html`<div class="err">${r.error}</div>` : null}
      ${r.result ? html`<div class="result" title=${r.result}>${r.result}</div>` : null}
    `;
  }

  static styles = [
    OverlayCardBase.baseStyles,
    css`
      .muted { font-size: 11px; color: #71717a; }
      .small { font-size: 9px; margin-top: 4px; }
      .err {
        font-size: 10px;
        color: #ef4444;
        margin-top: 6px;
        word-break: break-word;
      }
      .head-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      .status {
        font-size: 9px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        border: 1px solid;
        border-radius: 999px;
        padding: 2px 8px;
      }
      .agent { font-size: 10px; color: #a1a1aa; }
      .steps { display: flex; flex-direction: column; gap: 4px; min-width: 240px; }
      .step {
        display: flex;
        align-items: center;
        gap: 7px;
        font-size: 10px;
        color: #d4d4d8;
      }
      .step-dot { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; }
      .step-n { color: #71717a; }
      .step-status { text-transform: capitalize; }
      .step-dur { margin-left: auto; color: #71717a; font-size: 9px; }
      .step-err {
        font-size: 9px;
        color: #ef4444;
        margin-left: 13px;
        word-break: break-word;
      }
      .result {
        margin-top: 8px;
        font-size: 9px;
        color: #a1a1aa;
        max-height: 60px;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "overlay-card-workflow": OverlayCardWorkflow;
  }
}
