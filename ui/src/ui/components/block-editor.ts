/**
 * <moltbot-block-editor>
 *
 * Notion-style free-scrolling block editor with slash commands. Drop-in
 * replacement for <moltbot-markdown-editor>: takes a markdown string via
 * `.value`, emits `change` events with the updated markdown.
 *
 *   <moltbot-block-editor
 *     .value=${row.body ?? ''}
 *     placeholder="Write…"
 *     @change=${(e: CustomEvent<{ value: string }>) => onSave(e.detail.value)}
 *   ></moltbot-block-editor>
 *
 * Internally it mounts the imperative mountBlockEditor (./views/project-
 * content-editor) in "inline" mode and brokers value <-> blocks conversion.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { mountBlockEditor, type BlockEditor } from "../views/project-content-editor.js";
// The markdown ↔ block conversion now lives in a shared module so the
// gateway (agent tools, Notion sync, etc.) can produce blocks that render
// identically to what users see in the database row editor. The Block /
// BlockType / function names are unchanged; we just re-export them so any
// caller importing from this file keeps working.
import {
  type Block,
  type BlockType,
  blocksToMarkdown,
  markdownToBlocks,
} from "../../../../src/content/blocks-markdown.js";
export {
  type Block,
  type BlockType,
  blocksToMarkdown,
  markdownToBlocks,
};

/**
 * When set, the editor self-loads/saves blocks through the gateway
 * (kanban.projects.content.getBlocks / .saveBlocks). The component's `value`
 * prop is ignored in this mode — the gateway is the source of truth.
 */
export interface BlockEditorPersistence {
  client: { request: (method: string, params: any) => Promise<any> };
  projectId: string;
}

@customElement("moltbot-block-editor")
export class MoltbotBlockEditor extends LitElement {
  @property({ type: String }) value = "";
  @property({ type: String }) placeholder = "Type / for commands…";
  /**
   * Optional gateway-backed persistence. Set this for places that already
   * have a project content store (e.g. /projects detail panel). Leave unset
   * for value-bound mode (Databases tab, ad-hoc rich-text fields).
   */
  @property({ attribute: false }) persistence: BlockEditorPersistence | null = null;

  private editor: BlockEditor | null = null;
  private mountEl: HTMLDivElement | null = null;
  /** Last markdown we emitted so external `value` updates only re-seed when
   *  they actually differ from what the user just typed. */
  private lastEmitted = "";
  /** Snapshot of the persistence target that was mounted. If projectId or
   *  client changes we tear down and remount so the new project loads. */
  private mountedPersistenceKey: string | null = null;

  // Render in light DOM so the styles mountBlockEditor injects into
  // document.head reach the editor's nodes.
  protected createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  firstUpdated(): void {
    this.mountEl = this.renderRoot.querySelector(".me-mount") as HTMLDivElement;
    this.mountEditor();
    // When the editor loses focus, apply any pending external value that
    // willUpdate skipped while the user was typing.
    this.addEventListener("focusout", this.handleFocusOut);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener("focusout", this.handleFocusOut);
    this.teardownEditor();
  }

  private handleFocusOut = (e: FocusEvent): void => {
    // Only react when focus is leaving the editor entirely, not just moving
    // between two children (e.g. caret jumping between blocks).
    const next = e.relatedTarget as Node | null;
    if (next && this.contains(next)) return;
    if (!this.editor || this.persistence) return;
    if (this.value === this.lastEmitted) return;
    this.lastEmitted = this.value;
    this.editor.setBlocks(markdownToBlocks(this.value));
  };

  willUpdate(changed: Map<string, unknown>): void {
    // Persistence target changed → remount (the editor needs to reload from
    // a different project). Run after the mount node exists.
    if (this.mountEl && changed.has("persistence")) {
      const nextKey = this.persistence
        ? `${this.persistence.projectId}::has-client`
        : null;
      if (nextKey !== this.mountedPersistenceKey) {
        this.mountEditor();
        return;
      }
    }
    if (!this.editor || this.persistence) return;
    if (!changed.has("value")) return;
    // Don't clobber the editor while the user is typing — only re-seed when
    // the external value differs from what we last emitted.
    if (this.value === this.lastEmitted) return;
    // Defense in depth against out-of-order save responses: if the editor
    // currently has focus, the user is mid-edit. Refuse to re-seed from an
    // external value that disagrees with what we last emitted — accept it
    // when they blur instead. Without this, a stale server response can
    // wipe whatever the user has typed since the last debounced save.
    if (this.contains(document.activeElement)) return;
    this.lastEmitted = this.value;
    this.editor.setBlocks(markdownToBlocks(this.value));
  }

  private teardownEditor(): void {
    if (this.editor) {
      try { this.editor.destroy(); } catch { /* ignore */ }
      this.editor = null;
    }
    this.mountedPersistenceKey = null;
  }

  private mountEditor(): void {
    if (!this.mountEl) return;
    this.teardownEditor();

    if (this.persistence) {
      // Gateway-backed mode: the underlying editor handles load/save itself.
      this.editor = mountBlockEditor(this.mountEl, {
        client: this.persistence.client,
        projectId: this.persistence.projectId,
        placeholder: this.placeholder,
        onNavigate: (rowId) => this.emitNavigate(rowId),
      });
      this.mountedPersistenceKey = `${this.persistence.projectId}::has-client`;
      return;
    }

    // Inline value-bound mode.
    const initialBlocks = markdownToBlocks(this.value);
    this.lastEmitted = this.value;
    this.editor = mountBlockEditor(this.mountEl, {
      placeholder: this.placeholder,
      inline: {
        initialBlocks,
        onChange: (blocks) => this.handleBlocksChanged(blocks),
      },
      onNavigate: (rowId) => this.emitNavigate(rowId),
    });
    this.mountedPersistenceKey = null;
  }

  private emitNavigate(rowId: string): void {
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: { rowId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleBlocksChanged(blocks: Block[]): void {
    const md = blocksToMarkdown(blocks);
    if (md === this.lastEmitted) return;
    this.lastEmitted = md;
    this.value = md;
    this.dispatchEvent(
      new CustomEvent("change", {
        detail: { value: md },
        bubbles: true,
        composed: true,
      }),
    );
    this.dispatchEvent(
      new CustomEvent("input", {
        detail: { value: md },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    return html`<div class="me-mount" part="mount"></div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "moltbot-block-editor": MoltbotBlockEditor;
  }
}
