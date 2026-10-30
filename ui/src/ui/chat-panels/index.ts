/**
 * Chat panels — the ONE shared entry point every chat surface uses to render
 * agent-invokable panels (webchat, Grid chat, classic chat, voice transcript).
 * Detect with `extractPanelRef` / `extractPanelRefsFromMessage`, render with
 * `renderChatPanelRef`. Backend: src/chat-panels + chat.panel.* RPCs.
 */
import { html, nothing } from "lit";

import "./chat-panel-card";
import { extractPanelRef, type ChatPanelRef } from "./panel-ref";

export {
  extractPanelRef,
  extractPanelRefsFromMessage,
  SHOW_PANEL_TOOL,
  type ChatPanelRef,
} from "./panel-ref";

export { isChatPanelModalOpen } from "./chat-panel-modal";

export function renderChatPanelRef(ref: ChatPanelRef) {
  return html`<chat-panel-card .ref=${ref}></chat-panel-card>`;
}

/** Render the panel card for a tool result's text, or `nothing` if it has none. */
export function renderPanelForToolText(text: unknown) {
  const ref = extractPanelRef(text);
  return ref ? renderChatPanelRef(ref) : nothing;
}
