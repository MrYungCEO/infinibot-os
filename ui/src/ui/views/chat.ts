import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../i18n";
import type { SessionsListResult } from "../types";
import type { ChatAttachment, ChatQueueItem } from "../ui-types";
import type { ChatItem, MessageGroup } from "../types/chat-types";
import { icons } from "../icons";
import { isSecureModeActive, isSecureSessionKey } from "../secure-mode";
import {
  normalizeMessage,
  normalizeRoleForGrouping,
} from "../chat/message-normalizer";
import {
  renderMessageGroup,
  renderReadingIndicatorGroup,
  renderStreamingGroup,
  renderGroupedMessage,
  renderAvatar,
} from "../chat/grouped-render";
import { renderMarkdownSidebar } from "./markdown-sidebar";
import { 
  renderChatSessionHeader, 
  renderChatSessionInfo, 
  renderSessionTabBar,
  renderSessionContextBar,
  loadSessionContext,
  saveSessionContext,
  type SessionContextSettings,
  type SessionContextProject,
} from "./chat-sessions";
import "../components/resizable-divider";
import "../components/thinking-indicator";
import "../components/slash-command-preview";
import "../components/ai-ide-panel";
import "../components/video-feed-hud";
import "../components/subagent-activity-panel";
import { VisionSettings, VISION_BACKENDS } from "../controllers/vision";
import { extractToolExecutions, extractFileOperations } from "../controllers/ai-ide";
import type { ToolExecution, FileOperation } from "../components/ai-ide-panel";
import type { GatewayBrowserClient } from "../gateway";
import {
  CHAT_ATTACHMENT_ACCEPT,
  isSupportedChatFile,
  normalizedFileMime,
  prepareChatAttachment,
  type AttachmentPreparationProgress,
} from "../chat/attachments";
import "../components/chat-attachment-chip";

export type CompactionIndicatorStatus = {
  active: boolean;
  startedAt: number | null;
  completedAt: number | null;
};

export type ChatProps = {
  sessionKey: string;
  /** Session key whose history is currently in `messages`. When this !== sessionKey we treat the thread as mid-switch and suppress the empty-state card. */
  loadedSessionKey?: string | null;
  onSessionKeyChange: (next: string) => void;
  /** Secure Mode composer switch (lane = session key). Omitted → no switch. */
  onSecureToggle?: (on: boolean) => void;
  secureBusy?: boolean;
  secureError?: string | null;
  thinkingLevel: string | null;
  showThinking: boolean;
  loading: boolean;
  sending: boolean;
  canAbort?: boolean;
  compactionStatus?: CompactionIndicatorStatus | null;
  messages: unknown[];
  toolMessages: unknown[];
  stream: string | null;
  streamStartedAt: number | null;
  /** When the AI started "thinking" (before streaming begins) */
  thinkingStartedAt?: number | null;
  assistantAvatarUrl?: string | null;
  draft: string;
  queue: ChatQueueItem[];
  connected: boolean;
  canSend: boolean;
  disabledReason: string | null;
  error: string | null;
  sessions: SessionsListResult | null;
  // Focus mode
  focusMode: boolean;
  // Sidebar state
  sidebarOpen?: boolean;
  sidebarContent?: string | null;
  sidebarError?: string | null;
  splitRatio?: number;
  assistantName: string;
  assistantAvatar: string | null;
  // Document / image / video attachments
  attachments?: ChatAttachment[];
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  // Event handlers
  onRefresh: () => void;
  onToggleFocusMode: () => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  onAbort?: () => void;
  onQueueRemove: (id: string) => void;
  onNewSession: () => void;
  onCreateMultipleSessions?: (count: number) => void;
  onOpenSidebar?: (content: string) => void;
  onCloseSidebar?: () => void;
  onSplitRatioChange?: (ratio: number) => void;
  onChatScroll?: (event: Event) => void;
  onMcpSetup: () => void;
  onToggleThreadsSidebar?: () => void;
  onSessionRename?: (key: string, newLabel: string) => void;
  onRequestUpdate?: () => void;
  // Vision
  visionEnabled?: boolean;
  visionSettings?: VisionSettings | null;
  visionAnalyzing?: boolean;
  onToggleVision?: () => void;
  onVisionCapture?: () => void;
  onVisionSettingsOpen?: () => void;
  // AI IDE Panel
  aiIdeEnabled?: boolean;
  aiIdeCollapsed?: boolean;
  onAiIdeToggle?: () => void;
  onAiIdeCollapsedChange?: (collapsed: boolean) => void;
  // Video Mode
  videoModeEnabled?: boolean;
  onToggleVideoMode?: () => void;
  onVideoFrame?: (base64: string, mimeType: string) => void;
  // Gateway for subagent monitoring
  gateway?: GatewayBrowserClient | null;
  // Model selector
  availableModels?: Array<{ id: string; name: string; provider?: string }>;
  onModelChange?: (sessionKey: string, modelId: string) => Promise<void>;
  // Session management
  onCloseSession?: (key: string) => Promise<void>;
  // Session context (directory & project)
  sessionContext?: SessionContextSettings;
  sessionProjects?: SessionContextProject[];
  sessionProjectsLoading?: boolean;
  onSessionContextChange?: (ctx: SessionContextSettings) => void;
  onBrowseDirectory?: () => void;
};

// ============================================================
// Speech-to-Text — <chat-mic-button> Custom Element
// ============================================================
// Talk to the chat composer. Local voice (the default) transcribes through
// this gateway; with cloud voice chosen, each transcription is one free
// robovoice.speech.stt request. It reuses the chat sidebar's
// ChatSpeechController (components/chat-speech.ts), so the gating is the same:
//   - cloud voice, plugin off / not linked → "Connect Robovoice"
//   - cloud voice busy                     → "Cloud voice is busy — switch to local voice" (one click)
//   - otherwise                            → click to toggle, hold to push-to-talk
// An optional per-panel wake word (on-device spotter, controllers/wake-word.ts)
// starts a recording.
// ============================================================

import { LitElement, css } from "lit";
import { customElement, state as litState, property } from "lit/decorators.js";
import {
  registerPanelWakeWord,
  updatePanelWakeWord,
  panelStartedRecording,
  panelStoppedRecording,
  isWakeListening,
  isWakeFailed,
  resetWakeErrors,
  initWakeWord,
  startWakeListener,
  setWakeWordOptIn,
} from "../controllers/wake-word";
import { ChatSpeechController, chatSpeechStyles, TALK_TARGET_ID } from "../components/chat-speech";
import "../components/chat-call-button";
import { WALLET_EMPTY_TEXT } from "../components/chat-speech-state";
import { getGatewayClient } from "../gateway-client";

// Per-panel wake-word settings (the talk prefs themselves are shared with the chat sidebar)
function getSettingsKey(panelId: string): string {
  return panelId ? `infinibot-stt-settings-${panelId}` : 'infinibot-stt-settings';
}

interface MicWakeSettings {
  wakeWordEnabled: boolean;
  wakeWord: string;
  silenceTimeoutMs: number;
}

function loadMicWakeSettings(panelId: string): MicWakeSettings {
  const def: MicWakeSettings = { wakeWordEnabled: false, wakeWord: 'hey_jarvis', silenceTimeoutMs: 3000 };
  try {
    const raw = JSON.parse(localStorage.getItem(getSettingsKey(panelId)) ?? 'null') as Partial<MicWakeSettings> | null;
    if (raw && typeof raw === 'object') {
      return {
        wakeWordEnabled: raw.wakeWordEnabled === true,
        wakeWord: typeof raw.wakeWord === 'string' && raw.wakeWord ? raw.wakeWord : def.wakeWord,
        silenceTimeoutMs: typeof raw.silenceTimeoutMs === 'number' ? raw.silenceTimeoutMs : def.silenceTimeoutMs,
      };
    }
  } catch {}
  return def;
}

