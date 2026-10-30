/**
 * <voice-robovoice-console> — the Voice page. Voice runs on this machine by
 * default (local engine: local STT → voice turn → local TTS, see
 * local-call-session.ts); Robovoice is the opt-in cloud voice for devices that
 * can't run voice locally (Account › Voice engine). Local mode shows the
 * Session and Settings tabs only; the tabs below are Robovoice's. The routing switch in the sub-tab bar (and in the call view)
 * picks what answers the owner's voice turns: the API LLM (InfiniBot voice
 * agent) or a selected CLI session (<voice-cli-route-control>, decided
 * gateway-side by voice.cliRoute.*):
 *
 *   not linked  one "Connect Robovoice" card: device-code sign-in
 *               (robovoice.link.start → code + approval link → poll
 *               robovoice.link.status), what Robovoice is, robovoice.io link
 *   linked      Session (default): the voice session itself — the original
 *               Voice Terminal look (blob, transcript, HUD mode) on a
 *               Robovoice call, with live STT → LLM → TTS stage animation
 *               (<voice-session-view>). Settings and config are their own
 *               sub-tabs: Pipeline (STT → LLM → TTS for the location) ·
 *               Voice agents (voice toggle, LLM, TTS voice, language) ·
 *               Characters · Voice LLM (status, owner caller emails, token
 *               rotate, test) · Account (org, wallet, wake word)
 *
 * The not-linked, plugin-off, wallet-empty and error states show inside the
 * session view, styled like it.
 *
 * With cloud voice every Robovoice setting shown is Robovoice's and every
 * write is a robovoice.* RPC (console-actions.ts). Local voice is the default
 * (docs/voice/LOCAL-DEFAULT.md). The wake word is an on-device keyword
 * spotter that only starts calls.
 */

import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../gateway.js";
import { awaitGatewayClient, getGatewayClient } from "../../gateway-client.js";
import { PLUGIN_HOST_EVENT, isTabAvailable } from "../../plugin-host.js";
import "../robovoice/pipeline-editor.js";
import "./session-view.js";
import type { CallPipelineInfo } from "./live-state.js";
import "../../components/robovoice-agent-voice.js";
import type { VoiceAgentsPayload } from "../../components/robovoice-agent-voice.js";
import type { RvCallStart } from "./call-session.js";
import { robovoiceCall } from "./call-store.js";
import {
  CLOUD_VOICE_PROVIDER_ID,
  VOICE_PROVIDER_EVENT,
  getVoiceProvidersState,
  refreshVoiceProvidersState,
  selectVoiceProvider,
} from "../../controllers/voice-provider.js";
import { resolveCallTarget, sessionLabel } from "./call-target.js";
import "../../components/voice-terminal-stream.js";
import "./cli-route-control.js";
import { onVoiceCliRoutePayload } from "./cli-route-control.js";
import { cliName, loadCachedRoute } from "./cli-route-state.js";
import {
  getWakeWordStatus,
  listRegisteredWakePhrases,
  onStatusChange as onWakeStatusChange,
  resetWakeErrors,
  setWakeWordLanguage,
  setWakeWordOptIn,
} from "../../controllers/wake-word.js";
import {
  IDLE_CALL,
  VOICE_INTENT_EVENT,
  ageText,
  callInProgress,
  consolePhase,
  dashboardUrl,
  startBlockedReason,
  isCloudVoiceBusy,
  takeVoiceIntent,
  type CallState,
  type ConsolePhase,
  type RvLinkStatus,
} from "./console-state.js";
import {
  normalizePublicUrl,
  parseEmails,
  voiceConsoleActions,
  type RvCharacter,
  type RvConfigIssue,
  type RvSettingsView,
  type RvVoiceLlmStatus,
  type RvVoiceTest,
  type VoiceConsoleActions,
} from "./console-actions.js";

type Section = "session" | "pipeline" | "agents" | "characters" | "llm" | "account";
const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: "session", label: "Session" },
  { id: "pipeline", label: "Pipeline" },
  { id: "agents", label: "Voice agents" },
  { id: "characters", label: "Characters" },
  { id: "llm", label: "Voice LLM" },
  { id: "account", label: "Account" },
];

type StageNames = { provider: string; model: string };
type EffectiveStages = { stt: StageNames; llm: StageNames; tts: StageNames };
/** The slice of robovoice.pipeline.config.get the session's live stages need. */
type PipelineEffectiveView = { effective?: { location?: EffectiveStages | null; characters?: Record<string, EffectiveStages> } };

const ROBOVOICE_SITE = "https://robovoice.io";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

