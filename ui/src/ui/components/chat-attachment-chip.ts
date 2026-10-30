import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway";
import type { ChatAttachment } from "../ui-types";
import { icons } from "../icons";
import { ocrStatusLabel, type OcrEntryInfo } from "../file-ocr";
import "./video-detail";

function iconFor(mime: string) {
  if (mime === "application/pdf") return "PDF";
  if (mime.includes("wordprocessingml")) return "DOCX";
  if (mime.includes("spreadsheetml") || mime === "text/csv")
    return mime === "text/csv" ? "CSV" : "XLSX";
  if (mime.includes("presentationml")) return "PPTX";
  if (mime === "text/markdown") return "MD";
  if (mime.startsWith("text/")) return "TXT";
  if (mime.startsWith("video/")) return "VIDEO";
  return "FILE";
}

@customElement("ib-chat-attachment-chip")
export class ChatAttachmentChip extends LitElement {
  static styles = css`
    :host {
      display: inline-block;
      max-width: min(360px, 100%);
      color: var(--text, #eee);
    }
    .chip {
      position: relative;
      min-width: 190px;
      max-width: 100%;
      min-height: 62px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 34px 8px 9px;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.14));
      border-radius: 12px;
      background: var(--g-surface, rgba(20, 20, 24, 0.9));
      overflow: hidden;
    }
    .thumb {
      width: 44px;
      height: 44px;
      flex: none;
      display: grid;
      place-items: center;
      border-radius: 8px;
      background: color-mix(in srgb, var(--g-primary, #d7b45a) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary, #d7b45a) 28%, transparent);
      color: var(--g-primary, #d7b45a);
      font:
        700 10px/1 ui-monospace,
        monospace;
    }
    img.thumb {
      object-fit: cover;
      color: transparent;
    }
    .meta {
      min-width: 0;
      display: grid;
      gap: 4px;
      flex: 1;
    }
    .name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      font-weight: 650;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: var(--muted, #999);
      font-size: 10.5px;
    }
    .status[data-status="done"] {
      color: #79d69c;
    }
    .status[data-status="failed"] {
      color: #ff9487;
    }
    .status[data-status="queued"],
    .status[data-status="processing"],
    .status[data-status="reading"],
    .status[data-status="uploading"] {
      color: var(--g-primary, #d7b45a);
    }
    .status svg {
      width: 12px;
      height: 12px;
    }
    .bar {
      height: 3px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.09);
      overflow: hidden;
    }
    .bar > i {
      display: block;
      height: 100%;
      background: var(--g-primary, #d7b45a);
      transition: width 0.15s;
    }
    .remove {
      position: absolute;
      right: 6px;
      top: 6px;
      width: 25px;
      height: 25px;
      display: grid;
      place-items: center;
      padding: 0;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: var(--muted, #999);
      cursor: pointer;
    }
    .remove:hover,
    .remove:focus-visible {
      color: var(--text, #fff);
      background: rgba(255, 255, 255, 0.08);
      outline: none;
    }
    .remove svg {
      width: 13px;
      height: 13px;
    }
    .retry,
    .inspect {
      all: unset;
      cursor: pointer;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .retry:focus-visible,
    .inspect:focus-visible {
      outline: 2px solid var(--g-primary, #d7b45a);
      outline-offset: 2px;
      border-radius: 2px;
    }
    ib-video-attach-picker {
      grid-column: 1 / -1;
    }
  `;

