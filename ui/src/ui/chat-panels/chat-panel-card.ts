/**
 * <chat-panel-card> — the compact, LIVE inline card a chat transcript renders
 * for a `show_panel` tool result. Same data + renderers as the modal, trimmed
 * (`mode: "card"`), with Expand / Open-full-page / Refresh.
 */
import { css, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";

import { icons } from "../icons";
import { PanelLiveElement } from "./panel-live";
import { hasLink, openPanelLink, timeAgo } from "./panel-nav";
import { kindIcon, renderPanelBody, renderSkeleton } from "./panel-renderers";
import { panelBodyStyles, panelTokens } from "./panel-styles";

/** At most this many inline live meshes (each is a WebGL context). */
const MAX_LIVE_MESH = 2;
const liveMesh = new Set<ChatPanelCard>();

@customElement("chat-panel-card")
export class ChatPanelCard extends PanelLiveElement {
  protected readonly mode = "card" as const;

  static styles = [
    panelTokens,
    panelBodyStyles,
    css`
      :host { display: block; margin: 8px 0; max-width: 640px; contain: content; }
      .card {
        border-radius: 12px; overflow: hidden;
        border: 1px solid var(--edge);
        background: linear-gradient(180deg, color-mix(in srgb, var(--gold) 6%, var(--surface)), var(--surface));
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.03);
      }
      .head {
        display: flex; align-items: center; gap: 10px; padding: 10px 12px;
        border-bottom: 1px solid var(--line);
        background: linear-gradient(180deg, color-mix(in srgb, var(--gold) 9%, transparent), transparent);
      }
      .ic {
        width: 28px; height: 28px; border-radius: 8px; flex: none; display: grid; place-items: center;
        color: var(--gold); border: 1px solid color-mix(in srgb, var(--gold) 35%, transparent);
        background: color-mix(in srgb, var(--gold) 10%, transparent);
      }
      .ic svg { width: 15px; height: 15px; }
      .titles { flex: 1; min-width: 0; }
      .kind { font-size: 9.5px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--gold); font-weight: 700; }
      .title { font-size: 14px; font-weight: 650; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .summary { font-size: 11.5px; color: var(--ink-mute); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .icon-btn {
        width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; cursor: pointer; flex: none;
        border: 1px solid var(--line); background: var(--surface-2); color: var(--ink-mute);
      }
      .icon-btn:hover { color: var(--gold); border-color: var(--gold); }
      .icon-btn svg { width: 14px; height: 14px; }
      .body { padding: 12px; max-height: 420px; overflow: auto; }
      .foot {
        display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--line);
        background: rgba(0, 0, 0, 0.18); font-size: 11px; color: var(--ink-mute);
      }
      .live { display: inline-flex; align-items: center; gap: 6px; }
      .live .dot { color: var(--pos); }
      .foot .sp { flex: 1; }
      .foot .btn { white-space: nowrap; }
      :host { container-type: inline-size; }
      @container (max-width: 400px) {
        .foot .live-txt, .foot .expand-txt { display: none; }
        .body { padding: 10px; }
      }
    `,
  ];

  protected onVisibilityChange(visible: boolean): void {
    super.onVisibilityChange(visible);
    if (this.ref?.kind !== "mesh") return;
    if (visible && (liveMesh.size < MAX_LIVE_MESH || liveMesh.has(this))) {
      liveMesh.add(this);
      this.vizLive = true;
    } else if (!visible) {
      liveMesh.delete(this);
      this.vizLive = false;
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    liveMesh.delete(this);
  }

  render() {
    const ref = this.ref;
    if (!ref) return nothing;
    const r = this.result;
    const err = this.errorText;
    const title = r?.title || ref.title;
    const summary = r?.summary || ref.summary;
    const link = r?.link ?? ref.link;
    const live = Boolean((r?.refreshMs ?? ref.refreshMs) && !err);
    return html`<section class="card" aria-label=${`${title} panel`}>
      <header class="head">
        <span class="ic">${kindIcon(ref.kind, r?.data)}</span>
        <div class="titles">
          <div class="kind">${ref.kind}</div>
          <div class="title" title=${title}>${title}</div>
          ${summary ? html`<div class="summary" title=${summary}>${summary}</div>` : nothing}
        </div>
        <button class="icon-btn" title="Refresh" aria-label="Refresh" @click=${() => void this.load()}>
          ${this.loading ? html`<span class="spin"></span>` : icons.refresh}
        </button>
        <button class="icon-btn" title="Expand" aria-label="Expand to full view" @click=${() => this.expand()}>
          ${icons.maximize}
        </button>
      </header>
      <div class="body">
        ${err
          ? html`<div class="state err">${icons.alertCircle}<span>${err}</span></div>`
          : r
            ? r.empty
              ? html`<div class="state">${r.summary || "Nothing to show."}</div>`
              : renderPanelBody(ref.kind, r.data, this.ctx())
            : renderSkeleton()}
      </div>
      <footer class="foot">
        ${live
          ? html`<span class="live"><span class="dot live"></span>Live<span class="live-txt">${r ? html` · ${timeAgo(r.fetchedAt) || "now"}` : nothing}</span></span>`
          : html`<span>${r ? `Updated ${timeAgo(r.fetchedAt) || "now"}` : "Loading…"}</span>`}
        <span class="sp"></span>
        <button class="btn" title="Expand" @click=${() => this.expand()}>${icons.maximize}<span class="expand-txt">Expand</span></button>
        ${hasLink(link) && link.label
          ? html`<button class="btn primary" @click=${() => openPanelLink(link)}>${link.label} ${icons.chevronRight}</button>`
          : nothing}
      </footer>
    </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "chat-panel-card": ChatPanelCard;
  }
}
