/**
 * Voice session styles — the ORIGINAL Voice terminal stylesheet (voice-chat.ts
 * static styles at 37d5b15a), carried over verbatim so the Robovoice-backed
 * session view looks exactly like the page it replaces. Do not restyle here.
 */
import { css } from "lit";

export const sessionStyles = css`
    :host {
      display: block;
      height: 100%;
      width: 100%;
      background: transparent;
      color: var(--g-fg, #e0e0e0);
      font-family: var(--g-font-family, 'JetBrains Mono', 'Fira Code', 'SF Mono', monospace);
      position: relative;
      overflow: hidden;

      /* Map legacy local tokens onto the --g-* design system so palette/theme
         changes from the Appearance page cascade into the voice terminal.
         Status colors stay hardcoded (semantic, not brand). */
      --gold-primary: var(--g-primary);
      --gold-secondary: var(--g-accent, #DAA520);
      --gold-dim: color-mix(in srgb, var(--g-primary) 55%, transparent);
      --gold-glow: color-mix(in srgb, var(--g-primary) 40%, transparent);
      --glass-bg: var(--g-surface);
      --glass-border: var(--g-border);
      --glass-highlight: var(--g-surface-hover);
      --success: #00ff88;
      --warning: #ffaa00;
      --danger: #ff4444;
      --text-primary: var(--g-fg);
      --text-secondary: var(--g-fg-dim);
      --text-muted: var(--g-fg-faint);

      /* Resizable left split — bottom (log) panel height. Drag-bar writes
         this on :host inline-style; the value persists to localStorage. */
      --vc-left-split: 240px;
    }

    /* ═══════════════════════════════════════════════════════════
       MAIN LAYOUT - Video-Centric Design

       The whole HUD is ONE glass-morphism plate floating on the
       dynamic theme background. Internal panels (header / left /
       center / right / footer) are transparent and use hairline
       dividers — no per-panel surfaces.
       ═══════════════════════════════════════════════════════════ */
    .hud-container {
      display: grid;
      grid-template-columns: var(--vc-left-width, 440px) 6px 1fr var(--vc-right-width, 300px);
      grid-template-rows: 52px 1fr 68px;
      grid-template-areas:
        "header header  header header"
        "left   colsep  center right"
        "footer footer  footer footer";
      height: 100%;
      position: relative;
      isolation: isolate;
      overflow: hidden;
      border-radius: var(--g-radius-lg, 20px);
      border: 1px solid var(--g-glass-border, var(--glass-border));
      background:
        linear-gradient(var(--g-glass-tint, transparent), var(--g-glass-tint, transparent)),
        var(--g-gradient-surface,
          linear-gradient(160deg,
            rgba(255, 255, 255, 0.06) 0%,
            rgba(255, 255, 255, 0.02) 45%,
            rgba(0, 0, 0, 0.30) 100%));
      backdrop-filter: var(--g-blur-heavy, blur(28px) saturate(180%));
      -webkit-backdrop-filter: var(--g-blur-heavy, blur(28px) saturate(180%));
      box-shadow:
        0 1px 4px rgba(0, 0, 0, 0.18),
        var(--g-shadow, 0 12px 40px rgba(0, 0, 0, 0.35)),
        0 28px 64px rgba(0, 0, 0, 0.32),
        inset 0 1px 0 var(--g-edge-light, rgba(255, 255, 255, 0.10)),
        inset 0 -1px 0 var(--g-edge-shadow, rgba(0, 0, 0, 0.35)),
        inset 0 0 0 1px rgba(255, 255, 255, 0.02);
      transition: grid-template-columns 360ms cubic-bezier(0.22, 1, 0.36, 1),
                  grid-template-rows 360ms cubic-bezier(0.22, 1, 0.36, 1);
    }

    /* Top specular glare arc — same vocabulary as global .glass-panel. */
    .hud-container::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      pointer-events: none;
      z-index: 0;
      background:
        radial-gradient(ellipse 55% 30% at 50% -10%,
          var(--g-edge-light, rgba(255, 255, 255, 0.10)),
          transparent 60%),
        linear-gradient(135deg, rgba(255, 255, 255, 0.04), transparent 50%);
      mix-blend-mode: screen;
    }
    .hud-container > * { position: relative; z-index: 1; }

    /* ═══════════════════════════════════════════════════════════
       LIVE ACTION MODE — slim sidebar layout
       When liveActionMode is on the element is mounted inside the
       app shell's .live-action-voice-host wrapper (360px wide,
       fixed to the right edge). Inside that host we collapse the
       full HUD to just:
         1) a top "voice bar" hosting the animated orb + status
         2) a scrollable transcript with the Claude Code toggle
       Everything else (System modules panel, hud-header, hud-footer,
       video feed, HUD overlays, log split) is hidden.

       These rules live inside the component's shadow DOM styles —
       the app shell's global stylesheet can't pierce shadow DOM,
       so light-DOM descendant selectors targeting these classes
       would never apply.
       ═══════════════════════════════════════════════════════════ */
    .hud-container.live-action-on {
      display: flex !important;
      flex-direction: column !important;
      grid-template: none !important;
      width: 100%;
      height: 100%;
      /* Layered base: a vertical gradient + low-opacity primary tint +
         heavy backdrop blur gives the sidebar real depth without going
         opaque. We rely on the host wrapper for the deeper background;
         this layer adds the glass sheen on top. */
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--g-primary, #caa45a) 5%, transparent) 0%,
          rgba(0,0,0,0) 60%),
        linear-gradient(180deg,
          color-mix(in srgb, #000 30%, transparent) 0%,
          color-mix(in srgb, #000 55%, transparent) 100%);
      backdrop-filter: var(--g-blur-heavy, blur(24px) saturate(160%));
      -webkit-backdrop-filter: var(--g-blur-heavy, blur(24px) saturate(160%));
      box-shadow:
        inset 1px 0 0 color-mix(in srgb, var(--g-primary, #caa45a) 22%, transparent),
        inset 0 1px 0 rgba(255,255,255,0.04);
    }

    /* Strip the chrome we don't want in the slim sidebar. The footer
       stays visible — Connect / mic are essential. */
    .hud-container.live-action-on .hud-header,
    .hud-container.live-action-on .panel-right,
    .hud-container.live-action-on .video-container,
    .hud-container.live-action-on .video-overlay {
      display: none !important;
    }

    /* ── TOP: VOICE BAR (glassy floating tile) ──────────────────
       .panel-center becomes a 196px tall glass tile hosting only
       the animated orb + status. We layer a primary-tinted radial
       glow over a dark glass surface with a soft inner highlight
       and a depth-cast shadow on the bottom edge — same vocabulary
       as .glass-panel elsewhere in the app. */
    .hud-container.live-action-on .panel-center {
      flex: 0 0 auto;
      height: 196px;
      min-height: 196px;
      width: 100%;
      grid-area: unset;
      margin: 10px 10px 0 10px;
      border-radius: 14px;
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 18%, var(--glass-border));
      background:
        radial-gradient(ellipse at 50% 58%,
          color-mix(in srgb, var(--g-primary, #caa45a) 14%, transparent) 0%,
          rgba(0,0,0,0) 65%),
        linear-gradient(160deg,
          rgba(255,255,255,0.05) 0%,
          rgba(255,255,255,0.01) 38%,
          rgba(0,0,0,0.35) 100%),
        rgba(8, 8, 10, 0.55);
      backdrop-filter: var(--g-blur-heavy, blur(20px) saturate(150%));
      -webkit-backdrop-filter: var(--g-blur-heavy, blur(20px) saturate(150%));
      box-shadow:
        0 8px 24px rgba(0,0,0,0.45),
        inset 0 1px 0 rgba(255,255,255,0.08),
        inset 0 0 0 1px color-mix(in srgb, var(--g-primary, #caa45a) 6%, transparent);
      position: relative;
      overflow: hidden;
    }
    /* Faint scanline sheen — adds the techy depth without competing
       with the orb. Sits behind the orb-container via z-index. */
    .hud-container.live-action-on .panel-center::before {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: repeating-linear-gradient(
        180deg,
        rgba(255,255,255,0.025) 0px,
        rgba(255,255,255,0.025) 1px,
        transparent 1px,
        transparent 3px
      );
      mix-blend-mode: overlay;
      opacity: 0.5;
      z-index: 1;
    }
    .hud-container.live-action-on .panel-center .center-video-wrapper,
    .hud-container.live-action-on .panel-center .video-hud-overlay,
    .hud-container.live-action-on .panel-center .no-camera-prompt,
    .hud-container.live-action-on .panel-center .center-corners,
    .hud-container.live-action-on .panel-center .center-reticle,
    .hud-container.live-action-on .panel-center .center-live-badge,
    .hud-container.live-action-on .panel-center .center-frame-counter,
    .hud-container.live-action-on .panel-center .grid-bg {
      display: none !important;
    }
    /* Orb-container is 320x320 absolute-centered by default — way
       bigger than our ~340x196 tile. Reflow it to fill the tile so
       its inner flex centers the orb; shrink the orb so rings and
       sound waves stay inside. z-index lifts it above the scanline. */
    .hud-container.live-action-on .panel-center .orb-container {
      position: absolute;
      inset: 0;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      transform: none;
      opacity: 1;
      z-index: 2;
    }
    .hud-container.live-action-on .panel-center .orb {
      width: 88px;
      height: 88px;
    }
    .hud-container.live-action-on .panel-center .orb.speaking {
      width: 108px;
      height: 108px;
    }
    .hud-container.live-action-on .panel-center .status-display {
      bottom: 10px;
      padding: 5px 14px;
      background: rgba(0,0,0,0.55);
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 18%, var(--glass-border));
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      z-index: 3;
    }
    .hud-container.live-action-on .panel-center .status-text {
      font-size: 0.72rem;
      letter-spacing: 2.5px;
    }
    .hud-container.live-action-on .panel-center .status-sub {
      display: none;
    }

    /* ── Live Action chat composer (text + image into voice session) ──
       Hidden by default. Shows as its own glass tile under the voice bar
       *only* when Live Action mode is on, so the orb never has to share
       its space and the composer reads as a sibling input strip. */
    .live-chat-composer { display: none; }
    .hud-container.live-action-on .live-chat-composer {
      display: flex;
      flex: 0 0 auto;
      flex-direction: column;
      gap: 6px;
      margin: 8px 10px 0 10px;
      padding: 9px 10px;
      border-radius: 14px;
      background:
        linear-gradient(135deg,
          color-mix(in srgb, var(--g-primary, #caa45a) 7%, transparent),
          transparent 60%),
        linear-gradient(180deg,
          color-mix(in srgb, #fff 3%, transparent),
          color-mix(in srgb, #000 40%, transparent));
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 22%, transparent);
      box-shadow:
        inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent),
        0 10px 24px rgba(0, 0, 0, 0.42);
      backdrop-filter: blur(16px) saturate(160%);
      -webkit-backdrop-filter: blur(16px) saturate(160%);
      box-sizing: border-box;
      position: relative;
      z-index: 4;
    }
    .hud-container.live-action-on .live-chat-composer.is-idle { opacity: 0.78; }
    .lcc-attachments {
      display: flex; flex-wrap: wrap; gap: 6px;
      padding: 4px 2px;
    }
    .lcc-att {
      position: relative;
      width: 44px; height: 44px;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid color-mix(in srgb, var(--g-primary) 28%, transparent);
      background: color-mix(in srgb, #000 50%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 10%, transparent);
    }
    .lcc-att img {
      width: 100%; height: 100%;
      object-fit: cover;
      display: block;
    }
    .lcc-att-rm {
      position: absolute; top: 2px; right: 2px;
      width: 16px; height: 16px;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.78);
      color: #fff;
      border: 1px solid color-mix(in srgb, #fff 22%, transparent);
      font: 700 11px sans-serif;
      cursor: pointer;
      display: grid; place-items: center;
      transition: background 120ms;
    }
    .lcc-att-rm:hover { background: rgba(239, 68, 68, 0.85); }
    .lcc-row {
      display: flex; align-items: flex-end; gap: 6px;
    }
    .lcc-file { display: none; }
    .lcc-attach, .lcc-send {
      flex-shrink: 0;
      width: 32px; height: 32px;
      border-radius: 9px;
      display: grid; place-items: center;
      cursor: pointer;
      transition: all 140ms ease;
    }
    .lcc-attach {
      background: color-mix(in srgb, #000 30%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
      color: rgba(255, 255, 255, 0.65);
    }
    .lcc-attach:hover:not(:disabled) {
      border-color: color-mix(in srgb, var(--g-primary) 45%, transparent);
      color: var(--g-primary);
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
    }
    .lcc-attach:disabled { opacity: 0.4; cursor: not-allowed; }
    .lcc-input {
      flex: 1;
      min-height: 32px;
      max-height: 96px;
      padding: 7px 11px;
      border-radius: 9px;
      background: color-mix(in srgb, #000 42%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
      color: #f5f5f4;
      font: 500 12.5px/1.45 -apple-system, 'Inter', sans-serif;
      outline: none;
      resize: none;
      box-sizing: border-box;
      transition: all 160ms ease;
    }
    .lcc-input:focus {
      border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
      background: color-mix(in srgb, #000 52%, transparent);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--g-primary) 14%, transparent);
    }
    .lcc-input::placeholder { color: rgba(255, 255, 255, 0.36); }
    .lcc-input:disabled { opacity: 0.5; cursor: not-allowed; }
    .lcc-send {
      background: color-mix(in srgb, #000 30%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
      color: rgba(255, 255, 255, 0.4);
    }
    .lcc-send.is-ready {
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--g-primary) 36%, transparent),
          color-mix(in srgb, var(--g-primary) 18%, transparent));
      border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
      color: var(--g-primary);
      box-shadow:
        inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent),
        0 4px 12px color-mix(in srgb, var(--g-primary) 28%, transparent);
    }
    .lcc-send.is-ready:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow:
        inset 0 1px 0 color-mix(in srgb, #fff 18%, transparent),
        0 8px 18px color-mix(in srgb, var(--g-primary) 38%, transparent);
    }
    .lcc-send:disabled { cursor: not-allowed; }

    /* ── MIDDLE: TRANSCRIPT (glass tile) + CLAUDE CODE TOGGLE ───
       .panel-left becomes a glass tile mirroring the voice bar.
       Keep its existing .panel-header (▶ Terminal / ◧ Transcript
       toggle) — that wiring is identical to the voice tab. */
    .hud-container.live-action-on .panel-left {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      min-height: 0;
      width: auto;
      margin: 10px;
      grid-area: unset;
      border: 1px solid var(--glass-border);
      border-radius: 14px;
      background:
        linear-gradient(160deg,
          rgba(255,255,255,0.04) 0%,
          rgba(255,255,255,0.01) 40%,
          rgba(0,0,0,0.30) 100%),
        rgba(10, 10, 12, 0.55);
      backdrop-filter: var(--g-blur-heavy, blur(20px) saturate(150%));
      -webkit-backdrop-filter: var(--g-blur-heavy, blur(20px) saturate(150%));
      box-shadow:
        0 8px 24px rgba(0,0,0,0.40),
        inset 0 1px 0 rgba(255,255,255,0.06);
      overflow: hidden;
    }
    .hud-container.live-action-on .panel-left .vc-left-transcript {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .hud-container.live-action-on .panel-left .vc-left-transcript .panel-header {
      flex: 0 0 auto;
      padding: 8px 12px;
      background: linear-gradient(180deg,
        color-mix(in srgb, var(--g-primary, #caa45a) 8%, transparent) 0%,
        transparent 100%);
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 14%, var(--glass-border));
    }
    .hud-container.live-action-on .panel-left .vc-left-transcript .transcript-content {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      padding: 0.6rem;
      background: transparent;
    }
    .hud-container.live-action-on .panel-left .vc-left-transcript .vc-term-mode {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .hud-container.live-action-on .panel-left .vc-left-splitter,
    .hud-container.live-action-on .panel-left .vc-left-log {
      display: none !important;
    }

    /* ── BOTTOM: COMPACT CONTROL FOOTER ─────────────────────────
       Override voice-chat's full footer (which packs Connect, mic,
       LIVEKIT mic, Vision, Video, Stream) into a compact strip that
       fits 360px wide. The advanced toggles (Vision/Video/Stream)
       are dropped — those belong on the full voice tab. We keep
       Connect/Disconnect (primary) + Local STT mic + LiveKit mic. */
    .hud-container.live-action-on .hud-footer {
      display: flex !important;
      flex: 0 0 auto;
      grid-area: unset;
      width: auto;
      margin: 0 10px 10px 10px;
      padding: 8px 12px;
      gap: 8px;
      align-items: center;
      justify-content: center;
      flex-wrap: wrap;
      border: 1px solid var(--glass-border);
      border-radius: 14px;
      background:
        linear-gradient(180deg,
          rgba(255,255,255,0.04) 0%,
          rgba(0,0,0,0.30) 100%),
        rgba(10, 10, 12, 0.55);
      backdrop-filter: var(--g-blur-heavy, blur(20px) saturate(150%));
      -webkit-backdrop-filter: var(--g-blur-heavy, blur(20px) saturate(150%));
      box-shadow:
        0 8px 24px rgba(0,0,0,0.40),
        inset 0 1px 0 rgba(255,255,255,0.06);
    }
    /* Drop the secondary control-group (Vision/Video/Stream cluster):
       it's the last .control-group child. Connect lives in the FIRST
       .control-group, mic wrappers are siblings — leave those alone. */
    .hud-container.live-action-on .hud-footer .control-group:last-of-type {
      display: none !important;
    }
    /* The dividers between groups make the strip feel cramped at
       360px; suppress them. */
    .hud-container.live-action-on .hud-footer .divider {
      display: none !important;
    }
    /* Shrink mic buttons + the Connect pill so everything fits. */
    .hud-container.live-action-on .hud-footer .ctrl-btn {
      padding: 8px 14px;
      font-size: 0.65rem;
      letter-spacing: 1.5px;
    }
    .hud-container.live-action-on .hud-footer .mic-btn {
      width: 44px;
      height: 44px;
    }
    .hud-container.live-action-on .hud-footer .mic-label {
      font-size: 8px;
    }

    /* ── LIVE ACTION RESIZE HANDLE ────────────────────────────────
       Thin vertical strip on the left (inner) edge of the sidebar.
       Absolutely positioned inside .hud-container so it never shifts
       the flex column layout. Pointer events captured on pointerdown
       for smooth out-of-bounds drag (same pattern as vc-col-splitter).
       ─────────────────────────────────────────────────────────── */
    .la-resize-handle {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 6px;
      cursor: ew-resize;
      z-index: 10;
      touch-action: none;
      user-select: none;
      background: transparent;
      transition: background 0.15s ease;
    }
    .la-resize-handle::before {
      content: "";
      position: absolute;
      top: 0; bottom: 0;
      left: -4px; right: -4px;
    }
    .la-resize-handle::after {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 2px;
      height: 32px;
      border-radius: 2px;
      background: color-mix(in srgb, var(--g-primary) 40%, transparent);
      opacity: 0.55;
      transition: opacity 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
    }
    .la-resize-handle:hover,
    .la-resize-handle.dragging {
      background: color-mix(in srgb, var(--g-primary) 12%, transparent);
    }
    .la-resize-handle:hover::after,
    .la-resize-handle.dragging::after {
      opacity: 1;
      background: var(--g-primary);
      box-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 55%, transparent);
    }
    .la-resize-handle:focus-visible {
      outline: none;
      background: color-mix(in srgb, var(--g-primary) 18%, transparent);
    }
    /* Chevron appears when handle is at minimum width */
    .la-resize-handle .la-chevron {
      display: none;
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 18px;
      height: 18px;
      align-items: center;
      justify-content: center;
      color: var(--g-primary);
      opacity: 0.8;
      font-size: 12px;
      line-height: 1;
      pointer-events: none;
    }
    .la-resize-handle.at-min .la-chevron {
      display: flex;
    }
    .la-resize-handle.at-min::after {
      display: none;
    }

    /* Width readout chip — fades in only while dragging */
    .la-width-chip {
      position: absolute;
      left: 14px;
      top: 50%;
      transform: translateY(-50%);
      background: color-mix(in srgb, var(--g-surface, rgba(18,18,22,1)) 88%, transparent);
      border: 1px solid var(--g-border, rgba(255,255,255,0.08));
      border-radius: 6px;
      padding: 3px 8px;
      font: 600 10px/1 'JetBrains Mono', 'Fira Code', monospace;
      color: var(--g-primary);
      letter-spacing: 0.05em;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.12s ease;
      white-space: nowrap;
      z-index: 20;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }
    .la-width-chip.visible {
      opacity: 1;
    }

    /* Collapsed-state rail — slim 24px strip with a chevron to expand */
    .la-collapse-rail {
      display: none;
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      right: 0;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 11;
      background: transparent;
      border: none;
      padding: 0;
    }
    .la-collapse-rail svg {
      color: var(--g-primary);
      opacity: 0.7;
      transition: opacity 0.15s ease, transform 0.15s ease;
      flex-shrink: 0;
    }
    .la-collapse-rail:hover svg {
      opacity: 1;
      transform: scale(1.2);
    }
    .la-collapse-rail:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--g-primary) 70%, transparent);
      outline-offset: 2px;
    }

    /* Collapsed panel state — hide all content, show only the rail */
    .hud-container.live-action-on.la-collapsed > *:not(.la-collapse-rail) {
      opacity: 0;
      pointer-events: none;
      visibility: hidden;
    }
    .hud-container.live-action-on.la-collapsed .la-collapse-rail {
      display: flex;
    }

    /* ── PREMIUM GLASSMORPHISM ENHANCEMENTS ───────────────────────
       Layer additional depth onto the live-action sidebar to match
       the premium glass panels elsewhere in the UI. The base
       backdrop-filter and bg gradient were already close — these
       add the outer drop-shadow, inset top-edge highlight, and a
       more refined border treatment using existing tokens.
       ─────────────────────────────────────────────────────────── */
    .hud-container.live-action-on {
      border-radius: 16px 0 0 16px;
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 20%, rgba(255,255,255,0.06));
      border-right: none;
      box-shadow:
        -14px 0 44px rgba(0,0,0,0.55),
        inset 1px 0 0 color-mix(in srgb, var(--g-primary, #caa45a) 22%, transparent),
        inset 0 1px 0 rgba(255,255,255,0.05),
        0 0 0 0.5px color-mix(in srgb, var(--g-accent, #7cf5ff) 8%, transparent);
    }
    /* Inner tiles (panel-left, hud-footer) — subtle glass upgrade */
    .hud-container.live-action-on .panel-left {
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 14%, rgba(255,255,255,0.04));
      border-radius: 12px;
      background:
        linear-gradient(160deg,
          rgba(255,255,255,0.03) 0%,
          rgba(255,255,255,0.01) 40%,
          rgba(0,0,0,0.28) 100%),
        rgba(10, 10, 12, 0.55);
      backdrop-filter: var(--g-blur-heavy, blur(22px) saturate(140%));
      -webkit-backdrop-filter: var(--g-blur-heavy, blur(22px) saturate(140%));
      box-shadow:
        0 8px 24px rgba(0,0,0,0.40),
        inset 0 1px 0 rgba(255,255,255,0.05);
    }
    .hud-container.live-action-on .hud-footer {
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 12%, rgba(255,255,255,0.04));
      border-radius: 12px;
      background:
        linear-gradient(180deg,
          rgba(255,255,255,0.03) 0%,
          rgba(0,0,0,0.28) 100%),
        rgba(10, 10, 12, 0.55);
      backdrop-filter: var(--g-blur-heavy, blur(22px) saturate(140%));
      -webkit-backdrop-filter: var(--g-blur-heavy, blur(22px) saturate(140%));
      box-shadow:
        0 8px 24px rgba(0,0,0,0.40),
        inset 0 1px 0 rgba(255,255,255,0.05);
    }

    /* Live Action toggle pill + display picker */
    .live-action-cluster {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-right: 4px;
    }
    .live-action-toggle {
      display: inline-flex !important;
      align-items: center;
      gap: 6px;
      padding: 6px 12px !important;
      width: auto !important;
      height: auto !important;
      border-radius: 999px !important;
      font: 600 10px/1 'JetBrains Mono', 'Fira Code', monospace !important;
      letter-spacing: 0.1em !important;
      text-transform: uppercase !important;
      transition: background 160ms ease, color 160ms ease, border-color 160ms ease;
    }
    .live-action-toggle .la-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--gold-dim);
      transition: background 160ms ease, box-shadow 160ms ease;
    }
    .live-action-toggle.active {
      background: color-mix(in srgb, var(--gold-primary) 22%, transparent) !important;
      border-color: var(--gold-primary) !important;
      color: var(--gold-primary) !important;
    }
    .live-action-toggle.active .la-dot {
      background: var(--success);
      box-shadow: 0 0 6px var(--success);
      animation: pulse 1.5s ease-in-out infinite;
    }
    .live-action-display {
      appearance: none;
      padding: 5px 22px 5px 10px;
      border-radius: 999px;
      background: transparent;
      border: 1px solid var(--glass-border);
      color: var(--text-secondary);
      font: 600 10px/1 'JetBrains Mono', 'Fira Code', monospace;
      letter-spacing: 0.06em;
      cursor: pointer;
      background-image: linear-gradient(45deg, transparent 50%, currentColor 50%),
                        linear-gradient(135deg, currentColor 50%, transparent 50%);
      background-position: calc(100% - 12px) 50%, calc(100% - 8px) 50%;
      background-size: 4px 4px;
      background-repeat: no-repeat;
    }
    .live-action-display:hover {
      border-color: var(--gold-dim);
      color: var(--gold-primary);
    }

    /* ═══════════════════════════════════════════════════════════
       HEADER
       ═══════════════════════════════════════════════════════════ */
    .hud-header {
      grid-area: header;
      background: transparent;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 1.5rem;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 1.5rem;
    }

    .system-title {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: var(--gold-primary);
      font-weight: 600;
    }

    .system-title svg {
      filter: drop-shadow(0 0 6px var(--gold-glow));
    }

    .status-badges {
      display: flex;
      gap: 0.5rem;
    }

    .status-badge.voice-provider-badge {
      white-space: nowrap;
      flex-shrink: 0;
    }

    .status-badge.voice-account-badge {
      white-space: nowrap;
      min-width: 0;
      max-width: 340px;
      color: var(--accent);
      border-color: color-mix(in srgb, var(--accent) 40%, transparent);
    }
    .status-badge.voice-account-badge .vp-text { overflow: hidden; text-overflow: ellipsis; }
    .status-badge.voice-account-badge svg { flex-shrink: 0; }

    /* The mobile HUD header is already at capacity: collapse the provider
       badge to its status dot and the account badge to its pin (full text in
       the tooltip / aria-label and in
       Setup › Voice). */
    @media (max-width: 600px) {
      .status-badge.voice-provider-badge .vp-text { display: none; }
      .status-badge.voice-account-badge .vp-text { display: none; }
      .status-badge.voice-account-badge { padding: 6px; gap: 0; }
      .status-badge.voice-provider-badge { padding: 6px; gap: 0; }
    }

    .status-badge {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--glass-border);
      border-radius: 16px;
      font-size: 0.6rem;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-secondary);
    }

    .status-badge.active {
      border-color: var(--gold-dim);
      color: var(--gold-primary);
    }

    .status-badge.live {
      border-color: var(--success);
      color: var(--success);
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }

    .status-badge.live .status-dot {
      animation: pulse 1.5s ease-in-out infinite;
      box-shadow: 0 0 8px currentColor;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .system-time {
      font-size: 1.1rem;
      color: var(--gold-primary);
      font-weight: 300;
      letter-spacing: 2px;
      text-shadow: 0 0 10px var(--gold-glow);
      font-variant-numeric: tabular-nums;
    }

    .header-controls {
      display: flex;
      gap: 0.5rem;
    }

    /* ═══════════════════════════════════════════════════════════
       GLASS PANEL BASE
       Inner panels inherit the outer .hud-container glass; this
       class is a no-op now so we don't double-stack surfaces.
       ═══════════════════════════════════════════════════════════ */
    .glass-panel {
      background: transparent;
      border: none;
      box-shadow: none;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.875rem 1rem;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
      background: transparent;
    }

    .panel-title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: var(--gold-primary);
      font-weight: 600;
    }

    .panel-title svg {
      opacity: 0.8;
      width: 14px;
      height: 14px;
    }

    .panel-badge {
      padding: 2px 8px;
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      border: 1px solid var(--glass-border);
      border-radius: 4px;
      font-size: 0.55rem;
      color: var(--gold-dim);
      font-weight: 600;
    }

    /* ═══════════════════════════════════════════════════════════
       LEFT PANEL - TRANSCRIPT
       ═══════════════════════════════════════════════════════════ */
    .panel-left {
      grid-area: left;
      display: flex;
      flex-direction: column;
      background: transparent;
      min-height: 0;
      overflow: hidden;
    }

    /* ── Vertical column splitter (drag the right edge of panel-left) ──
       Sits in its own 6px grid track between panel-left and panel-center
       so the drag handle never overlaps panel content. Wider hit area is
       supplied via ::before. Mirrors .vc-left-splitter (horizontal). */
    .vc-col-splitter {
      grid-area: colsep;
      position: relative;
      cursor: ew-resize;
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      transition: background 0.15s ease;
      touch-action: none;
      user-select: none;
      z-index: 2;
    }
    .vc-col-splitter::before {
      content: "";
      position: absolute;
      top: 0;
      bottom: 0;
      left: -4px;
      right: -4px;
    }
    .vc-col-splitter::after {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 2px;
      height: 28px;
      border-radius: 2px;
      background: color-mix(in srgb, var(--g-primary) 35%, transparent);
      opacity: 0.6;
      transition: opacity 0.15s ease, background 0.15s ease;
    }
    .vc-col-splitter:hover,
    .vc-col-splitter.dragging {
      background: color-mix(in srgb, var(--g-primary) 28%, transparent);
    }
    .vc-col-splitter:hover::after,
    .vc-col-splitter.dragging::after {
      opacity: 1;
      background: var(--g-primary);
    }
    /* Live-action sidebar mode collapses the grid into a flex column, so
       the column splitter becomes irrelevant — hide it. */
    .hud-container.live-action-on .vc-col-splitter { display: none; }

    /* Transcript section in the upper half of the resizable left column.
       Owns its own header + scroll container; flex-grows to fill the space
       not consumed by the log panel below. */
    .vc-left-transcript {
      flex: 1 1 auto;
      min-height: 96px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Drag handle between transcript (top) and log (bottom). Height stays
       small for content; visual hit-area widens via ::before so the user
       gets a generous grab target without enlarging layout. */
    .vc-left-splitter {
      flex: 0 0 4px;
      position: relative;
      cursor: ns-resize;
      background: var(--g-border, var(--glass-border));
      border-top: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
      transition: background 0.15s ease;
      touch-action: none;
      user-select: none;
    }
    .vc-left-splitter::before {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      top: -4px;
      bottom: -4px;
    }
    .vc-left-splitter::after {
      content: "";
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 28px;
      height: 2px;
      border-radius: 2px;
      background: color-mix(in srgb, var(--g-primary) 35%, transparent);
      opacity: 0.6;
      transition: opacity 0.15s ease, background 0.15s ease;
    }
    .vc-left-splitter:hover,
    .vc-left-splitter.dragging {
      background: color-mix(in srgb, var(--g-primary) 28%, transparent);
    }
    .vc-left-splitter:hover::after,
    .vc-left-splitter.dragging::after {
      opacity: 1;
      background: var(--g-primary);
    }

    /* Log section in the lower half of the resizable left column. Height
       is driven by --vc-left-split (set on :host); flex-grow:0 keeps it
       fixed against transcript growth. */
    .vc-left-log {
      flex: 0 0 auto;
      height: var(--vc-left-split, 240px);
      min-height: 80px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border-top: 1px solid var(--glass-border);
    }

    /* Free-floating transcript stream. The scroll viewport has NO chrome of
       its own — turns float directly over the mesh map as bare text. Both
       edges are masked to transparent so the stream dissolves into the scene
       at top AND bottom instead of stopping at a hard panel edge (pure CSS,
       no JS opacity hacks). This thin gradient mask is the only "background"
       — there is no card behind the conversation. */
    .transcript-content {
      --transcript-fade: 96px;
      --transcript-fade-b: 56px;
      flex: 1 1 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 0.75rem 0.5rem 0.9rem;
      padding-top: 0.5rem;
      scroll-behavior: smooth;
      overscroll-behavior: contain;
      /* Required so the flex child is allowed to shrink below its content
         height and actually scroll instead of pushing the grid cell taller. */
      min-height: 0;
      -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 var(--transcript-fade), #000 calc(100% - var(--transcript-fade-b)), transparent 100%);
      mask-image: linear-gradient(to bottom, transparent 0, #000 var(--transcript-fade), #000 calc(100% - var(--transcript-fade-b)), transparent 100%);
    }

    /* No visible scrollbar — the viewport must have no edge or boundary. */
    .transcript-content {
      scrollbar-width: none;
      scrollbar-color: transparent transparent;
    }
    .transcript-content::-webkit-scrollbar {
      width: 0;
      height: 0;
      display: none;
    }

    /* Each turn is bare floating text — NO card, NO border, NO backdrop blur.
       The speaker is read from a tiny inline chip; legibility over the busy
       mesh map comes purely from text-shadow + the column's gradient mask.
       Auto-sizes to content and wraps naturally. */
    .message {
      position: relative;
      display: block;
      width: fit-content;
      max-width: min(60ch, 100%);
      margin-bottom: 0.85rem;
      padding: 0;
      background: none;
      border: none;
      box-shadow: none;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      /* Staggered slide-up entrance; --i set per-turn from the template. */
      animation: pillIn 0.24s ease-out both;
      animation-delay: calc(var(--i, 0) * 45ms);
    }

    @keyframes pillIn {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Assistant turns hug the left; user turns hug the right. No fills —
       the alignment + accent color carries the speaker distinction. */
    .message.agent { margin-right: auto; }
    .message.user  { margin-left: auto; text-align: right; }

    /* Speaker label = tiny rounded glass chip (the ONLY chrome on a turn). */
    .message-role {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 0.5rem;
      text-transform: uppercase;
      letter-spacing: 1.2px;
      margin-bottom: 0.32rem;
      padding: 2px 7px;
      border-radius: 999px;
      font-weight: 700;
      background: color-mix(in srgb, var(--g-primary) 9%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--g-primary) 16%, transparent);
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
    }

    .message.user .message-role {
      color: var(--text-secondary);
      background: rgba(255, 255, 255, 0.06);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14);
    }
    .message.agent .message-role { color: var(--gold-primary); }

    /* Bare text floating over the map. Gold-tinted for the assistant turn,
       muted-white for the user turn. A layered text-shadow keeps every glyph
       legible against the bright mesh without any backing panel. */
    .message-text {
      font-size: 0.82rem;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
      text-shadow:
        0 1px 2px rgba(0, 0, 0, 0.85),
        0 2px 10px rgba(0, 0, 0, 0.6),
        0 0 1px rgba(0, 0, 0, 0.9);
    }
    .message.agent .message-text {
      color: color-mix(in srgb, var(--gold-primary) 22%, #f4f5f7);
    }
    .message.user .message-text {
      color: color-mix(in srgb, #ffffff 86%, var(--text-secondary));
    }

    .message-time {
      margin-top: 0.28rem;
      font-size: 0.5rem;
      color: var(--text-muted);
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.75);
    }
    .message.user .message-time { text-align: right; }

    /* Reduced motion: no entrance animation. */
    @media (prefers-reduced-motion: reduce) {
      .message { animation: none; }
    }

    /* High-contrast: thicken the text-shadow into a near-outline so bare text
       stays readable without reintroducing a panel. */
    @media (prefers-contrast: more) {
      .message-text {
        text-shadow:
          0 0 2px #000, 0 0 2px #000,
          0 1px 3px #000, 0 -1px 3px #000;
      }
    }

    /* Mobile: turns shrink to fit the narrow viewport. */
    @media (max-width: 640px) {
      .message { max-width: 88vw; }
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--text-muted);
      gap: 0.75rem;
      text-align: center;
    }

    .empty-state svg { opacity: 0.3; }
    /* The empty-state line is live call guidance, not decoration: keep it readable. */
    .empty-state span { font-size: 0.78rem; line-height: 1.5; letter-spacing: 0.5px; color: var(--text-secondary); max-width: 32ch; }

    /* ═══════════════════════════════════════════════════════════
       CENTER PANEL - INTEGRATED VIDEO + VISUALIZER
       ═══════════════════════════════════════════════════════════ */
    .panel-center {
      grid-area: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      position: relative;
      background: transparent;
      overflow: hidden;
      margin: 0;
      border-radius: 0;
      border: none;
    }

    /* ── Unified agent-world backdrop (canonical iso mesh) ─────────────
       FULL-TERMINAL backdrop: absolutely positioned as a direct child of
       .hud-container (inset:0, z:0) so the mesh spans behind EVERY grid
       cell — left transcript, right edge HUD, center blob, footer. The
       grid cells (.hud-container > * → z:1) and the fixed edge HUD float
       ON TOP, so the whole page reads as ONE world with floating chrome,
       not a glass panel with a mesh boxed into its center cell.

       --vc-blob-cx tracks the horizontal centre of the center grid cell
       (left track + 6px splitter … minus the right track), so the mask /
       halo / vignette stay locked to the blob even as the panels resize. */
    .vc-world {
      --vc-blob-cx: calc(
        (var(--vc-left-width, 440px) + 6px + 100% - var(--vc-right-width, 300px)) / 2);
      position: absolute;
      inset: 0;
      z-index: 0;                    /* behind every grid cell (z:1) */
      overflow: hidden;
      pointer-events: auto;          /* mesh stays interactive (tap→focus) */
      -webkit-mask-image: radial-gradient(150% 135% at var(--vc-blob-cx) 46%, #000 40%, rgba(0,0,0,0.55) 72%, transparent 100%);
              mask-image: radial-gradient(150% 135% at var(--vc-blob-cx) 46%, #000 40%, rgba(0,0,0,0.55) 72%, transparent 100%);
    }
    /* The grid-child z:1 normalizer must NOT lift the world above the cells. */
    .hud-container > .vc-world { z-index: 0; }
    .vc-world agency-world-viz {
      position: absolute;
      /* Oversized symmetric bleed so the iso world grows OUTWARD behind the
         frosted side columns — reinforcing that the transcript and right rail
         float over the SAME world, not just the centre gap. NB: voice-world-
         connectors + voice-world-graph mirror this EXACT box (-16% / 132%) so
         their published agent-tile screen coords still map 1:1 to the mesh. */
      inset: -16%;
      display: block;
      width: 132%;
      height: 132%;
    }
    /* Vignette that fuses the mesh edges into the terminal-wide void so the
       rectangle never seams against the floating chrome. Centred on the blob
       via --vc-blob-cx (inherited from .vc-world). */
    .vc-world-fade {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background:
        radial-gradient(150% 115% at var(--vc-blob-cx, 50%) 42%,
          transparent 48%,
          color-mix(in srgb, var(--bg-void, #04060d) 78%, transparent) 100%);
    }
    /* Audio-reactive coupling halo — the blob's energy (--vc-blob-energy)
       scales/brightens this glow, and live mesh activity (--vc-mesh-activity)
       tints it, visually tying blob + mesh into one reactive world. */
    .vc-world-halo {
      position: absolute;
      left: var(--vc-blob-cx, 50%);
      top: 50%;
      width: 540px;
      height: 540px;
      transform: translate(-50%, -50%) scale(calc(0.88 + var(--vc-blob-energy, 0.06) * 0.4));
      pointer-events: none;
      border-radius: 50%;
      background: radial-gradient(circle,
        color-mix(in srgb, var(--g-primary, #caa45a) calc(12% + var(--vc-mesh-activity, 0) * 28%), transparent) 0%,
        transparent 60%);
      opacity: calc(0.3 + var(--vc-blob-energy, 0.06) * 0.55);
      transition: opacity 120ms linear, transform 120ms linear;
      mix-blend-mode: screen;
    }

    /* ── HUD mode: blob sits ABOVE the mesh, not on top of it ──────────
       The mesh map is constrained to the lower portion of the terminal
       (so the blob isn't covering it), the blob is lifted into the upper
       portion, and the connector/graph layers stay full-bleed so they can
       flow upward from mesh nodes into the blob. */
    .hud-container.floating-hud-on .vc-world agency-world-viz {
      top: 38%;
      bottom: -16%;
      height: auto;
      -webkit-mask-image: linear-gradient(to bottom, transparent 0%, #000 18%, #000 100%);
              mask-image: linear-gradient(to bottom, transparent 0%, #000 18%, #000 100%);
    }
    .hud-container.floating-hud-on .vc-world-fade {
      background:
        radial-gradient(150% 90% at var(--vc-blob-cx, 50%) 78%,
          transparent 52%,
          color-mix(in srgb, var(--bg-void, #04060d) 78%, transparent) 100%);
    }
    .hud-container.floating-hud-on .vc-world-halo {
      top: 34%;
    }
    .hud-container.floating-hud-on .panel-center .orb-container,
    .hud-container:not(.live-action-on) .panel-center .orb-container {
      top: 50% !important;
      transform: translate(-50%, -50%) !important;
    }

    /* The sticky <voice-controls-dock> owns the bottom-centre in HUD mode, so
       hide the legacy in-grid footer controls to avoid a duplicate bottom bar
       peeking through. (Live-action mode keeps its own compact footer.) */
    .hud-container.floating-hud-on .hud-footer {
      display: none !important;
    }

    /* ── Free-floating control pills (anchored below the global app bar) ──
       Glass pills that hover under the VOICE TERMINAL header (which itself
       sits directly below the global topbar), centered, never occluding the
       blob center. Gaps pass clicks through; pills re-enable pointer events. */
    .vc-floating-pills {
      position: absolute;
      top: 64px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 40;
      display: flex;
      align-items: center;
      gap: 10px;
      pointer-events: none;
    }
    .vc-floating-pills > * { pointer-events: auto; }
    .vc-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      height: 34px;
      padding: 0 14px;
      border-radius: 999px;
      border: 1px solid var(--g-glass-border, rgba(255,255,255,0.12));
      background: color-mix(in srgb, var(--g-surface, rgba(12,14,22,0.6)) 80%, transparent);
      backdrop-filter: blur(18px) saturate(160%);
      -webkit-backdrop-filter: blur(18px) saturate(160%);
      color: var(--text-primary, #e8e8ea);
      font: 600 11px/1 'JetBrains Mono', monospace;
      letter-spacing: 0.04em;
      cursor: pointer;
      white-space: nowrap;
      box-shadow: 0 6px 22px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06);
      transition: border-color .18s, background .18s, transform .12s, color .18s;
    }
    .vc-pill:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--g-primary,#caa45a) 55%, transparent); }
    .vc-pill:disabled { opacity: 0.55; cursor: wait; }
    .vc-pill.is-live { border-color: color-mix(in srgb, var(--success,#39d98a) 60%, transparent); color: var(--success,#39d98a); }
    .vc-pill.is-off  { border-color: color-mix(in srgb, var(--danger,#ff5d5d) 50%, transparent); color: var(--danger,#ff5d5d); }
    .vc-pill.is-rec  { border-color: color-mix(in srgb, var(--g-primary,#caa45a) 60%, transparent); color: var(--g-primary,#caa45a); }
    .vc-pill-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; opacity: 0.5; }
    .vc-pill-dot.live, .vc-pill-dot.rec { opacity: 1; box-shadow: 0 0 8px currentColor; animation: vc-pill-blink 1.4s ease-in-out infinite; }
    @keyframes vc-pill-blink { 0%,100%{opacity:1} 50%{opacity:0.35} }
    .vc-pill--select { padding: 0 6px 0 10px; height: 34px; }
    .vc-pill--select agent-cli-selector { --acs-compact: 1; }
    .vc-pill--route { padding: 0 10px; height: 34px; }

    /* ── Floating cloud terminal ── */
    .vc-cloud-terminal {
      position: absolute;
      right: 22px;
      bottom: 88px;
      width: 360px;
      max-width: 42vw;
      height: 240px;
      z-index: 38;
      display: flex;
      flex-direction: column;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid color-mix(in srgb, var(--g-primary,#caa45a) 22%, var(--g-glass-border, rgba(255,255,255,0.12)));
      background: color-mix(in srgb, #060810 86%, transparent);
      backdrop-filter: blur(20px) saturate(150%);
      -webkit-backdrop-filter: blur(20px) saturate(150%);
      box-shadow: 0 18px 54px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.05);
    }
    .vct-head {
      display: flex; align-items: center; gap: 8px;
      padding: 7px 10px;
      cursor: grab;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary,#caa45a) 14%, transparent);
      background: linear-gradient(180deg, rgba(255,255,255,0.04), transparent);
      user-select: none;
      touch-action: none;
    }
    .vct-head:active { cursor: grabbing; }
    .vct-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-secondary,#8a8a92); flex-shrink: 0; }
    .vct-dot.live { background: var(--success,#39d98a); box-shadow: 0 0 8px var(--success,#39d98a); animation: vc-pill-blink 1.4s ease-in-out infinite; }
    .vct-title { flex: 1; font: 700 10px/1 'JetBrains Mono', monospace; letter-spacing: 0.1em; color: var(--g-primary,#caa45a); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .vct-btn { background: none; border: none; color: var(--text-secondary,#9a9aa2); cursor: pointer; font-size: 13px; padding: 2px 5px; line-height: 1; border-radius: 4px; }
    .vct-btn:hover { color: var(--g-primary,#caa45a); background: rgba(255,255,255,0.06); }
    .vct-body {
      flex: 1; overflow-y: auto; padding: 8px 10px;
      font: 11px/1.5 'JetBrains Mono', monospace;
      color: var(--text-primary,#d6d6da);
      background: repeating-linear-gradient(0deg, transparent 0 23px, rgba(255,255,255,0.012) 23px 24px);
    }
    .vct-empty { opacity: 0.5; font-style: italic; }
    .vct-line { display: flex; gap: 8px; padding: 1px 0; }
    .vct-ts { color: color-mix(in srgb, var(--g-primary,#caa45a) 55%, transparent); flex-shrink: 0; }
    .vct-msg { word-break: break-word; }
    .vct-error .vct-msg { color: var(--danger,#ff6b6b); }
    .vct-warn .vct-msg  { color: var(--warning,#ffb454); }
    .vct-system .vct-msg { color: color-mix(in srgb, var(--g-primary,#caa45a) 80%, white); }

    /* Main Video Feed - Full Center Area */
    .center-video-wrapper {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      border-radius: 16px;
    }

    .center-video-wrapper video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transform: scaleX(-1);
    }

    .center-video-wrapper.no-video {
      background: radial-gradient(ellipse at center, color-mix(in srgb, var(--g-primary) 3%, transparent) 0%, transparent 70%);
    }

    /* Video HUD Overlay */
    .video-hud-overlay {
      position: absolute;
      inset: 0;
      pointer-events: none;
      border-radius: 16px;
      overflow: hidden;
    }

    /* Grid Background (shows when no video) */
    .grid-bg {
      position: absolute;
      inset: 0;
      background-image: 
        linear-gradient(color-mix(in srgb, var(--g-primary) 2%, transparent) 1px, transparent 1px),
        linear-gradient(90deg, color-mix(in srgb, var(--g-primary) 2%, transparent) 1px, transparent 1px);
      background-size: 50px 50px;
      opacity: 0.5;
    }

    /* Scanlines Overlay */
    .center-scanlines {
      position: absolute;
      inset: 0;
      background: repeating-linear-gradient(
        0deg,
        transparent 0px,
        transparent 2px,
        rgba(0, 0, 0, 0.1) 2px,
        rgba(0, 0, 0, 0.1) 4px
      );
      pointer-events: none;
    }

    /* Vignette Effect */
    .center-vignette {
      position: absolute;
      inset: 0;
      background: radial-gradient(ellipse at center, transparent 40%, rgba(0, 0, 0, 0.6) 100%);
      pointer-events: none;
    }

    /* ── HOLO-DOMINANT MODE ──────────────────────────────────────
       When the holographic ring is the backdrop (no live-action tile)
       and there's no live camera feed, the <voice-holo-ring> paints its
       own deep void + atmosphere + 3D agent ring. The legacy CRT chrome
       (grid, scanlines, vignette) must NOT compete with it — they used to
       show through the (transparent) holo canvas and made the page "look
       the same". Suppress the grid entirely, drop scanlines to a faint
       texture, and soften the vignette to a gentle edge falloff so the
       holo scene dominates. Full-strength chrome returns over real video. */
    .panel-center.holo-active:not(.has-video) .center-scanlines {
      opacity: 0.04;
    }
    .panel-center.holo-active:not(.has-video) .center-vignette {
      background: radial-gradient(ellipse at center, transparent 62%, rgba(0, 0, 0, 0.28) 100%);
    }
    /* Corner brackets stay as subtle HUD framing but dimmed over holo. */
    .panel-center.holo-active:not(.has-video) .center-corners .corner {
      opacity: 0.35;
    }

    /* HUD Corner Brackets - Larger */
    .center-corners .corner {
      position: absolute;
      width: 40px;
      height: 40px;
      border: 2px solid var(--gold-primary);
      opacity: 0.7;
    }

    .center-corners .corner.tl { top: 20px; left: 20px; border-right: none; border-bottom: none; }
    .center-corners .corner.tr { top: 20px; right: 20px; border-left: none; border-bottom: none; }
    .center-corners .corner.bl { bottom: 20px; left: 20px; border-right: none; border-top: none; }
    .center-corners .corner.br { bottom: 20px; right: 20px; border-left: none; border-top: none; }

    /* Target Reticle - Center of Video */
    .center-reticle {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 80px;
      height: 80px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
      border-radius: 50%;
      opacity: 0.6;
    }

    .center-reticle::before,
    .center-reticle::after {
      content: '';
      position: absolute;
      background: var(--gold-primary);
      opacity: 0.4;
    }

    .center-reticle::before {
      top: 50%;
      left: -10px;
      right: -10px;
      height: 1px;
    }

    .center-reticle::after {
      left: 50%;
      top: -10px;
      bottom: -10px;
      width: 1px;
    }

    /* ═══════════════════════════════════════════════════════════
       ENHANCED ORB WITH THINKING & SPEAKING ANIMATIONS
       ═══════════════════════════════════════════════════════════ */
    .orb-container {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 480px;
      height: 480px;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 20;
      pointer-events: none;
      transition: opacity 0.5s ease;
    }

    .orb-container.video-active {
      opacity: 0.7;
    }

    /* ── Zoom-reactive top dock ────────────────────────────────────────────
       The blob LIVES in the top band (under the running-agent pills) and its
       SIZE reacts continuously to mesh zoom (see DOCK_* consts in this file).
       We ONLY animate transform (never width/height) so a zoom tick never
       reflows the transcript/pills.

       Geometry: the orb-container is anchored at top:50%/left:50% and centred
       via translate(-50%,-50%), so its centre sits at (50vw, 50vh). The dock
       adds translateY(var(--vc-dock-ty)) → centre moves up under the pills row,
       and scale(var(--vc-dock-scale)) shrinks/grows it. transform-origin stays
       centre so the waveform scales symmetrically; horizontal stays centred.

       Both custom props are recomputed in JS (applyDockGeometry) on every zoom
       tick: --vc-dock-scale = DOCK_BASE_SCALE × the smoothstep'd zoom multiplier
       (continuous 0.4→1.2× base), --vc-dock-ty from the live pills-row bottom
       edge + the blob's real anchor centre + current scale, so the ~12px gap
       under the pills holds at any size / viewport / topbar offset. The CSS
       fallbacks keep a sane pose for the one frame before JS runs. */
    .orb-container {
      --vc-dock-scale: 0.46;
      /* transform is the only animated property — spring-y ease, ~250ms. */
      transition: transform 250ms cubic-bezier(.22, 1, .36, 1), opacity 0.5s ease;
      will-change: transform;
    }
    /* Match the specificity (+!important) of the floating-hud orb rules above so
       the docked transform actually wins. */
    .orb-container.zoom-docked,
    .hud-container.floating-hud-on .panel-center .orb-container.zoom-docked,
    .hud-container:not(.live-action-on) .panel-center .orb-container.zoom-docked {
      top: 50% !important;
      transform:
        translate(-50%, -50%)
        translateY(var(--vc-dock-ty, -240px))
        scale(var(--vc-dock-scale)) !important;
    }
    @media (max-width: 760px) {
      .orb-container { --vc-dock-scale: 0.5; }
    }
    /* Accessibility: honour reduced-motion by snapping (no tween). */
    @media (prefers-reduced-motion: reduce) {
      .orb-container { transition: none; }
    }

    /* WebGL blob host — sits inside .orb-container, fills it. Sized
       large for the "premium" voice page; live-action sidebar mode
       overrides this back down to fit its 196px tile. */
    .orb-container.webgl-mode {
      width: min(640px, 58vmin);
      height: min(640px, 58vmin);
    }
    .webgl-blob-host {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: auto;
      z-index: 1;
    }
    .webgl-blob-host canvas {
      display: block;
      width: 100%;
      height: 100%;
    }

    /* Voice character pill — sits top-right of the orb container, mirrors
       the bottom-right visualizer-settings dot. One click flips TTS. */
    .voice-char-toggle {
      position: absolute;
      top: -8px;
      right: -8px;
      z-index: 30;
      pointer-events: auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 28px;
      padding: 0 12px 0 10px;
      border-radius: 14px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 35%, transparent);
      background: rgba(8, 8, 12, 0.78);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      color: rgba(255, 255, 255, 0.85);
      font: 600 10px/1 ui-monospace, "JetBrains Mono", Menlo, monospace;
      letter-spacing: 0.12em;
      cursor: pointer;
      transition: transform 0.12s ease, border-color 0.12s ease, color 0.12s ease;
    }
    .voice-char-toggle:hover {
      transform: translateY(-1px);
      border-color: color-mix(in srgb, var(--g-primary) 70%, transparent);
      color: #fff;
    }
    .voice-char-toggle .voice-char-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      box-shadow: 0 0 6px currentColor;
    }
    .voice-char-toggle.jarvis .voice-char-dot { background: #6ec1ff; color: #6ec1ff; }
    .voice-char-toggle.kokoro .voice-char-dot { background: #ffb84a; color: #ffb84a; }

    .tts-pause-toggle {
      position: absolute;
      top: -8px;
      right: 92px;
      z-index: 30;
      pointer-events: auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 28px;
      padding: 0 12px 0 10px;
      border-radius: 14px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 35%, transparent);
      background: rgba(8, 8, 12, 0.78);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      color: rgba(255, 255, 255, 0.85);
      font: 600 10px/1 ui-monospace, "JetBrains Mono", Menlo, monospace;
      letter-spacing: 0.12em;
      cursor: pointer;
      transition: transform 0.12s ease, border-color 0.12s ease, color 0.12s ease;
    }
    .tts-pause-toggle:hover {
      transform: translateY(-1px);
      border-color: color-mix(in srgb, var(--g-primary) 70%, transparent);
      color: #fff;
    }
    .tts-pause-toggle.paused {
      border-color: color-mix(in srgb, #ffb84a 70%, transparent);
      color: #ffd28f;
    }
    .tts-pause-toggle .tts-pause-icon { font-size: 11px; line-height: 1; }

    /* Style picker */
    .blob-style-controls {
      position: absolute;
      bottom: -8px;
      right: -8px;
      z-index: 30;
      pointer-events: auto;
    }
    .blob-style-toggle {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: 1px solid color-mix(in srgb, var(--g-primary) 40%, transparent);
      background: rgba(8, 8, 12, 0.85);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    }
    .blob-style-toggle:hover {
      transform: scale(1.08);
      border-color: color-mix(in srgb, var(--g-primary) 80%, transparent);
      box-shadow: 0 4px 18px color-mix(in srgb, var(--g-primary) 40%, transparent);
    }
    .blob-style-dot {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      font-weight: 700;
      color: rgba(255, 255, 255, 0.85);
      letter-spacing: 0.5px;
    }
    .blob-style-dot.off-swatch {
      background: rgba(255, 255, 255, 0.08);
      border: 1px dashed rgba(255, 255, 255, 0.25);
    }
    /* Premium settings panel — replaces the old flat dropdown. Anchors
       to bottom-right of the blob, opens upward + leftward. Each section
       is a collapsible accordion row with a chevron. */
    .blob-settings-panel {
      position: absolute;
      bottom: 44px;
      right: 0;
      width: 296px;
      max-height: min(560px, 70vh);
      overflow-y: auto;
      background: linear-gradient(180deg, rgba(14, 14, 20, 0.94) 0%, rgba(6, 6, 10, 0.96) 100%);
      backdrop-filter: blur(18px) saturate(140%);
      -webkit-backdrop-filter: blur(18px) saturate(140%);
      border: 1px solid color-mix(in srgb, var(--g-primary) 22%, rgba(255,255,255,0.06));
      border-radius: 14px;
      box-shadow:
        0 18px 48px rgba(0, 0, 0, 0.7),
        0 0 0 1px rgba(255, 255, 255, 0.02) inset;
      animation: blobMenuIn 0.16s cubic-bezier(0.2, 0.7, 0.2, 1);
      color: rgba(255, 255, 255, 0.92);
      font-family: var(--font-sans, system-ui, sans-serif);
    }
    @keyframes blobMenuIn {
      from { opacity: 0; transform: translateY(8px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    .blob-settings-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .blob-settings-title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 1.4px;
      text-transform: uppercase;
      color: color-mix(in srgb, var(--g-primary) 80%, white 0%);
    }
    .blob-settings-close {
      background: transparent;
      border: 0;
      color: rgba(255, 255, 255, 0.55);
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 4px 6px;
      border-radius: 4px;
      transition: color 0.12s, background 0.12s;
    }
    .blob-settings-close:hover { color: white; background: rgba(255,255,255,0.06); }

    .blob-section { border-bottom: 1px solid rgba(255, 255, 255, 0.04); }
    .blob-section:last-of-type { border-bottom: 0; }

    .blob-section-head {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 12px 14px;
      background: transparent;
      border: 0;
      cursor: pointer;
      color: rgba(255, 255, 255, 0.86);
      font-size: 12px;
      letter-spacing: 0.4px;
      text-align: left;
      transition: background 0.12s;
    }
    .blob-section-head:hover { background: rgba(255, 255, 255, 0.03); }
    .blob-section-head .chevron {
      width: 10px;
      transition: transform 0.18s ease;
      color: rgba(255, 255, 255, 0.45);
      font-size: 10px;
    }
    .blob-section-head.open .chevron { transform: rotate(90deg); color: var(--g-primary); }
    .blob-section-head .section-name { flex: 1; font-weight: 600; }
    .blob-section-head .section-summary {
      font-size: 10.5px;
      color: rgba(255, 255, 255, 0.40);
      letter-spacing: 0.4px;
      text-transform: uppercase;
    }

    .blob-section-body {
      padding: 4px 14px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    /* Style grid — 2 cols of swatches with labels */
    .blob-style-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 6px;
    }
    .blob-style-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      background: rgba(255, 255, 255, 0.025);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 8px;
      cursor: pointer;
      color: rgba(255, 255, 255, 0.85);
      font-size: 11.5px;
      letter-spacing: 0.2px;
      text-align: left;
      transition: background 0.12s, border-color 0.12s, transform 0.12s;
    }
    .blob-style-item:hover {
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(255, 255, 255, 0.14);
      transform: translateY(-1px);
    }
    .blob-style-item.selected {
      background: color-mix(in srgb, var(--g-primary) 14%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--g-primary) 30%, transparent);
    }
    .blob-style-swatch {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      flex-shrink: 0;
      border: 1px solid rgba(255, 255, 255, 0.10);
    }
    .blob-style-label { flex: 1; }

    /* Color rows */
    .blob-color-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 0;
    }
    .blob-color-row label {
      flex: 1;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.78);
    }
    .blob-color-row .blob-color-hint {
      font-size: 10px;
      color: rgba(255, 255, 255, 0.35);
      letter-spacing: 0.4px;
      text-transform: uppercase;
    }
    .blob-color-input {
      width: 36px;
      height: 28px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      background: transparent;
      cursor: pointer;
      padding: 0;
    }
    .blob-color-input::-webkit-color-swatch-wrapper { padding: 2px; }
    .blob-color-input::-webkit-color-swatch { border: 0; border-radius: 4px; }
    .blob-color-input::-moz-color-swatch { border: 0; border-radius: 4px; }
    .blob-color-reset {
      align-self: flex-end;
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: rgba(255, 255, 255, 0.55);
      font-size: 10.5px;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      padding: 6px 10px;
      border-radius: 6px;
      cursor: pointer;
      transition: color 0.12s, border-color 0.12s, background 0.12s;
    }
    .blob-color-reset:hover { color: white; border-color: rgba(255,255,255,0.20); background: rgba(255,255,255,0.04); }

    /* Visualizer section — toggle button */
    .blob-toggle-row {
      width: 100%;
      padding: 9px 12px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.10);
      border-radius: 8px;
      color: rgba(255, 255, 255, 0.82);
      font-size: 12px;
      letter-spacing: 0.3px;
      cursor: pointer;
      transition: background 0.12s, border-color 0.12s;
    }
    .blob-toggle-row:hover { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.20); }
    .blob-toggle-row.danger {
      color: color-mix(in srgb, #ff6066 78%, white);
      border-color: color-mix(in srgb, #ff6066 30%, transparent);
    }

    /* Main Orb */
    .orb {
      width: 240px;
      height: 240px;
      border-radius: 50%;
      background: radial-gradient(circle at 30% 30%,
        color-mix(in srgb, var(--g-primary) 40%, transparent) 0%,
        color-mix(in srgb, var(--g-primary) 20%, transparent) 40%,
        rgba(0, 0, 0, 0.75) 100%);
      box-shadow:
        0 0 80px color-mix(in srgb, var(--g-primary) 40%, transparent),
        0 0 160px color-mix(in srgb, var(--g-primary) 18%, transparent),
        inset 0 0 60px rgba(0, 0, 0, 0.6);
      animation: orbIdle 4s ease-in-out infinite;
      transition: all 0.4s ease;
      position: relative;
    }

    /* Speaking State - Pulsing with Sound Waves */
    .orb.speaking {
      width: 300px;
      height: 300px;
      animation: orbSpeak 0.15s ease-in-out infinite alternate;
      box-shadow:
        0 0 120px color-mix(in srgb, var(--g-primary) 60%, transparent),
        0 0 220px color-mix(in srgb, var(--g-primary) 30%, transparent),
        inset 0 0 60px rgba(0, 0, 0, 0.35);
    }

    /* Thinking State - Rotating with Inner Activity */
    .orb.thinking {
      animation: orbThink 2s ease-in-out infinite;
      box-shadow: 
        0 0 60px color-mix(in srgb, var(--g-primary) 50%, transparent),
        0 0 120px color-mix(in srgb, var(--g-primary) 25%, transparent),
        inset 0 0 60px color-mix(in srgb, var(--g-primary) 15%, transparent);
    }

    /* Processing State */
    .orb.processing {
      animation: orbProcess 1.5s linear infinite;
      box-shadow: 
        0 0 60px color-mix(in srgb, var(--g-primary) 40%, transparent),
        0 0 100px color-mix(in srgb, var(--g-primary) 20%, transparent),
        inset 0 0 30px rgba(0, 0, 0, 0.6);
    }

    @keyframes orbIdle {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.03); }
    }

    @keyframes orbSpeak {
      0% { transform: scale(1); }
      100% { transform: scale(1.08); }
    }

    @keyframes orbThink {
      0%, 100% { 
        transform: scale(1); 
        filter: hue-rotate(0deg);
      }
      25% { transform: scale(1.05); }
      50% { 
        transform: scale(1.02); 
        filter: hue-rotate(15deg);
      }
      75% { transform: scale(1.06); }
    }

    @keyframes orbProcess {
      0% { transform: rotate(0deg) scale(1); }
      50% { transform: rotate(180deg) scale(1.05); }
      100% { transform: rotate(360deg) scale(1); }
    }

    /* Sound Wave Rings - Emanate when speaking */
    .sound-wave {
      position: absolute;
      border: 2px solid var(--gold-primary);
      border-radius: 50%;
      opacity: 0;
      pointer-events: none;
    }

    .orb-container.speaking .sound-wave {
      animation: soundWave 1.5s ease-out infinite;
    }

    .sound-wave:nth-child(1) { animation-delay: 0s; }
    .sound-wave:nth-child(2) { animation-delay: 0.3s; }
    .sound-wave:nth-child(3) { animation-delay: 0.6s; }

    @keyframes soundWave {
      0% {
        width: 260px;
        height: 260px;
        opacity: 0.6;
      }
      100% {
        width: 520px;
        height: 520px;
        opacity: 0;
      }
    }

    /* Thinking Particles - Float around when thinking */
    .thinking-particles {
      position: absolute;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }

    .thinking-particle {
      position: absolute;
      width: 6px;
      height: 6px;
      background: var(--gold-primary);
      border-radius: 50%;
      opacity: 0;
      box-shadow: 0 0 10px var(--gold-glow);
    }

    .orb-container.thinking .thinking-particle {
      animation: particleOrbit 3s linear infinite;
    }

    .thinking-particle:nth-child(1) { animation-delay: 0s; }
    .thinking-particle:nth-child(2) { animation-delay: 0.5s; }
    .thinking-particle:nth-child(3) { animation-delay: 1s; }
    .thinking-particle:nth-child(4) { animation-delay: 1.5s; }
    .thinking-particle:nth-child(5) { animation-delay: 2s; }
    .thinking-particle:nth-child(6) { animation-delay: 2.5s; }

    @keyframes particleOrbit {
      0% {
        transform: rotate(0deg) translateX(100px) scale(0);
        opacity: 0;
      }
      10% {
        opacity: 1;
        transform: rotate(36deg) translateX(100px) scale(1);
      }
      90% {
        opacity: 1;
        transform: rotate(324deg) translateX(100px) scale(1);
      }
      100% {
        transform: rotate(360deg) translateX(100px) scale(0);
        opacity: 0;
      }
    }

    /* Inner Pulse Ring - Visible when thinking */
    .inner-pulse {
      position: absolute;
      width: 100px;
      height: 100px;
      border: 2px solid var(--gold-primary);
      border-radius: 50%;
      opacity: 0;
    }

    .orb-container.thinking .inner-pulse {
      animation: innerPulse 1.5s ease-in-out infinite;
    }

    @keyframes innerPulse {
      0%, 100% { 
        transform: scale(0.8); 
        opacity: 0;
      }
      50% { 
        transform: scale(1.2); 
        opacity: 0.5;
      }
    }

    /* Orbital Rings - Surround Orb */
    .ring {
      position: absolute;
      border: 1px solid;
      border-radius: 50%;
      opacity: 0.3;
    }

    .ring-1 {
      width: 300px; height: 300px;
      border-color: var(--gold-primary);
      animation: rotate 12s linear infinite;
    }

    .ring-2 {
      width: 360px; height: 360px;
      border-color: var(--gold-secondary);
      animation: rotate 18s linear infinite reverse;
    }

    .ring-3 {
      width: 420px; height: 420px;
      border-color: var(--gold-dim);
      animation: rotate 25s linear infinite;
      border-style: dashed;
    }

    /* Speed up rings when thinking */
    .orb-container.thinking .ring-1 { animation-duration: 4s; opacity: 0.5; }
    .orb-container.thinking .ring-2 { animation-duration: 6s; opacity: 0.5; }
    .orb-container.thinking .ring-3 { animation-duration: 8s; opacity: 0.5; }

    /* Glow intensifies when speaking */
    .orb-container.speaking .ring-1 { opacity: 0.6; box-shadow: 0 0 20px var(--gold-glow); }
    .orb-container.speaking .ring-2 { opacity: 0.5; box-shadow: 0 0 15px var(--gold-glow); }

    @keyframes rotate {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    /* Status Label - Shows current AI state */
    .orb-status-label {
      position: absolute;
      bottom: -30px;
      left: 50%;
      transform: translateX(-50%);
      padding: 4px 16px;
      background: rgba(0, 0, 0, 0.7);
      border: 1px solid var(--glass-border);
      border-radius: 12px;
      font-size: 0.6rem;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: var(--gold-primary);
      white-space: nowrap;
    }

    .orb-status-label.thinking {
      color: var(--warning);
      border-color: var(--warning);
      animation: labelPulse 1s ease-in-out infinite;
    }

    .orb-status-label.speaking {
      color: var(--success);
      border-color: var(--success);
    }

    @keyframes labelPulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

    /* Top-Left Video Badge */
    .center-live-badge {
      position: absolute;
      top: 20px;
      left: 60px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      background: rgba(0, 0, 0, 0.75);
      border: 1px solid var(--success);
      border-radius: 6px;
      font-size: 0.6rem;
      color: var(--success);
      text-transform: uppercase;
      letter-spacing: 1px;
      z-index: 5;
    }

    .rec-dot {
      width: 8px;
      height: 8px;
      background: #ff0000;
      border-radius: 50%;
      animation: blink 1s ease-in-out infinite;
      box-shadow: 0 0 8px #ff0000;
    }

    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    /* Bottom-Right Frame Counter */
    .center-frame-counter {
      position: absolute;
      bottom: 20px;
      right: 60px;
      padding: 6px 12px;
      background: rgba(0, 0, 0, 0.75);
      border: 1px solid var(--glass-border);
      border-radius: 6px;
      font-size: 0.6rem;
      color: var(--gold-primary);
      font-variant-numeric: tabular-nums;
      z-index: 5;
    }

    /* Status Display - Bottom Center */
    .status-display {
      position: absolute;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      text-align: center;
      z-index: 5;
      padding: 8px 20px;
      background: rgba(0, 0, 0, 0.7);
      border-radius: 8px;
      border: 1px solid var(--glass-border);
    }

    .status-text {
      font-size: 0.9rem;
      text-transform: uppercase;
      letter-spacing: 4px;
      color: var(--gold-primary);
      text-shadow: 0 0 15px var(--gold-glow);
      font-weight: 600;
    }

    .status-text.thinking { color: var(--warning); }
    .status-text.speaking { color: var(--success); }

    .status-sub {
      font-size: 0.55rem;
      color: var(--text-muted);
      letter-spacing: 2px;
      margin-top: 4px;
    }

    /* No Camera Prompt */
    .no-camera-prompt {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1rem;
      z-index: 5;
      pointer-events: none;
    }

    .no-camera-prompt button {
      pointer-events: all;
    }

    .no-camera-prompt svg {
      color: var(--gold-dim);
      opacity: 0.5;
    }

    .enable-camera-btn {
      padding: 0.75rem 2rem;
      background: linear-gradient(135deg, var(--gold-primary) 0%, var(--gold-secondary) 100%);
      border: none;
      border-radius: 8px;
      color: #000;
      font-family: inherit;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      cursor: pointer;
      transition: all 0.3s;
      box-shadow: 0 4px 20px var(--gold-glow);
    }

    .enable-camera-btn:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 30px var(--gold-glow);
    }

    .camera-error-msg {
      font-size: 0.7rem;
      color: var(--danger);
      text-align: center;
      max-width: 280px;
    }

    /* ═══════════════════════════════════════════════════════════
       RIGHT PANEL - SYSTEM MODULES + LOG
       ═══════════════════════════════════════════════════════════ */
    .panel-right {
      grid-area: right;
      display: flex;
      flex-direction: column;
      border-left: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
      background: transparent;
      overflow: hidden;
      min-height: 0;
    }

    /* Header layout when the panel can collapse — title on the left,
       a small chevron toggle on the right. Mirrors the live-action
       sidebar collapse affordance so the gesture is consistent. */
    .panel-right .panel-header {
      gap: 8px;
    }

    .right-panel-collapse-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 0;
      margin-left: 4px;
      background: color-mix(in srgb, var(--g-primary) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
      border-radius: 4px;
      color: var(--gold-dim, var(--text-secondary));
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    }
    .right-panel-collapse-btn:hover {
      background: color-mix(in srgb, var(--g-primary) 16%, transparent);
      color: var(--gold-primary);
      border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
    }
    .right-panel-collapse-btn svg {
      width: 12px;
      height: 12px;
    }

    /* ── Collapsed state ──
       The grid track shrinks to RIGHT_PANEL_RAIL_WIDTH via
       --vc-right-width on :host. Inside the column we hide the header
       label, tabs, and content; only the expand button remains,
       centered vertically along the rail. */
    .hud-container.right-collapsed .panel-right {
      padding: 0;
    }
    .hud-container.right-collapsed .panel-right .panel-header {
      flex-direction: column;
      padding: 8px 0;
      border-bottom: none;
      justify-content: flex-start;
    }
    .hud-container.right-collapsed .panel-right .panel-title,
    .hud-container.right-collapsed .panel-right .panel-badge,
    .hud-container.right-collapsed .panel-right .right-panel-content {
      display: none !important;
    }
    .hud-container.right-collapsed .panel-right .right-panel-collapse-btn {
      margin-left: 0;
    }

    /* Tab Switcher */
    .right-panel-tabs {
      display: flex;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
      background: transparent;
    }

    .right-panel-tab {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 0.75rem;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--text-muted);
      font-family: inherit;
      font-size: 0.6rem;
      text-transform: uppercase;
      letter-spacing: 1px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .right-panel-tab:hover {
      color: var(--text-secondary);
      background: color-mix(in srgb, var(--g-primary) 3%, transparent);
    }

    .right-panel-tab.active {
      color: var(--gold-primary);
      border-bottom-color: var(--gold-primary);
      background: color-mix(in srgb, var(--g-primary) 5%, transparent);
    }

    .right-panel-tab svg {
      width: 12px;
      height: 12px;
    }

    .tab-badge {
      padding: 2px 6px;
      background: color-mix(in srgb, var(--g-primary) 15%, transparent);
      border-radius: 8px;
      font-size: 0.5rem;
      font-weight: 700;
    }

    .tab-badge.has-errors {
      background: rgba(255, 68, 68, 0.25);
      color: var(--danger);
    }

    .right-panel-content {
      flex: 1;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    /* System Modules */
    .modules-section {
      flex: 1;
      overflow-y: auto;
      padding: 0.75rem;
    }

    .module {
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--glass-border);
      border-radius: 8px;
      margin-bottom: 0.75rem;
      overflow: hidden;
    }

    .module-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem;
      background: var(--glass-highlight);
      cursor: pointer;
      transition: background 0.2s;
    }

    .module-header:hover {
      background: color-mix(in srgb, var(--g-primary) 5%, transparent);
    }

    .module-title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.6rem;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--gold-primary);
      font-weight: 600;
    }

    .module-title svg {
      width: 12px;
      height: 12px;
      opacity: 0.7;
    }

    .module-status {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 8px var(--success);
    }

    .module-status.warning { background: var(--warning); box-shadow: 0 0 8px var(--warning); }
    .module-status.off { background: var(--text-muted); box-shadow: none; }

    .module-content {
      padding: 0.75rem;
    }

    .module-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.35rem 0;
      font-size: 0.65rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.03);
    }

    .module-row:last-child { border-bottom: none; }

    .module-label { color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .module-value { color: var(--text-primary); }
    .module-value.gold { color: var(--gold-primary); }

    /* ═══════════════════════════════════════════════════════════
       MICROPHONE WAVEFORM VISUALIZER
       ═══════════════════════════════════════════════════════════ */
    .mic-waveform {
      display: flex;
      align-items: flex-end;
      justify-content: center;
      gap: 3px;
      height: 40px;
      padding: 8px 0;
      background: rgba(0, 0, 0, 0.3);
      border-radius: 6px;
      margin-top: 8px;
    }

    .mic-bar {
      width: 6px;
      min-height: 4px;
      background: linear-gradient(to top, var(--gold-dim) 0%, var(--gold-primary) 100%);
      border-radius: 3px;
      transition: height 0.05s ease;
    }

    .mic-bar.active {
      box-shadow: 0 0 8px var(--gold-glow);
    }

    .mic-bar.high {
      background: linear-gradient(to top, var(--gold-primary) 0%, var(--success) 100%);
    }

    .mic-bar.peak {
      background: linear-gradient(to top, var(--warning) 0%, #ff6600 100%);
    }

    /* Mic level text */
    .mic-level-text {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 0 0;
      font-size: 0.55rem;
    }

    .mic-level-label {
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .mic-level-value {
      color: var(--gold-primary);
      font-variant-numeric: tabular-nums;
      font-weight: 600;
    }

    .mic-level-value.speaking {
      color: var(--success);
    }

    /* ═══════════════════════════════════════════════════════════
       DEDICATED LOG SECTION
       ═══════════════════════════════════════════════════════════ */
    .log-section {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .log-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem;
      background: var(--glass-highlight);
      border-bottom: 1px solid var(--glass-border);
    }

    .log-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.6rem;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--gold-primary);
      font-weight: 600;
    }

    .log-title svg {
      width: 12px;
      height: 12px;
      opacity: 0.8;
    }

    .log-clear-btn {
      padding: 4px 10px;
      background: transparent;
      border: 1px solid var(--glass-border);
      border-radius: 4px;
      color: var(--text-muted);
      font-family: inherit;
      font-size: 0.5rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .log-clear-btn:hover {
      background: rgba(255, 68, 68, 0.1);
      border-color: var(--danger);
      color: var(--danger);
    }

    .log-content {
      flex: 1 1 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 0.5rem;
      font-size: 0.6rem;
      scroll-behavior: smooth;
      overscroll-behavior: contain;
      /* Same flexbox overflow trap as transcript-content — without min-height:0
         the panel grows to fit all log entries instead of scrolling. */
      min-height: 0;
    }

    .log-content::-webkit-scrollbar {
      width: 6px;
    }

    .log-content::-webkit-scrollbar-track {
      background: color-mix(in srgb, var(--g-primary) 3%, transparent);
      border-radius: 3px;
    }

    .log-content::-webkit-scrollbar-thumb {
      background: linear-gradient(180deg, var(--gold-primary) 0%, var(--gold-dim) 100%);
      border-radius: 3px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
    }

    .log-content::-webkit-scrollbar-thumb:hover {
      background: linear-gradient(180deg, var(--gold-primary) 0%, var(--gold-secondary) 100%);
    }

    /* Firefox scrollbar */
    .log-content {
      scrollbar-width: thin;
      scrollbar-color: var(--gold-dim) color-mix(in srgb, var(--g-primary) 3%, transparent);
    }

    .log-entry {
      display: flex;
      gap: 0.75rem;
      padding: 0.35rem 0.5rem;
      border-radius: 3px;
      animation: logSlideIn 0.2s ease-out;
    }

    @keyframes logSlideIn {
      from { opacity: 0; transform: translateX(-6px); }
      to { opacity: 1; transform: translateX(0); }
    }

    .log-entry:hover { background: rgba(255, 255, 255, 0.03); }

    .log-time { 
      color: var(--text-muted); 
      min-width: 55px; 
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }

    .log-text {
      flex: 1;
      word-break: break-word;
    }

    .log-entry.info .log-text { color: var(--gold-primary); }
    .log-entry.warn .log-text { color: var(--warning); }
    .log-entry.error .log-text { color: var(--danger); }
    .log-entry.system .log-text { color: var(--success); }

    .log-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--text-muted);
      font-size: 0.6rem;
      gap: 0.5rem;
    }

    .log-empty svg {
      opacity: 0.3;
    }

    /* ═══════════════════════════════════════════════════════════
       FOOTER CONTROLS
       ═══════════════════════════════════════════════════════════ */
    .hud-footer {
      grid-area: footer;
      background: transparent;
      border-top: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 2rem;
      gap: 1rem;
    }

    .control-group {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .divider {
      width: 1px;
      height: 32px;
      background: var(--glass-border);
      margin: 0 0.5rem;
    }

    .ctrl-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      padding: 0.6rem 1.25rem;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--glass-border);
      border-radius: 8px;
      color: var(--text-secondary);
      font-family: inherit;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 1px;
      cursor: pointer;
      transition: all 0.3s;
    }

    .ctrl-btn:hover {
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      border-color: var(--gold-dim);
      color: var(--gold-primary);
    }

    .ctrl-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .ctrl-btn.primary {
      background: linear-gradient(135deg, var(--gold-primary) 0%, var(--gold-secondary) 100%);
      border-color: var(--gold-primary);
      color: #000;
      font-weight: 700;
    }

    .ctrl-btn.primary:hover {
      box-shadow: 0 0 25px var(--gold-glow);
    }

    .ctrl-btn.active {
      background: color-mix(in srgb, var(--g-primary) 15%, transparent);
      border-color: var(--gold-primary);
      color: var(--gold-primary);
    }

    .hud-toggle-btn {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      letter-spacing: 0.05em;
      font-family: 'JetBrains Mono', monospace;
    }
    .hud-toggle-btn.active {
      background: rgba(0, 200, 150, 0.15);
      border-color: #00c896;
      color: #00c896;
      box-shadow: 0 0 12px rgba(0, 200, 150, 0.3);
    }

    .ctrl-btn.danger {
      border-color: var(--danger);
      color: var(--danger);
    }

    .ctrl-btn.danger:hover {
      background: rgba(255, 68, 68, 0.15);
    }

    /* Main Mic Button with Waveform Ring */
    .mic-btn-wrapper {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .mic-btn {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--gold-primary) 0%, var(--gold-secondary) 100%);
      border: 3px solid rgba(255, 255, 255, 0.2);
      color: #000;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.3s;
      box-shadow: 0 0 30px var(--gold-glow);
      position: relative;
      z-index: 2;
    }

    .mic-btn:hover {
      transform: scale(1.1);
      box-shadow: 0 0 50px var(--gold-glow);
    }

    .mic-btn.muted {
      background: linear-gradient(135deg, var(--danger) 0%, #aa2222 100%);
      box-shadow: 0 0 30px rgba(255, 68, 68, 0.4);
    }

    .mic-btn.speaking {
      animation: micPulse 0.3s ease-in-out infinite alternate;
    }

    .mic-btn.local-stt.recording {
      background: linear-gradient(135deg, #ff4444 0%, #cc2222 100%);
      box-shadow: 0 0 30px rgba(255, 68, 68, 0.6);
      animation: micPulse 0.3s ease-in-out infinite alternate;
    }

    .mic-btn.local-stt.transcribing {
      background: linear-gradient(135deg, #4488ff 0%, #2266cc 100%);
      box-shadow: 0 0 30px rgba(68, 136, 255, 0.6);
    }

    .mic-btn-wrapper.recording .mic-activity-ring {
      border-color: #ff4444;
      opacity: 0.8;
      animation: micRingPulse 0.5s ease-out infinite;
    }

    .mic-label {
      position: absolute;
      bottom: -18px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 8px;
      color: var(--gold-primary);
      letter-spacing: 1px;
      white-space: nowrap;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    /* Small inline spinner for the voice-mode toggle. Sized to sit
       beside the "Switching…" label without expanding the button. */
    .vc-mode-spinner {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      border: 1.5px solid color-mix(in srgb, var(--g-primary, #caa45a) 30%, transparent);
      border-top-color: var(--g-primary, #caa45a);
      animation: spin 0.8s linear infinite;
      flex-shrink: 0;
    }
    .vc-mode-toggle.switching {
      pointer-events: none;
    }

    /* Stylish gear button beside the transcript toggle — opens the model
       & voice settings overlay. Matches the toggle's 6px radius and gold
       palette but presents as a square icon button with a subtle gradient
       backing and rotate-on-hover gear. */
    .vc-model-settings-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      padding: 0;
      border-radius: 6px;
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 55%, transparent);
      background: linear-gradient(
        135deg,
        color-mix(in srgb, var(--g-primary, #caa45a) 14%, transparent),
        color-mix(in srgb, var(--g-primary, #caa45a) 4%, transparent)
      );
      color: var(--g-primary, #caa45a);
      cursor: pointer;
      transition: background 160ms ease, border-color 160ms ease,
                  transform 160ms ease, box-shadow 200ms ease;
      flex-shrink: 0;
    }
    .vc-model-settings-btn svg {
      width: 14px;
      height: 14px;
      transition: transform 400ms cubic-bezier(.4,.2,.2,1);
    }
    .vc-model-settings-btn:hover {
      border-color: var(--g-primary, #caa45a);
      background: linear-gradient(
        135deg,
        color-mix(in srgb, var(--g-primary, #caa45a) 24%, transparent),
        color-mix(in srgb, var(--g-primary, #caa45a) 10%, transparent)
      );
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--g-primary, #caa45a) 35%, transparent),
                  0 2px 10px -2px color-mix(in srgb, var(--g-primary, #caa45a) 45%, transparent);
    }
    .vc-model-settings-btn:hover svg {
      transform: rotate(60deg);
    }
    .vc-model-settings-btn:active {
      transform: scale(0.94);
    }
    .vc-model-settings-btn.active {
      background: color-mix(in srgb, var(--g-primary, #caa45a) 22%, transparent);
      border-color: var(--g-primary, #caa45a);
    }
    .vc-model-settings-btn.active svg {
      transform: rotate(120deg);
    }

    @keyframes micPulse {
      from { transform: scale(1); }
      to { transform: scale(1.08); }
    }

    /* Mic Activity Ring */
    .mic-activity-ring {
      position: absolute;
      width: 72px;
      height: 72px;
      border-radius: 50%;
      border: 2px solid var(--gold-primary);
      opacity: 0;
      transition: all 0.2s ease;
    }

    .mic-btn-wrapper.active .mic-activity-ring {
      opacity: 0.5;
      animation: micRingPulse 0.5s ease-out infinite;
    }

    @keyframes micRingPulse {
      0% {
        transform: scale(1);
        opacity: 0.5;
      }
      100% {
        transform: scale(1.3);
        opacity: 0;
      }
    }

    /* ═══════════════════════════════════════════════════════════
       SETTINGS OVERLAY
       ═══════════════════════════════════════════════════════════ */
    .settings-overlay {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(10px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s;
    }

    .settings-overlay.open {
      opacity: 1;
      pointer-events: all;
    }

    .settings-card {
      /* Responsive width + capped height so the whole panel always fits the
         viewport; the header is pinned and the content scrolls (see
         .settings-content) instead of being clipped off-screen. */
      width: min(440px, 92vw);
      max-height: 88vh;
      display: flex;
      flex-direction: column;
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 0 40px var(--gold-glow);
    }

    .settings-header {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.25rem;
      background: var(--glass-highlight);
      border-bottom: 1px solid var(--glass-border);
    }

    .settings-title {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: var(--gold-primary);
      font-weight: 600;
    }

    .settings-close {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: transparent;
      border: 1px solid var(--glass-border);
      color: var(--text-muted);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s;
    }

    .settings-close:hover {
      background: rgba(255, 68, 68, 0.1);
      border-color: var(--danger);
      color: var(--danger);
    }

    .settings-content {
      padding: 1.25rem;
      /* Scroll the options when they exceed the capped card height so every
         control (incl. the voice-stack settings + Save button) stays reachable
         on short windows. min-height:0 lets this flex child actually shrink. */
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
    }

    .setting-group {
      margin-bottom: 1.25rem;
    }

    .setting-label {
      font-size: 0.6rem;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-muted);
      margin-bottom: 0.5rem;
      display: block;
    }

    .setting-select {
      width: 100%;
      padding: 0.65rem 0.875rem;
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid var(--glass-border);
      border-radius: 6px;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 0.8rem;
      cursor: pointer;
      transition: border-color 0.2s;
    }

    .setting-select:focus {
      outline: none;
      border-color: var(--gold-primary);
    }

    .setting-toggle {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.65rem 0;
    }

    .toggle-switch {
      width: 40px;
      height: 22px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 11px;
      cursor: pointer;
      position: relative;
      transition: background 0.3s;
    }

    .toggle-switch.active {
      background: color-mix(in srgb, var(--g-primary) 30%, transparent);
    }

    .toggle-switch::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 18px;
      height: 18px;
      background: var(--text-secondary);
      border-radius: 50%;
      transition: all 0.3s;
    }

    .toggle-switch.active::after {
      transform: translateX(18px);
      background: var(--gold-primary);
      box-shadow: 0 0 8px var(--gold-glow);
    }

    .settings-save {
      width: 100%;
      padding: 0.875rem;
      background: linear-gradient(135deg, var(--gold-primary) 0%, var(--gold-secondary) 100%);
      border: none;
      border-radius: 6px;
      color: #000;
      font-family: inherit;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      cursor: pointer;
      transition: all 0.3s;
    }

    .settings-save:hover {
      box-shadow: 0 0 25px var(--gold-glow);
    }

    /* ── Modular voice stack additions ── */
    .vss-divider { height: 1px; background: var(--glass-border); margin: 1.25rem 0 1rem; }
    .vss-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
    .vss-mode {
        padding: 12px; border-radius: 8px; cursor: pointer;
        background: rgba(255,255,255,0.03); border: 1px solid var(--glass-border);
        transition: border-color .15s, background .15s;
    }
    .vss-mode:hover { border-color: var(--gold-primary); }
    .vss-mode.selected { border-color: var(--gold-primary); background: color-mix(in srgb, var(--gold-primary) 8%, transparent); }
    .vss-mode-name { font-size: 0.8rem; font-weight: 600; margin-bottom: 4px; color: var(--text-primary); display: flex; align-items: center; gap: 6px; }
    .vss-mode-desc { font-size: 0.68rem; color: var(--text-muted); line-height: 1.4; }
    .vss-tag {
        font-size: 0.55rem; font-weight: 700; letter-spacing: .5px; text-transform: uppercase;
        padding: 1px 5px; border-radius: 4px; color: #000; background: var(--gold-primary);
    }
    .vss-hint { font-size: 0.68rem; color: var(--text-muted); margin-top: 6px; }
    .vss-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
    .vss-statuses { display: flex; flex-direction: column; gap: 4px; margin-bottom: 4px; }
    .vss-status { font-size: 0.7rem; line-height: 1.4; }
    .vss-status.ok { color: var(--success, #22c55e); }
    .vss-status.err { color: var(--error, #ef4444); }
    .vss-status.info { color: var(--text-muted); }
    .vss-btn {
        padding: 8px 14px; border-radius: 6px; font-size: 0.72rem; font-weight: 600;
        border: 1px solid var(--glass-border); cursor: pointer;
        display: inline-flex; align-items: center; gap: 6px;
    }
    .vss-btn:disabled { opacity: 0.55; cursor: default; }
    .vss-btn.ghost { background: rgba(255,255,255,0.05); color: var(--text-primary); }
    .vss-btn.ghost:hover:not(:disabled) { border-color: var(--gold-primary); }
    .vss-btn.primary {
        background: linear-gradient(135deg, var(--gold-primary), var(--gold-secondary));
        color: #000; border: none;
    }
    .vss-btn.primary:hover:not(:disabled) { box-shadow: 0 0 18px var(--gold-glow); }

    /* Device Selection */
    .device-select {
      width: 100%;
      padding: 0.5rem 0.65rem;
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid var(--glass-border);
      border-radius: 4px;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 0.65rem;
      cursor: pointer;
      margin-top: 0.35rem;
    }

    .device-select:focus {
      outline: none;
      border-color: var(--gold-primary);
    }

    .device-select option {
      background: #1a1a1a;
      color: var(--text-primary);
    }

    /* ═══════════════════════════════════════════════════════════
       JARVIS HUD THEME — additive overlay applied on top of the
       default glass-panel base. Activates when liveActionMode is
       OFF (the slim sidebar mode keeps its own look). Inspired by
       the Iron Man HUD reference: deep navy field, cyan accents,
       reticle rings around the central blob, corner brackets, and
       tech-styled glass panels with mono labels.
       ═══════════════════════════════════════════════════════════ */
    :host {
      /* HUD accent === theme accent. Resolves at runtime against whichever
         theme is active so the entire voice page recolors when the user
         changes theme (hud / dark / light / system). The fallbacks keep
         the page styled even if the theme module hasn't applied yet. */
      --hud-accent:        var(--g-primary, #fbbf24);
      --hud-accent-strong: var(--g-primary-strong, color-mix(in srgb, var(--g-primary) 35%, transparent));
      --hud-accent-muted:  var(--g-primary-muted,  color-mix(in srgb, var(--g-primary) 18%, transparent));
      --hud-accent-soft:   var(--g-primary-soft,   color-mix(in srgb, var(--g-primary) 8%,  transparent));
      --hud-accent-faint:  color-mix(in srgb, var(--g-primary) 4%, transparent);
      --hud-glow-strong:   color-mix(in srgb, var(--g-primary) 55%, transparent);
      --hud-glow-mid:      color-mix(in srgb, var(--g-primary) 30%, transparent);
      --hud-glow-soft:     color-mix(in srgb, var(--g-primary) 12%, transparent);
      --hud-mono: "JetBrains Mono", "Fira Code", ui-monospace, monospace;
    }

    /* Blob-centre tracking var, consumed by the single-plane container +
       backdrop rules below (the live cascade winner). Defined here on the
       container so the radial fills stay locked to the blob as panels resize. */
    .hud-container:not(.live-action-on) {
      --vc-blob-cx: calc(
        (var(--vc-left-width, 440px) + 6px + 100% - var(--vc-right-width, 300px)) / 2);
      border: 1px solid var(--hud-accent-strong);
    }

    /* Faint tech grid floor — only visible inside the central viewport */
    .hud-container:not(.live-action-on)::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 0;
      background-image:
        linear-gradient(color-mix(in srgb, var(--g-primary) 5%, transparent) 1px, transparent 1px),
        linear-gradient(90deg, color-mix(in srgb, var(--g-primary) 5%, transparent) 1px, transparent 1px);
      background-size: 48px 48px, 48px 48px;
      background-position: center center;
      mask-image: radial-gradient(ellipse 60% 50% at 50% 50%, black 0%, transparent 75%);
      -webkit-mask-image: radial-gradient(ellipse 60% 50% at 50% 50%, black 0%, transparent 75%);
      opacity: 0.7;
    }

    /* Corner brackets — top + bottom of the hud-container */
    .hud-container:not(.live-action-on) > .hud-frame-corners {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 2;
    }
    .hud-frame-corners .corner-mark {
      position: absolute;
      width: 28px; height: 28px;
      border: 1.5px solid var(--hud-accent);
      filter: drop-shadow(0 0 6px color-mix(in srgb, var(--g-primary) 55%, transparent));
    }
    .hud-frame-corners .corner-mark.tl { top: 14px; left: 14px;
      border-right: 0; border-bottom: 0; }
    .hud-frame-corners .corner-mark.tr { top: 14px; right: 14px;
      border-left: 0; border-bottom: 0; }
    .hud-frame-corners .corner-mark.bl { bottom: 14px; left: 14px;
      border-right: 0; border-top: 0; }
    .hud-frame-corners .corner-mark.br { bottom: 14px; right: 14px;
      border-left: 0; border-top: 0; }

    /* ───────────────────────────────────────────────────────────
       BLOB RETICLE STACK
       Three concentric layers, all centered on the blob:
         · ::before — outermost thin dashed ring, slow CW drift.
         · ::after  — middle bright ring with cardinal tick wedges
                      built into a conic gradient + outward glow.
         · .orb-reticle — inner fine reticle of major+minor ticks,
                      slow CCW for parallax.
       All three use inset for positioning so the rotation keyframe
       only needs rotate() — no translate() (which was the source
       of the previous off-center drift).
       ─────────────────────────────────────────────────────────── */

    /* Layer 1 — STATIC HAIRLINE BOUNDARY
       Single ultra-thin ring just past the blob silhouette. Sets a
       precise edge without burning compositor cycles on rotation.
       0.6px on retina, anti-aliased to a clean sub-pixel line. */
    .hud-container:not(.live-action-on) .orb-container.webgl-mode::before {
      content: "";
      position: absolute;
      inset: -4%;
      border-radius: 50%;
      pointer-events: none;
      border: 1px solid color-mix(in srgb, var(--g-primary) 24%, transparent);
      box-shadow:
        inset 0 0 1px color-mix(in srgb, var(--g-primary) 40%, transparent),
        0 0 10px color-mix(in srgb, var(--g-primary) 8%, transparent);
    }

    /* Layer 2 — SWEEP ARC
       One long fading wedge that rotates like a radar sweep. The
       hard leading edge fades into a soft trailing tail (long alpha
       ramp). Single moving element — restrained, premium. */
    .hud-container:not(.live-action-on) .orb-container.webgl-mode::after {
      content: "";
      position: absolute;
      inset: -11%;
      border-radius: 50%;
      pointer-events: none;
      background:
        conic-gradient(from 0deg,
          var(--hud-accent) 0deg,
          color-mix(in srgb, var(--g-primary) 60%, transparent) 8deg,
          color-mix(in srgb, var(--g-primary) 25%, transparent) 60deg,
          color-mix(in srgb, var(--g-primary) 8%,  transparent) 130deg,
          transparent 170deg,
          transparent 360deg);
      -webkit-mask: radial-gradient(circle, transparent 48.8%, black 49.2%, black 50.4%, transparent 50.8%);
              mask: radial-gradient(circle, transparent 48.8%, black 49.2%, black 50.4%, transparent 50.8%);
      filter: drop-shadow(0 0 5px color-mix(in srgb, var(--g-primary) 55%, transparent));
      animation: hud-rot-self-cw 22s linear infinite;
      transform-origin: 50% 50%;
    }

    /* Layer 3 — CARDINAL RETICLE
       Four crisp position marks at N/E/S/W plus four secondary marks
       at the intercardinals — short, hairline, no clutter. Slow
       counter-rotation for parallax against the sweep. */
    .hud-container:not(.live-action-on) .orb-reticle {
      position: absolute;
      inset: -16%;
      pointer-events: none;
      border-radius: 50%;
      background:
        conic-gradient(from 0deg,
          var(--hud-accent) 0deg 0.6deg,   transparent 0.6deg 45deg,
          color-mix(in srgb, var(--g-primary) 35%, transparent) 45deg 45.5deg,
          transparent 45.5deg 90deg,
          var(--hud-accent) 90deg 90.6deg, transparent 90.6deg 135deg,
          color-mix(in srgb, var(--g-primary) 35%, transparent) 135deg 135.5deg,
          transparent 135.5deg 180deg,
          var(--hud-accent) 180deg 180.6deg, transparent 180.6deg 225deg,
          color-mix(in srgb, var(--g-primary) 35%, transparent) 225deg 225.5deg,
          transparent 225.5deg 270deg,
          var(--hud-accent) 270deg 270.6deg, transparent 270.6deg 315deg,
          color-mix(in srgb, var(--g-primary) 35%, transparent) 315deg 315.5deg,
          transparent 315.5deg 360deg);
      -webkit-mask: radial-gradient(circle, transparent 47%, black 47.4%, black 49.4%, transparent 49.8%);
              mask: radial-gradient(circle, transparent 47%, black 47.4%, black 49.4%, transparent 49.8%);
      filter: drop-shadow(0 0 3px color-mix(in srgb, var(--g-primary) 50%, transparent));
      opacity: 0.92;
      animation: hud-rot-self-ccw 180s linear infinite;
      transform-origin: 50% 50%;
    }

    /* Translate-free rotation keyframes — used by inset-positioned
       layers. The original hud-rot-cw/ccw still ship for any
       layers using left/top:50% + translate(-50%,-50%). */
    @keyframes hud-rot-self-cw  { from { transform: rotate(0); }       to { transform: rotate(360deg); } }
    @keyframes hud-rot-self-ccw { from { transform: rotate(0); }       to { transform: rotate(-360deg); } }
    @keyframes hud-rot-cw       { from { transform: translate(-50%,-50%) rotate(0); } to { transform: translate(-50%,-50%) rotate(360deg); } }
    @keyframes hud-rot-ccw      { from { transform: translate(-50%,-50%) rotate(0); } to { transform: translate(-50%,-50%) rotate(-360deg); } }

    /* Edge legibility scrim for the frosted side columns (the columns' frosted
       glass itself is set in the cascade-winning block further down). This
       ::before darkens the OUTER frame edge — where the transcript / right-rail
       text lives — and dissolves to fully transparent toward the blob, so text
       stays readable over the busy mesh while the column never reads as a solid
       tile. Sits behind the panel content (z:-1). */
    .hud-container:not(.live-action-on) .panel-left,
    .hud-container:not(.live-action-on) .panel-right {
      position: relative;
    }
    .hud-container:not(.live-action-on) .panel-left::before,
    .hud-container:not(.live-action-on) .panel-right::before {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: -1;
    }
    /* Conversation column reads as bare floating text now — legibility lives
       in per-glyph text-shadow, not a panel fill. Keep only a whisper-thin
       vignette pinned to the outer frame edge so the column never appears as
       a solid card/tile behind the messages. */
    .hud-container:not(.live-action-on) .panel-left::before {
      background:
        linear-gradient(90deg,
          rgba(4, 10, 20, 0.24) 0%,
          rgba(4, 10, 20, 0.08) 34%,
          transparent 64%);
    }
    .hud-container:not(.live-action-on) .panel-right::before {
      background:
        linear-gradient(270deg,
          rgba(4, 10, 20, 0.55) 0%,
          rgba(4, 10, 20, 0.30) 55%,
          transparent 100%);
    }
    /* Subtle tech ticker scanline traveling down each side panel */
    .hud-container:not(.live-action-on) .panel-left::after,
    .hud-container:not(.live-action-on) .panel-right::after {
      content: "";
      position: absolute;
      left: 0; right: 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--hud-accent), transparent);
      opacity: 0.45;
      filter: drop-shadow(0 0 4px var(--hud-accent));
      animation: hud-scan 9s ease-in-out infinite;
    }
    @keyframes hud-scan {
      0%   { top: 5%;  opacity: 0; }
      10%  { opacity: 0.55; }
      90%  { opacity: 0.55; }
      100% { top: 96%; opacity: 0; }
    }

    /* Panel header / title text → mono cyan caps with a tech bar */
    .hud-container:not(.live-action-on) .panel-header .panel-title,
    .hud-container:not(.live-action-on) .panel-header .panel-title svg + span,
    .hud-container:not(.live-action-on) .panel-header .panel-title span {
      color: var(--hud-accent);
      font-family: var(--hud-mono);
      font-weight: 600;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      font-size: 11px;
      text-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 40%, transparent);
    }
    .hud-container:not(.live-action-on) .panel-header {
      border-bottom: 1px solid var(--hud-accent-strong) !important;
      background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 6%, transparent), transparent);
    }

    /* HUD header bar (top of layout) — make it a tech strip */
    .hud-container:not(.live-action-on) .hud-header {
      border-bottom: 1px solid var(--hud-accent-strong) !important;
      background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 5%, transparent), transparent) !important;
    }
    .hud-container:not(.live-action-on) .hud-header .system-title,
    .hud-container:not(.live-action-on) .hud-header .header-status,
    .hud-container:not(.live-action-on) .hud-header span {
      font-family: var(--hud-mono);
      letter-spacing: 1.4px;
    }
    .hud-container:not(.live-action-on) .hud-header .system-title {
      color: var(--hud-accent);
      text-shadow: 0 0 10px color-mix(in srgb, var(--g-primary) 50%, transparent);
    }

    /* Status display under the blob — chunky cyan tech readout */
    .hud-container:not(.live-action-on) .status-display {
      font-family: var(--hud-mono);
    }
    .hud-container:not(.live-action-on) .status-text {
      color: var(--hud-accent) !important;
      text-shadow: 0 0 12px color-mix(in srgb, var(--g-primary) 65%, transparent) !important;
      letter-spacing: 3px !important;
      font-weight: 700;
    }
    .hud-container:not(.live-action-on) .status-sub {
      color: color-mix(in srgb, var(--g-primary) 55%, transparent) !important;
      letter-spacing: 1.2px !important;
    }

    /* Log lines as tech telemetry strip */
    .hud-container:not(.live-action-on) .vc-left-log,
    .hud-container:not(.live-action-on) .log-content,
    .hud-container:not(.live-action-on) .log-stream {
      font-family: var(--hud-mono);
      font-size: 10.5px;
      color: color-mix(in srgb, var(--g-primary) 78%, transparent);
    }
    .hud-container:not(.live-action-on) .log-line {
      border-bottom: 1px dashed color-mix(in srgb, var(--g-primary) 8%, transparent) !important;
    }

    /* Settings panel — already premium; layer in the cyan accent */
    .hud-container:not(.live-action-on) .blob-settings-panel {
      border-color: var(--hud-accent-strong) !important;
      box-shadow:
        0 18px 48px rgba(0, 0, 0, 0.7),
        0 0 24px color-mix(in srgb, var(--g-primary) 8%, transparent),
        0 0 0 1px color-mix(in srgb, var(--g-primary) 4%, transparent) inset !important;
    }
    .hud-container:not(.live-action-on) .blob-settings-title {
      color: var(--hud-accent) !important;
      text-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 40%, transparent);
    }
    .hud-container:not(.live-action-on) .blob-section-head .chevron {
      color: var(--hud-accent-strong) !important;
    }
    .hud-container:not(.live-action-on) .blob-section-head.open .chevron {
      color: var(--hud-accent) !important;
    }
    .hud-container:not(.live-action-on) .blob-style-toggle {
      border-color: var(--hud-accent-strong) !important;
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--g-primary) 5%, transparent) inset,
        0 4px 14px rgba(0, 0, 0, 0.6),
        0 0 18px color-mix(in srgb, var(--g-primary) 18%, transparent) !important;
    }

    /* ───────────────────────────────────────────────────────────
       FLOATING LOG TELEMETRY — detach the log pane from its column
       and present it as a glass HUD readout card. Per-corner accent
       brackets, a tech header strip, and a slow scanline travelling
       down the body so it reads as "live data".
       ─────────────────────────────────────────────────────────── */
    .hud-container:not(.live-action-on) .vc-left-log {
      position: relative;
      margin: 8px 10px 10px 10px;
      padding: 0;
      height: calc(var(--vc-left-split, 240px) - 14px);
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--g-primary) 8%, rgba(4, 10, 18, 0.78)) 0%,
          rgba(2, 6, 12, 0.82) 100%);
      border: 1px solid var(--hud-accent-strong) !important;
      border-radius: 10px;
      backdrop-filter: blur(14px) saturate(140%);
      -webkit-backdrop-filter: blur(14px) saturate(140%);
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--g-primary) 4%, transparent) inset,
        0 0 22px color-mix(in srgb, var(--g-primary) 8%, transparent) inset,
        0 14px 36px rgba(0, 0, 0, 0.55),
        0 0 32px color-mix(in srgb, var(--g-primary) 8%, transparent);
      overflow: hidden;
      isolation: isolate;
    }
    .hud-container:not(.live-action-on) .vc-left-log::before,
    .hud-container:not(.live-action-on) .vc-left-log::after {
      content: "";
      position: absolute;
      width: 14px; height: 14px;
      border: 1.5px solid var(--hud-accent);
      filter: drop-shadow(0 0 4px var(--hud-glow-strong));
      pointer-events: none;
      z-index: 3;
    }
    .hud-container:not(.live-action-on) .vc-left-log::before {
      top: 6px; left: 6px; border-right: 0; border-bottom: 0;
    }
    .hud-container:not(.live-action-on) .vc-left-log::after {
      bottom: 6px; right: 6px; border-left: 0; border-top: 0;
    }
    .hud-container:not(.live-action-on) .vc-left-log > .panel-header {
      background: linear-gradient(180deg,
        color-mix(in srgb, var(--g-primary) 14%, transparent),
        color-mix(in srgb, var(--g-primary) 4%, transparent)) !important;
      border-bottom: 1px solid var(--hud-accent-strong) !important;
      padding: 8px 14px !important;
    }
    .hud-container:not(.live-action-on) .vc-left-log > .panel-header::after {
      content: "▮ TELEMETRY";
      position: absolute;
      right: 12px;
      font-family: var(--hud-mono);
      font-size: 9.5px;
      letter-spacing: 1.6px;
      color: var(--hud-accent);
      text-shadow: 0 0 6px var(--hud-glow-strong);
      opacity: 0.85;
    }
    .hud-container:not(.live-action-on) .vc-left-log .panel-header {
      position: relative;
    }
    /* Slow horizontal scanline drifting down the log body */
    .hud-container:not(.live-action-on) .vc-left-log .log-content::before {
      content: "";
      position: absolute;
      left: 8px; right: 8px;
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--hud-accent), transparent);
      filter: drop-shadow(0 0 4px var(--hud-accent));
      opacity: 0.5;
      animation: hud-log-scan 7s ease-in-out infinite;
      pointer-events: none;
      z-index: 2;
    }
    .hud-container:not(.live-action-on) .vc-left-log .log-content {
      position: relative;
      padding: 8px 12px !important;
    }
    @keyframes hud-log-scan {
      0%   { top: 10%;  opacity: 0; }
      12%  { opacity: 0.5; }
      88%  { opacity: 0.5; }
      100% { top: 96%;  opacity: 0; }
    }

    /* ───────────────────────────────────────────────────────────
       FLOATING SYSTEM MODULES — reskin the right-rail modules so
       each one reads like an instrument card on the HUD: cyan
       outlines, mono caption, tiny corner accents, animated
       status pip pulsing on a theme color.
       ─────────────────────────────────────────────────────────── */
    .hud-container:not(.live-action-on) .panel-right .modules-section {
      padding: 10px !important;
    }
    .hud-container:not(.live-action-on) .module {
      position: relative;
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--g-primary) 6%, rgba(4, 10, 18, 0.72)) 0%,
          rgba(2, 6, 12, 0.78) 100%) !important;
      border: 1px solid var(--hud-accent-strong) !important;
      border-radius: 10px !important;
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--g-primary) 4%, transparent) inset,
        0 0 14px color-mix(in srgb, var(--g-primary) 6%, transparent) inset,
        0 8px 22px rgba(0, 0, 0, 0.5) !important;
      isolation: isolate;
      overflow: hidden;
    }
    .hud-container:not(.live-action-on) .module::before {
      content: "";
      position: absolute;
      top: 4px; left: 4px;
      width: 10px; height: 10px;
      border: 1.5px solid var(--hud-accent);
      border-right: 0; border-bottom: 0;
      filter: drop-shadow(0 0 3px var(--hud-glow-strong));
      pointer-events: none;
    }
    .hud-container:not(.live-action-on) .module::after {
      content: "";
      position: absolute;
      bottom: 4px; right: 4px;
      width: 10px; height: 10px;
      border: 1.5px solid var(--hud-accent);
      border-left: 0; border-top: 0;
      filter: drop-shadow(0 0 3px var(--hud-glow-strong));
      pointer-events: none;
    }
    .hud-container:not(.live-action-on) .module-header {
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--g-primary) 14%, transparent),
          color-mix(in srgb, var(--g-primary) 4%, transparent)) !important;
      border-bottom: 1px solid var(--hud-accent-strong) !important;
    }
    .hud-container:not(.live-action-on) .module-title {
      color: var(--hud-accent) !important;
      font-family: var(--hud-mono);
      text-shadow: 0 0 6px var(--hud-glow-strong);
      letter-spacing: 1.6px;
    }
    .hud-container:not(.live-action-on) .module-status {
      animation: hud-pip-pulse 2s ease-in-out infinite;
    }
    .hud-container:not(.live-action-on) .module-row {
      border-bottom: 1px dashed color-mix(in srgb, var(--g-primary) 10%, transparent) !important;
    }
    .hud-container:not(.live-action-on) .module-label {
      color: color-mix(in srgb, var(--g-primary) 65%, transparent) !important;
      font-family: var(--hud-mono);
      font-size: 0.6rem;
    }
    .hud-container:not(.live-action-on) .module-value {
      color: var(--hud-accent) !important;
      font-family: var(--hud-mono);
      text-shadow: 0 0 4px var(--hud-glow-mid);
    }
    @keyframes hud-pip-pulse {
      0%, 100% { transform: scale(1);   box-shadow: 0 0 8px currentColor; }
      50%      { transform: scale(1.3); box-shadow: 0 0 14px currentColor; }
    }

    /* ───────────────────────────────────────────────────────────
       TOOL-CALL / THINKING SPIN RINGS
       Two conic-gradient rings around the blob that ramp in when
       the agent is thinking or running a tool call. The aiState
       'thinking' state covers both: Claude Code in terminal mode,
       transcript agent tool dispatch, and gateway agent processing.
       At rest the rings sit at zero opacity so they don't compete
       with the static reticle marks.
       ─────────────────────────────────────────────────────────── */
    .hud-container:not(.live-action-on) .orb-spin-ring {
      position: absolute;
      left: 50%; top: 50%;
      pointer-events: none;
      border-radius: 50%;
      opacity: 0;
      transition: opacity 0.32s ease;
      transform: translate(-50%, -50%);
      width: 116%;
      height: 116%;
      /* Bright wedge sweep + dim trailing band */
      background: conic-gradient(
        from 0deg,
        transparent 0deg,
        color-mix(in srgb, var(--g-primary) 35%, transparent) 18deg,
        var(--hud-accent) 28deg,
        color-mix(in srgb, white 60%, var(--hud-accent)) 40deg,
        var(--hud-accent) 52deg,
        color-mix(in srgb, var(--g-primary) 35%, transparent) 62deg,
        transparent 80deg,
        transparent 360deg);
      -webkit-mask: radial-gradient(circle, transparent 47.5%, black 48%, black 49.6%, transparent 50.2%);
              mask: radial-gradient(circle, transparent 47.5%, black 48%, black 49.6%, transparent 50.2%);
      filter: drop-shadow(0 0 6px var(--hud-glow-strong));
      animation: hud-spin-cw 1.4s linear infinite;
    }
    .hud-container:not(.live-action-on) .orb-spin-ring.inner {
      width: 96%;
      height: 96%;
      animation: hud-spin-ccw 2.2s linear infinite;
      background: conic-gradient(
        from 180deg,
        transparent 0deg,
        color-mix(in srgb, var(--g-primary) 25%, transparent) 20deg,
        var(--hud-accent) 36deg,
        color-mix(in srgb, var(--g-primary) 25%, transparent) 52deg,
        transparent 72deg,
        transparent 360deg);
      -webkit-mask: radial-gradient(circle, transparent 46.5%, black 47%, black 48%, transparent 48.5%);
              mask: radial-gradient(circle, transparent 46.5%, black 47%, black 48%, transparent 48.5%);
      filter: drop-shadow(0 0 4px var(--hud-glow-mid));
    }
    .hud-container:not(.live-action-on) .orb-container.thinking .orb-spin-ring {
      opacity: 1;
    }
    /* Subtle "armed" version when speaking — agent is producing audio
       but not necessarily running a tool. Keeps motion alive without
       being as aggressive as the thinking spin. */
    .hud-container:not(.live-action-on) .orb-container.speaking .orb-spin-ring {
      opacity: 0.35;
      animation-duration: 3s;
    }
    @keyframes hud-spin-cw  { from { transform: translate(-50%,-50%) rotate(0); }    to { transform: translate(-50%,-50%) rotate(360deg); } }
    @keyframes hud-spin-ccw { from { transform: translate(-50%,-50%) rotate(0); }    to { transform: translate(-50%,-50%) rotate(-360deg); } }

    /* ───────────────────────────────────────────────────────────
       MULTI-INSTANCE FOCUS THROTTLE
       When the host page loses OS focus (user switched to another
       InfiniBot instance / monitor), pause every keyframed
       compositor animation so the four background tabs stop
       burning GPU. Re-enabled instantly when focus returns. The
       WebGL blob is throttled in parallel via voiceBlob.setIntensity().
       ─────────────────────────────────────────────────────────── */
    :host(.tab-unfocused) .orb-container.webgl-mode::before,
    :host(.tab-unfocused) .orb-container.webgl-mode::after,
    :host(.tab-unfocused) .orb-reticle,
    :host(.tab-unfocused) .orb-spin-ring,
    :host(.tab-unfocused) .vc-left-log .log-content::before,
    :host(.tab-unfocused) .panel-left::after,
    :host(.tab-unfocused) .panel-right::after,
    :host(.tab-unfocused) .module-status {
      animation-play-state: paused !important;
    }

    /* ═══════════════════════════════════════════════════════════════════
       FLOATING HUD REFINEMENT — clear glass + depth
       Lighten the outer plate & panels so the animated theme background
       shows through, while every control/overlay/badge gets a real
       glassmorphism treatment: gradient surface, blurred backdrop, inset
       specular highlight, soft bottom recess, outer drop shadow.
       (Voice blob, spin rings, mic button, and rotating animations are
       intentionally not retouched.)
       ═════════════════════════════════════════════════════════════════ */

    /* Outer HUD plate — drop the solid base, keep the edge sheen. */
    /* SINGLE-PLANE CONTAINER (live cascade winner — overrides the tech-theme
       block above with !important). The unified world mesh (.vc-world, z:0) is
       the terminal's backdrop, so the container itself must stay transparent —
       any opaque fill here was the "second plane" the mesh appeared pasted
       into. We keep only a faint edge-anchored void (so the masked mesh edges
       dissolve into depth, centred on the blob via --vc-blob-cx) plus the frame
       border + outer glow that define the terminal boundary. A light backdrop
       blur frosts only the app page BEHIND the terminal — the mesh is a child,
       painted on top of it, so it stays crisp. */
    .hud-container:not(.live-action-on) {
      background:
        radial-gradient(ellipse 135% 115% at var(--vc-blob-cx, 50%) 40%,
          transparent 50%,
          rgba(4, 9, 18, 0.55) 100%) !important;
      backdrop-filter: blur(10px) saturate(150%) !important;
      -webkit-backdrop-filter: blur(10px) saturate(150%) !important;
      border: 1px solid color-mix(in srgb, var(--g-primary) 20%, rgba(255, 255, 255, 0.06)) !important;
      box-shadow:
        0 1px 4px rgba(0, 0, 0, 0.18),
        0 18px 48px rgba(0, 0, 0, 0.32),
        0 0 32px color-mix(in srgb, var(--g-primary) 8%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.10),
        inset 0 -1px 0 rgba(0, 0, 0, 0.32),
        inset 0 0 0 1px color-mix(in srgb, var(--g-primary) 4%, transparent) !important;
    }

    /* Side columns — FROSTED GLASS over the one world, NOT opaque tiles.
       Background is near-transparent (a whisper of dark for white-text
       contrast); legibility comes from a backdrop blur that frosts the mesh
       *behind* the column plus the edge scrim (::before) — so the same world
       reads through the transcript / right rail, just softened. No hard border
       or drop-shadow → no "tile" silhouette = one plane. */
    .hud-container:not(.live-action-on) .panel-left,
    .hud-container:not(.live-action-on) .panel-right {
      background:
        linear-gradient(180deg, rgba(4, 10, 20, 0.30) 0%, rgba(4, 10, 20, 0.36) 100%) !important;
      border: none !important;
      backdrop-filter: blur(16px) saturate(160%) !important;
      -webkit-backdrop-filter: blur(16px) saturate(160%) !important;
      box-shadow: none !important;
    }
    /* Hairline only on the INNER edge (the seam toward the blob) so the column
       has a faint boundary without a full enclosing frame. */
    .hud-container:not(.live-action-on) .panel-left {
      border-right: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent) !important;
    }
    .hud-container:not(.live-action-on) .panel-right {
      border-left: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent) !important;
    }

    /* Header strip — clear glass plate so theme animation reads through. */
    .hud-container:not(.live-action-on) .hud-header {
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--g-primary) 6%, rgba(255, 255, 255, 0.03)),
          rgba(0, 0, 0, 0.08)) !important;
      backdrop-filter: blur(14px) saturate(160%);
      -webkit-backdrop-filter: blur(14px) saturate(160%);
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 20%, rgba(255, 255, 255, 0.06)) !important;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.10),
        inset 0 -1px 0 rgba(0, 0, 0, 0.22);
    }

    /* Footer control strip — same clear-glass language as header. */
    .hud-container:not(.live-action-on) .hud-footer {
      background:
        linear-gradient(0deg,
          color-mix(in srgb, var(--g-primary) 6%, rgba(255, 255, 255, 0.03)),
          rgba(0, 0, 0, 0.08)) !important;
      backdrop-filter: blur(14px) saturate(160%);
      -webkit-backdrop-filter: blur(14px) saturate(160%);
      border-top: 1px solid color-mix(in srgb, var(--g-primary) 20%, rgba(255, 255, 255, 0.06)) !important;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.10),
        inset 0 -1px 0 rgba(0, 0, 0, 0.22);
    }

    /* Status badges (LIVE / VISION / VIDEO / STREAMING) in the header —
       floating glass chips. */
    .hud-container:not(.live-action-on) .status-badge {
      padding: 4px 12px;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, rgba(255, 255, 255, 0.06));
      background:
        linear-gradient(155deg,
          color-mix(in srgb, var(--g-primary) 12%, rgba(255, 255, 255, 0.04)) 0%,
          rgba(0, 0, 0, 0.22) 100%);
      backdrop-filter: blur(16px) saturate(170%);
      -webkit-backdrop-filter: blur(16px) saturate(170%);
      box-shadow:
        0 1px 2px rgba(0, 0, 0, 0.28),
        0 6px 16px rgba(0, 0, 0, 0.28),
        inset 0 1px 0 rgba(255, 255, 255, 0.12),
        inset 0 -1px 0 rgba(0, 0, 0, 0.30);
    }
    .hud-container:not(.live-action-on) .status-badge.live {
      border-color: color-mix(in srgb, var(--success) 55%, transparent);
      box-shadow:
        0 1px 2px rgba(0, 0, 0, 0.28),
        0 6px 16px rgba(0, 0, 0, 0.28),
        0 0 22px color-mix(in srgb, var(--success) 22%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.14),
        inset 0 -1px 0 rgba(0, 0, 0, 0.30);
    }
    .hud-container:not(.live-action-on) .status-badge.active {
      border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
      box-shadow:
        0 1px 2px rgba(0, 0, 0, 0.28),
        0 6px 16px rgba(0, 0, 0, 0.28),
        0 0 22px color-mix(in srgb, var(--g-primary) 24%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.14),
        inset 0 -1px 0 rgba(0, 0, 0, 0.30);
    }

    /* Footer + header control buttons (the .ctrl-btn family — settings,
       Live Action toggle, etc.). The mic button is .mic-btn and is left
       untouched. */
    .hud-container:not(.live-action-on) .ctrl-btn {
      padding: 0.55rem 1.1rem;
      border-radius: 10px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, rgba(255, 255, 255, 0.06)) !important;
      background:
        linear-gradient(155deg,
          color-mix(in srgb, var(--g-primary) 10%, rgba(255, 255, 255, 0.05)) 0%,
          color-mix(in srgb, var(--g-primary) 2%, rgba(0, 0, 0, 0.20)) 55%,
          rgba(0, 0, 0, 0.30) 100%) !important;
      backdrop-filter: blur(18px) saturate(180%);
      -webkit-backdrop-filter: blur(18px) saturate(180%);
      color: var(--text-secondary);
      box-shadow:
        0 1px 2px rgba(0, 0, 0, 0.32),
        0 8px 20px rgba(0, 0, 0, 0.28),
        inset 0 1px 0 rgba(255, 255, 255, 0.12),
        inset 0 -1px 0 rgba(0, 0, 0, 0.32);
      transition: transform 0.18s ease, box-shadow 0.18s ease,
                  border-color 0.18s ease, color 0.18s ease, background 0.18s ease;
    }
    .hud-container:not(.live-action-on) .ctrl-btn:hover {
      transform: translateY(-1px);
      border-color: color-mix(in srgb, var(--g-primary) 50%, transparent) !important;
      color: var(--gold-primary);
      box-shadow:
        0 2px 4px rgba(0, 0, 0, 0.36),
        0 12px 28px rgba(0, 0, 0, 0.36),
        0 0 24px color-mix(in srgb, var(--g-primary) 22%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.16),
        inset 0 -1px 0 rgba(0, 0, 0, 0.36);
    }
    .hud-container:not(.live-action-on) .ctrl-btn.active {
      border-color: var(--gold-primary) !important;
      color: var(--gold-primary);
      background:
        linear-gradient(155deg,
          color-mix(in srgb, var(--g-primary) 26%, rgba(255, 255, 255, 0.04)) 0%,
          color-mix(in srgb, var(--g-primary) 10%, rgba(0, 0, 0, 0.24)) 100%) !important;
      box-shadow:
        0 2px 4px rgba(0, 0, 0, 0.36),
        0 14px 32px rgba(0, 0, 0, 0.40),
        0 0 28px color-mix(in srgb, var(--g-primary) 32%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.18),
        inset 0 -1px 0 rgba(0, 0, 0, 0.36),
        0 0 0 1px color-mix(in srgb, var(--g-primary) 30%, transparent);
    }

    /* System modules — translucent cards. The cyan corner-brackets and
       tech header band defined earlier still cascade through. */
    .hud-container:not(.live-action-on) .module {
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--g-primary) 6%, rgba(255, 255, 255, 0.03)) 0%,
          rgba(0, 0, 0, 0.22) 100%) !important;
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, rgba(255, 255, 255, 0.05)) !important;
      backdrop-filter: blur(14px) saturate(165%);
      -webkit-backdrop-filter: blur(14px) saturate(165%);
      box-shadow:
        0 1px 2px rgba(0, 0, 0, 0.22),
        0 10px 26px rgba(0, 0, 0, 0.30),
        inset 0 1px 0 rgba(255, 255, 255, 0.10),
        inset 0 -1px 0 rgba(0, 0, 0, 0.28) !important;
    }
    .hud-container:not(.live-action-on) .module-header {
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--g-primary) 16%, transparent),
          color-mix(in srgb, var(--g-primary) 4%, rgba(255, 255, 255, 0.02))) !important;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 24%, transparent) !important;
    }

    /* Log telemetry pane — keep the corner brackets/scanline already
       defined, but lighten the base so the theme reads behind. */
    .hud-container:not(.live-action-on) .vc-left-log {
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--g-primary) 7%, rgba(255, 255, 255, 0.03)) 0%,
          rgba(0, 0, 0, 0.24) 100%) !important;
      border: 1px solid color-mix(in srgb, var(--g-primary) 20%, rgba(255, 255, 255, 0.06)) !important;
      backdrop-filter: blur(16px) saturate(170%) !important;
      -webkit-backdrop-filter: blur(16px) saturate(170%) !important;
      box-shadow:
        0 2px 4px rgba(0, 0, 0, 0.26),
        0 14px 32px rgba(0, 0, 0, 0.30),
        0 0 24px color-mix(in srgb, var(--g-primary) 7%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.08),
        inset 0 -1px 0 rgba(0, 0, 0, 0.30) !important;
    }

    /* Right-panel tab strip — pills feel like floating tabs on the glass. */
    .hud-container:not(.live-action-on) .right-panel-tab {
      transition: color 0.2s ease, background 0.2s ease,
                  text-shadow 0.2s ease, border-bottom-color 0.2s ease;
    }
    .hud-container:not(.live-action-on) .right-panel-tab.active {
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--g-primary) 16%, transparent),
          color-mix(in srgb, var(--g-primary) 4%, transparent)) !important;
      color: var(--gold-primary);
      text-shadow: 0 0 10px color-mix(in srgb, var(--g-primary) 40%, transparent);
      border-bottom-color: var(--gold-primary);
    }

    /* Live Action cluster (pill + display picker in the header). */
    .hud-container:not(.live-action-on) .live-action-cluster {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .hud-container:not(.live-action-on) .live-action-display {
      padding: 6px 10px;
      border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, rgba(255, 255, 255, 0.06));
      background:
        linear-gradient(155deg,
          color-mix(in srgb, var(--g-primary) 10%, rgba(255, 255, 255, 0.04)) 0%,
          rgba(0, 0, 0, 0.30) 100%);
      backdrop-filter: blur(14px) saturate(170%);
      -webkit-backdrop-filter: blur(14px) saturate(170%);
      color: var(--text-primary);
      font: 11px/1 var(--hud-mono);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.10),
        inset 0 -1px 0 rgba(0, 0, 0, 0.30),
        0 4px 12px rgba(0, 0, 0, 0.28);
    }

    /* Settings overlay — backdrop is a heavy frost rather than a near-
       opaque wash, so the HUD behind still reads. */
    .hud-container:not(.live-action-on) .settings-overlay {
      background: rgba(0, 0, 0, 0.45) !important;
      backdrop-filter: blur(24px) saturate(180%) !important;
      -webkit-backdrop-filter: blur(24px) saturate(180%) !important;
    }
    .hud-container:not(.live-action-on) .settings-card {
      background:
        linear-gradient(160deg,
          color-mix(in srgb, var(--g-primary) 10%, rgba(255, 255, 255, 0.05)) 0%,
          rgba(0, 0, 0, 0.32) 100%) !important;
      border: 1px solid color-mix(in srgb, var(--g-primary) 30%, rgba(255, 255, 255, 0.08)) !important;
      backdrop-filter: blur(28px) saturate(180%);
      -webkit-backdrop-filter: blur(28px) saturate(180%);
      box-shadow:
        0 2px 4px rgba(0, 0, 0, 0.4),
        0 28px 64px rgba(0, 0, 0, 0.50),
        0 0 40px color-mix(in srgb, var(--g-primary) 18%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.14),
        inset 0 -1px 0 rgba(0, 0, 0, 0.40) !important;
    }
    .hud-container:not(.live-action-on) .settings-header {
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--g-primary) 14%, transparent),
          color-mix(in srgb, var(--g-primary) 4%, rgba(255, 255, 255, 0.02))) !important;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 26%, transparent) !important;
    }

    /* Transcript region in HUD mode: NO container chrome. The scroll viewport
       is fully transparent and borderless so the turn-pills float directly on
       the 3D voice scene / ambient layer. Pill styling lives in the base
       .message rules above (borderless glass with inner ring + glow). */

    /* Right-panel collapse caret button — clear-glass like .ctrl-btn. */
    .hud-container:not(.live-action-on) .right-panel-collapse-btn {
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, rgba(255, 255, 255, 0.06));
      background:
        linear-gradient(155deg,
          color-mix(in srgb, var(--g-primary) 10%, rgba(255, 255, 255, 0.05)) 0%,
          rgba(0, 0, 0, 0.28) 100%);
      backdrop-filter: blur(14px) saturate(170%);
      -webkit-backdrop-filter: blur(14px) saturate(170%);
      box-shadow:
        0 1px 2px rgba(0, 0, 0, 0.28),
        0 4px 10px rgba(0, 0, 0, 0.26),
        inset 0 1px 0 rgba(255, 255, 255, 0.12),
        inset 0 -1px 0 rgba(0, 0, 0, 0.30);
      transition: transform 0.18s ease, box-shadow 0.18s ease,
                  border-color 0.18s ease, color 0.18s ease, background 0.18s ease;
    }
    .hud-container:not(.live-action-on) .right-panel-collapse-btn:hover {
      transform: translateY(-1px);
      border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      color: var(--gold-primary);
      box-shadow:
        0 2px 4px rgba(0, 0, 0, 0.32),
        0 8px 18px rgba(0, 0, 0, 0.32),
        0 0 18px color-mix(in srgb, var(--g-primary) 22%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.16),
        inset 0 -1px 0 rgba(0, 0, 0, 0.32);
    }

    /* Settings gear button in transcript header — lifted clear-glass. */
    .hud-container:not(.live-action-on) .vc-model-settings-btn {
      background:
        linear-gradient(155deg,
          color-mix(in srgb, var(--g-primary) 14%, rgba(255, 255, 255, 0.05)) 0%,
          color-mix(in srgb, var(--g-primary) 3%, rgba(0, 0, 0, 0.28)) 100%);
      border: 1px solid color-mix(in srgb, var(--g-primary) 40%, rgba(255, 255, 255, 0.06));
      backdrop-filter: blur(14px) saturate(170%);
      -webkit-backdrop-filter: blur(14px) saturate(170%);
      box-shadow:
        0 1px 2px rgba(0, 0, 0, 0.28),
        0 4px 12px rgba(0, 0, 0, 0.28),
        inset 0 1px 0 rgba(255, 255, 255, 0.12),
        inset 0 -1px 0 rgba(0, 0, 0, 0.28);
    }
    .hud-container:not(.live-action-on) .vc-model-settings-btn:hover {
      background:
        linear-gradient(155deg,
          color-mix(in srgb, var(--g-primary) 26%, rgba(255, 255, 255, 0.06)) 0%,
          color-mix(in srgb, var(--g-primary) 10%, rgba(0, 0, 0, 0.28)) 100%);
      box-shadow:
        0 2px 4px rgba(0, 0, 0, 0.32),
        0 8px 18px rgba(0, 0, 0, 0.34),
        0 0 18px color-mix(in srgb, var(--g-primary) 28%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.16),
        inset 0 -1px 0 rgba(0, 0, 0, 0.32);
    }
    .hud-container:not(.live-action-on) .vc-model-settings-btn.active {
      background:
        linear-gradient(155deg,
          color-mix(in srgb, var(--g-primary) 32%, rgba(255, 255, 255, 0.06)) 0%,
          color-mix(in srgb, var(--g-primary) 12%, rgba(0, 0, 0, 0.28)) 100%);
      box-shadow:
        0 2px 4px rgba(0, 0, 0, 0.32),
        0 10px 22px rgba(0, 0, 0, 0.36),
        0 0 24px color-mix(in srgb, var(--g-primary) 36%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.18),
        inset 0 -1px 0 rgba(0, 0, 0, 0.34),
        0 0 0 1px color-mix(in srgb, var(--g-primary) 30%, transparent);
    }

    /* Voice mode toggle (▶ Terminal / ◧ Transcript) — clear glass pill.
       Overrides the inline transparent background with the same gradient
       glass language as .ctrl-btn so it reads as floating. */
    .hud-container:not(.live-action-on) .vc-mode-toggle {
      background:
        linear-gradient(155deg,
          color-mix(in srgb, var(--g-primary) 12%, rgba(255, 255, 255, 0.05)) 0%,
          color-mix(in srgb, var(--g-primary) 3%, rgba(0, 0, 0, 0.26)) 100%) !important;
      border: 1px solid color-mix(in srgb, var(--g-primary) 45%, rgba(255, 255, 255, 0.06)) !important;
      backdrop-filter: blur(14px) saturate(170%);
      -webkit-backdrop-filter: blur(14px) saturate(170%);
      box-shadow:
        0 1px 2px rgba(0, 0, 0, 0.28),
        0 4px 12px rgba(0, 0, 0, 0.28),
        inset 0 1px 0 rgba(255, 255, 255, 0.12),
        inset 0 -1px 0 rgba(0, 0, 0, 0.28);
      transition: transform 0.18s ease, box-shadow 0.18s ease,
                  border-color 0.18s ease, background 0.18s ease;
    }
    .hud-container:not(.live-action-on) .vc-mode-toggle:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow:
        0 2px 4px rgba(0, 0, 0, 0.32),
        0 8px 18px rgba(0, 0, 0, 0.34),
        0 0 18px color-mix(in srgb, var(--g-primary) 26%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.16),
        inset 0 -1px 0 rgba(0, 0, 0, 0.30);
    }

    /* Panel title bars (Transcript / right panel header). The base rule
       paints transparent; give a faint gradient strip so the title band
       sits visibly above the panel surface. */
    .hud-container:not(.live-action-on) .panel-header {
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--g-primary) 8%, rgba(255, 255, 255, 0.03)) 0%,
          color-mix(in srgb, var(--g-primary) 2%, rgba(0, 0, 0, 0.05)) 100%);
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 22%, rgba(255, 255, 255, 0.05));
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.08),
        inset 0 -1px 0 rgba(0, 0, 0, 0.20);
    }

    /* Conversation (transcript) header: drop the solid card divider so the
       message stream appears to flow out of the title rather than out of a
       boxed panel. A faint center-weighted gradient line replaces the hard
       border; the terminal-mode header (its own concern) keeps the rule above. */
    .hud-container:not(.live-action-on) .vc-left-transcript > .panel-header {
      background: linear-gradient(180deg,
        color-mix(in srgb, var(--g-primary) 5%, transparent) 0%,
        transparent 100%);
      border-bottom: none;
      box-shadow: none;
      position: relative;
    }
    .hud-container:not(.live-action-on) .vc-left-transcript > .panel-header::after {
      content: "";
      position: absolute;
      left: 0; right: 0; bottom: 0;
      height: 1px;
      background: linear-gradient(90deg,
        transparent,
        color-mix(in srgb, var(--g-primary) 30%, transparent) 50%,
        transparent);
      opacity: 0.5;
    }

    /* Small glass chip — message count / status dot in panel headers. */
    .hud-container:not(.live-action-on) .panel-badge {
      padding: 3px 9px;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 22%, rgba(255, 255, 255, 0.06));
      background:
        linear-gradient(155deg,
          color-mix(in srgb, var(--g-primary) 14%, rgba(255, 255, 255, 0.05)) 0%,
          rgba(0, 0, 0, 0.24) 100%);
      backdrop-filter: blur(12px) saturate(170%);
      -webkit-backdrop-filter: blur(12px) saturate(170%);
      color: var(--gold-dim);
      box-shadow:
        0 1px 2px rgba(0, 0, 0, 0.26),
        0 3px 10px rgba(0, 0, 0, 0.22),
        inset 0 1px 0 rgba(255, 255, 255, 0.12),
        inset 0 -1px 0 rgba(0, 0, 0, 0.28);
    }

    /* Settings overlay form controls — selects/inputs get the same
       clear-glass surface so they sit on the card with depth. */
    .hud-container:not(.live-action-on) .setting-select,
    .hud-container:not(.live-action-on) .settings-card input[type="text"],
    .hud-container:not(.live-action-on) .settings-card input[type="number"],
    .hud-container:not(.live-action-on) .settings-card input[type="password"],
    .hud-container:not(.live-action-on) .settings-card input[type="search"],
    .hud-container:not(.live-action-on) .settings-card input[type="url"],
    .hud-container:not(.live-action-on) .settings-card textarea {
      background:
        linear-gradient(180deg,
          rgba(0, 0, 0, 0.32) 0%,
          rgba(0, 0, 0, 0.20) 100%);
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, rgba(255, 255, 255, 0.06));
      backdrop-filter: blur(14px) saturate(170%);
      -webkit-backdrop-filter: blur(14px) saturate(170%);
      box-shadow:
        inset 0 1px 2px rgba(0, 0, 0, 0.34),
        inset 0 -1px 0 rgba(255, 255, 255, 0.05),
        0 1px 0 rgba(255, 255, 255, 0.04);
      transition: border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
    }
    .hud-container:not(.live-action-on) .setting-select:focus,
    .hud-container:not(.live-action-on) .settings-card input:focus,
    .hud-container:not(.live-action-on) .settings-card textarea:focus {
      border-color: color-mix(in srgb, var(--g-primary) 60%, transparent);
      box-shadow:
        inset 0 1px 2px rgba(0, 0, 0, 0.34),
        inset 0 -1px 0 rgba(255, 255, 255, 0.06),
        0 0 0 1px color-mix(in srgb, var(--g-primary) 30%, transparent),
        0 0 18px color-mix(in srgb, var(--g-primary) 18%, transparent);
    }
    .hud-container:not(.live-action-on) .setting-label {
      color: color-mix(in srgb, var(--gold-dim) 80%, var(--text-muted));
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.35);
    }

    /* Primary Connect button — keep the gold gradient untouched, but
       layer in the lifted-glass shadow stack so it reads with the same
       depth as the rest of the HUD controls. */
    .hud-container:not(.live-action-on) .ctrl-btn.primary {
      background: linear-gradient(135deg, var(--gold-primary) 0%, var(--gold-secondary) 100%) !important;
      border-color: var(--gold-primary) !important;
      color: #000;
      box-shadow:
        0 1px 2px rgba(0, 0, 0, 0.32),
        0 10px 24px rgba(0, 0, 0, 0.36),
        0 0 24px color-mix(in srgb, var(--g-primary) 32%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.42),
        inset 0 -1px 0 rgba(0, 0, 0, 0.28),
        0 0 0 1px color-mix(in srgb, var(--g-primary) 30%, transparent);
    }
    .hud-container:not(.live-action-on) .ctrl-btn.primary:hover {
      transform: translateY(-1px);
      box-shadow:
        0 2px 4px rgba(0, 0, 0, 0.36),
        0 14px 32px rgba(0, 0, 0, 0.42),
        0 0 36px var(--gold-glow),
        inset 0 1px 0 rgba(255, 255, 255, 0.50),
        inset 0 -1px 0 rgba(0, 0, 0, 0.30),
        0 0 0 1px color-mix(in srgb, var(--g-primary) 40%, transparent);
    }

    /* Footer vertical divider — soft gradient line that fades at edges
       instead of a flat hard border. */
    .hud-container:not(.live-action-on) .divider {
      background:
        linear-gradient(180deg,
          transparent 0%,
          color-mix(in srgb, var(--g-primary) 35%, rgba(255, 255, 255, 0.12)) 30%,
          color-mix(in srgb, var(--g-primary) 35%, rgba(255, 255, 255, 0.12)) 70%,
          transparent 100%);
      box-shadow:
        1px 0 0 rgba(0, 0, 0, 0.25),
        -1px 0 0 rgba(255, 255, 255, 0.04);
    }

    /* Drag handles between columns / log split — subtle glass treatment.
       The ::after thumb (already styled in base rules) keeps its cyan
       accent on hover; we just elevate the rail itself. */
    .hud-container:not(.live-action-on) .vc-col-splitter,
    .hud-container:not(.live-action-on) .vc-left-splitter {
      background:
        linear-gradient(180deg,
          rgba(255, 255, 255, 0.04) 0%,
          color-mix(in srgb, var(--g-primary) 10%, rgba(0, 0, 0, 0.18)) 50%,
          rgba(255, 255, 255, 0.04) 100%);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.06),
        inset 0 -1px 0 rgba(0, 0, 0, 0.24);
    }
    .hud-container:not(.live-action-on) .vc-col-splitter:hover,
    .hud-container:not(.live-action-on) .vc-col-splitter.dragging,
    .hud-container:not(.live-action-on) .vc-left-splitter:hover,
    .hud-container:not(.live-action-on) .vc-left-splitter.dragging {
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--g-primary) 14%, transparent) 0%,
          color-mix(in srgb, var(--g-primary) 30%, rgba(0, 0, 0, 0.18)) 50%,
          color-mix(in srgb, var(--g-primary) 14%, transparent) 100%);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.10),
        inset 0 -1px 0 rgba(0, 0, 0, 0.30),
        0 0 18px color-mix(in srgb, var(--g-primary) 22%, transparent);
    }

    /* ════════════════════════════════════════════════════════════════
       COLLAPSED = PILL — one unified gradient-pill language for every
       collapsed / handle / chip / toggle surface on the voice HUD.
       Only collapsed/iconic states are touched here; expanded panels
       keep their existing styling. All values derive from the glass
       theme tokens (--g-primary / --g-surface / --g-border / --g-accent).
       ════════════════════════════════════════════════════════════════ */
    :host {
      --pill-peel: linear-gradient(180deg,
        rgba(255, 255, 255, 0.10) 0%,
        rgba(255, 255, 255, 0) 35%,
        rgba(0, 0, 0, 0.18) 100%);
      --pill-surface: var(--g-surface, rgba(12, 14, 22, 0.6));
      --pill-border-col: color-mix(in srgb, var(--g-primary, #caa45a) 28%, var(--g-border, rgba(255, 255, 255, 0.12)));
      --pill-glow:
        0 4px 22px -8px color-mix(in srgb, var(--g-primary, #caa45a) 35%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.18);
      --pill-glow-hover:
        0 6px 26px -7px color-mix(in srgb, var(--g-primary, #caa45a) 48%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.26);
      --pill-glow-active:
        inset 0 2px 6px rgba(0, 0, 0, 0.40),
        inset 0 1px 0 rgba(255, 255, 255, 0.10);
      --pill-blur: blur(10px) saturate(140%);
      --pill-ease: cubic-bezier(.2, .8, .2, 1);
    }

    /* ── Collapsed left-rail (live-action sidebar) → vertical pill ── */
    .la-collapse-rail::before {
      content: "";
      position: absolute;
      top: 16px;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
      width: 24px;
      border-radius: 999px;
      background: var(--pill-peel), var(--pill-surface);
      border: 1px solid var(--pill-border-col);
      box-shadow: var(--pill-glow);
      backdrop-filter: var(--pill-blur);
      -webkit-backdrop-filter: var(--pill-blur);
      transition: transform 0.16s var(--pill-ease), box-shadow 0.16s var(--pill-ease);
      pointer-events: none;
    }
    .la-collapse-rail svg { position: relative; z-index: 1; }
    .la-collapse-rail:hover::before {
      transform: translateX(-50%) translateY(-1px);
      box-shadow: var(--pill-glow-hover);
    }
    .la-collapse-rail:active::before {
      transform: translateX(-50%);
      box-shadow: var(--pill-glow-active);
    }

    /* ── Resize handle at minimum width → chevron sits in a pill ── */
    .la-resize-handle.at-min .la-chevron {
      width: 24px;
      height: 44px;
      border-radius: 999px;
      background: var(--pill-peel), var(--pill-surface);
      border: 1px solid var(--pill-border-col);
      box-shadow: var(--pill-glow);
      backdrop-filter: var(--pill-blur);
      -webkit-backdrop-filter: var(--pill-blur);
      transition: transform 0.16s var(--pill-ease), box-shadow 0.16s var(--pill-ease);
    }
    .la-resize-handle.at-min:hover .la-chevron {
      transform: translate(-50%, -50%) translateY(-1px);
      box-shadow: var(--pill-glow-hover);
    }

    /* ── Right-panel collapse / expand caret → round pill ── */
    .hud-container:not(.live-action-on) .right-panel-collapse-btn,
    .right-panel-collapse-btn {
      border-radius: 999px;
      background: var(--pill-peel), var(--pill-surface);
      border: 1px solid var(--pill-border-col);
      box-shadow: var(--pill-glow);
      backdrop-filter: var(--pill-blur);
      -webkit-backdrop-filter: var(--pill-blur);
      transition: transform 0.16s var(--pill-ease), box-shadow 0.16s var(--pill-ease), color 0.16s var(--pill-ease);
    }
    .right-panel-collapse-btn:hover {
      transform: translateY(-1px);
      box-shadow: var(--pill-glow-hover);
    }
    .right-panel-collapse-btn:active {
      transform: none;
      box-shadow: var(--pill-glow-active);
    }

    /* ── Free-floating control pills (vc-pill family) → gradient peel.
       State colour variants (is-live / is-off / is-rec) are re-declared
       after the base so their semantic borders still win. ── */
    .vc-pill {
      background: var(--pill-peel), var(--pill-surface);
      border-color: var(--pill-border-col);
      box-shadow: var(--pill-glow);
      backdrop-filter: var(--pill-blur);
      -webkit-backdrop-filter: var(--pill-blur);
    }
    .vc-pill:hover {
      transform: translateY(-1px);
      box-shadow: var(--pill-glow-hover);
    }
    .vc-pill:active {
      transform: none;
      box-shadow: var(--pill-glow-active);
    }
    .vc-pill.is-live { border-color: color-mix(in srgb, var(--success, #39d98a) 60%, transparent); }
    .vc-pill.is-off  { border-color: color-mix(in srgb, var(--danger, #ff5d5d) 50%, transparent); }
    .vc-pill.is-rec  { border-color: color-mix(in srgb, var(--g-primary, #caa45a) 60%, transparent); }

    /* ── Column / log-split drag-handle thumbs → fully rounded ── */
    .vc-col-splitter::after,
    .vc-left-splitter::after { border-radius: 999px; }

    /* ── Respect reduced-motion: kill transforms + transitions ── */
    @media (prefers-reduced-motion: reduce) {
      .la-collapse-rail::before,
      .la-resize-handle.at-min .la-chevron,
      .right-panel-collapse-btn,
      .vc-pill {
        transition: none !important;
      }
      .la-collapse-rail:hover::before,
      .la-resize-handle.at-min:hover .la-chevron,
      .right-panel-collapse-btn:hover,
      .vc-pill:hover { transform: none !important; }
    }
`;
