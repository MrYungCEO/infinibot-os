/**
 * Holographic Voice Terminal — the presentation layer over the original
 * stylesheet (session-styles.ts stays verbatim; this sheet is applied after it
 * and after the session view's own additions). REDESIGN_BRIEF.md: the same
 * regions and controls, borderless — floating content, partial framing,
 * smoked technical glass, champagne gold used as light on a near-black canvas.
 *
 * Type split: condensed uppercase for headings (--hx-font-head), monospace for
 * technical data and timestamps (--hx-font-mono), clean sans for conversation.
 * Z-depth: background haze → grid → dust → glass modules → HUD rings → blob →
 * controls. Desktop geometry is scoped to min-width 901px so the phone stack
 * in session-view.ts keeps working.
 */
import { css } from "lit";
import { holoTokens } from "./holo-primitives.js";

export const holoStyles = [
  holoTokens,
  css`
    :host {
      /* The original sheet maps its gold onto the theme primary; the holo
         terminal pins the champagne tiers (the blob keeps its own colours). */
      --gold-primary: var(--hx-g3);
      --gold-secondary: var(--hx-g2);
      --gold-dim: color-mix(in srgb, var(--hx-g2) 55%, transparent);
      --gold-glow: color-mix(in srgb, var(--hx-g3) 40%, transparent);
      --glass-border: color-mix(in srgb, var(--hx-g2) 16%, transparent);
      --success: var(--hx-ok);
      --warning: var(--hx-warn);
      --danger: var(--hx-bad);
      --text-primary: rgba(238, 234, 226, 0.92);
      --text-secondary: var(--hx-meta);
      --text-muted: var(--hx-meta-dim);
      --hud-accent: var(--hx-g3);
      /* The shell zooms <body> to 0.7 between 1101 and 1680px (viewport-scale.css);
         viewport units ignore that zoom, so divide it back out to keep the
         columns at ~21% of what the user actually sees. */
      --hx-vz: 1;
      --vc-left-width: clamp(272px, calc(21.5vw / var(--hx-vz)), 480px);
      --vc-right-width: clamp(268px, calc(20vw / var(--hx-vz)), 440px);
      color: var(--text-primary);
    }

    /* ── Canvas: no plate, no border — the near-black page is the surface ── */
    .hud-container {
      border: 0;
      border-radius: 0;
      box-shadow: none;
      background:
        radial-gradient(60% 55% at 50% 46%, rgba(214, 166, 42, 0.07) 0%, rgba(122, 88, 22, 0.025) 40%, transparent 70%),
        radial-gradient(40% 40% at 8% 4%, rgba(245, 200, 75, 0.035), transparent 70%),
        radial-gradient(40% 50% at 96% 96%, rgba(245, 200, 75, 0.03), transparent 70%),
        linear-gradient(180deg, var(--hx-ink-2) 0%, var(--hx-ink) 55%, var(--hx-ink-3) 100%);
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
    /* Faint grid + sparse gold dust (not a starfield): one fixed layer. */
    .hud-container::before {
      mix-blend-mode: normal;
      border-radius: 0;
      background:
        radial-gradient(1px 1px at 12% 22%, rgba(255, 228, 154, 0.5), transparent 60%),
        radial-gradient(1px 1px at 31% 71%, rgba(255, 228, 154, 0.35), transparent 60%),
        radial-gradient(1.5px 1.5px at 58% 13%, rgba(255, 228, 154, 0.4), transparent 60%),
        radial-gradient(1px 1px at 77% 63%, rgba(255, 228, 154, 0.35), transparent 60%),
        radial-gradient(1px 1px at 89% 28%, rgba(255, 228, 154, 0.3), transparent 60%),
        radial-gradient(1px 1px at 44% 88%, rgba(255, 228, 154, 0.3), transparent 60%),
        linear-gradient(rgba(214, 166, 42, 0.035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(214, 166, 42, 0.035) 1px, transparent 1px);
      background-size: 100% 100%, 100% 100%, 100% 100%, 100% 100%, 100% 100%, 100% 100%, 56px 56px, 56px 56px;
      -webkit-mask-image: radial-gradient(90% 85% at 50% 50%, #000 30%, transparent 100%);
      mask-image: radial-gradient(90% 85% at 50% 50%, #000 30%, transparent 100%);
    }
    @media (min-width: 1101px) and (max-width: 1680px) {
      :host { --hx-vz: var(--ui-viewport-zoom, 0.7); }
    }
    @media (min-width: 901px) {
      .hud-container { grid-template-rows: 56px minmax(0, 1fr) 104px; }
    }

    /* Whole-frame targeting marks: hairline, dim, only at the corners. */
    .hud-frame-corners .corner-mark { border-color: color-mix(in srgb, var(--hx-g2) 30%, transparent) !important; }

    /* ── Header: VOICE TERMINAL left · INFINI brand centre · clock/HUD/gear right ── */
    .hud-header { border-bottom: 0; position: relative; padding: 0 1.25rem; }
    .hud-header::after {
      content: ""; position: absolute; left: 12%; right: 12%; bottom: 0; height: 1px; pointer-events: none;
      background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--hx-g2) 26%, transparent) 30%, color-mix(in srgb, var(--hx-g3) 40%, transparent) 50%, color-mix(in srgb, var(--hx-g2) 26%, transparent) 70%, transparent);
    }
    .header-left { gap: 1.1rem; min-width: 0; }
    .system-title {
      font: 600 15px/1 var(--hx-font-head); letter-spacing: 0.24em; color: var(--hx-g4);
      text-shadow: 0 0 14px color-mix(in srgb, var(--hx-g3) 40%, transparent);
    }
    .system-title svg { color: var(--hx-g3); width: 16px; height: 16px; }
    .status-badge {
      gap: 7px; padding: 4px 10px; border-radius: 999px; font: 500 9px/1 var(--hx-font-mono); letter-spacing: 0.18em;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(0, 0, 0, 0.25));
      border: 1px solid rgba(255, 255, 255, 0.07); color: var(--hx-meta);
    }
    .status-badge.active { border-color: color-mix(in srgb, var(--hx-g2) 34%, transparent); color: var(--hx-g3); }
    .status-badge.live { border-color: color-mix(in srgb, var(--hx-ok) 40%, transparent); color: var(--hx-ok); }
    .status-badge:not(.live):not(.active) .status-dot { background: rgba(226, 222, 212, 0.3); }

    .hx-brand {
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
      display: flex; flex-direction: column; align-items: center; gap: 5px; pointer-events: none; white-space: nowrap;
    }
    .hx-brand-mark {
      display: flex; align-items: center; gap: 14px;
      font: 700 21px/1 var(--hx-font-head); letter-spacing: 0.5em; padding-left: 0.5em;
      background: linear-gradient(180deg, var(--hx-g5) 0%, var(--hx-g4) 35%, var(--hx-g3) 70%, var(--hx-g2) 100%);
      -webkit-background-clip: text; background-clip: text; color: transparent;
      filter: drop-shadow(0 0 10px color-mix(in srgb, var(--hx-g3) 45%, transparent));
    }
    .hx-brand-mark::before, .hx-brand-mark::after {
      content: ""; width: 46px; height: 1px; background: linear-gradient(90deg, transparent, var(--hx-g2));
    }
    .hx-brand-mark::after { background: linear-gradient(90deg, var(--hx-g2), transparent); }
    .hx-brand-sub { font: 500 8.5px/1 var(--hx-font-mono); letter-spacing: 0.42em; color: color-mix(in srgb, var(--hx-g3) 76%, transparent); padding-left: 0.42em; }

    .header-controls { align-items: center; gap: 10px; }
    .system-time {
      display: flex; align-items: baseline; gap: 8px;
      font: 400 15px/1 var(--hx-font-mono); letter-spacing: 0.14em; color: var(--hx-g4);
      text-shadow: 0 0 12px color-mix(in srgb, var(--hx-g3) 45%, transparent);
      padding-right: 6px; margin-right: 2px; position: relative;
    }
    .system-time::before { content: "SYS"; font-size: 8px; letter-spacing: 0.3em; color: var(--hx-meta-dim); text-shadow: none; }

    /* ── Dark glass capsules (HudCapsule): header + footer buttons, selects ── */
    .ctrl-btn,
    .vs-agent-select,
    .log-clear-btn,
    .vs-mini-btn {
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--hx-g2) 34%, transparent);
      background: linear-gradient(180deg, rgba(255, 243, 207, 0.05) 0%, rgba(8, 9, 11, 0.72) 48%, rgba(4, 5, 7, 0.82) 100%);
      box-shadow: inset 0 1px 0 rgba(255, 243, 207, 0.08), 0 8px 22px -14px rgba(0, 0, 0, 0.9);
      color: color-mix(in srgb, var(--hx-g4) 86%, transparent);
      font-family: var(--hx-font-head);
      font-weight: 600;
      letter-spacing: 0.2em;
      -webkit-backdrop-filter: blur(12px);
      backdrop-filter: blur(12px);
      transition: border-color 0.2s ease, box-shadow 0.2s ease, color 0.2s ease, transform 0.15s ease;
    }
    .ctrl-btn:hover:not(:disabled),
    .log-clear-btn:hover,
    .vs-mini-btn:hover:not(:disabled) {
      background: linear-gradient(180deg, rgba(255, 243, 207, 0.09) 0%, rgba(14, 12, 8, 0.78) 50%, rgba(4, 5, 7, 0.86) 100%);
      border-color: color-mix(in srgb, var(--hx-g3) 70%, transparent);
      color: var(--hx-g5);
      box-shadow: inset 0 1px 0 rgba(255, 243, 207, 0.12), 0 0 18px -6px color-mix(in srgb, var(--hx-g3) 60%, transparent);
    }
    .ctrl-btn:focus-visible, .vs-agent-select:focus-visible, .vc-pill:focus-visible, .mic-btn:focus-visible, .device-select:focus-visible, .log-clear-btn:focus-visible {
      outline: 1px solid var(--hx-g4); outline-offset: 3px;
    }
    .hud-header .ctrl-btn { height: 32px; padding: 0 14px; font-size: 11px; }
    .hud-header .ctrl-btn:not(.hud-toggle-btn) { width: 32px; padding: 0; }
    .hud-header .ctrl-btn svg { width: 14px; height: 14px; }
    .hud-toggle-btn.active { background: color-mix(in srgb, var(--hx-g3) 14%, rgba(4, 5, 7, 0.8)); border-color: var(--hx-g3); color: var(--hx-g5); box-shadow: 0 0 16px -4px var(--hx-g3); }

    /* ── Session pills (Connect / Mic / agent) float independently ── */
    .vc-floating-pills { top: 72px; gap: 12px; }
    .vc-pill {
      height: 34px; padding: 0 16px; gap: 9px;
      border: 1px solid color-mix(in srgb, var(--hx-g2) 36%, transparent);
      background: linear-gradient(180deg, rgba(255, 243, 207, 0.06) 0%, rgba(8, 9, 11, 0.7) 50%, rgba(4, 5, 7, 0.8) 100%);
      box-shadow: inset 0 1px 0 rgba(255, 243, 207, 0.09), 0 10px 26px -16px rgba(0, 0, 0, 0.95), 0 0 22px -14px color-mix(in srgb, var(--hx-g3) 70%, transparent);
      color: var(--hx-g4);
      font: 600 11.5px/1 var(--hx-font-head);
      letter-spacing: 0.2em;
      text-transform: uppercase;
    }
    .vc-pill:hover:not(:disabled) { border-color: color-mix(in srgb, var(--hx-g3) 72%, transparent); color: var(--hx-g5); }
    .vc-pill:disabled { cursor: not-allowed; }
    .vc-pill.is-live { border-color: color-mix(in srgb, var(--hx-g3) 62%, transparent); color: var(--hx-g5); }
    .vc-pill.is-live .vc-pill-dot { color: var(--hx-ok); }
    .vc-pill.is-off { border-color: color-mix(in srgb, var(--hx-bad) 45%, transparent); color: color-mix(in srgb, var(--hx-bad) 85%, white); }
    .vc-pill-dot { width: 6px; height: 6px; color: var(--hx-g3); opacity: 0.55; box-shadow: 0 0 6px currentColor; }
    .vc-pill--select { padding: 0 6px 0 14px; }
    .vc-pill--select select option, .vs-agent-select option { background: #07080a; color: #ece9e2; }

    /* ── LEFT: floating comms feed + system log (no card) ── */
    .panel-left { padding: 6px 4px 6px 14px; gap: 10px; }
    .vc-left-transcript, .vc-left-log { position: relative; }
    .vc-left-transcript {
      background: radial-gradient(120% 60% at 0% 0%, rgba(214, 166, 42, 0.05), transparent 65%), linear-gradient(180deg, rgba(10, 11, 13, 0.38), rgba(6, 7, 9, 0.1) 80%, transparent);
    }
    .panel-header { border-bottom: 0; position: relative; padding: 0.8rem 0.9rem 0.7rem; }
    .panel-header::after {
      content: ""; position: absolute; left: 0.9rem; width: 42%; bottom: 0; height: 1px;
      background: linear-gradient(90deg, color-mix(in srgb, var(--hx-g3) 45%, transparent), transparent);
    }
    .panel-title { font: 600 12px/1 var(--hx-font-head); letter-spacing: 0.28em; color: var(--hx-g4); }
    .panel-title svg { color: var(--hx-g3); opacity: 1; }
    .panel-badge {
      font: 500 9px/1 var(--hx-font-mono); letter-spacing: 0.08em; padding: 3px 7px; border-radius: 999px;
      color: var(--hx-g3); border: 1px solid color-mix(in srgb, var(--hx-g2) 28%, transparent); background: rgba(0, 0, 0, 0.35);
    }
    .vc-model-settings-btn { border-radius: 999px; }
    .transcript-content { padding: 0.9rem 0.85rem 1rem; --transcript-fade: 40px; --transcript-fade-b: 28px; }
    .empty-state span { font-family: var(--hx-font-sans); color: var(--hx-meta); }
    .empty-state svg { color: var(--hx-g3); opacity: 0.45; }

    .hx-convo-status {
      display: flex; align-items: center; gap: 10px; padding: 8px 0.9rem 10px;
      font: 500 9px/1 var(--hx-font-mono); letter-spacing: 0.26em; text-transform: uppercase; color: var(--hx-meta);
    }
    .hx-convo-status b { font: 400 13px/1 var(--hx-font-sans); color: var(--hx-g3); letter-spacing: 0; }
    .hx-convo-status.live { color: var(--hx-g3); }
    .hx-convo-wave { display: inline-flex; align-items: center; gap: 2px; height: 10px; margin-left: auto; }
    .hx-convo-wave i { width: 2px; height: 3px; border-radius: 1px; background: currentColor; opacity: 0.6; }
    .hx-convo-status.live .hx-convo-wave i { animation: hx-cw 0.9s ease-in-out infinite alternate; }
    .hx-convo-wave i:nth-child(2n) { animation-delay: -0.3s; }
    .hx-convo-wave i:nth-child(3n) { animation-delay: -0.6s; }
    @keyframes hx-cw { from { height: 2px; } to { height: 10px; } }

    .vc-left-splitter { flex: 0 0 1px; border: 0; background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--hx-g2) 22%, transparent), transparent); cursor: default; }
    .vc-left-splitter::after { display: none; }
    .vc-left-log { border-top: 0; background: linear-gradient(180deg, rgba(8, 9, 11, 0.32), rgba(6, 7, 9, 0.06)); }
    .log-section { background: transparent; }
    .log-header { border-bottom: 0; padding: 0.75rem 0.9rem 0.45rem; }
    .log-title { font: 600 11px/1 var(--hx-font-head); letter-spacing: 0.28em; color: var(--hx-g4); }
    .log-title svg { color: var(--hx-g3); }
    .log-clear-btn { height: 22px; padding: 0 10px; font-size: 9px; letter-spacing: 0.24em; }
    .log-content { padding: 0.2rem 0.9rem 0.8rem; font-family: var(--hx-font-mono); }
    .log-entry { padding: 3px 0; gap: 12px; font-size: 10.5px; line-height: 1.45; border: 0; background: transparent; }
    .log-entry:hover { background: transparent; }
    .log-time { color: var(--hx-meta); font-variant-numeric: tabular-nums; }
    .log-entry.info .log-text { color: var(--hx-g3); }
    .log-entry.system .log-text, .log-entry.success .log-text { color: var(--hx-ok); }
    .log-entry.warn .log-text { color: var(--hx-warn); }
    .log-entry.error .log-text { color: var(--hx-bad); }

    /* ── CENTRE: the blob dominates; HUD lives in <voice-core> ── */
    .vc-col-splitter, .vc-col-splitter:hover { background: transparent; cursor: default; }
    .vc-col-splitter::after { display: none; }
    .panel-center { background: transparent; container: hx-stage / inline-size; }
    .center-scanlines, .center-corners { display: none; }
    /* No centre vignette: it darkened the stage edges into a visible seam against the columns. */
    .center-vignette { display: none; }
    /* The legacy reticle/hairline around the blob gives way to <voice-core>'s instrument rings. */
    .hud-container:not(.live-action-on) .orb-container.webgl-mode::before,
    .hud-container:not(.live-action-on) .orb-container.webgl-mode::after { display: none; }
    @media (min-width: 901px) {
      .orb-container.webgl-mode {
        width: min(680px, calc(56vmin / var(--hx-vz)), calc(40vw / var(--hx-vz)));
        height: min(680px, calc(56vmin / var(--hx-vz)), calc(40vw / var(--hx-vz)));
      }
      .hud-container:not(.live-action-on) .panel-center .orb-container { top: 49% !important; }
    }
    .orb-status-label {
      font: 500 9px/1 var(--hx-font-mono); letter-spacing: 0.3em; color: var(--hx-g3); background: transparent; border: 0;
      text-shadow: 0 0 10px color-mix(in srgb, var(--hx-g3) 60%, transparent);
    }
    .blob-style-toggle { width: 22px; height: 22px; border: 1px solid color-mix(in srgb, var(--hx-g2) 45%, transparent); background: rgba(4, 5, 7, 0.75); box-shadow: 0 0 10px -3px var(--hx-g3); }
    .blob-style-dot { width: 8px; height: 8px; box-shadow: 0 0 6px var(--hx-g3); }
    .status-display {
      bottom: 14px; background: transparent; border: 0; padding: 0;
    }
    .status-text {
      font: 600 15px/1 var(--hx-font-head); letter-spacing: 0.5em; padding-left: 0.5em; color: var(--hx-g4);
      text-shadow: 0 0 18px color-mix(in srgb, var(--hx-g3) 55%, transparent);
    }
    .status-text.speaking { color: var(--hx-g5); }
    .status-text.thinking { color: var(--hx-g3); }
    .status-sub { font: 400 9.5px/1.4 var(--hx-font-mono); letter-spacing: 0.16em; color: var(--hx-meta-dim); margin-top: 7px; }

    /* ── RIGHT: floating modules (holo-panel frame="brackets") ── */
    .panel-right { border-left: 0; padding-right: 10px; }
    .panel-right .panel-header { padding-left: 0.75rem; }
    .panel-right .panel-header::after { left: 0.75rem; }
    .right-panel-collapse-btn { border-color: color-mix(in srgb, var(--hx-g2) 30%, transparent); color: var(--hx-g3); background: transparent; }
    .right-panel-collapse-btn svg { display: block; width: 12px; height: 12px; flex: none; stroke: var(--hx-g3); }
    .modules-section { padding: 0.5rem 0.25rem 1rem 0.75rem; scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--hx-g2) 25%, transparent) transparent; }
    holo-panel.module { display: block; margin-bottom: 14px; background: none; border: 0; border-radius: 0; overflow: visible; }
    .module-header { background: transparent; padding: 2px 0 8px; cursor: default; }
    .module-header:hover { background: transparent; }
    .module-title { font: 600 11px/1 var(--hx-font-head); letter-spacing: 0.26em; color: var(--hx-g4); }
    .module-title svg { color: var(--hx-g3); opacity: 0.9; }
    .module-content { padding: 0 0 2px; }
    .module-row { font-size: 10px; padding: 5px 0; border-bottom: 1px solid rgba(214, 166, 42, 0.05); gap: 10px; }
    .module-label { font: 500 9px/1.3 var(--hx-font-mono); letter-spacing: 0.16em; color: var(--hx-meta-dim); }
    .module-value { font: 500 10px/1.3 var(--hx-font-mono); color: rgba(238, 234, 226, 0.85); letter-spacing: 0.04em; }
    .module-value.gold { color: var(--hx-g3); }
    .module-value.hx-ready { color: var(--hx-ok); text-shadow: 0 0 10px color-mix(in srgb, var(--hx-ok) 50%, transparent); }
    .vs-live-module { padding: 0 0 4px; }

    .device-select {
      appearance: none; -webkit-appearance: none; width: 100%; height: 34px; margin-top: 6px; padding: 0 30px 0 12px;
      border-radius: 6px; border: 1px solid color-mix(in srgb, var(--hx-g2) 24%, transparent);
      background:
        linear-gradient(45deg, transparent 50%, var(--hx-g3) 50%) calc(100% - 15px) 50% / 5px 5px no-repeat,
        linear-gradient(135deg, var(--hx-g3) 50%, transparent 50%) calc(100% - 10px) 50% / 5px 5px no-repeat,
        linear-gradient(180deg, rgba(255, 243, 207, 0.035), rgba(4, 5, 7, 0.8));
      box-shadow: inset 0 1px 0 rgba(255, 243, 207, 0.05);
      color: rgba(238, 234, 226, 0.9); font: 400 11px/1 var(--hx-font-sans); cursor: pointer;
    }
    .device-select:hover:not(:disabled) { border-color: color-mix(in srgb, var(--hx-g3) 55%, transparent); }
    .device-select option { background: #07080a; color: #ece9e2; }

    /* Volume: thin gold energy track, illuminated trail, glowing handle. */
    .vs-volume { -webkit-appearance: none; appearance: none; height: 18px; background: transparent; }
    .vs-volume::-webkit-slider-runnable-track {
      height: 2px; border-radius: 2px;
      background: linear-gradient(90deg, var(--hx-g2), var(--hx-g4) var(--pct, 100%), rgba(214, 166, 42, 0.14) var(--pct, 100%));
      box-shadow: 0 0 8px -1px color-mix(in srgb, var(--hx-g3) 60%, transparent);
    }
    .vs-volume::-moz-range-track { height: 2px; background: rgba(214, 166, 42, 0.14); }
    .vs-volume::-moz-range-progress { height: 2px; background: linear-gradient(90deg, var(--hx-g2), var(--hx-g4)); }
    .vs-volume::-webkit-slider-thumb {
      -webkit-appearance: none; width: 13px; height: 13px; margin-top: -5.5px; border-radius: 50%;
      background: radial-gradient(circle at 50% 40%, var(--hx-g5), var(--hx-g3) 55%, var(--hx-g1));
      border: 1px solid var(--hx-g4); box-shadow: 0 0 0 3px rgba(245, 200, 75, 0.12), 0 0 12px var(--hx-g3);
    }
    .vs-volume::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: var(--hx-g4); border: 1px solid var(--hx-g5); box-shadow: 0 0 12px var(--hx-g3); }
    .vs-mini-btn { height: 30px; min-height: 30px; font-size: 10px; letter-spacing: 0.2em; border-radius: 999px; }
    .vs-toggle-row { font-family: var(--hx-font-sans); font-size: 11px; color: var(--hx-meta); }
    .vs-link-btn { color: var(--hx-g3); font-family: var(--hx-font-mono); font-size: 10px; }
    .mic-bar { background: color-mix(in srgb, var(--hx-g2) 30%, transparent); }
    .mic-bar.active { background: var(--hx-g3); box-shadow: 0 0 6px color-mix(in srgb, var(--hx-g3) 60%, transparent); }
    .mic-bar.high, .mic-bar.peak { background: var(--hx-g4); }

    /* ── FOOTER: controls float individually — no bar ── */
    .hud-footer { border-top: 0; background: transparent; gap: 18px; padding: 0 2rem 16px; }
    .hud-footer .divider { width: 28px; height: 1px; margin: 0; background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--hx-g2) 40%, transparent), transparent); }
    .hud-footer .control-group { gap: 12px; }
    .hud-footer .ctrl-btn { height: 40px; padding: 0 22px; font-size: 12px; }
    .hud-footer .ctrl-btn svg { color: var(--hx-g3); }
    .vs-agent-select {
      height: 40px; padding: 0 34px 0 18px; font-size: 12px; text-transform: uppercase; max-width: 260px;
      background:
        linear-gradient(45deg, transparent 50%, var(--hx-g3) 50%) calc(100% - 19px) 55% / 4px 4px no-repeat,
        linear-gradient(135deg, var(--hx-g3) 50%, transparent 50%) calc(100% - 15px) 55% / 4px 4px no-repeat,
        linear-gradient(180deg, rgba(255, 243, 207, 0.05) 0%, rgba(8, 9, 11, 0.72) 48%, rgba(4, 5, 7, 0.82) 100%);
    }
    .vs-agent-select:hover:not(:disabled) { border-color: color-mix(in srgb, var(--hx-g3) 70%, transparent); color: var(--hx-g5); }
    .vs-agent-select:disabled { opacity: 0.6; cursor: default; }

    /* CONNECT (GlowButton): the strongest CTA — illuminated champagne glass. */
    .ctrl-btn.primary {
      height: 42px; padding: 0 30px; font-size: 13px; letter-spacing: 0.32em; color: #1c1405; font-weight: 700;
      border: 1px solid var(--hx-g5);
      background:
        linear-gradient(180deg, rgba(255, 249, 232, 0.95) 0%, var(--hx-g4) 30%, var(--hx-g3) 62%, var(--hx-g2) 100%);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.8),
        inset -10px 0 14px -10px color-mix(in srgb, var(--hx-rose) 70%, transparent),
        0 0 0 1px rgba(122, 88, 22, 0.5),
        0 0 26px -4px color-mix(in srgb, var(--hx-g3) 75%, transparent),
        0 14px 30px -16px rgba(0, 0, 0, 0.9);
      text-shadow: 0 1px 0 rgba(255, 243, 207, 0.6);
    }
    .ctrl-btn.primary:hover:not(:disabled) {
      color: #120c02; border-color: #fff;
      background: linear-gradient(180deg, #fffaf0 0%, var(--hx-g5) 30%, var(--hx-g4) 62%, var(--hx-g3) 100%);
      box-shadow: inset 0 1px 0 #fff, inset -10px 0 14px -10px color-mix(in srgb, var(--hx-rose) 80%, transparent), 0 0 34px -2px var(--hx-g3), 0 14px 30px -16px rgba(0, 0, 0, 0.9);
    }
    .ctrl-btn.primary:disabled { opacity: 0.5; filter: saturate(0.6); }
    .ctrl-btn.danger { height: 42px; padding: 0 26px; border-color: color-mix(in srgb, var(--hx-bad) 60%, transparent); color: color-mix(in srgb, var(--hx-bad) 55%, white); letter-spacing: 0.26em; }
    .ctrl-btn.danger:hover:not(:disabled) { border-color: var(--hx-bad); color: #fff; box-shadow: 0 0 20px -6px var(--hx-bad); }

    /* MICROPHONE (MicReactor): dark core, luminous glyph. */
    .mic-btn-wrapper { margin: 0 6px; }
    .mic-btn {
      width: 54px; height: 54px; border: 1px solid color-mix(in srgb, var(--hx-g3) 55%, transparent); color: var(--hx-g5);
      background: radial-gradient(circle at 50% 35%, rgba(255, 243, 207, 0.16), rgba(20, 15, 6, 0.92) 62%, rgba(4, 5, 7, 0.96));
      box-shadow: inset 0 0 14px color-mix(in srgb, var(--hx-g3) 22%, transparent), 0 0 18px -4px color-mix(in srgb, var(--hx-g3) 60%, transparent);
    }
    .mic-btn svg { filter: drop-shadow(0 0 5px var(--hx-g3)); }
    .mic-btn:hover:not(:disabled) { transform: scale(1.05); box-shadow: inset 0 0 18px color-mix(in srgb, var(--hx-g3) 32%, transparent), 0 0 28px -2px var(--hx-g3); }
    .mic-btn:disabled { cursor: not-allowed; opacity: 1; color: color-mix(in srgb, var(--hx-g4) 70%, transparent); }
    .mic-btn.muted { background: radial-gradient(circle at 50% 35%, rgba(255, 107, 107, 0.14), rgba(20, 6, 6, 0.94) 62%); border-color: color-mix(in srgb, var(--hx-bad) 60%, transparent); color: color-mix(in srgb, var(--hx-bad) 80%, white); box-shadow: 0 0 16px -4px var(--hx-bad); }
    .mic-btn.muted svg { filter: none; }
    .mic-label { bottom: -8px; font: 500 8px/1 var(--hx-font-mono); letter-spacing: 0.3em; color: var(--hx-g3); }

    /* Notices / faults keep their semantics, in the terminal's glass. */
    .vs-notice { border-radius: 10px; background: linear-gradient(180deg, rgba(255, 243, 207, 0.05), rgba(4, 5, 7, 0.86)); font-family: var(--hx-font-sans); }

    /* ═══════════════════════════════════════════════════════════
       NEUTRALISE THE BOXED THEME LAYER
       The original sheet's late "single plane / instrument card" block
       (.hud-container:not(.live-action-on) …, many !important) frames every
       region in a bordered card. The holo terminal scopes itself with
       .hx-holo and wins on specificity + !important where those rules do.
       ═══════════════════════════════════════════════════════════ */
    .hud-container.hx-holo:not(.live-action-on) {
      border: 0 !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      background:
        radial-gradient(60% 55% at 50% 46%, rgba(214, 166, 42, 0.07) 0%, rgba(122, 88, 22, 0.025) 40%, transparent 70%),
        radial-gradient(40% 40% at 8% 4%, rgba(245, 200, 75, 0.035), transparent 70%),
        radial-gradient(40% 50% at 96% 96%, rgba(245, 200, 75, 0.03), transparent 70%),
        linear-gradient(180deg, var(--hx-ink-2) 0%, var(--hx-ink) 55%, var(--hx-ink-3) 100%) !important;
    }
    .hud-container.hx-holo:not(.live-action-on)::after { display: none; }
    .hud-container.hx-holo:not(.live-action-on) > .hud-frame-corners .corner-mark { width: 22px; height: 22px; border-width: 1px; filter: none; }

    .hud-container.hx-holo:not(.live-action-on) .panel-left, .hud-container.hx-holo:not(.live-action-on) .panel-right {
      background: transparent !important; border: none !important; box-shadow: none !important;
      backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
    }
    .hud-container.hx-holo:not(.live-action-on) .panel-left::before { background: none; }
    .hud-container.hx-holo:not(.live-action-on) .panel-right::before { background: linear-gradient(270deg, rgba(2, 3, 4, 0.5) 0%, rgba(2, 3, 4, 0.2) 60%, transparent 100%); }
    .hud-container.hx-holo:not(.live-action-on) .panel-left::after, .hud-container.hx-holo:not(.live-action-on) .panel-right::after { display: none; }

    .hud-container.hx-holo:not(.live-action-on) .hud-header, .hud-container.hx-holo:not(.live-action-on) .hud-footer {
      background: transparent !important; border-top: 0 !important; border-bottom: 0 !important;
      box-shadow: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
    }
    .hud-container.hx-holo:not(.live-action-on) .hud-header .system-title { color: var(--hx-g4); text-shadow: 0 0 14px color-mix(in srgb, var(--hx-g3) 40%, transparent); font-family: var(--hx-font-head); letter-spacing: 0.24em; }
    .hud-container.hx-holo:not(.live-action-on) .hud-header span.hx-brand-sub, .hud-container.hx-holo:not(.live-action-on) .hud-header .hx-brand-mark { font-family: inherit; }
    .hud-container.hx-holo:not(.live-action-on) .hud-header .hx-brand-mark { font-family: var(--hx-font-head); letter-spacing: 0.5em; }
    .hud-container.hx-holo:not(.live-action-on) .hud-header .hx-brand-sub { font-family: var(--hx-font-mono); letter-spacing: 0.42em; }

    .hud-container.hx-holo:not(.live-action-on) .panel-header {
      background: transparent !important; border-bottom: 0 !important; box-shadow: none !important;
    }
    .hud-container.hx-holo:not(.live-action-on) .panel-header::after, .hud-container.hx-holo:not(.live-action-on) .vc-left-transcript > .panel-header::after {
      content: ""; position: absolute; left: 0.9rem; right: auto; width: 42%; bottom: 0; height: 1px; opacity: 1;
      background: linear-gradient(90deg, color-mix(in srgb, var(--hx-g3) 45%, transparent), transparent);
    }
    .hud-container.hx-holo:not(.live-action-on) .panel-header .panel-title, .hud-container.hx-holo:not(.live-action-on) .panel-header .panel-title span {
      font: 600 12px/1 var(--hx-font-head); letter-spacing: 0.28em; color: var(--hx-g4);
      text-shadow: 0 0 10px color-mix(in srgb, var(--hx-g3) 35%, transparent);
    }
    .hud-container.hx-holo:not(.live-action-on) .panel-badge {
      padding: 3px 7px; border: 1px solid color-mix(in srgb, var(--hx-g2) 28%, transparent); background: rgba(0, 0, 0, 0.35);
      backdrop-filter: none; box-shadow: none; color: var(--hx-g3); font: 500 9px/1 var(--hx-font-mono);
    }

    .hud-container.hx-holo:not(.live-action-on) .vc-left-log {
      margin: 0; height: var(--vc-left-split, 240px); border: 0 !important; border-radius: 0;
      background: linear-gradient(180deg, rgba(8, 9, 11, 0.32), rgba(6, 7, 9, 0.06)) !important;
      box-shadow: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
      font-family: var(--hx-font-mono);
    }
    .hud-container.hx-holo:not(.live-action-on) .vc-left-log::before, .hud-container.hx-holo:not(.live-action-on) .vc-left-log::after, .hud-container.hx-holo:not(.live-action-on) .vc-left-log .log-content::before { display: none; }
    .hud-container.hx-holo:not(.live-action-on) .vc-left-log .log-content { padding: 0.2rem 0.9rem 0.8rem !important; }

    .hud-container.hx-holo:not(.live-action-on) .vc-col-splitter, .hud-container.hx-holo:not(.live-action-on) .vc-left-splitter { box-shadow: none; }
    .hud-container.hx-holo:not(.live-action-on) .vc-col-splitter { background: transparent; }
    .hud-container.hx-holo:not(.live-action-on) .vc-left-splitter { background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--hx-g2) 22%, transparent), transparent); }
    .hud-container.hx-holo:not(.live-action-on) .divider { box-shadow: none; background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--hx-g2) 40%, transparent), transparent); }

    .hud-container.hx-holo:not(.live-action-on) .panel-right .modules-section { padding: 0.5rem 0.25rem 1rem 0.75rem !important; }
    .hud-container.hx-holo:not(.live-action-on) .module {
      background: none !important; border: 0 !important; border-radius: 0 !important; box-shadow: none !important;
      backdrop-filter: none !important; -webkit-backdrop-filter: none !important; overflow: visible;
    }
    .hud-container.hx-holo:not(.live-action-on) .module::before, .hud-container.hx-holo:not(.live-action-on) .module::after { display: none; }
    .hud-container.hx-holo:not(.live-action-on) .module-header { background: transparent !important; border-bottom: 0 !important; }
    .hud-container.hx-holo:not(.live-action-on) .module-title { color: var(--hx-g4) !important; font-family: var(--hx-font-head); letter-spacing: 0.26em; text-shadow: 0 0 10px color-mix(in srgb, var(--hx-g3) 35%, transparent); }
    .hud-container.hx-holo:not(.live-action-on) .module-row { border-bottom: 1px solid rgba(214, 166, 42, 0.05) !important; }
    .hud-container.hx-holo:not(.live-action-on) .module-label { color: var(--hx-meta) !important; font: 500 9px/1.3 var(--hx-font-mono); }
    .hud-container.hx-holo:not(.live-action-on) .module-value { color: rgba(238, 234, 226, 0.85) !important; font-family: var(--hx-font-mono); text-shadow: none; }
    .hud-container.hx-holo:not(.live-action-on) .module-value.gold { color: var(--hx-g3) !important; }
    .hud-container.hx-holo:not(.live-action-on) .module-value.slow { color: var(--hx-warn) !important; }
    .hud-container.hx-holo:not(.live-action-on) .module-value.hx-ready { color: var(--hx-ok) !important; text-shadow: 0 0 10px color-mix(in srgb, var(--hx-ok) 50%, transparent); }

    .hud-container.hx-holo:not(.live-action-on) .status-badge {
      padding: 4px 10px; border: 1px solid rgba(255, 255, 255, 0.07); backdrop-filter: none; -webkit-backdrop-filter: none;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(0, 0, 0, 0.25)); box-shadow: none;
    }
    .hud-container.hx-holo:not(.live-action-on) .status-badge.active { border-color: color-mix(in srgb, var(--hx-g2) 34%, transparent); box-shadow: none; }
    .hud-container.hx-holo:not(.live-action-on) .status-badge.live { border-color: color-mix(in srgb, var(--hx-ok) 40%, transparent); box-shadow: 0 0 14px -6px var(--hx-ok); }

    .hud-container.hx-holo:not(.live-action-on) .status-text { color: var(--hx-g4) !important; letter-spacing: 0.5em !important; text-shadow: 0 0 18px color-mix(in srgb, var(--hx-g3) 55%, transparent) !important; font-family: var(--hx-font-head); }
    .hud-container.hx-holo:not(.live-action-on) .status-text.speaking { color: var(--hx-g5) !important; }
    .hud-container.hx-holo:not(.live-action-on) .status-sub { color: var(--hx-meta) !important; letter-spacing: 0.16em !important; font-family: var(--hx-font-mono); }

    /* Capsule controls (HudCapsule) — re-asserted over the theme's !important glass. */
    .hud-container.hx-holo:not(.live-action-on) .ctrl-btn {
      border: 1px solid color-mix(in srgb, var(--hx-g2) 34%, transparent) !important;
      background: linear-gradient(180deg, rgba(255, 243, 207, 0.05) 0%, rgba(8, 9, 11, 0.72) 48%, rgba(4, 5, 7, 0.82) 100%) !important;
      box-shadow: inset 0 1px 0 rgba(255, 243, 207, 0.08), 0 8px 22px -14px rgba(0, 0, 0, 0.9);
      border-radius: 999px; color: color-mix(in srgb, var(--hx-g4) 86%, transparent);
    }
    .hud-container.hx-holo:not(.live-action-on) .ctrl-btn:hover:not(:disabled) {
      transform: none; border-color: color-mix(in srgb, var(--hx-g3) 70%, transparent) !important; color: var(--hx-g5);
      box-shadow: inset 0 1px 0 rgba(255, 243, 207, 0.12), 0 0 18px -6px color-mix(in srgb, var(--hx-g3) 60%, transparent);
    }
    .hud-container.hx-holo:not(.live-action-on) .ctrl-btn.active {
      border-color: var(--hx-g3) !important; color: var(--hx-g5);
      background: linear-gradient(180deg, rgba(255, 228, 154, 0.16), rgba(14, 12, 8, 0.8)) !important;
      box-shadow: 0 0 16px -4px var(--hx-g3);
    }
    .hud-container.hx-holo:not(.live-action-on) .ctrl-btn.primary {
      color: #1c1405; border: 1px solid var(--hx-g5) !important;
      background: linear-gradient(180deg, rgba(255, 249, 232, 0.95) 0%, var(--hx-g4) 30%, var(--hx-g3) 62%, var(--hx-g2) 100%) !important;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.8),
        inset -10px 0 14px -10px color-mix(in srgb, var(--hx-rose) 70%, transparent),
        0 0 0 1px rgba(122, 88, 22, 0.5),
        0 0 26px -4px color-mix(in srgb, var(--hx-g3) 75%, transparent),
        0 14px 30px -16px rgba(0, 0, 0, 0.9);
    }
    .hud-container.hx-holo:not(.live-action-on) .ctrl-btn.primary:hover:not(:disabled) {
      color: #120c02; border-color: #fff !important;
      background: linear-gradient(180deg, #fffaf0 0%, var(--hx-g5) 30%, var(--hx-g4) 62%, var(--hx-g3) 100%) !important;
      box-shadow: inset 0 1px 0 #fff, inset -10px 0 14px -10px color-mix(in srgb, var(--hx-rose) 80%, transparent), 0 0 34px -2px var(--hx-g3), 0 14px 30px -16px rgba(0, 0, 0, 0.9);
    }
    .hud-container.hx-holo:not(.live-action-on) .ctrl-btn.danger { border-color: color-mix(in srgb, var(--hx-bad) 60%, transparent) !important; color: color-mix(in srgb, var(--hx-bad) 55%, white); }
    .hud-container.hx-holo:not(.live-action-on) .ctrl-btn.danger:hover:not(:disabled) { border-color: var(--hx-bad) !important; color: #fff; box-shadow: 0 0 20px -6px var(--hx-bad); }
    .hud-container.hx-holo:not(.live-action-on) .hud-header .ctrl-btn { padding: 0 14px; }
    .hud-container.hx-holo:not(.live-action-on) .hud-header .ctrl-btn:not(.hud-toggle-btn) { padding: 0; }
    .hud-container.hx-holo:not(.live-action-on) .right-panel-collapse-btn { background: transparent; border-color: color-mix(in srgb, var(--hx-g2) 30%, transparent); box-shadow: none; backdrop-filter: none; }

    /* ── Mid desktops: keep everything legible as columns narrow ── */
    @media (min-width: 901px) and (max-width: 1280px) {
      .hx-brand-sub { display: none; }
      .hx-brand-mark { font-size: 17px; }
      .hx-brand-mark::before, .hx-brand-mark::after { width: 22px; }
      .system-time::before { display: none; }
      .hud-footer { gap: 12px; padding: 0 1rem 6px; }
      .hud-footer .ctrl-btn { padding: 0 16px; }
    }
    @media (max-width: 1100px) {
      .hx-brand { display: none; }
    }

    /* ── Phone stack (session-view.ts reflows the grid at ≤900px) ── */
    @media (max-width: 900px) {
      .hud-container { grid-template-rows: auto minmax(360px, 52vh) auto minmax(320px, auto) auto; }
      .system-time { display: none; }
      .hud-header { padding: 8px 0.75rem; flex-wrap: wrap; row-gap: 8px; min-height: 52px; }
      .header-left { gap: 0.6rem; flex-wrap: wrap; row-gap: 6px; }
      .system-title { font-size: 12px; letter-spacing: 0.16em; white-space: nowrap; }
      .status-badge { padding: 4px 7px; letter-spacing: 0.12em; }
      .hud-header .ctrl-btn.hud-toggle-btn { padding: 0 10px; }
      .panel-left { padding: 6px 10px; }
      .panel-right { padding: 0 6px; }
      .hud-footer { padding: 12px 8px 18px; gap: 10px; }
      .hud-footer .ctrl-btn { padding: 0 16px; }
      /* Stacked: the conversation gets real room; the log sits under it. */
      .panel-left { min-height: 560px; }
      .vc-left-transcript { min-height: 320px; }
      .hud-container.hx-holo:not(.live-action-on) .vc-left-log { height: 220px; }
      /* The header wraps to its content here, so the session pills join the
         flow at the top of the stage instead of a fixed offset that could
         land on the header's controls. */
      .vc-floating-pills {
        position: relative; top: auto; left: auto; transform: none;
        grid-area: center; align-self: start; justify-self: center; margin-top: 12px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .hx-convo-wave i { animation: none !important; }
    }
  `,
];
