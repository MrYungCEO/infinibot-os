/**
 * <ib-repo-setup> — first-time setup for attaching a repo.
 *
 *   1 Pick     choose a folder (shared picker) or clone a URL; optionally
 *              attach it to a board project
 *   2 Deploy   detect the default branch, propose the deploy branch
 *   3 Learn    branches and worktrees in plain language, with a diagram
 *   4 GitHub   `gh auth status` (optional)
 *   5 Scan     first branch-health scan
 *   6 Done     "here's where you deploy from"
 *
 * Every step can be skipped; progress is saved on the gateway
 * (projects.repo.setup.update) so a reload resumes where you left off.
 */

import { LitElement, css, html, nothing, svg } from "lit";
import { customElement, state } from "lit/decorators.js";
import { awaitGatewayClient } from "../gateway-client";
import { icons } from "../icons";
import "./deploy-card";
import {
  fmtBytes,
  reposApi,
  targetLabel,
  type GithubStatus,
  type HealthReport,
  type RepoSummary,
} from "./health-store";
import { openRepoPicker } from "./repo-picker";
import { attachProjectRepo, showRepoToast } from "./store";

const STEPS = [
  { id: "pick", label: "Pick a repo" },
  { id: "branch", label: "Deploy branch" },
  { id: "learn", label: "Branches 101" },
  { id: "github", label: "GitHub" },
  { id: "scan", label: "Health scan" },
  { id: "done", label: "Done" },
] as const;
type StepId = (typeof STEPS)[number]["id"];

const DIAGRAM = svg`<svg viewBox="0 0 560 196" role="img" aria-label="Branches and worktrees diagram" style="width:100%;height:auto;max-width:620px">
  <defs>
    <linearGradient id="ib-deploy-line" gradientUnits="userSpaceOnUse" x1="80" y1="0" x2="540" y2="0">
      <stop offset="0" stop-color="#8a6d1f"/><stop offset="1" stop-color="#f0cf68"/>
    </linearGradient>
  </defs>
  <text x="8" y="37" fill="#d4af37" font-size="15" font-family="ui-monospace,monospace">deploy</text>
  <line x1="80" y1="32" x2="540" y2="32" stroke="url(#ib-deploy-line)" stroke-width="4" stroke-linecap="round"/>
  ${[110, 190, 300, 420, 520].map((x) => svg`<circle cx=${x} cy="32" r="8" fill="#17140c" stroke="#f0cf68" stroke-width="2.5"/>`)}
  <text x="8" y="97" fill="#8fe3bb" font-size="15" font-family="ui-monospace,monospace">feature</text>
  <path d="M190 32 C 215 32, 215 92, 240 92 L 330 92 C 355 92, 355 32, 420 32" fill="none" stroke="#5ad19a" stroke-width="3"/>
  ${[260, 310].map((x) => svg`<circle cx=${x} cy="92" r="7" fill="#0d1a13" stroke="#5ad19a" stroke-width="2.5"/>`)}
  <text x="232" y="122" fill="#8fe3bb" font-size="14" font-family="system-ui">merged → safe to delete</text>
  <text x="8" y="167" fill="#f5c46b" font-size="15" font-family="ui-monospace,monospace">wip</text>
  <path d="M110 32 C 135 32, 135 162, 160 162 L 290 162" fill="none" stroke="#f5b041" stroke-width="3"/>
  ${[200, 250].map((x) => svg`<circle cx=${x} cy="162" r="7" fill="#1d150a" stroke="#f5b041" stroke-width="2.5"/>`)}
  <rect x="300" y="140" width="112" height="44" rx="9" fill="rgba(212,175,55,0.06)" stroke="#d4af37" stroke-dasharray="5 4"/>
  <text x="356" y="160" fill="#d4af37" font-size="13" text-anchor="middle" font-family="system-ui">worktree</text>
  <text x="356" y="176" fill="#d4af37" font-size="13" text-anchor="middle" font-family="system-ui">folder</text>
  <text x="424" y="167" fill="#f5c46b" font-size="14" font-family="system-ui">not merged</text>
  <text x="424" y="184" fill="#f5c46b" font-size="14" font-family="system-ui">→ review</text>
</svg>`;

