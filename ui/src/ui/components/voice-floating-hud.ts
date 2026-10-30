/**
 * Voice Floating HUD — the holographic full-screen mode of the Voice Terminal.
 *
 * Layers (back → front):
 *   1. deep-space background canvas (stars + nebula, baked gradients)
 *   2. the canonical isometric agent map (<agency-world-viz>), dimmed to an
 *      ambient backdrop — the real agent data lives in the panels
 *   3. <voice-hud-panels>: ONE CSS grid that holds the central voice orb (slotted
 *      in below) and the live panels around it — Call, Conversation, System,
 *      Quick actions, Agents, Today, Needs attention. Fixed regions, so nothing
 *      overlaps at any viewport; narrow screens switch to tabs.
 *
 * Toggled from session-view.ts via floatingHudMode.
 *
 * NOTE ON NAVIGATION (root-cause fix, kept from the original HUD):
 *   The HUD lives inside the persistent `.live-action-voice-host` wrapper that
 *   survives route changes (mode-hidden) so a call never drops. To cover the
 *   viewport we expand that host with inline styles; to keep those from leaking:
 *     1. a MutationObserver auto-exits the HUD the moment the host goes
 *        `mode-hidden` (the user navigated away),
 *     2. while the HUD is up the app chrome (`.topbar`, `.nav`) is lifted above
 *        the host so navigation keeps working,
 *     3. disconnectedCallback always restores the host + chrome.
 */
