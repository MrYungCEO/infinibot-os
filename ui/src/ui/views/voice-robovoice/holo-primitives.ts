/**
 * Holographic Voice Terminal primitives — the presentation layer of the Voice
 * page (REDESIGN_BRIEF.md). Pure visuals: none of these own call state, fire
 * call events or replace a control. Controls stay the session view's native
 * <button>/<select>/<input> elements (same handlers, same test ids); the
 * wrappers below only paint light around them.
 *
 *   <hud-corners>         partial framing — corner brackets instead of boxes
 *   <status-indicator>    a status dot with a soft halo (ok / active / idle / warn / error)
 *   <telemetry-label>     small technical label (+ optional value) with a lead tick
 *   <orbital-ring>        one SVG instrument ring (track / ticks / segments / arc / dashed)
 *   <voice-core>          the HUD around the existing WebGL blob (slotted, never replaced):
 *                         haze, orbital rings, waveform arc, particles, platform, side labels
 *   <mic-reactor>         circular reactor around the slotted mic button
 *   <glow-button>         bloom + light trace behind a slotted primary button (CONNECT)
 *   <hud-capsule>         glint + trace on a slotted dark-glass capsule control
 *   <pipeline-node>       one live-pipeline stage node (slotted icon)
 *   <transcript-message>  one floating comms capsule in the transcript
 *
 * Palette: champagne gold used as light. Tiers (darkest → white-gold):
 *   #4A3510 #7A5816 #D6A62A #F5C84B #FFE49A #FFF3CF
 */

import { LitElement, css, html, nothing, svg, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";

/** Gold-as-light tiers + glass tokens, shared by every primitive and the view's holo sheet. */
export const holoTokens = css`
  :host {
    --hx-g0: #4a3510;
    --hx-g1: #7a5816;
    --hx-g2: #d6a62a;
    --hx-g3: #f5c84b;
    --hx-g4: #ffe49a;
    --hx-g5: #fff3cf;
    --hx-ink: #020304;
    --hx-ink-2: #050608;
    --hx-ink-3: #08090b;
    --hx-violet: #c9b6ff;
    --hx-rose: #f3b6d4;
    --hx-ok: #5fe3a1;
    --hx-warn: #f2b45a;
    --hx-bad: #ff6b6b;
    --hx-meta: rgba(226, 222, 212, 0.52);
    --hx-meta-dim: rgba(226, 222, 212, 0.32);
    --hx-glass: linear-gradient(160deg, rgba(14, 13, 11, 0.72) 0%, rgba(6, 7, 9, 0.58) 60%, rgba(4, 5, 7, 0.4) 100%);
    --hx-edge: color-mix(in srgb, var(--hx-g2) 34%, transparent);
    --hx-edge-soft: color-mix(in srgb, var(--hx-g2) 16%, transparent);
    --hx-font-head: "Rajdhani", "Barlow Condensed", "Oswald", "Roboto Condensed", "Arial Narrow", "DejaVu Sans Condensed", ui-sans-serif, system-ui, sans-serif;
    --hx-font-mono: "JetBrains Mono", "SF Mono", "Fira Code", ui-monospace, monospace;
    --hx-font-sans: var(--g-font-sans, "Inter", "SF Pro Text", "Segoe UI", ui-sans-serif, system-ui, sans-serif);
  }
`;

const reduceMotion = css`
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
`;

/** Deterministic 0..1 sequence (stable layout between renders, no Math.random flicker). */
function seq(n: number, seed: number): number[] {
  const out: number[] = [];
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 9301 + 49297) % 233280;
    out.push(x / 233280);
  }
  return out;
}

// ── <hud-corners> ──────────────────────────────────────────────────────────

/** Corner brackets. Default = top-left + bottom-right only (partial framing, never a box). */
@customElement("hud-corners")
export class HudCorners extends LitElement {
  /** Space-separated subset of "tl tr bl br". */
  @property() corners = "tl br";
  /** Bracket arm length in px. */
  @property({ type: Number }) size = 14;
  /** ghost | dim | gold | bright */
  @property({ reflect: true }) tone: "ghost" | "dim" | "gold" | "bright" = "dim";
  /** Offset from the host edge in px (negative = outside). */
  @property({ type: Number }) inset = 0;

  render() {
    const set = new Set(this.corners.split(/\s+/));
    return html`${(["tl", "tr", "bl", "br"] as const).map((c) =>
      set.has(c) ? html`<span class="c ${c}" style="--s:${this.size}px;--o:${this.inset}px"></span>` : nothing,
    )}`;
  }