@customElement("ib-repo-setup")
export class RepoSetupWizard extends LitElement {
  @state() private step: StepId = "pick";
  @state() private done = new Set<StepId>();
  @state() private repo: RepoSummary | null = null;
  @state() private cloneUrl = "";
  @state() private busy = false;
  @state() private error = "";
  @state() private gh: GithubStatus | null = null;
  @state() private report: HealthReport | null = null;
  @state() private projects: Array<{ id: string; name: string }> = [];
  @state() private projectId = "";
  @state() private defaultBranch = "";

  static styles = css`
    :host {
      display: block;
      color: var(--text, #ece6d6);
      font-size: 13.5px;
    }
    .box {
      border-radius: 18px;
      border: 1px solid rgba(212, 175, 55, 0.4);
      background: radial-gradient(120% 140% at 0% 0%, rgba(212, 175, 55, 0.12), transparent 55%),
        linear-gradient(170deg, #17140c, #0b0a08);
      padding: 18px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
    }
    .top {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    h2 {
      margin: 0;
      font-size: 18px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    h2 svg {
      color: #d4af37;
      width: 20px;
      height: 20px;
    }
    .steps {
      display: flex;
      gap: 6px;
      margin: 14px 0 16px;
      overflow-x: auto;
      scrollbar-width: none;
      padding-bottom: 2px;
      /* Fade the right edge so it reads as scrollable on narrow screens. */
      mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent);
      -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent);
      padding-right: 24px;
    }
    .s {
      all: unset;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #b9af93;
      font-size: 12px;
      white-space: nowrap;
    }
    .s .n {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      display: inline-grid;
      place-items: center;
      font-size: 11px;
      background: rgba(255, 255, 255, 0.07);
    }
    .s.on {
      border-color: rgba(212, 175, 55, 0.7);
      color: #f6e3a1;
      background: rgba(212, 175, 55, 0.1);
    }
    .s.ok .n {
      background: #b8932c;
      color: #17140c;
    }
    .s svg {
      width: 11px;
      height: 11px;
    }
    .pane {
      display: grid;
      gap: 12px;
    }
    .lead {
      color: #d8cfb5;
      line-height: 1.55;
      max-width: 720px;
    }
    .muted {
      color: var(--muted, #9a937f);
    }
    .mono {
      font-family: var(--font-mono, ui-monospace, monospace);
      font-size: 12.5px;
      overflow-wrap: anywhere;
    }
    .choice {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
      gap: 12px;
    }
    .opt {
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.025);
      padding: 14px;
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .opt b {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .opt b svg {
      color: #d4af37;
    }
    input,
    select {
      font: inherit;
      color: #f2ead2;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(212, 175, 55, 0.28);
      border-radius: 10px;
      padding: 9px 11px;
      min-height: 40px;
      width: 100%;
      box-sizing: border-box;
    }
    button {
      font: inherit;
      cursor: pointer;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      padding: 9px 14px;
      min-height: 40px;
      border-radius: 10px;
      border: 1px solid rgba(212, 175, 55, 0.35);
      background: rgba(212, 175, 55, 0.08);
      color: #f0dc9a;
      font-size: 13px;
    }
    .btn.primary {
      background: linear-gradient(180deg, #e8c766, #c29a2e);
      color: #1a1406;
      border-color: #e8c766;
      font-weight: 650;
    }
    .btn.ghost {
      background: transparent;
      border-color: transparent;
      color: #b3aa90;
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: default;
    }
    svg {
      width: 15px;
      height: 15px;
    }
    .nav {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 4px;
      align-items: center;
    }
    .grow {
      flex: 1;
    }
    .facts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
      gap: 10px;
    }
    .fact {
      border-radius: 12px;
      padding: 12px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.07);
      line-height: 1.5;
    }
    .fact b {
      color: #f6e3a1;
      display: block;
      margin-bottom: 4px;
    }
    .err {
      color: #ff9b8a;
    }
    .ok {
      color: #8fe3bb;
    }
    .big {
      font-size: 15px;
      color: #f6e3a1;
    }
    .diagram {
      border-radius: 14px;
      border: 1px solid rgba(212, 175, 55, 0.2);
      background: rgba(0, 0, 0, 0.35);
      padding: 10px;
      overflow-x: auto;
    }
    @media (max-width: 560px) {
      .box {
        padding: 14px;
        border-radius: 14px;
      }
      .diagram svg {
        min-width: 540px;
      }
      .steps {
        flex-wrap: wrap;
        overflow: visible;
        mask-image: none;
        -webkit-mask-image: none;
        padding-right: 0;
      }
      .nav .btn {
        flex: 1 1 auto;
      }
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    void this.restore();
  }

  private async restore() {
    try {
      const st = await reposApi.setupGet();
      const steps = st.setup.steps ?? {};
      this.done = new Set(Object.keys(steps) as StepId[]);
      if (st.setup.repoKey) this.repo = st.repos.find((r) => r.key === st.setup.repoKey) ?? null;
      if (st.setup.projectId) this.projectId = st.setup.projectId;
      const next = STEPS.find((s) => !this.done.has(s.id));
      this.step = this.repo ? (next?.id ?? "done") : "pick";
      if (this.step === "github") void this.checkGh();
      if (this.step === "scan" || this.step === "done") void this.loadReport();
    } catch {
      /* fresh start */
    }
    void this.loadProjects();
  }

  private async loadProjects() {
    try {
      const client = await awaitGatewayClient(15_000);
      const raw = await client.request<unknown>("kanban.projects.list", {});
      const list = (Array.isArray(raw) ? raw : ((raw as { projects?: unknown[] })?.projects ?? [])) as Array<Record<string, unknown>>;
      this.projects = list
        .filter((p) => typeof p.id === "string")
        .map((p) => ({ id: p.id as string, name: String(p.name ?? p.title ?? p.id) }))
        .slice(0, 300);
    } catch {
      this.projects = [];
    }
  }

  private async mark(step: StepId, skipped = false) {
    this.done = new Set([...this.done, step]);
    try {
      await reposApi.setupUpdate({ step, skipped, repoKey: this.repo?.key, projectId: this.projectId || undefined });
    } catch {
      /* progress is best-effort */
    }
  }

  private go(step: StepId) {
    this.step = step;
    this.error = "";
    if (step === "github" && !this.gh) void this.checkGh();
    if (step === "branch" && this.repo && !this.defaultBranch) {
      void reposApi.suggest({ repoKey: this.repo.key }).then((s) => (this.defaultBranch = s.defaultBranch ?? "")).catch(() => undefined);
    }
    if ((step === "scan" || step === "done") && !this.report) void this.loadReport();
  }

  private async next(skipped = false) {
    await this.mark(this.step, skipped);
    const i = STEPS.findIndex((s) => s.id === this.step);
    const n = STEPS[Math.min(i + 1, STEPS.length - 1)].id;
    this.go(n);
    if (n === "done") void this.mark("done");
  }

  private async useFolder(path: string) {
    this.busy = true;
    this.error = "";
    try {
      const res = await reposApi.register(path);
      this.repo = res.repo;
      if (this.projectId) {
        const p = this.projects.find((x) => x.id === this.projectId);
        void attachProjectRepo(this.projectId, res.repo.root, { projectName: p?.name }).catch(() => undefined);
      }
      await this.next();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
    }
  }

  private async pick() {
    const res = await openRepoPicker({ mode: "directory", requireRepo: true, title: "Choose your repo folder" });
    if (res?.path) await this.useFolder(res.path);
  }

  private async clone() {
    if (!this.cloneUrl.trim()) return;
    this.busy = true;
    this.error = "";
    try {
      const res = await reposApi.clone(this.cloneUrl.trim());
      showRepoToast(`Cloned into ${res.path}`, "ok");
      await this.useFolder(res.path);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
    }
  }

  private async checkGh() {
    try {
      this.gh = await reposApi.github();
    } catch (e) {
      this.gh = { installed: false, authed: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  private async loadReport() {
    if (!this.repo) return;
    try {
      const res = await reposApi.healthGet({ repoKey: this.repo.key });
      this.report = res.report;
      this.repo = res.repo;
    } catch {
      /* not scanned */
    }
  }

  private async runScan() {
    if (!this.repo) return;
    this.busy = true;
    this.error = "";
    try {
      const res = await reposApi.healthScan({ repoKey: this.repo.key }, { wait: true });
      this.report = res.report ?? null;
      await this.loadReport();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
    }
  }

  private close(openRepo = false) {
    void reposApi.setupUpdate({ dismiss: true }).catch(() => undefined);
    if (openRepo && this.repo) {
      this.dispatchEvent(new CustomEvent("setup-open-repo", { detail: this.repo.key, bubbles: true, composed: true }));
    } else {
      this.dispatchEvent(new CustomEvent("setup-close", { bubbles: true, composed: true }));
    }
  }

  private renderPick() {
    return html`<div class="pane" data-setup-step="pick">
      <div class="lead">
        A <b>repo</b> is a project folder that git tracks. Pick the folder you already have, or paste a GitHub link and
        InfiniBot clones it for you.
      </div>
      <div class="choice">
        <div class="opt">
          <b>${icons.folder} Use a folder on this computer</b>
          <span class="muted">Browse, or pick from recent repos and ~/Desktop/Development.</span>
          <button class="btn primary" data-setup-pick ?disabled=${this.busy} @click=${() => this.pick()}>${icons.folderInput}<span>Choose folder</span></button>
        </div>
        <div class="opt">
          <b>${icons.download} Clone from a URL</b>
          <input type="url" placeholder="https://github.com/you/app.git" .value=${this.cloneUrl}
            @input=${(e: Event) => (this.cloneUrl = (e.target as HTMLInputElement).value)} />
          <button class="btn" ?disabled=${this.busy || !this.cloneUrl.trim()} @click=${() => this.clone()}>${icons.download}<span>${this.busy ? "Cloning…" : "Clone"}</span></button>
        </div>
      </div>
      ${this.projects.length
        ? html`<label class="muted" style="display:grid;gap:6px;max-width:420px">Attach it to a project (optional)
            <select .value=${this.projectId} @change=${(e: Event) => (this.projectId = (e.target as HTMLSelectElement).value)}>
              <option value="">— none —</option>
              ${this.projects.map((p) => html`<option value=${p.id} ?selected=${p.id === this.projectId}>${p.name}</option>`)}
            </select>
          </label>`
        : nothing}
      ${this.repo ? html`<div class="ok">${icons.check} Picked <span class="mono">${this.repo.root}</span></div>` : nothing}
    </div>`;
  }

  private renderBranch() {
    if (!this.repo) return html`<div class="muted">Pick a repo first.</div>`;
    return html`<div class="pane" data-setup-step="branch">
      <div class="lead">
        The <b>deploy branch</b> is the one your live app is built from. InfiniBot looked at your deploy files, CI, recent
        deploys and branch names and suggests one below — tap <b>Use this</b> to confirm, or choose another.
        ${this.defaultBranch ? html`<br /><span class="muted">Default branch on GitHub: <span class="mono">${this.defaultBranch}</span></span>` : nothing}
      </div>
      <ib-repo-deploy-card inPage .repoKey=${this.repo.key} @deploy-changed=${() => void this.next()}></ib-repo-deploy-card>
    </div>`;
  }

  private renderLearn() {
    return html`<div class="pane" data-setup-step="learn">
      <div class="diagram">${DIAGRAM}</div>
      <div class="muted">Each dot is a commit (a saved snapshot). A worktree is a second folder that shows one branch.</div>
      <div class="facts">
        <div class="fact"><b>Branch</b>A named line of work. You make changes on a side branch so the live app keeps working.</div>
        <div class="fact"><b>Merge</b>Bringing a branch's changes into the deploy branch. Once merged, the side branch can go.</div>
        <div class="fact"><b>Worktree</b>An extra folder that shows one branch, so agents can work on several things at once without stepping on each other.</div>
        <div class="fact"><b>Stash</b>Changes put aside without a commit. Easy to forget — InfiniBot lists them so nothing gets lost.</div>
      </div>
      <div class="muted">InfiniBot only ever suggests deleting branches whose work is already in the deploy branch, and keeps a restore file every time.</div>
    </div>`;
  }

  private renderGithub() {
    const g = this.gh;
    return html`<div class="pane" data-setup-step="github">
      <div class="lead">Connecting GitHub lets the health page show which pull requests were merged. It is optional.</div>
      ${!g
        ? html`<div class="muted">Checking…</div>`
        : g.authed
          ? html`<div class="ok big">${icons.checkCircle} Connected${g.account ? html` as <b>${g.account}</b>` : nothing}</div>`
          : html`<div class="fact">
              <b>${g.installed ? "GitHub CLI is installed but not logged in" : "GitHub CLI (gh) is not installed"}</b>
              ${g.installed
                ? html`Open a terminal and run <span class="mono">gh auth login</span>, then press Check again.`
                : html`Install it from <a style="color:#f0dc9a" href="https://cli.github.com" target="_blank" rel="noopener">cli.github.com</a>, run <span class="mono">gh auth login</span>, then press Check again.`}
            </div>`}
      <div><button class="btn" @click=${() => this.checkGh()}>${icons.refresh}<span>Check again</span></button></div>
    </div>`;
  }

  private renderScan() {
    const t = this.report?.totals;
    return html`<div class="pane" data-setup-step="scan">
      <div class="lead">The health scan reads every branch, worktree and stash and sorts them into Safe, Review, Active and Protected. It changes nothing.</div>
      ${t
        ? html`<div class="facts" data-setup-scan-result>
            <div class="fact"><b>${t.safe + t.worktreesSafe} safe to delete</b>${t.safe} branches, ${t.worktreesSafe} worktrees · ${fmtBytes(t.reclaimBytes)}</div>
            <div class="fact"><b>${t.review} to review</b>${t.uniqueWork} hold work not in the deploy branch</div>
            <div class="fact"><b>${t.active} active · ${t.protected} protected</b>${t.stashes} stash${t.stashes === 1 ? "" : "es"}</div>
          </div>`
        : nothing}
      <div><button class="btn primary" data-setup-scan ?disabled=${this.busy || !this.repo} @click=${() => this.runScan()}>${icons.activity}<span>${this.busy ? "Scanning…" : t ? "Scan again" : "Run first scan"}</span></button></div>
    </div>`;
  }

  private renderDone() {
    const d = this.repo?.deploy;
    return html`<div class="pane" data-setup-step="done">
      <div class="big">${icons.rocket} Here's where you deploy from</div>
      ${d
        ? html`<div class="fact" data-setup-deploy-summary>
            <b class="mono">${d.branch}</b>
            <div class="mono">${d.worktreePath}</div>
            ${d.target ? html`<div class="muted">${targetLabel(d.target)}</div>` : nothing}
            ${d.command ? html`<div class="mono muted">${d.command}</div>` : nothing}
          </div>`
        : html`<div class="fact"><b>No deploy branch yet</b>Go back to step 2 whenever you are ready.</div>`}
      <div class="muted">Agents see this too: every coder that works in this repo is told the deploy branch and folder.</div>
    </div>`;
  }

  render() {
    const i = STEPS.findIndex((s) => s.id === this.step);
    const body =
      this.step === "pick"
        ? this.renderPick()
        : this.step === "branch"
          ? this.renderBranch()
          : this.step === "learn"
            ? this.renderLearn()
            : this.step === "github"
              ? this.renderGithub()
              : this.step === "scan"
                ? this.renderScan()
                : this.renderDone();
    return html`<div class="box" data-repo-setup>
      <div class="top">
        <h2>${icons.sparkles} Set up your first repo</h2>
        <span class="grow"></span>
        <button class="btn ghost" data-setup-close @click=${() => this.close()}>${icons.x}<span>Close</span></button>
      </div>
      <div class="steps" role="tablist">
        ${STEPS.map(
          (s, n) => html`<button role="tab" class="s ${s.id === this.step ? "on" : ""} ${this.done.has(s.id) ? "ok" : ""}" data-step=${s.id}
            @click=${() => this.go(s.id)}>
            <span class="n">${this.done.has(s.id) ? icons.check : n + 1}</span>${s.label}
          </button>`,
        )}
      </div>
      ${body}
      ${this.error ? html`<div class="err" style="margin-top:10px">${this.error}</div>` : nothing}
      <div class="nav" style="margin-top:16px">
        ${i > 0 ? html`<button class="btn ghost" @click=${() => this.go(STEPS[i - 1].id)}>${icons.arrowLeft}<span>Back</span></button>` : nothing}
        <span class="grow"></span>
        ${this.step === "done"
          ? html`<button class="btn primary" data-setup-finish @click=${() => this.close(true)}>${icons.activity}<span>Open branch health</span></button>`
          : html`<button class="btn ghost" data-setup-skip @click=${() => this.next(true)}>Skip</button>
              <button class="btn primary" data-setup-next ?disabled=${(this.step === "pick" && !this.repo) || this.busy} @click=${() => this.next()}>
                <span>Next</span>${icons.arrowRight}
              </button>`}
      </div>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-repo-setup": RepoSetupWizard;
  }
}
