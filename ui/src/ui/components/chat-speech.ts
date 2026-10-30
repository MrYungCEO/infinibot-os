/**
 * Speech for the chat sidebar (<agent-chat-modal>) and chat mic. Local voice
 * (the default) reads aloud with this gateway's local TTS (/api/voice/tts →
 * Kokoro) and transcribes with local Whisper (/api/voice/stt) — free, no
 * account. With cloud voice (Robovoice) selected it is Robovoice speech:
 *
 *   • speech strip under the header — read-aloud toggle, voice/model picker,
 *     wallet + this session's speech spend; "Connect Robovoice" hint when the
 *     plugin is off or unlinked, "Wallet empty — top up" (controls disabled) at $0
 *   • per-message Read / Stop with the credit estimate and the live charge
 *   • talk button in the composer: click to toggle, hold to push-to-talk;
 *     recording → processing → transcript in the composer (or auto-send)
 *
 * Every synthesis / transcription is one robovoice.speech.tts / .stt request,
 * which Robovoice charges to the linked org wallet as its own ledger line.
 * The catalog (providers, models, voices, prices) is robovoice.speech.catalog —
 * the org's real account; there are no built-in choices.
 */

import { css, html, nothing, svg as svgPart, type ReactiveController, type ReactiveControllerHost, type TemplateResult } from "lit";
import { clipToWav } from "../lib/to-wav.js";

import type { GatewayBrowserClient } from "../gateway";
import { PLUGIN_HOST_EVENT, isTabAvailable } from "../plugin-host";
import { gatewayHttpBase } from "../gateway-http-auth";
import { VOICE_PROVIDER_EVENT, isCloudVoiceActive, switchToLocalVoice } from "../controllers/voice-provider";
import {
  WALLET_EMPTY_TEXT,
  estimateSttCredits,
  estimateTtsCredits,
  formatCredits,
  isWalletEmptyError,
  loadSpeechPrefs,
  reconcilePrefs,
  saveSpeechPrefs,
  speechChunks,
  speechGate,
  speechText,
  sttReady,
  ttsReady,
  type SpeechCatalog,
  type SpeechCharge,
  type SpeechGate,
  type SpeechPrefs,
  type SpeechUnavailable,
  type SpeechWallet,
  LOCAL_SPEECH_CATALOG,
} from "./chat-speech-state";

type Host = ReactiveControllerHost &
  HTMLElement & {
    client: GatewayBrowserClient | null;
    /** Put a transcript in the composer (and send it when autoSend). */
    applyTranscript(text: string, autoSend: boolean): void;
  };

type TalkState = "idle" | "recording" | "processing" | "error";
type Catalog = SpeechCatalog & { topUpUrl?: string };

const CATALOG_TTL_MS = 60_000;
/** Held longer than this = push-to-talk (release stops); shorter = toggle. */
const PUSH_TO_TALK_MS = 450;
/**
 * ui-targets id of the Talk control. The button below carries it as a literal;
 * a surface that renders a stand-in for the same control in another gate state
 * (e.g. the "Connect Robovoice" chip) binds this constant instead, so the id
 * keeps exactly one literal site in the markup (see src/ui-targets tests).
 */
export const TALK_TARGET_ID = "control:chat/talk";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function b64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function blobToB64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error ?? new Error("could not read the recording"));
    r.readAsDataURL(blob);
  });
}

function pickRecorderMime(): string {
  const MR = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) {
    try {
      if (MR?.isTypeSupported?.(m)) return m;
    } catch {
      /* keep looking */
    }
  }
  return "";
}

export class ChatSpeechController implements ReactiveController {
  prefs: SpeechPrefs = loadSpeechPrefs(globalThis.localStorage);
  private catalog: Catalog | SpeechUnavailable | null = null;
  private rpcError: string | null = null;
  private loaded = false;
  private loadedAt = 0;
  private loading: Promise<void> | null = null;
  private wallet: SpeechWallet | null = null;
  private settingsOpen = false;

  /** Credits charged per message key, and in total this session. */
  private charged = new Map<string, number>();
  private sessionCredits = 0;
  private sessionRequests = 0;
  private speechError: string | null = null;

  // playback
  private playingKey: string | null = null;
  private pendingKey: string | null = null;
  private audio: HTMLAudioElement | null = null;
  private audioUrl: string | null = null;
  private playToken = 0;

  // talk
  talk: TalkState = "idle";
  private talkError: string | null = null;
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private recStartedAt = 0;
  private recTimer: ReturnType<typeof setInterval> | null = null;
  private pressAt = 0;
  private lastTalkCharge: number | null = null;

  constructor(private readonly host: Host) {
    host.addController(this);
  }

  private onPluginHost = () => {
    this.loadedAt = 0;
    void this.refresh();
  };

