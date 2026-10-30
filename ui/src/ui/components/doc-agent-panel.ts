/**
 * <doc-agent-panel> — full-height glass-morphism document agent panel
 * with streaming markdown rendering, typing indicator, and tool pulses.
 *
 * Drop one of these into any content page (note detail, database row,
 * workflow editor, project content, kanban card) and the user gets a
 * floating, document-scoped chat with the agent. The panel:
 *
 *   1. Spawns a doc-typed session via `doc_agent.spawn` on first open.
 *      The server returns the sessionKey + the system prompt that
 *      describes the document and the editing rules.
 *   2. Loads any prior conversation for that sessionKey via
 *      `chat.history` (so reopening the panel on a doc you've worked on
 *      brings the conversation back).
 *   3. Streams new turns via the regular `chat.send` flow — agent runs
 *      with the doc-agent tool profile (notes/databases/kanban/workflows
 *      writers allowed; exec/process/browser denied).
 *   4. Renders the system prompt as an editable "Instructions" header
 *      so the user can see (and tweak) what the agent's been told.
 *   5. Renders assistant messages as formatted markdown with streaming
 *      cursor, typing dots, and tool-activity pulse animation.
 *
 * Reuse pattern in a page render function:
 *
 *   import "../components/doc-agent-panel.js";
 *
 *   html`<doc-agent-panel
 *     .client=${client}
 *     docType="note"
 *     .documentId=${note.id}
 *     .title=${note.name}
 *     .content=${note.body}
 *   ></doc-agent-panel>`
 *
 * The panel floats from the right edge, full viewport height, with a
 * launch button when collapsed; expanded to ~440px wide. Auto-hides if
 * the page navigates away (the host page owns the lifecycle).
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";
import type { GatewayBrowserClient } from "../gateway";
import "./agent-cli-selector";
import "./thinking-indicator.js";
import type { SelectorValue } from "./agent-cli-selector";

interface ChatMessageItem {
  role: "user" | "assistant" | "system";
  text: string;
  ts: number;
}

interface Capabilities {
  sidePanel: boolean;
  voice: boolean;
  liveActionObserve: boolean;
  liveActionAct: boolean;
}

interface SpawnResponse {
  sessionKey: string;
  systemPrompt: string;
  docType: string;
  documentId: string;
  agentId: string;
  model: string;
  title: string | null;
  toolProfile: string;
  editableInstructions: boolean;
  capabilities?: Capabilities;
}

interface ObservedEvent {
  kind: string;
  ts: number;
  summary: string;
}

function extractText(msg: unknown): string {
  if (!msg) return "";
  if (typeof msg === "string") return msg;
  if (typeof msg === "object") {
    const m = msg as Record<string, unknown>;
    if (typeof m.text === "string") return m.text;
    if (typeof m.content === "string") return m.content;
  }
  return "";
}

@customElement("doc-agent-panel")
export class DocAgentPanel extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property() docType:
    | "note"
    | "db_row"
    | "workflow"
    | "project"
    | "kanban_card"
    | "content_page"
    | "storyboard"
    | "whiteboard_doc"
    | "video_composition"
    | "brand_doc"
    | "funnel_page"
    | "inbox_thread"
    | "generic" = "generic";
  @property() documentId = "";
  @property() title = "";
  @property() content = "";
  @property() databaseId = "";
  @property() schema = "";
  @property() extra = "";
  @property({ type: Boolean }) startOpen = false;

  @state() private _open = false;
  @state() private _spawning = false;
  @state() private _sessionKey: string | null = null;
  @state() private _systemPrompt = "";
  @state() private _model = "";
  @state() private _messages: ChatMessageItem[] = [];
  @state() private _draft = "";
  @state() private _sending = false;
  @state() private _streamingContent: string | null = null;
  @state() private _err: string | null = null;
  @state() private _showInstructions = false;
  @state() private _capabilities: Capabilities = {
    sidePanel: true,
    voice: false,
    liveActionObserve: false,
    liveActionAct: false,
  };
  @state() private _voiceEnabled = false;
  @state() private _liveActionEnabled = false;
  @state() private _observed: ObservedEvent[] = [];
  @state() private _voiceCliSelection: SelectorValue = { kind: "gateway", id: "gateway" };

  private _eventUnsubscribe: (() => void) | null = null;

  private _onLiveActionEvent = (ev: Event) => {
    const ce = ev as CustomEvent<{ sessionKey?: string; kind?: string; summary?: string }>;
    const d = ce.detail ?? {};
    if (!this._sessionKey || d.sessionKey !== this._sessionKey) return;
    if (!d.kind || !d.summary) return;
    const next: ObservedEvent = { kind: d.kind, ts: Date.now(), summary: d.summary };
    const list = [...this._observed, next];
    this._observed = list.length > 5 ? list.slice(list.length - 5) : list;
  };

  static override styles = css`
    :host {
      position: fixed;
      bottom: 0;
      right: 0;
      z-index: 6500;
      pointer-events: none;
      font-family: inherit;
      --doc-agent-accent: var(--g-primary, #caa45a);
    }

    .launcher {
      pointer-events: auto;
      position: fixed;
      bottom: 24px;
      right: 24px;
      height: 40px;
      padding: 0 18px 0 14px;
      border-radius: 999px;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: color-mix(in srgb, var(--doc-agent-accent) 92%, #f5f5f4);
      display: inline-flex;
      align-items: center;
      gap: 10px;
      isolation: isolate;
      background:
        linear-gradient(
          135deg,
          color-mix(in srgb, var(--doc-agent-accent) 22%, transparent) 0%,
          color-mix(in srgb, var(--doc-agent-accent) 8%, transparent) 50%,
          color-mix(in srgb, var(--g-bg, #0a0a0a) 60%, transparent) 100%
        ),
        color-mix(in srgb, var(--g-bg, #0a0a0a) 70%, transparent);
      border: 1px solid color-mix(in srgb, var(--doc-agent-accent) 36%, transparent);
      backdrop-filter: blur(18px) saturate(160%);
      -webkit-backdrop-filter: blur(18px) saturate(160%);
      box-shadow:
        inset 0 1px 0 color-mix(in srgb, #ffffff 14%, transparent),
        inset 0 -1px 0 rgba(0, 0, 0, 0.4),
        0 8px 28px -8px color-mix(in srgb, var(--doc-agent-accent) 38%, transparent),
        0 2px 8px rgba(0, 0, 0, 0.35);
      transform: translateY(0);
      transition:
        transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
        box-shadow 220ms ease,
        background 220ms ease;
    }
    .launcher::before {
      content: "";
      position: absolute;
      inset: -8px -2px -8px -8px;
      border-radius: inherit;
      background: radial-gradient(
        65% 80% at 20% 50%,
        color-mix(in srgb, var(--doc-agent-accent) 32%, transparent),
        transparent 70%
      );
      filter: blur(14px);
      opacity: 0.55;
      z-index: -1;
      transition: opacity 220ms ease;
    }
    .launcher:hover {
      transform: translateY(-3px) scale(1.04);
      box-shadow:
        inset 0 1px 0 color-mix(in srgb, #ffffff 20%, transparent),
        inset 0 -1px 0 rgba(0, 0, 0, 0.4),
        0 14px 38px -6px color-mix(in srgb, var(--doc-agent-accent) 55%, transparent),
        0 4px 12px rgba(0, 0, 0, 0.4);
    }
    .launcher:hover::before {
      opacity: 0.9;
    }
    .launcher:active {
      transform: translateY(-1px) scale(1.02);
      box-shadow:
        inset 0 1px 2px rgba(0, 0, 0, 0.3),
        0 6px 20px -6px color-mix(in srgb, var(--doc-agent-accent) 45%, transparent);
    }
    .launcher-dot {
      flex-shrink: 0;
      width: 8px; height: 8px;
      border-radius: 999px;
      background: var(--doc-agent-accent);
      box-shadow:
        0 0 0 2px color-mix(in srgb, var(--doc-agent-accent) 18%, transparent),
        0 0 10px color-mix(in srgb, var(--doc-agent-accent) 70%, transparent);
      animation: launcher-pulse 2400ms ease-in-out infinite;
    }
    @keyframes launcher-pulse {
      0%, 100% {
        box-shadow:
          0 0 0 2px color-mix(in srgb, var(--doc-agent-accent) 18%, transparent),
          0 0 8px color-mix(in srgb, var(--doc-agent-accent) 60%, transparent);
      }
      50% {
        box-shadow:
          0 0 0 3px color-mix(in srgb, var(--doc-agent-accent) 28%, transparent),
          0 0 14px color-mix(in srgb, var(--doc-agent-accent) 90%, transparent);
      }
    }
    .launcher-icon {
      display: inline-flex;
      width: 16px; height: 16px;
      align-items: center; justify-content: center;
      color: color-mix(in srgb, var(--doc-agent-accent) 95%, #f5f5f4);
    }
    .launcher-icon svg {
      width: 16px; height: 16px;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .launcher-label {
      line-height: 1;
      letter-spacing: 0.1em;
      background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--doc-agent-accent) 96%, #ffffff) 0%,
        color-mix(in srgb, var(--doc-agent-accent) 76%, #ffffff) 100%
      );
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    @media (prefers-reduced-motion: reduce) {
      .launcher, .launcher::before, .launcher-dot { transition: none; animation: none; }
    }
    /* Phones: an icon-only glass pill tucked into the corner (clear of the
       home indicator) so it covers as little row chrome as possible. */
    @media (max-width: 640px) {
      .launcher {
        bottom: calc(14px + env(safe-area-inset-bottom, 0px));
        right: calc(14px + env(safe-area-inset-right, 0px));
        width: 44px;
        height: 44px;
        padding: 0;
        gap: 0;
        justify-content: center;
      }
      .launcher-label { display: none; }
      .launcher-dot {
        position: absolute;
        top: 7px;
        right: 7px;
        width: 7px;
        height: 7px;
      }
      .launcher-icon, .launcher-icon svg { width: 18px; height: 18px; }
    }

    .panel {
      pointer-events: auto;
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: min(520px, 92vw);
      max-height: min(85vh, 800px);
      display: flex;
      flex-direction: column;
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--g-primary, #caa45a) 5%, transparent) 0%,
          color-mix(in srgb, var(--g-primary, #caa45a) 2%, transparent) 100%),
        color-mix(in srgb, var(--g-bg, #0a0a0a) 75%, transparent);
      backdrop-filter: blur(28px) saturate(160%);
      -webkit-backdrop-filter: blur(28px) saturate(160%);
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 14%, transparent);
      border-radius: 16px;
      box-shadow:
        inset 0 1px 0 color-mix(in srgb, #ffffff 6%, transparent),
        0 8px 40px rgba(0, 0, 0, 0.5),
        0 0 0 1px rgba(0, 0, 0, 0.3);
      color: var(--c-fg, #f5f5f4);
      animation: slideIn 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
      overflow: hidden;
    }
    .panel::before {
      content: "";
      position: absolute;
      inset: -10%;
      pointer-events: none;
      z-index: 0;
      background:
        radial-gradient(600px 400px at 30% 20%, color-mix(in srgb, var(--g-primary, #caa45a) 4%, transparent) 0%, transparent 70%),
        radial-gradient(500px 300px at 80% 80%, color-mix(in srgb, #f59e0b 4%, transparent) 0%, transparent 70%);
      filter: blur(40px);
      opacity: 0.9;
    }
    .panel > * {
      position: relative;
      z-index: 1;
    }
    @keyframes slideIn {
      from { transform: translateX(40px); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }

    .panel-head {
      display: flex; align-items: center; gap: 10px;
      padding: 14px 16px;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 10%, transparent);
      flex-shrink: 0;
    }
    .panel-head .eyebrow {
      font-size: 10px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.5);
    }
    .panel-head .doc-title {
      font-size: 13px; font-weight: 700;
      color: var(--c-fg, #f5f5f4);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .panel-head .grow { flex: 1; min-width: 0; }
    .icon-btn {
      appearance: none; font: inherit; cursor: pointer;
      width: 30px; height: 30px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 8px;
      background: color-mix(in srgb, #ffffff 4%, transparent);
      color: rgba(255,255,255,0.65);
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 12%, transparent);
      transition: all 160ms ease;
    }
    .icon-btn:hover { color: var(--g-primary, #caa45a); border-color: color-mix(in srgb, var(--g-primary, #caa45a) 40%, transparent); background: color-mix(in srgb, #ffffff 8%, transparent); }
    .icon-btn.is-on {
      color: #0a0a0a;
      background: color-mix(in srgb, var(--g-primary, #caa45a) 70%, #f59e0b);
      border-color: var(--g-primary, #caa45a);
      box-shadow: 0 0 8px color-mix(in srgb, var(--g-primary, #caa45a) 50%, transparent);
    }

    .observed {
      border-top: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 8%, transparent);
      padding: 6px 16px;
      display: flex; flex-direction: column; gap: 2px;
      font-size: 10.5px;
      color: rgba(255,255,255,0.5);
      max-height: 90px;
      overflow-y: auto;
      flex-shrink: 0;
    }
    .observed-row { display: flex; gap: 8px; align-items: baseline; }
    .observed-kind {
      flex-shrink: 0;
      color: var(--g-primary, #caa45a);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 9px;
    }
    .observed-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .instructions {
      padding: 10px 16px;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 8%, transparent);
      font-size: 11px;
      color: rgba(255,255,255,0.55);
      background: color-mix(in srgb, var(--g-primary, #caa45a) 4%, transparent);
      flex-shrink: 0;
    }
    .instructions textarea {
      width: 100%;
      box-sizing: border-box;
      min-height: 80px;
      max-height: 220px;
      resize: vertical;
      font: inherit;
      font-size: 11px;
      line-height: 1.5;
      padding: 8px 10px;
      border-radius: 8px;
      background: rgba(0,0,0,0.3);
      color: rgba(255,255,255,0.85);
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 18%, transparent);
    }

    .messages {
      flex: 1; min-height: 0;
      overflow-y: auto;
      padding: 12px 16px;
      display: flex; flex-direction: column; gap: 12px;
    }
    .messages::-webkit-scrollbar {
      width: 4px;
    }
    .messages::-webkit-scrollbar-track {
      background: transparent;
    }
    .messages::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--g-primary, #caa45a) 20%, transparent);
      border-radius: 4px;
    }

    .msg {
      max-width: 92%;
      padding: 10px 14px;
      border-radius: 12px;
      font-size: 12.5px;
      line-height: 1.55;
      word-wrap: break-word;
    }
    .msg-fade-in {
      animation: msg-fade-in 220ms ease-out both;
    }
    @keyframes msg-fade-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .msg-user {
      align-self: flex-end;
      background: linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary, #caa45a) 22%, transparent),
        color-mix(in srgb, var(--g-primary, #caa45a) 12%, transparent));
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 28%, transparent);
      color: var(--c-fg, #f5f5f4);
    }
    .msg-assistant {
      align-self: flex-start;
      background: color-mix(in srgb, #ffffff 4%, transparent);
      border: 1px solid color-mix(in srgb, #ffffff 6%, transparent);
      color: var(--c-fg, #f5f5f4);
    }
    .msg-assistant p { margin: 0 0 8px; }
    .msg-assistant p:last-child { margin-bottom: 0; }
    .msg-assistant ul, .msg-assistant ol { margin: 4px 0; padding-left: 20px; }
    .msg-assistant li { margin-bottom: 2px; }
    .msg-assistant code {
      background: color-mix(in srgb, #000 30%, transparent);
      border-radius: 4px;
      padding: 1px 5px;
      font-size: 11.5px;
      font-family: "JetBrains Mono", "Fira Code", monospace;
    }
    .msg-assistant pre {
      background: color-mix(in srgb, #000 40%, transparent);
      border-radius: 8px;
      padding: 10px 12px;
      overflow-x: auto;
      margin: 8px 0;
      border: 1px solid color-mix(in srgb, #ffffff 6%, transparent);
    }
    .msg-assistant pre code {
      background: none;
      padding: 0;
      font-size: 11px;
      line-height: 1.45;
    }
    .msg-assistant strong { color: var(--c-fg, #f5f5f4); }
    .msg-assistant blockquote {
      border-left: 2px solid var(--doc-agent-accent);
      margin: 8px 0;
      padding: 4px 12px;
      color: rgba(255,255,255,0.7);
    }
    .msg-system {
      align-self: stretch;
      font-size: 11px;
      color: rgba(255,255,255,0.5);
      font-style: italic;
      background: transparent;
      border: none;
      padding: 4px 0;
    }

    .msg.streaming-bubble {
      align-self: flex-start;
      background: color-mix(in srgb, var(--g-primary, #caa45a) 6%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 16%, transparent);
      max-width: 92%;
    }
    .streaming-cursor {
      display: inline-block;
      color: var(--doc-agent-accent);
      animation: cursor-blink 1s step-end infinite;
      margin-left: 2px;
      font-weight: bold;
    }
    @keyframes cursor-blink {
      0%, 50% { opacity: 1; }
      51%, 100% { opacity: 0; }
    }

    .typing-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 0;
    }
    .typing-indicator__dot {
      width: 10px;
      height: 10px;
      background: var(--doc-agent-accent);
      border-radius: 50%;
      animation: typing-bounce 1.2s ease-in-out infinite;
      box-shadow: 0 0 6px color-mix(in srgb, var(--doc-agent-accent) 50%, transparent);
    }
    .typing-indicator__dot:nth-child(2) { animation-delay: 0.15s; }
    .typing-indicator__dot:nth-child(3) { animation-delay: 0.3s; }
    @keyframes typing-bounce {
      0%, 70%, 100% { transform: translateY(0); opacity: 0.5; }
      35% { transform: translateY(-8px); opacity: 1; }
    }
    .typing-indicator__text {
      margin-left: 8px;
      font-size: 12px;
      color: color-mix(in srgb, var(--doc-agent-accent) 75%, transparent);
      font-style: italic;
    }

    .tool-pulse {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      margin: 4px 0 8px;
      border-radius: 8px;
      background: color-mix(in srgb, var(--doc-agent-accent) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--doc-agent-accent) 12%, transparent);
      font-size: 11px;
      color: color-mix(in srgb, var(--doc-agent-accent) 80%, transparent);
      animation: tool-pulse-glow 1800ms ease-in-out infinite;
    }
    @keyframes tool-pulse-glow {
      0%, 100% { border-color: color-mix(in srgb, var(--doc-agent-accent) 12%, transparent); }
      50% { border-color: color-mix(in srgb, var(--doc-agent-accent) 35%, transparent); box-shadow: 0 0 12px color-mix(in srgb, var(--doc-agent-accent) 15%, transparent); }
    }
    .tool-pulse__icon {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--doc-agent-accent);
      animation: tool-pulse-dot 1400ms ease-in-out infinite;
    }
    @keyframes tool-pulse-dot {
      0%, 100% { opacity: 0.4; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.4); }
    }

    .err {
      padding: 8px 12px;
      margin: 0 16px 8px;
      border-radius: 8px;
      font-size: 11px;
      color: #f87171;
      background: color-mix(in srgb, #ef4444 10%, transparent);
      border: 1px solid color-mix(in srgb, #ef4444 28%, transparent);
      flex-shrink: 0;
    }

    .composer {
      padding: 10px 16px;
      border-top: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 10%, transparent);
      display: flex; gap: 8px;
      flex-shrink: 0;
    }
    .composer textarea {
      flex: 1;
      box-sizing: border-box;
      min-height: 40px;
      max-height: 120px;
      resize: vertical;
      font: inherit;
      font-size: 12.5px;
      line-height: 1.4;
      padding: 8px 10px;
      border-radius: 10px;
      background: color-mix(in srgb, #ffffff 4%, transparent);
      color: var(--c-fg, #f5f5f4);
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 14%, transparent);
      transition: border-color 160ms ease;
    }
    .composer textarea:focus {
      outline: none;
      border-color: color-mix(in srgb, var(--g-primary, #caa45a) 35%, transparent);
    }
    .composer .send {
      padding: 8px 16px;
      border-radius: 10px;
      font: inherit;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      cursor: pointer;
      background: linear-gradient(135deg, var(--g-primary, #caa45a), color-mix(in srgb, var(--g-primary, #caa45a) 70%, #6366f1));
      color: #0a0a0a;
      border: none;
      transition: opacity 160ms ease, transform 160ms ease;
    }
    .composer .send:disabled { opacity: 0.4; cursor: not-allowed; }
    .composer .send:not(:disabled):active { transform: scale(0.96); }

    .meta-row {
      display: flex; gap: 8px; align-items: center;
      padding: 6px 16px;
      font-size: 10px;
      color: rgba(255,255,255,0.35);
      flex-shrink: 0;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 6%, transparent);
    }
    .meta-row strong { color: rgba(255,255,255,0.55); font-weight: 600; }

    .empty {
      text-align: center;
      color: rgba(255,255,255,0.35);
      font-size: 12px;
      padding: 32px 16px;
      line-height: 1.6;
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("infinibot:doc-agent-event", this._onLiveActionEvent);
    if (this.startOpen) {
      this._open = true;
      void this._initSession();
    }
  }

  override disconnectedCallback(): void {
    window.removeEventListener("infinibot:doc-agent-event", this._onLiveActionEvent);
    this._unsubscribeEvents();
    if (this._liveActionEnabled && this._sessionKey && this.client) {
      this.client
        .request("doc_agent.detach_live_action", { sessionKey: this._sessionKey })
        .catch(() => {});
    }
    super.disconnectedCallback();
  }

  private _subscribeEvents() {
    if (!this.client || this._eventUnsubscribe) return;
    const handler = (evt: { event: string; payload?: unknown }) => {
      if (evt.event === "chat") {
        this._handleChatEvent(evt.payload as Record<string, unknown> | undefined);
      }
    };
    if (typeof this.client.subscribe === "function") {
      this._eventUnsubscribe = this.client.subscribe(handler);
    }
  }

  private _unsubscribeEvents() {
    if (this._eventUnsubscribe) {
      this._eventUnsubscribe();
      this._eventUnsubscribe = null;
    }
  }

  private _handleChatEvent(payload?: Record<string, unknown>) {
    if (!payload) return;
    if (payload.sessionKey !== this._sessionKey) return;

    const state = payload.state as string | undefined;

    if (state === "delta") {
      const content = extractText(payload.message);
      if (content) {
        if (!this._streamingContent || content.length >= this._streamingContent.length) {
          this._streamingContent = content;
          this._scrollToBottom();
        }
      }
    } else if (state === "final") {
      this._streamingContent = null;
      this._sending = false;
      void this._loadHistory();
    } else if (state === "aborted") {
      this._streamingContent = null;
      this._sending = false;
    } else if (state === "error") {
      this._streamingContent = null;
      this._sending = false;
      this._err = (payload.errorMessage as string) || "Agent error";
    }
  }

  private _scrollToBottom() {
    const container = this.renderRoot?.querySelector(".messages");
    if (container) {
      queueMicrotask(() => {
        container.scrollTop = container.scrollHeight;
      });
    }
  }

  private async _initSession() {
    if (this._sessionKey || this._spawning) return;
    if (!this.client) {
      this._err = "Gateway client not available.";
      return;
    }
    if (!this.documentId) {
      this._err = "documentId required";
      return;
    }
    this._spawning = true;
    this._err = null;
    this._subscribeEvents();
    try {
      const resp = (await this.client.request("doc_agent.spawn", {
        docType: this.docType,
        documentId: this.documentId,
        title: this.title,
        content: this.content,
        databaseId: this.databaseId,
        schema: this.schema,
        extra: this.extra,
      })) as SpawnResponse;
      this._sessionKey = resp.sessionKey;
      this._systemPrompt = resp.systemPrompt;
      this._model = resp.model;
      if (resp.capabilities) {
        this._capabilities = resp.capabilities;
      }
      this.client
        .request("doc_agent.set_modalities", {
          sessionKey: this._sessionKey,
          docType: this.docType,
          modalities: {
            sidePanel: true,
            voice: false,
            liveActionObserve: false,
            liveActionAct: false,
          },
        })
        .catch(() => {});
      await this._loadHistory();
    } catch (err) {
      this._err = (err as Error).message ?? String(err);
    } finally {
      this._spawning = false;
    }
  }

  private async _loadHistory() {
    if (!this._sessionKey || !this.client) return;
    try {
      const hist = (await this.client.request("chat.history", {
        sessionKey: this._sessionKey,
        limit: 100,
      })) as { messages?: Array<Record<string, unknown>> };
      const msgs = Array.isArray(hist?.messages) ? hist.messages : [];
      this._messages = msgs
        .map((m) => ({
          role: (m.role as ChatMessageItem["role"]) ?? "assistant",
          text: typeof m.text === "string" ? m.text : typeof m.content === "string" ? (m.content as string) : "",
          ts: typeof m.ts === "number" ? (m.ts as number) : Date.now(),
        }))
        .filter((m) => m.text.length > 0);
    } catch {
      /* fresh session */
    }
  }

  private async _send() {
    const text = this._draft.trim();
    if (!text) return;
    if (!this._sessionKey || !this.client) {
      this._err = "Session not ready.";
      return;
    }
    this._sending = true;
    this._err = null;
    this._streamingContent = null;
    const now = Date.now();
    this._messages = [...this._messages, { role: "user", text, ts: now }];
    this._draft = "";
    this._scrollToBottom();
    try {
      const isFirst = this._messages.filter((m) => m.role === "user").length === 1;
      const composedText = isFirst
        ? `[INSTRUCTIONS — read once, then respond to my message]\n\n${this._systemPrompt}\n\n---\n\nMy message: ${text}`
        : text;
      await this.client.request("session.send", {
        sessionKey: this._sessionKey,
        message: composedText,
      });
    } catch (err) {
      this._sending = false;
      this._streamingContent = null;
      this._err = (err as Error).message ?? String(err);
    }
  }

  private _onComposerKey(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void this._send();
    }
  }

  private async _toggleVoice() {
    if (!this._sessionKey || !this.client) return;
    if (!this._capabilities.voice) return;
    const next = !this._voiceEnabled;
    this._voiceEnabled = next;
    try {
      await this.client.request("doc_agent.set_modalities", {
        sessionKey: this._sessionKey,
        docType: this.docType,
        modalities: {
          sidePanel: true,
          voice: next,
          liveActionObserve: this._liveActionEnabled,
          liveActionAct: false,
        },
      });
    } catch (err) {
      this._voiceEnabled = !next;
      this._err = (err as Error).message ?? String(err);
      return;
    }
    window.dispatchEvent(
      new CustomEvent("infinibot:doc-agent-voice", {
        detail: {
          sessionKey: this._sessionKey,
          docType: this.docType,
          documentId: this.documentId,
          title: this.title,
          enabled: next,
        },
      }),
    );
  }

  private async _toggleLiveAction() {
    if (!this._sessionKey || !this.client) return;
    if (!this._capabilities.liveActionObserve) return;
    const next = !this._liveActionEnabled;
    try {
      if (next) {
        await this.client.request("doc_agent.attach_live_action", {
          sessionKey: this._sessionKey,
          docType: this.docType,
          documentId: this.documentId,
          title: this.title || undefined,
        });
      } else {
        await this.client.request("doc_agent.detach_live_action", {
          sessionKey: this._sessionKey,
        });
        this._observed = [];
      }
      await this.client.request("doc_agent.set_modalities", {
        sessionKey: this._sessionKey,
        docType: this.docType,
        modalities: {
          sidePanel: true,
          voice: this._voiceEnabled,
          liveActionObserve: next,
          liveActionAct: false,
        },
      });
      this._liveActionEnabled = next;
    } catch (err) {
      this._err = (err as Error).message ?? String(err);
    }
  }

  override render() {
    if (!this._open) {
      return html`
        <button
          class="launcher"
          @click=${() => {
            this._open = true;
            void this._initSession();
          }}
          title="Open the document agent for ${this.title || this.documentId}"
          aria-label="Open the document agent for ${this.title || this.documentId}"
        >
          <span class="launcher-dot" aria-hidden="true"></span>
          <span class="launcher-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 3v3" />
              <path d="M12 18v3" />
              <path d="M5.6 5.6l2.1 2.1" />
              <path d="M16.3 16.3l2.1 2.1" />
              <path d="M3 12h3" />
              <path d="M18 12h3" />
              <path d="M5.6 18.4l2.1-2.1" />
              <path d="M16.3 7.7l2.1-2.1" />
              <circle cx="12" cy="12" r="3.4" />
            </svg>
          </span>
          <span class="launcher-label">Agent</span>
        </button>
      `;
    }

    const isStreaming = this._sending || Boolean(this._streamingContent);

    return html`
      <div class="panel">
        <div class="panel-head">
          <div class="grow">
            <div class="eyebrow">Document Agent · ${this.docType.replace("_", " ")}</div>
            <div class="doc-title">${this.title || this.documentId}</div>
          </div>
          ${this._capabilities.voice
            ? html`
                <agent-cli-selector
                  surfaceId="doc-agent:${this.docType}"
                  .client=${this.client as any}
                  .value=${this._voiceCliSelection}
                  compact
                  @change=${(e: CustomEvent<SelectorValue>) => {
                    this._voiceCliSelection = e.detail;
                    window.dispatchEvent(
                      new CustomEvent("infinibot:doc-agent-voice-cli", {
                        detail: {
                          sessionKey: this._sessionKey,
                          docType: this.docType,
                          documentId: this.documentId,
                          selection: e.detail,
                        },
                      }),
                    );
                  }}
                ></agent-cli-selector>
                <button
                  class="icon-btn ${this._voiceEnabled ? "is-on" : ""}"
                  title="${this._voiceEnabled ? "Disable" : "Enable"} voice for this document"
                  @click=${() => void this._toggleVoice()}
                >🎙</button>
              `
            : nothing}
          ${this._capabilities.liveActionObserve
            ? html`
                <button
                  class="icon-btn ${this._liveActionEnabled ? "is-on" : ""}"
                  title="${this._liveActionEnabled ? "Stop" : "Start"} live action observation"
                  @click=${() => void this._toggleLiveAction()}
                >◉</button>
              `
            : nothing}
          <button
            class="icon-btn"
            title="${this._showInstructions ? "Hide" : "Show"} agent instructions"
            @click=${() => (this._showInstructions = !this._showInstructions)}
          >ⓘ</button>
          <button class="icon-btn" title="Close" @click=${() => (this._open = false)}>×</button>
        </div>

        ${this._showInstructions
          ? html`
              <div class="instructions">
                <div style="margin-bottom:6px;">Agent is told the following:</div>
                <textarea
                  .value=${this._systemPrompt}
                  @input=${(e: Event) => (this._systemPrompt = (e.target as HTMLTextAreaElement).value)}
                ></textarea>
              </div>
            `
          : nothing}

        <div class="meta-row">
          <span><strong>model:</strong> ${this._model || "(default)"}</span>
          <span>·</span>
          <span><strong>session:</strong> ${this._sessionKey ? this._sessionKey.split(":").slice(-1)[0] : "—"}</span>
        </div>

        ${this._err ? html`<div class="err">${this._err}</div>` : nothing}

        <div class="messages">
          ${this._messages.length === 0 && !isStreaming
            ? html`
                <div class="empty">
                  ${this._spawning
                    ? "Spawning agent…"
                    : html`Ask the agent to draft, edit, plan, or summarize this <strong>${this.docType}</strong>. The agent has read-only context of the current content and can update it via tools.`}
                </div>
              `
            : html`
                ${this._messages.map(
                  (m) => html`
                    <div class="msg msg-${m.role} msg-fade-in">
                      ${m.role === "assistant"
                        ? unsafeHTML(marked.parse(m.text, { gfm: true, breaks: true }) as string)
                        : m.text}
                    </div>
                  `,
                )}
                ${isStreaming
                  ? html`
                      ${this._streamingContent
                        ? html`
                            <div class="msg streaming-bubble msg-fade-in">
                              ${unsafeHTML(marked.parse(this._streamingContent, { gfm: true, breaks: true }) as string)}
                              <span class="streaming-cursor">▊</span>
                            </div>
                          `
                        : html`
                            <div class="msg streaming-bubble msg-fade-in">
                              <thinking-indicator
                                .startedAt=${Date.now()}
                                ?streaming=${false}
                                ?extended=${false}
                                gpuMode="high"
                              ></thinking-indicator>
                            </div>
                          `}
                    `
                  : nothing}
              `}
        </div>

        ${this._liveActionEnabled && this._observed.length > 0
          ? html`
              <div class="observed" aria-live="polite">
                ${this._observed.map(
                  (ev) => html`
                    <div class="observed-row">
                      <span class="observed-kind">${ev.kind}</span>
                      <span class="observed-summary">${ev.summary}</span>
                    </div>
                  `,
                )}
              </div>
            `
          : nothing}

        <div class="composer">
          <textarea
            placeholder="Ask the agent — ⌘/Ctrl+Enter to send"
            .value=${this._draft}
            ?disabled=${this._sending || this._spawning}
            @input=${(e: Event) => (this._draft = (e.target as HTMLTextAreaElement).value)}
            @keydown=${this._onComposerKey}
          ></textarea>
          <button class="send" ?disabled=${this._sending || this._spawning || !this._draft.trim()} @click=${this._send}>
            ${this._sending ? "…" : "Send"}
          </button>
        </div>
      </div>
    `;
  }
}