  static styles = [
    holoTokens,
    css`
      :host { position: absolute; inset: 0; pointer-events: none; z-index: 2; --line: color-mix(in srgb, var(--hx-g2) 42%, transparent); }
      :host([tone="ghost"]) { --line: color-mix(in srgb, var(--hx-g2) 18%, transparent); }
      :host([tone="gold"]) { --line: color-mix(in srgb, var(--hx-g3) 70%, transparent); }
      :host([tone="bright"]) { --line: var(--hx-g4); filter: drop-shadow(0 0 3px color-mix(in srgb, var(--hx-g3) 70%, transparent)); }
      .c { position: absolute; width: var(--s); height: var(--s); }
      .tl { top: var(--o); left: var(--o); border-top: 1px solid var(--line); border-left: 1px solid var(--line); }
      .tr { top: var(--o); right: var(--o); border-top: 1px solid var(--line); border-right: 1px solid var(--line); }
      .bl { bottom: var(--o); left: var(--o); border-bottom: 1px solid var(--line); border-left: 1px solid var(--line); }
      .br { bottom: var(--o); right: var(--o); border-bottom: 1px solid var(--line); border-right: 1px solid var(--line); }
    `,
  ];
}

// ── <status-indicator> ─────────────────────────────────────────────────────

@customElement("status-indicator")
export class StatusIndicator extends LitElement {
  /** ok = green, active = gold, idle = graphite, warn = amber, error = red. */
  @property({ reflect: true }) tone: "ok" | "active" | "idle" | "warn" | "error" = "idle";
  @property({ type: Boolean, reflect: true }) pulse = false;

  render() {
    return html`<span class="dot" aria-hidden="true"></span>`;
  }

  static styles = [
    holoTokens,
    reduceMotion,
    css`
      :host { display: inline-flex; width: 7px; height: 7px; flex: none; position: relative; --c: rgba(226, 222, 212, 0.28); --halo: transparent; }
      :host([tone="ok"]) { --c: var(--hx-ok); --halo: color-mix(in srgb, var(--hx-ok) 55%, transparent); }
      :host([tone="active"]) { --c: var(--hx-g3); --halo: color-mix(in srgb, var(--hx-g3) 60%, transparent); }
      :host([tone="warn"]) { --c: var(--hx-warn); --halo: color-mix(in srgb, var(--hx-warn) 55%, transparent); }
      :host([tone="error"]) { --c: var(--hx-bad); --halo: color-mix(in srgb, var(--hx-bad) 55%, transparent); }
      .dot { width: 100%; height: 100%; border-radius: 50%; background: var(--c); box-shadow: 0 0 0 2px color-mix(in srgb, var(--c) 14%, transparent), 0 0 8px var(--halo); }
      :host([pulse]) .dot { animation: si-pulse 1.8s ease-in-out infinite; }
      @keyframes si-pulse { 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--c) 6%, transparent), 0 0 14px var(--halo); opacity: 0.75; } }
    `,
  ];
}

// ── <telemetry-label> ──────────────────────────────────────────────────────

@customElement("telemetry-label")
export class TelemetryLabel extends LitElement {
  @property() label = "";
  @property() value = "";
  /** Lit = brighter (the live state on the core's side rail). */
  @property({ type: Boolean, reflect: true }) lit = false;
  /** Tick side: "left" (default) | "right" | "none". */
  @property({ reflect: true }) tick: "left" | "right" | "none" = "left";

  render() {
    return html`<span class="t" aria-hidden="true"></span><span class="l">${this.label}</span>${this.value
        ? html`<span class="v">${this.value}</span>`
        : nothing}`;
  }

  static styles = [
    holoTokens,
    css`
      :host { display: inline-flex; align-items: center; gap: 7px; font: 500 9px/1.2 var(--hx-font-mono); letter-spacing: 0.22em; text-transform: uppercase; color: var(--hx-meta-dim); white-space: nowrap; }
      :host([tick="right"]) { flex-direction: row-reverse; }
      .t { width: 10px; height: 1px; background: currentColor; opacity: 0.6; }
      :host([tick="none"]) .t { display: none; }
      .v { color: var(--hx-g4); letter-spacing: 0.08em; }
      :host([lit]) { color: var(--hx-g4); text-shadow: 0 0 10px color-mix(in srgb, var(--hx-g3) 55%, transparent); }
      :host([lit]) .t { width: 16px; opacity: 1; background: var(--hx-g3); box-shadow: 0 0 6px var(--hx-g3); }
    `,
  ];
}

// ── <orbital-ring> ─────────────────────────────────────────────────────────

/**
 * One SVG instrument ring, centred in its positioned parent and sized as a
 * percentage of it. Hierarchy comes from `tier`: ghost rings are nearly
 * invisible, only a few `glow` segments light up.
 */
