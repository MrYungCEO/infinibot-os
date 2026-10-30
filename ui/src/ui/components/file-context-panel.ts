/**
 * <ib-file-context> — local auto-OCR context for one file: status badge,
 * "Extracted text / Description / Pages" tabs with copy, re-run OCR, and
 * "Ask the image" (visual inspect via the local Qwen VL model).
 *
 * Resolves the file by `fileId`, `filePath` (Files-page path) or `sha256`
 * (chat attachments). `secure` reads the encrypted Secure Mode lane.
 *
 * <ib-file-context-dialog> wraps it in a modal; use openFileContextDialog().
 */
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icons } from "../icons";
import { isSecureSessionKey } from "../secure-mode/session-key";
import { getSecureState, secureRequest } from "../secure-mode/store";
import {
  formatConfidence,
  sha256OfBase64,
  urlToBase64,
  isImageFileName,
  isOcrPending,
  OCR_WINDOW_EVENT,
  ocrStatusLabel,
  type OcrEntryInfo,
  type OcrSidecarInfo,
} from "../file-ocr";
import { isVideoFileName } from "../video-analysis";
import "./video-detail";

interface RequestClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

type Tab = "text" | "description" | "pages";

const panelStyles = css`
  :host {
    display: block;
    color: var(--wg-fg, #e9e6df);
    font-size: 12.5px;
    --fc-gold: var(--wg-gold, #d9b45a);
    --fc-stroke: var(--glass-stroke, rgba(255, 255, 255, 0.1));
    --fc-well: color-mix(in srgb, var(--glass-base, #14161c) 62%, transparent);
  }
  svg { width: 14px; height: 14px; flex: none; }
  .fc { display: grid; gap: 10px; }
  .fc-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .fc-title {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--wg-fg-3, #9a968c);
  }
  .fc-title svg { color: var(--fc-gold); }
  .fc-spacer { flex: 1; }
  .badge {
    display: inline-flex; align-items: center; gap: 5px;
    height: 22px; padding: 0 9px; border-radius: 999px;
    font-size: 11px; font-weight: 600; border: 1px solid var(--fc-stroke);
    background: rgba(255, 255, 255, 0.04); color: var(--wg-fg-2, #c9c5bb); white-space: nowrap;
  }
  .badge svg { width: 12px; height: 12px; }
  .badge[data-s="done"] { color: #8fdcaa; border-color: rgba(120, 210, 150, 0.35); background: rgba(80, 190, 120, 0.1); }
  .badge[data-s="failed"] { color: #ff9a8a; border-color: rgba(255, 120, 100, 0.35); background: rgba(255, 110, 90, 0.1); }
  .badge[data-s="queued"], .badge[data-s="processing"] { color: var(--fc-gold); border-color: color-mix(in srgb, var(--fc-gold) 40%, transparent); background: color-mix(in srgb, var(--fc-gold) 10%, transparent); }
  .badge[data-s="processing"] svg { animation: spin 1.1s linear infinite; }
  .badge.lock { color: var(--fc-gold); }
  @keyframes spin { to { transform: rotate(360deg); } }
  .meta { display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--wg-fg-3, #9a968c); font-size: 11.5px; }
  .meta b { color: var(--wg-fg-2, #c9c5bb); font-weight: 600; }
  .tabs { display: inline-flex; padding: 3px; gap: 2px; border-radius: 10px; border: 1px solid var(--fc-stroke); background: rgba(0, 0, 0, 0.18); }
  .tabs button {
    all: unset; cursor: pointer; padding: 5px 10px; border-radius: 7px; font-size: 12px;
    color: var(--wg-fg-3, #9a968c); display: inline-flex; gap: 6px; align-items: center;
  }
  .tabs button[aria-selected="true"] { color: var(--wg-fg, #eee); background: rgba(255, 255, 255, 0.08); box-shadow: inset 0 0 0 1px var(--fc-stroke); }
  .tabs button:focus-visible, .btn:focus-visible { outline: 2px solid var(--fc-gold); outline-offset: 1px; }
  .well {
    position: relative; max-height: var(--fc-max-h, 46vh); overflow: auto; padding: 12px 14px;
    border-radius: 12px; border: 1px solid var(--fc-stroke); background: var(--fc-well);
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.22);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; line-height: 1.55;
    white-space: pre-wrap; word-break: break-word;
  }
  .well.prose { font-family: inherit; font-size: 12.5px; }
  .empty { color: var(--wg-fg-3, #9a968c); font-style: italic; font-family: inherit; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .btn {
    all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px;
    border-radius: 8px; border: 1px solid var(--fc-stroke); background: rgba(255, 255, 255, 0.05);
    color: var(--wg-fg-2, #c9c5bb); font-size: 12px; font-weight: 500;
  }
  .btn:hover { background: rgba(255, 255, 255, 0.09); color: var(--wg-fg, #fff); }
  .btn[disabled] { opacity: 0.5; pointer-events: none; }
  .btn.primary { color: #1a1406; border-color: transparent; background: linear-gradient(180deg, var(--wg-gold-hi, #ecd28a), var(--fc-gold)); }
  .ask { display: grid; gap: 8px; padding-top: 4px; border-top: 1px solid var(--fc-stroke); }
  .ask-row { display: flex; gap: 6px; }
  .ask input {
    flex: 1; min-width: 0; height: 30px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--fc-stroke);
    background: rgba(0, 0, 0, 0.22); color: inherit; font: inherit;
  }
  .ask input:focus { outline: none; border-color: color-mix(in srgb, var(--fc-gold) 60%, transparent); }
  .answer { padding: 10px 12px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--fc-gold) 30%, transparent); background: color-mix(in srgb, var(--fc-gold) 7%, transparent); white-space: pre-wrap; line-height: 1.5; }
  .answer small { display: block; margin-top: 6px; color: var(--wg-fg-3, #9a968c); }
  .err { color: #ff9a8a; font-size: 12px; }
  .warn { color: var(--wg-fg-3, #9a968c); font-size: 11.5px; }
  .page { margin-bottom: 10px; }
  .page h4 { margin: 0 0 4px; font: 600 11px/1.4 inherit; color: var(--wg-fg-3, #9a968c); letter-spacing: 0.04em; text-transform: uppercase; display: flex; gap: 8px; }
  .skel { height: 10px; border-radius: 6px; background: linear-gradient(90deg, rgba(255,255,255,0.05), rgba(255,255,255,0.12), rgba(255,255,255,0.05)); background-size: 200% 100%; animation: sh 1.4s ease infinite; margin: 6px 0; }
  @keyframes sh { to { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) { .skel, .badge[data-s="processing"] svg { animation: none; } }
`;