@customElement("voice-robovoice-console")
export class VoiceRobovoiceConsole extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  /** Sub-tab (e.g. from a deep link); the voice session is the default. */
  @property({ reflect: true }) section: Section = "session";

  @state() private pluginAvailable = isTabAvailable("robovoice");
  @state() private status: RvLinkStatus | null = null;
  @state() private loadError: string | null = null;
  /** Robovoice-side link status (org, device, credits) in flight. */
  @state() private remoteLoading = false;
  @state() private voiceAgents: VoiceAgentsPayload | null = null;
  @state() private agentsError: string | null = null;
  @state() private voiceLlm: RvVoiceLlmStatus | null = null;
  @state() private voiceLlmError: string | null = null;
  /** null = not loaded yet (skeleton); [] = Robovoice has none (empty state). */
  @state() private characters: RvCharacter[] | null = null;
  @state() private charactersError: string | null = null;
  /** Mappings / default / pipeline location that aren't the linked org's (cleared on request). */
  @state() private configIssues: RvConfigIssue[] = [];
  @state() private settings: RvSettingsView | null = null;
  @state() private busy: string | null = null;
  @state() private note: { text: string; error?: boolean } | null = null;
  @state() private copied = false;
  @state() private selfHostedUrl = "";
  @state() private showSelfHosted = false;
  @state() private call: CallState = IDLE_CALL;
  @state() private callStart: RvCallStart | null = null;
  @state() private callAgent: string | null = null;
  /** Chat session the next call is bound to (a call requested from a chat surface); null = the agent's main session. */
  @state() private callSessionKey: string | null = null;
  @state() private muted = false;
  @state() private now = Date.now();
  @state() private ownerEmailsDraft: string | null = null;
  @state() private publicUrlDraft: string | null = null;
  @state() private testAgent: string | null = null;
  @state() private testResult: RvVoiceTest | null = null;
  @state() private fastModelDraft: string | null = null;
  @state() private intentNote: string | null = null;
  /** Effective STT/LLM/TTS per character from robovoice.pipeline.config.get (names the live stages). */
  @state() private pipelineView: PipelineEffectiveView | null = null;
  @state() private pipelineLoaded = false;
  private pipelineLoading = false;
  /** Voice/CLI page mode. Kept in localStorage so navigation and reloads retain it. */
  /** Voice turns go to a CLI session (the terminal panel then opens on it). */
  @state() private cliRouting = loadCachedRoute().mode === "cli";
  /** What the routed CLI session is (HUD terminal label), "gateway_agent" when routing to the agent. */
  @state() private cliRouteName = "gateway_agent";
  /** Voice engine: local (default, this machine) or robovoice (opt-in cloud voice). */
  @state() private engine: "local" | "robovoice" = robovoiceCall.engine;
  /** InfiniBot agents a local voice session can talk to (agents.list); null = not loaded. */
  @state() private localAgents: Array<{ id: string; name: string }> | null = null;
  @state() private localAgentsError: string | null = null;
  private unsubscribeCliRoute: (() => void) | null = null;

  private actions: VoiceConsoleActions = voiceConsoleActions((m, p) => this.rpc(m, p));
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private unsubscribeCall: (() => void) | null = null;
  private unsubscribeWake: (() => void) | null = null;
  private loadAttempts = 0;

  private readonly onPluginHost = () => {
    const next = isTabAvailable("robovoice");
    if (next !== this.pluginAvailable) {
      this.pluginAvailable = next;
      if (next) void this.load();
    }
  };
  private readonly onIntent = () => void this.consumeIntent();
  private readonly onProvider = () => {
    const next = robovoiceCall.engine;
    if (next === this.engine) {
      this.requestUpdate();
      return;
    }
    this.engine = next;
    if (next === "robovoice") void this.load();
    else void this.loadLocalAgents();
  };

  private frameTopObserver: ResizeObserver | null = null;

  /** The shell's <main> (crossing shadow roots): its offsetTop is where the content area starts, in CSS px. */
  private shellMain(): HTMLElement | null {
    let node: Node | null = this;
    while (node) {
      if (node instanceof HTMLElement && node.tagName === "MAIN") return node;
      node = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null);
    }
    return null;
  }

  /** Keep --rv-frame-top at the content area's top so the fixed frame never covers the narrow-screen nav strip. */
  private trackFrameTop() {
    const main = this.shellMain();
    if (!main || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      const top = main.offsetTop;
      if (top > 0) this.style.setProperty("--rv-frame-top", `${top}px`);
      else this.style.removeProperty("--rv-frame-top");
    };
    this.frameTopObserver?.disconnect();
    this.frameTopObserver = new ResizeObserver(apply);
    const shell = main.parentElement;
    if (shell) this.frameTopObserver.observe(shell);
    for (const el of shell ? Array.from(shell.children) : [main]) this.frameTopObserver.observe(el);
    apply();
  }

  static styles = css`
    /* The page is a full-bleed frame over the content area, as the original
       Voice Terminal was: sub-tab bar on top, the session (or a scrolling
       settings tab) underneath. */
    :host {
      position: fixed; z-index: 50; box-sizing: border-box;
      top: var(--shell-topbar-height, 60px); left: var(--shell-nav-width, 260px);
      right: var(--chat-dock-reserve, 0px); bottom: 0;
      padding: 14px; display: flex; flex-direction: column;
      transition: left 360ms cubic-bezier(0.22, 1, 0.36, 1);
      font-size: 13px; color: var(--text, #e4e4e7);
      --rv-line: var(--border, #27272a); --rv-card: var(--card, #0f0f0f); --rv-muted: var(--muted, #a1a1aa);
      --rv-accent: var(--accent, #d4af37); --rv-on-accent: var(--accent-foreground, #000);
      --rv-ok: var(--ok, #22c55e); --rv-warn: var(--warn, #f59e0b); --rv-bad: var(--danger, #ef4444);
    }
    :host-context(.shell--nav-collapsed) { left: var(--shell-nav-slim-width, 64px); }
    /* <=1100px the shell puts its nav strip under the topbar: start below it (top of <main>, measured). */
    @media (max-width: 1100px) {
      :host, :host-context(.shell--nav-collapsed) { left: 0; top: var(--rv-frame-top, var(--shell-topbar-height, 60px)); }
    }
    * { box-sizing: border-box; }
    .bar { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 10px; min-width: 0; }
    /* Voice brain switch (API LLM | CLI session): right end of the sub-tab bar; own row on phones. */
    .route-bar { flex: none; margin-left: auto; min-width: 0; }
    @media (max-width: 640px) { .bar { flex-wrap: wrap; row-gap: 8px; } .route-bar { width: 100%; justify-content: flex-end; } }
    /* Holographic Voice Terminal (REDESIGN_BRIEF.md): the nav floats on the
       near-black canvas — text tabs with a lit capsule for the current one. */
    :host([section="session"]) {
      background:
        radial-gradient(70% 50% at 50% 0%, rgba(214, 166, 42, 0.05), transparent 70%),
        linear-gradient(180deg, #050608 0%, #020304 60%, #08090b 100%);
    }
    .subtabs {
      display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 999px; overflow-x: auto; scrollbar-width: none; min-width: 0;
      background: linear-gradient(180deg, rgba(255, 243, 207, 0.03), rgba(4, 5, 7, 0.5));
      border: 1px solid rgba(214, 166, 42, 0.12);
      box-shadow: inset 0 1px 0 rgba(255, 243, 207, 0.05);
    }
    .subtabs::-webkit-scrollbar { display: none; }
    /* Narrow screens: the strip scrolls — fade its right edge so that reads. */
    @media (max-width: 640px) {
      .subtabs { -webkit-mask-image: linear-gradient(90deg, #000 82%, transparent); mask-image: linear-gradient(90deg, #000 82%, transparent); }
    }
    .subtabs button {
      font: 600 12px/1 "Rajdhani", "Barlow Condensed", "Oswald", "Roboto Condensed", "Arial Narrow", ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0.16em; text-transform: uppercase; padding: 8px 15px; min-height: 0; border-radius: 999px;
      color: rgba(226, 222, 212, 0.5); background: transparent; border: 1px solid transparent; position: relative;
      transition: color 140ms ease, background 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
    }
    .subtabs button:hover:not(:disabled) { color: #ffe49a; background: rgba(245, 200, 75, 0.05); }
    .subtabs button.on {
      color: #fff3cf; border-color: rgba(245, 200, 75, 0.55);
      background: linear-gradient(180deg, rgba(255, 228, 154, 0.16), rgba(122, 88, 22, 0.14));
      box-shadow: inset 0 1px 0 rgba(255, 243, 207, 0.18), 0 0 18px -6px rgba(245, 200, 75, 0.8);
      text-shadow: 0 0 10px rgba(245, 200, 75, 0.6);
    }
    .subtabs button:focus-visible { outline: 1px solid #ffe49a; outline-offset: 2px; }
    .wallet-pill {
      flex: none; display: inline-flex; align-items: center; gap: 10px; padding: 7px 14px; border-radius: 999px; white-space: nowrap;
      font: 500 11px/1 var(--mono, "JetBrains Mono", ui-monospace, monospace); letter-spacing: 0.06em;
      border: 1px solid rgba(214, 166, 42, 0.3);
      background: linear-gradient(180deg, rgba(255, 243, 207, 0.05), rgba(4, 5, 7, 0.75));
      box-shadow: inset 0 1px 0 rgba(255, 243, 207, 0.07);
      color: rgba(226, 222, 212, 0.75); text-decoration: none;
    }
    .wallet-pill:hover { border-color: rgba(245, 200, 75, 0.6); text-decoration: none; }
    .wallet-pill .muted { color: rgba(226, 222, 212, 0.42); text-transform: uppercase; letter-spacing: 0.18em; font-size: 9.5px; }
    .wallet-pill b { color: #ffe49a; font-weight: 600; text-shadow: 0 0 10px rgba(245, 200, 75, 0.45); }
    .wallet-pill.w-empty { border-color: color-mix(in srgb, var(--rv-bad) 55%, transparent); }
    .wallet-pill.w-low { border-color: color-mix(in srgb, var(--rv-warn) 55%, transparent); }
    @media (max-width: 640px) { :host { padding: 8px; } .wallet-pill .muted { display: none; } }
    .body { flex: 1 1 auto; min-height: 0; }
    .body.scroll { overflow-y: auto; padding: 8px clamp(0px, 2vw, 18px) 56px; }
    voice-session-view { display: block; height: 100%; }
    /* Session + the live terminal stream underneath (collapsed = one line). */
    .session-stack { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; }
    .session-stack voice-session-view { flex: 1 1 auto; min-height: 0; height: auto; }
    .session-stack voice-terminal-stream { flex: none; }
    .bound-chip {
      flex: none; display: inline-flex; align-items: center; gap: 8px; padding: 5px 6px 5px 12px; border-radius: 999px; max-width: 46vw; min-width: 0;
      font: 500 11px/1 var(--mono, "JetBrains Mono", ui-monospace, monospace); color: rgba(226, 222, 212, 0.8);
      border: 1px solid rgba(214, 166, 42, 0.3); background: linear-gradient(180deg, rgba(255, 243, 207, 0.05), rgba(4, 5, 7, 0.75));
    }
    .bound-chip .muted { color: rgba(226, 222, 212, 0.42); text-transform: uppercase; letter-spacing: 0.18em; font-size: 9.5px; }
    .bound-chip b { color: #ffe49a; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .bound-chip button { min-width: 28px; min-height: 28px; border-radius: 999px; border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; font-size: 14px; }
    @media (max-width: 640px) { .bound-chip { max-width: 40vw; } .bound-chip .muted { display: none; } }
    /* Connect / plugin-off / error inside the session stage: same glass as the terminal. */
    .hero.compact {
      grid-template-columns: 1fr; gap: 0; max-width: 620px; width: 100%; padding: 22px 24px; border-radius: 16px;
      background: linear-gradient(to bottom, rgba(255,255,255,0.07), rgba(0,0,0,0.3)), color-mix(in srgb, var(--g-surface, #111) 88%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 30%, var(--g-border, #2a2a2a));
      box-shadow: 0 24px 60px -24px rgba(0,0,0,0.9), inset 0 1px 0 rgba(255,255,255,0.06);
      -webkit-backdrop-filter: blur(16px) saturate(140%); backdrop-filter: blur(16px) saturate(140%);
    }
    .hero.compact h1 { font-size: 20px; }
    .hero.compact p.lead { font-size: 13px; margin-bottom: 14px; }
    .hero.compact .orb { display: none; }
    .hero.compact .steps { margin-bottom: 16px; font-size: 12.5px; }
    a:not(.btn) { color: var(--rv-accent); text-decoration: none; }
    a:not(.btn):hover { text-decoration: underline; }
    .wrap { max-width: 1120px; margin: 0 auto; display: grid; gap: 16px; }
    .wrap.wide { max-width: 1440px; }
    .muted { color: var(--rv-muted); }
    .ok { color: var(--rv-ok); } .warn { color: var(--rv-warn); } .bad { color: var(--rv-bad); }
    .mono { font-family: var(--mono, ui-monospace, monospace); font-size: 12px; overflow-wrap: anywhere; }
    .kicker { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--rv-muted); font-weight: 600; }
    .card { border: 1px solid var(--rv-line); border-radius: 14px; background: var(--rv-card); padding: 18px 20px; min-width: 0; }
    .card h2 { margin: 0 0 12px; font-size: 15px; font-weight: 650; color: var(--text-strong, inherit); }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .between { justify-content: space-between; }
    button, a.btn {
      font: inherit; font-size: 12.5px; font-weight: 650; cursor: pointer; border-radius: 10px; padding: 8px 16px; min-height: 36px;
      border: 1px solid var(--rv-accent); background: var(--rv-accent); color: var(--rv-on-accent); text-decoration: none;
      display: inline-flex; align-items: center; justify-content: center; gap: 6px; white-space: nowrap;
    }
    button.ghost, a.btn.ghost { background: transparent; color: var(--rv-accent); }
    button.quiet, a.btn.quiet { background: transparent; border-color: var(--rv-line); color: var(--text, inherit); }
    button.danger { background: transparent; border-color: color-mix(in srgb, var(--rv-bad) 60%, transparent); color: var(--rv-bad); }
    button.end { background: var(--rv-bad); border-color: var(--rv-bad); color: #fff; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.lg, a.btn.lg { min-height: 46px; padding: 10px 22px; font-size: 14px; border-radius: 12px; }
    input, select {
      font: inherit; color: inherit; background: color-mix(in srgb, var(--bg, #050505) 60%, transparent);
      border: 1px solid var(--rv-line); border-radius: 10px; padding: 8px 10px; min-height: 38px; width: 100%;
    }
    .field { display: grid; gap: 5px; margin-bottom: 12px; }
    .field label { font-size: 12px; color: var(--rv-muted); }
    .note { margin-top: 10px; font-size: 12.5px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--rv-line); vertical-align: middle; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--rv-muted); font-weight: 550; }

    /* ── Connect state ───────────────────────────────────────────── */
    .hero {
      position: relative; overflow: hidden; border-radius: 20px; border: 1px solid color-mix(in srgb, var(--rv-accent) 35%, var(--rv-line));
      background:
        radial-gradient(120% 90% at 100% 0%, color-mix(in srgb, var(--rv-accent) 16%, transparent) 0%, transparent 55%),
        radial-gradient(90% 80% at 0% 100%, color-mix(in srgb, var(--rv-accent) 8%, transparent) 0%, transparent 60%),
        var(--rv-card);
      padding: clamp(22px, 4vw, 44px); display: grid; gap: 26px; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); align-items: center;
    }
    .hero h1 { font-size: clamp(24px, 3.4vw, 34px); line-height: 1.12; margin: 8px 0 10px; letter-spacing: -0.02em; color: var(--text-strong, inherit); }
    .hero p.lead { font-size: 14.5px; line-height: 1.6; color: var(--rv-muted); margin: 0 0 18px; max-width: 58ch; }
    .steps { display: grid; gap: 10px; margin: 0 0 22px; padding: 0; list-style: none; }
    .steps li { display: grid; grid-template-columns: 28px 1fr; gap: 10px; align-items: start; line-height: 1.5; }
    .steps b.n {
      width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font-size: 12px;
      border: 1px solid color-mix(in srgb, var(--rv-accent) 60%, transparent); color: var(--rv-accent);
    }
    .orb { position: relative; aspect-ratio: 1; width: min(100%, 300px); margin: 0 auto; display: grid; place-items: center; }
    .orb .ring { position: absolute; inset: 0; border-radius: 50%; border: 1px solid color-mix(in srgb, var(--rv-accent) 40%, transparent); animation: pulse 3.6s ease-out infinite; }
    .orb .ring:nth-child(2) { animation-delay: 1.2s; } .orb .ring:nth-child(3) { animation-delay: 2.4s; }
    .orb .core {
      width: 46%; aspect-ratio: 1; border-radius: 50%; display: grid; place-items: center;
      background: radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--rv-accent) 85%, #fff) 0%, var(--rv-accent) 45%, color-mix(in srgb, var(--rv-accent) 40%, #000) 100%);
      box-shadow: 0 0 60px color-mix(in srgb, var(--rv-accent) 40%, transparent); color: var(--rv-on-accent);
    }
    .orb .core svg { width: 38%; height: 38%; }
    @keyframes pulse { 0% { transform: scale(0.55); opacity: 0.9; } 100% { transform: scale(1); opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .orb .ring { animation: none; opacity: 0.4; } }
    .code-box { display: grid; gap: 12px; padding: 16px; border-radius: 14px; border: 1px dashed color-mix(in srgb, var(--rv-accent) 60%, transparent); background: color-mix(in srgb, var(--rv-accent) 6%, transparent); }
    .code { font-family: var(--mono, ui-monospace, monospace); font-size: clamp(24px, 5vw, 32px); font-weight: 700; letter-spacing: 0.14em; color: var(--text-strong, inherit); }
    .spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--rv-accent) 30%, transparent); border-top-color: var(--rv-accent); animation: spin 0.9s linear infinite; display: inline-block; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .facts3 { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); }
    .fact { border: 1px solid var(--rv-line); border-radius: 12px; padding: 14px; background: var(--rv-card); }
    .fact b { display: block; margin-bottom: 4px; color: var(--text-strong, inherit); }
    @media (max-width: 820px) { .hero { grid-template-columns: 1fr; } .orb { width: 160px; order: -1; } }

    /* ── Linked header ───────────────────────────────────────────── */
    .head { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
    .head h1 { margin: 4px 0 2px; font-size: clamp(20px, 2.6vw, 26px); letter-spacing: -0.015em; color: var(--text-strong, inherit); }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--rv-ok); box-shadow: 0 0 10px color-mix(in srgb, var(--rv-ok) 70%, transparent); display: inline-block; }
    .dot.off { background: var(--rv-warn); box-shadow: none; }
    .wallet { display: grid; gap: 2px; justify-items: end; text-align: right; padding: 10px 14px; border-radius: 12px; border: 1px solid var(--rv-line); min-width: 170px; }
    .wallet .amt { font-size: 22px; font-weight: 750; color: var(--text-strong, inherit); }
    .wallet.empty { border-color: color-mix(in srgb, var(--rv-bad) 55%, transparent); background: color-mix(in srgb, var(--rv-bad) 8%, transparent); }
    .wallet.low { border-color: color-mix(in srgb, var(--rv-warn) 55%, transparent); }
    .banner { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; justify-content: space-between; padding: 12px 16px; border-radius: 12px; }
    .banner.bad { border: 1px solid color-mix(in srgb, var(--rv-bad) 55%, transparent); background: color-mix(in srgb, var(--rv-bad) 10%, transparent); color: inherit; }
    .banner.warn { border: 1px solid color-mix(in srgb, var(--rv-warn) 55%, transparent); background: color-mix(in srgb, var(--rv-warn) 9%, transparent); color: inherit; }
    .banner strong { color: var(--text-strong, inherit); }
    @media (max-width: 640px) { .head { grid-template-columns: 1fr; } .wallet { justify-items: start; text-align: left; } }

    .tabs { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; border-bottom: 1px solid var(--rv-line); }
    .tabs::-webkit-scrollbar { display: none; }
    @media (max-width: 640px) { .tabs { -webkit-mask-image: linear-gradient(90deg, #000 85%, transparent); mask-image: linear-gradient(90deg, #000 85%, transparent); padding-right: 24px; } }
    .tabs button { background: transparent; border: 0; border-bottom: 2px solid transparent; border-radius: 0; color: var(--rv-muted); min-height: 40px; padding: 8px 12px; }
    .tabs button.on { color: var(--text-strong, inherit); border-bottom-color: var(--rv-accent); }

    /* ── Call ───────────────────────────────────────────────────── */
    .callgrid { display: grid; gap: 16px; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); }
    @media (max-width: 900px) { .callgrid { grid-template-columns: 1fr; } }
    .stage { display: grid; gap: 14px; }
    .phase { display: inline-flex; gap: 8px; align-items: center; font-weight: 650; font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--rv-line); }
    .phase.live { border-color: color-mix(in srgb, var(--rv-ok) 60%, transparent); color: var(--rv-ok); }
    .phase.live .dot { animation: blink 1.4s ease-in-out infinite; }
    @keyframes blink { 50% { opacity: 0.35; } }
    .timer { font-family: var(--mono, ui-monospace, monospace); font-size: 30px; font-weight: 700; color: var(--text-strong, inherit); }
    .transcript { display: grid; gap: 8px; max-height: 360px; overflow-y: auto; padding-right: 4px; }
    .line { max-width: 88%; padding: 8px 12px; border-radius: 12px; line-height: 1.45; border: 1px solid var(--rv-line); }
    .line.you { justify-self: end; background: color-mix(in srgb, var(--rv-accent) 12%, transparent); border-color: color-mix(in srgb, var(--rv-accent) 30%, transparent); }
    .line.interim { opacity: 0.65; }
    .line small { display: block; font-size: 10.5px; color: var(--rv-muted); margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.06em; }
    .stats { display: grid; gap: 10px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .stat { border: 1px solid var(--rv-line); border-radius: 12px; padding: 10px 12px; }
    .stat .v { font-size: 20px; font-weight: 700; color: var(--text-strong, inherit); }
    .skel { display: block; border-radius: 10px; background: linear-gradient(90deg, color-mix(in srgb, var(--rv-line) 55%, transparent) 0%, color-mix(in srgb, var(--rv-line) 100%, transparent) 50%, color-mix(in srgb, var(--rv-line) 55%, transparent) 100%); background-size: 200% 100%; animation: skel 1.4s ease-in-out infinite; max-width: 100%; }
    @keyframes skel { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
    @media (prefers-reduced-motion: reduce) { .skel { animation: none; } }
    .skel-page { display: grid; gap: 16px; }
    .skel-list { display: grid; gap: 10px; }
    .failed { display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; padding: 12px 14px; border-radius: 12px; border: 1px solid color-mix(in srgb, var(--rv-bad) 45%, transparent); background: color-mix(in srgb, var(--rv-bad) 7%, transparent); }
    .empty { padding: 26px 12px; text-align: center; color: var(--rv-muted); border: 1px dashed var(--rv-line); border-radius: 12px; }

    .agents-head { display: grid; grid-template-columns: minmax(120px, 1.1fr) auto minmax(150px, 1fr) minmax(150px, 1.2fr) minmax(110px, 0.8fr); gap: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--rv-line); }
    .agents-head span { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--rv-muted); }
    @media (max-width: 760px) { .agents-head { display: none; } }
    .kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 7px 16px; align-items: baseline; }
    .chip { font-size: 11px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--rv-line); white-space: nowrap; }
    .chip.good { border-color: color-mix(in srgb, var(--rv-ok) 55%, transparent); color: var(--rv-ok); }
    .chip.flag { border-color: color-mix(in srgb, var(--rv-warn) 55%, transparent); color: var(--rv-warn); }
    .two { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); }
    @media (max-width: 640px) { .hide-sm { display: none; } th, td { padding: 8px 4px; } }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.trackFrameTop();
    this.unsubscribeCliRoute = onVoiceCliRoutePayload((p) => {
      this.cliRouting = p.route.mode === "cli";
      this.cliRouteName = p.route.mode === "cli" && p.route.target ? cliName(p.route.target.cliType) : "gateway_agent";
    });
    window.addEventListener(VOICE_PROVIDER_EVENT, this.onProvider);
    void refreshVoiceProvidersState(getGatewayClient() ?? this.client);
    void this.loadLocalAgents();
    this.unsubscribeWake = onWakeStatusChange(() => this.requestUpdate());
    window.addEventListener(PLUGIN_HOST_EVENT, this.onPluginHost);
    window.addEventListener(VOICE_INTENT_EVENT, this.onIntent);
    // Have the call library in memory before Connect is tapped (the tap must unlock audio synchronously).
    robovoiceCall.preload();
    this.unsubscribeCall = robovoiceCall.subscribe((s, start) => {
      const was = this.call.phase;
      // A turn just happened (agent line or a timing sample): fetch InfiniBot's side of it for the diagnostics.
      const agentLines = (c: CallState) => c.transcript.reduce((n, l) => n + (l.who === "agent" ? 1 : 0), 0);
      if (s.latency.length > this.call.latency.length || agentLines(s) > agentLines(this.call) || s.silentReplies > this.call.silentReplies) this.refreshTurns();
      this.call = s;
      this.callStart = start;
      this.engine = robovoiceCall.engine;
      if (s.agentId) this.callAgent = s.agentId;
      // A chat-bound call finished: the next call from this page is the agent's own again.
      if (s.sessionKey && (s.phase === "ended" || s.phase === "failed")) this.callSessionKey = null;
      if (callInProgress(s)) this.startTick();
      else this.stopTick();
    });
    void this.load();
  }

  private turnsTimer: ReturnType<typeof setTimeout> | null = null;

  /** Debounced robovoice.voiceLlm.status (the gateway logs the turn a moment after its last token). */
  private refreshTurns(): void {
    if (this.turnsTimer) clearTimeout(this.turnsTimer);
    this.turnsTimer = setTimeout(() => {
      this.turnsTimer = null;
      void this.actions
        .voiceLlmStatus()
        .then((v) => (this.voiceLlm = v))
        .catch(() => undefined);
    }, 700);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.frameTopObserver?.disconnect();
    this.frameTopObserver = null;
    if (this.turnsTimer) clearTimeout(this.turnsTimer);
    this.turnsTimer = null;
    window.removeEventListener(PLUGIN_HOST_EVENT, this.onPluginHost);
    window.removeEventListener(VOICE_INTENT_EVENT, this.onIntent);
    window.removeEventListener(VOICE_PROVIDER_EVENT, this.onProvider);
    this.unsubscribeCliRoute?.();
    this.unsubscribeCliRoute = null;
    this.unsubscribeCall?.();
    this.unsubscribeCall = null;
    this.unsubscribeWake?.();
    this.unsubscribeWake = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.stopTick();
  }

  protected updated(changed: PropertyValues): void {
    // Back on the session after editing the pipeline: re-read what the stages run.
    if (changed.has("section") && changed.get("section") === "pipeline" && this.phase === "linked") void this.loadPipelineView();
  }

  private startTick(): void {
    this.tick ??= setInterval(() => (this.now = Date.now()), 1000);
  }
  private stopTick(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
  }

  private async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    // The live global client first: a client handed down at render time can be
    // a stopped one after a reconnect (its requests never leave the browser).
    const client = getGatewayClient() ?? this.client ?? (await awaitGatewayClient(15_000));
    if (!client) throw new Error("gateway not connected");
    return client.request<T>(method, params);
  }

  private get phase(): ConsolePhase {
    return consolePhase({ pluginAvailable: this.pluginAvailable, status: this.status, error: this.loadError });
  }

  /**
   * Full load. The install's own link record first (local, instant) decides
   * the page; then every Robovoice read runs in parallel: link status (org,
   * device, credits — robovoice.io takes 5–13 s), wallet, voice agents with
   * their real voices, characters, settings. Nothing is shown until Robovoice
   * (or the link record it wrote) says it.
   */
  async load(): Promise<void> {
    if (this.engine === "local") void this.consumeIntent();
    if (!this.pluginAvailable) return;
    try {
      this.status = await this.actions.linkStatus(false);
      this.loadError = null;
      this.loadAttempts = 0;
    } catch (err) {
      this.loadError = errText(err);
      // Direct load of /voice mounts before the socket is up — retry a few times.
      if (this.loadAttempts++ < 5) setTimeout(() => void this.load(), 2000);
      return;
    }
    if (this.phase === "linking") this.schedulePoll();
    if (this.phase === "linked") await this.loadLinked();
    void this.consumeIntent();
  }

  /** Linked console data, all in parallel; local reads retried while the socket settles. */
  private async loadLinked(attempt = 0): Promise<void> {
    await Promise.allSettled([
      attempt === 0 ? this.refreshRemote() : Promise.resolve(),
      this.loadVoice(),
      attempt === 0 || this.characters === null ? this.loadCharacters() : Promise.resolve(),
      this.loadSettings(),
      attempt === 0 || !this.pipelineView ? this.loadPipelineView() : Promise.resolve(),
    ]);
    if ((!this.voiceAgents || !this.settings) && attempt < 5 && this.isConnected) {
      setTimeout(() => void this.loadLinked(attempt + 1), 2000 * (attempt + 1));
    }
  }

  /** Robovoice's side of the link: org, location, device state, credits. */
  private async refreshRemote(): Promise<void> {
    this.remoteLoading = true;
    try {
      const s = await this.actions.linkStatus(true);
      this.status = s;
    } catch (err) {
      if (this.status) this.status = { ...this.status, remoteError: errText(err) };
    } finally {
      this.remoteLoading = false;
    }
  }

  /** Retry everything Robovoice-side from scratch (no stale values kept on screen). */
  private retryRemote(): Promise<void> {
    this.characters = null;
    this.charactersError = null;
    return this.load();
  }

  private async loadVoice(): Promise<void> {
    const [agents, llm] = await Promise.allSettled([
      this.rpc<VoiceAgentsPayload>("robovoice.voiceAgents.list"),
      this.actions.voiceLlmStatus(),
    ]);
    if (agents.status === "fulfilled") {
      // Keep the Robovoice voices already read while the local list refreshes.
      const prev = new Map((this.voiceAgents?.agents ?? []).map((a) => [a.id, a.robovoice]));
      this.voiceAgents = { ...agents.value, agents: agents.value.agents.map((a) => ({ ...a, robovoice: prev.get(a.id) })) };
      this.agentsError = null;
      this.pickDefaults();
    } else if (!this.voiceAgents) {
      this.agentsError = errText(agents.reason);
    }
    if (llm.status === "fulfilled") {
      this.voiceLlm = llm.value;
      this.voiceLlmError = null;
    } else if (!this.voiceLlm) {
      this.voiceLlmError = errText(llm.reason);
    }
    // Then each voice agent's real voice from Robovoice.
    try {
      const remote = await this.rpc<VoiceAgentsPayload>("robovoice.voiceAgents.list", { remote: true });
      this.voiceAgents = remote;
      this.pickDefaults();
    } catch (err) {
      if (this.voiceAgents) {
        this.voiceAgents = {
          ...this.voiceAgents,
          voicesError: errText(err),
          agents: this.voiceAgents.agents.map((a) => ({ ...a, robovoice: null })),
        };
      }
    }
  }

  /** Call + test pickers default to a real voice agent (never an assumed "main"). */
  private pickDefaults(): void {
    const callable = this.callableAgents();
    if (!this.callAgent || !callable.some((a) => a.id === this.callAgent)) this.callAgent = callable[0]?.id ?? null;
    const testable = this.testableAgents();
    if (!this.testAgent || !testable.some((a) => a.id === this.testAgent)) this.testAgent = testable[0]?.id ?? null;
  }

  private testableAgents() {
    return (this.voiceAgents?.agents ?? []).filter((a) => a.voiceAgent && a.llm === "infinibot");
  }

  private async loadCharacters(): Promise<void> {
    try {
      const r = await this.actions.characters();
      if (r.error) {
        this.characters = null;
        this.charactersError = r.error;
      } else {
        this.characters = r.characters ?? [];
        this.charactersError = null;
        this.configIssues = r.issues ?? [];
      }
    } catch (err) {
      this.characters = null;
      this.charactersError = errText(err);
    }
  }

  private async loadSettings(): Promise<void> {
    try {
      this.settings = await this.actions.settings();
    } catch {
      /* optional */
    }
  }

  /**
   * Effective pipeline per character — what the live STT/LLM/TTS stages are
   * named after. Robovoice's edge read takes ~15 s and sometimes answers 503,
   * so it is retried; until it answers the stages show "…", and after the last
   * failure "unavailable" (never a default).
   */
  private async loadPipelineView(attempt = 0): Promise<void> {
    if (this.pipelineLoading && attempt === 0) return;
    this.pipelineLoading = true;
    try {
      this.pipelineView = await this.rpc<PipelineEffectiveView>("robovoice.pipeline.config.get");
      this.pipelineLoaded = true;
      this.pipelineLoading = false;
    } catch {
      if (attempt < 3 && this.isConnected) {
        setTimeout(() => void this.loadPipelineView(attempt + 1), 3000 * (attempt + 1));
        return;
      }
      this.pipelineLoaded = true;
      this.pipelineLoading = false;
    }
  }

  /** The pipeline the call agent runs: its character's effective stages, else the location's. */
  private sessionPipeline(): CallPipelineInfo | null {
    const eff = this.pipelineView?.effective;
    if (!eff) return null;
    const id = this.call.agentId ?? this.callAgent;
    const characterId = (this.voiceAgents?.agents ?? []).find((a) => a.id === id)?.characterId;
    const stages = (characterId && eff.characters?.[characterId]) || eff.location;
    if (!stages) return null;
    const pick = (s: StageNames | undefined) => ({ provider: s?.provider ?? "", model: s?.model ?? "" });
    return { stt: pick(stages.stt), llm: pick(stages.llm), tts: pick(stages.tts) };
  }

  private callableAgents() {
    if (this.engine === "local") return this.localAgents ?? [];
    return (this.voiceAgents?.agents ?? []).filter((a) => a.voiceAgent && a.characterId);
  }

  /** Local voice talks to any InfiniBot agent (no Robovoice voice-agent setup). */
  private async loadLocalAgents(attempt = 0): Promise<void> {
    try {
      const res = await this.rpc<{ agents?: Array<{ id: string; name?: string; identity?: { name?: string } }>; defaultId?: string }>("agents.list");
      const list = (res.agents ?? []).map((a) => ({ id: a.id, name: a.identity?.name || a.name || a.id }));
      const def = res.defaultId;
      this.localAgents = def ? [...list.filter((a) => a.id === def), ...list.filter((a) => a.id !== def)] : list;
      this.localAgentsError = null;
      if (this.engine === "local" && (!this.callAgent || !this.localAgents.some((a) => a.id === this.callAgent))) {
        this.callAgent = this.localAgents[0]?.id ?? null;
      }
    } catch (err) {
      this.localAgentsError = errText(err);
      if (attempt < 5 && this.isConnected) setTimeout(() => void this.loadLocalAgents(attempt + 1), 2000);
    }
  }

  /** What a local session runs: local Whisper → the agent or the routed CLI → local Kokoro. */
  private localPipeline(): CallPipelineInfo {
    const agent = this.callableAgents().find((a) => a.id === (this.call.agentId ?? this.callAgent))?.name ?? "agent";
    return {
      stt: { provider: "whisper", model: "local" },
      llm: { provider: "infinibot", model: this.cliRouting ? `CLI · ${this.cliRouteName}` : agent },
      tts: { provider: "kokoro", model: "local" },
    };
  }

  /** Switch the voice engine (voice.providers.select): "auto" = local (default), "robovoice" = cloud. */
  private chooseEngine(id: "auto" | typeof CLOUD_VOICE_PROVIDER_ID): Promise<void> {
    return this.act(
      "engine",
      async () => {
        const client = getGatewayClient() ?? this.client;
        if (!client) throw new Error("gateway not connected");
        await selectVoiceProvider(client, id);
      },
      id === "auto" ? "Voice runs locally on this machine." : "Cloud voice (Robovoice) selected.",
      false,
    );
  }

  /** Link poll while the device-code sign-in is pending. */
  private schedulePoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      try {
        this.status = await this.actions.linkStatus(false);
      } catch {
        this.schedulePoll();
        return;
      }
      const p = this.status.pending;
      if (p?.status === "linked" || (this.status.linked && !this.status.unlinkedAt)) {
        this.note = { text: this.status.org?.name ? `Connected to ${this.status.org.name}.` : "Connected to Robovoice." };
        await this.load();
      } else if (p?.status === "error") {
        this.note = { text: p.error ?? "Sign-in failed", error: true };
      } else if (this.phase === "linking") {
        this.schedulePoll();
      }
    }, 2000);
  }

  /** Wake word / voice button asked for a call. */
  private async consumeIntent(): Promise<void> {
    if (this.engine !== "local" && (this.phase === "loading" || this.phase === "error")) return;
    const intent = takeVoiceIntent();
    if (!intent) return;
    if (this.engine !== "local" && this.phase !== "linked") {
      this.intentNote = "Voice runs on Robovoice — connect it below and your wake word will start a call.";
      return;
    }
    if (robovoiceCall.inProgress()) return;
    this.section = "session";
    const target = resolveCallTarget({ agentId: intent.agentId, sessionKey: intent.sessionKey }, this.callAgent ?? "main");
    const wanted = intent.agentId || intent.sessionKey ? target.agentId : null;
    const agent = wanted && this.callableAgents().some((a) => a.id === wanted) ? wanted : this.callAgent;
    if (agent) this.callAgent = agent;
    this.callSessionKey = agent && agent === target.agentId ? (target.sessionKey ?? null) : null;
    await this.startCall();
  }

  private async act(key: string, fn: () => Promise<unknown>, done?: string, reload = true): Promise<void> {
    if (this.busy) return;
    this.busy = key;
    this.note = null;
    try {
      await fn();
      if (done) this.note = { text: done };
      if (reload) await this.load();
    } catch (err) {
      this.note = { text: errText(err), error: true };
    } finally {
      this.busy = null;
    }
  }

  private startLink(): Promise<void> {
    const apiBase = this.showSelfHosted ? this.selfHostedUrl.trim() || undefined : undefined;
    return this.act("link", async () => {
      const p = await this.actions.linkStart(apiBase);
      try {
        window.open(p.verificationUriComplete, "_blank", "noopener");
      } catch {
        /* popup blocked — the page shows the link */
      }
    });
  }

  private async copyCode(code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      this.copied = true;
      setTimeout(() => (this.copied = false), 1600);
    } catch {
      this.note = { text: "Copy failed — select the code instead.", error: true };
    }
  }

  private async startCall(): Promise<void> {
    const agent = this.callAgent;
    const why =
      this.engine === "local"
        ? callInProgress(this.call)
          ? "A call is already in progress."
          : agent
            ? null
            : "Pick an agent."
        : startBlockedReason(this.phase, this.call, agent);
    if (why || !agent) {
      this.note = { text: why ?? "Pick a voice agent.", error: true };
      return;
    }
    this.muted = false;
    this.note = null;
    // Still inside the Connect tap here: the only moment the browser lets us unlock agent audio.
    robovoiceCall.primeAudio();
    await robovoiceCall.begin(agent, { sessionKey: resolveCallTarget({ agentId: agent, sessionKey: this.callSessionKey }).sessionKey });
  }

  private async toggleMute(): Promise<void> {
    this.muted = !this.muted;
    await robovoiceCall.setMuted(this.muted);
  }

  // ── render ────────────────────────────────────────────────────────────────

  render() {
    const phase = this.phase;
    const local = this.engine === "local";
    const linked = phase === "linked";
    // Local voice: Session + Settings. Robovoice not linked yet: every sub-tab
    // leads to the same Connect state, shown in the session.
    const tabs = local ? SECTIONS.filter((x) => x.id === "session" || x.id === "account") : SECTIONS;
    const usable = local || linked;
    const section: Section = usable && tabs.some((x) => x.id === this.section) ? this.section : "session";
    return html`<div class="bar">
        <nav class="subtabs" role="tablist" aria-label="Voice sections" data-testid="voice-subtabs">
          ${tabs.map(
            (x) => html`<button role="tab" data-section=${x.id} aria-selected=${x.id === section ? "true" : "false"} class=${x.id === section ? "on" : ""}
              ?disabled=${!usable && x.id !== "session"} @click=${() => (this.section = x.id)}>${local && x.id === "account" ? "Settings" : x.label}</button>`,
          )}
        </nav>
        ${usable ? this.renderBoundSession() : nothing}
        ${linked && !local ? html`<span class="wallet-pill" data-testid="voice-free-pill" title="Cloud voice is free">Cloud voice · free</span>` : nothing}
        <voice-cli-route-control class="route-bar" .client=${this.client} variant="bar"></voice-cli-route-control>
      </div>
      <div class="body ${section === "session" ? "" : "scroll"}" data-testid="voice-console" data-phase=${phase} data-section=${section}
        data-route=${this.cliRouting ? "cli" : "api"} data-engine=${this.engine}>
        ${section === "session"
          ? this.renderSession(phase)
          : html`<div class="wrap ${section === "pipeline" ? "wide" : ""}">${local ? this.renderLocalSettings() : this.renderConsole()}</div>`}
      </div>`;
  }

  /** "Chat · webchat:xyz" — the chat session this call's turns + transcript land in (absent = the agent's main session). */
  private renderBoundSession() {
    const live = callInProgress(this.call);
    const key = live ? this.call.sessionKey : this.callSessionKey;
    if (!key) return nothing;
    return html`<span class="bound-chip" data-testid="voice-bound-session" title=${`Turns and transcript go to chat session ${key}`}>
      <span class="muted">Chat</span><b>${sessionLabel(key)}</b>
      ${live ? nothing : html`<button aria-label="Call the agent's main session instead" title="Use the agent's main session" @click=${() => (this.callSessionKey = null)}>×</button>`}
    </span>`;
  }

  /** The voice session: the original Voice Terminal on a Robovoice call. */
  private renderSession(phase: ConsolePhase) {
    if (this.engine === "local") return this.renderLocalSession();
    const linked = phase === "linked";
    const agents = this.callableAgents().map((a) => ({ id: a.id, name: a.name }));
    const blocked = !linked
      ? phase === "loading"
        ? "Loading your Robovoice account…"
        : "Connect Robovoice to start a voice session."
      : !this.voiceAgents
        ? (this.agentsError ?? "Loading voice agents…")
        : agents.length === 0
          ? "No voice agents yet — turn one on under Voice agents."
          : startBlockedReason(phase, this.call, this.callAgent);
    const overlay = phase === "plugin-off" || phase === "error" || phase === "unlinked" || phase === "linking";
    return html`<div class="session-stack">${this.renderSessionView(phase, linked, agents, blocked, overlay)}
      ${linked || this.cliRouting
        ? html`<!-- Follows the routed CLI session (voice.cliRoute → setVoiceCliSelection); open while CLI routing is on. -->
            <voice-terminal-stream .client=${this.client} surface=${this.cliRouting ? "voice-cli" : "voice"} ?default-open=${this.cliRouting}
              data-testid="voice-cli-terminal-stream"></voice-terminal-stream>`
        : nothing}
    </div>`;
  }

  /** Local voice session: any InfiniBot agent, no account, the CLI terminal stream under it. */
  private renderLocalSession() {
    const agents = this.localAgents ?? [];
    const blocked = this.localAgents === null ? (this.localAgentsError ?? "Loading agents…") : agents.length === 0 ? "No agents configured." : null;
    return html`<div class="session-stack">${this.renderSessionView("linked", true, agents, blocked, false)}
      <!-- Direct CLI mode: the routed CLI session's live terminal (voice.cliRoute → setVoiceCliSelection). -->
      <voice-terminal-stream .client=${this.client} surface=${this.cliRouting ? "voice-cli" : "voice"} ?default-open=${this.cliRouting}
        data-testid="voice-cli-terminal-stream"></voice-terminal-stream>
    </div>`;
  }

  /** Local voice settings: the voice engine choice + wake word (Robovoice's own tabs appear with cloud voice). */
  private renderLocalSettings() {
    return html`${this.renderNote()}${this.renderEngine()}${this.renderWakeWord()}`;
  }

  /** Voice engine: local (default) or cloud voice (Robovoice). Shown in Settings / Account. */
  private renderEngine() {
    const p = getVoiceProvidersState();
    const cloud = p?.providers.find((x) => x.id === CLOUD_VOICE_PROVIDER_ID) ?? null;
    const local = p?.providers.find((x) => x.source === "builtin") ?? null;
    const selected = p?.backend === CLOUD_VOICE_PROVIDER_ID ? "robovoice" : "auto";
    const busy = this.busy !== null;
    const opt = (id: "auto" | "robovoice", title: string, sub: string, extra: unknown, disabled = false) =>
      html`<label class="kv" style="grid-template-columns:auto minmax(0,1fr);align-items:start;cursor:${disabled ? "default" : "pointer"};padding:10px 0;" data-testid=${id === "auto" ? "voice-engine-local" : "voice-engine-cloud"}>
        <input type="radio" name="voice-engine" style="width:16px;height:16px;min-height:0;padding:0;margin:3px 0 0;box-shadow:none;" .checked=${selected === id} ?disabled=${busy || disabled}
          @change=${() => void this.chooseEngine(id)} />
        <span><b>${title}</b>${selected === id ? html` <span class="chip good">In use</span>` : nothing}
          <div class="muted" style="margin-top:3px;">${sub}</div>${extra}</span>
      </label>`;
    return html`<section class="card" data-testid="voice-engine">
      <div class="kicker">Voice engine</div>
      <div class="muted" style="margin:4px 0 6px;max-width:46rem;">Where speech-to-text and text-to-speech run for the Voice page, chat calls and wake words.</div>
      ${opt(
        "auto",
        "Local voice (default)",
        "Runs on this machine: local Whisper speech-to-text and Kokoro text-to-speech through this gateway. No account needed. Talk directly to a CLI agent or a gateway agent.",
        local && !local.status.ready ? html`<div class="muted" style="color:var(--rv-warn);margin-top:3px;">${local.status.error ?? "Local voice is not ready."}</div>` : nothing,
      )}
      ${opt(
        "robovoice",
        "Cloud voice (Robovoice)",
        "Optional: studio voices on Robovoice's cloud, for when you want them or a device can't run voice locally. Free, nothing to top up. Switch back to local voice any time.",
        cloud
          ? cloud.status.ready
            ? nothing
            : html`<div class="muted" style="margin-top:3px;">${cloud.status.error ?? "Link your Robovoice account first"} —
                <a href="/robovoice" style="color:var(--rv-accent);" @click=${(e: Event) => this.navigate(e, "/robovoice")}>Robovoice page</a></div>`
          : html`<div class="muted" style="margin-top:3px;">Turn on the Robovoice plugin to use it —
              <a href="/plugins" style="color:var(--rv-accent);" @click=${(e: Event) => this.navigate(e, "/plugins")}>Plugins</a></div>`,
        !cloud,
      )}
    </section>`;
  }

  private renderSessionView(
    phase: ConsolePhase,
    linked: boolean,
    agents: Array<{ id: string; name: string }>,
    blocked: string | null,
    overlay: boolean,
  ) {
    const local = this.engine === "local";
    return html`<voice-session-view
      .engine=${this.engine}
      .voiceRoute=${this.cliRouting ? this.cliRouteName : "gateway_agent"}
      .client=${this.client}
      .call=${this.call}
      .agents=${agents}
      .agentId=${this.callAgent}
      .muted=${this.muted}
      .blockedReason=${callInProgress(this.call) ? null : blocked}
      .account=${this.status?.org?.name ?? ""}
      .pipeline=${local ? this.localPipeline() : linked ? this.sessionPipeline() : null}
      .pipelineLoaded=${local || this.pipelineLoaded}
      .overlay=${overlay}
      .levels=${() => robovoiceCall.levels()}
      .turns=${local ? [] : this.callTurns()}
      @session-output=${(e: CustomEvent<{ deviceId: string; volume: number }>) => void robovoiceCall.setOutput(e.detail.deviceId, e.detail.volume)}
      @session-mic-device=${(e: CustomEvent<{ deviceId: string }>) => void robovoiceCall.setMicDevice(e.detail.deviceId).catch(() => undefined)}
      @session-connect=${() => void this.startCall()}
      @session-disconnect=${() => void robovoiceCall.end()}
      @session-switch-local=${() => void this.chooseEngine("auto")}
      @session-mute=${() => void this.toggleMute()}
      @session-enable-audio=${() => void robovoiceCall.enableAudio()}
      @session-agent=${(e: CustomEvent<{ id?: string }>) => {
        if (!e.detail?.id) return;
        this.callAgent = e.detail.id;
        // A chat binding belongs to one agent; picking another drops it.
        if (this.callSessionKey && resolveCallTarget({ agentId: e.detail.id, sessionKey: this.callSessionKey }).sessionKey === undefined) this.callSessionKey = null;
      }}
      @session-settings=${() => (this.section = local ? "account" : "pipeline")}
    >
      <voice-cli-route-control slot="route" .client=${this.client} variant="pill"></voice-cli-route-control>
      ${overlay
        ? html`<div slot="overlay" style="display:contents;">
            ${phase === "plugin-off" ? this.renderPluginOff() : phase === "error" ? this.renderError() : this.renderConnect(phase === "linking")}
          </div>`
        : nothing}
    </voice-session-view>`;
  }

  private renderLoading() {
    return html`<div class="skel-page" data-testid="voice-loading" aria-busy="true" aria-label="Loading your Robovoice account">
      <div class="head"><div style="display:grid;gap:8px;"><span class="skel" style="width:120px;height:11px;"></span><span class="skel" style="width:220px;height:26px;"></span><span class="skel" style="width:280px;height:14px;"></span></div>
        <span class="skel" style="width:170px;height:64px;"></span></div>
      <span class="skel" style="height:40px;"></span>
      <div class="callgrid"><span class="skel" style="height:260px;"></span><span class="skel" style="height:260px;"></span></div>
    </div>`;
  }

  /** Inline skeleton while a Robovoice read is in flight. */
  private skel(w = "100%", h = "14px", label = "Loading from Robovoice") {
    return html`<span class="skel" style="width:${w};height:${h};" aria-label=${label} role="progressbar"></span>`;
  }

  /** "Couldn't read X from Robovoice: … [Retry]" — nothing stale or made up next to it. */
  private renderFailed(what: string, err: string, retry: () => void, testid: string) {
    return html`<div class="failed" role="alert" data-testid=${testid}>
      <span class="bad">Couldn't read ${what} from Robovoice: ${err}</span>
      <button class="ghost" @click=${retry}>Retry</button>
    </div>`;
  }

  /** Empty list, said plainly, with the Robovoice dashboard where it's managed. */
  private renderEmpty(text: string, testid: string) {
    return html`<div class="empty" data-testid=${testid}>${text}
      <div style="margin-top:10px;"><a class="btn quiet" href=${dashboardUrl(this.status)} target="_blank" rel="noopener">Open the Robovoice dashboard ↗</a></div></div>`;
  }

  private renderError() {
    return html`<div class="hero compact" style="display:block;" data-testid="voice-error">
      <h2>Robovoice isn't answering</h2>
      <div class="bad">${this.loadError}</div>
      <div class="row" style="margin-top:12px;"><button class="ghost" data-testid="voice-retry" @click=${() => void this.load()}>Retry</button></div>
    </div>`;
  }

  private orb() {
    return html`<div class="orb" aria-hidden="true">
      <span class="ring"></span><span class="ring"></span><span class="ring"></span>
      <div class="core">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0" /><line x1="12" y1="17" x2="12" y2="22" />
        </svg>
      </div>
    </div>`;
  }

  private renderPluginOff() {
    return html`<section class="hero compact" data-testid="voice-plugin-off">
      <div>
        <div class="kicker">Voice · powered by Robovoice</div>
        <h1>Voice runs on Robovoice</h1>
        <p class="lead">InfiniBot's voice — live calls, speech-to-text, the voices your agents speak with — comes from Robovoice. The Robovoice plugin is turned off on this install.</p>
        <div class="row">
          <button class="lg" ?disabled=${this.busy !== null}
            @click=${() => this.act("enable", () => this.actions.enablePlugin(), "Robovoice is on.", false)}>
            ${this.busy === "enable" ? "Turning on…" : "Turn on Robovoice"}
          </button>
          <a class="btn quiet lg" href=${ROBOVOICE_SITE} target="_blank" rel="noopener">What is Robovoice? ↗</a>
        </div>
        ${this.renderNote()}
      </div>
      ${this.orb()}
    </section>`;
  }

  private renderConnect(linking: boolean) {
    const s = this.status;
    const p = s?.pending;
    const relink = Boolean(s?.unlinkedAt);
    return html`
      <section class="hero compact" data-testid="voice-connect">
        <div>
          <div class="kicker">Cloud voice · Robovoice (optional)</div>
          <h1>${relink ? "Reconnect Robovoice to talk to your agents" : "Connect Robovoice to talk to your agents"}</h1>
          <p class="lead">
            Cloud voice is an optional, free alternative to local voice: Robovoice listens (speech-to-text), lets your agent think,
            and answers out loud (text-to-speech) with studio voices — in the browser, on the phone app or on Robovoice Desktop.
            Connecting makes this computer a Robovoice <b>location</b> and turns your agents into voice agents there. No credits needed.
          </p>
          ${this.intentNote ? html`<div class="banner warn" style="margin-bottom:16px;" data-testid="voice-intent-note">${this.intentNote}</div>` : nothing}
          ${linking && p
            ? html`<div class="code-box" data-testid="voice-link-pending">
                <div class="row"><span class="spinner"></span>
                  <span>${p.status === "linking" ? "Approved — creating your location…" : "Approve this code in Robovoice (signed in as an org admin):"}</span></div>
                <div class="row between">
                  <span class="code" data-testid="voice-link-code">${p.userCode}</span>
                  <div class="row">
                    <button class="quiet" @click=${() => void this.copyCode(p.userCode)}>${this.copied ? "Copied ✓" : "Copy code"}</button>
                    <a class="btn" href=${p.verificationUriComplete} target="_blank" rel="noopener" data-testid="voice-link-open">Open approval page ↗</a>
                  </div>
                </div>
                <div class="mono muted">${p.verificationUriComplete}</div>
                <div><button class="quiet" ?disabled=${this.busy !== null}
                  @click=${() => this.act("cancel", () => this.actions.linkCancel())}>Cancel</button></div>
              </div>`
            : html`<ol class="steps">
                  <li><b class="n">1</b><span><b>Sign in with a code.</b> We show a short code; approve it in Robovoice as an org admin.</span></li>
                  <li><b class="n">2</b><span><b>This computer becomes a location</b> — “InfiniBot · ${s?.device?.name ?? "this computer"}” — with its own device.</span></li>
                  <li><b class="n">3</b><span><b>Talk.</b> Your main agent is a voice agent right away; call it from here or say “hey InfiniBot”.</span></li>
                </ol>
                <div class="row">
                  <button class="lg" id="voice-connect-btn" data-testid="voice-connect-btn" ?disabled=${this.busy !== null} @click=${() => void this.startLink()}>
                    ${this.busy === "link" ? html`<span class="spinner"></span> Starting…` : relink ? "Reconnect Robovoice" : "Connect Robovoice"}
                  </button>
                  <a class="btn quiet lg" href=${ROBOVOICE_SITE} target="_blank" rel="noopener">Open robovoice.io ↗</a>
                </div>
                <div style="margin-top:14px;">
                  <button class="quiet" style="min-height:30px;padding:4px 10px;font-size:12px;" @click=${() => (this.showSelfHosted = !this.showSelfHosted)}>
                    ${this.showSelfHosted ? "Use Robovoice cloud" : "Self-hosted Robovoice?"}
                  </button>
                  ${this.showSelfHosted
                    ? html`<div class="field" style="margin-top:10px;max-width:420px;">
                        <label for="voice-selfhosted-url">Your Robovoice URL (local voice = your own Robovoice stack)</label>
                        <input id="voice-selfhosted-url" type="url" placeholder="http://<robovoice-host>:3011" .value=${this.selfHostedUrl}
                          @input=${(e: Event) => (this.selfHostedUrl = (e.target as HTMLInputElement).value)} />
                      </div>`
                    : nothing}
                </div>`}
          ${s?.remoteError && !linking ? html`<div class="note warn">${s.remoteError}</div>` : nothing}
          ${this.renderNote()}
        </div>
        ${this.orb()}
      </section>`;
  }

  private renderNote() {
    return this.note ? html`<div class="note ${this.note.error ? "bad" : "ok"}" role="status" data-testid="voice-note">${this.note.text}</div>` : nothing;
  }

  private renderConsole() {
    const s = this.status!;
    const stale = s.remote?.stale ?? false;
    return html`
      <header class="head" data-testid="voice-console-head">
        <div style="min-width:0;">
          <div class="kicker">Voice · Robovoice</div>
          <h1 data-testid="voice-org">${s.org?.name ?? "—"}</h1>
          <div class="row muted">
            ${s.device?.state ? html`<span class="dot ${s.device.state !== "online" ? "off" : ""}"></span>` : nothing}
            <span data-testid="voice-location">${s.location?.name ?? "—"}</span>
            ${s.device?.state
              ? html`<span data-testid="voice-device-state" title="This install's Robovoice edge device">· edge device ${s.device.state}</span>`
              : this.remoteLoading
                ? this.skel("90px", "12px", "Loading device state from Robovoice")
                : nothing}
            ${s.desktop?.running ? html`<span>· Robovoice Desktop running</span>` : nothing}
            <a class="btn quiet" style="min-height:28px;padding:3px 10px;" href=${dashboardUrl(s)} target="_blank" rel="noopener" data-testid="voice-dashboard-link">Dashboard ↗</a>
          </div>
        </div>
        <div class="wallet" data-testid="voice-free" data-wallet="free">
          <span class="kicker">Cloud voice</span>
          <span class="amt">Free</span>
          <span class="muted">No credits or top-ups</span>
        </div>
      </header>
      ${s.remoteError && !this.remoteLoading
        ? html`<div class="banner ${stale ? "warn" : "bad"}" role="alert" data-testid="voice-remote-error">
            <span><strong>Robovoice didn't answer.</strong> ${s.remoteError}
              ${stale && s.remote ? html`<br /><span class="muted">Showing Robovoice's last answer from ${ageText(s.remote.fetchedAt)}.</span>` : html`<br /><span class="muted">Org and location come from this install's link record; live Robovoice data is hidden until it answers.</span>`}</span>
            <button class="ghost" data-testid="voice-remote-retry" @click=${() => void this.retryRemote()}>Retry</button>
          </div>`
        : nothing}
      ${this.renderBusy()}
      ${this.renderNote()}
      ${this.section === "pipeline"
          ? this.renderPipeline()
          : this.section === "agents"
            ? this.renderAgents()
            : this.section === "characters"
              ? this.renderCharacters()
              : this.section === "llm"
                ? this.renderVoiceLlm()
                : this.renderAccount()}
    `;
  }

  /** Robovoice couldn't take the call (fair-use limit / busy): friendly line + one-click switch to local voice. */
  private renderBusy() {
    if (this.engine === "local") return nothing;
    const err = this.call.phase === "failed" || this.call.media === "unavailable" ? (this.call.error ?? this.call.mediaError ?? "") : "";
    if (!isCloudVoiceBusy(err) && !isCloudVoiceBusy(this.note?.error ? this.note.text : "")) return nothing;
    return html`<div class="banner warn" role="alert" data-testid="voice-cloud-busy">
      <span><strong>Cloud voice is busy.</strong> Switch to local voice to keep talking — it runs on this computer.</span>
      <button class="btn" data-testid="voice-switch-local" ?disabled=${this.busy !== null}
        @click=${() => void this.chooseEngine("auto")}>Switch to local voice</button>
    </div>`;
  }

  /**
   * Wake word: an on-device keyword spotter in this browser (Web Speech with
   * processLocally) — it only listens for the phrases and starts a Robovoice
   * call; no audio leaves the machine and nothing local answers.
   */
  private renderWakeWord() {
    const st = getWakeWordStatus();
    const phrases = listRegisteredWakePhrases();
    const state = !st.optedIn ? "Off" : st.blocked ? "Unavailable" : st.listening ? "Listening" : "Starting…";
    return html`<section class="card" data-testid="voice-wake-word">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
        <div>
          <div class="kicker">Wake word</div>
          <div class="muted" style="margin-top:4px;max-width:46rem;">Say “hey infinibot” (or “hey &lt;agent&gt;”) to start a voice call${this.engine === "local" ? "" : " on Robovoice"}. Detection runs on this device's own speech recognizer — no audio is sent anywhere.</div>
        </div>
        <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;">
          <input type="checkbox" data-testid="voice-wake-toggle" .checked=${st.optedIn}
            @change=${(e: Event) => { setWakeWordOptIn((e.target as HTMLInputElement).checked); this.requestUpdate(); }} />
          <span>${st.optedIn ? "On" : "Off"}</span>
        </label>
      </div>
      <div class="kv" style="margin-top:12px;">
        <span class="muted">Status</span>
        <span data-testid="voice-wake-status">${state}${st.blocked ? html` — <span class="muted">${st.blocked}</span>` : nothing}
          ${st.blocked ? html` <button class="quiet" style="min-height:28px;padding:2px 10px;" @click=${() => { resetWakeErrors(); this.requestUpdate(); }}>Retry</button>` : nothing}</span>
        <span class="muted">Language</span>
        <span><input type="text" aria-label="Wake word language" style="max-width:120px;" .value=${st.language}
          @change=${(e: Event) => { setWakeWordLanguage((e.target as HTMLInputElement).value); this.requestUpdate(); }} /></span>
        <span class="muted">Phrases</span>
        <span>${phrases.length ? phrases.slice(0, 8).join(" · ") + (phrases.length > 8 ? ` · +${phrases.length - 8}` : "") : "—"}</span>
      </div>
    </section>`;
  }

  private renderPipeline() {
    return html`<section data-testid="voice-pipeline">
      <div class="muted" style="margin:0 0 10px;">${this.status?.cloud
        ? html`Speech-to-text → language model → voice that your calls run on InfiniBot Cloud's hosted voice agent. Read-only: InfiniBot Cloud doesn't support editing it.`
        : html`Speech-to-text → language model → voice for calls at <b>${this.status?.location?.name ?? "your location"}</b>. Saved to Robovoice.`}</div>
      <rv-pipeline-editor @rv-pipeline-saved=${() => { void this.loadVoice(); void this.loadPipelineView(); }}></rv-pipeline-editor>
    </section>`;
  }

  private renderAgents() {
    const d = this.voiceAgents;
    return html`<section class="card" data-testid="voice-agents">
      <div class="row between" style="margin-bottom:8px;">
        <h2 style="margin:0;">Voice agents</h2>
        <span class="muted">${d?.location ? `Characters at ${d.location} · synced to Robovoice` : "Synced to Robovoice"}</span>
      </div>
      <div class="muted" style="margin-bottom:12px;">A voice agent is an InfiniBot agent callable at your Robovoice location. Its model step is InfiniBot (the gateway agent or a CLI agent) or the location's own LLM; the voice and language are Robovoice's.</div>
      ${d?.voicesError ? html`<div style="margin-bottom:10px;">${this.renderFailed("the agents' voices", d.voicesError, () => void this.loadVoice(), "voice-agents-voices-error")}</div>` : nothing}
      ${!d
        ? this.agentsError
          ? this.renderFailed("your voice agents", this.agentsError, () => void this.loadVoice(), "voice-agents-error")
          : html`<div class="skel-list" data-testid="voice-agents-loading">${[0, 1, 2].map(() => this.skel("100%", "40px", "Loading voice agents"))}</div>`
        : d.agents.length === 0
          ? this.renderEmpty("No InfiniBot agents to make voice agents from.", "voice-agents-empty")
          : html`<div class="agents-head"><span>Agent</span><span>Voice agent</span><span>Answers via</span><span>Voice (Robovoice)</span><span>Status</span></div>
            ${d.agents.map(
              (a) => html`<robovoice-agent-voice variant="row" agent-id=${a.id} .payload=${d}
                @robovoice-agent-changed=${(e: CustomEvent<VoiceAgentsPayload>) => {
                  this.voiceAgents = e.detail;
                  void this.loadVoice();
                }}></robovoice-agent-voice>`,
            )}
            <div class="muted" style="margin-top:10px;">Voices are Robovoice's: change one in <a href="#" @click=${(e: Event) => { e.preventDefault(); this.section = "pipeline"; }}>Pipeline</a> (agent scope) or the Robovoice dashboard.</div>`}
    </section>`;
  }

  private renderCharacters() {
    const chars = this.characters;
    const map = this.settings?.settings.characterMap ?? {};
    const def = this.settings?.settings.defaultCharacterId ?? "";
    const agents = this.voiceAgents?.agents ?? [];
    const nameOf = (id: string) => chars?.find((c) => c.id === id)?.name ?? id;
    const head = html`<div class="row between" style="margin-bottom:8px;">
        <h2 style="margin:0;">Characters</h2>
        ${chars ? html`<span class="muted" data-testid="voice-characters-count">${chars.length} Robovoice character${chars.length === 1 ? "" : "s"}</span>` : nothing}
      </div>
      <div class="muted" style="margin-bottom:12px;">Voice agents get their own character at your location. Agents that aren't voice agents can borrow an existing Robovoice character instead.</div>`;
    if (this.charactersError) {
      return html`<section class="card" data-testid="voice-characters">${head}
        ${this.renderFailed("your characters", this.charactersError, () => void this.loadCharacters(), "voice-characters-error")}</section>`;
    }
    if (!chars) {
      return html`<section class="card" data-testid="voice-characters">${head}
        <div class="skel-list" data-testid="voice-characters-loading">${[0, 1, 2, 3].map(() => this.skel("100%", "36px", "Loading characters from Robovoice"))}</div></section>`;
    }
    if (!chars.length) {
      return html`<section class="card" data-testid="voice-characters">${head}
        ${this.renderEmpty("Your Robovoice organization has no agents at this location yet.", "voice-characters-empty")}</section>`;
    }
    const own = (id: string) => chars.some((c) => c.id === id);
    const issues = this.configIssues;
    return html`<section class="card" data-testid="voice-characters">${head}
      ${issues.length
        ? html`<div class="banner warn" role="alert" data-testid="voice-config-issues" style="margin-bottom:12px;">
            <div><strong>${issues.length} setting${issues.length === 1 ? "" : "s"} point${issues.length === 1 ? "s" : ""} outside your Robovoice organization.</strong>
              Calls never use them; clear them so what you see here is what Robovoice runs.</div>
            <ul style="margin:6px 0 8px 18px;padding:0;">${issues.map((i) => html`<li class="mono" style="font-size:12px;">${i.message}</li>`)}</ul>
            <button class="btn" data-testid="voice-config-fix" ?disabled=${this.busy === "config-fix"}
              @click=${() => this.act("config-fix", () => this.actions.validateConfig(true), "Cleared the stale ids.", false).then(() => Promise.all([this.loadSettings(), this.loadCharacters()]))}>Clear stale ids</button>
          </div>`
        : nothing}
      <div class="field" style="max-width:420px;">
        <label for="voice-default-char">Default character (agents without one)</label>
        <select id="voice-default-char" @change=${(e: Event) => this.act("default", () => this.actions.setDefaultCharacter((e.target as HTMLSelectElement).value), "Default character saved.", false).then(() => this.loadSettings())}>
          <option value="" ?selected=${!def}>None (agents without a character can't take calls)</option>
          ${def && !own(def) ? html`<option value=${def} selected disabled>${def} (not in your organization)</option>` : nothing}
          ${chars.map((c) => html`<option value=${c.id} ?selected=${def === c.id}>${c.name}</option>`)}
        </select>
      </div>
      <table>
        <thead><tr><th>Agent</th><th>Character</th><th class="hide-sm">Voice · language (Robovoice)</th></tr></thead>
        <tbody>
          ${agents.map((a) => {
            if (a.voiceAgent && a.characterId) {
              const rv = a.robovoice;
              const own = chars.find((c) => c.id === a.characterId);
              return html`<tr data-agent=${a.id}><td>${a.emoji ?? ""} ${a.name}</td><td><span class="chip good">Own character</span> <span class="muted hide-sm">${own?.name ?? rv?.characterName ?? ""}</span> <span class="mono muted hide-sm">${a.characterId}</span></td>
                <td class="hide-sm muted" data-testid="voice-character-voice">${rv
                  ? [rv.tts.provider, rv.tts.voice, rv.language].filter(Boolean).join(" · ") || "—"
                  : rv === undefined ? this.skel("120px") : "—"}</td></tr>`;
            }
            const mapped = map[a.id] ?? "";
            const ch = chars.find((c) => c.id === mapped);
            return html`<tr data-agent=${a.id}><td>${a.emoji ?? ""} ${a.name}</td><td>
                <select aria-label="Character for ${a.id}" @change=${(e: Event) => this.act(`map:${a.id}`, () => this.actions.setCharacter(a.id, (e.target as HTMLSelectElement).value || null), "Character saved.", false).then(() => this.loadSettings())}>
                  <option value="" ?selected=${!mapped}>${def && own(def) ? `Default (${nameOf(def)})` : "None (no calls)"}</option>
                  ${mapped && !own(mapped) ? html`<option value=${mapped} selected disabled>${mapped} (not in your organization)</option>` : nothing}
                  ${chars.map((c) => html`<option value=${c.id} ?selected=${mapped === c.id}>${c.name}</option>`)}
                </select></td>
              <td class="hide-sm muted">${[ch?.tts_provider, ch?.language].filter(Boolean).join(" · ")}</td></tr>`;
          })}
        </tbody>
      </table>
    </section>`;
  }

  /** InfiniBot-side turns of the current (or last) call, newest first. */
  private callTurns() {
    const turns = this.voiceLlm?.turns ?? [];
    const since = this.call.startedAt ? Date.parse(this.call.startedAt) - 5000 : null;
    if (since === null || Number.isNaN(since)) return [];
    return turns.filter((t) => t.call !== "test" && Date.parse(t.at) >= since);
  }

  private renderVoiceLlm() {
    const v = this.voiceLlm;
    const emails = this.ownerEmailsDraft ?? (v?.ownerCallerEmails ?? []).join(", ");
    const publicUrl = this.publicUrlDraft ?? this.settings?.settings.mcpPublicUrl ?? v?.publicUrl ?? "";
    const agents = this.testableAgents();
    if (!v) {
      return html`<section class="card" data-testid="voice-llm">${this.voiceLlmError
        ? this.renderFailed("the voice-LLM status", this.voiceLlmError, () => void this.loadVoice(), "voice-llm-error")
        : html`<div class="skel-list" data-testid="voice-llm-loading">${[0, 1, 2, 3].map(() => this.skel("100%", "20px", "Loading voice LLM status"))}</div>`}</section>`;
    }
    return html`<div class="two">
      <section class="card" data-testid="voice-llm">
        <div class="row between" style="margin-bottom:8px;">
          <h2 style="margin:0;">InfiniBot as the voice LLM</h2>
          <span class="chip ${v?.bound ? "good" : "flag"}" data-testid="voice-llm-bound">${v?.bound ? "Bound at the location" : "Not bound"}</span>
        </div>
        <div class="muted" style="margin-bottom:12px;">Robovoice's voice agent calls this gateway for each turn (streamed) with a token scoped to your location — never the gateway password.</div>
        <div class="kv">
          <span class="muted">Callback URL</span><span class="mono">${v?.baseUrl ?? "—"}</span>
          <span class="muted">Location token</span><span class="mono">${v?.token?.hint ?? "minted on the next sync"}</span>
          <span class="muted">Answers for</span><span>${v?.agents.length ? v.agents.join(", ") : "—"}</span>
          <span class="muted">First token (p50)</span><span>${v?.summary.firstTokenP50Ms != null ? `${v.summary.firstTokenP50Ms} ms · ${v.summary.ok}/${v.summary.turns} ok` : "no turns yet"}</span>
        </div>
        <div class="field" style="margin-top:14px;">
          <label for="voice-public-url">Public URL Robovoice reaches this gateway on (tunnel / Tailscale Funnel)</label>
          <div class="row">
            <input id="voice-public-url" style="flex:1;min-width:200px;" placeholder="https://<host>.ts.net" .value=${publicUrl}
              @input=${(e: Event) => (this.publicUrlDraft = (e.target as HTMLInputElement).value)} />
            <button class="ghost" ?disabled=${this.publicUrlDraft === null || this.busy !== null}
              @click=${() => this.act("url", async () => {
                const r = await this.actions.setPublicUrl(normalizePublicUrl(this.publicUrlDraft ?? ""));
                this.publicUrlDraft = null;
                if (r.sync.mcp?.status === "error") throw new Error(`Saved; sync failed: ${r.sync.mcp.error ?? "unknown"}`);
              }, "Saved and synced to Robovoice.")}>Save + sync</button>
          </div>
        </div>
        <div class="field">
          <label for="voice-owner-emails">Owner caller emails — Robovoice-verified callers treated as you (full tools)</label>
          <div class="row">
            <input id="voice-owner-emails" style="flex:1;min-width:200px;" placeholder="you@example.com" .value=${emails}
              @input=${(e: Event) => (this.ownerEmailsDraft = (e.target as HTMLInputElement).value)} />
            <button class="ghost" ?disabled=${this.ownerEmailsDraft === null || this.busy !== null}
              @click=${() => this.act("emails", async () => {
                await this.actions.setOwnerCallerEmails(parseEmails(this.ownerEmailsDraft ?? ""));
                this.ownerEmailsDraft = null;
                this.voiceLlm = await this.actions.voiceLlmStatus();
              }, "Owner caller emails saved.", false)}>Save</button>
          </div>
        </div>
        <div class="field" data-testid="voice-llm-mode">
          <label for="voice-llm-mode-select">How a turn is answered</label>
          <div class="row">
            <select id="voice-llm-mode-select" style="flex:1;min-width:200px;" ?disabled=${this.busy !== null}
              @change=${(e: Event) => this.act("llm-mode", async () => {
                this.voiceLlm = await this.actions.setVoiceLlm({ mode: (e.target as HTMLSelectElement).value === "agent" ? "agent" : "auto" });
              }, "Saved.", false)}>
              <option value="auto" ?selected=${v.mode !== "agent"}>Fast — talk directly, full agent only for tool work</option>
              <option value="agent" ?selected=${v.mode === "agent"}>Full agent on every turn (slower)</option>
            </select>
          </div>
          <div class="muted" style="margin-top:6px;">Fast answers conversation with one direct streaming model call (about a second). When a request needs tools or your data, the agent says a short "one moment" and the full agent takes over.</div>
        </div>
        <div class="field">
          <label for="voice-llm-fast-model">Model for fast turns (provider/model) — empty = the agent's own model</label>
          <div class="row">
            <input id="voice-llm-fast-model" style="flex:1;min-width:200px;" placeholder="e.g. groq/openai/gpt-oss-120b" .value=${this.fastModelDraft ?? v.fastModel ?? ""}
              @input=${(e: Event) => (this.fastModelDraft = (e.target as HTMLInputElement).value)} />
            <button class="ghost" ?disabled=${this.fastModelDraft === null || this.busy !== null}
              @click=${() => this.act("llm-model", async () => {
                this.voiceLlm = await this.actions.setVoiceLlm({ fastModel: (this.fastModelDraft ?? "").trim() });
                this.fastModelDraft = null;
              }, "Saved.", false)}>Save</button>
          </div>
        </div>
        <div class="row">
          <button class="quiet" id="voice-rotate-token" ?disabled=${!v?.locationId || this.busy !== null}
            @click=${() => this.act("rotate", async () => {
              const r = await this.actions.rotateVoiceLlm();
              this.voiceLlm = r;
              if (r.syncError) throw new Error(`Token rotated; sync failed: ${r.syncError}`);
            }, "Token rotated and re-sent to Robovoice.", false)}>Rotate token</button>
        </div>
      </section>
      <section class="card" data-testid="voice-llm-test">
        <h2>Test a voice turn</h2>
        <div class="muted" style="margin-bottom:12px;">Runs one turn through the exact path Robovoice's callback uses and times the first token.</div>
        <div class="row" style="align-items:flex-end;">
          <div class="field" style="flex:1;min-width:160px;margin:0;">
            <label for="voice-test-agent">Agent</label>
            <select id="voice-test-agent" ?disabled=${!agents.length} @change=${(e: Event) => (this.testAgent = (e.target as HTMLSelectElement).value)}>
              ${agents.length
                ? agents.map((a) => html`<option value=${a.id} ?selected=${a.id === this.testAgent}>${a.name}</option>`)
                : html`<option value="" selected>No voice agent answers via InfiniBot</option>`}
            </select>
          </div>
          <button ?disabled=${this.busy !== null || !this.testAgent}
            @click=${() => this.act("test", async () => {
              if (!this.testAgent) return;
              this.testResult = null;
              this.testResult = await this.actions.testVoiceLlm(this.testAgent);
              this.voiceLlm = await this.actions.voiceLlmStatus();
            }, undefined, false)}>${this.busy === "test" ? "Testing…" : "Test turn"}</button>
        </div>
        ${this.testResult
          ? html`<div class="card" style="margin-top:12px;padding:12px 14px;" data-testid="voice-llm-test-out">
              <div>${this.testResult.text}</div>
              <div class="mono muted" style="margin-top:6px;">first token ${this.testResult.firstTokenMs ?? "—"} ms · total ${this.testResult.totalMs} ms · ${this.testResult.backend}</div>
            </div>`
          : nothing}
        ${v?.turns.length
          ? html`<table style="margin-top:14px;">
              <thead><tr><th>When</th><th>Agent</th><th>Path</th><th class="hide-sm">Prep</th><th>First token</th><th class="hide-sm">First sentence</th><th class="hide-sm">Total</th></tr></thead>
              <tbody>${v.turns.slice(0, 8).map(
                (t) => html`<tr><td class="muted">${new Date(t.at).toLocaleTimeString()}</td><td>${t.agentId} <span class="mono muted">${t.model ?? t.backend}</span></td>
                  <td class="mono">${t.path ?? "agent"}</td><td class="hide-sm mono">${t.prepMs ?? "—"} ms</td>
                  <td class=${t.ok ? "" : "bad"}>${t.ok ? `${t.firstTokenMs ?? "—"} ms` : (t.error ?? "failed")}</td>
                  <td class="hide-sm mono">${t.firstSentenceMs ?? "—"} ms</td><td class="hide-sm mono">${t.totalMs} ms</td></tr>`,
              )}</tbody>
            </table>`
          : nothing}
      </section>
    </div>`;
  }

  private renderAccount() {
    const s = this.status!;
    return html`${this.renderEngine()}<section class="card" data-testid="voice-account">
      <div class="row between" style="margin-bottom:12px;">
        <h2 style="margin:0;">Robovoice link</h2>
        <div class="row">
          <button class="quiet" ?disabled=${this.busy !== null} @click=${() => this.act("sync", () => this.actions.sync(), "Agents synced to Robovoice.")}>${this.busy === "sync" ? "Syncing…" : "Sync agents"}</button>
          <button class="danger" data-testid="voice-unlink" ?disabled=${this.busy !== null}
            @click=${() => confirm("Unlink this install from Robovoice? The device is retired; the location and its agents stay in your org.") &&
              this.act("unlink", () => this.actions.unlink(), "Unlinked. Reconnect any time.")}>Unlink</button>
          ${s.signedIn
            ? html`<button class="danger" ?disabled=${this.busy !== null}
                @click=${() => confirm("Sign out of Robovoice on this install?") && this.act("logout", () => this.actions.logout(), "Signed out.")}>Sign out</button>`
            : nothing}
        </div>
      </div>
      <div class="kv">
        <span class="muted">Organization</span><span>${s.org?.name ?? "—"}${s.userEmail ? html` <span class="muted">· ${s.userEmail}</span>` : nothing}</span>
        <span class="muted">Location</span><span>${s.location?.name ?? "—"} <a href=${dashboardUrl(s)} target="_blank" rel="noopener" style="color:var(--rv-accent);">Open in Robovoice ↗</a></span>
        <span class="muted">Edge device</span><span class="mono">${s.device?.id ?? "—"}${s.device?.state ? ` · ${s.device.state}` : ""}</span>
        <span class="muted">Robovoice</span><span class="mono">${s.apiBase}</span>
        <span class="muted">Robovoice Desktop</span><span>${s.desktop?.running ? "running — calls use its local pipeline" : s.desktop?.installed ? "installed, not running" : "not installed"}</span>
        <span class="muted">Linked agents</span><span>${s.agents.map((a) => a.name).join(", ") || "—"}</span>
      </div>
      ${s.secretsEncrypted === false ? html`<div class="note warn">Robovoice credentials on this install are not encrypted (install key unavailable).</div>` : nothing}
      <div class="note muted">Want voice fully local? Choose Local voice under Voice engine above — it runs on this machine with no account.
        Advanced connection settings (self-hosted URL, edge device keys, agent tools) are on the <a href="/robovoice" style="color:var(--rv-accent);"
          @click=${(e: Event) => this.navigate(e, "/robovoice")}>Robovoice plugin page</a>.</div>
    </section>
    ${this.renderWakeWord()}`;
  }

  private navigate(e: Event, path: string): void {
    e.preventDefault();
    this.dispatchEvent(new CustomEvent("voice-navigate", { detail: { path }, bubbles: true, composed: true }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "voice-robovoice-console": VoiceRobovoiceConsole;
  }
}