@customElement("orbital-ring")
export class OrbitalRing extends LitElement {
  /** Diameter as % of the parent box. */
  @property({ type: Number }) size = 100;
  @property() kind: "track" | "ticks" | "segments" | "arc" | "dashed" = "track";
  @property({ reflect: true }) tier: "ghost" | "dim" | "mid" | "glow" = "dim";
  /** Ticks / segments count. */
  @property({ type: Number }) count = 72;
  /** Arc sweep in degrees (kind=arc), or lit-segment stride (kind=segments). */
  @property({ type: Number }) sweep = 70;
  /** Seconds per revolution; negative = counter-clockwise; 0 = static. */
  @property({ type: Number }) spin = 0;
  /** Start angle in degrees. */
  @property({ type: Number }) rotate = 0;

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("size")) this.style.setProperty("--d", `${this.size}%`);
    if (changed.has("spin") || changed.has("rotate")) {
      this.style.setProperty("--spin", `${Math.abs(this.spin) || 1}s`);
      this.style.setProperty("--dir", this.spin < 0 ? "reverse" : "normal");
      this.style.setProperty("--rot", `${this.rotate}deg`);
      this.toggleAttribute("spinning", this.spin !== 0);
    }
  }

  private body() {
    const r = 98;
    switch (this.kind) {
      case "ticks": {
        const n = this.count;
        return svg`${Array.from({ length: n }, (_, i) => {
          const major = i % 6 === 0;
          const a = (i / n) * Math.PI * 2;
          const r1 = major ? r - 7 : r - 3.5;
          return svg`<line class=${major ? "major" : "minor"} x1=${100 + Math.cos(a) * r1} y1=${100 + Math.sin(a) * r1} x2=${100 + Math.cos(a) * r} y2=${100 + Math.sin(a) * r}></line>`;
        })}`;
      }
      case "segments": {
        const n = this.count;
        const step = 360 / n;
        return svg`${Array.from({ length: n }, (_, i) => {
          const lit = this.sweep > 0 && i % Math.max(1, Math.round(this.sweep)) === 0;
          return svg`<circle class=${lit ? "seg lit" : "seg"} cx="100" cy="100" r=${r} pathLength="360"
            stroke-dasharray=${`${step * 0.72} ${360 - step * 0.72}`} stroke-dashoffset=${-i * step}></circle>`;
        })}`;
      }
      case "arc":
        return svg`<circle class="arc" cx="100" cy="100" r=${r} pathLength="360" stroke-dasharray=${`${this.sweep} ${360 - this.sweep}`}></circle>
          <circle class="arc-tail" cx="100" cy="100" r=${r} pathLength="360" stroke-dasharray=${`${this.sweep * 0.5} ${360 - this.sweep * 0.5}`} stroke-dashoffset=${-this.sweep - 6}></circle>`;
      case "dashed":
        return svg`<circle class="track" cx="100" cy="100" r=${r} pathLength="360" stroke-dasharray="1.2 4.8"></circle>`;
      default:
        return svg`<circle class="track" cx="100" cy="100" r=${r}></circle>`;
    }
  }

  render() {
    return html`<svg viewBox="0 0 200 200" aria-hidden="true">${this.body()}</svg>`;
  }

  static styles = [
    holoTokens,
    reduceMotion,
    css`
      :host {
        position: absolute; left: 50%; top: 50%; width: var(--d, 100%); aspect-ratio: 1; pointer-events: none;
        transform: translate(-50%, -50%) rotate(var(--rot, 0deg));
        --stroke: color-mix(in srgb, var(--hx-g2) 30%, transparent);
        --lit: var(--hx-g3);
      }
      :host([tier="ghost"]) { --stroke: color-mix(in srgb, var(--hx-g2) 9%, transparent); }
      :host([tier="mid"]) { --stroke: color-mix(in srgb, var(--hx-g2) 48%, transparent); }
      :host([tier="glow"]) { --stroke: color-mix(in srgb, var(--hx-g3) 78%, transparent); filter: drop-shadow(0 0 4px color-mix(in srgb, var(--hx-g3) 60%, transparent)); }
      :host([spinning]) svg { animation: or-spin var(--spin) linear infinite; animation-direction: var(--dir); }
      @keyframes or-spin { to { transform: rotate(360deg); } }
      svg { width: 100%; height: 100%; overflow: visible; display: block; }
      circle, line { fill: none; stroke: var(--stroke); stroke-width: 1; vector-effect: non-scaling-stroke; }
      line.major { stroke: color-mix(in srgb, var(--stroke) 100%, var(--hx-g3) 25%); }
      .seg.lit { stroke: var(--lit); stroke-width: 1.6; }
      .arc { stroke: var(--lit); stroke-width: 1.4; stroke-linecap: round; }
      .arc-tail { stroke: color-mix(in srgb, var(--hx-g3) 30%, transparent); }
    `,
  ];
}

// ── <voice-core> ───────────────────────────────────────────────────────────

const LEFT_WORDS: Array<{ word: string; on: string }> = [
  { word: "Listen", on: "listening" },
  { word: "Think", on: "thinking" },
  { word: "Speak", on: "speaking" },
  { word: "Evolve", on: "" },
];
const RIGHT_WORDS = ["Realtime", "Multimodal", "Intelligence"];

/**
 * The holographic HUD around the voice blob. The blob itself is the slotted
 * `.webgl-blob-host` (the original WebGL VoiceBlob, mounted and driven by the
 * session view exactly as before) — this element never draws, sizes or
 * replaces it. Energy comes from the view's `--vc-blob-energy` (set per frame).
 */
@customElement("voice-core")
export class VoiceCore extends LitElement {
  /** aiState(): idle | listening | thinking | speaking. */
  @property({ reflect: true }) state = "idle";
  /** In a live call (rings brighten, waveform arcs wake). */
  @property({ type: Boolean, reflect: true }) live = false;
  /** Show the atmospheric side labels. */
  @property({ type: Boolean, reflect: true }) labels = true;