  hostConnected(): void {
    window.addEventListener(PLUGIN_HOST_EVENT, this.onPluginHost);
    window.addEventListener(VOICE_PROVIDER_EVENT, this.onPluginHost);
  }

  hostDisconnected(): void {
    window.removeEventListener(PLUGIN_HOST_EVENT, this.onPluginHost);
    window.removeEventListener(VOICE_PROVIDER_EVENT, this.onPluginHost);
    this.stop();
    this.cancelRecording();
  }

  private update() {
    this.host.requestUpdate();
  }

  private get pluginEnabled(): boolean {
    return isTabAvailable("robovoice");
  }

  /** Local voice (default): this gateway's own STT/TTS. Cloud voice: Robovoice speech. */
  get local(): boolean {
    return !isCloudVoiceActive();
  }

  get gate(): SpeechGate {
    return speechGate({
      pluginEnabled: this.local || this.pluginEnabled,
      loaded: this.loaded,
      catalog: this.catalog,
      rpcError: this.rpcError,
      wallet: this.wallet,
    });
  }

  private get cat(): Catalog | null {
    const g = this.gate;
    return g.kind === "ready" || g.kind === "empty" ? (g.catalog as Catalog) : null;
  }

  /** Load (or refresh) the org's speech catalog; cheap to call on every open. */
  refresh(force = false): Promise<void> {
    if (this.local) {
      this.catalog = LOCAL_SPEECH_CATALOG;
      this.wallet = LOCAL_SPEECH_CATALOG.wallet;
      this.rpcError = null;
      this.loaded = true;
      this.loadedAt = Date.now();
      // One local voice and one local STT model: pick them (no setup step).
      const next = reconcilePrefs(
        {
          ...this.prefs,
          ttsProvider: "local",
          ttsVoice: "configured",
          ttsModel: null,
          sttProvider: "local",
          sttModel: "whisper",
        },
        LOCAL_SPEECH_CATALOG,
      );
      next.readAloud = this.prefs.readAloud;
      if (JSON.stringify(next) !== JSON.stringify(this.prefs)) this.setPrefs(next);
      else this.update();
      return Promise.resolve();
    }
    if (this.catalog === LOCAL_SPEECH_CATALOG) {
      // Back on cloud voice: drop the local catalog, read Robovoice's.
      this.catalog = null;
      this.wallet = null;
      this.loaded = false;
    }
    if (!this.pluginEnabled) {
      this.loaded = true;
      this.update();
      return Promise.resolve();
    }
    if (!force && this.loaded && Date.now() - this.loadedAt < CATALOG_TTL_MS) return Promise.resolve();
    const client = this.host.client;
    if (!client) return Promise.resolve();
    this.loading ??= client
      .request<Catalog | SpeechUnavailable>("robovoice.speech.catalog", {})
      .then((c) => {
        this.catalog = c;
        this.rpcError = null;
        if (c.available) {
          this.wallet = c.wallet;
          const next = reconcilePrefs(this.prefs, c);
          if (JSON.stringify(next) !== JSON.stringify(this.prefs)) this.setPrefs(next);
        }
      })
      .catch((e) => {
        this.catalog = null;
        this.rpcError = errText(e);
      })
      .finally(() => {
        this.loaded = true;
        this.loadedAt = Date.now();
        this.loading = null;
        this.update();
      });
    return this.loading;
  }

  private setPrefs(p: SpeechPrefs) {
    this.prefs = p;
    saveSpeechPrefs(globalThis.localStorage, p);
    this.update();
  }

  private noteCharge(key: string | null, c: SpeechCharge) {
    this.wallet = c.wallet;
    this.sessionRequests++;
    this.sessionCredits += c.credits;
    if (key) this.charged.set(key, (this.charged.get(key) ?? 0) + c.credits);
  }

  private noteError(e: unknown): string {
    if (isWalletEmptyError(e)) {
      const w = this.wallet;
      this.wallet = { availableCredits: 0, balanceCredits: w?.balanceCredits ?? 0, enforcement: "enforce", empty: true };
      return WALLET_EMPTY_TEXT;
    }
    return errText(e);
  }

  // --- read-aloud ----------------------------------------------------------------

  /** Called for every finished assistant reply of the visible thread. */
  onAssistantReply(key: string, text: string): void {
    if (!this.prefs.readAloud || this.gate.kind !== "ready" || !ttsReady(this.prefs, this.cat)) return;
    void this.speak(key, text);
  }

  estimateFor(text: string): number | null {
    if (this.local) return null;
    const c = this.cat;
    if (!c || !ttsReady(this.prefs, c) || !this.prefs.ttsProvider) return null;
    const spoken = speechText(text);
    return estimateTtsCredits(c, this.prefs.ttsProvider, this.prefs.ttsModel, spoken.length);
  }