export function ocrBadgeTemplate(status: OcrEntryInfo["status"] | undefined, progress?: OcrEntryInfo["progress"]) {
  if (!status) return nothing;
  const icon =
    status === "done" ? icons.checkCircle : status === "failed" ? icons.alertCircle : status === "processing" ? icons.loader : icons.clock;
  return html`<span class="badge" data-s=${status} title=${ocrStatusLabel({ status, progress })}>${icon}${ocrStatusLabel({ status, progress })}</span>`;
}

@customElement("ib-file-context")
export class FileContextPanel extends LitElement {
  static styles = panelStyles;

  @property({ attribute: false }) client: RequestClient | null = null;
  @property() fileId: string | null = null;
  @property() filePath: string | null = null;
  @property() sha256: string | null = null;
  @property() fileName: string | null = null;
  @property({ type: Boolean }) secure = false;

  @state() private entry: OcrEntryInfo | null = null;
  @state() private sidecar: OcrSidecarInfo | null = null;
  @state() private loading = false;
  @state() private notFound = false;
  @state() private error: string | null = null;
  @state() private tab: Tab = "text";
  @state() private copied = false;
  @state() private question = "";
  @state() private answer: { text: string; model: string } | null = null;
  @state() private asking = false;
  @state() private rerunning = false;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private onOcrEvent = (e: Event) => {
    const d = (e as CustomEvent<{ id?: string; lane?: string }>).detail;
    if (!d || (this.entry && d.id === this.entry.id) || !this.entry) void this.load(true);
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(OCR_WINDOW_EVENT, this.onOcrEvent);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(OCR_WINDOW_EVENT, this.onOcrEvent);
    this.clearTimer();
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("fileId") || changed.has("filePath") || changed.has("sha256") || changed.has("secure") || changed.has("client")) {
      if (changed.has("fileId") || changed.has("filePath") || changed.has("sha256")) {
        this.entry = null;
        this.sidecar = null;
        this.answer = null;
        this.question = "";
        this.tab = "text";
      }
      void this.load();
    }
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private ref(): Record<string, unknown> {
    if (this.fileId) return { id: this.fileId };
    if (this.filePath) return { path: this.filePath };
    if (this.sha256) return { sha256: this.sha256 };
    return {};
  }