  private readonly dust = seq(28, 7).map((v, i, a) => ({ a: v * 360, r: 0.56 + (a[(i + 5) % a.length] ?? 0.5) * 0.3, d: 4 + ((i * 7) % 9), s: i % 5 === 0 ? 2 : 1 }));
  private readonly wave = seq(64, 31);

  private waveArc(startDeg: number, sweepDeg: number) {
    const n = 32;
    return svg`${Array.from({ length: n }, (_, i) => {
      const a = ((startDeg + (i / (n - 1)) * sweepDeg) * Math.PI) / 180;
      const n2 = this.wave.length;
      const h = 2 + this.wave[(((i + Math.round(startDeg)) % n2) + n2) % n2] * 7;
      const r0 = 74;
      return svg`<line class="wv" style="--i:${i}" x1=${100 + Math.cos(a) * r0} y1=${100 + Math.sin(a) * r0} x2=${100 + Math.cos(a) * (r0 + h)} y2=${100 + Math.sin(a) * (r0 + h)}></line>`;
    })}`;
  }

  render() {
    return html`
      <div class="haze" aria-hidden="true"></div>
      <div class="grid" aria-hidden="true"></div>
      <div class="rings" aria-hidden="true">
        <orbital-ring size="170" kind="dashed" tier="ghost" spin="-240"></orbital-ring>
        <orbital-ring size="152" kind="ticks" tier="ghost" count="120" spin="180"></orbital-ring>
        <orbital-ring size="134" kind="segments" tier="dim" count="48" sweep="9" spin="-90" rotate="12"></orbital-ring>
        <orbital-ring size="118" kind="track" tier="dim"></orbital-ring>
        <orbital-ring size="118" kind="arc" tier="glow" sweep="38" spin="26" rotate="-60"></orbital-ring>
        <orbital-ring size="104" kind="ticks" tier="dim" count="72" spin="-140"></orbital-ring>
        <orbital-ring class="live-arc" size="142" kind="arc" tier="mid" sweep="24" spin="-18" rotate="140"></orbital-ring>
      </div>
      <svg class="waves" viewBox="0 0 200 200" aria-hidden="true">${this.waveArc(200, 50)}${this.waveArc(-70, 50)}</svg>
      <div class="dust" aria-hidden="true">
        ${this.dust.map((p) => html`<i style="--a:${p.a}deg;--r:${p.r};--d:${p.d}s;--s:${p.s}px"></i>`)}
      </div>
      <div class="platform" aria-hidden="true">
        <svg viewBox="0 0 400 120" preserveAspectRatio="none">
          <defs>
            <radialGradient id="vc-floor" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stop-color="#f5c84b" stop-opacity="0.32"></stop>
              <stop offset="55%" stop-color="#d6a62a" stop-opacity="0.08"></stop>
              <stop offset="100%" stop-color="#4a3510" stop-opacity="0"></stop>
            </radialGradient>
          </defs>
          <ellipse cx="200" cy="60" rx="196" ry="52" fill="url(#vc-floor)"></ellipse>
          <ellipse class="pe e1" cx="200" cy="60" rx="190" ry="44"></ellipse>
          <ellipse class="pe e2" cx="200" cy="60" rx="146" ry="33"></ellipse>
          <ellipse class="pe e3" cx="200" cy="60" rx="98" ry="21"></ellipse>
          <ellipse class="pe e4" cx="200" cy="60" rx="52" ry="10"></ellipse>
          ${[-160, -110, -60, 60, 110, 160].map((x) => svg`<line class="trace" x1=${200 + x * 0.32} y1="60" x2=${200 + x} y2=${x < 0 ? 90 : 90}></line>`)}
        </svg>
        <div class="beam"></div>
      </div>
      <div class="core"><slot></slot></div>
      ${this.labels
        ? html`<div class="side left">
              <div class="words">
                ${LEFT_WORDS.map((w) => html`<telemetry-label label=${w.word} ?lit=${w.on !== "" && w.on === this.state}></telemetry-label>`)}
              </div>
              <div class="tag"><span>Human ideas</span><b>+</b><span>Machine potential</span></div>
            </div>
            <div class="side right">
              <div class="words">
                ${RIGHT_WORDS.map((w) => html`<telemetry-label tick="right" label=${w} ?lit=${this.live && w === "Realtime"}></telemetry-label>`)}
              </div>
              <div class="tag"><span>The future</span><span>speaks with you</span></div>
            </div>`
        : nothing}
    `;
  }

