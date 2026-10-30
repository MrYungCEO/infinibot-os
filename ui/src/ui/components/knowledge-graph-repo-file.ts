/**
 * <ib-repo-file-view> — file preview for the Knowledge Graph "Repos" mode.
 *
 * Loads the file through projects.repo.file (repo-confined, secure paths
 * refused) and, when the OCR/file-context pipeline knows the file, its
 * summary via files.context.get. `full` renders as a large overlay.
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { awaitGatewayClient } from "../gateway-client";
import { relTime } from "../project-repos/store";

interface RepoFileRead {
  root: string;
  path: string;
  absPath: string;
  size: number;
  lang: string;
  binary: boolean;
  truncated: boolean;
  content?: string;
  lastCommit?: { sha: string; subject: string; at: number; author?: string };
}

interface FileContext {
  found: boolean;
  entry?: { status?: string; summary?: string; title?: string; kind?: string };
  sidecar?: { summary?: string; text?: string; title?: string } & Record<string, unknown>;
}

const PREVIEW_LINES = 60;

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

@customElement("ib-repo-file-view")
export class RepoFileView extends LitElement {
  @property() projectId = "";
  @property() root = "";
  @property() path = "";
  @property({ type: Boolean }) full = false;

  @state() private file: RepoFileRead | null = null;
  @state() private ctx: FileContext | null = null;
  @state() private error = "";
  @state() private loading = false;

  static styles = css`
    :host {
      display: block;
      font-size: 12px;
      color: var(--text, #e5e5e5);
    }
    :host([full]) {
      position: fixed;
      inset: 4vh 4vw;
      z-index: 10040;
      background: #101016;
      border: 1px solid rgba(212, 175, 55, 0.35);
      border-radius: 14px;
      box-shadow: 0 30px 90px rgba(0, 0, 0, 0.6);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .head {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 6px 0;
    }
    :host([full]) .head {
      padding: 12px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .path {
      font-family: var(--font-mono, ui-monospace, monospace);
      color: var(--muted, #aaa);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }
    .meta {
      color: var(--muted, #999);
      font-size: 11px;
      margin: 2px 0 6px;
    }
    :host([full]) .meta,
    :host([full]) .ctx {
      margin: 8px 16px 0;
    }
    pre {
      margin: 0;
      padding: 8px 0;
      max-height: 260px;
      overflow: auto;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 8px;
      font: 11px/1.45 var(--font-mono, ui-monospace, monospace);
      counter-reset: ln;
    }
    :host([full]) pre {
      max-height: none;
      flex: 1;
      margin: 10px 16px 16px;
      font-size: 12px;
    }
    .ln {
      display: block;
      padding: 0 10px 0 0;
      white-space: pre;
    }
    .ln::before {
      counter-increment: ln;
      content: counter(ln);
      display: inline-block;
      width: 3.4em;
      margin-right: 10px;
      text-align: right;
      color: rgba(255, 255, 255, 0.25);
    }
    .ctx {
      border: 1px solid rgba(212, 175, 55, 0.25);
      background: rgba(212, 175, 55, 0.06);
      border-radius: 8px;
      padding: 6px 8px;
      margin-bottom: 6px;
    }
    .ctx b {
      color: var(--g-primary, #d4af37);
    }
    button {
      border-radius: 7px;
      padding: 4px 9px;
      font: inherit;
      font-size: 11.5px;
      cursor: pointer;
      border: 1px solid rgba(212, 175, 55, 0.4);
      background: rgba(212, 175, 55, 0.1);
      color: var(--g-primary, #d4af37);
      white-space: nowrap;
    }
    .err {
      color: var(--danger, #ff6b6b);
    }
  `;

  updated(changed: Map<string, unknown>): void {
    if (changed.has("path") || changed.has("root") || changed.has("projectId")) void this.load();
  }

  private async load() {
    if (!this.path || (!this.root && !this.projectId)) return;
    const want = `${this.root}|${this.path}`;
    this.loading = true;
    this.error = "";
    try {
      const client = await awaitGatewayClient();
      const file = await client.request<RepoFileRead>("projects.repo.file", {
        ...(this.root ? { root: this.root } : { projectId: this.projectId }),
        path: this.path,
      });
      if (want !== `${this.root}|${this.path}`) return;
      this.file = file;
      try {
        this.ctx = await client.request<FileContext>("files.context.get", { path: file.absPath });
      } catch {
        this.ctx = null;
      }
    } catch (e) {
      this.file = null;
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  private openFull() {
    const el = document.createElement("ib-repo-file-view") as RepoFileView;
    el.root = this.root;
    el.projectId = this.projectId;
    el.path = this.path;
    el.full = true;
    el.setAttribute("full", "");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const close = () => {
      el.remove();
      window.removeEventListener("keydown", onKey);
    };
    el.addEventListener("repo-file-close", close);
    window.addEventListener("keydown", onKey);
    document.body.appendChild(el);
  }

  private renderContext() {
    const c = this.ctx;
    if (!c?.found) return nothing;
    const summary = c.sidecar?.summary ?? c.entry?.summary ?? "";
    const text = typeof c.sidecar?.text === "string" ? c.sidecar.text : "";
    return html`<div class="ctx">
      <b>File context</b>${c.entry?.status ? html` · ${c.entry.status}` : nothing}
      ${summary ? html`<div>${summary}</div>` : nothing}
      ${!summary && text ? html`<div>${text.slice(0, 400)}${text.length > 400 ? "…" : ""}</div>` : nothing}
    </div>`;
  }

  render() {
    const f = this.file;
    const lines = f?.content?.split("\n") ?? [];
    const shown = this.full ? lines : lines.slice(0, PREVIEW_LINES);
    return html`
      <div class="head">
        <span class="path" title=${f?.absPath ?? this.path}>${this.path}</span>
        ${this.full
          ? html`<button @click=${() => this.dispatchEvent(new CustomEvent("repo-file-close"))}>Close</button>`
          : html`<button data-repo-file-open @click=${() => this.openFull()}>Open file</button>`}
      </div>
      ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
      ${this.loading && !f ? html`<div class="meta">Loading…</div>` : nothing}
      ${f
        ? html`<div class="meta">
              ${f.lang} · ${fmtSize(f.size)}${f.lastCommit
                ? html` · ${f.lastCommit.subject} (${relTime(f.lastCommit.at)})`
                : nothing}
            </div>
            ${this.renderContext()}
            ${f.binary
              ? html`<div class="meta">Binary file — no text preview.</div>`
              : html`<pre class="code">${shown.map((l) => html`<span class="ln">${l}</span>`)}</pre>
                  ${!this.full && lines.length > PREVIEW_LINES
                    ? html`<div class="meta">${lines.length - PREVIEW_LINES} more lines — Open file for all.</div>`
                    : nothing}
                  ${f.truncated ? html`<div class="meta">Showing the first 512 KB.</div>` : nothing}`}`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-repo-file-view": RepoFileView;
  }
}