  async load(quiet = false): Promise<void> {
    const client = this.client;
    const ref = this.ref();
    if (!client || !Object.keys(ref).length) return;
    const seq = ++this.seq;
    if (!quiet && !this.entry) this.loading = true;
    try {
      const res = await client.request<{ found: boolean; entry?: OcrEntryInfo; sidecar?: OcrSidecarInfo | null }>(
        "files.context.get",
        { ...ref, ...(this.secure ? { secure: true } : {}) },
      );
      if (seq !== this.seq) return;
      this.error = null;
      this.notFound = !res?.found;
      this.entry = res?.entry ?? null;
      this.sidecar = res?.sidecar ?? null;
      if (this.tab === "text" && !this.sidecar?.markdown?.trim() && this.sidecar?.description) this.tab = "description";
    } catch (err) {
      if (seq !== this.seq) return;
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (seq === this.seq) this.loading = false;
    }
    this.clearTimer();
    if (this.isConnected && (isOcrPending(this.entry?.status) || (this.entry?.status === "done" && !this.sidecar?.complete))) {
      this.timer = setTimeout(() => void this.load(true), 2500);
    }
  }

  private async copy() {
    const text = this.tab === "description" ? this.sidecar?.description ?? "" : this.sidecar?.markdown ?? "";
    try {
      await navigator.clipboard.writeText(text);
      this.copied = true;
      setTimeout(() => (this.copied = false), 1400);
    } catch {
      /* clipboard blocked */
    }
  }

  private async rerun() {
    if (!this.client) return;
    this.rerunning = true;
    try {
      const ref = this.entry ? { id: this.entry.id } : this.ref();
      const res = await this.client.request<{ entry: OcrEntryInfo }>("files.ocr.rerun", {
        ...ref,
        ...(this.secure ? { secure: true } : {}),
      });
      if (res?.entry) {
        this.entry = res.entry;
        this.sidecar = null;
        this.notFound = false;
      }
      this.dispatchEvent(new CustomEvent("ocr-rerun", { detail: res?.entry, bubbles: true, composed: true }));
      void this.load(true);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.rerunning = false;
    }
  }

  private async ask(e?: Event) {
    e?.preventDefault();
    const q = this.question.trim();
    if (!q || !this.client || !this.entry) return;
    this.asking = true;
    this.answer = null;
    this.error = null;
    try {
      const res = await this.client.request<{ answer: string; model: string }>("files.inspect", {
        id: this.entry.id,
        question: q,
        ...(this.secure ? { secure: true } : {}),
      });
      this.answer = { text: res?.answer ?? "", model: res?.model ?? "" };
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.asking = false;
    }
  }

  private renderBody() {
    const sc = this.sidecar;
    if (this.loading) return html`<div class="well">${[86, 64, 78, 52].map((w) => html`<div class="skel" style="width:${w}%"></div>`)}</div>`;
    if (this.tab === "description") {
      return html`<div class="well prose" data-testid="ocr-description">${sc?.description?.trim() ||
        html`<span class="empty">${isOcrPending(this.entry?.status) ? "The local vision model is still looking at this file…" : "No vision description for this file."}</span>`}</div>`;
    }
    if (this.tab === "pages") {
      return html`<div class="well">${(sc?.pages ?? []).map(
        (p) => html`<div class="page"><h4><span>Page ${p.page}</span><span>${p.method}</span><span>${formatConfidence(p.confidence)}</span></h4>${p.text || html`<span class="empty">(no text)</span>`}</div>`,
      )}</div>`;
    }
    return html`<div class="well" data-testid="ocr-text">${sc?.markdown?.trim() ||
      html`<span class="empty">${isOcrPending(this.entry?.status) ? "Reading text locally…" : "No text was found in this file."}</span>`}</div>`;
  }