  async speak(key: string, text: string): Promise<void> {
    const c = this.cat;
    const client = this.host.client;
    if (!c || !client || this.gate.kind !== "ready" || !ttsReady(this.prefs, c)) return;
    this.stop();
    const token = ++this.playToken;
    const chunks = speechChunks(speechText(text), c.pricing.limits.ttsMaxChars || 2000);
    if (!chunks.length) return;
    this.pendingKey = key;
    this.speechError = null;
    this.update();
    type TtsOut = { audioBase64?: string; blob?: Blob; mime: string; charge: SpeechCharge | null };
    const synth = (chunk: string): Promise<TtsOut> =>
      this.local
        ? synthLocal(chunk).then((blob) => ({ blob, mime: blob.type || "audio/mpeg", charge: null }))
        : client.request<TtsOut>("robovoice.speech.tts", {
            provider: this.prefs.ttsProvider,
            model: this.prefs.ttsModel ?? undefined,
            voice: this.prefs.ttsVoice,
            text: chunk,
          });
    try {
      // Synthesize one piece ahead of playback so long replies don't pause.
      let next: Promise<TtsOut> | null = synth(chunks[0]);
      for (let i = 0; i < chunks.length && next; i++) {
        const out: TtsOut = await next;
        if (token !== this.playToken) return;
        if (out.charge) this.noteCharge(key, out.charge);
        next = i + 1 < chunks.length && !out.charge?.wallet.empty ? synth(chunks[i + 1]) : null;
        next?.catch(() => undefined);
        await this.play(token, key, out.blob ?? b64ToBlob(out.audioBase64 ?? "", out.mime));
        if (token !== this.playToken) return;
      }
    } catch (e) {
      if (token === this.playToken) this.speechError = this.noteError(e);
    } finally {
      if (token === this.playToken) {
        this.playingKey = null;
        this.pendingKey = null;
        this.releaseAudio();
        this.update();
      }
    }
  }

