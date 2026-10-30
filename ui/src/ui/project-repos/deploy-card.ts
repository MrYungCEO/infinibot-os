/**
 * <ib-repo-deploy-card .repoKey | .path | .projectId> — the repo's deploy
 * branch: branch, absolute deploy folder, target, command, ahead/behind
 * origin, uncommitted changes and last deploy. Without one it shows the
 * auto-detected suggestion with its confidence and a one-click "Use this".
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icons } from "../icons";
import { inferBasePathFromPathname } from "../navigation";
import {
  onRepoEvents,
  reposApi,
  pathParts,
  targetLabel,
  type DeployCandidate,
  type DeployConfig,
  type DeployStatus,
  type DeploySuggestion,
  type DeployTargetKind,
  type RepoRefParams,
  type RepoSummary,
} from "./health-store";
import { relTime, showRepoToast } from "./store";

/** Open the Repos page (optionally on one repo's branch health). */
export function openReposPage(repoKey?: string, extra: Record<string, string> = {}): void {
  const base = inferBasePathFromPathname(window.location.pathname);
  const q = new URLSearchParams({ view: "repos", ...(repoKey ? { repo: repoKey } : {}), ...extra });
  window.history.pushState({}, "", `${base.replace(/\/+$/, "")}/projects?${q.toString()}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const TARGET_KINDS: DeployTargetKind[] = ["fly", "gateway", "netlify", "vercel", "docker", "other"];

export const deployCardStyles = css`
  :host {
    display: block;
    min-width: 0;
    color: var(--text, #ece6d6);
    font-size: 13px;
  }
  .card {
    position: relative;
    border-radius: 14px;
    padding: 14px 16px;
    background: linear-gradient(160deg, rgba(30, 25, 12, 0.92), rgba(12, 11, 9, 0.94));
    border: 1px solid rgba(212, 175, 55, 0.32);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4) inset, 0 12px 32px rgba(0, 0, 0, 0.35);
    min-width: 0;
  }
  .card.unset {
    border-style: dashed;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .kicker {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: rgba(212, 175, 55, 0.85);
  }
  .branch {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 15px;
    font-weight: 650;
    color: #f6e3a1;
    overflow-wrap: anywhere;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 11px;
    border: 1px solid rgba(212, 175, 55, 0.35);
    color: #e9d48f;
    background: rgba(212, 175, 55, 0.1);
    white-space: nowrap;
  }
  .pill.warn {
    border-color: rgba(245, 176, 65, 0.6);
    color: #f5c46b;
    background: rgba(245, 176, 65, 0.1);
  }
  .pill.ok {
    border-color: rgba(90, 209, 154, 0.5);
    color: #8fe3bb;
    background: rgba(90, 209, 154, 0.08);
  }
  .grid {
    display: grid;
    grid-template-columns: minmax(84px, max-content) minmax(0, 1fr);
    gap: 6px 12px;
    margin-top: 12px;
    align-items: baseline;
  }
  .k {
    color: var(--muted, #9a937f);
    font-size: 12px;
  }
  .v {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    flex-wrap: wrap;
  }
  .row > .mono {
    min-width: 0;
    flex: 0 1 auto;
  }
  button {
    font: inherit;
    cursor: pointer;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px;
    min-height: 34px;
    border-radius: 10px;
    border: 1px solid rgba(212, 175, 55, 0.35);
    background: rgba(212, 175, 55, 0.08);
    color: #f0dc9a;
    font-size: 12.5px;
  }
  .btn:hover {
    background: rgba(212, 175, 55, 0.16);
  }
  .btn.primary {
    background: linear-gradient(180deg, #e8c766, #c29a2e);
    color: #1a1406;
    border-color: #e8c766;
    font-weight: 650;
  }
  .btn.ghost {
    border-color: transparent;
    background: transparent;
    color: var(--muted, #b3aa90);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .icon-btn {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    padding: 4px;
    border-radius: 6px;
    color: rgba(212, 175, 55, 0.8);
  }
  .icon-btn:hover {
    background: rgba(212, 175, 55, 0.14);
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 14px;
  }
  .conf {
    position: relative;
    width: 84px;
    height: 6px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.08);
    overflow: hidden;
  }
  .conf > i {
    position: absolute;
    inset: 0 auto 0 0;
    background: linear-gradient(90deg, #8a6d1f, #f0cf68);
  }
  .signals {
    margin: 8px 0 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 3px;
    color: var(--muted, #b3aa90);
    font-size: 12px;
  }
  .signals li::before {
    content: "";
    display: inline-block;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: rgba(212, 175, 55, 0.7);
    margin-right: 7px;
    vertical-align: middle;
  }
  .alts {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 10px;
  }
  .alt {
    all: unset;
    cursor: pointer;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11.5px;
    padding: 3px 8px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    color: #d8cfb5;
  }
  .alt:hover {
    border-color: rgba(212, 175, 55, 0.5);
  }
  form {
    display: grid;
    gap: 10px;
    margin-top: 12px;
  }
  label {
    display: grid;
    gap: 4px;
    font-size: 12px;
    color: var(--muted, #b3aa90);
  }
  input,
  select,
  textarea {
    font: inherit;
    font-size: 13px;
    color: #f2ead2;
    background: rgba(0, 0, 0, 0.45);
    border: 1px solid rgba(212, 175, 55, 0.25);
    border-radius: 9px;
    padding: 8px 10px;
    min-width: 0;
    min-height: 36px;
    box-sizing: border-box;
    width: 100%;
  }
  .two {
    display: grid;
    grid-template-columns: 140px minmax(0, 1fr);
    gap: 8px;
  }
  .muted {
    color: var(--muted, #9a937f);
  }
  .err {
    color: #ff9b8a;
    font-size: 12px;
    margin-top: 8px;
  }
  .skeleton {
    height: 92px;
    border-radius: 10px;
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.03), rgba(212, 175, 55, 0.08), rgba(255, 255, 255, 0.03));
    background-size: 200% 100%;
    animation: sh 1.4s linear infinite;
  }
  @keyframes sh {
    to {
      background-position: -200% 0;
    }
  }
  svg {
    width: 14px;
    height: 14px;
  }
  @media (max-width: 560px) {
    .card {
      padding: 12px;
    }
    .grid {
      grid-template-columns: minmax(0, 1fr);
      gap: 2px;
    }
    .grid .k {
      margin-top: 6px;
    }
    .two {
      grid-template-columns: minmax(0, 1fr);
    }
    .btn {
      flex: 1 1 auto;
      justify-content: center;
    }
  }
`;

@customElement("ib-repo-deploy-card")
export class RepoDeployCard extends LitElement {
  @property({ attribute: false }) repoKey?: string;
  @property({ attribute: false }) path?: string;
  @property({ attribute: false }) projectId?: string;
  /** Hide the "Branch health" link (when already on that page). */
  @property({ type: Boolean }) inPage = false;

  @state() private repo: RepoSummary | null = null;
  @state() private deploy: DeployConfig | null = null;
  @state() private status: DeployStatus | null = null;
  @state() private suggestion: DeploySuggestion | null = null;
  @state() private loading = true;
  @state() private detecting = false;
  @state() private editing = false;
  @state() private saving = false;
  @state() private error = "";
  @state() private draft: {
    branch: string;
    worktreePath: string;
    kind: DeployTargetKind | "";
    name: string;
    command: string;
    notes: string;
  } = { branch: "", worktreePath: "", kind: "", name: "", command: "", notes: "" };

  private off: (() => void) | null = null;

  static styles = deployCardStyles;

  private get ref(): RepoRefParams {
    return { repoKey: this.repoKey, path: this.path, projectId: this.projectId };
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
    void onRepoEvents((event, p) => {
      if (event === "projects.repo.changed" && (p.reason === "deploy" || p.reason === "attach") && (!p.repoKey || p.repoKey === this.repo?.key)) {
        void this.load(true);
      }
    }).then((off) => {
      if (this.isConnected) this.off = off;
      else off();
    });
  }

  disconnectedCallback(): void {
    this.off?.();
    this.off = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("repoKey") || changed.has("path") || changed.has("projectId")) {
      if (changed.get("repoKey") !== undefined || changed.get("path") !== undefined || changed.get("projectId") !== undefined) {
        void this.load();
      }
    }
  }

  private async load(quiet = false) {
    if (!this.repoKey && !this.path && !this.projectId) return;
    if (!quiet) this.loading = true;
    this.error = "";
    try {
      const res = await reposApi.deployGet(this.ref, true);
      this.repo = res.repo;
      this.deploy = res.deploy;
      this.status = res.status;
      if (!res.deploy && !this.suggestion) void this.detect();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  private async detect() {
    this.detecting = true;
    try {
      this.suggestion = await reposApi.suggest(this.repo ? { repoKey: this.repo.key } : this.ref);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.detecting = false;
    }
  }

  private async save(cfg: {
    branch: string;
    worktreePath: string;
    target?: { kind: DeployTargetKind; name?: string };
    command?: string;
    notes?: string;
    source: "manual" | "auto";
    confidence?: number;
  }) {
    this.saving = true;
    this.error = "";
    try {
      const res = await reposApi.deploySet(this.repo ? { repoKey: this.repo.key } : this.ref, cfg);
      this.repo = res.repo;
      this.deploy = res.deploy;
      this.status = res.status;
      this.editing = false;
      this.dispatchEvent(new CustomEvent("deploy-changed", { detail: res.deploy, bubbles: true, composed: true }));
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.saving = false;
    }
  }

  private useCandidate(c: DeployCandidate) {
    if (!c.worktreePath) {
      this.startEdit(c);
      return;
    }
    void this.save({
      branch: c.branch,
      worktreePath: c.worktreePath,
      target: c.target,
      command: c.command,
      source: "auto",
      confidence: c.confidence,
    });
  }

  private startEdit(from?: DeployCandidate) {
    const d = this.deploy;
    this.draft = {
      branch: from?.branch ?? d?.branch ?? this.suggestion?.best?.branch ?? "",
      worktreePath: from?.worktreePath ?? d?.worktreePath ?? this.suggestion?.best?.worktreePath ?? this.repo?.root ?? "",
      kind: (from?.target?.kind ?? d?.target?.kind ?? this.suggestion?.best?.target?.kind ?? "") as DeployTargetKind | "",
      name: from?.target?.name ?? d?.target?.name ?? this.suggestion?.best?.target?.name ?? "",
      command: from?.command ?? d?.command ?? this.suggestion?.best?.command ?? "",
      notes: d?.notes ?? "",
    };
    this.editing = true;
    if (!this.suggestion) void this.detect();
  }

  private copy(text: string) {
    void navigator.clipboard?.writeText(text).then(
      () => showRepoToast("Copied", "ok"),
      () => undefined,
    );
  }

  private renderStatus(d: DeployConfig, s: DeployStatus | null) {
    const ab = s
      ? s.originRef
        ? s.ahead || s.behind
          ? html`<span class="pill ${s.behind ? "warn" : ""}">${s.behind ? `${s.behind} behind` : ""}${s.ahead && s.behind ? " · " : ""}${s.ahead ? `${s.ahead} ahead` : ""}</span>
              <span class="muted mono">${s.originRef}</span>`
          : html`<span class="pill ok">in sync</span> <span class="muted mono">${s.originRef}</span>`
        : html`<span class="muted">no origin branch</span>`
      : nothing;
    return html`<div class="grid">
      <span class="k">Folder</span>
      <span class="v row"
        ><span class="mono" data-deploy-path>${pathParts(d.worktreePath).map((seg) => html`<span style="white-space:nowrap">${seg}</span><wbr />`)}</span
        ><button class="icon-btn" title="Copy path" aria-label="Copy path" @click=${() => this.copy(d.worktreePath)}>${icons.copy}</button></span
      >
      ${d.target
        ? html`<span class="k">Target</span><span class="v">${targetLabel(d.target)}</span>`
        : nothing}
      ${d.command
        ? html`<span class="k">Command</span
            ><span class="v row"
              ><span class="mono">${d.command}</span
              ><button class="icon-btn" title="Copy command" aria-label="Copy command" @click=${() => this.copy(d.command!)}>${icons.copy}</button></span
            >`
        : nothing}
      ${s
        ? html`<span class="k">Checked out</span>
            <span class="v">
              ${!s.exists
                ? html`<span class="pill warn">folder missing</span>`
                : s.onDeployBranch
                  ? html`<span class="pill ok">${icons.check} on ${d.branch}</span>`
                  : html`<span class="pill warn">on ${s.checkedOutBranch ?? "detached HEAD"}</span>`}
            </span>
            <span class="k">Origin</span><span class="v row">${ab}${s.fetchedAt ? html`<span class="muted">· fetched ${relTime(s.fetchedAt)}</span>` : nothing}</span>
            <span class="k">Changes</span>
            <span class="v">${s.dirty ? html`<span class="pill warn">${s.dirtyCount} uncommitted</span>` : html`<span class="pill ok">clean</span>`}</span>
            <span class="k">Last commit</span><span class="v">${s.headSubject ?? "—"} <span class="muted">${relTime(s.headAt)}</span></span>
            <span class="k">Last deploy</span>
            <span class="v">${s.lastDeploy ? html`${relTime(s.lastDeploy.at)} <span class="muted">· ${s.lastDeploy.detail ?? s.lastDeploy.source}</span>` : html`<span class="muted">unknown</span>`}</span>`
        : nothing}
      ${d.notes ? html`<span class="k">Notes</span><span class="v">${d.notes}</span>` : nothing}
    </div>`;
  }

  private renderSuggestion() {
    const sg = this.suggestion;
    const best = sg?.best;
    if (this.detecting && !sg) {
      return html`<div class="muted" style="margin-top:10px">Looking at fly.toml, CI, the running gateway, recent deploys and release branches…</div>`;
    }
    if (!best) return html`<div class="muted" style="margin-top:10px">No suggestion — set it by hand.</div>`;
    const pct = Math.round(best.confidence * 100);
    return html`<div style="margin-top:10px" data-deploy-suggestion>
      <div class="row">
        <span class="muted">Suggested</span>
        <span class="branch">${best.branch}</span>
        <span class="conf" title="${pct}% confidence"><i style="width:${pct}%"></i></span>
        <span class="pill">${pct}% sure</span>
      </div>
      <div class="grid">
        <span class="k">Folder</span><span class="v mono">${best.worktreePath ? pathParts(best.worktreePath).map((seg) => html`<span style="white-space:nowrap">${seg}</span><wbr />`) : html`<span class="muted">not checked out — pick a folder</span>`}</span>
        ${best.target ? html`<span class="k">Target</span><span class="v">${targetLabel(best.target)}</span>` : nothing}
      </div>
      <ul class="signals">
        ${best.signals.map((s) => html`<li>${s.detail}</li>`)}
      </ul>
      ${sg && sg.candidates.length > 1
        ? html`<div class="alts">
            <span class="muted" style="font-size:12px;align-self:center">Or:</span>
            ${sg.candidates.slice(1, 5).map(
              (c) => html`<button class="alt" title=${c.signals.map((s) => s.detail).join("\n")} @click=${() => this.startEdit(c)}>${c.branch} · ${Math.round(c.confidence * 100)}%</button>`,
            )}
          </div>`
        : nothing}
      <div class="actions">
        <button class="btn primary" data-deploy-use ?disabled=${this.saving} @click=${() => this.useCandidate(best)}>
          ${icons.check}<span>${this.saving ? "Saving…" : "Use this"}</span>
        </button>
        <button class="btn" @click=${() => this.startEdit()}>${icons.edit}<span>Choose another</span></button>
      </div>
    </div>`;
  }

  private renderForm() {
    const d = this.draft;
    const sg = this.suggestion;
    const branches = [...new Set((sg?.candidates ?? []).map((c) => c.branch))];
    const folders = [...new Set((sg?.candidates ?? []).map((c) => c.worktreePath).filter(Boolean) as string[])];
    const set = (k: keyof typeof d) => (e: Event) => {
      this.draft = { ...this.draft, [k]: (e.target as HTMLInputElement).value };
    };
    return html`<form
      data-deploy-form
      @submit=${(e: Event) => {
        e.preventDefault();
        if (!d.branch.trim() || !d.worktreePath.trim()) {
          this.error = "Branch and folder are required";
          return;
        }
        void this.save({
          branch: d.branch.trim(),
          worktreePath: d.worktreePath.trim(),
          target: d.kind ? { kind: d.kind, name: d.name.trim() || undefined } : undefined,
          command: d.command.trim() || undefined,
          notes: d.notes.trim() || undefined,
          source: "manual",
        });
      }}
    >
      <label>Deploy branch
        <input name="branch" list="ib-deploy-branches" .value=${d.branch} @input=${set("branch")} placeholder="release/2026-10-12" autocomplete="off" />
        <datalist id="ib-deploy-branches">${branches.map((b) => html`<option value=${b}></option>`)}</datalist>
      </label>
      <label>Folder it is checked out in (absolute path)
        <input name="worktreePath" class="mono" list="ib-deploy-folders" .value=${d.worktreePath} @input=${set("worktreePath")} placeholder="/home/you/code/app-release" autocomplete="off" />
        <datalist id="ib-deploy-folders">${folders.map((f) => html`<option value=${f}></option>`)}</datalist>
      </label>
      <div class="two">
        <label>Target
          <select name="kind" .value=${d.kind} @change=${set("kind")}>
            <option value="">—</option>
            ${TARGET_KINDS.map((k) => html`<option value=${k} ?selected=${d.kind === k}>${k === "gateway" ? "InfiniBot gateway" : k}</option>`)}
          </select>
        </label>
        <label>Name (Fly app, site…)
          <input name="name" .value=${d.name} @input=${set("name")} placeholder="flypic-web" />
        </label>
      </div>
      <label>Deploy command
        <input name="command" class="mono" .value=${d.command} @input=${set("command")} placeholder="fly deploy -c deploy/fly/fly.toml" />
      </label>
      <label>Notes
        <textarea name="notes" rows="2" .value=${d.notes} @input=${set("notes")} placeholder="Anything an agent should know before deploying"></textarea>
      </label>
      <div class="actions" style="margin-top:2px">
        <button class="btn primary" type="submit" data-deploy-save ?disabled=${this.saving}>${icons.save}<span>${this.saving ? "Saving…" : "Save deploy branch"}</span></button>
        <button class="btn ghost" type="button" @click=${() => (this.editing = false)}>Cancel</button>
      </div>
    </form>`;
  }

  render() {
    if (this.loading && !this.repo) return html`<div class="card"><div class="skeleton"></div></div>`;
    if (!this.repo) return html`<div class="card unset"><div class="err">${this.error || "No repo"}</div></div>`;
    const d = this.deploy;
    return html`<div class="card ${d ? "" : "unset"}" data-deploy-card data-repo-key=${this.repo.key}>
      <div class="head">
        <span class="kicker">${icons.rocket} Deploy branch</span>
        ${d
          ? html`<span class="pill ${d.source === "manual" ? "ok" : ""}">${d.source === "manual" ? "confirmed" : `auto · ${Math.round((d.confidence ?? 0) * 100)}%`}</span>`
          : html`<span class="pill warn">not set</span>`}
        <span style="flex:1"></span>
        ${d && !this.editing
          ? html`<button class="icon-btn" title="Re-check status" aria-label="Refresh" @click=${() => this.load(true)}>${icons.refresh}</button>`
          : nothing}
      </div>
      ${d ? html`<div class="branch" style="margin-top:8px" data-deploy-branch>${d.branch}</div>` : nothing}
      ${this.editing ? this.renderForm() : d ? this.renderStatus(d, this.status) : this.renderSuggestion()}
      ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
      ${d && !this.editing
        ? html`<div class="actions">
            <button class="btn" data-deploy-change @click=${() => this.startEdit()}>${icons.edit}<span>Change</span></button>
            ${d.source !== "manual"
              ? html`<button class="btn" @click=${() => this.save({ ...d, source: "manual" })}>${icons.check}<span>Confirm</span></button>`
              : nothing}
            ${this.inPage
              ? nothing
              : html`<button class="btn" @click=${() => openReposPage(this.repo!.key)}>${icons.activity}<span>Branch health</span></button>`}
          </div>`
        : nothing}
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-repo-deploy-card": RepoDeployCard;
  }
}