  render() {
    const e = this.entry;
    const sc = this.sidecar;
    const name = e?.name ?? this.fileName ?? "";
    // Videos: the video analysis card (player, analysts, findings) replaces the text tabs.
    if (isVideoFileName(name)) {
      return html`<ib-video-detail
        compact
        .client=${this.client}
        .fileId=${e?.id ?? this.fileId}
        .filePath=${this.filePath}
        .sha256=${this.sha256}
        .fileName=${name}
        .secure=${this.secure}
      ></ib-video-detail>`;
    }
    const canAsk = e && (isImageFileName(name) || /\.pdf$/i.test(name));
    return html`<div class="fc" data-testid="file-context-panel">
      <div class="fc-head">
        <span class="fc-title">${icons.scrollText}Local OCR</span>
        ${this.secure ? html`<span class="badge lock">${icons.lock}Secure lane</span>` : nothing}
        <span class="fc-spacer"></span>
        ${e ? ocrBadgeTemplate(e.status, e.progress) : this.notFound ? html`<span class="badge">${icons.minus}Not scanned</span>` : nothing}
      </div>
      ${e
        ? html`<div class="meta">
            <span>Confidence <b>${formatConfidence(sc?.confidence ?? e.confidence)}</b></span>
            <span>Pages <b>${sc?.pageCount ?? e.pages ?? "—"}</b></span>
            <span>Engine <b>${sc?.engines?.ocr ? "RapidOCR" : sc?.engines?.text?.includes("native") ? "Native text" : sc?.engines?.text?.includes("pdf-text-layer") ? "PDF text" : "—"}</b></span>
            <span>Vision <b>${sc?.engines?.vl ?? e.vlModel ?? "—"}</b></span>
            ${sc?.updatedAt ? html`<span>Updated <b>${new Date(sc.updatedAt).toLocaleString()}</b></span>` : nothing}
          </div>`
        : nothing}
      ${e?.status === "failed" && e.error ? html`<div class="err" role="alert">${e.error}</div>` : nothing}
      ${this.error ? html`<div class="err" role="alert">${this.error}</div>` : nothing}
      ${e || this.loading
        ? html`<div class="row">
              <div class="tabs" role="tablist" aria-label="OCR views">
                <button role="tab" aria-selected=${this.tab === "text"} @click=${() => (this.tab = "text")}>${icons.fileText}Extracted text</button>
                <button role="tab" aria-selected=${this.tab === "description"} @click=${() => (this.tab = "description")}>${icons.eye}Description</button>
                ${(sc?.pageCount ?? 0) > 1 ? html`<button role="tab" aria-selected=${this.tab === "pages"} @click=${() => (this.tab = "pages")}>${icons.layers}Pages</button>` : nothing}
              </div>
              <span class="fc-spacer"></span>
              <button class="btn" @click=${this.copy} ?disabled=${!sc} aria-label="Copy text">${this.copied ? icons.check : icons.copy}${this.copied ? "Copied" : "Copy"}</button>
              <button class="btn" @click=${this.rerun} ?disabled=${this.rerunning || isOcrPending(e?.status)} aria-label="Re-run OCR">${icons.refresh}Re-run</button>
            </div>
            ${this.renderBody()}
            ${(sc?.warnings ?? []).length ? html`<div class="warn">${sc!.warnings.join(" · ")}</div>` : nothing}`
        : this.notFound
          ? html`<div class="row"><span class="warn">This file has not been scanned yet.</span><span class="fc-spacer"></span><button class="btn primary" @click=${this.rerun} ?disabled=${this.rerunning}>${icons.scrollText}Run OCR</button></div>`
          : nothing}
      ${canAsk
        ? html`<form class="ask" @submit=${this.ask}>
            <span class="fc-title">${icons.sparkles}Ask the image</span>
            <div class="ask-row">
              <input
                type="text"
                placeholder="e.g. What is the total amount due?"
                aria-label="Question for the local vision model"
                .value=${this.question}
                @input=${(ev: Event) => (this.question = (ev.target as HTMLInputElement).value)}
              />
              <button class="btn primary" type="submit" ?disabled=${this.asking || !this.question.trim()}>${this.asking ? icons.loader : icons.send}${this.asking ? "Looking…" : "Ask"}</button>
            </div>
            ${this.answer ? html`<div class="answer" data-testid="ocr-answer">${this.answer.text}<small>Answered locally by ${this.answer.model}</small></div>` : nothing}
          </form>`
        : nothing}
    </div>`;
  }
}