function saveMicWakeSettings(panelId: string, s: MicWakeSettings) {
  try { localStorage.setItem(getSettingsKey(panelId), JSON.stringify(s)); } catch {}
}

let instanceCounter = 0;

@customElement("chat-mic-button")
class ChatMicButton extends LitElement {
  @property({ type: Boolean }) disabled = false;
  @property({ type: String }) panelId = ''; // Unique panel identifier for per-panel wake words
  @property({ attribute: false }) gateway: GatewayBrowserClient | null = null;

  @litState() private wakeListening = false;
  @litState() private wakeFailed = false;
  @litState() private wakeDetected = false;
  @litState() private wakeOpen = false;
  @litState() private wakeWordEnabled = false;
  @litState() private wakeWord = 'hey_jarvis';
  @litState() private silenceTimeoutMs = 3000;

  private readonly speech = new ChatSpeechController(this);
  private instanceId = '';
  private unsubWake: (() => void) | null = null;
  private wakeCheckInterval: number | null = null;
  private wakeStopTimer: number | null = null;
  private wakeRecording = false;
  private lastTalk = this.speech.talk;

  /** ChatSpeechController host contract. */
  get client(): GatewayBrowserClient | null {
    return this.gateway ?? getGatewayClient();
  }

  /** ChatSpeechController host contract: transcript → composer (stt-* events). */
  applyTranscript(text: string, autoSend: boolean): void {
    const currentDraft = this.closest('.chat-compose')?.querySelector('textarea')?.value || '';
    const spacer = currentDraft && !currentDraft.endsWith(' ') ? ' ' : '';
    const full = currentDraft + spacer + text;
    this.dispatchEvent(new CustomEvent('stt-transcript', { bubbles: true, composed: true, detail: { text: full, isFinal: true } }));
    if (autoSend && full.trim()) {
      this.dispatchEvent(new CustomEvent('stt-send', { bubbles: true, composed: true }));
    }
  }

  static styles = [
    chatSpeechStyles,
    css`
      :host { display: inline-flex; position: relative; }
      .mic { display: inline-flex; align-items: center; gap: 4px; position: relative; }
      .talk { width: 32px; height: 32px; }
      .mic-chip {
        display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
        padding: 5px 9px; border-radius: 999px; font: inherit; font-size: 11.5px; cursor: pointer;
        background: transparent; color: var(--c-text-muted, #a1a1aa);
        border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 30%, transparent);
      }
      .mic-chip:hover { color: var(--g-primary, #fbbf24); }
      .mic-chip.err { border-color: rgba(239, 68, 68, 0.45); color: #fca5a5; }
      .mic-chip svg { width: 13px; height: 13px; }
      .gear {
        width: 26px; height: 26px; display: grid; place-items: center; padding: 0; cursor: pointer;
        border-radius: 8px; border: 1px solid transparent; background: transparent; color: var(--c-text-muted, #a1a1aa);
      }
      .gear:hover, .gear.active { color: var(--g-primary, #fbbf24); border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 25%, transparent); }
      .gear svg { width: 14px; height: 14px; }
      .wake-badge { font-size: 10px; letter-spacing: 0.04em; color: var(--g-primary, #fbbf24); white-space: nowrap; }
      .wake-badge.failed { color: #ef4444; }
      .wake-badge.flash { text-shadow: 0 0 10px var(--g-primary, #fbbf24); }
      .float {
        position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 30;
        width: min(320px, 86vw);
      }
      .float .sp-pop { position: static; }
      .float .talk-status { border-radius: 10px; background: rgba(12, 11, 16, 0.97); }
      .wake { display: grid; gap: 6px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08); font-size: 11.5px; }
      .wake input[type="text"], .wake input[type="number"] {
        background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); border-radius: 6px;
        padding: 5px 7px; color: inherit; font: inherit; width: 100%; box-sizing: border-box;
      }
      .wake label { display: flex; align-items: center; gap: 6px; }
      .wake small { color: var(--c-text-muted, #a1a1aa); }
    `,
  ];

