/**
 * <ib-repo-badge .projectId=${id}> — repo highlight for a project.
 *
 * Connected projects show "⎇ repo · branch · clean|N changed · ↑a ↓b".
 * Without a repo it renders nothing, or an "Attach repo" button when
 * `attachable` is set. Clicking a connected badge opens the shared picker
 * (change / detach). `compact` drops everything but name + dirty dot.
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icons } from "../icons";
import { BRANCH_ICON, openRepoPicker } from "./repo-picker";
import {
  getProjectRepo,
  loadProjectRepos,
  onProjectReposChange,
  prefetchRepoPicker,
  repoDisplayName,
  repoTooltip,
} from "./store";

@customElement("ib-repo-badge")
export class RepoBadge extends LitElement {
  @property({ attribute: false }) projectId: string | null | undefined = null;
  @property({ attribute: false }) projectName = "";
  @property({ type: Boolean }) attachable = false;
  @property({ type: Boolean }) compact = false;
  /** Read-only badges (pickers) never open the picker on click. */
  @property({ type: Boolean }) readonly = false;

  @state() private tick = 0;
  private off: (() => void) | null = null;

  static styles = css`
    :host {
      display: inline-flex;
      vertical-align: middle;
      min-width: 0;
      max-width: 100%;
    }
    button {
      all: unset;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      max-width: 100%;
      min-width: 0;
      padding: 2px 8px 2px 6px;
      border-radius: 12px;
      font-size: 12px;
      line-height: 17px;
      cursor: pointer;
      white-space: nowrap;
      flex-wrap: wrap;
      row-gap: 1px;
      font-family: var(--font-mono, ui-monospace, monospace);
    }
    button[disabled] {
      cursor: default;
    }
    .on {
      color: var(--g-primary, #d4af37);
      background: rgba(212, 175, 55, 0.12);
      border: 1px solid rgba(212, 175, 55, 0.42);
      box-shadow: 0 0 10px rgba(212, 175, 55, 0.14);
    }
    .on:hover {
      background: rgba(212, 175, 55, 0.2);
    }
    .attach {
      color: var(--muted, #9a9a9a);
      border: 1px dashed rgba(255, 255, 255, 0.22);
      font-family: inherit;
    }
    .attach:hover {
      color: var(--g-primary, #d4af37);
      border-color: rgba(212, 175, 55, 0.5);
    }
    .name {
      font-weight: 650;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 2.5em;
      max-width: 100%;
      flex: 0 1 auto;
    }
    .sep {
      opacity: 0.45;
    }
    .branch {
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
      min-width: 3em;
      flex: 0 1 auto;
      opacity: 0.9;
    }
    .branch.is-deploy {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      color: #f3dc8a;
      opacity: 1;
    }
    .branch.is-deploy svg {
      width: 11px;
      height: 11px;
      flex: none;
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex: none;
      background: var(--ok, #5ad19a);
    }
    .dot.dirty {
      background: var(--warning, #f5b041);
    }
    .ab {
      opacity: 0.85;
    }
    .dot.scan {
      background: var(--g-primary, #d4af37);
      animation: ib-repo-pulse 1.1s ease-in-out infinite;
    }
    @keyframes ib-repo-pulse {
      50% {
        opacity: 0.25;
      }
    }
    .deploy {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      margin-left: 2px;
      padding: 1px 4px;
      border-radius: 999px;
      background: rgba(212, 175, 55, 0.2);
      border: 1px solid rgba(212, 175, 55, 0.5);
      color: #f3dc8a;
      font-size: 11px;
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .deploy svg {
      width: 12px;
      height: 12px;
    }
    .deploy.none {
      background: transparent;
      border-style: dashed;
      color: var(--muted, #9a9a9a);
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.off = onProjectReposChange(() => this.tick++);
    void loadProjectRepos();
    if (this.attachable) this.addEventListener("pointerenter", prefetchRepoPicker, { once: true });
  }

  disconnectedCallback(): void {
    this.off?.();
    this.off = null;
    super.disconnectedCallback();
  }

  private open(e: Event) {
    e.stopPropagation();
    e.preventDefault();
    if (this.readonly || !this.projectId) return;
    void openRepoPicker({
      mode: "attach",
      projectId: this.projectId,
      projectName: this.projectName,
    });
  }

  render() {
    void this.tick;
    const repo = getProjectRepo(this.projectId);
    if (!repo) {
      if (!this.attachable || !this.projectId) return nothing;
      return html`<button class="attach" data-repo-attach @click=${this.open} title="Attach a local git repo to this project">
        ${BRANCH_ICON}<span>Attach repo</span>
      </button>`;
    }
    const ab = `${repo.ahead ? `↑${repo.ahead}` : ""}${repo.behind ? ` ↓${repo.behind}` : ""}`.trim();
    const deploy = repo.deploy;
    const tip = [
      repoTooltip(repo),
      deploy ? `deploys from ${deploy.branch} at ${deploy.worktreePath}` : "no deploy branch set",
    ].join("\n");
    return html`<button
      class="on"
      data-repo-badge
      data-scanning=${repo.scanning ? "1" : "0"}
      ?disabled=${this.readonly}
      title=${tip}
      @click=${this.open}
    >
      ${BRANCH_ICON}
      <span class="name">${repoDisplayName(repo)}</span>
      ${this.compact
        ? html`<span class="dot ${repo.scanning ? "scan" : repo.dirty ? "dirty" : ""}"></span>`
        : repo.scanning && !repo.branch
          ? html`<span class="sep">·</span><span class="dot scan"></span><span>scanning…</span>`
          : html`<span class="sep">·</span>
              ${deploy && repo.branch === deploy.branch
                ? html`<span class="branch is-deploy" data-repo-deploy-pill title="Checked out on the deploy branch">${icons.rocket}<span style="overflow:hidden;text-overflow:ellipsis">${repo.branch}</span></span>`
                : html`<span class="branch">${repo.branch ?? "?"}</span>`}
              <span class="dot ${repo.scanning ? "scan" : repo.dirty ? "dirty" : ""}"></span>
              <span>${repo.scanning ? "scanning…" : repo.dirty ? `${repo.dirtyCount}` : "clean"}</span>
              ${ab ? html`<span class="ab">${ab}</span>` : nothing}
              ${deploy && repo.branch !== deploy.branch
                ? html`<span class="deploy" data-repo-deploy-pill title=${`Deploys from ${deploy.branch} (${deploy.worktreePath})`}>${icons.rocket}</span>`
                : nothing}`}
    </button>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-repo-badge": RepoBadge;
  }
}
