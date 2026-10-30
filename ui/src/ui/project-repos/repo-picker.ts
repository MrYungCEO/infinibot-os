/**
 * <ib-repo-picker> — the one shared folder / repo picker.
 *
 *   openRepoPicker({ mode: "attach", projectId, projectName })
 *     → attaches the chosen git repo to the project (or detaches it).
 *   openRepoPicker({ mode: "directory", title?, initialPath? })
 *     → resolves with the chosen folder; nothing is written.
 *
 * Sections: Projects with repos · Recent · Development (worktrees under
 * ~/Desktop/Development) · Browse (folder walk with git detection) plus a
 * typed path that is validated live.
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { awaitGatewayClient } from "../gateway-client";
import {
  attachProjectRepo,
  browseRepoDirs,
  cachedBrowse,
  cachedRepoSuggestions,
  detachProjectRepo,
  getProjectRepo,
  listProjectRepos,
  loadProjectRepos,
  loadRepoSuggestions,
  relTime,
  repoDisplayName,
  repoStatusSummary,
  type BrowseResult,
  type ProjectRepo,
  type RepoInfo,
  type RepoSuggestions,
} from "./store";

export type RepoPickerMode = "attach" | "directory";

export interface RepoPickerOptions {
  mode: RepoPickerMode;
  projectId?: string;
  projectName?: string;
  title?: string;
  initialPath?: string;
  /** directory mode: require the folder to be a git repo. */
  requireRepo?: boolean;
}

export interface RepoPickerResult {
  path: string;
  projectId?: string;
  repo?: RepoInfo;
  detached?: boolean;
}

type Tab = "projects" | "recent" | "development" | "browse";

export const BRANCH_ICON = html`<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="7" r="2.2"/><path d="M6 7.2v9.6"/><path d="M18 9.2c0 5-6 4-12 7.6"/></svg>`;

@customElement("ib-repo-picker")
export class RepoPicker extends LitElement {
  @property({ attribute: false }) options: RepoPickerOptions = { mode: "directory" };
  @property({ attribute: false }) onDone: (r: RepoPickerResult | null) => void = () => {};

  @state() private tab: Tab = "projects";
  @state() private projects: ProjectRepo[] = [];
  @state() private suggestions: RepoSuggestions | null = null;
  @state() private browse: BrowseResult | null = null;
  @state() private browseLoading = false;
  @state() private typed = "";
  @state() private selected: RepoInfo | null = null;
  @state() private selectedProjectId: string | undefined;
  @state() private validating = false;
  @state() private error = "";
  @state() private busy = false;
  @state() private query = "";