  static styles = [
    holoTokens,
    reduceMotion,
    css`
      :host {
        position: absolute; inset: 0; display: block; pointer-events: none;
        container-type: size;
        --e: var(--vc-blob-energy, 0);
      }
      .core { position: absolute; inset: 0; z-index: 3; }
      /* Soft volumetric glow behind the wires — dark centre stays dark so the mesh reads. */
      .haze {
        position: absolute; left: 50%; top: 50%; width: 120%; aspect-ratio: 1; transform: translate(-50%, -50%); z-index: 0;
        background:
          radial-gradient(circle, transparent 0 20%, color-mix(in srgb, var(--hx-g3) calc(7% + var(--e) * 14%), transparent) 34%, color-mix(in srgb, var(--hx-g1) 8%, transparent) 50%, transparent 66%);
        filter: blur(6px);
        transition: opacity 400ms ease;
        opacity: 0.85;
      }
      .grid {
        position: absolute; left: 50%; top: 50%; width: 190%; aspect-ratio: 1; transform: translate(-50%, -50%); z-index: 0;
        background:
          linear-gradient(color-mix(in srgb, var(--hx-g2) 7%, transparent) 1px, transparent 1px),
          linear-gradient(90deg, color-mix(in srgb, var(--hx-g2) 7%, transparent) 1px, transparent 1px);
        background-size: 34px 34px; background-position: center;
        -webkit-mask-image: radial-gradient(circle, #000 0, rgba(0,0,0,0.5) 28%, transparent 56%);
        mask-image: radial-gradient(circle, #000 0, rgba(0,0,0,0.5) 28%, transparent 56%);
        opacity: 0.55;
      }
      .rings { position: absolute; inset: 0; z-index: 1; opacity: 0.8; transition: opacity 500ms ease; }
      :host([live]) .rings { opacity: 1; }
      .rings .live-arc { opacity: 0; transition: opacity 500ms ease; }
      :host([live]) .rings .live-arc { opacity: 1; }
      :host([state="thinking"]) .rings orbital-ring[kind="segments"] { filter: drop-shadow(0 0 3px color-mix(in srgb, var(--hx-g3) 55%, transparent)); }

      .waves { position: absolute; left: 50%; top: 50%; width: 134%; aspect-ratio: 1; transform: translate(-50%, -50%); z-index: 1; overflow: visible; }
      .wv { stroke: color-mix(in srgb, var(--hx-g3) 55%, transparent); stroke-width: 1; vector-effect: non-scaling-stroke; stroke-linecap: round; opacity: calc(0.18 + var(--e) * 0.8); transform-origin: 100px 100px; }
      :host([state="speaking"]) .wv, :host([state="listening"]) .wv { animation: wv 1.1s ease-in-out infinite; animation-delay: calc(var(--i) * -70ms); }
      @keyframes wv { 50% { opacity: calc(0.3 + var(--e)); } }

      .dust { position: absolute; left: 50%; top: 50%; width: 0; height: 0; z-index: 2; }
      .dust i {
        position: absolute; width: var(--s); height: var(--s); border-radius: 50%; background: var(--hx-g4);
        box-shadow: 0 0 4px var(--hx-g3); opacity: 0.35;
        transform: rotate(var(--a)) translateX(calc(var(--r) * 62cqw));
        animation: dust var(--d) ease-in-out infinite alternate;
      }
      @keyframes dust { to { opacity: 0.08; transform: rotate(calc(var(--a) + 6deg)) translateX(calc(var(--r) * 66cqw)); } }

      /* Holographic projection platform under the core — subtle, never competing with the blob. */
      .platform { position: absolute; left: 50%; top: 79%; width: 104%; height: 24%; transform: translateX(-50%); z-index: 0; }
      .platform svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
      .pe { fill: none; stroke: color-mix(in srgb, var(--hx-g2) 26%, transparent); stroke-width: 1; vector-effect: non-scaling-stroke; }
      .pe.e1 { stroke: color-mix(in srgb, var(--hx-g2) 12%, transparent); stroke-dasharray: 2 6; }
      .pe.e3 { stroke: color-mix(in srgb, var(--hx-g3) 42%, transparent); }
      .pe.e4 { stroke: color-mix(in srgb, var(--hx-g4) 60%, transparent); filter: drop-shadow(0 0 4px var(--hx-g3)); }
      .trace { stroke: color-mix(in srgb, var(--hx-g2) 14%, transparent); stroke-width: 1; vector-effect: non-scaling-stroke; }
      .beam {
        position: absolute; left: 50%; bottom: 50%; width: 46%; height: 260%; transform: translateX(-50%);
        background: linear-gradient(to top, color-mix(in srgb, var(--hx-g3) 9%, transparent), transparent 70%);
        clip-path: polygon(30% 100%, 70% 100%, 100% 0, 0 0);
        filter: blur(10px); opacity: calc(0.5 + var(--e) * 0.6);
      }

      .side { position: absolute; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 22px; z-index: 4; }
      /* Just outside the segmented ring (134%), over the ghost instrument rings. */
      .side.left { right: 117%; align-items: flex-start; }
      .side.right { left: 117%; align-items: flex-end; }
      .words { display: flex; flex-direction: column; gap: 11px; }
      .side.left .words { align-items: flex-start; }
      .side.right .words { align-items: flex-end; }
      .tag { display: flex; flex-direction: column; gap: 3px; font: 600 9.5px/1.25 var(--hx-font-head); letter-spacing: 0.26em; text-transform: uppercase; color: color-mix(in srgb, var(--hx-g3) 62%, transparent); }
      .side.right .tag { text-align: right; }
      .tag b { font-weight: 400; color: var(--hx-meta-dim); letter-spacing: 0; }
      /* Side rails only when the stage (the view's .panel-center, container
         "hx-stage") has room beside the rings; otherwise they'd clip. */
      .side { display: none; }
      @container hx-stage (min-width: 1180px) { .side { display: flex; } }
    `,
  ];
}

