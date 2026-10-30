/**
 * <import-upload> — "Import" button + drag-and-drop for skills and workflows.
 *
 *   html`<import-upload
 *     .client=${client}
 *     method="skills.import"          // or "workflows.import"
 *     noun="skill"                    // shown in messages
 *     accept=".md,.zip"
 *     @imported=${() => reload()}
 *   ></import-upload>`
 *
 * Sends the file base64-encoded. The gateway answers with either
 * { status: "imported" }, { status: "conflict" } (we then offer
 * Replace / Keep both / Cancel and re-send), or a plain-English error that we
 * show verbatim. Dropping files anywhere on the page while this is mounted
 * also imports them.
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway";

type Outcome =
  | { kind: "imported"; text: string }
  | { kind: "conflict"; text: string }
  | { kind: "error"; text: string };

const MAX_CLIENT_BYTES = 25 * 1024 * 1024;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Exported for tests: run one import round-trip and describe the result. */
export async function runImport(
  client: Pick<GatewayBrowserClient, "request">,
  method: string,
  noun: string,
  file: File,
  onConflict: "ask" | "replace" | "keep-both",
): Promise<Outcome> {
  if (file.size === 0) return { kind: "error", text: `"${file.name}" is empty.` };
  if (file.size > MAX_CLIENT_BYTES) {
    return {
      kind: "error",
      text: `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB; the upload limit is 25 MB.`,
    };
  }
  try {
    const dataBase64 = toBase64(await file.arrayBuffer());
    const res = (await client.request(method, {
      fileName: file.name,
      dataBase64,
      onConflict,
    })) as {
      status?: string;
      message?: string;
      skills?: Array<{ name: string; slug: string; renamedFrom?: string; replaced?: boolean }>;
      workflow?: { name: string };
      replaced?: boolean;
      warnings?: string[];
    };
    if (res?.status === "conflict") {
      return { kind: "conflict", text: res.message ?? `That ${noun} already exists.` };
    }
    const names = res?.skills?.map((s) => s.slug) ?? (res?.workflow ? [res.workflow.name] : []);
    const verb = res?.replaced || res?.skills?.some((s) => s.replaced) ? "Replaced" : "Imported";
    const warn = res?.warnings?.length ? ` ${res.warnings.join(" ")}` : "";
    return {
      kind: "imported",
      text: `${verb} ${noun}${names.length > 1 ? "s" : ""}: ${names.join(", ")}.${warn}`,
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const text = /^[A-Z_]+:\s/.test(raw) ? raw.replace(/^[A-Z_]+:\s/, "") : raw;
    return { kind: "error", text: text || `Couldn't import that ${noun}.` };
  }
}

@customElement("import-upload")
export class ImportUpload extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property() method = "skills.import";
  @property() noun = "skill";
  @property() accept = ".md,.zip";
  @property() label = "Import";
  @state() private busy = false;
  @state() private dragging = false;
  @state() private outcome: Outcome | null = null;
  @state() private pending: File | null = null;
  private dragDepth = 0;
  private dismissTimer: number | undefined;

  static styles = css`
    :host { display: inline-block; }
    .btn {
      font: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
      padding: 8px 14px; border-radius: 10px; color: inherit;
      background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.16);
    }
    .btn:hover { background: rgba(255,255,255,0.1); }
    .btn[disabled] { opacity: 0.6; cursor: progress; }
    /* Overlays use popover="manual" (top layer) so ancestor transforms /
       backdrop-filters on host pages can't trap position:fixed. */
    [popover] { margin: 0; border: 0; padding: 0; overflow: visible; background: transparent; color: inherit; }
    .toast {
      position: fixed; inset: auto 20px 20px auto; z-index: 2147483000; max-width: 420px;
      padding: 12px 16px; border-radius: 12px; font-size: 13px; line-height: 1.45;
      background: rgba(18,18,22,0.96); color: #f5f1e6; white-space: pre-line;
      border: 1px solid rgba(255,255,255,0.18); box-shadow: 0 10px 40px rgba(0,0,0,0.5);
    }
    .toast.ok { border-color: rgba(80,200,120,0.6); }
    .toast.err { border-color: rgba(240,90,90,0.7); }
    .toast.sized { width: fit-content; height: fit-content; }
    .toast button { all: unset; cursor: pointer; margin-left: 10px; opacity: 0.7; }
    .drop {
      position: fixed; inset: 0; width: 100%; height: 100%; max-width: none; max-height: none; z-index: 2147482000; display: grid; place-items: center;
      background: rgba(10,10,14,0.72); backdrop-filter: blur(4px); pointer-events: none;
      color: #f5d77a; font-size: 22px; font-weight: 600;
    }
    .drop div { padding: 40px 64px; border: 2px dashed #f5d77a; border-radius: 20px; }
    .scrim {
      position: fixed; inset: 0; width: 100%; height: 100%; max-width: none; max-height: none; z-index: 2147483100; display: grid; place-items: center;
      background: rgba(0,0,0,0.6);
    }
    .dlg {
      width: min(440px, 92vw); padding: 22px; border-radius: 16px; color: #f5f1e6;
      background: rgba(22,22,28,0.98); border: 1px solid rgba(245,215,122,0.35);
    }
    .dlg h3 { margin: 0 0 8px; font-size: 16px; }
    .dlg p { margin: 0 0 16px; opacity: 0.85; font-size: 13px; line-height: 1.5; }
    .row { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
    .gold { background: #f5d77a; color: #1a1a1a; border-color: #f5d77a; }
  `;

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("dragenter", this.onDragEnter);
    window.addEventListener("dragleave", this.onDragLeave);
    window.addEventListener("dragover", this.onDragOver);
    window.addEventListener("drop", this.onDrop);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("dragenter", this.onDragEnter);
    window.removeEventListener("dragleave", this.onDragLeave);
    window.removeEventListener("dragover", this.onDragOver);
    window.removeEventListener("drop", this.onDrop);
    window.clearTimeout(this.dismissTimer);
  }

  private hasFiles(e: DragEvent) {
    return Array.from(e.dataTransfer?.types ?? []).includes("Files");
  }
  private onDragEnter = (e: DragEvent) => {
    if (!this.hasFiles(e)) return;
    this.dragDepth++;
    this.dragging = true;
  };
  private onDragLeave = (e: DragEvent) => {
    if (!this.hasFiles(e)) return;
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.dragging = false;
  };
  private onDragOver = (e: DragEvent) => {
    if (this.hasFiles(e)) e.preventDefault();
  };
  private onDrop = (e: DragEvent) => {
    if (!this.hasFiles(e)) return;
    e.preventDefault();
    this.dragDepth = 0;
    this.dragging = false;
    const files = Array.from(e.dataTransfer?.files ?? []);
    void this.importFiles(files);
  };

  private async importFiles(files: File[]) {
    for (const f of files) await this.importOne(f, "ask");
  }

  private async importOne(file: File, mode: "ask" | "replace" | "keep-both") {
    if (!this.client) {
      this.show({ kind: "error", text: "Not connected to the gateway yet. Try again in a moment." });
      return;
    }
    this.busy = true;
    this.outcome = null;
    const res = await runImport(this.client, this.method, this.noun, file, mode);
    this.busy = false;
    if (res.kind === "conflict") {
      this.pending = file;
      this.outcome = res;
      return;
    }
    this.pending = null;
    this.show(res);
    if (res.kind === "imported") {
      this.dispatchEvent(new CustomEvent("imported", { bubbles: true, composed: true }));
    }
  }

  private show(o: Outcome) {
    this.outcome = o;
    window.clearTimeout(this.dismissTimer);
    if (o.kind === "imported") {
      this.dismissTimer = window.setTimeout(() => (this.outcome = null), 8000);
    }
  }

  private resolve(mode: "replace" | "keep-both" | null) {
    const file = this.pending;
    this.pending = null;
    this.outcome = null;
    if (file && mode) void this.importOne(file, mode);
  }

  protected updated() {
    for (const el of this.renderRoot.querySelectorAll<HTMLElement>("[popover]")) {
      if (!el.matches(":popover-open")) {
        try { el.showPopover(); } catch { /* already open / unsupported */ }
      }
    }
  }

  render() {
    const o = this.outcome;
    return html`
      <button class="btn" part="button" ?disabled=${this.busy}
        title=${`Upload a ${this.noun} (${this.accept}) — or drag a file onto the page`}
        @click=${() => this.renderRoot.querySelector<HTMLInputElement>("input[type=file]")?.click()}>
        ⇪ ${this.busy ? "Importing…" : this.label}
      </button>
      <input type="file" hidden multiple accept=${this.accept}
        @change=${(e: Event) => {
          const input = e.target as HTMLInputElement;
          const files = Array.from(input.files ?? []);
          input.value = "";
          void this.importFiles(files);
        }} />
      ${this.dragging
        ? html`<div class="drop" popover="manual"><div>Drop to import ${this.noun}${this.noun === "skill" ? " (.md or .zip)" : " (.json or .md)"}</div></div>`
        : nothing}
      ${o && o.kind === "conflict" && this.pending
        ? html`<div class="scrim" popover="manual"><div class="dlg" role="dialog" aria-label="Name already exists">
            <h3>Already exists</h3>
            <p>${o.text}</p>
            <div class="row">
              <button class="btn" @click=${() => this.resolve(null)}>Cancel</button>
              <button class="btn" @click=${() => this.resolve("keep-both")}>Keep both</button>
              <button class="btn gold" @click=${() => this.resolve("replace")}>Replace</button>
            </div></div></div>`
        : o && o.kind !== "conflict"
          ? html`<div class="toast ${o.kind === "imported" ? "ok" : "err"}" role="status" popover="manual">
              ${o.kind === "imported" ? "✓ " : "⚠ "}${o.text}
              <button aria-label="Dismiss" @click=${() => (this.outcome = null)}>✕</button>
            </div>`
          : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "import-upload": ImportUpload;
  }
}