  @property({ attribute: false }) attachment!: ChatAttachment;
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property() sessionKey = "";
  @property({ type: Boolean }) removable = true;
  @state() private remote: OcrEntryInfo | null = null;
  private timer: number | null = null;

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("attachment") || changed.has("client")) void this.refresh();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = null;
  }

  private async refresh() {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = null;
    if (!this.client || !this.attachment?.ocrId) return;
    try {
      const result = await this.client.request<{ found?: boolean; entry?: OcrEntryInfo }>(
        "files.context.get",
        {
          id: this.attachment.ocrId,
          ...(this.attachment.secure ? { secure: true } : {}),
        },
      );
      if (result?.entry) {
        this.remote = result.entry;
        const progressChanged =
          JSON.stringify(this.attachment.extractionProgress ?? null) !==
          JSON.stringify(result.entry.progress ?? null);
        if (
          this.attachment.extractionStatus !== result.entry.status ||
          this.attachment.error !== result.entry.error ||
          progressChanged
        ) {
          this.dispatchEvent(
            new CustomEvent("attachment-status", {
              bubbles: true,
              composed: true,
              detail: {
                ...this.attachment,
                extractionStatus: result.entry.status,
                extractionProgress: result.entry.progress,
                error: result.entry.error,
              },
            }),
          );
        }
      }
    } catch {
      // The chip remains usable; chat.send will surface a definitive error.
    }
    const status = this.remote?.status ?? this.attachment.extractionStatus;
    if (status === "queued" || status === "processing") {
      this.timer = window.setTimeout(() => void this.refresh(), 2000);
    }
  }

  private openContext() {
    if (!this.attachment.ocrId || !this.client) return;
    const client = this.client;
    void import("./file-context-panel").then((module) =>
      module.openFileContextDialog({
        fileId: this.attachment.ocrId,
        fileName: this.attachment.fileName,
        secure: Boolean(this.attachment.secure),
        client,
      }),
    );
  }

  render() {
    const a = this.attachment;
    if (!a) return nothing;
    const status = this.remote?.status ?? a.extractionStatus;
    const progress = this.remote?.progress ?? a.extractionProgress;
    const pct =
      a.uploadProgress ??
      (progress?.total ? Math.round((progress.done / progress.total) * 100) : undefined);
    const pending =
      status === "reading" ||
      status === "uploading" ||
      status === "queued" ||
      status === "processing";
    const label =
      status === "reading"
        ? `Reading${pct != null ? ` ${pct}%` : "…"}`
        : status === "uploading"
          ? "Uploading…"
          : status === "failed"
            ? a.error || this.remote?.error || "Extraction failed"
            : status
              ? ocrStatusLabel({ status: status as OcrEntryInfo["status"], progress })
              : "Ready to send";
    const isImage = a.mimeType.startsWith("image/") && Boolean(a.dataUrl);
    return html`<div class="chip" data-testid="chat-attachment-chip">
      ${
        isImage
          ? html`<img class="thumb" src=${a.dataUrl} alt="" />`
          : html`<span class="thumb" aria-hidden="true">${iconFor(a.mimeType)}</span>`
      }
      <span class="meta">
        <span class="name" title=${a.fileName ?? "Attachment"}>${a.fileName ?? "Attachment"}</span>
        <span class="status" data-status=${status ?? "ready"}>
          ${pending ? icons.loader : status === "done" ? icons.checkCircle : status === "failed" ? icons.alertCircle : icons.fileText}
          ${
            a.ocrId && status !== "failed"
              ? html`<button class="inspect" type="button" @click=${this.openContext}>${label}</button>`
              : html`<span>${label}</span>`
          }
          ${
            status === "failed" && a.sourceFile
              ? html`<button class="retry" type="button" @click=${() => this.dispatchEvent(new CustomEvent("attachment-retry", { bubbles: true, composed: true, detail: a }))}>Retry</button>`
              : nothing
          }
        </span>
        ${pending && pct != null ? html`<span class="bar"><i style=${`width:${Math.max(2, pct)}%`}></i></span>` : nothing}
        ${
          a.mimeType.startsWith("video/")
            ? html`<ib-video-attach-picker
              .client=${this.client}
              .selected=${a.analysts ?? []}
              @analysts-change=${(e: CustomEvent<string[]>) => this.dispatchEvent(new CustomEvent("attachment-update", { bubbles: true, composed: true, detail: { ...a, analysts: e.detail } }))}
            ></ib-video-attach-picker>`
            : nothing
        }
      </span>
      ${this.removable ? html`<button class="remove" type="button" title="Remove attachment" aria-label=${`Remove ${a.fileName ?? "attachment"}`} @click=${() => this.dispatchEvent(new CustomEvent("attachment-remove", { bubbles: true, composed: true, detail: a }))}>${icons.x}</button>` : nothing}
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-chat-attachment-chip": ChatAttachmentChip;
  }
}
