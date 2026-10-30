/**
 * <ib-local-voice-setup> — "Set up voice for me".
 *
 * One big button that checks the computer, gets Docker running (or walks a
 * non-technical user through installing it), downloads + starts the local
 * speech engines, connects InfiniBot to them and tests them. Used on the
 * onboarding Voice step and on Setup › Voice.
 *
 * All the work happens in the gateway (voice.local.* RPCs); this element shows
 * the resumable setup record it streams (`voice.local.progress`, with status
 * polling as a fallback). Closing the app mid-download and coming back resumes
 * automatically.
 *
 * Events (bubbling, composed): `voice-ready` (setup finished), `use-cloud`,
 * `skip-voice`.
 */
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { awaitGatewayClient, getGatewayClient } from "../gateway-client.js";
import { gatewayHttpBase } from "../gateway-http-auth.js";
import { icon, type IconName } from "../icons.js";
import {
  DOCKER_EXPLAINER,
  LOCAL_VOICE_WINDOW_EVENT,
  cardFor,
  dockerStartLine,
  downloadLine,
  fmtBytes,
  fmtDuration,
  headline,
  imageLabel,
  introCopy,
  introLine,
  type EngineKind,
  stepIcon,
  sudoLine,
  type SetupState,
} from "../onboarding/local-voice-model.js";

type Requester = { request: (method: string, params?: unknown) => Promise<unknown> };

interface DetectResult {
  supported: boolean;
  message?: string;
  recommendedEngine?: EngineKind;
  native?: { approxMb: number; downloaded: boolean; sttModel: string };
  host?: SetupState["host"];
  plan?: Array<{ id: string; label: string; approxMb: number | null; gpu: boolean }>;
  state?: SetupState;
}

const SAMPLE_TEXT = "Hi, I'm InfiniBot. Your voice is set up and running on this computer.";

@customElement("ib-local-voice-setup")
export class LocalVoiceSetup extends LitElement {
  @property({ attribute: false }) client: Requester | null = null;
  /** "onboarding" shows the Cloud / Skip fallbacks; "settings" keeps it compact. */
  @property() context: "onboarding" | "settings" = "onboarding";
  /** Previews / screenshots: render `state` as given, never poll or call the gateway. */
  @property({ type: Boolean }) frozen = false;

