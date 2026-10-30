/**
 * <voice-session-view> — the Voice page's main view: the original InfiniBot
 * Voice Terminal (header, floating pills, transcript + system log, the WebGL
 * voice blob, System modules, footer controls, and the holographic HUD mode),
 * running on InfiniBot's local voice (the default) or a Robovoice call (the
 * opt-in cloud voice) — `engine` says which; only the copy differs.
 *
 * Look: the original stylesheet verbatim (session-styles.ts) and the original
 * blob / HUD components (components/voice-*.ts). Only the wiring changed:
 *
 *   connect / disconnect   robovoice.call.start / .end (via the console)
 *   blob energy            mic + agent audio analysers on the LiveKit room,
 *                          agent state from the "lk.agent.state" attribute
 *   transcript             the call's transcript (data topic + transcriptions)
 *   live pipeline          <voice-live-pipeline>: STT → LLM → TTS lighting per
 *                          turn with per-stage latency (also shown in the HUD)
 *
 * Controls that only existed for the local stack (push-to-talk Whisper, the
 * Jarvis/Kokoro switch, vision/camera streaming, the CLI terminal route) are
 * gone with it. This view owns no call logic: it renders `call` and emits
 * session-* events; <voice-robovoice-console> does the work.
 */

import { LitElement, css, html, nothing, svg, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../gateway.js";
import { icons } from "../../icons.js";
import { VoiceBlob, BLOB_STYLES, type BlobStyle } from "../../components/voice-blob.js";
import "../../components/voice-floating-hud.js";
import "../../components/voice-controls-dock.js";
import type { HudCallSnapshot } from "./hud-panels.js";
import "./live-pipeline.js";
import { SILENT_ROOM, type RoomLevels } from "./call-session.js";
import { CLOUD_VOICE_BUSY_TEXT, IDLE_CALL, callInProgress, isCloudVoiceBusy, type CallState } from "./console-state.js";
import { agentPending, aiState, blobDrive, prettyProvider, transcriptEmptyText, type BlobDrive, type CallPipelineInfo, type LivePipelineInput } from "./live-state.js";
import { sessionStyles } from "./session-styles.js";
import { holoStyles } from "./holo-styles.js";
import "./holo-primitives.js";
import "../../components/holo-panel.js";
import {
  loadAudioPrefs,
  outputSelectionSupported,
  playTestTone,
  promptForOutput,
  resolveDevice,
  saveAudioPrefs,
  splitDevices,
  type AudioDevice,
} from "./audio-output.js";
import type { VoiceTurnDiag } from "./console-actions.js";

export type SessionAgent = { id: string; name: string };
type LogEntry = { text: string; type: "info" | "success" | "warn" | "error" | "system"; timestamp: number };

/** Same localStorage keys as the original terminal, so saved looks carry over. */
const AGENT_JOIN_WARN_MS = 30_000;

const KEY = {
  hud: "voice-chat:floatingHud",
  blobStyle: "voice-chat:blobStyle",
  blobEnabled: "voice-chat:blobEnabled",
  userColor: "voice-chat:blobUserColor:v2",
  agentColor: "voice-chat:blobAgentColor:v2",
  rightCollapsed: "voice-chat:rightPanelCollapsed",
  mic: "infinibot.voice.micDeviceId",
} as const;

/**
 * The holographic terminal's blob light: champagne-white (you) / pale gold
 * (agent). Used when nothing is saved; a colour picked in the visualizer
 * panel still wins.
 */
const HOLO_BLOB_COLORS = { user: "#fff0cc", agent: "#f5c84b" } as const;

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
};

const MIC_SVG = html`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
  <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
  <line x1="12" y1="19" x2="12" y2="23"></line>
  <line x1="8" y1="23" x2="16" y2="23"></line>
</svg>`;

