import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

import type { AssistantIdentity } from "../assistant-identity";
import { icons } from "../icons";
import { toSanitizedMarkdownHtml } from "../markdown";
import type { MessageGroup } from "../types/chat-types";
import { renderBrandAvatar } from "./brand-avatar";
import { renderCopyAsMarkdownButton } from "./copy-as-markdown";
import { renderTTSButton } from "./tts-button";
import { handleSnippetCopy, withSnippetCopyButtons } from "./snippet-copy";
import { isSecureSessionKey } from "../secure-mode/session-key";
import { isToolResultMessage, normalizeRoleForGrouping } from "./message-normalizer";
import {
  extractTextCached,
  extractThinkingCached,
  formatReasoningMarkdown,
} from "./message-extract";
import { extractToolCards, renderToolCardSidebar } from "./tool-cards";

// Import thinking indicator components
import "../components/thinking-indicator";
import "../components/response-actions";

/**
 * Generate a stable message ID based on content + timestamp
 */
function generateMessageId(message: unknown): string {
  const m = message as Record<string, unknown>;
  const timestamp = typeof m.timestamp === 'number' ? m.timestamp : Date.now();
  const text = extractTextCached(m)?.slice(0, 100) || '';
  // Simple hash for stability
  let hash = 0;
  const str = `${timestamp}-${text}`;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit int
  }
  return `msg-${Math.abs(hash).toString(36)}`;
}

type ImageBlock = {
  url: string;
  alt?: string;
};

function extractImages(message: unknown): ImageBlock[] {
  const m = message as Record<string, unknown>;
  const content = m.content;
  const images: ImageBlock[] = [];

  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;

      if (b.type === "image") {
        // Handle source object format (from sendChatMessage)
        const source = b.source as Record<string, unknown> | undefined;
        if (source?.type === "base64" && typeof source.data === "string") {
          const data = source.data as string;
          const mediaType = (source.media_type as string) || "image/png";
          // If data is already a data URL, use it directly
          const url = data.startsWith("data:")
            ? data
            : `data:${mediaType};base64,${data}`;
          images.push({ url });
        } else if (typeof b.url === "string") {
          images.push({ url: b.url });
        }
      } else if (b.type === "image_url") {
        // OpenAI format
        const imageUrl = b.image_url as Record<string, unknown> | undefined;
        if (typeof imageUrl?.url === "string") {
          images.push({ url: imageUrl.url });
        }
      }
    }
  }

  return images;
}

export function renderReadingIndicatorGroup(
  assistant?: AssistantIdentity,
  startedAt?: number,
  extended?: boolean,
) {
  const timestamp = startedAt ?? Date.now();
  return html`
    <div class="chat-group assistant">
      ${renderAvatar("assistant", assistant)}
      <div class="chat-group-messages">
        <thinking-indicator
          .startedAt=${timestamp}
          ?extended=${extended ?? false}
        ></thinking-indicator>
      </div>
    </div>
  `;
}

export function renderStreamingGroup(
  text: string,
  startedAt: number,
  onOpenSidebar?: (content: string) => void,
  assistant?: AssistantIdentity,
) {
  const timestamp = new Date(startedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const name = assistant?.name ?? "Assistant";

  return html`
    <div class="chat-group assistant">
      ${renderAvatar("assistant", assistant)}
      <div class="chat-group-messages">
        <thinking-indicator
          .startedAt=${startedAt}
          ?streaming=${true}
        ></thinking-indicator>
        ${renderGroupedMessage(
          {
            role: "assistant",
            content: [{ type: "text", text }],
            timestamp: startedAt,
          },
          { isStreaming: true, showReasoning: false },
          onOpenSidebar,
        )}
        <div class="chat-group-footer">
          <span class="chat-sender-name">${name}</span>
          <span class="chat-group-timestamp">${timestamp}</span>
        </div>
      </div>
    </div>
  `;
}

export function renderMessageGroup(
  group: MessageGroup,
  opts: {
    onOpenSidebar?: (content: string) => void;
    showReasoning: boolean;
    assistantName?: string;
    assistantAvatar?: string | null;
    sessionKey?: string;
  },
) {
  const normalizedRole = normalizeRoleForGrouping(group.role);
  const assistantName = opts.assistantName ?? "Assistant";
  const who =
    normalizedRole === "user"
      ? "You"
      : normalizedRole === "assistant"
        ? assistantName
        : normalizedRole;
  const roleClass =
    normalizedRole === "user"
      ? "user"
      : normalizedRole === "assistant"
        ? "assistant"
        : "other";
  const timestamp = new Date(group.timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  return html`
    <div class="chat-group ${roleClass}">
      ${renderAvatar(group.role, {
        name: assistantName,
        avatar: opts.assistantAvatar ?? null,
      })}
      <div class="chat-group-messages">
        ${group.messages.map((item, index) =>
          renderGroupedMessage(
            item.message,
            {
              isStreaming:
                group.isStreaming && index === group.messages.length - 1,
              showReasoning: opts.showReasoning,
              sessionKey: opts.sessionKey,
            },
            opts.onOpenSidebar,
          ),
        )}
        <div class="chat-group-footer">
          <span class="chat-sender-name">${who}</span>
          <span class="chat-group-timestamp">${timestamp}</span>
        </div>
      </div>
    </div>
  `;
}

export function renderAvatar(
  role: string,
  assistant?: Pick<AssistantIdentity, "name" | "avatar">,
) {
  const normalized = normalizeRoleForGrouping(role);
  // Assistant turns always show the (white-label aware) brand logo.
  if (normalized === "assistant") {
    const assistantName = assistant?.name?.trim() || "Assistant";
    return renderBrandAvatar("chat-avatar assistant", assistantName);
  }
  const initial = normalized === "user" ? "U" : normalized === "tool" ? "⚙" : "?";
  const className =
    normalized === "user" ? "user" : normalized === "tool" ? "tool" : "other";
  return html`<div class="chat-avatar ${className}">${initial}</div>`;
}

/** Check if we're on a mobile device */
function isMobileDevice(): boolean {
  return (
    window.matchMedia("(max-width: 768px)").matches ||
    window.matchMedia("(pointer: coarse)").matches ||
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
  );
}

/** Show fullscreen image lightbox on mobile, new tab on desktop */
function openImageViewer(url: string, alt?: string) {
  if (isMobileDevice()) {
    // Create lightbox overlay
    const lightbox = document.createElement("div");
    lightbox.className = "image-lightbox";
    lightbox.innerHTML = `
      <img src="${url}" alt="${alt ?? "Image"}" class="image-lightbox__img" />
      <button class="image-lightbox__close" aria-label="Close">✕</button>
      <div class="image-lightbox__hint">Tap anywhere to close • Pinch to zoom</div>
    `;

    // Close on tap anywhere
    const close = () => {
      lightbox.style.opacity = "0";
      setTimeout(() => lightbox.remove(), 150);
    };

    lightbox.addEventListener("click", (e) => {
      // Don't close if tapping the image itself (for pinch-zoom)
      if ((e.target as HTMLElement).classList.contains("image-lightbox__img")) {
        return;
      }
      close();
    });

    // Close on escape key
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        document.removeEventListener("keydown", onKeyDown);
      }
    };
    document.addEventListener("keydown", onKeyDown);

    // Close button
    lightbox.querySelector(".image-lightbox__close")?.addEventListener("click", close);

    document.body.appendChild(lightbox);
  } else {
    // Desktop: open in new tab
    window.open(url, "_blank");
  }
}