  private play(token: number, key: string, clip: Blob): Promise<void> {
    this.releaseAudio();
    this.audioUrl = URL.createObjectURL(clip);
    const audio = new Audio(this.audioUrl);
    this.audio = audio;
    this.pendingKey = null;
    this.playingKey = key;
    this.update();
    return new Promise((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("This browser could not play the audio."));
      audio.play().catch((e) => (token === this.playToken ? reject(e) : resolve()));
    });
  }

  private releaseAudio() {
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio = null;
    }
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audioUrl = null;
  }

  stop(): void {
    this.playToken++;
    this.releaseAudio();
    const had = this.playingKey || this.pendingKey;
    this.playingKey = null;
    this.pendingKey = null;
    if (had) this.update();
  }

  // --- talk ----------------------------------------------------------------------

  get talkBlockedReason(): string | null {
    const g = this.gate;
    if (g.kind === "empty") return WALLET_EMPTY_TEXT;
    if (g.kind !== "ready") return this.local ? "Local speech isn't ready" : "Connect Robovoice to talk";
    if (!sttReady(this.prefs, this.cat)) return "Pick a speech-to-text model";
    return null;
  }

  /** Start a talk recording (e.g. from a wake word); same gating as the button. */
  startTalk(): Promise<void> {
    return this.startRecording();
  }

  private async startRecording(): Promise<void> {
    if (this.talk === "recording" || this.talk === "processing") return;
    const blocked = this.talkBlockedReason;
    if (blocked) {
      if (blocked.startsWith("Pick")) this.openSettings();
      return;
    }
    this.talkError = null;
    this.lastTalkCharge = null;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      this.fail("Microphone recording isn't available here (needs HTTPS or localhost).");
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      this.fail(/denied|NotAllowed/i.test(errText(e)) ? "Microphone permission was denied." : `Microphone unavailable: ${errText(e)}`);
      return;
    }
    const mime = pickRecorderMime();
    this.chunks = [];
    this.recorder = mime ? new MediaRecorder(this.stream, { mimeType: mime }) : new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (ev) => {
      if (ev.data?.size) this.chunks.push(ev.data);
    };
    this.recorder.onstop = () => void this.transcribe();
    this.recorder.start(250);
    this.recStartedAt = performance.now();
    this.talk = "recording";
    const maxSec = this.cat?.pricing.limits.sttMaxSeconds || 0;
    this.recTimer = setInterval(() => {
      if (maxSec && this.recordSeconds >= maxSec) this.stopRecording();
      this.update();
    }, 250);
    this.update();
  }

  get recordSeconds(): number {
    return this.talk === "recording" ? (performance.now() - this.recStartedAt) / 1000 : 0;
  }

  private recordedMs = 0;

  stopRecording(): void {
    if (this.talk !== "recording" || !this.recorder) return;
    this.recordedMs = performance.now() - this.recStartedAt;
    if (this.recTimer) clearInterval(this.recTimer);
    this.recTimer = null;
    this.talk = "processing";
    this.update();
    this.recorder.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  cancelRecording(): void {
    if (this.recTimer) clearInterval(this.recTimer);
    this.recTimer = null;
    if (this.recorder) {
      this.recorder.onstop = null;
      if (this.recorder.state !== "inactive") this.recorder.stop();
    }
    this.recorder = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.talk === "recording" || this.talk === "processing") this.talk = "idle";
  }

  private fail(msg: string) {
    this.talk = "error";
    this.talkError = msg;
    this.update();
  }

  private async transcribe(): Promise<void> {
    const client = this.host.client;
    const mime = this.recorder?.mimeType || "audio/webm";
    this.recorder = null;
    const blob = new Blob(this.chunks, { type: mime });
    this.chunks = [];
    if (!client || !blob.size || this.recordedMs < 300) {
      this.fail(!blob.size || this.recordedMs < 300 ? "Too short — hold the mic a little longer." : "Not connected.");
      return;
    }
    if (this.local) {
      try {
        const text = (await transcribeLocalSpeech(blob, mime)).trim();
        if (!text) {
          this.fail("Didn't catch any words.");
          return;
        }
        this.talk = "idle";
        this.update();
        this.host.applyTranscript(text, this.prefs.autoSend);
      } catch (e) {
        this.fail(errText(e));
      }
      return;
    }
    try {
      const out = await client.request<{ text: string; charge: SpeechCharge }>("robovoice.speech.stt", {
        provider: this.prefs.sttProvider,
        model: this.prefs.sttModel,
        audioBase64: await blobToB64(blob),
        mime: mime.split(";")[0],
        durationMs: Math.round(this.recordedMs),
      });
      this.noteCharge(null, out.charge);
      this.lastTalkCharge = out.charge.credits;
      const text = out.text.trim();
      if (!text) {
        this.fail("Didn't catch any words.");
        return;
      }
      this.talk = "idle";
      this.update();
      this.host.applyTranscript(text, this.prefs.autoSend);
    } catch (e) {
      this.fail(this.noteError(e));
    }
  }

  private onTalkDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (this.talk === "recording") {
      this.stopRecording();
      this.pressAt = 0;
      return;
    }
    this.pressAt = performance.now();
    void this.startRecording();
  };

  private onTalkUp = () => {
    if (this.talk === "recording" && this.pressAt && performance.now() - this.pressAt > PUSH_TO_TALK_MS) this.stopRecording();
    this.pressAt = 0;
  };

  private onTalkKey = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (this.talk === "recording") this.stopRecording();
    else void this.startRecording();
  };

  // --- settings ------------------------------------------------------------------

  openSettings(): void {
    this.settingsOpen = true;
    void this.refresh();
    this.update();
  }

  closeSettings(): void {
    this.settingsOpen = false;
    this.update();
  }

  /** Open the Robovoice page (or Plugins when the plugin is off). */
  /** Cloud voice busy: back to local voice in one click. */
  async switchLocal(): Promise<void> {
    try {
      await switchToLocalVoice(this.host.client ?? null);
      this.speechError = null;
      this.talk = "idle";
    } catch (err) {
      this.speechError = err instanceof Error ? err.message : String(err);
    }
    this.host.requestUpdate();
  }

  goConnect() {
    const app = document.querySelector("infinibot-app") as unknown as { setTab?: (t: string) => void } | null;
    app?.setTab?.(this.pluginEnabled ? "robovoice" : "plugins");
  }

  // --- render --------------------------------------------------------------------

  renderStrip(): TemplateResult | typeof nothing {
    const g = this.gate;
    if (g.kind === "hidden") return nothing;
    if (g.kind === "connect") {
      return html`<div class="sp-strip sp-hint" data-speech-state="connect">
        ${micIcon(12)}
        <span>Read-aloud &amp; talk need Robovoice.</span>
        <button class="sp-link" @click=${() => this.goConnect()}>Connect Robovoice</button>
      </div>`;
    }
    if (g.kind === "error") {
      return html`<div class="sp-strip sp-hint sp-err" data-speech-state="error" title=${g.message}>
        <span class="sp-ell">Robovoice speech unavailable: ${g.message}</span>
        <button class="sp-link" @click=${() => void this.refresh(true)}>Retry</button>
      </div>`;
    }
    const c = g.catalog as Catalog;
    const empty = g.kind === "empty";
    const ready = ttsReady(this.prefs, c);
    const voice = ready ? c.tts.find((t) => t.id === this.prefs.ttsProvider)?.voices.find((v) => v.id === this.prefs.ttsVoice) : null;
    return html`<div class="sp-wrap">
      <div class="sp-strip" data-speech-state=${empty ? "wallet-empty" : "ready"}>
        <button
          class="sp-toggle ${this.prefs.readAloud && !empty ? "on" : ""}"
          role="switch"
          aria-checked=${this.prefs.readAloud && !empty ? "true" : "false"}
          ?disabled=${empty}
          title=${empty ? WALLET_EMPTY_TEXT : ready ? (this.local ? "Read replies aloud (local voice)" : "Read replies aloud (Robovoice)") : "Pick a voice first"}
          data-ib-target="control:chat/read-aloud"
          @click=${() => (ready ? this.setPrefs({ ...this.prefs, readAloud: !this.prefs.readAloud }) : this.openSettings())}
        >
          ${speakerIcon(this.prefs.readAloud && !empty)}<span>Read aloud</span>
        </button>
        <button class="sp-voice" aria-haspopup="dialog" aria-expanded=${this.settingsOpen ? "true" : "false"}
          title=${this.local ? "Local voice & speech-to-text" : "Robovoice voice & speech-to-text"} @click=${() => (this.settingsOpen ? this.closeSettings() : this.openSettings())}>
          <span class="sp-ell">${voice ? voice.name : "Pick a voice"}</span>${chevIcon()}
        </button>
        <span class="sp-spacer"></span>
        ${this.local
          ? nothing
          : empty
          ? html`<a class="sp-empty" href="#" data-testid="speech-switch-local"
              @click=${(e: Event) => (e.preventDefault(), void this.switchLocal())}>${WALLET_EMPTY_TEXT}</a>`
          : html`<span class="sp-wallet" title="Cloud voice (Robovoice) is free">Cloud voice · free</span>`}
      </div>
      ${this.speechError ? html`<div class="sp-note sp-err" role="status">${this.speechError}</div>` : nothing}
      ${this.settingsOpen ? this.renderSettings(c) : nothing}
    </div>`;
  }

  private renderSettings(c: Catalog): TemplateResult {
    const p = this.prefs;
    const tts = c.tts.find((t) => t.id === p.ttsProvider);
    const stt = c.stt.find((t) => t.id === p.sttProvider);
    const sel = (
      label: string,
      value: string | null,
      rows: Array<{ id: string; name?: string; label?: string; note?: string }>,
      on: (v: string | null) => void,
      target: string,
    ) => html`<label class="sp-field">
      <span>${label}</span>
      <select data-speech-field=${target} @change=${(e: Event) => on((e.target as HTMLSelectElement).value || null)}>
        <option value="" ?selected=${!value}>— choose —</option>
        ${rows.map(
          (r) => html`<option value=${r.id} ?selected=${r.id === value}>${r.label ?? r.name ?? r.id}${r.note ? ` · ${r.note}` : ""}</option>`,
        )}
      </select>
    </label>`;
    const local = this.local;
    return html`<div class="sp-pop" role="dialog" aria-label=${local ? "Local speech settings" : "Robovoice speech settings"}>
      <div class="sp-pop-head">
        <strong>${local ? "Local speech" : "Robovoice speech"}</strong>
        <button class="sp-x" aria-label="Close speech settings" @click=${() => this.closeSettings()}>✕</button>
      </div>
      <div class="sp-sec">Read aloud (text-to-speech)</div>
      ${c.tts.length
        ? html`${sel("Provider", p.ttsProvider, c.tts, (v) =>
              this.setPrefs({ ...p, ttsProvider: v, ttsModel: null, ttsVoice: null, readAloud: false }), "tts-provider")}
            ${tts && tts.models.length
              ? sel("Model", p.ttsModel, tts.models, (v) => this.setPrefs({ ...p, ttsModel: v }), "tts-model")
              : nothing}
            ${tts ? sel("Voice", p.ttsVoice, tts.voices, (v) => this.setPrefs({ ...p, ttsVoice: v }), "tts-voice") : nothing}
`
        : html`<div class="sp-none">No text-to-speech provider on this Robovoice org.</div>`}
      ${c.ttsUnavailable.length
        ? html`<div class="sp-unavail">${c.ttsUnavailable.map((u) => html`<span>${u.label}: ${u.reason}</span>`)}</div>`
        : nothing}
      <div class="sp-sec">Talk (speech-to-text)</div>
      ${c.stt.length
        ? html`${sel("Provider", p.sttProvider, c.stt, (v) => this.setPrefs({ ...p, sttProvider: v, sttModel: null }), "stt-provider")}
            ${stt ? sel("Model", p.sttModel, stt.models, (v) => this.setPrefs({ ...p, sttModel: v }), "stt-model") : nothing}
            <label class="sp-check">
              <input type="checkbox" .checked=${p.autoSend} @change=${(e: Event) =>
                this.setPrefs({ ...p, autoSend: (e.target as HTMLInputElement).checked })} />
              Send the transcript automatically
            </label>`
        : html`<div class="sp-none">No speech-to-text provider on this Robovoice org.</div>`}
      <div class="sp-foot">${local
        ? "Runs on this machine (local Kokoro and Whisper through this gateway). Switch to cloud voice on the Voice page's Settings tab."
        : "Runs on Robovoice's cloud — free. Switch back to local voice on the Voice page's Settings tab."}</div>
    </div>`;
  }

  /** The speech settings popover, when open (for hosts without the strip). */
  renderSettingsPopover(): TemplateResult | typeof nothing {
    const c = this.cat;
    return this.settingsOpen && c ? this.renderSettings(c) : nothing;
  }

  get settingsVisible(): boolean {
    return this.settingsOpen;
  }

  /** Read / Stop control under an assistant message. */
  renderMessageActions(key: string, text: string): TemplateResult | typeof nothing {
    const g = this.gate;
    if (g.kind !== "ready" && g.kind !== "empty") return nothing;
    const playing = this.playingKey === key;
    const pending = this.pendingKey === key;
    const spent = this.charged.get(key);
    const est = this.estimateFor(text);
    const empty = g.kind === "empty";
    const canRead = !empty && ttsReady(this.prefs, g.catalog);
    return html`<div class="sp-msg" data-speech-msg=${key}>
      ${playing || pending
        ? html`<button class="sp-mbtn active" @click=${() => this.stop()} title="Stop reading" aria-label="Stop reading">
            ${pending ? html`<span class="sp-spin" aria-hidden="true"></span>` : stopIcon()}<span>${pending ? "Preparing…" : "Stop"}</span>
          </button>`
        : html`<button class="sp-mbtn" ?disabled=${!canRead}
            title=${empty ? WALLET_EMPTY_TEXT : canRead ? "Read this reply aloud" : "Pick a voice in the speech settings"}
            aria-label="Read this reply aloud" @click=${() => void this.speak(key, text)}>
            ${playIcon()}<span>${spent ? "Replay" : "Read"}</span>
          </button>`}
    </div>`;
  }

  renderTalkButton(): TemplateResult | typeof nothing {
    const g = this.gate;
    if (g.kind !== "ready" && g.kind !== "empty") return nothing;
    const blocked = this.talkBlockedReason;
    const rec = this.talk === "recording";
    const busy = this.talk === "processing";
    const title = rec
      ? "Recording — click (or release) to stop"
      : busy
        ? "Transcribing…"
        : blocked ??
          (this.local
            ? "Talk (local speech-to-text) — click to toggle, hold to push-to-talk"
            : "Talk (cloud voice · Robovoice, free) — click to toggle, hold to push-to-talk");
    return html`<button
      class="talk ${this.talk}"
      data-talk-state=${blocked && !rec && !busy ? (g.kind === "empty" ? "wallet-empty" : "blocked") : this.talk}
      data-ib-target="control:chat/talk"
      aria-label=${rec ? "Stop recording" : "Talk"}
      aria-pressed=${rec ? "true" : "false"}
      title=${title}
      ?disabled=${busy || g.kind === "empty"}
      @pointerdown=${this.onTalkDown}
      @pointerup=${this.onTalkUp}
      @pointerleave=${this.onTalkUp}
      @keydown=${this.onTalkKey}
    >
      ${busy ? html`<span class="sp-spin" aria-hidden="true"></span>` : micIcon(16)}
      ${rec ? html`<span class="talk-rec" aria-hidden="true"></span>` : nothing}
    </button>`;
  }

  /** Recording / processing / error line above the composer. */
  renderTalkStatus(): TemplateResult | typeof nothing {
    const c = this.cat;
    if (this.talk === "recording" && c) {
      const sec = this.recordSeconds;
      return html`<div class="talk-status rec" role="status">
        <span class="talk-dot" aria-hidden="true"></span>
        Recording ${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}
        <button class="sp-link" @click=${() => {
          this.cancelRecording();
          this.update();
        }}>Cancel</button>
      </div>`;
    }
    if (this.talk === "processing")
      return html`<div class="talk-status busy" role="status"><span class="sp-spin" aria-hidden="true"></span>${this.local ? "Transcribing…" : "Transcribing with Robovoice…"}</div>`;
    if (this.talk === "error" && this.talkError)
      return html`<div class="talk-status err" role="alert">
        ${this.talkError}
        ${this.talkError === WALLET_EMPTY_TEXT
          ? html`<button class="sp-link" data-testid="speech-switch-local-talk" @click=${() => void this.switchLocal()}>Switch to local voice</button>`
          : nothing}
        <button class="sp-link" @click=${() => {
          this.talk = "idle";
          this.talkError = null;
          this.update();
        }}>Dismiss</button>
      </div>`;
    if (this.lastTalkCharge !== null && this.talk === "idle")
      return html`<div class="talk-status done" role="status">Transcribed</div>`;
    return nothing;
  }
}