// ── <mic-reactor> ──────────────────────────────────────────────────────────

/** Circular reactor around the slotted mic button — it reads as powering the core. */
@customElement("mic-reactor")
export class MicReactor extends LitElement {
  /** The caller is speaking. */
  @property({ type: Boolean, reflect: true }) active = false;
  @property({ type: Boolean, reflect: true }) muted = false;
  /** In a live call. */
  @property({ type: Boolean, reflect: true }) live = false;

  private readonly sparks = seq(10, 13);

  render() {
    return html`
      <div class="halo" aria-hidden="true"></div>
      <svg class="ring" viewBox="0 0 100 100" aria-hidden="true">
        <circle class="outer" cx="50" cy="50" r="48"></circle>
        ${Array.from({ length: 48 }, (_, i) => {
          const a = (i / 48) * Math.PI * 2;
          const r1 = i % 4 === 0 ? 44.5 : 46;
          return svg`<line class="tk" x1=${50 + Math.cos(a) * r1} y1=${50 + Math.sin(a) * r1} x2=${50 + Math.cos(a) * 47.2} y2=${50 + Math.sin(a) * 47.2}></line>`;
        })}
        <circle class="arc" cx="50" cy="50" r="42" pathLength="360" stroke-dasharray="70 290"></circle>
        <circle class="inner" cx="50" cy="50" r="37"></circle>
      </svg>
      <div class="energy" aria-hidden="true"></div>
      <div class="sparks" aria-hidden="true">${this.sparks.map((v, i) => html`<i style="--a:${v * 360}deg;--d:${2.4 + (i % 4) * 0.7}s"></i>`)}</div>
      <div class="slot"><slot></slot></div>
    `;
  }

  static styles = [
    holoTokens,
    reduceMotion,
    css`
      :host { position: relative; display: inline-grid; place-items: center; width: 82px; height: 82px; flex: none; }
      .slot { position: relative; z-index: 3; display: grid; place-items: center; }
      .halo {
        position: absolute; inset: -26px; border-radius: 50%; z-index: 0;
        background: radial-gradient(circle, color-mix(in srgb, var(--hx-g3) 22%, transparent) 0%, color-mix(in srgb, var(--hx-violet) 7%, transparent) 42%, transparent 68%);
        opacity: 0.55; transition: opacity 300ms ease;
      }
      :host([live]) .halo { opacity: 0.85; }
      :host([active]) .halo { opacity: 1; animation: mr-breathe 0.9s ease-in-out infinite alternate; }
      @keyframes mr-breathe { to { transform: scale(1.08); } }
      .ring { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 1; overflow: visible; }
      .ring circle, .ring line { fill: none; vector-effect: non-scaling-stroke; }
      .outer { stroke: color-mix(in srgb, var(--hx-g3) 72%, transparent); stroke-width: 1.2; filter: drop-shadow(0 0 3px color-mix(in srgb, var(--hx-g3) 70%, transparent)); }
      .tk { stroke: color-mix(in srgb, var(--hx-g2) 45%, transparent); stroke-width: 1; }
      .inner { stroke: color-mix(in srgb, var(--hx-g2) 30%, transparent); stroke-width: 1; }
      .arc { stroke: var(--hx-g4); stroke-width: 1.4; stroke-linecap: round; transform-origin: 50px 50px; animation: mr-spin 6s linear infinite; opacity: 0.8; }
      :host([active]) .arc { animation-duration: 1.6s; }
      @keyframes mr-spin { to { transform: rotate(360deg); } }
      .energy {
        position: absolute; inset: 14px; border-radius: 50%; z-index: 2;
        background:
          radial-gradient(circle at 50% 38%, color-mix(in srgb, var(--hx-g5) 30%, transparent) 0%, transparent 46%),
          conic-gradient(from 210deg, color-mix(in srgb, var(--hx-g3) 34%, transparent), color-mix(in srgb, var(--hx-rose) 22%, transparent), color-mix(in srgb, var(--hx-violet) 26%, transparent), color-mix(in srgb, var(--hx-g3) 34%, transparent));
        -webkit-mask-image: radial-gradient(circle, transparent 0 52%, #000 66%, transparent 100%);
        mask-image: radial-gradient(circle, transparent 0 52%, #000 66%, transparent 100%);
        filter: blur(1.5px); opacity: 0.7;
      }
      .sparks { position: absolute; left: 50%; top: 50%; z-index: 2; }
      .sparks i { position: absolute; width: 2px; height: 2px; border-radius: 50%; background: var(--hx-g5); box-shadow: 0 0 4px var(--hx-g3); opacity: 0; transform: rotate(var(--a)) translateX(40px); animation: mr-spark var(--d) ease-out infinite; }
      :host([live]) .sparks i { opacity: 0.5; }
      @keyframes mr-spark { from { opacity: 0.7; transform: rotate(var(--a)) translateX(38px); } to { opacity: 0; transform: rotate(var(--a)) translateX(56px); } }
      :host([muted]) .outer { stroke: color-mix(in srgb, var(--hx-bad) 60%, transparent); filter: none; }
      :host([muted]) .arc, :host([muted]) .sparks { display: none; }
      :host([muted]) .energy { opacity: 0.2; }
      :host([muted]) .halo { background: radial-gradient(circle, color-mix(in srgb, var(--hx-bad) 14%, transparent), transparent 66%); }
    `,
  ];
}