function renderMessageImages(images: ImageBlock[], withOcr = false) {
  if (images.length === 0) return nothing;

  return html`
    <div class="chat-message-images">
      ${images.map(
        (img) => html`
          <span class="chat-message-image-wrap">
            <img
              src=${img.url}
              alt=${img.alt ?? "Attached image"}
              class="chat-message-image"
              @click=${() => openImageViewer(img.url, img.alt)}
            />
            ${withOcr
              ? html`<button
                  type="button"
                  class="chat-attachment-ocr"
                  title="Extracted text and description (local OCR)"
                  aria-label="Show extracted text and description"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    void import("../components/file-context-panel").then((m) =>
                      m.openAttachmentContext(img.url, img.alt),
                    );
                  }}
                >${icons.scrollText}<span>Text</span></button>`
              : nothing}
          </span>
        `,
      )}
    </div>
  `;
}

export function renderGroupedMessage(
  message: unknown,
  opts: { isStreaming: boolean; showReasoning: boolean; sessionKey?: string },
  onOpenSidebar?: (content: string) => void,
) {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const isToolResult =
    isToolResultMessage(message) ||
    role.toLowerCase() === "toolresult" ||
    role.toLowerCase() === "tool_result" ||
    typeof m.toolCallId === "string" ||
    typeof m.tool_call_id === "string";

  const toolCards = extractToolCards(message);
  const hasToolCards = toolCards.length > 0;
  const images = extractImages(message);
  const hasImages = images.length > 0;

  const extractedText = extractTextCached(message);
  const extractedThinking =
    opts.showReasoning && role === "assistant"
      ? extractThinkingCached(message)
      : null;
  const markdownBase = extractedText?.trim() ? extractedText : null;
  const reasoningMarkdown = extractedThinking
    ? formatReasoningMarkdown(extractedThinking)
    : null;
  const markdown = markdownBase;
  const canCopyMarkdown = role === "assistant" && Boolean(markdown?.trim());

  const bubbleClasses = [
    "chat-bubble",
    canCopyMarkdown ? "has-copy" : "",
    opts.isStreaming ? "streaming" : "",
    "fade-in",
  ]
    .filter(Boolean)
    .join(" ");

  if (!markdown && hasToolCards && isToolResult) {
    return html`${toolCards.map((card) =>
      renderToolCardSidebar(card, onOpenSidebar),
    )}`;
  }

  if (!markdown && !hasToolCards && !hasImages) return nothing;

  // Generate a stable message ID for TTS tracking
  const messageId = generateMessageId(message);

  return html`
    <div class="${bubbleClasses}">
      ${canCopyMarkdown ? html`
        <div class="chat-bubble-actions">
          ${renderTTSButton(markdown!, messageId)}
          ${renderCopyAsMarkdownButton(markdown!)}
          ${
            !opts.isStreaming
              ? html`<ib-response-actions
                .markdown=${markdown!}
                .sessionKey=${opts.sessionKey ?? ""}
                .secure=${Boolean(opts.sessionKey && isSecureSessionKey(opts.sessionKey))}
              ></ib-response-actions>`
              : nothing
          }
        </div>
      ` : nothing}
      ${renderMessageImages(images, role === "user")}
      ${
        reasoningMarkdown
          ? html`<div class="chat-thinking">${unsafeHTML(
              toSanitizedMarkdownHtml(reasoningMarkdown),
            )}</div>`
          : nothing
      }
      ${
        markdown
          ? html`<div class="chat-text" @click=${handleSnippetCopy}>${unsafeHTML(
              withSnippetCopyButtons(toSanitizedMarkdownHtml(markdown)),
            )}</div>`
          : nothing
      }
      ${toolCards.map((card) => renderToolCardSidebar(card, onOpenSidebar))}
    </div>
  `;
}