  connectedCallback() {
    super.connectedCallback();
    this.instanceId = this.panelId || `stt-${++instanceCounter}-${Date.now().toString(36)}`;
    const s = loadMicWakeSettings(this.instanceId);
    this.wakeWordEnabled = s.wakeWordEnabled;
    this.wakeWord = s.wakeWord;
    this.silenceTimeoutMs = s.silenceTimeoutMs;
    initWakeWord();
    this.registerWakeWord();
    this.wakeCheckInterval = window.setInterval(() => {
      const listening = isWakeListening() && this.wakeWordEnabled;
      const failed = isWakeFailed() && this.wakeWordEnabled;
      if (listening !== this.wakeListening) this.wakeListening = listening;
      if (failed !== this.wakeFailed) this.wakeFailed = failed;
    }, 500);
    void this.speech.refresh();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.speech.cancelRecording();
    this.unsubWake?.();
    this.unsubWake = null;
    if (this.wakeCheckInterval) clearInterval(this.wakeCheckInterval);
    this.wakeCheckInterval = null;
    this.clearWakeStop();
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('gateway') && this.gateway) void this.speech.refresh();
    // Give the mic back to the wake listener once a wake-started recording ends.
    const talk = this.speech.talk;
    if (talk !== this.lastTalk) {
      if (this.lastTalk === 'recording' && talk !== 'recording') this.clearWakeStop();
      if (this.wakeRecording && talk !== 'recording' && talk !== 'processing') {
        this.wakeRecording = false;
        panelStoppedRecording(this.instanceId);
      }
      this.lastTalk = talk;
    }
  }

  private clearWakeStop() {
    if (this.wakeStopTimer !== null) clearTimeout(this.wakeStopTimer);
    this.wakeStopTimer = null;
  }

  private registerWakeWord() {
    this.unsubWake?.();
    this.unsubWake = registerPanelWakeWord({
      panelId: this.instanceId,
      enabled: this.wakeWordEnabled,
      wakeWord: this.wakeWord,
      callback: async () => {
        if (this.speech.talkBlockedReason || this.speech.talk === 'recording' || this.speech.talk === 'processing') return;
        this.wakeDetected = true;
        setTimeout(() => { this.wakeDetected = false; }, 600);
        // Free the mic from the wake listener, then record through Robovoice.
        await panelStartedRecording(this.instanceId);
        this.wakeRecording = true;
        await this.speech.startTalk();
        if ((this.speech.talk as string) !== 'recording') {
          this.wakeRecording = false;
          panelStoppedRecording(this.instanceId);
          return;
        }
        // Wake-started recordings stop on their own (click still stops earlier).
        const cap = Math.max(15000, this.silenceTimeoutMs * 3);
        this.clearWakeStop();
        this.wakeStopTimer = window.setTimeout(() => this.speech.stopRecording(), cap);
      },
    });
    this.wakeListening = isWakeListening() && this.wakeWordEnabled;
  }

  private persistWake() {
    saveMicWakeSettings(this.instanceId, {
      wakeWordEnabled: this.wakeWordEnabled,
      wakeWord: this.wakeWord,
      silenceTimeoutMs: this.silenceTimeoutMs,
    });
    updatePanelWakeWord(this.instanceId, { enabled: this.wakeWordEnabled, wakeWord: this.wakeWord });
    this.wakeListening = isWakeListening() && this.wakeWordEnabled;
  }

  private setWakeWordEnabled(enabled: boolean) {
    // Enabling wake word here is the user's explicit mic opt-in.
    if (enabled) setWakeWordOptIn(true);
    this.wakeWordEnabled = enabled;
    this.persistWake();
  }

  private retryWakeWord() {
    resetWakeErrors();
    startWakeListener();
    this.wakeFailed = false;
    this.wakeListening = isWakeListening() && this.wakeWordEnabled;
  }

  private toggleSettings() {
    if (this.speech.settingsVisible) {
      this.speech.closeSettings();
      this.wakeOpen = false;
    } else {
      this.speech.openSettings();
      this.wakeOpen = true;
    }
  }

  private renderWakeSettings() {
    return html`<div class="wake">
      <label>
        <input type="checkbox" .checked=${this.wakeWordEnabled}
          @change=${(e: Event) => this.setWakeWordEnabled((e.target as HTMLInputElement).checked)} />
        Wake word starts a recording${this.panelId ? ' (this panel)' : ''}
      </label>
      ${this.wakeWordEnabled ? html`
        <input type="text" placeholder="hey infini" aria-label="Wake word or phrase" .value=${this.wakeWord}
          @change=${(e: Event) => {
            const v = (e.target as HTMLInputElement).value.toLowerCase().trim();
            if (v) { this.wakeWord = v; this.persistWake(); }
          }} />
        <small>
          ${this.wakeFailed
            ? html`On-device recognizer unavailable. <button class="sp-link" @click=${() => this.retryWakeWord()}>Retry</button>`
            : this.wakeListening ? `Listening on-device for "${this.wakeWord}".` : 'Wake listener inactive.'}
          Recording stops after ${Math.round(Math.max(15000, this.silenceTimeoutMs * 3) / 1000)}s or on click.
        </small>
      ` : nothing}
    </div>`;
  }

  render() {
    const g = this.speech.gate;
    const micSvg = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="23"/></svg>`;

    if (g.kind === 'hidden') {
      return html`<span class="mic" data-speech-state="loading"><button class="talk" disabled title="Checking Robovoice…" aria-label="Talk">${micSvg}</button></span>`;
    }
    if (g.kind === 'connect') {
      return html`<span class="mic" data-speech-state="connect">
        <button class="mic-chip" title="Talk needs Robovoice — link this install to your Robovoice org"
          data-ib-target=${TALK_TARGET_ID} @click=${() => this.speech.goConnect()}>${micSvg}Connect Robovoice</button>
      </span>`;
    }
    if (g.kind === 'error') {
      return html`<span class="mic" data-speech-state="error">
        <button class="mic-chip err" title=${`Robovoice speech unavailable: ${g.message} — click to retry`}
          @click=${() => void this.speech.refresh(true)}>${micSvg}Retry</button>
      </span>`;
    }
    const empty = g.kind === 'empty';
    const status = this.speech.renderTalkStatus();
    return html`<span class="mic" data-speech-state=${empty ? 'wallet-empty' : 'ready'}>
      ${this.wakeWordEnabled && this.speech.talk !== 'recording'
        ? this.wakeFailed
          ? html`<span class="wake-badge failed" title="On-device wake word unavailable">WAKE OFF</span>`
          : this.wakeListening ? html`<span class="wake-badge ${this.wakeDetected ? 'flash' : ''}">◉ WAKE</span>` : nothing
        : nothing}
      ${empty
        ? html`<a class="mic-chip" href="#" data-testid="chat-mic-switch-local"
            @click=${(e: Event) => (e.preventDefault(), void this.speech.switchLocal())}>${WALLET_EMPTY_TEXT}</a>`
        : nothing}
      ${this.disabled && this.speech.talk === 'idle'
        ? html`<button class="talk" disabled title="Not connected" aria-label="Talk">${micSvg}</button>`
        : this.speech.renderTalkButton()}
      <button class="gear ${this.speech.settingsVisible ? 'active' : ''}" title="Robovoice speech settings"
        aria-label="Speech settings" @click=${() => this.toggleSettings()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
      ${this.speech.settingsVisible
        ? html`<div class="float">${this.speech.renderSettingsPopover()}${this.wakeOpen ? html`<div class="sp-pop" style="margin-top:6px">${this.renderWakeSettings()}</div>` : nothing}</div>`
        : status !== nothing ? html`<div class="float">${status}</div>` : nothing}
    </span>`;
  }
}

// ============================================================
// Slash Command Autocomplete — <slash-command-popup> Custom Element
// ============================================================

interface SlashCommand {
  command: string;
  description: string;
  category: 'project' | 'session' | 'system' | 'config' | 'other';
}

const SLASH_COMMANDS: SlashCommand[] = [
  // Project commands
  { command: '/project', description: 'Show current project status', category: 'project' },
  { command: '/project list', description: 'List all projects', category: 'project' },
  { command: '/project new', description: 'Create a new project', category: 'project' },
  { command: '/project extend', description: 'Add subtasks to current project', category: 'project' },
  { command: '/project complete', description: 'Mark project as complete', category: 'project' },
  { command: '/project pause', description: 'Pause current project', category: 'project' },
  { command: '/project resume', description: 'Resume paused project', category: 'project' },
  
  // Session commands
  { command: '/session', description: 'Show current session info', category: 'session' },
  { command: '/session list', description: 'List sessions with projects', category: 'session' },
  { command: '/session link', description: 'Link session to a project', category: 'session' },
  { command: '/session unlink', description: 'Unlink current project', category: 'session' },
  { command: '/onboard', description: 'Start project onboarding', category: 'session' },
  
  // Working directory & context commands
  { command: '/cmd', description: 'Working directory & context help', category: 'project' },
  { command: '/cmd pwd', description: 'Show current working directory', category: 'project' },
  { command: '/cmd cwd', description: 'Set working directory for project', category: 'project' },
  { command: '/cmd info', description: 'Show full project context info', category: 'project' },
  { command: '/cmd context', description: 'List context files', category: 'project' },
  { command: '/cmd context add', description: 'Add files to context', category: 'project' },
  { command: '/cmd context remove', description: 'Remove file from context', category: 'project' },
  { command: '/cmd context clear', description: 'Clear all context files', category: 'project' },
  
  // System commands
  { command: '/new', description: 'Start a new session', category: 'system' },
  { command: '/reset', description: 'Reset current session', category: 'system' },
  { command: '/status', description: 'Show system status', category: 'system' },
  { command: '/help', description: 'Show available commands', category: 'system' },
  { command: '/abort', description: 'Abort current operation', category: 'system' },
  { command: '/compact', description: 'Compact conversation context', category: 'system' },
  
  // Config commands
  { command: '/model', description: 'Change AI model', category: 'config' },
  { command: '/reasoning', description: 'Toggle extended thinking', category: 'config' },
  { command: '/verbose', description: 'Toggle verbose output', category: 'config' },
  { command: '/tts', description: 'Toggle text-to-speech', category: 'config' },
  { command: '/activation', description: 'Set group activation mode', category: 'config' },
];

const CATEGORY_LABELS: Record<string, string> = {
  project: 'Project',
  session: 'Session',
  system: 'System',
  config: 'Config',
  other: 'Other',
};

@customElement("slash-command-popup")
class SlashCommandPopup extends LitElement {
  @property({ type: String }) value = '';
  @property({ type: Boolean }) visible = false;
  
  @litState() private selectedIndex = 0;
  @litState() private filteredCommands: SlashCommand[] = [];

  static styles = css`
    :host {
      display: block;
      position: absolute;
      bottom: 100%;
      left: 0;
      right: 0;
      z-index: 1000;
    }
    
    .popup {
      background: var(--c-bg-2, #1a1a1a);
      border: 1px solid var(--c-border, #333);
      border-radius: 8px;
      box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.4);
      max-height: 300px;
      overflow-y: auto;
      margin-bottom: 8px;
    }
    
    .popup-header {
      padding: 8px 12px;
      border-bottom: 1px solid var(--c-border, #333);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--c-text-3, #666);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .popup-header kbd {
      background: var(--c-bg-3, #252525);
      border: 1px solid var(--c-border, #333);
      border-radius: 3px;
      padding: 2px 6px;
      font-size: 10px;
      color: var(--c-text-2, #888);
    }
    
    .category-label {
      padding: 6px 12px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--c-text-3, #666);
      background: var(--c-bg-3, #151515);
      border-bottom: 1px solid var(--c-border, #333);
    }
    
    .command-item {
      padding: 10px 12px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      border-bottom: 1px solid var(--c-border-subtle, #222);
      transition: background 0.1s;
    }
    
    .command-item:last-child {
      border-bottom: none;
    }
    
    .command-item:hover,
    .command-item.selected {
      background: var(--c-bg-hover, #252525);
    }
    
    .command-item.selected {
      background: var(--c-primary-dim, rgba(234, 179, 8, 0.15));
      border-left: 2px solid var(--c-primary, #eab308);
      padding-left: 10px;
    }
    
    .command-name {
      font-family: var(--font-mono, monospace);
      font-size: 13px;
      color: var(--c-primary, #eab308);
      font-weight: 500;
    }
    
    .command-desc {
      font-size: 12px;
      color: var(--c-text-2, #888);
      flex: 1;
      text-align: right;
    }
    
    .empty-state {
      padding: 16px;
      text-align: center;
      color: var(--c-text-3, #666);
      font-size: 13px;
    }
  `;

  updated(changedProps: Map<string, unknown>) {
    if (changedProps.has('value')) {
      this.updateFilteredCommands();
    }
  }

  private updateFilteredCommands() {
    const query = this.value.toLowerCase();
    
    if (!query.startsWith('/')) {
      this.filteredCommands = [];
      return;
    }
    
    const searchTerm = query.slice(1); // Remove leading /
    
    this.filteredCommands = SLASH_COMMANDS.filter(cmd => {
      const cmdLower = cmd.command.toLowerCase();
      const descLower = cmd.description.toLowerCase();
      return cmdLower.includes(query) || descLower.includes(searchTerm);
    });
    
    // Reset selection when filter changes
    this.selectedIndex = 0;
  }

  handleKeyDown(e: KeyboardEvent): boolean {
    if (!this.visible || this.filteredCommands.length === 0) return false;
    
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.selectedIndex = Math.min(this.selectedIndex + 1, this.filteredCommands.length - 1);
        return true;
        
      case 'ArrowUp':
        e.preventDefault();
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        return true;
        
      case 'Tab':
      case 'Enter':
        if (this.filteredCommands[this.selectedIndex]) {
          e.preventDefault();
          this.selectCommand(this.filteredCommands[this.selectedIndex]);
          return true;
        }
        return false;
        
      case 'Escape':
        e.preventDefault();
        this.dispatchEvent(new CustomEvent('close-popup'));
        return true;
    }
    
    return false;
  }

  private selectCommand(cmd: SlashCommand) {
    this.dispatchEvent(new CustomEvent('select-command', {
      detail: { command: cmd.command },
      bubbles: true,
      composed: true,
    }));
  }

  render() {
    if (!this.visible || this.filteredCommands.length === 0) {
      return nothing;
    }

    // Group by category
    const byCategory = new Map<string, SlashCommand[]>();
    for (const cmd of this.filteredCommands) {
      const cat = cmd.category;
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(cmd);
    }

    let globalIndex = 0;

    return html`
      <div class="popup">
        <div class="popup-header">
          <span>Commands</span>
          <span><kbd>↑↓</kbd> navigate <kbd>Tab</kbd> select <kbd>Esc</kbd> close</span>
        </div>
        ${Array.from(byCategory.entries()).map(([category, commands]) => html`
          <div class="category-label">${CATEGORY_LABELS[category] || category}</div>
          ${commands.map((cmd) => {
            const idx = globalIndex++;
            return html`
              <div 
                class="command-item ${idx === this.selectedIndex ? 'selected' : ''}"
                @click=${() => this.selectCommand(cmd)}
                @mouseenter=${() => { this.selectedIndex = idx; }}
              >
                <span class="command-name">${cmd.command}</span>
                <span class="command-desc">${cmd.description}</span>
              </div>
            `;
          })}
        `)}
      </div>
    `;
  }
}

const COMPACTION_TOAST_DURATION_MS = 5000;

function renderCompactionIndicator(status: CompactionIndicatorStatus | null | undefined) {
  if (!status) return nothing;

  // Show "compacting..." while active
  if (status.active) {
    return html`
      <div class="callout info compaction-indicator compaction-indicator--active">
        ${icons.loader} Compacting context...
      </div>
    `;
  }

  // Show "compaction complete" briefly after completion
  if (status.completedAt) {
    const elapsed = Date.now() - status.completedAt;
    if (elapsed < COMPACTION_TOAST_DURATION_MS) {
      return html`
        <div class="callout success compaction-indicator compaction-indicator--complete">
          ${icons.check} Context compacted
        </div>
      `;
    }
  }

  return nothing;
}

function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function handlePaste(e: ClipboardEvent, props: ChatProps) {
  const files = Array.from(e.clipboardData?.files ?? []).filter(isSupportedChatFile);
  if (!files.length || !props.onAttachmentsChange) return;
  e.preventDefault();
  void processFiles(files, props);
}

async function processFiles(files: File[], props: ChatProps) {
  if (!props.onAttachmentsChange || !props.gateway) return;
  let working = [...(props.attachments ?? [])];
  const valid = files.filter((file) => {
    if (isSupportedChatFile(file)) return true;
    window.alert(`Unsupported file: ${file.name}. Use PDF, DOCX, XLSX, PPTX, TXT/MD, CSV, image, or video.`);
    return false;
  });
  const pending = valid.map((file) => ({
    id: generateAttachmentId(),
    dataUrl: "",
    mimeType: normalizedFileMime(file),
    fileName: file.name,
    size: file.size,
    sourceFile: file,
    extractionStatus: "reading" as const,
    uploadProgress: 0,
  }));
  working = [...working, ...pending];
  props.onAttachmentsChange(working);

  await Promise.all(valid.map(async (file, index) => {
    const id = pending[index].id;
    const patch = (next: Partial<ChatAttachment>) => {
      working = working.map((attachment) => attachment.id === id ? { ...attachment, ...next } : attachment);
      props.onAttachmentsChange?.(working);
    };
    const onProgress = (progress: AttachmentPreparationProgress) => patch({
      extractionStatus: progress.phase === "error" ? "failed" : progress.phase,
      uploadProgress: progress.total ? Math.round((progress.loaded / progress.total) * 100) : undefined,
      error: progress.message,
    });
    try {
      const ready = await prepareChatAttachment({ file, client: props.gateway!, sessionKey: props.sessionKey, onProgress });
      working = working.map((attachment) => attachment.id === id ? { ...ready, id } : attachment);
      props.onAttachmentsChange?.(working);
    } catch (error) {
      patch({ extractionStatus: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }));
}

/** Handle file input selection (for mobile camera/gallery) */
function handleFileSelect(e: Event, props: ChatProps) {
  const input = e.target as HTMLInputElement;
  const files = input.files;
  if (!files || !props.onAttachmentsChange) return;

  void processFiles(Array.from(files), props);

  // Clear the input so the same file can be selected again
  input.value = "";
}

function renderAttachmentPreview(props: ChatProps) {
  const attachments = props.attachments ?? [];
  if (attachments.length === 0) return nothing;
  return html`
    <div class="chat-attachments">
      ${attachments.map(
        (att) => html`<ib-chat-attachment-chip
          .attachment=${att}
          .client=${props.gateway ?? null}
          .sessionKey=${props.sessionKey}
          @attachment-remove=${() => props.onAttachmentsChange?.((props.attachments ?? []).filter((a) => a.id !== att.id))}
          @attachment-update=${(e: CustomEvent<ChatAttachment>) => props.onAttachmentsChange?.((props.attachments ?? []).map((a) => (a.id === att.id ? e.detail : a)))}
          @attachment-status=${(e: CustomEvent<ChatAttachment>) => props.onAttachmentsChange?.((props.attachments ?? []).map((a) => (a.id === att.id ? e.detail : a)))}
          @attachment-retry=${() => att.sourceFile && void processFiles([att.sourceFile], { ...props, attachments: (props.attachments ?? []).filter((a) => a.id !== att.id) })}
        ></ib-chat-attachment-chip>`,
      )}
    </div>
  `;
}

/**
 * Render inline tool activity cards - integrated with streaming response
 * Shows sleek tool execution status within the chat flow
 */
// Extract streaming code from tool messages or stream
function extractStreamingCode(props: ChatProps): { code: string; filePath: string; startTime: number } | null {
  // Check for active Write/Edit tool execution
  const allMessages = [...(props.messages || []), ...(props.toolMessages || [])];
  
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const msg = allMessages[i] as Record<string, unknown>;
    const content = msg.content;
    
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        const type = String(b.type || "").toLowerCase();
        
        // Look for Write tool calls with content
        if (type === "tool_use" || type === "tooluse" || type === "tool_call") {
          const name = String(b.name || "").toLowerCase();
          if (name === "write" || name === "edit") {
            const args = b.input ?? b.arguments ?? b.args;
            if (args && typeof args === "object") {
              const a = args as Record<string, unknown>;
              const code = (a.content || a.newText || a.new_string || "") as string;
              const filePath = (a.path || a.file_path || a.filePath || "") as string;
              
              if (code && code.length > 0) {
                // Check if this tool is still running (no result yet)
                const toolId = b.id as string;
                const hasResult = allMessages.some((m: any) => {
                  const c = m.content;
                  if (Array.isArray(c)) {
                    return c.some((blk: any) => 
                      (blk.type === "tool_result" || blk.type === "toolresult") && 
                      (blk.tool_use_id === toolId || blk.toolCallId === toolId)
                    );
                  }
                  return false;
                });
                
                // Only show if actively running
                if (!hasResult) {
                  return {
                    code,
                    filePath,
                    startTime: (msg.timestamp as number) || Date.now(),
                  };
                }
              }
            }
          }
        }
      }
    }
  }
  
  return null;
}

function renderInlineToolActivity(props: ChatProps, collapsed: boolean, onToggle: () => void) {
  const allMessages = [...(props.messages || []), ...(props.toolMessages || [])];
  const executions = extractToolExecutions(allMessages);
  const files = extractFileOperations(executions);
  const isStreaming = props.stream !== null || props.sending;
  
  // Extract streaming code for animated display
  const streamingInfo = isStreaming ? extractStreamingCode(props) : null;
  
  // Only show recent executions (last 8)
  const recentExecs = executions.slice(-8);
  
  if (recentExecs.length === 0 && !isStreaming && !streamingInfo) return nothing;

  // Use the full AI IDE Panel component with streaming support
  return html`
    <ai-ide-panel
      .executions=${recentExecs}
      .files=${files}
      .streaming=${isStreaming}
      .collapsed=${collapsed}
      .streamingCode=${streamingInfo?.code || ""}
      .streamingFilePath=${streamingInfo?.filePath || ""}
      .streamingStartTime=${streamingInfo?.startTime || 0}
      @toggle-collapsed=${() => onToggle()}
    ></ai-ide-panel>
  `;
}

// State for inline tool activity collapse (per-session)
const toolActivityCollapsedState = new Map<string, boolean>();

/**
 * Render the AI IDE Panel showing real-time tool executions
 * Now returns inline tool activity instead of separate panel
 */
function renderAIIDEPanel(props: ChatProps) {
  // Check if AI IDE is enabled (default: true)
  const enabled = props.aiIdeEnabled !== false;
  if (!enabled) return nothing;

  const collapsed = toolActivityCollapsedState.get(props.sessionKey) ?? false;
  const onToggle = () => {
    toolActivityCollapsedState.set(props.sessionKey, !collapsed);
  };

  return renderInlineToolActivity(props, collapsed, onToggle);
}

export function renderChat(props: ChatProps) {
  const canCompose = props.connected;
  const isBusy = props.sending || props.stream !== null;
  const canAbort = Boolean(props.canAbort && props.onAbort);
  const activeSession = props.sessions?.sessions?.find(
    (row) => row.key === props.sessionKey,
  );
  const reasoningLevel = activeSession?.reasoningLevel ?? "off";
  const showReasoning = props.showThinking && reasoningLevel !== "off";
  const assistantIdentity = {
    name: props.assistantName,
    avatar: props.assistantAvatar ?? props.assistantAvatarUrl ?? null,
  };

  const hasAttachments = (props.attachments?.length ?? 0) > 0;
  const attachmentsReady = (props.attachments ?? []).every(
    (attachment) => !["reading", "uploading", "failed"].includes(attachment.extractionStatus ?? ""),
  );
  const composePlaceholder = props.connected
    ? hasAttachments
      ? "Add a message or paste more files..."
      : "Message (↩ to send, Shift+↩ for line breaks, paste files)"
    : "Connect to the gateway to start chatting…";

  const splitRatio = props.splitRatio ?? 0.6;
  const sidebarOpen = Boolean(props.sidebarOpen && props.onCloseSidebar);
  const isStreaming = props.stream !== null || props.sending;
  const chatItems = buildChatItems(props);
  // Empty-state hint when a session has no history yet — without this the
  // thread is just a blank flex container and the page reads as broken to
  // anyone landing on a fresh session.
  //
  // The session-match check (loadedSessionKey === sessionKey) is what makes
  // the page behave like the grid chat panel: when the user picks a session
  // from the sidebar, `messages` is cleared synchronously and
  // `loadedSessionKey` becomes null until the new history finishes loading.
  // Without this gate the empty-state card flashes for a frame on every
  // switch — the user sees a "high ash placeholder" instead of history.
  const sessionMatched =
    props.loadedSessionKey == null
      ? false
      : props.loadedSessionKey === props.sessionKey;
  const showEmptyState =
    !props.loading &&
    sessionMatched &&
    chatItems.length === 0 &&
    !isStreaming &&
    props.queue.length === 0;
  const showSwitchSkeleton =
    !showEmptyState &&
    !props.loading &&
    !sessionMatched &&
    chatItems.length === 0 &&
    !isStreaming;
  // Match the grid chat panel's minimal empty-state — just a single muted
  // line that doesn't compete with the message thread visually. The grid
  // panels render `<div class="empty-state">Start a conversation...</div>`
  // and that's the pattern users expect, not a giant card.
  const emptyStateText = props.connected
    ? t("chat.empty")
    : props.disabledReason || "Disconnected from gateway.";

  const thread = html`
    <div
      class="chat-thread"
      role="log"
      aria-live="polite"
      @scroll=${props.onChatScroll}
    >
      ${props.loading || showSwitchSkeleton
        ? html`<chat-loading-skeleton count="4"></chat-loading-skeleton>`
        : nothing}
      ${showEmptyState
        ? html`<div class="chat-empty-state">${emptyStateText}</div>`
        : nothing}
      ${repeat(chatItems, (item) => item.key, (item) => {
    if (item.kind === "reading-indicator") {
      // Show inline tool activity within the streaming response
      return html`
        <div class="chat-group assistant">
          ${renderAvatar("assistant", assistantIdentity)}
          <div class="chat-group-messages">
            ${renderAIIDEPanel(props)}
            <thinking-indicator
              .startedAt=${item.startedAt}
              ?extended=${item.extended}
            ></thinking-indicator>
          </div>
        </div>
      `;
    }

    if (item.kind === "stream") {
      // Integrate tool activity with streaming content
      const timestamp = new Date(item.startedAt).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
      return html`
        <div class="chat-group assistant">
          ${renderAvatar("assistant", assistantIdentity)}
          <div class="chat-group-messages">
            ${renderAIIDEPanel(props)}
            <thinking-indicator
              .startedAt=${item.startedAt}
              ?streaming=${true}
            ></thinking-indicator>
            ${renderGroupedMessage(
              {
                role: "assistant",
                content: [{ type: "text", text: item.text }],
                timestamp: item.startedAt,
              },
              { isStreaming: true, showReasoning: false },
              props.onOpenSidebar,
            )}
            <div class="chat-group-footer">
              <span class="chat-sender-name">${assistantIdentity.name}</span>
              <span class="chat-group-timestamp">${timestamp}</span>
            </div>
          </div>
        </div>
      `;
    }

    if (item.kind === "group") {
      return renderMessageGroup(item, {
        onOpenSidebar: props.onOpenSidebar,
        showReasoning,
        assistantName: props.assistantName,
        assistantAvatar: assistantIdentity.avatar,
      });
    }

    return nothing;
  })}
    </div>
  `;

  return html`
    <section class="card chat">
      <!-- Terminal Grid Header -->
      <div class="term-hdr">
        <button class="term-hdr__menu" @click=${props.onToggleThreadsSidebar} title="All Threads">
          ${icons.menu}
        </button>
        ${renderChatSessionHeader({
          state: {
            sessionKey: props.sessionKey,
            setTab: () => {},
            requestUpdate: props.onRequestUpdate,
            sessionsResult: props.sessions,
          } as any,
          onSessionChange: () => props.onSessionKeyChange(props.sessionKey),
          availableModels: props.availableModels,
          onModelChange: props.onModelChange,
        })}
      </div>

      <!-- Tab Bar -->
      ${renderSessionTabBar({
      // Secure Mode sessions stay out of the tab bar while Secure Mode is off.
      sessions: (props.sessions?.sessions || []).filter(
        (r) => !isSecureSessionKey(r.key) || isSecureModeActive() || r.key === props.sessionKey,
      ),
      currentSessionKey: props.sessionKey,
      onSwitchSession: (key) => props.onSessionKeyChange(key),
      onCloseSession: props.onCloseSession,
      onNewSession: () => props.onNewSession(),
      onCreateMultiple: props.onCreateMultipleSessions,
      onRename: props.onSessionRename,
      onRequestUpdate: props.onRequestUpdate,
    })}

      <!-- Session Context Bar (Directory & Project) -->
      ${props.sessionContext && props.onSessionContextChange ? renderSessionContextBar({
        sessionKey: props.sessionKey,
        context: props.sessionContext,
        projects: props.sessionProjects || [],
        projectsLoading: props.sessionProjectsLoading,
        onDirectoryChange: (dir) => {
          const newCtx = { ...props.sessionContext!, directory: dir };
          saveSessionContext(props.sessionKey, newCtx);
          props.onSessionContextChange!(newCtx);
        },
        onProjectChange: (projectId, projectName) => {
          const newCtx = { ...props.sessionContext!, projectId, projectName };
          saveSessionContext(props.sessionKey, newCtx);
          props.onSessionContextChange!(newCtx);
        },
        onRequestUpdate: props.onRequestUpdate,
        onBrowseDirectory: props.onBrowseDirectory,
      }) : nothing}

      ${props.disabledReason
      ? html`<div class="callout">${props.disabledReason}</div>`
      : nothing}

      ${props.error
      ? html`<div class="callout danger">${props.error}</div>`
      : nothing}

      ${renderCompactionIndicator(props.compactionStatus)}

      <!-- Sub-Agent Activity Panel -->
      ${props.gateway ? html`
        <subagent-activity-panel
          .gateway=${props.gateway}
          .pollIntervalMs=${3000}
          .limit=${10}
        ></subagent-activity-panel>
      ` : nothing}

      ${props.focusMode
      ? html`
            <button
              class="chat-focus-exit"
              type="button"
              @click=${props.onToggleFocusMode}
              aria-label="Exit focus mode"
              title="Exit focus mode"
            >
              ${icons.x}
            </button>
          `
      : nothing}

      <div
        class="chat-split-container ${sidebarOpen ? "chat-split-container--open" : ""}"
      >
        <div
          class="chat-main"
          style="flex: ${sidebarOpen ? `0 0 ${splitRatio * 100}%` : "1 1 100%"}"
        >
          ${thread}
        </div>

        ${sidebarOpen
      ? html`
              <resizable-divider
                .splitRatio=${splitRatio}
                @resize=${(e: CustomEvent) =>
          props.onSplitRatioChange?.(e.detail.splitRatio)}
              ></resizable-divider>
              <div class="chat-sidebar">
                ${renderMarkdownSidebar({
            content: props.sidebarContent ?? null,
            error: props.sidebarError ?? null,
            onClose: props.onCloseSidebar!,
            onViewRawText: () => {
              if (!props.sidebarContent || !props.onOpenSidebar) return;
              props.onOpenSidebar(`\`\`\`\n${props.sidebarContent}\n\`\`\``);
            },
          })}
              </div>
            `
      : nothing}
      </div>

      ${props.queue.length
      ? html`
            <div class="chat-queue" role="status" aria-live="polite">
              <div class="chat-queue__title">Queued (${props.queue.length})</div>
              <div class="chat-queue__list">
                ${props.queue.map(
        (item) => html`
                    <div class="chat-queue__item">
                      <div class="chat-queue__text">
                        ${item.text ||
          (item.attachments?.length
            ? `Image (${item.attachments.length})`
            : "")}
                      </div>
                      <button
                        class="btn chat-queue__remove"
                        type="button"
                        aria-label="Remove queued message"
                        @click=${() => props.onQueueRemove(item.id)}
                      >
                        ${icons.x}
                      </button>
                    </div>
                  `,
      )}
              </div>
            </div>
          `
      : nothing}

      <div
        class="chat-compose ${isSecureSessionKey(props.sessionKey) ? "chat-compose--secure" : ""}"
        @dragover=${(e: DragEvent) => {
          if (e.dataTransfer?.types.includes("Files")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }
        }}
        @drop=${(e: DragEvent) => {
          if (e.dataTransfer?.files?.length) {
            e.preventDefault();
            void processFiles(Array.from(e.dataTransfer.files), props);
          }
        }}
      >
        ${props.onSecureToggle
          ? html`<div class="chat-secure-row">
              ${isSecureSessionKey(props.sessionKey)
                ? html`<span class="ib-secure-lockbadge ${isSecureModeActive() ? "" : "ib-secure-lockbadge--locked"}" data-secure-composer-badge>
                    ${icons.lock}<span>${isSecureModeActive() ? "Secure session · local models only" : "Secure session locked — turn on Secure Mode to send"}</span>
                  </span>`
                : nothing}
              <ib-secure-toggle
                compact
                mode="custom"
                data-secure-surface="chat-legacy"
                .on=${isSecureSessionKey(props.sessionKey)}
                .busy=${Boolean(props.secureBusy)}
                .error=${props.secureError ?? null}
                @secure-toggle=${(e: CustomEvent<{ on: boolean }>) => props.onSecureToggle?.(e.detail.on)}
              ></ib-secure-toggle>
            </div>`
          : nothing}
        ${renderAttachmentPreview(props)}
        
        <!-- MCP Status Indicator -->
        <div class="mcp-status-bar">
             <button class="mcp-indicator ${props.connected ? 'connected' : ''}" @click=${props.onMcpSetup}>
                <span class="mcp-dot"></span>
                <span class="mcp-label">MCP Enabled</span>
             </button>
        </div>

        <div class="chat-compose__row"
          @stt-transcript=${(e: CustomEvent) => {
      console.log('[ChatCompose] ✓ Received stt-transcript event:', e.detail);
      props.onDraftChange(e.detail.text);
    }}
          @stt-autosend=${(e: CustomEvent) => {
      console.log('[ChatCompose] ✓ Received stt-autosend event:', e.detail);
      props.onDraftChange(e.detail.text);
      setTimeout(() => props.onSend(), 50);
    }}
          @stt-send=${(e: CustomEvent) => {
      console.log('[ChatCompose] ✓ Received stt-send event - triggering send');
      setTimeout(() => props.onSend(), 50);
    }}
          @select-command=${(e: CustomEvent) => {
      const command = String(e.detail.command ?? "");
      // `/skill` opens the full Browse Skills modal instead of stuffing
      // bare text into the prompt — same behaviour as the grid chat panel.
      if (command === "/skill") {
        // The global modal mount in `renderApp` registers its own
        // `state.requestUpdate` as the rerender on every render, so we
        // just flip the open flag and the next paint shows the modal.
        // On pick, append `@<skillKey>` to the current draft so the
        // user keeps any context they'd already typed.
        const currentDraft = props.draft ?? "";
        // Strip the leading `/skill` token so we don't end up with
        // "/skill @skill-key " in the prompt.
        const baseDraft = currentDraft.replace(/^\s*\/skill\b\s*/i, "");
        void import("./skills").then((mod) =>
          mod.openSkillsBrowseModal({
            onPick: (skillKey) => {
              const ref = `@${skillKey}`;
              const next = baseDraft
                ? `${baseDraft.trimEnd()} ${ref} `
                : `${ref} `;
              props.onDraftChange(next);
            },
          }),
        );
        // Drop the bare `/skill ` placeholder while the modal is open.
        props.onDraftChange(baseDraft);
        return;
      }
      props.onDraftChange(command + ' ');
    }}
        >
          <label class="field chat-compose__field" style="position: relative;">
            <span>Message</span>
            <slash-command-popup
              .value=${props.draft}
              .visible=${props.draft.startsWith('/')}
            ></slash-command-popup>
            <textarea
              .value=${props.draft}
              ?disabled=${!props.connected}
              @keydown=${(e: KeyboardEvent) => {
      // Check if slash popup wants to handle the key
      const popup = (e.target as HTMLElement).parentElement?.querySelector('slash-command-popup') as SlashCommandPopup | null;
      if (popup?.visible && popup.handleKeyDown(e)) {
        return;
      }
      if (e.key !== "Enter") return;
      if (e.isComposing || e.keyCode === 229) return;
      if (e.shiftKey) return; // Allow Shift+Enter for line breaks
      if (!props.connected) return;
      e.preventDefault();
      if (canCompose && attachmentsReady) props.onSend();
    }}
              @input=${(e: Event) =>
      props.onDraftChange((e.target as HTMLTextAreaElement).value)}
              @paste=${(e: ClipboardEvent) => handlePaste(e, props)}
              placeholder=${composePlaceholder}
            ></textarea>
          </label>
          <div class="chat-compose__actions">
            <!-- Vision button -->
            ${props.onToggleVision ? html`
              <button 
                class="btn btn--icon vision-btn ${props.visionEnabled ? 'active' : ''}"
                title="${props.visionEnabled ? 'Vision enabled - click to capture' : 'Enable vision'}"
                ?disabled=${!props.connected || props.visionAnalyzing}
                @click=${props.visionEnabled ? props.onVisionCapture : props.onToggleVision}
                @contextmenu=${(e: Event) => { e.preventDefault(); props.onVisionSettingsOpen?.(); }}
              >
                ${props.visionAnalyzing ? html`
                  <span class="vision-spinner"></span>
                ` : html`
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                    <circle cx="12" cy="12" r="3"></circle>
                  </svg>
                `}
                ${props.visionEnabled && props.visionSettings ? html`
                  <span class="vision-backend-tag">${props.visionSettings.backend === 'auto' ? 'A' : props.visionSettings.backend === 'local' ? 'L' : 'C'}</span>
                ` : ''}
              </button>
            ` : ''}
            <!-- Video mode button -->
            ${props.onToggleVideoMode ? html`
              <button 
                class="btn btn--icon video-mode-btn ${props.videoModeEnabled ? 'active' : ''}"
                title="${props.videoModeEnabled ? 'Video mode ON - streaming to context' : 'Enable video mode'}"
                ?disabled=${!props.connected}
                @click=${props.onToggleVideoMode}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="2" y="4" width="20" height="16" rx="2"></rect>
                  <circle cx="12" cy="12" r="3"></circle>
                  ${props.videoModeEnabled ? html`
                    <circle cx="18" cy="7" r="2" fill="#ff4444" stroke="none">
                      <animate attributeName="opacity" values="1;0.5;1" dur="1s" repeatCount="indefinite"/>
                    </circle>
                  ` : ''}
                </svg>
              </button>
            ` : ''}
            <!-- File upload button -->
            <label class="btn btn--icon chat-image-upload" title="Upload document, image, or video" ?disabled=${!props.connected}>
              <input
                type="file"
                accept=${CHAT_ATTACHMENT_ACCEPT}
                multiple
                style="display: none;"
                ?disabled=${!props.connected}
                @change=${(e: Event) => handleFileSelect(e, props)}
              />
              ${icons.image || icons.camera}
            </label>
            <chat-mic-button ?disabled=${!props.connected} .gateway=${props.gateway}></chat-mic-button>
            <chat-call-button ?disabled=${!props.connected} .sessionKey=${props.sessionKey} source="webchat"></chat-call-button>
            <button
              class="btn"
              ?disabled=${!props.connected || (!canAbort && props.sending)}
              @click=${canAbort ? props.onAbort : props.onNewSession}
            >
              ${canAbort ? "Stop" : "New session"}
            </button>
            <button
              class="btn primary"
              ?disabled=${!props.connected || !attachmentsReady}
              @click=${props.onSend}
            >
              ${isBusy ? "Queue" : "Send"}<kbd class="btn-kbd">↵</kbd>
            </button>
          </div>
        </div>
      </div>
      <!-- Video Feed HUD -->
      ${props.videoModeEnabled ? html`
        <video-feed-hud
          position="top-right"
          ?active=${props.videoModeEnabled}
          @frame-captured=${(e: CustomEvent) => {
            if (props.onVideoFrame) {
              const { base64 } = e.detail;
              // Extract base64 content and mime type from data URL
              const match = /^data:([^;]+);base64,(.+)$/.exec(base64);
              if (match) {
                props.onVideoFrame(match[2], match[1]);
              }
            }
          }}
          @close=${() => props.onToggleVideoMode?.()}
        ></video-feed-hud>
      ` : ''}
    </section>
    
    <style>
        /* ... existing styles ... */
        .mcp-status-bar {
            display: flex;
            justify-content: flex-end; /* Align right or left as preferred */
            padding: 4px 16px;
            margin-bottom: 4px;
        }
        .mcp-indicator {
            background: rgba(0, 0, 0, 0.4);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: var(--c-text-2, #aaa);
            font-size: 0.75rem;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 4px 10px;
            border-radius: 12px;
            cursor: pointer;
            transition: all 0.2s;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            font-weight: 600;
        }
        .mcp-indicator:hover {
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
            border-color: rgba(255, 255, 255, 0.2);
        }
        .mcp-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #666;
            box-shadow: 0 0 4px rgba(0,0,0,0.5);
            transition: all 0.3s;
        }
        .mcp-indicator.connected .mcp-dot {
            background: var(--c-emerald-500, #10b981);
            box-shadow: 0 0 8px var(--c-emerald-500, #10b981);
        }

        /* Vision Button Styles */
        .vision-btn {
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
            padding: 8px 12px;
            background: rgba(138, 43, 226, 0.1);
            border: 1px solid rgba(138, 43, 226, 0.3);
            border-radius: 8px;
            color: #8a2be2;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        .vision-btn:hover {
            background: rgba(138, 43, 226, 0.2);
            border-color: rgba(138, 43, 226, 0.5);
            box-shadow: 0 0 12px rgba(138, 43, 226, 0.3);
        }
        .vision-btn.active {
            background: rgba(138, 43, 226, 0.25);
            border-color: #8a2be2;
            box-shadow: 0 0 15px rgba(138, 43, 226, 0.4);
        }
        .vision-btn.active svg {
            filter: drop-shadow(0 0 4px #8a2be2);
        }
        .vision-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .vision-backend-tag {
            position: absolute;
            top: -4px;
            right: -4px;
            width: 14px;
            height: 14px;
            background: #8a2be2;
            border-radius: 50%;
            font-size: 8px;
            font-weight: bold;
            color: white;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 0 6px #8a2be2;
        }
        .vision-spinner {
            width: 16px;
            height: 16px;
            border: 2px solid rgba(138, 43, 226, 0.3);
            border-top-color: #8a2be2;
            border-radius: 50%;
            animation: vision-spin 0.8s linear infinite;
        }
        
        /* Video Mode Button Styles */
        .video-mode-btn {
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 8px 12px;
            background: rgba(255, 87, 51, 0.1);
            border: 1px solid rgba(255, 87, 51, 0.3);
            border-radius: 8px;
            color: #ff5733;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        .video-mode-btn:hover {
            background: rgba(255, 87, 51, 0.2);
            border-color: rgba(255, 87, 51, 0.5);
            box-shadow: 0 0 12px rgba(255, 87, 51, 0.3);
        }
        .video-mode-btn.active {
            background: rgba(255, 87, 51, 0.25);
            border-color: #ff5733;
            box-shadow: 0 0 15px rgba(255, 87, 51, 0.4);
        }
        .video-mode-btn.active svg {
            filter: drop-shadow(0 0 4px #ff5733);
        }
        .video-mode-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        @keyframes vision-spin {
            to { transform: rotate(360deg); }
        }
    </style>
  `;
}

/**
 * How many past messages the chat renders. 0 means all of them.
 *
 * This used to be a hard 200, which silently hid older messages behind a
 * "(N hidden)" notice — on a self-hosted install, where the history is the
 * user's own and there is no one to bill, truncating it just loses their
 * conversation. Kept as a knob rather than deleted because the cap is the only
 * thing standing between a very long session and rendering every node at once;
 * set it to a number again if a huge history ever gets slow to paint.
 */
const CHAT_HISTORY_RENDER_LIMIT = 0;

function groupMessages(items: ChatItem[]): Array<ChatItem | MessageGroup> {
  const result: Array<ChatItem | MessageGroup> = [];
  let currentGroup: MessageGroup | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      result.push(item);
      continue;
    }

    const normalized = normalizeMessage(item.message);
    const role = normalizeRoleForGrouping(normalized.role);
    const timestamp = normalized.timestamp || Date.now();

    if (!currentGroup || currentGroup.role !== role) {
      if (currentGroup) result.push(currentGroup);
      currentGroup = {
        kind: "group",
        key: `group:${role}:${item.key}`,
        role,
        messages: [{ message: item.message, key: item.key }],
        timestamp,
        isStreaming: false,
      };
    } else {
      currentGroup.messages.push({ message: item.message, key: item.key });
    }
  }

  if (currentGroup) result.push(currentGroup);
  return result;
}

function buildChatItems(props: ChatProps): Array<ChatItem | MessageGroup> {
  const items: ChatItem[] = [];
  const history = Array.isArray(props.messages) ? props.messages : [];
  const tools = Array.isArray(props.toolMessages) ? props.toolMessages : [];
  const historyStart =
    CHAT_HISTORY_RENDER_LIMIT > 0
      ? Math.max(0, history.length - CHAT_HISTORY_RENDER_LIMIT)
      : 0;
  if (historyStart > 0) {
    items.push({
      kind: "message",
      key: "chat:history:notice",
      message: {
        role: "system",
        content: `Showing last ${CHAT_HISTORY_RENDER_LIMIT} messages (${historyStart} hidden).`,
        timestamp: Date.now(),
      },
    });
  }
  for (let i = historyStart; i < history.length; i++) {
    const msg = history[i];
    const normalized = normalizeMessage(msg);

    if (!props.showThinking && normalized.role.toLowerCase() === "toolresult") {
      continue;
    }

    items.push({
      kind: "message",
      key: messageKey(msg, i),
      message: msg,
    });
  }
  if (props.showThinking) {
    for (let i = 0; i < tools.length; i++) {
      items.push({
        kind: "message",
        key: messageKey(tools[i], i + history.length),
        message: tools[i],
      });
    }
  }

  // A run is "in flight" while we're sending, while a stream buffer exists, or
  // while there's an abortable run id (canAbort). The webchat path disables
  // block streaming, so between the user message and the final reply NO deltas
  // arrive — and the fallback chain (cloud cooldown → local Ollama cold-load,
  // which can take many seconds) emits nothing either. Keying the thinking
  // indicator purely off `stream !== null` meant any intermediate reset (or the
  // `sending` flag flipping false on ack) left the user staring at a frozen
  // thread with no spinner. Treat an active run with no streamed text yet as the
  // "calling model / waiting for first token" state and always show the
  // indicator there.
  const hasStreamText = props.stream != null && props.stream.trim().length > 0;
  const runActive = props.stream !== null || props.sending || Boolean(props.canAbort);
  if (runActive) {
    const key = `stream:${props.sessionKey}:${props.streamStartedAt ?? "live"}`;
    const thinkingStart = props.thinkingStartedAt ?? props.streamStartedAt ?? Date.now();
    const isExtendedThinking = props.thinkingLevel === "high" || props.thinkingLevel === "medium";

    if (hasStreamText) {
      items.push({
        kind: "stream",
        key,
        text: props.stream as string,
        startedAt: props.streamStartedAt ?? Date.now(),
      });
    } else {
      items.push({
        kind: "reading-indicator",
        key,
        startedAt: thinkingStart,
        extended: isExtendedThinking,
      });
    }
  }

  return groupMessages(items);
}

function messageKey(message: unknown, index: number): string {
  const m = message as Record<string, unknown>;
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  if (toolCallId) return `tool:${toolCallId}`;
  const id = typeof m.id === "string" ? m.id : "";
  if (id) return `msg:${id}`;
  const messageId = typeof m.messageId === "string" ? m.messageId : "";
  if (messageId) return `msg:${messageId}`;
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  if (timestamp != null) return `msg:${role}:${timestamp}:${index}`;
  return `msg:${role}:${index}`;
}