  @property({ attribute: false }) state: SetupState | null = null;
  @property({ attribute: false }) supported = true;
  @property({ attribute: false }) unsupportedMessage = "";
  @property({ attribute: false }) plan: DetectResult["plan"] | null = null;
  /** Engine "Set up voice for me" uses: built-in unless Docker voice is already here. */
  @property({ attribute: false }) recommended: EngineKind = "native";
  @property({ attribute: false }) native: DetectResult["native"] | null = null;
  @property({ attribute: false }) diskFreeGb: number | null = null;
  @state() private busy = false;
  @state() private details = false;
  @state() private copied: string | null = null;
  @state() private speaking = false;
  @state() private rpcError: string | null = null;

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private resumed = false;
  private playedSample = false;
  private lastPhase: string | null = null;
  private onProgress = (e: Event) => {
    if (this.frozen) return;
    const s = (e as CustomEvent<SetupState>).detail;
    if (s && typeof s === "object" && "phase" in s) this.apply(s);
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(LOCAL_VOICE_WINDOW_EVENT, this.onProgress);
    if (!this.frozen) void this.load();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(LOCAL_VOICE_WINDOW_EVENT, this.onProgress);
    this.stopPoll();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("client") && this.client && !this.frozen && !this.state) void this.load();
  }

  // ── gateway ────────────────────────────────────────────────────────────

  private async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const client = this.client ?? getGatewayClient() ?? (await awaitGatewayClient(15_000).catch(() => null));
    if (!client) throw new Error("Not connected to InfiniBot yet.");
    return (await client.request(method, params)) as T;
  }

  private async load(): Promise<void> {
    try {
      const res = await this.rpc<DetectResult>("voice.local.detect");
      if (this.frozen) return;
      this.rpcError = null;
      this.supported = res.supported !== false;
      this.unsupportedMessage = res.message ?? "";
      this.plan = res.plan ?? null;
      this.recommended = res.recommendedEngine ?? "native";
      this.native = res.native ?? null;
      this.diskFreeGb = res.host?.diskFreeGb ?? null;
      if (res.state) this.apply(res.state);
      // Came back after closing the app mid-setup: carry on by itself.
      if (res.state?.interrupted && !res.state.running && !this.resumed) {
        this.resumed = true;
        void this.install();
      }
    } catch (err) {
      if (!this.frozen) this.rpcError = errText(err);
    }
  }

  private async install(engine?: EngineKind): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.details = false;
    try {
      const res = await this.rpc<{ state?: SetupState }>("voice.local.install", engine ? { engine } : {});
      this.rpcError = null;
      if (res.state) this.apply(res.state);
    } catch (err) {
      this.rpcError = errText(err);
    } finally {
      this.busy = false;
    }
  }

  private async cancel(): Promise<void> {
    try {
      const res = await this.rpc<{ state?: SetupState }>("voice.local.cancel");
      if (res.state) this.apply(res.state);
    } catch (err) {
      this.rpcError = errText(err);
    }
  }

  private apply(s: SetupState): void {
    const prev = this.lastPhase;
    this.state = s;
    this.lastPhase = s.phase;
    if (s.phase === "done" && prev && prev !== "done") {
      this.dispatchEvent(new CustomEvent("voice-ready", { detail: s, bubbles: true, composed: true }));
      if (!this.playedSample) {
        this.playedSample = true;
        void this.speak(true);
      }
    }
    this.schedulePoll();
  }

  /** Poll while running (events are the fast path), and while waiting on the user to fix Docker. */
  private schedulePoll(): void {
    this.stopPoll();
    if (this.frozen || !this.state) return;
    const s = this.state;
    const waiting = s.phase === "needs-docker" || s.phase === "needs-permission" || s.phase === "needs-sudo";
    if (!s.running && !waiting) return;
    this.pollTimer = setTimeout(() => void this.poll(waiting), waiting ? 5000 : 1500);
  }

  private async poll(waiting: boolean): Promise<void> {
    if (!this.isConnected) return;
    try {
      if (waiting) {
        // The user is installing / starting Docker: start again the moment it works.
        const res = await this.rpc<DetectResult>("voice.local.detect");
        const docker = res.host?.docker.state;
        const phase = this.state?.phase;
        const fixed =
          (phase === "needs-docker" && docker && docker !== "missing") ||
          ((phase === "needs-permission" || phase === "needs-sudo") && docker === "running");
        if (fixed) {
          await this.install();
          return;
        }
      } else {
        const res = await this.rpc<{ state?: SetupState }>("voice.local.status");
        if (res.state) {
          this.apply(res.state);
          return;
        }
      }
    } catch {
      /* keep polling */
    }
    this.schedulePoll();
  }

  private stopPoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /** "Hear InfiniBot speak": a sample through this InfiniBot's own TTS route. */
  private async speak(auto = false): Promise<void> {
    if (this.speaking) return;
    this.speaking = true;
    try {
      const res = await fetch(`${gatewayHttpBase()}/api/voice/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: SAMPLE_TEXT, voice: "af_heart" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      audio.onended = () => {
        URL.revokeObjectURL(url);
        this.speaking = false;
      };
      await audio.play();
    } catch {
      // Autoplay can be blocked until a click; the button stays there.
      this.speaking = false;
      if (!auto) this.rpcError = "We couldn't play the sample. Check your speakers and try again.";
    }
  }

  private async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    this.copied = text;
    setTimeout(() => {
      if (this.copied === text) this.copied = null;
    }, 1800);
  }

  private emit(name: "use-cloud" | "skip-voice"): void {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
  }

  // ── render ─────────────────────────────────────────────────────────────

  render(): TemplateResult {
    const card = cardFor(this.state, this.supported);
    return html`<div class="lvs" data-testid="local-voice-setup" data-card=${card}>
      ${card === "unsupported"
        ? this.renderUnsupported()
        : card === "intro"
          ? this.renderIntro()
          : card === "progress"
            ? this.renderProgress()
            : card === "needs-docker"
              ? this.renderNeedsDocker()
              : card === "needs-permission"
                ? this.renderPermission()
                : card === "needs-sudo"
                  ? this.renderSudo()
                  : card === "done"
                    ? this.renderDone()
                    : this.renderFailed()}
      ${this.rpcError ? html`<p class="lvs-err" role="alert">${icon("alertCircle")}<span>${this.rpcError}</span></p>` : nothing}
    </div>`;
  }

  private renderUnsupported(): TemplateResult {
    return html`<div class="lvs-card">
      <div class="lvs-head">${this.badge("globe")}<div>
        <h3>Voice runs in the cloud here</h3>
        <p>${this.unsupportedMessage || "Local voice is for InfiniBot on your own computer."}</p>
      </div></div>
    </div>`;
  }

  private renderIntro(): TemplateResult {
    const cancelled = this.state?.phase === "cancelled";
    const engine = this.recommended;
    const c = introCopy(engine, this.native ?? null, this.diskFreeGb);
    return html`<div class="lvs-card lvs-card--hero" data-engine=${engine}>
      <div class="lvs-head">${this.badge("mic")}<div>
        <h3>${cancelled ? "Voice setup stopped" : c.title}</h3>
        <p>${c.text}</p>
      </div></div>
      <button class="lvs-btn lvs-btn--big" data-testid="lvs-start" ?disabled=${this.busy} @click=${() => void this.install(engine)}>
        ${this.busy ? html`<span class="lvs-spin"></span>` : icon("sparkles")} ${cancelled ? "Continue setting up voice" : c.button}
      </button>
      <p class="lvs-fine">${icon(engine === "docker" ? "container" : "shieldCheck")}<span>${c.fine}</span></p>
      ${this.renderAdvanced(engine)} ${this.fallbacks()}
    </div>`;
  }

  /** Collapsed by default: the other engine (Docker for NVIDIA power users, or back to built-in). */
  private renderAdvanced(current: EngineKind): TemplateResult {
    const other: EngineKind = current === "native" ? "docker" : "native";
    return html`<details class="lvs-adv" data-testid="lvs-advanced">
      <summary>${icon("chevronRight")}<span>${other === "docker" ? "Advanced: GPU voice engine (Docker)" : "Advanced: built-in voice engine (no Docker)"}</span></summary>
      <div class="lvs-adv__body">
        ${other === "docker"
          ? html`<p>For power users with an NVIDIA graphics card: runs bigger speech models in Docker. ${DOCKER_EXPLAINER}</p>
              <p class="lvs-fine">${icon("download")}<span>${introLine(this.plan ?? null)}</span></p>`
          : html`<p>Use InfiniBot's own voice engine instead. No Docker needed; it runs inside InfiniBot. Your Docker voice is left as it is.</p>`}
        <button class="lvs-btn" data-testid="lvs-use-${other}" ?disabled=${this.busy} @click=${() => void this.install(other)}>
          ${icon(other === "docker" ? "container" : "sparkles")} ${other === "docker" ? "Use the Docker engine" : "Use the built-in engine"}
        </button>
      </div>
    </details>`;
  }

  private renderProgress(): TemplateResult {
    const s = this.state!;
    return html`<div class="lvs-card" aria-live="polite">
      <div class="lvs-head">${this.badge("loader", true)}<div>
        <h3 data-testid="lvs-headline">${headline(s)}</h3>
        <p>You can keep going with the other steps. If you close InfiniBot, it carries on from here next time.</p>
      </div></div>
      ${this.renderSteps(s)}
      ${s.phase === "starting-docker" ? html`<p class="lvs-sub">${icon("clock")}<span>${dockerStartLine(s)}</span></p>` : nothing}
      ${s.download && (s.phase === "downloading" || s.download.percent < 100) && s.phase !== "done" ? this.renderDownload(s) : nothing}
      ${s.phase === "model" && s.model ? html`<p class="lvs-sub">${icon("download")}<span>Downloading the speech model${s.model.approxMb ? ` (about ${fmtBytes(s.model.approxMb * 1024 * 1024)})` : ""} · ${fmtDuration(s.model.elapsedSec)}</span></p>` : nothing}
      <div class="lvs-actions">
        ${s.running ? html`<button class="lvs-btn lvs-btn--ghost" @click=${() => void this.cancel()}>${icon("stop")} Stop</button>` : nothing}
        ${this.detailsToggle()}
      </div>
      ${this.detailsLog()}
    </div>`;
  }

  private renderSteps(s: SetupState): TemplateResult {
    return html`<ol class="lvs-steps" data-testid="lvs-steps">
      ${s.steps.map(
        (st) => html`<li class="lvs-step is-${st.status}">
          <span class="lvs-step__icon">${icon(stepIcon(st.status))}</span>
          <span class="lvs-step__text"><strong>${st.label}</strong>${st.detail ? html`<span>${st.detail}</span>` : nothing}</span>
        </li>`,
      )}
    </ol>`;
  }

  private renderDownload(s: SetupState): TemplateResult {
    const d = s.download!;
    return html`<div class="lvs-dl" data-testid="lvs-download">
      <div class="lvs-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${d.percent}><span style="width:${d.percent}%"></span></div>
      <p class="lvs-dl__line">${downloadLine(d)}</p>
      <ul class="lvs-dl__list">
        ${d.images.map(
          (i) => html`<li><span>${imageLabel(i.service)}</span><span>${i.status === "done" ? "Done" : i.status === "waiting" ? "Waiting" : `${fmtBytes(i.doneBytes)} / ${fmtBytes(i.totalBytes)}`}</span></li>`,
        )}
      </ul>
    </div>`;
  }

  private renderNeedsDocker(): TemplateResult {
    const g = this.state!.docker.guide;
    const wsl = this.state!.docker.wslCommand;
    return html`<div class="lvs-card" data-testid="lvs-needs-docker">
      <div class="lvs-head">${this.badge("download")}<div>
        <h3>First, install Docker</h3>
        <p>${DOCKER_EXPLAINER} It's free and takes about 5 minutes.</p>
      </div></div>
      ${g
        ? html`<div class="lvs-guide">
            <div class="lvs-guide__title">${g.title}</div>
            ${g.download
              ? html`<a class="lvs-btn lvs-btn--big" data-testid="lvs-download-docker" href=${g.download.url} target="_blank" rel="noopener">${icon("download")} ${g.download.label}</a>`
              : nothing}
            <ol class="lvs-howto">
              ${g.steps.map(
                (st, i) => html`<li>
                  <span class="lvs-howto__num">${i + 1}</span>
                  <span class="lvs-howto__icon">${icon(asIcon(st.icon))}</span>
                  <span class="lvs-howto__body"><strong>${st.title}</strong><span>${st.text}</span>${st.command ? this.cmd(st.command) : nothing}</span>
                </li>`,
              )}
            </ol>
            ${g.note ? html`<p class="lvs-fine">${icon("alertCircle")}<span>${g.note}</span></p>${wsl ? this.cmd(wsl) : nothing}` : nothing}
          </div>`
        : nothing}
      <div class="lvs-actions">
        <button class="lvs-btn" data-testid="lvs-check-again" ?disabled=${this.busy} @click=${() => void this.install()}>${icon("refresh")} I've installed it — check again</button>
        <span class="lvs-watch"><span class="lvs-dot"></span>Checking every few seconds</span>
      </div>
      <p class="lvs-fine">${icon("sparkles")}<span>Don't want Docker? <button class="lvs-link lvs-link--inline" data-testid="lvs-use-native" @click=${() => void this.install("native")}>Use the built-in voice engine instead</button>. No extra apps.</span></p>
      ${this.fallbacks()}
    </div>`;
  }

  private renderPermission(): TemplateResult {
    const fix = this.state!.docker.permissionFix;
    return html`<div class="lvs-card" data-testid="lvs-needs-permission">
      <div class="lvs-head">${this.badge("lock")}<div>
        <h3>Your user isn't allowed to use Docker yet</h3>
        <p>Docker is installed. Give your user access once: open a terminal, paste this and enter your password.</p>
      </div></div>
      ${fix ? html`${this.cmd(fix.command)}<p class="lvs-fine">${icon("alertCircle")}<span>${fix.after}</span></p>` : nothing}
      <div class="lvs-actions">
        <button class="lvs-btn" ?disabled=${this.busy} @click=${() => void this.install()}>${icon("refresh")} I've done it — check again</button>
        ${this.detailsToggle()}
      </div>
      ${this.detailsLog()} ${this.fallbacks()}
    </div>`;
  }

  private renderSudo(): TemplateResult {
    const cmd = this.state!.docker.sudoCommand ?? "sudo systemctl start docker";
    return html`<div class="lvs-card" data-testid="lvs-needs-sudo">
      <div class="lvs-head">${this.badge("key")}<div>
        <h3>Docker needs your password to start</h3>
        <p>${sudoLine()}</p>
      </div></div>
      ${this.cmd(cmd)}
      <p class="lvs-fine">${icon("check")}<span>This also starts Docker with your computer, so voice is ready after a restart.</span></p>
      <div class="lvs-actions">
        <button class="lvs-btn" ?disabled=${this.busy} @click=${() => void this.install()}>${icon("play")} I've done it — continue</button>
        <span class="lvs-watch"><span class="lvs-dot"></span>We'll continue by ourselves once Docker is up</span>
      </div>
      ${this.fallbacks()}
    </div>`;
  }

  private renderDone(): TemplateResult {
    const s = this.state!;
    const stt = s.services.speaches;
    const heard = s.test?.transcript;
    return html`<div class="lvs-card lvs-card--ok" data-testid="lvs-done">
      <div class="lvs-head">${this.badge("checkCircle")}<div>
        <h3>Voice is ready</h3>
        <p>InfiniBot can hear you and talk back. Everything runs on this computer, so it's private and free.</p>
      </div></div>
      <ul class="lvs-facts">
        <li>${icon("mic")}<span>Speech-to-text ${stt?.gpu ? "on your graphics card" : "on your processor"}</span></li>
        <li>${icon("volumeUp")}<span>Voices ready${s.test?.tts ? " and tested" : ""}</span></li>
        ${heard ? html`<li>${icon("check")}<span>Test heard: “${heard}”</span></li>` : nothing}
        ${s.engine === "native" ? html`<li>${icon("sparkles")}<span>Built-in voice engine: no extra apps needed</span></li>` : nothing}
        ${stt?.backend === "wasm"
          ? html`<li data-testid="lvs-backend">${icon("alertCircle")}<span>Engine: compatibility mode (WebAssembly) — works everywhere, a little slower</span></li>`
          : stt?.backend === "native"
            ? html`<li data-testid="lvs-backend">${icon("zap")}<span>Engine: fast mode (native ONNX Runtime)</span></li>`
            : nothing}
        <li>${icon("refresh")}<span>${s.engine === "native" ? "Starts with InfiniBot and restarts by itself" : "Starts again by itself after a restart"}</span></li>
      </ul>
      ${s.notes.length ? html`<ul class="lvs-notes">${s.notes.map((n) => html`<li>${icon("alertCircle")}<span>${n}</span></li>`)}</ul>` : nothing}
      <div class="lvs-actions">
        <button class="lvs-btn" data-testid="lvs-speak" ?disabled=${this.speaking} @click=${() => void this.speak()}>
          ${this.speaking ? html`<span class="lvs-spin"></span>` : icon("volumeUp")} Hear InfiniBot speak
        </button>
        ${this.detailsToggle()}
      </div>
      ${this.detailsLog()}
    </div>`;
  }

  private renderFailed(): TemplateResult {
    const e = this.state!.error ?? { title: "Voice setup didn't finish", message: "", action: "Press Try again.", code: "unknown", details: "" };
    return html`<div class="lvs-card lvs-card--bad" data-testid="lvs-failed">
      <div class="lvs-head">${this.badge("alertCircle")}<div>
        <h3>${e.title}</h3>
        <p>${e.message}</p>
      </div></div>
      ${this.state!.steps.some((st) => st.status !== "pending") ? this.renderSteps(this.state!) : nothing}
      <p class="lvs-next">${icon("arrowRight")}<span><strong>Next:</strong> ${e.action}</span></p>
      <div class="lvs-actions">
        <button class="lvs-btn lvs-btn--big" data-testid="lvs-retry" ?disabled=${this.busy} @click=${() => void this.install(this.state?.engine ?? undefined)}>${icon("refresh")} Try again</button>
        ${this.detailsToggle()}
      </div>
      ${this.detailsLog()} ${this.fallbacks(true)}
    </div>`;
  }

  // ── bits ───────────────────────────────────────────────────────────────

  private badge(name: IconName, spin = false): TemplateResult {
    return html`<span class="lvs-badge ${spin ? "is-spin" : ""}" aria-hidden="true">${icon(name)}</span>`;
  }

  private cmd(text: string): TemplateResult {
    const done = this.copied === text;
    return html`<div class="lvs-cmd">
      <code>${text}</code>
      <button class="lvs-copy" @click=${() => void this.copy(text)} aria-label="Copy command">${icon(done ? "check" : "copy")}${done ? "Copied" : "Copy"}</button>
    </div>`;
  }

  private detailsToggle(): TemplateResult | typeof nothing {
    if (!this.state?.log.length) return nothing;
    return html`<button class="lvs-link" aria-expanded=${this.details ? "true" : "false"} @click=${() => (this.details = !this.details)}>
      ${icon(this.details ? "chevronUp" : "chevronDown")} ${this.details ? "Hide details" : "Show details"}
    </button>`;
  }

  private detailsLog(): TemplateResult | typeof nothing {
    if (!this.details || !this.state) return nothing;
    const extra = this.state.error?.details && !this.state.log.length ? this.state.error.details : "";
    return html`<pre class="lvs-log" data-testid="lvs-log">${[...this.state.log, extra].filter(Boolean).join("\n")}</pre>`;
  }

  private fallbacks(prominent = false): TemplateResult | typeof nothing {
    if (this.context !== "onboarding") return nothing;
    return html`<div class="lvs-fallback ${prominent ? "is-prominent" : ""}">
      <button class="lvs-link" data-testid="lvs-use-cloud" @click=${() => this.emit("use-cloud")}>${icon("globe")} Use Cloud voice (Robovoice) instead</button>
      <button class="lvs-link" data-testid="lvs-skip" @click=${() => this.emit("skip-voice")}>Skip for now</button>
    </div>`;
  }

  static styles = css`
    :host {
      display: block;
      min-width: 0;
      max-width: 100%;
      --g: var(--sob-gold, var(--g-primary, #fbbf24));
      --fg: var(--sob-fg, #f5f2ea);
      --fg2: var(--sob-fg-2, rgba(245, 242, 234, 0.72));
      --fg3: var(--sob-fg-3, rgba(245, 242, 234, 0.48));
      --line: var(--sob-line, color-mix(in srgb, var(--g) 16%, rgba(255, 255, 255, 0.08)));
      --line2: var(--sob-line-2, color-mix(in srgb, var(--g) 38%, transparent));
      --ok: var(--sob-ok, #6ee7a0);
      --bad: var(--sob-danger, #f87171);
      --mono: var(--sob-mono, "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace);
      color: var(--fg);
      font: 14px/1.5 var(--sob-sans, "Space Grotesk", "Inter", system-ui, sans-serif);
    }
    svg { width: 16px; height: 16px; flex-shrink: 0; }
    .lvs { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; min-width: 0; }
    .lvs-card, .lvs-guide, .lvs-howto__body { min-width: 0; }
    .lvs-card {
      position: relative; display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; padding: 18px; border-radius: 16px;
      background: linear-gradient(160deg, rgba(20, 17, 9, 0.92), rgba(6, 5, 3, 0.94));
      border: 1px solid var(--line);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
    }
    .lvs-card--hero { border-color: var(--line2); box-shadow: 0 0 0 1px color-mix(in srgb, var(--g) 8%, transparent), 0 18px 40px -24px color-mix(in srgb, var(--g) 50%, transparent); }
    .lvs-card--ok { border-color: color-mix(in srgb, var(--ok) 40%, transparent); }
    .lvs-card--bad { border-color: color-mix(in srgb, var(--bad) 45%, transparent); }
    .lvs-head { display: flex; gap: 14px; align-items: flex-start; }
    .lvs-head h3 { margin: 2px 0 4px; font-size: 17px; font-weight: 650; letter-spacing: -0.01em; color: var(--fg); }
    .lvs-head p { margin: 0; color: var(--fg2); }
    .lvs-badge {
      width: 42px; height: 42px; border-radius: 12px; display: grid; place-items: center; flex-shrink: 0;
      color: var(--g); background: color-mix(in srgb, var(--g) 10%, transparent); border: 1px solid var(--line2);
    }
    .lvs-badge svg { width: 20px; height: 20px; }
    .lvs-card--ok .lvs-badge { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); background: color-mix(in srgb, var(--ok) 10%, transparent); }
    .lvs-card--bad .lvs-badge { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, transparent); background: color-mix(in srgb, var(--bad) 10%, transparent); }
    .lvs-badge.is-spin svg, .lvs-step.is-active .lvs-step__icon svg { animation: lvs-rot 1.1s linear infinite; }
    @keyframes lvs-rot { to { transform: rotate(360deg); } }

    .lvs-btn {
      appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      min-height: 44px; padding: 0 18px; border-radius: 12px; cursor: pointer; text-decoration: none;
      font: 600 14px/1 inherit; font-family: inherit; color: var(--g);
      background: color-mix(in srgb, var(--g) 8%, transparent); border: 1px solid var(--line2);
      transition: background 0.15s, box-shadow 0.15s, transform 0.1s;
    }
    .lvs-btn:hover:not([disabled]), .lvs-btn:focus-visible { background: color-mix(in srgb, var(--g) 16%, transparent); outline: none; box-shadow: 0 0 14px -2px color-mix(in srgb, var(--g) 45%, transparent); }
    .lvs-btn:active:not([disabled]) { transform: translateY(1px); }
    .lvs-btn[disabled] { opacity: 0.55; cursor: default; }
    .lvs-btn--big {
      min-height: 52px; font-size: 15.5px; color: #120d02; border: none;
      background: linear-gradient(180deg, color-mix(in srgb, var(--g) 92%, #fff 8%), color-mix(in srgb, var(--g) 80%, #b45309 20%));
      box-shadow: 0 10px 26px -12px color-mix(in srgb, var(--g) 80%, transparent);
    }
    .lvs-btn--big:hover:not([disabled]), .lvs-btn--big:focus-visible { background: linear-gradient(180deg, color-mix(in srgb, var(--g) 100%, #fff 12%), var(--g)); }
    .lvs-card--hero > .lvs-btn--big { width: 100%; }
    .lvs-btn--ghost { color: var(--fg2); background: transparent; border-color: var(--line); }
    .lvs-link {
      appearance: none; background: none; border: none; padding: 6px 2px; cursor: pointer; display: inline-flex; gap: 6px; align-items: center;
      color: var(--fg3); font: 500 13px/1.2 inherit; font-family: inherit;
    }
    .lvs-link:hover, .lvs-link:focus-visible { color: var(--g); outline: none; }
    .lvs-actions { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; }
    .lvs-fine, .lvs-sub, .lvs-next, .lvs-err { display: flex; gap: 8px; align-items: flex-start; margin: 0; font-size: 13px; color: var(--fg3); }
    .lvs-fine svg, .lvs-sub svg, .lvs-next svg, .lvs-err svg { margin-top: 2px; width: 14px; height: 14px; }
    .lvs-sub { color: var(--fg2); }
    .lvs-next { color: var(--fg); font-size: 14px; }
    .lvs-next svg { color: var(--g); }
    .lvs-err { color: var(--bad); }
    .lvs-adv { border: 1px solid var(--line); border-radius: 12px; background: rgba(0, 0, 0, 0.2); }
    .lvs-adv summary { list-style: none; cursor: pointer; display: flex; gap: 8px; align-items: center; padding: 10px 12px; color: var(--fg2); font-size: 13.5px; font-weight: 550; min-height: 44px; box-sizing: border-box; }
    .lvs-adv summary::-webkit-details-marker { display: none; }
    .lvs-adv summary svg { transition: transform 0.15s; color: var(--g); }
    .lvs-adv[open] summary svg { transform: rotate(90deg); }
    .lvs-adv summary:hover, .lvs-adv summary:focus-visible { color: var(--g); outline: none; }
    .lvs-adv__body { display: grid; gap: 10px; padding: 0 12px 12px; color: var(--fg2); font-size: 13.5px; }
    .lvs-adv__body p { margin: 0; }
    .lvs-adv__body .lvs-btn { justify-self: start; }
    .lvs-link--inline { display: inline; padding: 0; color: var(--g); font-size: inherit; text-decoration: underline; text-underline-offset: 2px; }
    .lvs-fallback { display: flex; flex-wrap: wrap; gap: 4px 18px; padding-top: 10px; border-top: 1px solid var(--line); }
    .lvs-fallback.is-prominent .lvs-link { color: var(--fg2); }

    .lvs-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
    .lvs-step { display: flex; gap: 12px; align-items: flex-start; padding: 8px 10px; border-radius: 10px; color: var(--fg3); }
    .lvs-step__icon { margin-top: 2px; display: inline-flex; }
    .lvs-step__text { display: grid; gap: 1px; }
    .lvs-step__text strong { font-weight: 550; }
    .lvs-step__text span { font-size: 12.5px; color: var(--fg3); }
    .lvs-step.is-active { color: var(--fg); background: color-mix(in srgb, var(--g) 6%, transparent); }
    .lvs-step.is-active .lvs-step__icon { color: var(--g); }
    .lvs-step.is-done, .lvs-step.is-skipped { color: var(--fg2); }
    .lvs-step.is-done .lvs-step__icon, .lvs-step.is-skipped .lvs-step__icon { color: var(--ok); }
    .lvs-step.is-failed { color: var(--fg); }
    .lvs-step.is-failed .lvs-step__icon { color: var(--bad); }
    .lvs-step.is-waiting .lvs-step__icon { color: var(--g); }

    .lvs-dl { display: grid; gap: 8px; padding: 12px; border-radius: 12px; border: 1px solid var(--line); background: rgba(0, 0, 0, 0.25); }
    .lvs-bar { height: 8px; border-radius: 99px; background: rgba(255, 255, 255, 0.06); overflow: hidden; }
    .lvs-bar span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, color-mix(in srgb, var(--g) 70%, #b45309), var(--g)); box-shadow: 0 0 12px color-mix(in srgb, var(--g) 60%, transparent); transition: width 0.4s ease; }
    .lvs-dl__line { margin: 0; font: 600 13.5px/1.3 var(--mono); color: var(--fg); font-variant-numeric: tabular-nums; }
    .lvs-dl__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: 12.5px; color: var(--fg3); }
    .lvs-dl__list li { display: flex; justify-content: space-between; gap: 10px; font-variant-numeric: tabular-nums; }

    .lvs-guide { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
    .lvs-guide__title { font-weight: 600; color: var(--fg); }
    .lvs-guide > .lvs-btn--big { justify-self: start; }
    .lvs-howto { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
    .lvs-howto li { display: grid; grid-template-columns: 26px 28px 1fr; gap: 10px; align-items: start; }
    .lvs-howto__num { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font: 600 12px/1 var(--mono); color: #120d02; background: var(--g); }
    .lvs-howto__icon { color: var(--g); padding-top: 3px; }
    .lvs-howto__body { display: grid; gap: 4px; min-width: 0; }
    .lvs-howto__body strong { color: var(--fg); font-weight: 600; }
    .lvs-howto__body > span { color: var(--fg2); font-size: 13.5px; }

    .lvs-cmd { display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 12px; border-radius: 10px; border: 1px solid var(--line2); background: rgba(0, 0, 0, 0.45); min-width: 0; }
    .lvs-cmd code { flex: 1; min-width: 0; font: 12.5px/1.4 var(--mono); color: var(--g); overflow-x: auto; white-space: nowrap; scrollbar-width: thin; }
    .lvs-copy { appearance: none; display: inline-flex; gap: 6px; align-items: center; min-height: 34px; padding: 0 10px; border-radius: 8px; cursor: pointer; font: 600 12px/1 inherit; font-family: inherit; color: var(--fg); background: rgba(255, 255, 255, 0.06); border: 1px solid var(--line); flex-shrink: 0; }
    .lvs-copy:hover, .lvs-copy:focus-visible { color: var(--g); border-color: var(--line2); outline: none; }
    .lvs-copy svg { width: 14px; height: 14px; }
    .lvs-watch { display: inline-flex; gap: 8px; align-items: center; font-size: 12.5px; color: var(--fg3); }
    .lvs-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--g); animation: lvs-pulse 1.6s ease-in-out infinite; }
    @keyframes lvs-pulse { 50% { opacity: 0.25; } }

    .lvs-facts, .lvs-notes { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
    .lvs-facts li, .lvs-notes li { display: flex; gap: 10px; align-items: flex-start; color: var(--fg2); }
    .lvs-facts svg { color: var(--ok); margin-top: 3px; }
    .lvs-notes li { font-size: 13px; color: var(--fg3); }
    .lvs-notes svg { color: var(--g); margin-top: 3px; width: 14px; height: 14px; }
    .lvs-log { margin: 0; max-height: 220px; overflow: auto; padding: 10px 12px; border-radius: 10px; background: #000; border: 1px solid var(--line); font: 11.5px/1.5 var(--mono); color: var(--fg2); white-space: pre-wrap; word-break: break-word; }
    .lvs-spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: lvs-rot 0.8s linear infinite; }

    @media (max-width: 560px) {
      .lvs-card { padding: 14px; }
      .lvs-head { gap: 12px; }
      .lvs-badge { width: 36px; height: 36px; }
      .lvs-actions > .lvs-btn, .lvs-guide > .lvs-btn--big { width: 100%; justify-self: stretch; }
      .lvs-howto li { grid-template-columns: 24px 18px minmax(0, 1fr); gap: 8px; }
      .lvs-howto__icon svg { width: 15px; height: 15px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .lvs-badge.is-spin svg, .lvs-step.is-active .lvs-step__icon svg, .lvs-dot, .lvs-spin { animation: none; }
    }
  `;
}

const KNOWN_ICONS = new Set<string>(["download", "settings", "play", "refresh", "folder", "terminal", "users", "globe", "lock", "key"]);
function asIcon(name: string): IconName {
  return (KNOWN_ICONS.has(name) ? name : "check") as IconName;
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/missing scope|unauthorized|not allowed/i.test(msg)) return "Only the owner of this InfiniBot can set up voice. Ask them to do it.";
  if (/unknown method/i.test(msg)) return "This InfiniBot needs an update before it can set up voice by itself.";
  return msg.replace(/^Error:\s*/, "");
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-local-voice-setup": LocalVoiceSetup;
  }
}