// ── <glow-button> ──────────────────────────────────────────────────────────

/** Bloom + top light trace behind the slotted primary button (it lights the surface around it). */
@customElement("glow-button")
export class GlowButton extends LitElement {
  /** gold = CONNECT; danger = END/CANCEL. */
  @property({ reflect: true }) tone: "gold" | "danger" = "gold";

  render() {
    return html`<span class="bloom" aria-hidden="true"></span><slot></slot><span class="trace" aria-hidden="true"></span>`;
  }

  static styles = [
    holoTokens,
    css`
      :host { position: relative; display: inline-flex; isolation: isolate; }
      .bloom {
        position: absolute; inset: -14px -22px; z-index: -1; border-radius: 999px; pointer-events: none;
        background: radial-gradient(ellipse at center, color-mix(in srgb, var(--hx-g3) 34%, transparent) 0%, color-mix(in srgb, var(--hx-g2) 10%, transparent) 46%, transparent 72%);
        filter: blur(6px);
      }
      :host([tone="danger"]) .bloom { background: radial-gradient(ellipse at center, color-mix(in srgb, var(--hx-bad) 8%, transparent), transparent 70%); }
      .trace { position: absolute; left: 18%; right: 18%; top: -1px; height: 1px; pointer-events: none; background: linear-gradient(90deg, transparent, var(--hx-g5), transparent); opacity: 0.85; }
      :host([tone="danger"]) .trace { background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--hx-bad) 80%, white), transparent); opacity: 0.5; }
      ::slotted(*) { position: relative; }
    `,
  ];
}

// ── <hud-capsule> ──────────────────────────────────────────────────────────

/** Light trace + tiny corner glint on a slotted dark-glass capsule control. */
@customElement("hud-capsule")
export class HudCapsule extends LitElement {
  @property({ type: Boolean, reflect: true }) lit = false;

  render() {
    return html`<slot></slot><span class="glint" aria-hidden="true"></span>`;
  }

  static styles = [
    holoTokens,
    css`
      :host { position: relative; display: inline-flex; }
      .glint { position: absolute; left: 22%; width: 34%; top: 0; height: 1px; pointer-events: none; background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--hx-g4) 70%, transparent), transparent); opacity: 0.55; }
      :host([lit]) .glint { opacity: 1; left: 14%; width: 60%; }
    `,
  ];
}

// ── <pipeline-node> ────────────────────────────────────────────────────────

/** One live-pipeline stage node: dark glass disc, gold ring, slotted icon. */
@customElement("pipeline-node")
export class PipelineNode extends LitElement {
  @property({ type: Boolean, reflect: true }) lit = false;
  @property({ type: Boolean, reflect: true }) active = false;
  @property({ type: Boolean, reflect: true }) done = false;

  render() {
    return html`${this.active ? html`<span class="ping" aria-hidden="true"></span>` : nothing}<span class="disc"><slot></slot></span>`;
  }

  static styles = [
    holoTokens,
    reduceMotion,
    css`
      :host { position: relative; display: grid; place-items: center; width: 34px; height: 34px; flex: none; color: color-mix(in srgb, var(--hx-g3) 55%, transparent); }
      .disc {
        position: relative; width: 100%; height: 100%; box-sizing: border-box; border-radius: 50%; display: grid; place-items: center;
        background: radial-gradient(circle at 50% 35%, rgba(255, 243, 207, 0.05), rgba(6, 8, 12, 0.9) 70%);
        border: 1px solid color-mix(in srgb, var(--hx-g2) 26%, transparent);
        box-shadow: inset 0 1px 0 rgba(255, 243, 207, 0.06);
        transition: border-color 250ms ease, box-shadow 250ms ease, color 250ms ease;
      }
      :host([lit]) { color: var(--hx-g4); }
      :host([lit]) .disc { border-color: color-mix(in srgb, var(--hx-g3) 70%, transparent); box-shadow: 0 0 14px -2px color-mix(in srgb, var(--hx-g3) 70%, transparent), inset 0 0 10px color-mix(in srgb, var(--hx-g3) 18%, transparent); }
      :host([done]:not([active])) .disc { border-color: color-mix(in srgb, var(--hx-g2) 55%, transparent); }
      .ping { position: absolute; inset: 0; border-radius: 50%; border: 1px solid var(--hx-g3); animation: pn-ping 1.2s ease-out infinite; }
      @keyframes pn-ping { from { opacity: 0.8; transform: scale(0.92); } to { opacity: 0; transform: scale(1.55); } }
      ::slotted(svg) { width: 15px; height: 15px; }
    `,
  ];
}

