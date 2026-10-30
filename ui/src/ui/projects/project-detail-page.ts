/**
 * <project-detail-page> — shared dedicated project-detail surface, rendered by
 * the router for deep-link routes:
 *   /projects/:slug   and   /agency-operations/projects/:slug
 *
 * This is a LIGHTWEIGHT PLACEHOLDER. A parallel workstream owns the real
 * component body and drops it in without touching the router. Until then this
 * simply reads the `:slug` (and resolved id, when the router can recover it)
 * and shows a loading state so the route resolves cleanly.
 *
 * Contract for the real component: keep the `project-detail-page` tag name and
 * the public `slug` / `projectId` reflected attributes so the router wiring in
 * app-render.ts / app-settings.ts continues to work unchanged.
 */

import { LitElement, css, html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("project-detail-page")
export class ProjectDetailPage extends LitElement {
  /** Raw slug from the URL (may embed the id as name--id). */
  @property({ type: String, reflect: true }) slug = "";

  /** Resolved entity id, when the router could recover it from the slug/store. */
  @property({ type: String, reflect: true, attribute: "project-id" })
  projectId = "";

  static styles = css`
    :host {
      display: block;
      height: 100%;
      color: var(--text, #e8ecf1);
    }
    .detail-loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      height: 100%;
      min-height: 240px;
      padding: 48px 24px;
      text-align: center;
    }
    .spinner {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      border: 2px solid rgba(212, 175, 55, 0.25);
      border-top-color: var(--gold, #d4af37);
      animation: spin 0.9s linear infinite;
    }
    .label {
      font-size: 14px;
      opacity: 0.7;
      letter-spacing: 0.02em;
    }
    .slug {
      font-family: var(--mono, ui-monospace, monospace);
      font-size: 12px;
      opacity: 0.5;
      word-break: break-all;
      max-width: 480px;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
  `;

  render(): TemplateResult {
    const label = this.slug || this.projectId || "project";
    return html`
      <div class="detail-loading" role="status" aria-live="polite">
        <div class="spinner"></div>
        <div class="label">loading ${label}…</div>
        ${this.projectId
          ? html`<div class="slug">id: ${this.projectId}</div>`
          : this.slug
            ? html`<div class="slug">${this.slug}</div>`
            : null}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "project-detail-page": ProjectDetailPage;
  }
}
