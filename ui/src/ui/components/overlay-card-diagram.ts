/**
 * overlay-card-diagram.ts — Excalidraw scene overlay (read-only preview).
 *
 * payload: { elements?: any[], appState?: object, files?: object, svg?: string, title?: string }
 *
 * Renders a static preview of an Excalidraw scene. If raw `svg` is supplied we
 * paint it directly; otherwise we lazily import `@excalidraw/excalidraw`'s
 * `exportToSvg` (only when elements are present, to keep the diagram heavy-dep
 * off the critical path). Editing happens in the full Whiteboard view — the
 * "Edit" button dispatches `overlay-open-whiteboard`. Server-side push/pull of
 * the live scene is handled by the `excalidraw_*` MCP tools, not this card.
 */

import { html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { OverlayCardBase } from "./overlay-card-base";

@customElement("overlay-card-diagram")
export class OverlayCardDiagram extends OverlayCardBase {
  @state() private svg = "";
  @state() private status: "idle" | "loading" | "empty" | "error" = "idle";

  static styles = [
    OverlayCardBase.baseStyles,
    css`
      .ovc-body {
        padding: 0;
        display: flex;
        flex-direction: column;
        background: #fafaf7;
      }
      .canvas {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        display: grid;
        place-items: center;
        padding: 8px;
      }
      .canvas svg {
        max-width: 100%;
        height: auto;
      }
      .toolbar {
        flex: 0 0 auto;
        display: flex;
        gap: 8px;
        padding: 6px 10px;
        background: var(--g-surface, rgba(255, 255, 255, 0.04));
        border-bottom: 1px solid var(--g-border, rgba(251, 191, 36, 0.14));
      }
      .toolbar button {
        font-size: 10px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 4px 9px;
        border-radius: 6px;
        border: 1px solid var(--g-border, rgba(251, 191, 36, 0.14));
        background: transparent;
        color: var(--g-fg-dim, rgba(245, 245, 244, 0.7));
        cursor: pointer;
      }
      .toolbar button:hover {
        color: var(--g-primary, #fbbf24);
        border-color: var(--g-border-strong, rgba(251, 191, 36, 0.3));
      }
      .state {
        flex: 1 1 auto;
        display: grid;
        place-items: center;
        color: #71717a;
        font-size: 12px;
      }
    `,
  ];

  protected get cardIcon() {
    return "◫";
  }
  protected get cardTitle() {
    return (this.payload.title as string) || "Diagram";
  }

  firstUpdated() {
    super.firstUpdated();
    void this.build();
  }

  private async build() {
    const p = this.payload;
    if (typeof p.svg === "string" && p.svg.trim()) {
      this.svg = p.svg;
      this.status = "idle";
      return;
    }
    const elements = p.elements as unknown[] | undefined;
    if (!elements || !elements.length) {
      this.status = "empty";
      return;
    }
    this.status = "loading";
    try {
      const mod = (await import("@excalidraw/excalidraw")) as {
        exportToSvg: (opts: unknown) => Promise<SVGSVGElement>;
      };
      const svgEl = await mod.exportToSvg({
        elements,
        appState: { ...(p.appState as object), exportBackground: false },
        files: p.files ?? null,
      });
      this.svg = svgEl.outerHTML;
      this.status = "idle";
    } catch {
      this.status = "error";
    }
  }

  private edit() {
    this.dispatchEvent(
      new CustomEvent("overlay-open-whiteboard", {
        detail: { payload: this.payload },
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected renderBody() {
    return html`
      <div class="toolbar"><button @click=${() => this.edit()}>Edit in Whiteboard</button></div>
      ${this.status === "loading"
        ? html`<div class="state">Rendering diagram…</div>`
        : this.status === "empty"
          ? html`<div class="state">Empty scene</div>`
          : this.status === "error"
            ? html`<div class="state">Could not render scene</div>`
            : html`<div class="canvas">${this.svg ? unsafeHTML(this.svg) : nothing}</div>`}
    `;
  }
}