// ── <transcript-message> ───────────────────────────────────────────────────

const USER_ICON = svg`<circle cx="12" cy="8" r="4"></circle><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"></path>`;
const AGENT_ICON = svg`<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>`;

/** One floating comms capsule. USER = smoked glass; agent = warm gold glass with a tiny waveform. */
@customElement("transcript-message")
export class TranscriptMessage extends LitElement {
  @property({ reflect: true }) speaker: "user" | "agent" = "user";
  @property() name = "";
  @property() time = "";
  @property() text = "";
  /** The agent's line that is being spoken now (waveform animates). */
  @property({ type: Boolean, reflect: true }) live = false;

  render() {
    const agent = this.speaker === "agent";
    return html`<div class="cap">
      <div class="head">
        <svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${agent ? AGENT_ICON : USER_ICON}</svg>
        <span class="who">${this.name}</span>
        ${agent ? html`<span class="wave" aria-hidden="true">${[5, 9, 6, 11, 7, 4, 8].map((h, i) => html`<i style="--h:${h}px;--i:${i}"></i>`)}</span>` : nothing}
        <span class="time">${this.time}</span>
      </div>
      <div class="text">${this.text}</div>
    </div>`;
  }

  static styles = [
    holoTokens,
    reduceMotion,
    css`
      :host { display: flex; margin: 0 0 12px; animation: tm-in 320ms cubic-bezier(0.22, 1, 0.36, 1) both; }
      :host([speaker="user"]) { justify-content: flex-end; }
      @keyframes tm-in { from { opacity: 0; transform: translateY(6px); } }
      .cap {
        position: relative; max-width: 92%; padding: 9px 13px 10px; border-radius: 4px 14px 14px 14px;
        background: linear-gradient(160deg, rgba(20, 21, 24, 0.66), rgba(8, 9, 11, 0.42));
        border: 1px solid rgba(255, 255, 255, 0.06);
        box-shadow: 0 10px 26px -18px rgba(0, 0, 0, 0.9), inset 0 1px 0 rgba(255, 255, 255, 0.04);
        -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
      }
      :host([speaker="user"]) .cap { border-radius: 14px 4px 14px 14px; }
      :host([speaker="agent"]) .cap {
        background:
          linear-gradient(100deg, color-mix(in srgb, var(--hx-g3) 13%, transparent), color-mix(in srgb, var(--hx-g2) 4%, transparent) 70%),
          linear-gradient(160deg, rgba(22, 17, 8, 0.6), rgba(8, 7, 5, 0.38));
        border-color: color-mix(in srgb, var(--hx-g2) 11%, transparent);
        box-shadow: inset 2px 0 0 color-mix(in srgb, var(--hx-g3) 75%, transparent), -6px 0 18px -12px color-mix(in srgb, var(--hx-g3) 70%, transparent), 0 10px 26px -18px rgba(0, 0, 0, 0.9);
      }
      .head { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; }
      .ic { width: 11px; height: 11px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; color: var(--hx-meta); flex: none; }
      :host([speaker="agent"]) .ic { color: var(--hx-g3); filter: drop-shadow(0 0 3px color-mix(in srgb, var(--hx-g3) 60%, transparent)); }
      .who { font: 700 10.5px/1 var(--hx-font-head); letter-spacing: 0.22em; text-transform: uppercase; color: var(--hx-meta); }
      :host([speaker="agent"]) .who { color: var(--hx-g4); }
      .time { margin-left: auto; padding-left: 10px; font: 400 9px/1 var(--hx-font-mono); letter-spacing: 0.06em; color: var(--hx-meta-dim); font-variant-numeric: tabular-nums; }
      .wave { display: inline-flex; align-items: center; gap: 1.5px; height: 11px; }
      .wave i { width: 1.5px; height: var(--h); border-radius: 1px; background: color-mix(in srgb, var(--hx-g3) 65%, transparent); transform-origin: center; }
      :host([live]) .wave i { animation: tm-wave 0.8s ease-in-out infinite alternate; animation-delay: calc(var(--i) * -110ms); }
      @keyframes tm-wave { to { transform: scaleY(0.35); } }
      .text { font: 400 13px/1.5 var(--hx-font-sans); color: rgba(236, 233, 226, 0.84); letter-spacing: 0.005em; overflow-wrap: anywhere; }
      :host([speaker="agent"]) .text { color: rgba(255, 246, 225, 0.95); }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "hud-corners": HudCorners;
    "status-indicator": StatusIndicator;
    "telemetry-label": TelemetryLabel;
    "orbital-ring": OrbitalRing;
    "voice-core": VoiceCore;
    "mic-reactor": MicReactor;
    "glow-button": GlowButton;
    "hud-capsule": HudCapsule;
    "pipeline-node": PipelineNode;
    "transcript-message": TranscriptMessage;
  }
}
