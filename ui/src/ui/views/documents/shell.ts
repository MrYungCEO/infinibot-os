/**
 * <ib-documents-shell> — the Documents page's two sections:
 *
 *   [ Documents | Ideas ]
 *
 * Documents = <ib-documents-workspace> (unchanged); Ideas = <ib-documents-ideas>.
 * The section is the `notes` host's sub-view (navigation.ts HOST_SUBVIEWS), so
 * the app owns it like any other sub-tab: `/notes?view=ideas` deep-links it,
 * Back/Forward work, and this element only renders `section` and asks to
 * switch with a `section-change` event. Light DOM, so the workspace's
 * `doc-opened` event keeps bubbling to the page exactly as before.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

import { icons } from "../../icons";
import type { RpcClient } from "./api";
import "./ideas";
import "./workspace";
import { SecureModeController } from "../../secure-mode/store";
import "../../secure-mode/secure-toggle";
import "../../secure-mode/secure-docs";

export type DocumentsSection = "documents" | "ideas";

const STYLE = `
ib-documents-shell { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; }
ib-documents-shell > .ds-bar { display: flex; align-items: center; gap: 10px; flex: none; }
ib-documents-shell .ds-seg { display: inline-flex; gap: 4px; padding: 4px; border-radius: 999px;
  border: 1px solid var(--glass-stroke, rgba(217,180,95,.14));
  background: var(--glass-surface-1, rgba(18,16,12,.55)); backdrop-filter: var(--glass-blur, blur(18px)); }
ib-documents-shell .ds-seg button { display: inline-flex; align-items: center; gap: 7px; min-height: 36px; padding: 0 16px;
  border: 0; border-radius: 999px; background: transparent; color: var(--glass-fg-2, #c9c3b6); font: inherit; font-size: 13.5px; cursor: pointer;
  transition: background .18s ease, color .18s ease; }
ib-documents-shell .ds-seg button:hover { color: var(--glass-fg, #f4f1ea); }
ib-documents-shell .ds-seg button[aria-selected="true"] { color: #1a1408; font-weight: 600;
  background: linear-gradient(180deg, var(--glass-gold-hi, #f1d38a), var(--glass-gold, #d9b45f)); }
ib-documents-shell .ds-seg button:focus-visible { outline: none; box-shadow: var(--glass-focus-ring, 0 0 0 2px #d9b45f); }
ib-documents-shell > .ds-bar > ib-secure-toggle { margin-left: auto; }
ib-documents-shell > .ds-body { flex: 1; min-height: 0; }
ib-documents-shell > .ds-body > * { height: 100%; }
`;

@customElement("ib-documents-shell")
export class DocumentsShell extends LitElement {
  @property({ attribute: false }) client: RpcClient | null = null;
  @property({ attribute: false }) pendingSlug: string | null = null;
  /** Which section shows (owned by the app: the `notes` host sub-view). */
  @property({ attribute: false }) section: DocumentsSection = "documents";
  /** Idea to open when the Ideas section shows (set by the library's idea rows). */
  private ideaFocus: string | null = null;
  /** Secure Mode on → the Documents section shows the encrypted secure docs. */
  private secure = new SecureModeController(this);

  protected createRenderRoot() {
    return this;
  }

  protected willUpdate(changed: Map<string, unknown>): void {
    // A /notes/:slug deep link that arrives while Ideas is showing opens the doc.
    if (changed.has("pendingSlug") && this.pendingSlug && this.section !== "documents") this.pick("documents");
  }

  private openIdea = (e: Event): void => {
    const id = (e as CustomEvent<{ id: string }>).detail?.id;
    this.ideaFocus = id || null;
    if (this.section === "ideas") this.requestUpdate();
    else this.pick("ideas");
  };

  private pick(section: DocumentsSection): void {
    if (section === this.section) return;
    this.section = section;
    this.dispatchEvent(new CustomEvent("section-change", { detail: section, bubbles: true, composed: true }));
  }

  private takeIdeaFocus(): string | null {
    const id = this.ideaFocus;
    this.ideaFocus = null;
    return id;
  }

  render() {
    const tab = (id: DocumentsSection, label: string, icon: unknown) =>
      html`<button role="tab" aria-selected=${this.section === id} data-testid=${`documents-section-${id}`} @click=${() => this.pick(id)}>${icon}<span>${label}</span></button>`;
    return html`<style>
        ${STYLE}
      </style>
      <div class="ds-bar">
        <div class="ds-seg" role="tablist" aria-label="Documents sections">${tab("documents", this.secure.active ? "Secure" : "Documents", this.secure.active ? icons.lock : icons.fileText)} ${tab("ideas", "Ideas", icons.lightbulb)}</div>
        <ib-secure-toggle data-secure-surface="documents"></ib-secure-toggle>
      </div>
      <div class="ds-body">
        ${this.section === "documents" && this.secure.active
          ? html`<ib-secure-docs></ib-secure-docs>`
          : this.section === "ideas"
          ? html`<ib-documents-ideas .client=${this.client} .focusId=${this.takeIdeaFocus()}></ib-documents-ideas>`
          : html`<ib-documents-workspace
              class="wg-notes"
              .client=${this.client}
              .pendingSlug=${this.pendingSlug}
              @open-idea=${this.openIdea}
            ></ib-documents-workspace>`}
      </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-documents-shell": DocumentsShell;
  }
}
