/**
 * <chat-panel-modal> — full-size LIVE panel (ported from the OmniTrade
 * <omnitrade-panel-modal>, generalised to the chat panel kind registry).
 * Mounted by <chat-panel-host>; closes on Esc / scrim / ✕ and after a
 * route-hop to the full page.
 */
import { css, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";

import { icons } from "../icons";
import { PanelLiveElement } from "./panel-live";
import { hasLink, openPanelLink, timeAgo } from "./panel-nav";
import { kindIcon, renderPanelBody, renderSkeleton } from "./panel-renderers";
import { panelBodyStyles, panelTokens } from "./panel-styles";

let openPanelModals = 0;

/** True while an expanded panel modal is on screen — other modals (the agent
 *  chat modal) leave Escape / focus-trapping to it instead of closing too. */
export function isChatPanelModalOpen(): boolean {
  return openPanelModals > 0;
}

@customElement("chat-panel-modal")
export class ChatPanelModal extends PanelLiveElement {
  protected readonly mode = "modal" as const;

  static styles = [
    panelTokens,
    panelBodyStyles,
    css`
      /* Expanded from any chat surface — including the universal
         <agent-chat-modal> (100010) — so it must sit above all of them. */
      :host { position: fixed; inset: 0; z-index: 100020; }
      .scrim {
        position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px;
        background: rgba(0, 0, 0, 0.62); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
        animation: fade 0.16s ease;
      }
      @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
      .panel {
        width: min(1080px, 96vw); height: min(780px, 88vh); display: flex; flex-direction: column;
        background: linear-gradient(180deg, color-mix(in srgb, var(--gold) 5%, var(--surface)), var(--surface));
        border: 1px solid var(--edge); border-radius: 14px;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.03);
        overflow: hidden; animation: pop 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      .panel:focus { outline: none; }
      .panel.compact { height: auto; max-height: 88vh; width: min(760px, 96vw); }
      @keyframes pop { from { transform: translateY(10px) scale(0.98); opacity: 0; } to { transform: none; opacity: 1; } }
      .head {
        display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line);
        background: linear-gradient(180deg, color-mix(in srgb, var(--gold) 9%, transparent), transparent);
      }
      .badge {
        display: inline-flex; align-items: center; gap: 6px; flex: none;
        text-transform: uppercase; font-size: 10px; letter-spacing: 0.14em; font-weight: 750;
        color: #0b0b0d; background: var(--gold); padding: 5px 8px; border-radius: 6px;
      }
      .badge svg { width: 12px; height: 12px; }
      .titles { flex: 1; min-width: 0; }
      .title { font-size: 17px; font-weight: 680; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .summary { font-size: 12px; color: var(--ink-mute); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .icon-btn {
        width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; cursor: pointer; flex: none;
        border: 1px solid var(--line); background: var(--surface-2); color: var(--ink);
      }
      .icon-btn:hover { color: var(--gold); border-color: var(--gold); }
      .icon-btn svg { width: 15px; height: 15px; }
      .body { flex: 1; min-height: 0; overflow: auto; padding: 16px; }
      .body.fill { display: flex; flex-direction: column; overflow: hidden; }
      .body.fill > * { flex: 1; min-height: 0; }
      .foot {
        display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--line);
        font-size: 11.5px; color: var(--ink-mute); background: rgba(0, 0, 0, 0.2);
      }
      .foot .sp { flex: 1; }
      .live { display: inline-flex; align-items: center; gap: 6px; }
      .live .dot { color: var(--pos); }
      @media (max-width: 720px) {
        .scrim { padding: 0; align-items: stretch; }
        .panel, .panel.compact { width: 100vw; height: 100%; max-height: none; border-radius: 0; }
        .body > div[style*="grid-template-columns"] { grid-template-columns: 1fr !important; }
      }
    `,
  ];

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.close();
  };

  connectedCallback(): void {
    super.connectedCallback();
    openPanelModals += 1;
    window.addEventListener("keydown", this.onKey);
    // The modal always shows the live mesh (one context, full size).
    this.vizLive = true;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    openPanelModals = Math.max(0, openPanelModals - 1);
    window.removeEventListener("keydown", this.onKey);
  }

  protected firstUpdated(): void {
    (this.renderRoot.querySelector(".panel") as HTMLElement | null)?.focus();
  }

  private close(): void {
    this.dispatchEvent(
      new CustomEvent("panel-close", { detail: { panelId: this.ref?.panelId }, bubbles: true, composed: true }),
    );
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
    const tall = ["mesh", "project", "business", "agents", "clients", "opportunities", "table"].includes(ref.kind);
    return html`<div class="scrim" @click=${(e: Event) => e.target === e.currentTarget && this.close()}>
      <section
        class="panel ${tall ? "" : "compact"}"
        role="dialog"
        aria-modal="true"
        aria-label=${title}
        tabindex="-1"
      >
        <header class="head">
          <span class="badge">${kindIcon(ref.kind, this.result?.data)}${ref.kind}</span>
          <div class="titles">
            <div class="title" title=${title}>${title}</div>
            ${summary ? html`<div class="summary" title=${summary}>${summary}</div>` : nothing}
          </div>
          <button class="icon-btn" title="Refresh" aria-label="Refresh" @click=${() => void this.load()}>
            ${this.loading ? html`<span class="spin"></span>` : icons.refresh}
          </button>
          <button class="icon-btn" title="Close" aria-label="Close" @click=${() => this.close()}>${icons.x}</button>
        </header>
        <div class="body ${ref.kind === "mesh" && !err ? "fill" : ""}">
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
            ? html`<span class="live"><span class="dot live"></span>Live · refreshes every ${Math.round((r?.refreshMs ?? ref.refreshMs) / 1000)}s${r ? html` · updated ${timeAgo(r.fetchedAt)}` : nothing}</span>`
            : html`<span>${r ? `Updated ${timeAgo(r.fetchedAt)}` : "Loading…"}</span>`}
          <span class="sp"></span>
          ${hasLink(link) && link.label
            ? html`<button
                class="btn primary"
                @click=${() => {
                  openPanelLink(link);
                  this.close();
                }}
              >${link.label} ${icons.chevronRight}</button>`
            : nothing}
        </footer>
      </section>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "chat-panel-modal": ChatPanelModal;
  }
}