@customElement("voice-session-view")
export class VoiceSessionView extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ attribute: false }) call: CallState = IDLE_CALL;
  @property({ attribute: false }) agents: SessionAgent[] = [];
  @property() agentId: string | null = null;
  @property({ type: Boolean }) muted = false;
  /** Why a call can't start right now (null = it can). */
  @property() blockedReason: string | null = null;
  /** Org / account label for the provider badge. */
  @property() account = "";
  /** The call agent's effective pipeline from Robovoice; null = not answered or unavailable. */
  @property({ attribute: false }) pipeline: CallPipelineInfo | null = null;
  @property({ type: Boolean }) pipelineLoaded = false;
  /** True while an overlay (Connect Robovoice, plugin off, load error) owns the stage. */
  @property({ type: Boolean }) overlay = false;
  /** Audio read-out of the call room, sampled every frame. */
  @property({ attribute: false }) levels: () => RoomLevels = () => SILENT_ROOM;
  /** Which voice engine runs the call: local (this machine, default) or robovoice (cloud). */
  @property() engine: "local" | "robovoice" = "robovoice";
  /** Direct CLI mode: what the voice turns go to (voice.cliRoute), for the HUD terminal label. */
  @property() voiceRoute = "gateway_agent";
  /** InfiniBot's side of the latest voice turns (robovoice.voiceLlm.status → turns), newest first. */
  @property({ attribute: false }) turns: VoiceTurnDiag[] = [];

  @state() private floatingHudMode = false;
  @state() private blobEnabled = true;
  @state() private blobStyle: BlobStyle = "audio-wireframe";
  @state() private blobUserColor = "#7cf5ff";
  @state() private blobAgentColor = "#ffb84a";
  @state() private blobPickerOpen = false;
  @state() private blobOpenSection: "style" | "colors" | "visualizer" | null = "style";
  @state() private rightPanelCollapsed = false;
  @state() private systemTime = new Date().toLocaleTimeString("en-US", { hour12: false });
  @state() private logs: LogEntry[] = [];
  @state() private microphones: Array<{ deviceId: string; label: string }> = [];
  @state() private selectedMicrophone = "";
  @state() private devicesLoaded = false;
  @state() private speakers: AudioDevice[] = [];
  @state() private selectedSpeaker = "";
  @state() private outputVolume = 1;
  @state() private fallbackVoice = true;
  @state() private toneState: "idle" | "playing" | "ok" | "failed" = "idle";
  /** A saved device that is no longer plugged in (the call uses the default instead). */
  @state() private missingDevice: { mic: boolean; speaker: boolean } = { mic: false, speaker: false };
  private readonly outputSupported = outputSelectionSupported();
  // Reactive mirror of the room levels (10 Hz) for the waveform + HUD props.
  @state() private micLevel = 0;
  @state() private micLevels: number[] = Array(12).fill(0) as number[];
  @state() private micBass = 0;
  @state() private micTreble = 0;
  @state() private agentLevel = 0;
  @state() private userSpeaking = false;
  @state() private agentSpeaking = false;

  private voiceBlob: VoiceBlob | null = null;
  private blobRafId: number | null = null;
  private frame: RoomLevels = SILENT_ROOM;
  private clock: ReturnType<typeof setInterval> | null = null;
  private meter: ReturnType<typeof setInterval> | null = null;
  private themeTimer: ReturnType<typeof setTimeout> | null = null;
  private agentWait: ReturnType<typeof setTimeout> | null = null;

  static styles = [
    sessionStyles,
    css`
      /* Robovoice session additions — everything else is the original sheet. */
      .vc-pill--select select,
      .vs-agent-select {
        appearance: none;
        background: transparent;
        border: 0;
        color: inherit;
        font: inherit;
        letter-spacing: inherit;
        cursor: pointer;
        outline: none;
        max-width: 190px;
        text-overflow: ellipsis;
      }
      .vc-pill--select select option,
      .vs-agent-select option { background: #0b0b0d; color: #e4e4e7; }
      .vc-pill--select select,
      .vs-agent-select {
        padding-right: 16px;
        background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
        background-position: calc(100% - 7px) 55%, calc(100% - 3px) 55%;
        background-size: 4px 4px, 4px 4px;
        background-repeat: no-repeat;
      }
      .vs-agent-select {
        padding: 8px 22px 8px 12px;
        background-position: calc(100% - 13px) 55%, calc(100% - 9px) 55%;
        border-radius: 8px;
        border: 1px solid var(--glass-border);
        background-color: rgba(0, 0, 0, 0.3);
        font-size: 0.7rem;
      }
      /* Autoplay refused the agent's voice: one obvious tap unlocks it. */
      .vs-audio-unlock {
        position: absolute;
        top: 4.5rem;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483000;
        display: flex;
        align-items: center;
        gap: 0.75rem;
        width: max-content;
        max-width: calc(100% - 2rem);
        min-height: 52px;
        padding: 0.7rem 1.25rem;
        border-radius: 14px;
        border: 1px solid var(--hud-accent, #fbbf24);
        background: color-mix(in srgb, var(--hud-accent, #fbbf24) 16%, rgba(8, 8, 10, 0.92));
        color: var(--g-fg, #f5f5f5);
        font: inherit;
        text-align: left;
        cursor: pointer;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.55), 0 0 0 4px color-mix(in srgb, var(--hud-accent, #fbbf24) 14%, transparent);
        animation: vs-audio-unlock-pulse 1.8s ease-in-out infinite;
      }
      .vs-audio-unlock svg { width: 22px; height: 22px; flex: none; color: var(--hud-accent, #fbbf24); }
      .vs-audio-unlock span { display: flex; flex-direction: column; gap: 2px; }
      .vs-audio-unlock b { font-size: 0.85rem; letter-spacing: 0.06em; text-transform: uppercase; }
      .vs-audio-unlock small { font-size: 0.7rem; opacity: 0.75; }
      .vs-audio-unlock:focus-visible { outline: 2px solid var(--hud-accent, #fbbf24); outline-offset: 3px; }
      @keyframes vs-audio-unlock-pulse {
        50% { box-shadow: 0 10px 40px rgba(0, 0, 0, 0.55), 0 0 0 9px color-mix(in srgb, var(--hud-accent, #fbbf24) 6%, transparent); }
      }
      @media (prefers-reduced-motion: reduce) {
        .vs-audio-unlock { animation: none; }
      }
      /* The agent answered in text but its voice never arrived. */
      .vs-tts-fault {
        position: absolute;
        /* Below the Connect / Mic / agent pills, so the call controls stay reachable. */
        top: 8rem;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147482000;
        display: flex;
        align-items: center;
        gap: 0.75rem;
        box-sizing: border-box;
        width: min(560px, calc(100% - 2rem));
        padding: 0.7rem 1.1rem;
        border-radius: 14px;
        border: 1px solid color-mix(in srgb, var(--danger, #ef4444) 60%, transparent);
        background: color-mix(in srgb, var(--danger, #ef4444) 14%, rgba(8, 8, 10, 0.94));
        color: var(--g-fg, #f5f5f5);
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.55);
      }
      .vs-tts-fault svg { width: 22px; height: 22px; flex: none; color: var(--danger, #ef4444); }
      .vs-tts-fault span { display: flex; flex-direction: column; gap: 3px; }
      .vs-tts-fault b { font-size: 0.8rem; letter-spacing: 0.06em; text-transform: uppercase; }
      .vs-tts-fault small { font-size: 0.7rem; line-height: 1.45; opacity: 0.85; }
      .vs-device-note { margin-top: 0.4rem; font-size: 0.6rem; line-height: 1.45; color: var(--warning, #f59e0b); }
      .vs-device-note.error { color: var(--danger, #ef4444); overflow: hidden; text-overflow: ellipsis; }
      .vs-volume-row { gap: 0.6rem; margin-top: 0.35rem; }
      .vs-volume { flex: 1; min-width: 0; height: 24px; accent-color: var(--gold-primary, #fbbf24); cursor: pointer; }
      .vs-volume-value { min-width: 2.6rem; text-align: right; font-variant-numeric: tabular-nums; }
      .vs-mini-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.45rem;
        width: 100%;
        min-height: 34px;
        margin-top: 0.5rem;
        padding: 0.4rem 0.7rem;
        border-radius: 6px;
        border: 1px solid var(--glass-border);
        background: rgba(0, 0, 0, 0.35);
        color: var(--text-primary);
        font: inherit;
        font-size: 0.65rem;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        cursor: pointer;
        transition: border-color 0.15s ease, color 0.15s ease;
      }
      .vs-mini-btn svg { width: 11px; height: 11px; flex: none; }
      .vs-mini-btn:hover:not(:disabled) { border-color: var(--gold-primary, #fbbf24); color: var(--gold-primary, #fbbf24); }
      .vs-mini-btn:focus-visible { outline: 2px solid var(--gold-primary, #fbbf24); outline-offset: 2px; }
      .vs-mini-btn:disabled { opacity: 0.6; cursor: default; }
      .vs-mini-btn.ok { border-color: var(--success, #22c55e); color: var(--success, #22c55e); }
      .vs-mini-btn.failed { border-color: var(--danger, #ef4444); color: var(--danger, #ef4444); }
      .vs-link-btn {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        max-width: 65%;
        min-height: 24px;
        padding: 0 0.1rem;
        border: 0;
        background: none;
        color: var(--gold-primary, #fbbf24);
        font: inherit;
        font-size: 0.65rem;
        cursor: pointer;
      }
      .vs-link-btn .ellip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .vs-link-btn:hover { text-decoration: underline; }
      .vs-link-btn:focus-visible { outline: 2px solid var(--gold-primary, #fbbf24); outline-offset: 2px; border-radius: 4px; }
      .vs-toggle-row { display: flex; align-items: center; gap: 0.5rem; margin: 0.6rem 0 0.25rem; font-size: 0.62rem; color: var(--text-muted); cursor: pointer; }
      .vs-toggle-row input { accent-color: var(--gold-primary, #fbbf24); width: 14px; height: 14px; flex: none; }
      .module-value.slow { color: var(--warning, #f59e0b); }
      .vs-notice {
        position: absolute;
        left: 50%;
        top: 64px;
        transform: translateX(-50%);
        z-index: 30;
        display: flex;
        align-items: center;
        gap: 12px;
        max-width: min(560px, calc(100% - 48px));
        padding: 10px 14px;
        border-radius: 12px;
        font-size: 0.68rem;
        line-height: 1.5;
        letter-spacing: 0.02em;
        color: var(--text-primary);
        background: linear-gradient(to bottom, rgba(255, 255, 255, 0.07), rgba(0, 0, 0, 0.25)), var(--glass-bg);
        border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--glass-border));
        box-shadow: 0 10px 30px -12px color-mix(in srgb, var(--warning) 40%, transparent), inset 0 1px 0 rgba(255, 255, 255, 0.06);
        -webkit-backdrop-filter: blur(14px) saturate(140%);
        backdrop-filter: blur(14px) saturate(140%);
      }
      .vs-notice.error { border-color: color-mix(in srgb, var(--danger) 55%, var(--glass-border)); box-shadow: 0 10px 30px -12px color-mix(in srgb, var(--danger) 45%, transparent), inset 0 1px 0 rgba(255, 255, 255, 0.06); }
      .vs-notice b { color: var(--warning); letter-spacing: 0.12em; text-transform: uppercase; font-size: 0.6rem; }
      .vs-notice.error b { color: var(--danger); }
      .vs-notice a { color: var(--gold-primary); white-space: nowrap; text-decoration: none; border: 1px solid var(--gold-dim); border-radius: 8px; padding: 5px 10px; }
      .vs-notice .vs-switch { color: #0b0b0b; background: var(--gold-primary); white-space: nowrap; border: 0; border-radius: 8px; padding: 6px 12px; font: inherit; font-weight: 600; cursor: pointer; }
      .vs-overlay {
        position: absolute;
        inset: 0;
        z-index: 40;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        overflow: auto;
        background: radial-gradient(ellipse at center, rgba(0, 0, 0, 0.72) 0%, rgba(0, 0, 0, 0.45) 60%, transparent 100%);
      }
      .vs-live-module { padding: 0 2px 2px; }
      .vs-live-module voice-live-pipeline { margin-bottom: 10px; }
      .module-value.ellip { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      /* Narrow screens: the original grid has no phone layout (the blob is
         squeezed out). Stack it: blob first, then live pipeline + modules,
         transcript and log, with the page scrolling. */
      @media (max-width: 900px) {
        :host { overflow-y: auto; }
        .hud-container,
        .hud-container.right-collapsed {
          grid-template-columns: minmax(0, 1fr);
          grid-template-rows: 52px minmax(360px, 52vh) auto minmax(320px, auto) auto;
          grid-template-areas: "header" "center" "right" "left" "footer";
          height: auto;
          min-height: 100%;
          overflow: visible;
        }
        .vc-col-splitter { display: none; }
        .system-time { display: none; }
        .panel-left { min-height: 420px; }
        .vc-left-transcript { min-height: 180px; }
        .hud-footer { flex-wrap: wrap; padding: 10px 8px; gap: 8px; min-width: 0; }
        .hud-footer .divider { display: none; }
        .hud-footer .control-group { gap: 6px; min-width: 0; }
        .vc-floating-pills { flex-wrap: wrap; justify-content: center; max-width: calc(100% - 16px); }
      }
    `,
    // The holographic presentation layer (REDESIGN_BRIEF.md) goes last so it wins.
    ...holoStyles,
  ];

  // ── lifecycle ─────────────────────────────────────────────────────────────

  connectedCallback(): void {
    super.connectedCallback();
    this.floatingHudMode = read(KEY.hud) === "1";
    this.rightPanelCollapsed = read(KEY.rightCollapsed) === "1";
    const style = read(KEY.blobStyle) as BlobStyle | null;
    if (style && BLOB_STYLES.some((s) => s.id === style)) this.blobStyle = style;
    if (read(KEY.blobEnabled) === "false") this.blobEnabled = false;
    this.applyBlobColors();
    const prefs = loadAudioPrefs();
    this.selectedMicrophone = prefs.micDeviceId;
    this.selectedSpeaker = prefs.outputDeviceId;
    this.outputVolume = prefs.volume;
    this.fallbackVoice = prefs.fallbackVoice;
    navigator.mediaDevices?.addEventListener?.("devicechange", this.onDeviceChange);
    this.clock = setInterval(() => (this.systemTime = new Date().toLocaleTimeString("en-US", { hour12: false })), 1000);
    this.meter = setInterval(() => this.mirrorLevels(), 100);
    window.addEventListener("keydown", this.onKey);
    this.addLog(this.bootLogMessage(), "system");
    void this.loadDevices();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.clock) clearInterval(this.clock);
    if (this.meter) clearInterval(this.meter);
    this.clock = this.meter = null;
    if (this.themeTimer) clearTimeout(this.themeTimer);
    this.themeTimer = null;
    if (this.agentWait) clearTimeout(this.agentWait);
    this.agentWait = null;
    window.removeEventListener("keydown", this.onKey);
    navigator.mediaDevices?.removeEventListener?.("devicechange", this.onDeviceChange);
    this.disposeVoiceBlob();
  }

  private readonly onDeviceChange = (): void => void this.loadDevices(true);

  protected firstUpdated(): void {
    this.applyBlobColors();
    this.mountVoiceBlob();
    // Re-read shortly after boot (saved colours may land after the first paint).
    this.themeTimer = setTimeout(() => this.applyBlobColors(), 1500);
  }

  /** Saved colours win; otherwise the holographic terminal's champagne light. */
  private applyBlobColors(): void {
    const theme = HOLO_BLOB_COLORS;
    const hex = (v: string | null, fallback: string) => (v && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback);
    const user = hex(read(KEY.userColor), theme.user);
    const agent = hex(read(KEY.agentColor), theme.agent);
    if (user === this.blobUserColor && agent === this.blobAgentColor) return;
    this.blobUserColor = user;
    this.blobAgentColor = agent;
    this.voiceBlob?.setColors(user, agent);
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("call")) this.logCallChange(changed.get("call") as CallState | undefined, this.call);
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has("call")) {
      const t = this.renderRoot.querySelector(".transcript-content");
      if (t) t.scrollTop = t.scrollHeight;
      const l = this.renderRoot.querySelector(".log-content");
      if (l) l.scrollTop = l.scrollHeight;
    }
    // The blob host can be re-created by Lit (WebGL ↔ CSS orb switch): remount.
    if (this.blobEnabled) {
      const host = this.renderRoot.querySelector(".webgl-blob-host");
      if (host && (!this.voiceBlob || host.childElementCount === 0)) {
        this.disposeVoiceBlob();
        this.mountVoiceBlob();
      }
    } else if (this.voiceBlob) {
      this.disposeVoiceBlob();
    }
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key !== "e" && e.key !== "E") return;
    if (e.metaKey || e.ctrlKey || e.altKey || !this.isConnected || this.offsetParent === null) return;
    const t = e.composedPath()[0] as HTMLElement | undefined;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (this.connected || this.isConnecting) this.emit("session-disconnect");
    else this.emit("session-connect");
  };

  // ── derived ───────────────────────────────────────────────────────────────

  private get connected(): boolean {
    return this.call.phase === "active";
  }
  private get isConnecting(): boolean {
    return this.call.phase === "starting" || this.call.phase === "connecting";
  }
  private get agentName(): string {
    const id = this.call.agentId ?? this.agentId;
    return this.agents.find((a) => a.id === id)?.name ?? "Agent";
  }

  private drive(levels: RoomLevels = this.frame): BlobDrive {
    return blobDrive({
      connected: this.connected,
      muted: this.muted,
      agentState: this.call.agentState,
      mic: levels.mic,
      agentLevel: levels.agentLevel,
      userSpeaking: levels.userSpeaking,
      agentSpeaking: levels.agentSpeaking,
    });
  }

  private get liveInput(): LivePipelineInput {
    return {
      agentState: this.call.agentState,
      latency: this.call.latency,
      tool: this.call.tool,
      pipeline: this.pipeline,
      pipelineLoaded: this.pipelineLoaded,
      inCall: callInProgress(this.call),
      language: this.call.language?.label ?? null,
    };
  }

  private get local(): boolean {
    return this.engine === "local";
  }

  private emit(name: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  // ── logs ──────────────────────────────────────────────────────────────────

  /** Context-aware boot message — reflects the actual call state on (re)connect, not a static string. */
  private bootLogMessage(): string {
    if (this.overlay) return this.local ? "Voice page ready." : "Voice page ready — connect Robovoice to start.";
    const phase = this.call.phase;
    if (phase === "active") {
      if (this.call.media !== "connected") return "Voice session active — waiting for call audio.";
      if (agentPending(this.call)) return `Voice session active — ${this.agentName} is joining…`;
      if (this.muted) return "Voice session active — mic is muted.";
      return `Voice session active with ${this.agentName}.`;
    }
    if (phase === "starting") return this.local ? `Starting local voice with ${this.agentName}…` : `Calling ${this.agentName} on Robovoice…`;
    if (phase === "connecting") return this.call.mode === "device" ? "Opening the microphone…" : this.call.mode === "local" ? "Robovoice Desktop is taking the call" : "Robovoice cloud call is connecting…";
    if (phase === "ending") return "Ending call…";
    if (phase === "failed") return this.call.error ?? "Call failed.";
    if (phase === "ended") return "Call ended.";
    if (this.blockedReason) return `Voice ready — ${this.blockedReason}`;
    return `Voice ready — connect to call ${this.agentName}.`;
  }

  private addLog(text: string, type: LogEntry["type"] = "info"): void {
    this.logs = [...this.logs, { text, type, timestamp: Date.now() }].slice(-200);
  }

  /** The system log narrates the real call: every line is a state the call reported. */
  private logCallChange(prev: CallState | undefined, next: CallState): void {
    if (!prev) return;
    if (prev.phase !== next.phase) {
      if (next.phase === "starting") this.addLog(this.local ? `Starting local voice with ${this.agentName}…` : `Calling ${this.agentName} on Robovoice…`);
      else if (next.phase === "connecting") this.addLog(next.mode === "device" ? "Local voice: speech-to-text and text-to-speech on this machine" : next.mode === "local" ? `Robovoice Desktop took the call${next.desktopName ? ` (${next.desktopName})` : ""}` : "Robovoice cloud call started");
      else if (next.phase === "active") this.addLog("Voice bridge active", "success");
      else if (next.phase === "ending") this.addLog("Ending call…");
      else if (next.phase === "ended") this.addLog("Call ended");
      else if (next.phase === "failed") this.addLog(next.error ?? "Call failed", "error");
    }
    if (prev.media !== next.media) {
      if (next.media === "connected") {
        this.addLog(next.mode === "device" ? "Microphone open" : "LiveKit audio joined", "success");
        if (agentPending(next) && next.mode !== "device") this.addLog("Waiting for the Robovoice agent to join…");
        this.watchForAgent();
      }
      else if (next.media === "unavailable") this.addLog(`Browser audio unavailable: ${next.mediaError ?? "unknown"}`, "warn");
    }
    if (prev.playback !== next.playback) {
      if (next.playback === "playing") this.addLog("Agent audio playing", "success");
      else if (next.playback === "blocked") this.addLog("Audio blocked — tap to enable", "warn");
    }
    if (!prev.audioIn && next.audioIn) this.addLog("Agent voice audio received", "success");
    if (next.output && next.output !== prev.output) {
      if (next.output.routed === "fallback-default") this.addLog("Chosen speaker is unavailable — playing on the system default", "warn");
      else if (next.output.routed === "applied" && next.output.deviceId) this.addLog(`Output: ${this.speakerLabel(next.output.deviceId)}`);
    }
    if (next.silentReplies > prev.silentReplies && next.ttsFault) {
      this.addLog(
        `No voice audio for the agent's reply — ${next.mode === "device" ? "local text-to-speech" : "Robovoice's speech step"} produced nothing${next.ttsFault.fallback ? "; spoken with the browser's fallback voice" : ""}`,
        "error",
      );
    }
    // Once the audio joined after the devices were listed without labels, list them again (labels need mic permission).
    if (prev.media !== "connected" && next.media === "connected") void this.loadDevices(true);
    if (agentPending(prev) && !agentPending(next) && next.phase === "active" && next.agentState) {
      this.addLog(`${this.agentName} joined — ${next.agentState}`, "success");
    }
    // A turn that goes thinking → listening never reached the voice: the agent
    // answered nothing out loud (on Robovoice: the speech step failed, or the turn was dropped).
    if (prev.agentState === "thinking" && next.agentState === "listening") {
      this.addLog(`${this.agentName} went back to listening without speaking`, "warn");
    }
    if (next.latency.length > prev.latency.length) {
      const s = next.latency[next.latency.length - 1];
      this.addLog(`Turn ${s.totalMs} ms${s.sttToLlmMs != null ? ` · STT→LLM ${s.sttToLlmMs}` : ""}${s.llmToTtsMs != null ? ` · LLM→TTS ${s.llmToTtsMs}` : ""}`);
    }
    if (next.tool?.used && next.tool.names.length && next.tool !== prev.tool) this.addLog(`Tool: ${next.tool.names.join(", ")}`);
  }

  // ── devices ───────────────────────────────────────────────────────────────

  private async loadDevices(quiet = false): Promise<void> {
    try {
      const { inputs, outputs } = splitDevices(await navigator.mediaDevices.enumerateDevices());
      this.microphones = inputs;
      this.speakers = outputs;
      // A saved device that was unplugged: keep the choice (it may come back) but use the default now.
      const prefs = loadAudioPrefs();
      const mic = resolveDevice(prefs.micDeviceId, inputs);
      const speaker = resolveDevice(prefs.outputDeviceId, outputs);
      const was = this.missingDevice;
      this.missingDevice = { mic: mic.missing, speaker: speaker.missing };
      this.selectedMicrophone = mic.deviceId || (inputs[0]?.deviceId ?? "");
      this.selectedSpeaker = speaker.deviceId;
      if (mic.missing && !was.mic) this.addLog("Saved microphone is not connected — using the default", "warn");
      if (speaker.missing && !was.speaker) {
        this.addLog("Saved speaker is not connected — using the system default", "warn");
        this.emit("session-output", { deviceId: "", volume: this.outputVolume });
      } else if (!speaker.missing && was.speaker) {
        this.addLog(`Speaker is back: ${this.speakerLabel(speaker.deviceId)}`, "success");
        this.emit("session-output", { deviceId: speaker.deviceId, volume: this.outputVolume });
      }
      if (!quiet) this.addLog(`Found ${inputs.length} mic${inputs.length === 1 ? "" : "s"}, ${outputs.length} speaker${outputs.length === 1 ? "" : "s"}`);
    } catch {
      if (!quiet) this.addLog("Audio device list unavailable", "warn");
    }
    this.devicesLoaded = true;
  }

  private speakerLabel(id: string): string {
    return this.speakers.find((d) => d.deviceId === id)?.label ?? (id ? "selected speaker" : "System default");
  }

  private selectMicrophone(id: string): void {
    this.selectedMicrophone = id;
    this.missingDevice = { ...this.missingDevice, mic: false };
    saveAudioPrefs({ micDeviceId: id });
    this.addLog(`Mic: ${this.microphones.find((m) => m.deviceId === id)?.label ?? "default"}`);
    // Mid-call the switch is live; otherwise the next call uses it.
    if (callInProgress(this.call)) this.emit("session-mic-device", { deviceId: id });
  }

  private selectSpeaker(id: string): void {
    this.selectedSpeaker = id;
    this.missingDevice = { ...this.missingDevice, speaker: false };
    saveAudioPrefs({ outputDeviceId: id });
    this.addLog(`Speaker: ${this.speakerLabel(id)}`);
    this.emit("session-output", { deviceId: id, volume: this.outputVolume });
  }

  private setVolume(v: number): void {
    this.outputVolume = v;
    saveAudioPrefs({ volume: v });
    this.emit("session-output", { deviceId: this.selectedSpeaker, volume: v });
  }

  private setFallbackVoice(on: boolean): void {
    this.fallbackVoice = on;
    saveAudioPrefs({ fallbackVoice: on });
  }

  /** Firefox: speakers are only listed after its own picker grants one. */
  private async chooseSpeaker(): Promise<void> {
    const picked = await promptForOutput();
    if (!picked) return;
    await this.loadDevices(true);
    this.selectSpeaker(picked.deviceId);
  }

  private async testSound(): Promise<void> {
    if (this.toneState === "playing") return;
    this.toneState = "playing";
    const r = await playTestTone({ deviceId: this.selectedSpeaker, volume: this.outputVolume });
    this.toneState = r.ok ? "ok" : "failed";
    if (!r.ok) this.addLog(`Test sound failed: ${r.error ?? "unknown"}`, "error");
    else if (r.routed === "fallback-default") this.addLog("Test sound played on the system default (chosen speaker unavailable)", "warn");
    else this.addLog(`Test sound played on ${this.speakerLabel(r.routed === "applied" ? this.selectedSpeaker : "")}`, "success");
    setTimeout(() => (this.toneState = "idle"), 2500);
  }

  /** Say so in the log when the agent still isn't in the room well past a normal cold start. */
  private watchForAgent(): void {
    if (this.agentWait) clearTimeout(this.agentWait);
    this.agentWait = setTimeout(() => {
      this.agentWait = null;
      if (agentPending(this.call)) this.addLog("The Robovoice agent has not joined after 30 s — it may be down; end the call and retry", "warn");
    }, AGENT_JOIN_WARN_MS);
  }

  // ── levels + blob ─────────────────────────────────────────────────────────

  private mirrorLevels(): void {
    // The blob's rAF loop samples the room each frame; with the WebGL blob off
    // (CSS orb) nothing else does, so sample here.
    if (!this.voiceBlob) this.frame = this.connected ? this.levels() : SILENT_ROOM;
    const f = this.frame;
    if (!this.connected && this.micLevel === 0 && this.agentLevel === 0 && !this.userSpeaking && !this.agentSpeaking) return;
    this.micLevel = f.mic.level;
    this.micLevels = f.mic.bars;
    this.micBass = f.mic.bass;
    this.micTreble = f.mic.treble;
    this.agentLevel = f.agentLevel;
    this.userSpeaking = f.userSpeaking;
    this.agentSpeaking = f.agentSpeaking || this.call.agentState === "speaking";
  }

  private mountVoiceBlob(): void {
    if (!this.blobEnabled || this.voiceBlob) return;
    const host = this.renderRoot?.querySelector?.(".webgl-blob-host") as HTMLElement | null;
    if (!host) return;
    try {
      this.voiceBlob = new VoiceBlob(host, { style: this.blobStyle, userColor: this.blobUserColor, agentColor: this.blobAgentColor });
      const tick = (t: number) => {
        if (!this.voiceBlob) return;
        this.frame = this.connected ? this.levels() : SILENT_ROOM;
        const d = this.drive();
        this.voiceBlob.setState(d.state);
        this.voiceBlob.update(d.dominant, t, d.bass, d.treble, d.user, d.agent);
        this.style.setProperty("--vc-blob-energy", d.dominant.toFixed(3));
        this.blobRafId = requestAnimationFrame(tick);
      };
      this.blobRafId = requestAnimationFrame(tick);
    } catch (e) {
      console.warn("VoiceBlob mount failed:", e);
      this.voiceBlob = null;
    }
  }

  private disposeVoiceBlob(): void {
    if (this.blobRafId != null) cancelAnimationFrame(this.blobRafId);
    this.blobRafId = null;
    try {
      this.voiceBlob?.dispose();
    } catch {
      /* ignore */
    }
    this.voiceBlob = null;
  }

  private setBlobStyle(style: BlobStyle): void {
    this.blobStyle = style;
    write(KEY.blobStyle, style);
    this.voiceBlob?.setStyle(style);
  }
  private readonly toggleBlobEnabled = (): void => {
    this.blobEnabled = !this.blobEnabled;
    write(KEY.blobEnabled, String(this.blobEnabled));
  };
  private readonly toggleBlobPicker = (): void => {
    this.blobPickerOpen = !this.blobPickerOpen;
  };
  private toggleBlobSection(section: "style" | "colors" | "visualizer"): void {
    this.blobOpenSection = this.blobOpenSection === section ? null : section;
  }
  private setBlobColor(which: "user" | "agent", hexColor: string): void {
    if (!/^#[0-9a-f]{6}$/i.test(hexColor)) return;
    if (which === "user") {
      this.blobUserColor = hexColor;
      write(KEY.userColor, hexColor);
    } else {
      this.blobAgentColor = hexColor;
      write(KEY.agentColor, hexColor);
    }
    this.voiceBlob?.setColors(this.blobUserColor, this.blobAgentColor);
  }
  private readonly resetBlobColors = (): void => {
    const theme = HOLO_BLOB_COLORS;
    this.setBlobColor("user", theme.user);
    this.setBlobColor("agent", theme.agent);
  };

  private setHud(on: boolean): void {
    this.floatingHudMode = on;
    write(KEY.hud, on ? "1" : "0");
  }
  private readonly toggleRightPanel = (): void => {
    this.rightPanelCollapsed = !this.rightPanelCollapsed;
    write(KEY.rightCollapsed, this.rightPanelCollapsed ? "1" : "0");
  };

  private toggleConnect(): void {
    this.emit(this.connected || this.isConnecting ? "session-disconnect" : "session-connect");
  }

  // ── HUD snapshot ──────────────────────────────────────────────────────────

  private hudSnap: HudCallSnapshot | null = null;
  private hudSnapKey = "";

  /**
   * The call facts the HUD panels render. Memoised on its inputs: this view
   * re-renders every audio frame (mic level), and a fresh object each frame
   * would re-render every HUD panel with it. The live mic level reaches the
   * panel meter through a CSS variable instead (voice-floating-hud).
   */
  private hudSnapshot(): HudCallSnapshot {
    const c = this.call;
    const key = [
      c.phase, c.mode, c.agentId, c.agentState, c.error, c.transcript.length, c.transcript[c.transcript.length - 1]?.text ?? "",
      c.latency.length, c.tool?.names.join(",") ?? "", this.engine, this.voiceRoute, this.muted, this.blockedReason, this.agentId,
      this.agents.length, this.pipeline ? JSON.stringify(this.pipeline) : "", this.pipelineLoaded,
    ].join("|");
    if (this.hudSnap && key === this.hudSnapKey) return this.hudSnap;
    this.hudSnapKey = key;
    this.hudSnap = {
      phase: c.phase,
      engine: this.engine,
      mode: c.mode,
      agentName: this.agentName,
      voiceRoute: this.voiceRoute,
      muted: this.muted,
      agentState: c.agentState,
      blockedReason: this.blockedReason,
      error: c.error,
      connected: this.connected,
      agents: this.agents,
      agentId: c.agentId ?? this.agentId,
      transcript: c.transcript.map((l) => ({ id: l.id, who: l.who, text: l.text, at: l.at })),
      pipeline: this.liveInput,
    };
    return this.hudSnap;
  }

  // ── render ────────────────────────────────────────────────────────────────

  render() {
    const d = this.drive(this.frame);
    const ai = aiState(d);
    const stateClass = ai === "speaking" ? "speaking" : ai === "thinking" ? "thinking" : "";
    // Audio is up but the agent isn't listening yet: don't invite the caller to speak.
    const waiting = agentPending(this.call);
    const hasErrors = this.logs.some((l) => l.type === "error");
    const messages = this.call.transcript.map((l) => ({ role: l.who === "you" ? "user" : "assistant", text: l.text, timestamp: l.at }));
    const swatch = BLOB_STYLES.find((s) => s.id === this.blobStyle)?.swatch ?? ["#fff", "#fff"];

    return html`
      ${this.call.playback === "blocked" && callInProgress(this.call)
        ? html`<button class="vs-audio-unlock" data-testid="voice-session-enable-audio" @click=${() => this.emit("session-enable-audio")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
              <line x1="23" y1="9" x2="17" y2="15"></line>
              <line x1="17" y1="9" x2="23" y2="15"></line>
            </svg>
            <span><b>Tap to enable audio</b><small>Your browser blocked the agent's voice</small></span>
          </button>`
        : nothing}
      ${this.call.ttsFault && callInProgress(this.call) && this.call.playback !== "blocked"
        ? html`<div class="vs-tts-fault" role="alert" data-testid="voice-session-tts-fault">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
              <line x1="12" y1="9" x2="12" y2="13"></line>
              <line x1="12" y1="17" x2="12.01" y2="17"></line>
            </svg>
            <span>
              <b>${this.local ? "No voice audio from local text-to-speech" : "No voice audio from Robovoice"}</b>
              <small>${this.agentName} answered in text, but the speech step (${this.pipeline?.tts?.provider ? prettyProvider(this.pipeline.tts.provider) : "TTS"}) sent no audio.
                ${this.call.ttsFault.fallback ? "Spoken with this browser's fallback voice." : "Fallback voice is off — read the reply in the transcript."}</small>
            </span>
          </div>`
        : nothing}
      ${this.floatingHudMode
        ? html`
            <voice-floating-hud
              .micLevel=${this.micLevel}
              .isUserSpeaking=${this.userSpeaking}
              .isAgentSpeaking=${this.agentSpeaking}
              .isProcessing=${ai === "thinking"}
              .micBass=${this.micBass}
              .micTreble=${this.micTreble}
              .agentLevel=${this.agentLevel}
              .blobStyle=${this.blobStyle}
              .blobUserColor=${this.blobUserColor}
              .blobAgentColor=${this.blobAgentColor}
              .gatewayClient=${this.client}
              .call=${this.hudSnapshot()}
              @exit-hud=${() => this.setHud(false)}
            ></voice-floating-hud>
            <voice-controls-dock
              data-hud-region="dock"
              .connected=${this.connected}
              .isConnecting=${this.isConnecting}
              .isMuted=${this.muted}
              .isUserSpeaking=${this.userSpeaking}
              .isAgentSpeaking=${this.agentSpeaking}
              .agents=${this.agents}
              .agentId=${this.agentId}
              .connectBlocked=${this.blockedReason ?? ""}
              @connect=${() => this.emit("session-connect")}
              @disconnect=${() => this.emit("session-disconnect")}
              @toggle-mute=${() => this.emit("session-mute")}
              @toggle-blob=${this.toggleBlobPicker}
              @toggle-settings=${() => this.emit("session-settings")}
              @toggle-hud=${() => this.setHud(!this.floatingHudMode)}
              @agent-change=${(e: CustomEvent) => this.emit("session-agent", { id: e.detail?.id })}
              @exit-hud=${() => this.setHud(false)}
            ></voice-controls-dock>
          `
        : nothing}
      <div class="hud-container hx-holo ${this.rightPanelCollapsed ? "right-collapsed" : ""} ${this.floatingHudMode ? "floating-hud-on" : ""}" data-testid="voice-session" data-state=${ai}>
        <div class="hud-frame-corners">
          <span class="corner-mark tl"></span>
          <span class="corner-mark tr"></span>
          <span class="corner-mark bl"></span>
          <span class="corner-mark br"></span>
        </div>

        <!-- HEADER -->
        <div class="hud-header" data-learn-id="voice-header">
          <div class="header-left">
            <div class="system-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                <line x1="12" y1="19" x2="12" y2="23"></line>
                <line x1="8" y1="23" x2="16" y2="23"></line>
              </svg>
              VOICE TERMINAL
            </div>
            <div class="status-badges">
              <div class="status-badge ${this.connected ? "live" : ""}" data-testid="voice-session-live">
                <status-indicator tone=${this.connected ? "ok" : "idle"} ?pulse=${this.connected}></status-indicator>
                ${this.connected ? "LIVE" : "OFFLINE"}
              </div>
              <div class="status-badge active" data-testid="voice-session-engine" title=${this.local ? "Voice runs on this machine (local speech-to-text and text-to-speech)" : this.account ? `Robovoice · ${this.account}` : "Voice runs on Robovoice"}>
                <status-indicator tone="active"></status-indicator>
                ${this.local ? "LOCAL" : "ROBOVOICE"}
              </div>
              ${this.call.mode === "local" && callInProgress(this.call)
                ? html`<div class="status-badge active"><span class="status-dot"></span>DESKTOP</div>`
                : nothing}
            </div>
          </div>

          <div class="hx-brand" aria-hidden="true">
            <span class="hx-brand-mark">INFINI</span>
            <span class="hx-brand-sub">VOICE INTELLIGENCE TERMINAL</span>
          </div>

          <div class="header-controls">
            <div class="system-time">${this.systemTime}</div>
            <button
              class="ctrl-btn hud-toggle-btn ${this.floatingHudMode ? "active" : ""}"
              data-learn-id="voice-hud-toggle"
              data-testid="voice-hud-toggle"
              title=${this.floatingHudMode ? "Exit Holographic HUD" : "Enter Holographic HUD"}
              @click=${() => this.setHud(!this.floatingHudMode)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26" stroke="none" />
              </svg>
              HUD
            </button>
            <button class="ctrl-btn" data-learn-id="voice-settings" title="Pipeline & voice settings" @click=${() => this.emit("session-settings")}>${icons.settings}</button>
          </div>
        </div>

        <!-- FREE-FLOATING CONTROL PILLS -->
        <div class="vc-floating-pills" role="toolbar" aria-label="Voice controls" data-learn-id="voice-pills">
          <hud-capsule ?lit=${this.connected}><button
            class="vc-pill ${this.connected ? "is-live" : ""}"
            data-testid="voice-session-connect-pill"
            ?disabled=${this.call.phase === "ending" || (!this.connected && !this.isConnecting && !!this.blockedReason)}
            title=${this.connected ? (this.local ? "End the voice session" : "End the Robovoice call") : (this.blockedReason ?? (this.local ? "Start a local voice session" : "Start a Robovoice call"))}
            @click=${() => this.toggleConnect()}
          >
            <span class="vc-pill-dot ${this.connected ? "live" : ""}"></span>
            ${this.isConnecting ? "Connecting…" : this.connected ? "Connected" : "Connect"}
          </button></hud-capsule>
          <hud-capsule><button class="vc-pill ${this.muted ? "is-off" : ""}" ?disabled=${!this.connected} title=${this.muted ? "Unmute microphone" : "Mute microphone"} @click=${() => this.emit("session-mute")}>
            <span class="vc-pill-dot ${this.muted || !this.connected ? "" : "live"}"></span>
            ${this.muted ? "Muted" : "Mic"}
          </button></hud-capsule>
          <hud-capsule><div class="vc-pill vc-pill--select" title="Voice agent to call">${this.renderAgentSelect()}</div></hud-capsule>
          <!-- What answers this call: API LLM or the routed CLI session (<voice-cli-route-control variant="pill">). -->
          <hud-capsule><div class="vc-pill vc-pill--route" data-testid="voice-session-route"><slot name="route"></slot></div></hud-capsule>
        </div>

        <!-- LEFT: Transcript (top) + System Log (bottom) -->
        <div class="panel-left glass-panel" data-learn-id="voice-transcript">
          <div class="vc-left-transcript">
            <hud-corners size="16"></hud-corners>
            <div class="panel-header" style="gap:8px;">
              <div class="panel-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
                Transcript
              </div>
              <button class="vc-model-settings-btn" style="margin-left:auto;" title="Pipeline & voice settings" aria-label="Pipeline settings" @click=${() => this.emit("session-settings")}>
                ${icons.settings}
              </button>
              <div class="panel-badge">${messages.length}</div>
            </div>
            <div class="transcript-content" role="log" aria-live="polite" aria-label="Voice conversation transcript" data-testid="voice-transcript">
              ${messages.length === 0
                ? html`<div class="empty-state">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <circle cx="12" cy="12" r="10"></circle>
                      <path d="M8 12h8M12 8v8"></path>
                    </svg>
                    <span data-testid="voice-transcript-empty">${transcriptEmptyText({
                      phase: this.call.phase,
                      media: this.call.media,
                      agentState: this.call.agentState,
                      muted: this.muted,
                      agentName: this.agentName,
                      blockedReason: this.blockedReason,
                    })}</span>
                  </div>`
                : messages.map(
                    (msg, i) => html`<transcript-message
                      class="message ${msg.role}"
                      speaker=${msg.role === "user" ? "user" : "agent"}
                      name=${msg.role === "user" ? "You" : this.agentName}
                      time=${new Date(msg.timestamp).toLocaleTimeString("en-US", { hour12: false })}
                      .text=${msg.text}
                      ?live=${msg.role !== "user" && i === messages.length - 1 && this.agentSpeaking}
                    ></transcript-message>`,
                  )}
            </div>
            <div class="hx-convo-status ${this.connected ? "live" : ""}" aria-hidden="true">
              <b>∞</b>${this.connected ? "Realtime conversation…" : this.isConnecting ? "Opening channel…" : "Conversation standby"}
              <span class="hx-convo-wave">${[0, 1, 2, 3, 4, 5, 6].map(() => html`<i></i>`)}</span>
            </div>
          </div>
          <div class="vc-left-splitter" role="separator" aria-orientation="horizontal"></div>
          <div class="vc-left-log"><hud-corners corners="tl br" size="12" tone="ghost"></hud-corners>${this.renderLogSection()}</div>
        </div>

        <div class="vc-col-splitter" role="separator" aria-orientation="vertical"></div>

        <!-- CENTER: voice blob -->
        <div class="panel-center holo-active">
          <div class="video-hud-overlay">
            <div class="center-scanlines"></div>
            <div class="center-vignette"></div>
            <div class="center-corners">
              <div class="corner tl"></div>
              <div class="corner tr"></div>
              <div class="corner bl"></div>
              <div class="corner br"></div>
            </div>
          </div>

          ${this.renderNotice()}

          <div class="orb-container ${stateClass} ${this.blobEnabled ? "webgl-mode" : ""}">
            ${this.blobEnabled
              ? html`<voice-core state=${ai} ?live=${this.connected}><div class="webgl-blob-host"></div></voice-core>`
              : html`<div class="thinking-particles">
                    ${[0, 1, 2, 3, 4, 5].map(() => html`<div class="thinking-particle"></div>`)}
                  </div>
                  <div class="inner-pulse"></div>
                  <div class="sound-wave"></div>
                  <div class="sound-wave"></div>
                  <div class="sound-wave"></div>
                  <div class="ring ring-1"></div>
                  <div class="ring ring-2"></div>
                  <div class="ring ring-3"></div>
                  <div class="orb ${stateClass}"></div>`}

            ${this.connected
              ? html`<div class="orb-status-label ${ai}">
                  ${waiting ? "◎ AGENT JOINING" : ai === "speaking" ? "◉ SPEAKING" : ai === "thinking" ? "◎ THINKING" : ai === "listening" ? "○ LISTENING" : "○ STANDBY"}
                </div>`
              : nothing}

            ${this.blobEnabled
              ? html`<div class="blob-style-controls">
                  <button class="blob-style-toggle" @click=${this.toggleBlobPicker} title="Visualizer settings">
                    <span class="blob-style-dot" style="background: linear-gradient(135deg, ${swatch[0]}, ${swatch[1]})"></span>
                  </button>
                  ${this.blobPickerOpen ? this.renderBlobPanel() : nothing}
                </div>`
              : html`<div class="blob-style-controls">
                  <button class="blob-style-toggle" @click=${this.toggleBlobEnabled} title="Switch to premium WebGL blob">
                    <span class="blob-style-dot off-swatch" style="background: rgba(255,255,255,0.08);border:1px dashed rgba(255,255,255,0.25);font-size:8px;font-weight:700;color:rgba(255,255,255,0.7);display:inline-flex;align-items:center;justify-content:center;">3D</span>
                  </button>
                </div>`}
          </div>

          <div class="status-display">
            <div class="status-text ${ai}" data-testid="voice-session-status">
              ${this.isConnecting ? "CONNECTING..." : waiting ? "AGENT JOINING..." : ai === "speaking" ? "TRANSMITTING" : ai === "thinking" ? "PROCESSING" : this.connected ? (this.muted ? "MUTED" : "LISTENING") : "STANDBY"}
            </div>
            <div class="status-sub">
              ${waiting
                ? (this.local ? "Starting • speak once it is listening" : "Robovoice is starting the agent • speak once it is listening")
                : this.connected
                ? "Voice bridge active • Press E to disconnect"
                : this.overlay
                  ? (this.local ? "Local voice" : "Voice runs on Robovoice")
                  : (this.blockedReason ?? "Press E or CONNECT to initialize")}
            </div>
          </div>

          ${this.overlay ? html`<div class="vs-overlay"><slot name="overlay"></slot></div>` : nothing}
        </div>

        <!-- RIGHT: System modules -->
        <div class="panel-right glass-panel" data-learn-id="voice-system">
          <div class="panel-header">
            <div class="panel-title">${icons.settings} System</div>
            <div class="panel-badge ${hasErrors ? "has-errors" : ""}">${this.logs.length} log${this.logs.length === 1 ? "" : "s"}</div>
            <button
              class="right-panel-collapse-btn"
              title=${this.rightPanelCollapsed ? "Expand system panel" : "Collapse system panel"}
              aria-label=${this.rightPanelCollapsed ? "Expand system panel" : "Collapse system panel"}
              aria-expanded=${!this.rightPanelCollapsed}
              @click=${this.toggleRightPanel}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                ${this.rightPanelCollapsed ? svg`<polyline points="15 18 9 12 15 6"></polyline>` : svg`<polyline points="9 18 15 12 9 6"></polyline>`}
              </svg>
            </button>
          </div>
          <div class="right-panel-content">${this.renderSystemModules()}</div>
        </div>

        <!-- FOOTER: controls -->
        <div class="hud-footer" data-learn-id="voice-footer">
          <div class="control-group">
            ${!this.connected && !this.isConnecting
              ? html`<glow-button><button class="ctrl-btn primary" data-testid="voice-session-connect" ?disabled=${!!this.blockedReason} title=${this.blockedReason ?? (this.local ? "Start a local voice session" : "Start a Robovoice call")} @click=${() => this.emit("session-connect")}>CONNECT</button></glow-button>`
              : html`<glow-button tone="danger"><button class="ctrl-btn danger" data-testid="voice-session-disconnect" ?disabled=${this.call.phase === "ending"} @click=${() => this.emit("session-disconnect")}>
                  ${this.isConnecting ? "CANCEL" : this.call.phase === "ending" ? "ENDING..." : "DISCONNECT"}
                </button></glow-button>`}
            <hud-capsule>${this.renderAgentSelect("vs-agent-select")}</hud-capsule>
          </div>

          <div class="divider"></div>
          <div class="mic-btn-wrapper ${this.userSpeaking ? "active" : ""}">
            <mic-reactor ?active=${this.userSpeaking} ?muted=${this.muted && this.connected} ?live=${this.connected}><button
              class="mic-btn ${this.muted ? "muted" : ""} ${this.userSpeaking ? "speaking" : ""}"
              data-testid="voice-session-mic"
              ?disabled=${!this.connected}
              @click=${() => this.emit("session-mute")}
              title=${!this.connected ? "Microphone — live during a call" : this.muted ? "Unmute mic" : "Mute mic"}
            >
              ${this.muted
                ? html`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="1" y1="1" x2="23" y2="23"></line>
                    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path>
                    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>
                    <line x1="12" y1="19" x2="12" y2="23"></line>
                    <line x1="8" y1="23" x2="16" y2="23"></line>
                  </svg>`
                : MIC_SVG}
            </button></mic-reactor>
            ${this.connected ? html`<span class="mic-label">${this.muted ? "MUTED" : "LIVEKIT"}</span>` : nothing}
          </div>

          <div class="divider"></div>
          <div class="control-group">
            <hud-capsule ?lit=${this.floatingHudMode}><button class="ctrl-btn ${this.floatingHudMode ? "active" : ""}" @click=${() => this.setHud(!this.floatingHudMode)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26" stroke="none" /></svg>
              HUD
            </button></hud-capsule>
            <hud-capsule><button class="ctrl-btn" @click=${() => this.emit("session-settings")}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"></path><circle cx="16" cy="6" r="2"></circle><circle cx="10" cy="12" r="2"></circle><circle cx="18" cy="18" r="2"></circle></svg>
              PIPELINE
            </button></hud-capsule>
          </div>
        </div>
      </div>
    `;
  }

  private renderAgentSelect(cls = "") {
    const busy = callInProgress(this.call);
    return html`<select
      class=${cls}
      aria-label="Voice agent"
      data-testid="voice-session-agent"
      ?disabled=${busy || this.agents.length === 0}
      @change=${(e: Event) => this.emit("session-agent", { id: (e.target as HTMLSelectElement).value })}
    >
      ${this.agents.length === 0 ? html`<option value="">No voice agents</option>` : nothing}
      ${this.agents.map((a) => html`<option value=${a.id} ?selected=${a.id === this.agentId}>${a.name}</option>`)}
    </select>`;
  }

  private renderNotice() {
    if (this.overlay) return nothing;
    const c = this.call;
    // Cloud voice refused (fair-use limit / busy): never a top-up, a one-click switch to local voice.
    const busy = this.engine !== "local" && (c.phase === "failed" || c.media === "unavailable") && isCloudVoiceBusy(c.error ?? c.mediaError);
    if (busy) {
      return html`<div class="vs-notice" data-testid="voice-cloud-busy">
        <b>Cloud voice is busy</b><span>${CLOUD_VOICE_BUSY_TEXT}</span>
        <button class="vs-switch" data-testid="voice-switch-local"
          @click=${() => this.dispatchEvent(new CustomEvent("session-switch-local", { bubbles: true, composed: true }))}>Switch to local voice</button>
      </div>`;
    }
    if (c.phase === "failed" && c.error) {
      return html`<div class="vs-notice error" data-testid="voice-session-error"><b>Call failed</b><span>${c.error}</span></div>`;
    }
    if (c.media === "unavailable" && callInProgress(c)) {
      return html`<div class="vs-notice" data-testid="voice-session-media"><b>No browser audio</b><span>${c.mediaError ?? "This browser couldn't join the call audio."}</span></div>`;
    }
    if (c.mode === "local" && callInProgress(c)) {
      return html`<div class="vs-notice" data-testid="voice-session-desktop"><b>On Robovoice Desktop</b><span>${c.desktopName ?? "Your desktop"} is running this call — speak there.</span></div>`;
    }
    return nothing;
  }

  private renderBlobPanel() {
    return html`<div class="blob-settings-panel">
      <div class="blob-settings-header">
        <span class="blob-settings-title">Visualizer</span>
        <button class="blob-settings-close" @click=${this.toggleBlobPicker} title="Close">✕</button>
      </div>
      <div class="blob-section">
        <button class="blob-section-head ${this.blobOpenSection === "style" ? "open" : ""}" @click=${() => this.toggleBlobSection("style")}>
          <span class="chevron">▸</span>
          <span class="section-name">Style</span>
          <span class="section-summary">${BLOB_STYLES.find((s) => s.id === this.blobStyle)?.label ?? ""}</span>
        </button>
        ${this.blobOpenSection === "style"
          ? html`<div class="blob-section-body">
              <div class="blob-style-grid">
                ${BLOB_STYLES.map(
                  (s) => html`<button class="blob-style-item ${s.id === this.blobStyle ? "selected" : ""}" @click=${() => this.setBlobStyle(s.id)} title=${s.label}>
                    <span class="blob-style-swatch" style="background: linear-gradient(135deg, ${s.swatch[0]}, ${s.swatch[1]})"></span>
                    <span class="blob-style-label">${s.label}</span>
                  </button>`,
                )}
              </div>
            </div>`
          : nothing}
      </div>
      <div class="blob-section">
        <button class="blob-section-head ${this.blobOpenSection === "colors" ? "open" : ""}" @click=${() => this.toggleBlobSection("colors")}>
          <span class="chevron">▸</span>
          <span class="section-name">Colors</span>
          <span class="section-summary" style="display:flex;gap:4px;align-items:center;">
            <span style="width:10px;height:10px;border-radius:50%;background:${this.blobUserColor};border:1px solid rgba(255,255,255,0.2);"></span>
            <span style="width:10px;height:10px;border-radius:50%;background:${this.blobAgentColor};border:1px solid rgba(255,255,255,0.2);"></span>
          </span>
        </button>
        ${this.blobOpenSection === "colors"
          ? html`<div class="blob-section-body">
              <div class="blob-color-row">
                <label>Your voice <span class="blob-color-hint">${this.blobUserColor}</span></label>
                <input class="blob-color-input" type="color" .value=${this.blobUserColor} @input=${(e: Event) => this.setBlobColor("user", (e.target as HTMLInputElement).value)} title="Color when you speak" />
              </div>
              <div class="blob-color-row">
                <label>AI voice <span class="blob-color-hint">${this.blobAgentColor}</span></label>
                <input class="blob-color-input" type="color" .value=${this.blobAgentColor} @input=${(e: Event) => this.setBlobColor("agent", (e.target as HTMLInputElement).value)} title="Color when the AI speaks" />
              </div>
              <button class="blob-color-reset" @click=${this.resetBlobColors}>Reset</button>
            </div>`
          : nothing}
      </div>
      <div class="blob-section">
        <button class="blob-section-head ${this.blobOpenSection === "visualizer" ? "open" : ""}" @click=${() => this.toggleBlobSection("visualizer")}>
          <span class="chevron">▸</span>
          <span class="section-name">Visualizer</span>
          <span class="section-summary">${this.blobEnabled ? "WebGL" : "CSS"}</span>
        </button>
        ${this.blobOpenSection === "visualizer"
          ? html`<div class="blob-section-body">
              <button class="blob-toggle-row danger" @click=${this.toggleBlobEnabled}>Switch to simple orb (CSS)</button>
            </div>`
          : nothing}
      </div>
    </div>`;
  }

  private renderSystemModules() {
    const c = this.call;
    const inCall = callInProgress(c);
    const stage = (id: "stt" | "llm" | "tts") => {
      const s = this.pipeline?.[id];
      return s?.provider ? prettyProvider(s.provider) : this.pipelineLoaded ? "UNAVAILABLE" : "…";
    };
    const secs = c.startedAt && inCall ? Math.max(0, Math.floor((Date.now() - Date.parse(c.startedAt)) / 1000)) : null;
    return html`
      <div class="modules-section">
        <!-- Live pipeline: STT → LLM → TTS per turn (Robovoice call HUD) -->
        <div class="vs-live-module" data-testid="voice-session-pipeline">
          <voice-live-pipeline .input=${this.liveInput}></voice-live-pipeline>
        </div>

        <!-- Microphone Module with Waveform -->
        <holo-panel class="module" frame="brackets" tone="champagne" compact>
          <div class="module-header">
            <div class="module-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                <line x1="12" y1="19" x2="12" y2="23"></line>
              </svg>
              Microphone
            </div>
            <status-indicator tone=${this.connected && !this.muted ? "ok" : this.devicesLoaded && this.microphones.length ? "active" : "idle"}></status-indicator>
          </div>
          <div class="module-content">
            <div class="module-row"><span class="module-label">Device</span></div>
            <select class="device-select" data-testid="voice-mic-select" .value=${this.selectedMicrophone} @change=${(e: Event) => this.selectMicrophone((e.target as HTMLSelectElement).value)}>
              ${this.microphones.map((m) => html`<option value=${m.deviceId} ?selected=${m.deviceId === this.selectedMicrophone}>${m.label}</option>`)}
              ${this.microphones.length === 0 ? html`<option value="">No microphones found</option>` : nothing}
            </select>
            ${this.missingDevice.mic ? html`<div class="vs-device-note" data-testid="voice-mic-missing">Saved microphone not connected — using the default</div>` : nothing}
            ${this.connected
              ? html`<div class="mic-waveform">
                    ${this.micLevels.map((level) => html`<div class="mic-bar ${level > 4 ? "active" : ""} ${level > 25 ? "high" : ""} ${level > 32 ? "peak" : ""}" style="height: ${level}px"></div>`)}
                  </div>
                  <div class="mic-level-text">
                    <span class="mic-level-label">Level</span>
                    <span class="mic-level-value ${this.userSpeaking ? "speaking" : ""}">${this.micLevel}%</span>
                  </div>`
              : html`<div class="module-row" style="margin-top: 0.5rem;">
                  <span class="module-label">Status</span>
                  <span class="module-value ${this.devicesLoaded ? "hx-ready" : ""}">${this.devicesLoaded ? "READY" : "LOADING..."}</span>
                </div>`}
          </div>
        </holo-panel>

        <!-- Speaker / output Module -->
        <holo-panel class="module" frame="brackets" tone="champagne" compact data-testid="voice-output-module">
          <div class="module-header">
            <div class="module-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 18v-6a9 9 0 0 1 18 0v6"></path>
                <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path>
              </svg>
              Speaker
            </div>
            <status-indicator tone=${c.playback === "playing" ? "ok" : "idle"}></status-indicator>
          </div>
          <div class="module-content">
            <div class="module-row"><span class="module-label">Output device</span></div>
            <select class="device-select" data-testid="voice-output-select" .value=${this.selectedSpeaker} ?disabled=${!this.outputSupported}
              @change=${(e: Event) => this.selectSpeaker((e.target as HTMLSelectElement).value)}>
              <option value="" ?selected=${this.selectedSpeaker === ""}>System default</option>
              ${this.speakers
                .filter((d) => d.deviceId && d.deviceId !== "default")
                .map((d) => html`<option value=${d.deviceId} ?selected=${d.deviceId === this.selectedSpeaker}>${d.label}</option>`)}
            </select>
            ${!this.outputSupported
              ? html`<div class="vs-device-note" data-testid="voice-output-unsupported">This browser always plays on the system output — pick the speaker in your system settings.</div>`
              : this.missingDevice.speaker
                ? html`<div class="vs-device-note" data-testid="voice-output-missing">Saved speaker not connected — playing on the system default</div>`
                : this.speakers.length === 0 && typeof (navigator.mediaDevices as { selectAudioOutput?: unknown } | undefined)?.selectAudioOutput === "function"
                  ? html`<button class="vs-mini-btn" @click=${() => void this.chooseSpeaker()}>Choose a speaker…</button>`
                  : nothing}
            <div class="module-row vs-volume-row">
              <label class="module-label" for="vs-volume">Volume</label>
              <input id="vs-volume" class="vs-volume" data-testid="voice-output-volume" type="range" min="0" max="100" step="1"
                style="--pct:${Math.round(this.outputVolume * 100)}%"
                .value=${String(Math.round(this.outputVolume * 100))}
                aria-valuetext="${Math.round(this.outputVolume * 100)} percent"
                @input=${(e: Event) => this.setVolume(Number((e.target as HTMLInputElement).value) / 100)} />
              <span class="module-value vs-volume-value">${Math.round(this.outputVolume * 100)}%</span>
            </div>
            <button class="vs-mini-btn ${this.toneState}" data-testid="voice-output-test" ?disabled=${this.toneState === "playing"} @click=${() => void this.testSound()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
              ${this.toneState === "playing" ? "Playing…" : this.toneState === "ok" ? "Played — did you hear it?" : this.toneState === "failed" ? "Could not play" : "Play test sound"}
            </button>
            <label class="vs-toggle-row" title=${this.local ? "When local text-to-speech fails, speak the reply with this browser's own voice" : "When Robovoice sends a reply as text but no voice audio, speak it with this browser's own voice"}>
              <input type="checkbox" data-testid="voice-fallback-toggle" .checked=${this.fallbackVoice} @change=${(e: Event) => this.setFallbackVoice((e.target as HTMLInputElement).checked)} />
              <span>Fallback voice if the agent's audio fails</span>
            </label>
            <div class="module-row">
              <span class="module-label">Agent voice</span>
              <button class="vs-link-btn" data-testid="voice-tts-change" title="Change the speech provider and voice on the Pipeline tab" @click=${() => this.emit("session-settings")}>
                <span class="ellip">${this.pipeline?.tts?.provider ? `${prettyProvider(this.pipeline.tts.provider)}${this.pipeline.tts.model ? ` · ${this.pipeline.tts.model}` : ""}` : this.pipelineLoaded ? "Not set" : "…"}</span>
                <span aria-hidden="true">›</span>
              </button>
            </div>
            <div class="module-row"><span class="module-label">Agent audio</span><span class="module-value ${c.audioIn ? "gold" : ""}" data-testid="voice-audio-in">${!inCall ? "—" : c.audioIn ? "RECEIVING" : c.ttsFault ? "NONE — TEXT ONLY" : "NONE YET"}</span></div>
            <div class="module-row"><span class="module-label">Playback</span><span class="module-value" data-testid="voice-playback">${!inCall ? "—" : c.playback === "playing" ? "PLAYING" : c.playback === "blocked" ? "BLOCKED" : "WAITING"}</span></div>
          </div>
        </holo-panel>

        <!-- Turn diagnostics: where the time went, per turn -->
        ${this.renderDiagnostics()}

        <!-- Audio Engine Module -->
        <holo-panel class="module" frame="brackets" tone="champagne" compact>
          <div class="module-header">
            <div class="module-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
              </svg>
              Audio Engine
            </div>
            <status-indicator tone=${this.connected ? "ok" : "idle"}></status-indicator>
          </div>
          <div class="module-content">
            <div class="module-row"><span class="module-label">STT</span><span class="module-value gold ellip">${stage("stt")}</span></div>
            <div class="module-row"><span class="module-label">LLM</span><span class="module-value gold ellip">${stage("llm")}</span></div>
            <div class="module-row"><span class="module-label">TTS</span><span class="module-value gold ellip">${stage("tts")}</span></div>
            <div class="module-row"><span class="module-label">Status</span><span class="module-value">${this.connected ? "ACTIVE" : "IDLE"}</span></div>
          </div>
        </holo-panel>

        <!-- Call Module -->
        <holo-panel class="module" frame="brackets" tone="champagne" compact>
          <div class="module-header">
            <div class="module-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"></path>
              </svg>
              Call
            </div>
            <status-indicator tone=${inCall ? "ok" : "idle"}></status-indicator>
          </div>
          <div class="module-content">
            <div class="module-row"><span class="module-label">Agent</span><span class="module-value ellip">${this.agents.length ? this.agentName : "—"}</span></div>
            <div class="module-row"><span class="module-label">Runs on</span><span class="module-value">${c.mode === "device" ? "THIS DEVICE" : c.mode === "local" ? "DESKTOP" : c.mode === "cloud" ? "CLOUD" : this.local ? "THIS DEVICE" : "—"}</span></div>
            <div class="module-row"><span class="module-label">Duration</span><span class="module-value ${inCall ? "gold" : ""}">${secs != null ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : "—"}</span></div>
          </div>
        </holo-panel>
      </div>
    `;
  }

  /** Latest turn: Robovoice's end-to-end timing next to InfiniBot's own share (the voice LLM step). */
  private renderDiagnostics() {
    const c = this.call;
    const rv = c.latency[c.latency.length - 1] ?? null;
    const ib = this.turns[0] ?? null;
    const ms = (v: number | null | undefined) => (typeof v === "number" ? `${Math.round(v)} ms` : "—");
    const pathLabel: Record<string, string> = { fast: "FAST", agent: "FULL AGENT", "fast+agent": "FAST → AGENT", cli: "CLI AGENT" };
    const slow = (v: number | null | undefined, limit: number) => (typeof v === "number" && v > limit ? "slow" : "");
    return html`<holo-panel class="module" frame="brackets" tone="champagne" compact data-testid="voice-diagnostics">
      <div class="module-header">
        <div class="module-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
          </svg>
          Turn diagnostics
        </div>
        <status-indicator tone=${rv || ib ? "ok" : "idle"}></status-indicator>
      </div>
      <div class="module-content">
        ${!rv && !ib
          ? html`<div class="vs-device-note">Timings appear after the first turn of a call.</div>`
          : html`
              <div class="module-row"><span class="module-label">Speech end → first audio</span><span class="module-value gold ${slow(rv?.totalMs, 2500)}" data-testid="voice-diag-total">${ms(rv?.totalMs)}</span></div>
              <div class="module-row"><span class="module-label">STT → LLM first token</span><span class="module-value ${slow(rv?.sttToLlmMs, 1800)}">${ms(rv?.sttToLlmMs)}</span></div>
              <div class="module-row"><span class="module-label">LLM → TTS first audio</span><span class="module-value ${slow(rv?.llmToTtsMs, 1200)}">${ms(rv?.llmToTtsMs)}</span></div>
              ${ib
                ? html`
                    <div class="module-row"><span class="module-label">InfiniBot path</span><span class="module-value gold" data-testid="voice-diag-path">${pathLabel[ib.path ?? "agent"] ?? ib.path}</span></div>
                    <div class="module-row"><span class="module-label">Model</span><span class="module-value ellip" title=${ib.model ?? ib.backend}>${ib.model ?? ib.backend}</span></div>
                    <div class="module-row"><span class="module-label">Prep</span><span class="module-value ${slow(ib.prepMs, 500)}">${ms(ib.prepMs)}</span></div>
                    <div class="module-row"><span class="module-label">First token</span><span class="module-value ${slow(ib.firstTokenMs, 1500)}" data-testid="voice-diag-first-token">${ib.ok ? ms(ib.firstTokenMs) : "FAILED"}</span></div>
                    <div class="module-row"><span class="module-label">First sentence</span><span class="module-value ${slow(ib.firstSentenceMs, 1800)}">${ms(ib.firstSentenceMs)}</span></div>
                    ${ib.path === "fast+agent"
                      ? html`<div class="module-row"><span class="module-label">Agent answer</span><span class="module-value">${ms(ib.agentFirstTokenMs)}</span></div>`
                      : nothing}
                    <div class="module-row"><span class="module-label">LLM total</span><span class="module-value">${ms(ib.totalMs)}</span></div>
                    ${ib.error || ib.fastError
                      ? html`<div class="vs-device-note error" title=${ib.error ?? ib.fastError ?? ""}>${ib.error ? `Turn failed: ${ib.error}` : `Fast step fell back: ${ib.fastError}`}</div>`
                      : nothing}
                  `
                : nothing}
              <div class="module-row"><span class="module-label">Silent replies</span><span class="module-value ${c.silentReplies ? "slow" : ""}" data-testid="voice-diag-silent">${c.silentReplies}</span></div>
            `}
      </div>
    </holo-panel>`;
  }

  private renderLogSection() {
    return html`<div class="log-section">
      <div class="log-header">
        <div class="log-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="4 17 10 11 4 5"></polyline>
            <line x1="12" y1="19" x2="20" y2="19"></line>
          </svg>
          System Log
        </div>
        <button class="log-clear-btn" @click=${() => (this.logs = [])}>Clear</button>
      </div>
      <div class="log-content">
        ${this.logs.length === 0
          ? html`<div class="log-empty">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <polyline points="4 17 10 11 4 5"></polyline>
                <line x1="12" y1="19" x2="20" y2="19"></line>
              </svg>
              <span>No log entries</span>
            </div>`
          : this.logs.slice(-50).map(
              (log) => html`<div class="log-entry ${log.type}">
                <span class="log-time">${new Date(log.timestamp).toLocaleTimeString("en-US", { hour12: false })}</span>
                <span class="log-text">${log.text}</span>
              </div>`,
            )}
      </div>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "voice-session-view": VoiceSessionView;
  }
}
