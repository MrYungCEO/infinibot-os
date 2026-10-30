/**
 * <cmo-chat> — the CMO marketing chat, now a thin wrapper over the universal
 * <agent-chat-modal> locked to the "cmo" agent. Kept so embeds such as the
 * Content Intelligence page (`<cmo-chat integrated>`) keep working unchanged,
 * including their legacy `agent:cmo:cmo-chat` session history.
 */

import { customElement } from "lit/decorators.js";

import { AgentChatModal } from "./agent-chat-modal";
import { CMO_AGENT_ID, CMO_CHAT_SUFFIX } from "./agent-chat-state";

@customElement("cmo-chat")
export class CmoChat extends AgentChatModal {
  constructor() {
    super();
    this.agentId = CMO_AGENT_ID;
    this.lockedAgent = true;
    this.sessionSuffix = CMO_CHAT_SUFFIX;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cmo-chat": CmoChat;
  }
}