/** Local TTS: this gateway's /api/voice/tts (Kokoro, or Speaches' Kokoro). */
async function synthLocal(text: string): Promise<Blob> {
  const res = await fetch(`${gatewayHttpBase()}/api/voice/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, response_format: "mp3" }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ? `Local text-to-speech: ${data.error}` : `Local text-to-speech failed (HTTP ${res.status})`);
  }
  return res.blob();
}

/** Local STT: this gateway's /api/voice/stt (Whisper in the Speaches container). */
async function transcribeLocalSpeech(recorded: Blob, mime: string): Promise<string> {
  // WAV works with every local engine (the built-in one needs no ffmpeg).
  const audio = await clipToWav(recorded);
  const form = new FormData();
  const ext = audio.type.includes("wav") ? "wav" : /ogg/.test(mime) ? "ogg" : /mp4/.test(mime) ? "m4a" : "webm";
  form.append("file", audio, `talk.${ext}`);
  form.append("response_format", "json");
  const res = await fetch(`${gatewayHttpBase()}/api/voice/stt`, { method: "POST", body: form });
  const data = (await res.json().catch(() => null)) as { text?: string; error?: string } | null;
  if (!res.ok) throw new Error(data?.error ? `Local speech-to-text: ${data.error}` : `Local speech-to-text failed (HTTP ${res.status})`);
  return typeof data?.text === "string" ? data.text : "";
}

const svg = (w: number, body: ReturnType<typeof svgPart>) => html`<svg width=${w} height=${w} viewBox="0 0 16 16" fill="none" stroke="currentColor"
  stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
function micIcon(w: number) {
  return svg(w, svgPart`<rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5"></rect><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5V15"></path>`);
}
function speakerIcon(on: boolean) {
  return svg(
    14,
    on
      ? svgPart`<path d="M2 6h2.5L8 3v10L4.5 10H2z"></path><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.5a6 6 0 0 1 0 9"></path>`
      : svgPart`<path d="M2 6h2.5L8 3v10L4.5 10H2z"></path><path d="M11 6l3 4M14 6l-3 4"></path>`,
  );
}
function playIcon() {
  return svg(12, svgPart`<path d="M4 2.5l9 5.5-9 5.5z" fill="currentColor"></path>`);
}
function stopIcon() {
  return svg(12, svgPart`<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor"></rect>`);
}
function chevIcon() {
  return svg(10, svgPart`<path d="M4 6l4 4 4-4"></path>`);
}

export const chatSpeechStyles = css`
  .sp-wrap {
    position: relative;
    z-index: 2;
  }
  .sp-strip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    min-height: 32px;
    font-size: 11.5px;
    color: color-mix(in srgb, var(--g-fg, #f5f5f4) 70%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 10%, transparent);
  }
  .sp-hint {
    gap: 8px;
    color: color-mix(in srgb, var(--g-fg, #f5f5f4) 55%, transparent);
  }
  .sp-err {
    color: #fca5a5;
  }
  .sp-ell {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .sp-spacer {
    flex: 1;
  }
  .sp-link {
    color: var(--g-primary, #fbbf24);
    font-weight: 600;
    font-size: inherit;
    text-decoration: none;
    padding: 0;
    white-space: nowrap;
  }
  .sp-link:hover {
    text-decoration: underline;
  }
  .sp-toggle {
    flex-shrink: 0;
  }
  .sp-toggle,
  .sp-voice {
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 9px;
    border-radius: 999px;
    font-size: 11.5px;
    background: color-mix(in srgb, var(--g-fg, #f5f5f4) 6%, transparent);
    max-width: 48%;
    min-width: 0;
  }
  .sp-toggle.on {
    background: color-mix(in srgb, var(--g-primary, #fbbf24) 22%, transparent);
    color: var(--g-primary, #fbbf24);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--g-primary, #fbbf24) 40%, transparent);
  }
  .sp-toggle:disabled,
  .sp-mbtn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .sp-wallet {
    font-family: "JetBrains Mono", "Fira Code", monospace;
    font-size: 11px;
    white-space: nowrap;
    color: color-mix(in srgb, var(--g-fg, #f5f5f4) 75%, transparent);
  }
  .sp-wallet small {
    color: var(--g-primary, #fbbf24);
  }
  .sp-empty {
    font-weight: 700;
    font-size: 11px;
    white-space: nowrap;
    color: #fecaca;
    background: rgba(239, 68, 68, 0.16);
    box-shadow: 0 0 0 1px rgba(239, 68, 68, 0.4);
    border-radius: 999px;
    padding: 3px 9px;
    text-decoration: none;
  }
  .sp-note {
    padding: 4px 14px;
    font-size: 11px;
  }
  .sp-pop {
    position: absolute;
    top: calc(100% - 2px);
    left: 10px;
    right: 10px;
    z-index: 5;
    padding: 12px;
    border-radius: 14px;
    background: rgba(12, 11, 16, 0.97);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--g-primary, #fbbf24) 22%, transparent),
      0 18px 50px -12px rgba(0, 0, 0, 0.8);
    display: grid;
    gap: 8px;
    font-size: 12px;
    max-height: 60vh;
    overflow: auto;
  }
  .sp-pop-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .sp-x {
    width: 24px;
    height: 24px;
    border-radius: 50%;
  }
  .sp-sec {
    margin-top: 4px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--g-primary, #fbbf24);
  }
  .sp-field {
    display: grid;
    grid-template-columns: 70px 1fr;
    align-items: center;
    gap: 8px;
  }
  .sp-field span {
    color: color-mix(in srgb, var(--g-fg, #f5f5f4) 60%, transparent);
  }
  .sp-field select {
    min-width: 0;
    height: 28px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--g-fg, #f5f5f4) 14%, transparent);
    background: rgba(255, 255, 255, 0.04);
    color: inherit;
    font: inherit;
    padding: 0 6px;
  }
  .sp-field select option {
    background: #111;
  }
  .sp-price,
  .sp-none,
  .sp-unavail,
  .sp-foot {
    font-size: 11px;
    color: color-mix(in srgb, var(--g-fg, #f5f5f4) 55%, transparent);
  }
  .sp-unavail {
    display: grid;
    gap: 2px;
  }
  .sp-check {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .sp-foot {
    border-top: 1px solid color-mix(in srgb, var(--g-fg, #f5f5f4) 8%, transparent);
    padding-top: 8px;
  }
  .sp-msg {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: -6px;
    padding-left: 4px;
  }
  .sp-mbtn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 22px;
    padding: 0 8px;
    border-radius: 999px;
    font-size: 11px;
    color: color-mix(in srgb, var(--g-fg, #f5f5f4) 60%, transparent);
    background: color-mix(in srgb, var(--g-fg, #f5f5f4) 5%, transparent);
  }
  .sp-mbtn:hover:not(:disabled),
  .sp-mbtn.active {
    color: var(--g-primary, #fbbf24);
    background: color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
  }
  .sp-mbtn small {
    opacity: 0.7;
    font-family: "JetBrains Mono", "Fira Code", monospace;
    font-size: 10px;
  }
  .sp-charged {
    font-family: "JetBrains Mono", "Fira Code", monospace;
    font-size: 10.5px;
    color: var(--g-primary, #fbbf24);
  }
  .sp-spin {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid currentColor;
    border-right-color: transparent;
    animation: sp-spin 0.8s linear infinite;
    flex-shrink: 0;
  }
  @keyframes sp-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .talk {
    position: relative;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border-radius: 12px;
    color: color-mix(in srgb, var(--g-fg, #f5f5f4) 75%, transparent);
    background: color-mix(in srgb, var(--g-fg, #f5f5f4) 7%, transparent);
    touch-action: none;
    user-select: none;
  }
  .talk:hover:not(:disabled) {
    color: var(--g-primary, #fbbf24);
  }
  .talk.recording {
    color: #fff;
    background: #dc2626;
    box-shadow: 0 0 0 4px rgba(220, 38, 38, 0.25);
    animation: talk-pulse 1.2s ease-in-out infinite;
  }
  .talk.processing {
    color: var(--g-primary, #fbbf24);
  }
  .talk:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .talk[data-talk-state="blocked"] {
    opacity: 0.6;
  }
  @keyframes talk-pulse {
    50% {
      box-shadow: 0 0 0 8px rgba(220, 38, 38, 0.12);
    }
  }
  .talk-status {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 16px 0;
    font-size: 11.5px;
    color: color-mix(in srgb, var(--g-fg, #f5f5f4) 70%, transparent);
    position: relative;
    z-index: 1;
  }
  .talk-status small {
    font-family: "JetBrains Mono", "Fira Code", monospace;
    color: var(--g-primary, #fbbf24);
  }
  .talk-status.rec {
    color: #fca5a5;
  }
  .talk-status.err {
    color: #fca5a5;
  }
  .talk-status.done {
    color: color-mix(in srgb, var(--g-fg, #f5f5f4) 55%, transparent);
  }
  .talk-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #ef4444;
    animation: talk-blink 1s steps(2) infinite;
  }
  @keyframes talk-blink {
    50% {
      opacity: 0.2;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .talk.recording,
    .talk-dot,
    .sp-spin {
      animation: none !important;
    }
  }
`;
