/**
 * overlay-card-note.ts — note overlay bound to a notes row.
 *
 * payload: { id?: string; name?: string; body?: string }
 *   • id   — notes row id; hydrated via `notes.get` and autosaved via `notes.update`
 *   • body — optional inline body for a not-yet-persisted/demo note
 *
 * Reuses <moltbot-markdown-editor>; debounced autosave on `change`.
 */

import { html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { OverlayCardBase } from "./overlay-card-base";
import "./markdown-editor";

type NoteFull = { id: string; name?: string; body?: string };

@customElement("overlay-card-note")
export class OverlayCardNote extends OverlayCardBase {
  @state() private body = "";
  @state() private name = "";
  @state() private loading = false;
  @state() private savedAt: number | null = null;
  private saveTimer: number | null = null;

  static styles = [
    OverlayCardBase.baseStyles,
    css`
      .ovc-body {
        padding: 0;
        display: flex;
        flex-direction: column;
      }
      moltbot-markdown-editor {
        flex: 1 1 auto;
        min-height: 0;
      }
      .savechip {
        font-size: 9px;
        letter-spacing: 0.06em;
        color: var(--g-fg-faint, rgba(245, 245, 244, 0.4));
        padding: 4px 10px;
        text-align: right;
      }
      .loading {
        padding: 16px;
        color: var(--g-fg-dim, rgba(245, 245, 244, 0.6));
        font-size: 12px;
      }
    `,
  ];

  protected get cardIcon() {
    return "✎";
  }
  protected get cardTitle() {
    return this.name || (this.payload.name as string) || "Note";
  }
  protected headerMeta() {
    return this.savedAt ? "saved" : nothing;
  }

  firstUpdated() {
    super.firstUpdated();
    void this.hydrate();
  }

  private async hydrate() {
    const p = this.payload;
    if (typeof p.body === "string") this.body = p.body;
    if (typeof p.name === "string") this.name = p.name;
    const id = p.id as string | undefined;
    if (!id || !this.gateway) return;
    this.loading = true;
    try {
      const note = (await this.gateway.request("notes.get", { id })) as NoteFull | null;
      if (note) {
        this.name = note.name ?? this.name;
        this.body = note.body ?? this.body;
      }
    } catch {
      /* note RPC unavailable / id missing — keep inline payload */
    } finally {
      this.loading = false;
    }
  }

  private onChange(e: CustomEvent<{ value: string }>) {
    this.body = e.detail?.value ?? "";
    const id = this.payload.id as string | undefined;
    if (!id || !this.gateway) return;
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(id), 700);
  }

  private async save(id: string) {
    try {
      await this.gateway?.request("notes.update", { id, body: this.body });
      this.savedAt = Date.now();
    } catch {
      /* swallow — autosave is best-effort */
    }
  }

  protected renderBody() {
    if (this.loading) return html`<div class="loading">Loading note…</div>`;
    return html`
      <moltbot-markdown-editor
        .value=${this.body}
        placeholder="Write…"
        @change=${(e: CustomEvent<{ value: string }>) => this.onChange(e)}
      ></moltbot-markdown-editor>
    `;
  }
}