@customElement("ib-file-context-dialog")
export class FileContextDialog extends LitElement {
  static styles = css`
    :host { position: fixed; inset: 0; z-index: 2000; display: grid; place-items: center; }
    .scrim { position: absolute; inset: 0; background: rgba(4, 5, 8, 0.6); backdrop-filter: blur(6px); }
    .card {
      position: relative; width: min(720px, calc(100vw - 32px)); max-height: calc(100vh - 48px); overflow: auto;
      padding: 18px 18px 16px; border-radius: 18px; border: 1px solid var(--glass-stroke, rgba(255,255,255,0.12));
      background: var(--glass-sheen, none), color-mix(in srgb, var(--glass-base, #121419) 92%, transparent);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55), var(--glass-specular, none); color: var(--wg-fg, #eee);
    }
    header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
    h3 { margin: 0; font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    button.x { all: unset; cursor: pointer; width: 30px; height: 30px; display: grid; place-items: center; border-radius: 8px; color: var(--wg-fg-3, #999); }
    button.x:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }
    button.x svg { width: 16px; height: 16px; }
    img.thumb { width: 54px; height: 54px; object-fit: cover; border-radius: 10px; border: 1px solid var(--glass-stroke, rgba(255,255,255,0.12)); }
  `;

  @property({ attribute: false }) client: RequestClient | null = null;
  @property() fileId: string | null = null;
  @property() filePath: string | null = null;
  @property() sha256: string | null = null;
  @property() fileName: string | null = null;
  @property() thumb: string | null = null;
  @property({ type: Boolean }) secure = false;

  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.close();
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.onKey);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onKey);
  }

  close() {
    this.remove();
  }

  render() {
    return html`<div class="scrim" @click=${this.close}></div>
      <div class="card" role="dialog" aria-modal="true" aria-label="Attachment text and description">
        <header>
          ${this.thumb ? html`<img class="thumb" src=${this.thumb} alt="" />` : nothing}
          <h3>${this.fileName || "Attachment"}</h3>
          <button class="x" aria-label="Close" @click=${this.close}>${icons.x}</button>
        </header>
        <ib-file-context
          .client=${this.client}
          .fileId=${this.fileId}
          .filePath=${this.filePath}
          .sha256=${this.sha256}
          .fileName=${this.fileName}
          .secure=${this.secure}
        ></ib-file-context>
      </div>`;
  }
}

export function openFileContextDialog(opts: {
  client: RequestClient;
  fileId?: string | null;
  filePath?: string | null;
  sha256?: string | null;
  fileName?: string | null;
  thumb?: string | null;
  secure?: boolean;
}): FileContextDialog {
  document.querySelectorAll("ib-file-context-dialog").forEach((d) => d.remove());
  const el = document.createElement("ib-file-context-dialog") as FileContextDialog;
  el.client = opts.client;
  el.fileId = opts.fileId ?? null;
  el.filePath = opts.filePath ?? null;
  el.sha256 = opts.sha256 ?? null;
  el.fileName = opts.fileName ?? null;
  el.thumb = opts.thumb ?? null;
  el.secure = Boolean(opts.secure);
  document.body.appendChild(el);
  return el;
}

/** Chat/group-chat attachment → its OCR panel (matched by content hash). */
export async function openAttachmentContext(url: string, name?: string | null, sessionKey?: string | null) {
  const b64 = await urlToBase64(url);
  const sha = b64 ? await sha256OfBase64(b64) : null;
  const key = sessionKey ?? getSecureState().chatSessionKey;
  return openFileContextDialog({
    client: { request: (method, params) => secureRequest(method, (params ?? {}) as Record<string, unknown>) },
    sha256: sha,
    fileName: name || "Attached image",
    thumb: url,
    secure: isSecureSessionKey(key),
  });
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-file-context": FileContextPanel;
    "ib-file-context-dialog": FileContextDialog;
  }
}