import { LitElement, html, css, type PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { VoiceBlob, type BlobStyle, type BlobState } from './voice-blob';
// The canonical isometric agent map — same component + data source as the
// dashboard world band. Embedded as an ambient, non-interactive backdrop.
import './agency-world-viz';
// In-world connector flows anchored to the iso map's agent coords.
import './voice-world-ambient';
import '../views/voice-robovoice/hud-panels.js';
import type { HudCallSnapshot } from '../views/voice-robovoice/hud-panels.js';
import type { GatewayBrowserClient } from '../gateway';
import { rafLoop, type SchedulerHandle } from '../perf/visibility-scheduler';

interface Star { x: number; y: number; r: number; a: number; twinkle: number; phase: number; }
interface Nebula { x: number; y: number; r: number; color: string; drift: number; t: number; }

@customElement('voice-floating-hud')
export class VoiceFloatingHud extends LitElement {
  // ── Audio state from the session view ────────────────────
  // Live mic RMS (0–100) — drives the blob's user lane + the Call panel meter.
  @property({ type: Number }) micLevel = 0;
  @property({ type: Boolean }) isUserSpeaking = false;
  @property({ type: Boolean }) isAgentSpeaking = false;
  @property({ type: Boolean }) isProcessing = false;
  @property({ type: Number }) micBass = 0;
  @property({ type: Number }) micTreble = 0;
  @property({ type: Number }) agentLevel = 0;
  @property({ type: String }) blobStyle: BlobStyle = 'aurora';
  @property({ type: String }) blobUserColor = '#7cf5ff';
  @property({ type: String }) blobAgentColor = '#ffb84a';
  @property({ attribute: false }) gatewayClient: GatewayBrowserClient | null = null;
  /** Call snapshot for the panels (memoised by the session view). */
  @property({ attribute: false }) call: HudCallSnapshot | null = null;

  private get bgCanvas(): HTMLCanvasElement | null {
    return this.renderRoot?.querySelector('.bg-canvas') as HTMLCanvasElement | null;
  }
  private get _panelsEl(): HTMLElement | null {
    return this.renderRoot?.querySelector('voice-hud-panels') as HTMLElement | null;
  }

  // ── Background particle system ───────────────────────────
  private bgCtx: CanvasRenderingContext2D | null = null;
  private bgLoop: SchedulerHandle | null = null;
  private stars: Star[] = [];
  private nebulae: Nebula[] = [];
  private bgTime = 0;
  private bgPaused = false;
  // Static layers baked once per resize (see _bakeBgStatic).
  private _bgBelow: HTMLCanvasElement | null = null;
  private _bgAbove: HTMLCanvasElement | null = null;
  private _bgLastDraw = 0;
  private static readonly BG_MIN_INTERVAL = 33; // ~30fps
  private _fxCoupleLast = 0; // throttle for blob↔world CSS-var coupling (~20fps)
  private _resizeHandler?: () => void;

  // ── Voice blob ───────────────────────────────────────────
  private voiceBlob: VoiceBlob | null = null;
  private blobLoop: SchedulerHandle | null = null;
  private reducedMotion = false;
  private visHandler?: () => void;

  // ── Host expansion / nav-fix bookkeeping ─────────────────
  private _hostEl: HTMLElement | null = null;
  private _navEl: HTMLElement | null = null;
  private _topbarEl: HTMLElement | null = null;
  private _hostOrig: Record<string, string> = {};
  private _navOrigZ = '';
  private _topbarOrigZ = '';
  private _hostObserver: MutationObserver | null = null;
  private _exited = false;

  // ── Lifecycle ────────────────────────────────────────────

  connectedCallback() {
    super.connectedCallback();
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Expand the live-action-voice-host to full viewport via JS
    // (CSS injection can't pierce shadow DOM boundaries).
    requestAnimationFrame(() => {
      this._locateHostChain();
      this._expandHost();
      this._watchHostMode();
    });

    this.visHandler = () => {
      if (document.hidden) this._pause();
      else this._resume();
    };
    document.addEventListener('visibilitychange', this.visHandler);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._teardown();
    this._restoreHost();
    this._hostObserver?.disconnect();
    this._hostObserver = null;
    if (this.visHandler) document.removeEventListener('visibilitychange', this.visHandler);
    if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
  }

  /**
   * Find the persistent host + app chrome. The host lives in the infinibot-app
   * shadow tree, several light-DOM levels above this component; rather than
   * rely on a brittle getRootNode() parent walk (which breaks depending on
   * whether intermediate hosts use shadow vs light DOM), do a shadow-piercing
   * deep query from the document down.
   */
  private _locateHostChain() {
    try {
      this._hostEl   = this._deepQuery('.live-action-voice-host');
      this._navEl    = this._deepQuery('.nav');
      this._topbarEl = this._deepQuery('.topbar');
    } catch { /* best-effort */ }
  }

  /** querySelector that descends through every open shadow root. */
  private _deepQuery(sel: string): HTMLElement | null {
    const visit = (root: Document | ShadowRoot | Element): HTMLElement | null => {
      const direct = (root as Element).querySelector?.(sel) as HTMLElement | null;
      if (direct) return direct;
      const all = (root as Element).querySelectorAll?.('*') ?? [];
      for (const el of Array.from(all)) {
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) {
          const found = visit(sr);
          if (found) return found;
        }
      }
      return null;
    };
    return visit(document);
  }

  private _expandHost() {
    const host = this._hostEl;
    if (!host) return;
    // Snapshot original inline values exactly once.
    if (!Object.keys(this._hostOrig).length) {
      for (const p of ['top', 'left', 'right', 'bottom', 'z-index', 'padding', 'width', 'height']) {
        this._hostOrig[p] = host.style.getPropertyValue(p);
      }
    }
    host.style.setProperty('top',     '0',    'important');
    host.style.setProperty('left',    '0',    'important');
    host.style.setProperty('right',   '0',    'important');
    host.style.setProperty('bottom',  '0',    'important');
    host.style.setProperty('width',   '100vw','important');
    host.style.setProperty('height',  '100vh','important');
    host.style.setProperty('z-index', '5000', 'important');
    host.style.setProperty('padding', '0',    'important');

    // Lift the app chrome ABOVE the expanded host so the user can still
    // navigate (click route links in the nav rail / topbar) while the HUD
    // is up. The topbar is already z:99999 (sticky); the nav rail is a grid
    // item at auto z-index → bump it above the host's 5000.
    if (this._navEl) {
      this._navOrigZ = this._navEl.style.zIndex;
      this._navEl.style.setProperty('z-index', '6000', 'important');
    }
    if (this._topbarEl) {
      this._topbarOrigZ = this._topbarEl.style.zIndex;
      // Already 99999 from the stylesheet, but make sure inline wins too.
      this._topbarEl.style.setProperty('z-index', '99999', 'important');
    }
  }

  private _restoreHost() {
    const host = this._hostEl;
    if (host) {
      for (const p of Object.keys(this._hostOrig)) {
        const v = this._hostOrig[p];
        if (v) host.style.setProperty(p, v);
        else host.style.removeProperty(p);
      }
    }
    if (this._navEl) {
      if (this._navOrigZ) this._navEl.style.zIndex = this._navOrigZ;
      else this._navEl.style.removeProperty('z-index');
    }
    if (this._topbarEl) {
      if (this._topbarOrigZ) this._topbarEl.style.zIndex = this._topbarOrigZ;
      else this._topbarEl.style.removeProperty('z-index');
    }
    this._hostOrig = {};
    this._hostEl = null;
    this._navEl = null;
    this._topbarEl = null;
  }

  /**
   * Watch the persistent host's class list. When it flips to `mode-hidden`
   * the user has navigated away from the voice surface — auto-exit the HUD so
   * the overlay never leaks onto another route. (This is THE navigation fix.)
   */
  private _watchHostMode() {
    if (!this._hostEl) return;
    this._hostObserver = new MutationObserver(() => {
      const host = this._hostEl;
      if (!host) return;
      if (host.classList.contains('mode-hidden')) {
        this._exitHud();
      }
    });
    this._hostObserver.observe(this._hostEl, { attributes: true, attributeFilter: ['class'] });
  }

  private _exitHud() {
    if (this._exited) return;
    this._exited = true;
    // Restore immediately so navigation isn't blocked for even one frame,
    // then ask the parent to drop floatingHudMode (which unmounts us).
    this._restoreHost();
    this._hostObserver?.disconnect();
    this._hostObserver = null;
    this.dispatchEvent(new CustomEvent('exit-hud', { bubbles: true, composed: true }));
  }

  firstUpdated() {
    this._initBackground();
    this._initBlob();
  }

  updated(changed: PropertyValues) {
    if (!this.voiceBlob) return;
    const state: BlobState = this.isAgentSpeaking
      ? 'speaking'
      : this.isUserSpeaking
      ? 'listening'
      : this.isProcessing
      ? 'processing'
      : 'idle';
    this.voiceBlob.setState(state);
    if (changed.has('blobStyle')) this.voiceBlob.setStyle(this.blobStyle);
    if (changed.has('blobUserColor') || changed.has('blobAgentColor')) {
      // Recolour IN PLACE — a dispose/re-create per colour settle stacks
      // transient WebGL contexts past Chrome's ~16-context ceiling.
      this.voiceBlob.setColors(this.blobUserColor, this.blobAgentColor);
    }
  }

  // ══════════════════════════════════════════════════════════
  // Background — deep-space canvas
  // ══════════════════════════════════════════════════════════

  private _initBackground() {
    const canvas = this.bgCanvas;
    if (!canvas) return;
    this.bgCtx = canvas.getContext('2d');
    this._resizeBg();
    this._resizeHandler = () => this._resizeBg();
    window.addEventListener('resize', this._resizeHandler);
    this._buildStars();
    this._buildNebulae();
    if (!this.reducedMotion) this.startBgLoop();
    else this._drawBg();
  }

  private _resizeBg() {
    const canvas = this.bgCanvas;
    if (!canvas) return;
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    this._bakeBgStatic();
  }

  /**
   * Pre-render the unchanging deep-space layers to offscreen canvases so the
   * per-frame path is two GPU-accelerated `drawImage` blits instead of three
   * `createGradient` + fullscreen `fillRect` calls. Visuals are pixel-identical.
   */
  private _bakeBgStatic() {
    const W = window.innerWidth, H = window.innerHeight;
    if (W <= 0 || H <= 0) return;

    const below = this._bgBelow ?? (this._bgBelow = document.createElement('canvas'));
    below.width = W; below.height = H;
    const bctx = below.getContext('2d');
    if (bctx) {
      const grad = bctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, '#020510');
      grad.addColorStop(0.4, '#040816');
      grad.addColorStop(1, '#020410');
      bctx.fillStyle = grad;
      bctx.fillRect(0, 0, W, H);
    }

    const above = this._bgAbove ?? (this._bgAbove = document.createElement('canvas'));
    above.width = W; above.height = H;
    const actx = above.getContext('2d');
    if (actx) {
      actx.clearRect(0, 0, W, H);
      const vig = actx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.85);
      vig.addColorStop(0, 'rgba(0,0,0,0)');
      vig.addColorStop(1, 'rgba(0,0,8,0.72)');
      actx.fillStyle = vig;
      actx.fillRect(0, 0, W, H);
      const bloom = actx.createRadialGradient(W / 2, 0, 0, W / 2, 0, H * 0.4);
      bloom.addColorStop(0, 'rgba(255,184,74,0.06)');
      bloom.addColorStop(1, 'rgba(255,184,74,0)');
      actx.fillStyle = bloom;
      actx.fillRect(0, 0, W, H);
    }
  }

  private _buildStars() {
    const W = window.innerWidth, H = window.innerHeight;
    this.stars = Array.from({ length: 260 }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      r: 0.3 + Math.random() * 1.2,
      a: 0.2 + Math.random() * 0.7,
      twinkle: 0.003 + Math.random() * 0.007,
      phase: Math.random() * Math.PI * 2,
    }));
  }

  private _buildNebulae() {
    const palette = [
      'rgba(10,30,80,',
      'rgba(30,10,60,',
      'rgba(0,60,70,',
      'rgba(60,20,10,',
    ];
    this.nebulae = Array.from({ length: 6 }, (_, i) => ({
      x: 0.1 + Math.random() * 0.8,
      y: 0.1 + Math.random() * 0.8,
      r: 200 + Math.random() * 350,
      color: palette[i % palette.length],
      drift: (Math.random() - 0.5) * 0.00015,
      t: Math.random() * Math.PI * 2,
    }));
  }

  private _tickBg = (t: number = performance.now()) => {
    if (this.bgPaused) return;
    // Throttle the heavy 2D redraw to ~30fps — keep the RAF cadence so resume/
    // pause stays responsive, but skip the expensive paint on most frames.
    if (t - this._bgLastDraw < VoiceFloatingHud.BG_MIN_INTERVAL) return;
    this.bgTime += (t - this._bgLastDraw) / 1000 * 60 * 0.016;
    this._bgLastDraw = t;
    this._drawBg();
  };

  private _drawBg() {
    const ctx = this.bgCtx;
    const canvas = this.bgCanvas;
    if (!ctx || !canvas) return;
    const W = canvas.width, H = canvas.height;

    // Static base gradient — baked once, blitted here (GPU-accelerated).
    if (this._bgBelow) ctx.drawImage(this._bgBelow, 0, 0);
    else ctx.clearRect(0, 0, W, H);

    // Nebulae (slow drift — the only reason the base needs a per-frame repaint)
    for (const n of this.nebulae) {
      n.t += n.drift;
      const nx = (n.x + Math.sin(n.t) * 0.04) * W;
      const ny = (n.y + Math.cos(n.t * 0.7) * 0.04) * H;
      const rg = ctx.createRadialGradient(nx, ny, 0, nx, ny, n.r);
      rg.addColorStop(0,   n.color + '0.18)');
      rg.addColorStop(0.5, n.color + '0.06)');
      rg.addColorStop(1,   n.color + '0)');
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(nx, ny, n.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Stars with slow twinkle
    const T = this.bgTime;
    for (const s of this.stars) {
      const a = s.a * (0.6 + 0.4 * Math.sin(T * s.twinkle * 60 + s.phase));
      ctx.fillStyle = `rgba(180,210,255,${a})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Static vignette + gold bloom — baked once, blitted on top.
    if (this._bgAbove) ctx.drawImage(this._bgAbove, 0, 0);
  }
  // ══════════════════════════════════════════════════════════
  // Voice blob
  // ══════════════════════════════════════════════════════════

  private _initBlob() {
    const host = this.renderRoot.querySelector('.blob-host') as HTMLDivElement;
    if (!host) return;
    try {
      this.voiceBlob = new VoiceBlob(host, {
        style: this.blobStyle,
        userColor: this.blobUserColor,
        agentColor: this.blobAgentColor,
        themeFollowSlots: true, // HUD blob follows the active theme
      });
      if (!this.reducedMotion) this.startBlobLoop();
    } catch {
      // WebGL unavailable — silently skip
    }
  }

  // Canonical blob drive — mirrors voice-chat.ts's terminal-mode tick so the
  // HUD blob looks and reacts IDENTICALLY: dual user/agent energy lanes, a VAD
  // floor, a TTS floor, and an ambient idle floor so the surface always
  // breathes between turns (the old tick used `this.volume`, which is always 0
  // → a frozen "dead" blob). Also publishes --vc-blob-energy / --vc-mesh-activity
  // so the world halo pulses with the blob and brightens with live mesh load.
  private _tickBlob = (t: number = performance.now()) => {
    if (!this.voiceBlob) return;

    // User lane — mic RMS (micLevel) with a VAD floor while speaking.
    const userV = Math.min(1, Math.max(0, this.micLevel / 100));
    const boostedUser = Math.min(1, userV * 1.4);
    const userDrive = Math.max(boostedUser, this.isUserSpeaking ? 0.72 : 0);

    // Agent lane — TTS analyser RMS with a floor during active speech.
    const agentV = Math.min(1, Math.max(0, this.agentLevel / 100));
    const agentDrive = Math.max(agentV, this.isAgentSpeaking ? 0.15 : 0);

    // Ambient idle floor so the wireframe never sits perfectly still.
    const dominant = Math.max(0.06, Math.max(userDrive, agentDrive));

    // Bass/treble — real FFT when the mic analyser is alive, else synthesized
    // from the dominant envelope so the displacement still feels organic.
    const hasFft = this.micBass > 0 || this.micTreble > 0;
    let bass: number, treble: number;
    if (hasFft) {
      bass   = Math.min(1, this.micBass * 1.3);
      treble = Math.min(1, this.micTreble * 1.8);
    } else {
      bass = dominant;
      treble = Math.pow(dominant, 1.4);
    }
    this.voiceBlob.update(dominant, t, bass, treble, userDrive, agentDrive);

    // Blob↔world coupling — same CSS vars the terminal publishes so the
    // .vc-world-halo scales/brightens with the blob and tints with mesh load.
    // Throttled to ~20fps: writing CSS custom properties on this fullscreen
    // fixed host invalidates style for everything reading them every frame, and
    // the halo coupling is a slow cosmetic glow that doesn't need 120Hz.
    if (t - this._fxCoupleLast < 50) return;
    this._fxCoupleLast = t;
    try {
      this.style.setProperty('--vc-blob-energy', dominant.toFixed(3));
      this._panelsEl?.style.setProperty('--hud-mic', userV.toFixed(3));
      const fx = (window as unknown as { __agentFxState?: Array<{ activity?: number; pulse?: number; status?: string }> }).__agentFxState;
      let act = 0;
      if (Array.isArray(fx) && fx.length) {
        for (const a of fx) {
          const e = a?.activity ?? a?.pulse ?? (a?.status === 'working' ? 1 : 0);
          act += Math.max(0, Math.min(1, e));
        }
        act = Math.min(1, act / fx.length);
      }
      this.style.setProperty('--vc-mesh-activity', act.toFixed(3));
    } catch { /* non-fatal cosmetic coupling */ }
  };

  private startBgLoop(): void {
    if (this.bgLoop) {
      this.bgLoop.resume();
      return;
    }
    this.bgLoop = rafLoop(this._tickBg);
  }

  private startBlobLoop(): void {
    if (this.blobLoop) {
      this.blobLoop.resume();
      return;
    }
    this.blobLoop = rafLoop(this._tickBlob);
  }

  private _pause() {
    this.bgPaused = true;
    this.bgLoop?.pause();
    this.blobLoop?.pause();
  }

  private _resume() {
    this.bgPaused = false;
    if (!this.reducedMotion) this.startBgLoop();
    if (!this.reducedMotion) this.startBlobLoop();
  }

  private _teardown() {
    this.bgLoop?.cancel();
    this.bgLoop = null;
    this.blobLoop?.cancel();
    this.blobLoop = null;
    this.voiceBlob?.dispose();
    this.voiceBlob = null;
  }

  render() {
    const hudState = this.isAgentSpeaking ? 'speaking'
                   : this.isUserSpeaking  ? 'listening'
                   : this.isProcessing    ? 'thinking'
                   : 'standby';
    return html`
      <canvas class="bg-canvas"></canvas>

      <!-- Ambient world: the iso agent map, dimmed + non-interactive. -->
      <div class="vc-world" aria-hidden="true">
        <agency-world-viz .client=${this.gatewayClient as any} no-overlays></agency-world-viz>
        <voice-world-connectors .client=${this.gatewayClient as any}></voice-world-connectors>
        <div class="vc-world-fade"></div>
      </div>

      <div class="hud-chrome" aria-hidden="true"></div>

      <!-- Layout + live panels. The orb is projected into the grid's centre
           cell so it shares one layout with the panels (no overlap). -->
      <voice-hud-panels .client=${this.gatewayClient} .call=${this.call}>
        <div class="blob-zone" slot="orb" data-state=${hudState}>
          <div class="blob-stage">
            <div class="blob-halo"></div>
            <div class="blob-host webgl-blob-host orb-container"></div>
          </div>
          <div class="blob-label"><span class="bl-dot"></span>INFINI<span class="bl-sep">·</span><span class="bl-state">${hudState}</span></div>
        </div>
      </voice-hud-panels>
    `;
  }

  static styles = css`
    :host {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 9000;
      overflow: hidden;
      font-family: 'JetBrains Mono', 'SF Mono', 'Consolas', monospace;
      color: #c8d8e8;
      pointer-events: auto;
    }

    /* ── Background canvas ── */
    .bg-canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      z-index: 0;
    }

    /* ── HUD chrome layer ── */
    .hud-chrome {
      position: absolute;
      inset: 0;
      z-index: 1;
      pointer-events: none;
    }
    /* Scanlines */
    .hud-chrome::before {
      content: '';
      position: absolute;
      inset: 0;
      background: repeating-linear-gradient(
        0deg,
        transparent,
        transparent 3px,
        rgba(0, 200, 255, 0.018) 3px,
        rgba(0, 200, 255, 0.018) 4px
      );
      animation: scanline-drift 12s linear infinite;
    }
    /* Subtle ISO grid overlay */
    .hud-chrome::after {
      content: '';
      position: absolute;
      inset: 0;
      background:
        linear-gradient(rgba(0,200,255,0.025) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0,200,255,0.025) 1px, transparent 1px);
      background-size: 60px 60px;
      opacity: 0.5;
    }
    @keyframes scanline-drift {
      from { background-position: 0 0; }
      to   { background-position: 0 80px; }
    }

    /* ── Corner brackets ── */

    /* ── Ambient world backdrop (dimmed; panels carry the data) ── */
    .vc-world {
      position: absolute;
      inset: 0;
      z-index: 1;
      overflow: hidden;
      pointer-events: none;
      opacity: 0.22;
      -webkit-mask-image: radial-gradient(70% 70% at 50% 55%, #000 35%, transparent 100%);
              mask-image: radial-gradient(70% 70% at 50% 55%, #000 35%, transparent 100%);
    }
    .vc-world agency-world-viz {
      position: absolute;
      inset: -6%;
      display: block;
      width: 112%;
      height: 112%;
    }
    .vc-world-fade {
      position: absolute;
      inset: 0;
      background: radial-gradient(125% 95% at 50% 44%, transparent 52%, rgba(2,5,16,0.78) 100%);
    }

    /* Phones: the world map is too dense to read behind a single-column
       layout (and costs GPU) — the orb + panels carry the HUD alone. */
    @media (max-width: 760px) {
      .vc-world { display: none; }
    }

    /* ── Voice orb (slotted into the panels grid's centre cell) ── */
    .blob-zone {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      container-type: size;
      pointer-events: none;
    }
    .blob-stage {
      position: relative;
      width: min(100cqw, calc(100cqh - 34px), 460px);
      aspect-ratio: 1;
      flex: 0 0 auto;
    }
    .blob-halo {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      transform: scale(calc(0.9 + var(--vc-blob-energy, 0.06) * 0.3));
      background: radial-gradient(circle,
        color-mix(in srgb, #f5c84b calc(14% + var(--vc-mesh-activity, 0) * 26%), transparent) 0%,
        transparent 62%);
      opacity: calc(0.35 + var(--vc-blob-energy, 0.06) * 0.55);
      transition: opacity 120ms linear, transform 120ms linear;
      mix-blend-mode: screen;
    }
    .blob-host {
      position: absolute;
      inset: 6px;
      filter: drop-shadow(0 0 36px rgba(245, 200, 75, 0.18));
      animation: bob 5s ease-in-out infinite;
    }
    .blob-host canvas {
      width: 100% !important;
      height: 100% !important;
      display: block;
    }
    @keyframes bob {
      0%, 100% { transform: translateY(0); }
      50%       { transform: translateY(-5px); }
    }
    .blob-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 10px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: rgba(255, 228, 154, 0.7);
      white-space: nowrap;
    }
    .bl-sep { color: rgba(245, 200, 75, 0.4); }
    .bl-state { color: rgba(124, 245, 255, 0.75); }
    .bl-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #f5c84b;
      box-shadow: 0 0 8px #f5c84b;
      animation: dot-blink 1.6s ease-in-out infinite;
    }
    .blob-zone[data-state="listening"] .bl-dot { background: #4ade80; box-shadow: 0 0 8px #4ade80; }
    .blob-zone[data-state="thinking"] .bl-dot { background: #7cf5ff; box-shadow: 0 0 8px #7cf5ff; }
    @keyframes dot-blink {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.25; }
    }

    @media (prefers-reduced-motion: reduce) {
      .blob-host, .bl-dot, .hud-chrome::before { animation: none !important; }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    'voice-floating-hud': VoiceFloatingHud;
  }
}