  private validateTimer: ReturnType<typeof setTimeout> | null = null;

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 10050;
      display: grid;
      place-items: center;
      background: rgba(4, 4, 8, 0.62);
      backdrop-filter: blur(6px);
      font-family: inherit;
      color: var(--text, #eee);
    }
    .dlg {
      width: min(860px, calc(100vw - 24px));
      height: min(620px, calc(100vh - 24px));
      display: grid;
      grid-template-rows: auto 1fr auto;
      background: #121218;
      background-image: linear-gradient(180deg, rgba(212, 175, 55, 0.05), transparent 120px);
      border: 1px solid var(--g-border, rgba(212, 175, 55, 0.28));
      border-radius: 16px;
      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
      overflow: hidden;
    }
    header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    }
    header h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 650;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    header .sub {
      color: var(--muted, #999);
      font-weight: 400;
    }
    .x {
      background: none;
      border: 0;
      color: var(--muted, #999);
      font-size: 20px;
      cursor: pointer;
      line-height: 1;
    }
    .body {
      display: grid;
      grid-template-columns: 190px 1fr;
      min-height: 0;
    }
    nav {
      border-right: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    nav button {
      text-align: left;
      background: none;
      border: 1px solid transparent;
      color: var(--text, #ddd);
      padding: 8px 10px;
      border-radius: 9px;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      display: flex;
      justify-content: space-between;
      gap: 6px;
    }
    nav button:hover {
      background: rgba(255, 255, 255, 0.04);
    }
    nav button.on {
      background: rgba(212, 175, 55, 0.12);
      border-color: rgba(212, 175, 55, 0.35);
      color: var(--g-primary, #d4af37);
    }
    nav .count {
      color: var(--muted, #888);
      font-size: 11px;
    }
    .list {
      overflow: auto;
      padding: 10px 12px;
      min-height: 0;
    }
    .search {
      width: 100%;
      box-sizing: border-box;
      margin-bottom: 8px;
    }
    input[type="text"] {
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
      color: var(--text, #eee);
      border-radius: 8px;
      padding: 8px 10px;
      font: inherit;
      font-size: 13px;
    }
    .row {
      display: grid;
      grid-template-columns: 28px 1fr auto;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border-radius: 10px;
      border: 1px solid transparent;
      cursor: pointer;
    }
    .row:hover {
      background: rgba(255, 255, 255, 0.04);
    }
    .row.sel {
      background: rgba(212, 175, 55, 0.1);
      border-color: rgba(212, 175, 55, 0.4);
    }
    .ico {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      background: rgba(255, 255, 255, 0.05);
      color: var(--muted, #aaa);
      font-size: 13px;
    }
    .ico.git {
      background: rgba(212, 175, 55, 0.14);
      color: var(--g-primary, #d4af37);
    }
    .name {
      font-size: 13px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .meta {
      font-size: 11.5px;
      color: var(--muted, #999);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mono {
      font-family: var(--font-mono, ui-monospace, monospace);
    }
    .tag {
      font-size: 10.5px;
      padding: 2px 7px;
      border-radius: 999px;
      border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
      color: var(--muted, #aaa);
      white-space: nowrap;
    }
    .tag.dirty {
      color: var(--warning, #f5b041);
      border-color: rgba(245, 176, 65, 0.4);
    }
    .tag.clean {
      color: var(--ok, #5ad19a);
      border-color: rgba(90, 209, 154, 0.35);
    }
    .crumbs {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      margin-bottom: 8px;
    }
    .crumbs button,
    .chip {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
      color: var(--text, #ddd);
      border-radius: 999px;
      padding: 4px 10px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .empty {
      color: var(--muted, #999);
      font-size: 13px;
      padding: 24px 8px;
      text-align: center;
    }
    footer {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      align-items: center;
      padding: 12px 18px;
      border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    }
    .pathrow {
      display: flex;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }
    .pathrow input {
      flex: 1;
      min-width: 0;
    }
    .status {
      font-size: 11.5px;
      color: var(--muted, #999);
      margin-top: 4px;
      min-height: 15px;
    }
    .status.err {
      color: var(--danger, #ff6b6b);
    }
    .btns {
      display: flex;
      gap: 8px;
    }
    .btn {
      border-radius: 9px;
      padding: 8px 14px;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
      border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
      background: rgba(255, 255, 255, 0.05);
      color: var(--text, #eee);
    }
    .btn.primary {
      background: linear-gradient(180deg, #e6c55a, #c9a227);
      border-color: #c9a227;
      color: #18140a;
      font-weight: 650;
    }
    .btn.danger {
      color: var(--danger, #ff6b6b);
      border-color: rgba(255, 107, 107, 0.35);
    }
    .btn[disabled] {
      opacity: 0.45;
      cursor: not-allowed;
    }
    @media (max-width: 640px) {
      .body {
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr;
      }
      nav {
        flex-direction: row;
        overflow-x: auto;
        border-right: 0;
        border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      }
      nav button {
        white-space: nowrap;
      }
      footer {
        grid-template-columns: 1fr;
      }
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.typed = this.options.initialPath ?? "";
    window.addEventListener("keydown", this.onKey);
    void this.init();
  }

  disconnectedCallback(): void {
    window.removeEventListener("keydown", this.onKey);
    super.disconnectedCallback();
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.finish(null);
  };

  private async init() {
    // Render from whatever is cached right away; refresh in the background.
    this.projects = listProjectRepos();
    const cached = cachedRepoSuggestions();
    if (cached) this.suggestions = cached;
    const applyOwn = () => {
      const own = this.options.projectId ? getProjectRepo(this.options.projectId) : null;
      if (own && !this.selected) this.select(own);
    };
    applyOwn();
    if (!this.selected && this.typed) void this.validate(this.typed);
    if (this.options.mode === "attach" || this.projects.length === 0) this.tab = "recent";
    if (this.tab === "recent" && cached && !cached.recent.length) this.tab = "development";
    void loadProjectRepos().then(() => {
      this.projects = listProjectRepos();
      applyOwn();
    });
    try {
      this.suggestions = await loadRepoSuggestions();
      if (this.tab === "recent" && !this.suggestions.recent.length) this.tab = "development";
    } catch (e) {
      if (!this.suggestions) this.error = e instanceof Error ? e.message : String(e);
    }
  }

  private finish(r: RepoPickerResult | null) {
    this.onDone(r);
    this.remove();
  }

  private select(r: RepoInfo, projectId?: string) {
    this.selected = r;
    this.selectedProjectId = projectId;
    this.typed = r.root ?? r.path;
    this.error = "";
  }

  private async validate(p: string) {
    if (!p.trim()) {
      this.selected = null;
      return;
    }
    this.validating = true;
    try {
      const client = await awaitGatewayClient();
      const info = await client.request<RepoInfo>("projects.repo.inspect", { path: p.trim() });
      if (this.typed.trim() !== p.trim()) return;
      this.selected = info;
      this.selectedProjectId = undefined;
      this.error = info.isRepo || (this.options.mode === "directory" && !this.options.requireRepo && !info.error?.includes("exist"))
        ? ""
        : info.error ?? "Not a git repository";
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.validating = false;
    }
  }

  private onTyped(v: string) {
    this.typed = v;
    if (this.validateTimer) clearTimeout(this.validateTimer);
    this.validateTimer = setTimeout(() => void this.validate(v), 350);
  }

  private async openBrowse(path?: string) {
    this.tab = "browse";
    const cached = cachedBrowse(path ?? this.browse?.path ?? this.suggestions?.root);
    if (cached) this.browse = cached;
    this.browseLoading = !cached;
    try {
      this.browse = await browseRepoDirs(path ?? this.browse?.path ?? this.suggestions?.root);
      this.error = "";
      if (this.browse.repo) this.select(this.browse.repo);
      else if (this.options.mode === "directory") {
        this.typed = this.browse.path;
        this.selected = { path: this.browse.path, root: null, isRepo: false, name: this.browse.path.split("/").pop() || "/", checkedAt: Date.now() };
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.browseLoading = false;
    }
  }

  private get canConfirm(): boolean {
    if (this.busy || this.validating || !this.typed.trim()) return false;
    if (this.options.mode === "attach" || this.options.requireRepo) return Boolean(this.selected?.isRepo);
    return !this.error;
  }

  private async confirm() {
    const path = this.selected?.root ?? this.typed.trim();
    if (!path) return;
    if (this.options.mode === "attach" && this.options.projectId) {
      // Instant: the badge flips optimistically and the picker closes; the
      // save runs in the background and rolls back with a toast on failure.
      const pending = attachProjectRepo(this.options.projectId, path, {
        projectName: this.options.projectName,
        preview: this.selected,
      });
      pending.catch(() => undefined);
      this.finish({ path, projectId: this.options.projectId, repo: this.selected ?? undefined });
      return;
    }
    this.finish({ path, projectId: this.selectedProjectId, repo: this.selected ?? undefined });
  }

  private detach() {
    if (!this.options.projectId) return;
    detachProjectRepo(this.options.projectId).catch(() => undefined);
    this.finish({ path: "", projectId: this.options.projectId, detached: true });
  }

  private matchesQuery(...vals: Array<string | undefined>): boolean {
    const q = this.query.trim().toLowerCase();
    if (!q) return true;
    return vals.some((v) => v?.toLowerCase().includes(q));
  }

  private renderRepoRow(r: RepoInfo, opts: { projectId?: string; label?: string } = {}) {
    const path = r.root ?? r.path;
    const sel = (this.selected?.root ?? this.selected?.path) === path && (opts.projectId ?? undefined) === this.selectedProjectId;
    return html`<div
      class="row ${sel ? "sel" : ""}"
      data-repo-path=${path}
      @click=${() => this.select(r, opts.projectId)}
      @dblclick=${() => {
        this.select(r, opts.projectId);
        if (this.canConfirm) void this.confirm();
      }}
    >
      <div class="ico git">${BRANCH_ICON}</div>
      <div style="min-width:0">
        <div class="name">${opts.label ? html`${opts.label} <span class="meta">· ${repoDisplayName(r)}</span>` : repoDisplayName(r)}</div>
        <div class="meta mono" title=${path}>${path}</div>
        <div class="meta">
          ${r.remoteSlug ?? (r.remote ? r.remote : "no remote")}
          ${r.lastCommit ? html` · ${r.lastCommit.subject} · ${relTime(r.lastCommit.at)}` : nothing}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
        <span class="tag mono">${r.branch ?? "?"}</span>
        <span class="tag ${r.dirty ? "dirty" : "clean"}">${r.dirty ? `${r.dirtyCount} changed` : "clean"}${r.ahead ? ` ↑${r.ahead}` : ""}${r.behind ? ` ↓${r.behind}` : ""}</span>
      </div>
    </div>`;
  }

  private renderProjects() {
    const rows = this.projects.filter((p) => this.matchesQuery(p.projectName, p.name, p.root ?? p.path));
    if (!this.projects.length) {
      return html`<div class="empty">No projects have a repo yet. Attach one from a project card or the Kanban header.</div>`;
    }
    return rows.map((p) => this.renderRepoRow(p, { projectId: p.projectId, label: p.projectName }));
  }

  private renderList(list: RepoInfo[] | undefined, empty: string) {
    const rows = (list ?? []).filter((r) => this.matchesQuery(r.name, r.root ?? r.path, r.remoteSlug, r.branch));
    if (!this.suggestions) return html`<div class="empty">Loading…</div>`;
    if (!rows.length) return html`<div class="empty">${empty}</div>`;
    return rows.map((r) => this.renderRepoRow(r));
  }

  private renderBrowse() {
    const b = this.browse;
    if (this.browseLoading && !b) return html`<div class="empty">Loading…</div>`;
    if (!b) return html`<div class="empty">Pick a starting folder.</div>`;
    const parts = b.path.split("/").filter(Boolean);
    return html`
      <div class="crumbs">
        ${b.roots.map((r) => html`<button class="chip" @click=${() => this.openBrowse(r.path)}>${r.label}</button>`)}
      </div>
      <div class="crumbs mono">
        ${b.parent ? html`<button @click=${() => this.openBrowse(b.parent!)} title="Up">↑ ..</button>` : nothing}
        ${parts.slice(-4).map((seg, i, arr) => {
          const full = "/" + parts.slice(0, parts.length - arr.length + i + 1).join("/");
          return html`<button @click=${() => this.openBrowse(full)}>${seg}</button>`;
        })}
      </div>
      ${b.entries
        .filter((e) => this.matchesQuery(e.name))
        .map((e) =>
          e.isRepo && e.repo
            ? html`<div @dblclick=${(ev: Event) => { ev.stopPropagation(); void this.openBrowse(e.path); }}>${this.renderRepoRow(e.repo)}</div>`
            : html`<div class="row" @click=${() => this.openBrowse(e.path)}>
                <div class="ico">📁</div>
                <div class="name">${e.name}</div>
                <span class="meta">${e.isRepo ? "git" : ""}</span>
              </div>`,
        )}
      ${b.entries.length === 0 ? html`<div class="empty">No sub-folders.</div>` : nothing}
      ${b.truncated ? html`<div class="meta">Showing the first ${b.entries.length} folders.</div>` : nothing}
    `;
  }

  render() {
    const o = this.options;
    const own = o.projectId ? getProjectRepo(o.projectId) : null;
    const title =
      o.mode === "attach"
        ? html`${own ? "Change" : "Attach"} local repo <span class="sub">· ${o.projectName ?? "project"}</span>`
        : html`${o.title ?? "Choose a folder"}`;
    const tabs: Array<[Tab, string, number | null]> = [
      ["projects", "Projects with repos", this.projects.length],
      ["recent", "Recent", this.suggestions?.recent.length ?? null],
      ["development", "Development", this.suggestions?.development.length ?? null],
      ["browse", "Browse…", null],
    ];
    const status = this.validating
      ? "Checking…"
      : this.error
        ? this.error
        : this.selected?.isRepo
          ? `${repoDisplayName(this.selected)} · ${repoStatusSummary(this.selected)}`
          : this.selected && o.mode === "directory"
            ? "Folder (not a git repo)"
            : "";
    return html`<div class="dlg" role="dialog" aria-modal="true" @click=${(e: Event) => e.stopPropagation()}>
      <header>
        <h2>${title}</h2>
        <button class="x" aria-label="Close" @click=${() => this.finish(null)}>×</button>
      </header>
      <div class="body">
        <nav>
          ${tabs.map(
            ([id, label, n]) => html`<button
              class=${this.tab === id ? "on" : ""}
              data-tab=${id}
              @click=${() => (id === "browse" ? this.openBrowse() : (this.tab = id))}
            >
              <span>${label}</span>${n !== null ? html`<span class="count">${n}</span>` : nothing}
            </button>`,
          )}
        </nav>
        <div class="list">
          <input
            class="search"
            type="text"
            placeholder="Filter…"
            .value=${this.query}
            @input=${(e: Event) => (this.query = (e.target as HTMLInputElement).value)}
          />
          ${this.tab === "projects"
            ? this.renderProjects()
            : this.tab === "recent"
              ? this.renderList(this.suggestions?.recent, "No recent repos yet.")
              : this.tab === "development"
                ? this.renderList(this.suggestions?.development, `No git checkouts under ${this.suggestions?.root ?? "~/Desktop/Development"}.`)
                : this.renderBrowse()}
        </div>
      </div>
      <footer>
        <div style="min-width:0">
          <div class="pathrow">
            <input
              type="text"
              class="mono"
              placeholder="/absolute/path/to/repo"
              .value=${this.typed}
              @input=${(e: Event) => this.onTyped((e.target as HTMLInputElement).value)}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter" && this.canConfirm) void this.confirm();
              }}
            />
          </div>
          <div class="status ${this.error ? "err" : ""}">${status}</div>
        </div>
        <div class="btns">
          ${o.mode === "attach" && own
            ? html`<button class="btn danger" ?disabled=${this.busy} @click=${() => this.detach()}>Detach</button>
                <button class="btn" data-open-deploy title="Deploy branch and branch health for this repo" @click=${() => {
                  const key = own.repoKey;
                  this.finish(null);
                  void import("./deploy-card").then((m) => m.openReposPage(key));
                }}>Deploy & health</button>`
            : nothing}
          <button class="btn" @click=${() => this.finish(null)}>Cancel</button>
          <button class="btn primary" data-confirm ?disabled=${!this.canConfirm} @click=${() => this.confirm()}>
            ${o.mode === "attach" ? (this.busy ? "Attaching…" : own ? "Change repo" : "Attach repo") : "Use folder"}
          </button>
        </div>
      </footer>
    </div>`;
  }
}

/** Open the shared picker. Resolves null when cancelled. */
export function openRepoPicker(options: RepoPickerOptions): Promise<RepoPickerResult | null> {
  return new Promise((resolve) => {
    document.querySelector("ib-repo-picker")?.remove();
    const el = document.createElement("ib-repo-picker") as RepoPicker;
    el.options = options;
    el.onDone = resolve;
    // Backdrop click cancels (clicks inside the dialog stop propagating).
    el.addEventListener("click", () => {
      el.onDone(null);
      el.remove();
    });
    document.body.appendChild(el);
  });
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-repo-picker": RepoPicker;
  }
}
