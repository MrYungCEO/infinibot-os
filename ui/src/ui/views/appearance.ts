import { html, nothing, type TemplateResult } from "lit";
import "../components/pair-invite-panel.js";
import type { AppViewState } from "../app-view-state.js";
import type { GatewayBrowserClient } from "../gateway.js";
import type { ThemeMode } from "../theme.js";
import {
  getLastBackgroundError,
  isDraftDirty,
  loadAppBranding,
  resetDraftToDefault,
  revertDraft,
  saveDraft,
  selectDraftPalette,
  updateDraftBackground,
  updateDraftBranding,
  updateDraftThemeMode,
  updateDraftTokens,
  uploadLogoFile,
  type AppBrandingPayload,
  type BackgroundStyle,
} from "../controllers/app-branding.js";
import { setGateEnabled, markGateUnpassed } from "../profiles.js";
import { loadChatFollowPrefs, saveChatFollowPrefs, type ChatFollowPrefs } from "../chat/chat-follow-nav.js";
import {
  clearSetupSnoozes,
  isSetupHighlightEnabled,
  setSetupHighlightEnabled,
} from "../controllers/nav-setup-status.js";
import {
  isLowEndDevice,
  refreshPerfMode,
  type PerfModeSetting,
} from "../lib/perf-mode.js";
import {
  ensureSystemGlass,
  sgAurora,
  sgChip,
  sgGloss,
  sgHero,
  sgIcon,
  sgLed,
  sgSkeleton,
  type SgIconName,
} from "./system-glass.js";

const PERF_MODE_OPTIONS: Array<{ id: PerfModeSetting; label: string; hint: string }> = [
  { id: "auto", label: "Auto", hint: "On automatically for low-end devices" },
  { id: "on", label: "On", hint: "Always tone down heavy visual passes" },
  { id: "off", label: "Off", hint: "Full fidelity (high-end devices)" },
];

function renderPerformanceCard(state: AppViewState): TemplateResult {
  const current: PerfModeSetting = state.settings.performanceMode ?? "auto";
  const lowEnd = isLowEndDevice();
  return html`
    <div class="sg-panel ap-card">
      <h2><span class="ap-h-ico">${sgIcon("bolt", 16)}</span>Performance mode<small>${sgChip(lowEnd ? "Low-end device" : "Capable device", lowEnd ? "warn" : "ok", true)}</small></h2>
      <p class="ap-note">
        Tones down the most expensive GPU passes (cinematic color-grade, heavy
        backdrop blur, world-map agent cap) without changing the look. This
        device is detected as <strong>${lowEnd ? "low-end" : "capable"}</strong>.
      </p>
      <div class="sg-seg ap-seg" role="group" aria-label="Performance mode">
        ${PERF_MODE_OPTIONS.map(
          (opt) => html`
            <button
              class="ap-btn ${current === opt.id ? "ap-btn--primary active" : ""}"
              aria-pressed=${current === opt.id ? "true" : "false"}
              title=${opt.hint}
              @click=${() => {
                state.applySettings({ ...state.settings, performanceMode: opt.id });
                refreshPerfMode();
                state.requestUpdate?.();
              }}
            >
              ${opt.label}
            </button>
          `,
        )}
      </div>
      <p class="ap-mode-hint">${PERF_MODE_OPTIONS.find((o) => o.id === current)?.hint ?? ""}</p>
    </div>
  `;
}

function chatFollowToggle(
  state: AppViewState,
  key: keyof ChatFollowPrefs,
  label: string,
  prefs: ChatFollowPrefs,
): TemplateResult {
  return html`
    <div class="ap-field">
      <label class="ap-toggle-row">
        <input
          type="checkbox"
          class="ap-toggle-input"
          role="switch"
          data-chat-follow-pref=${key}
          .checked=${prefs[key]}
          @change=${(e: Event) => {
            saveChatFollowPrefs({ [key]: (e.target as HTMLInputElement).checked });
            state.requestUpdate?.();
          }}
        />
        <span class="ap-toggle-track"><span class="ap-toggle-thumb"></span></span>
        <span class="ap-toggle-label">${label}</span>
      </label>
    </div>
  `;
}

/** "Keep chat open when navigating" (chat/chat-follow-nav.ts). Saved in this browser. */
function renderChatFollowCard(state: AppViewState): TemplateResult {
  const prefs = loadChatFollowPrefs();
  return html`
    <div class="sg-panel ap-card" data-ap-chat-follow>
      ${cardHead("link", "Chat & navigation")}
      ${chatFollowToggle(state, "agent", "Keep chat open when the agent navigates", prefs)}
      ${chatFollowToggle(state, "manual", "Keep chat open when I navigate", prefs)}
      <p class="ap-note">
        When the agent opens another page mid-conversation, the chat sidebar opens there on the same
        conversation and the reply keeps streaming. On a phone you get a "Back to chat" button instead.
        Saved in this browser.
      </p>
    </div>
  `;
}

const THEME_MODE_OPTIONS: Array<{ id: ThemeMode; label: string }> = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "hud", label: "HUD" },
];

const BACKGROUND_OPTIONS: Array<{ id: BackgroundStyle; label: string; hint: string }> = [
  { id: "none", label: "None", hint: "Flat surface, no animation" },
  { id: "gradient", label: "Gradient", hint: "Soft CSS aurora (low GPU)" },
  {
    id: "ambient-grid",
    label: "Ambient Grid (default)",
    hint: "Subtle gold grid with deep vignette. Always-on, GPU-friendly.",
  },
  { id: "aurora", label: "Aurora", hint: "Slow drifting aurora" },
  { id: "iridescence", label: "Iridescence", hint: "Shifting rainbow sheen" },
  { id: "liquid-chrome", label: "Liquid Chrome", hint: "Molten metal ripple" },
  { id: "lightning", label: "Lightning", hint: "Electric bolts" },
  { id: "beams", label: "Beams", hint: "Scanning light rays" },
  { id: "silk", label: "Silk", hint: "Smooth silky waves" },
  { id: "waves", label: "Waves", hint: "Oscillating line grid" },
  { id: "threads", label: "Threads", hint: "String-like waves" },
  { id: "particles", label: "Particles", hint: "Drifting particle field" },
  { id: "metaballs", label: "Meta Balls", hint: "Merging blobs" },
  { id: "orb", label: "Orb", hint: "Glowing sphere" },
  { id: "balatro", label: "Balatro", hint: "Cosmic spin pattern" },
  { id: "letter-glitch", label: "Letter Glitch", hint: "Scrambled code rain" },
  { id: "squares", label: "Squares", hint: "Grid pulse" },
  { id: "dot-grid", label: "Dot Grid", hint: "Cursor-reactive dot matrix" },
  { id: "faulty-terminal", label: "Faulty Terminal", hint: "CRT scanlines + glitches" },
  { id: "grainient", label: "Grainient", hint: "Warped film-grain gradient" },
];


// ── Glass G7 page styles ─────────────────────────────────────
// Page chrome rides the shared system-glass kit (gold = --glass-gold, which
// follows --g-primary, so it re-tints with the chosen palette). Swatches,
// colour pickers and the live preview are painted from the palette / draft
// tokens themselves and never from the gold chrome tokens.

const THEME_MODE_ICONS: Record<string, SgIconName> = {
  system: "settings",
  dark: "eye",
  light: "sun",
  hud: "grid",
};

/** Tiny CSS thumbnails for the background tiles (tinted by the live palette). */
const BG_THUMBS: Partial<Record<BackgroundStyle, string>> = {
  none: "linear-gradient(180deg, var(--ap-thumb-base), var(--ap-thumb-base))",
  gradient:
    "radial-gradient(80% 120% at 20% 0%, color-mix(in srgb, var(--g-primary, #d9b45f) 45%, transparent), transparent 60%), radial-gradient(80% 120% at 100% 100%, color-mix(in srgb, var(--g-accent, #a855f7) 40%, transparent), transparent 60%), var(--ap-thumb-base)",
  "ambient-grid":
    "linear-gradient(color-mix(in srgb, var(--g-primary, #d9b45f) 22%, transparent) 1px, transparent 1px) 0 0/10px 10px, linear-gradient(90deg, color-mix(in srgb, var(--g-primary, #d9b45f) 22%, transparent) 1px, transparent 1px) 0 0/10px 10px, var(--ap-thumb-base)",
  aurora:
    "radial-gradient(120% 60% at 30% 100%, color-mix(in srgb, var(--g-primary, #d9b45f) 55%, transparent), transparent 60%), radial-gradient(90% 60% at 80% 90%, color-mix(in srgb, var(--g-accent, #a855f7) 50%, transparent), transparent 60%), var(--ap-thumb-base)",
  iridescence: "linear-gradient(120deg, #ff9ffc66, #5227ff55, #4fd1c566, #f6e05e66), var(--ap-thumb-base)",
  "liquid-chrome": "repeating-radial-gradient(circle at 30% 40%, #ffffff33 0 3px, #8a8f9833 3px 7px), linear-gradient(135deg, #3b3f46, #9aa1ab 50%, #2b2e33)",
  lightning: "linear-gradient(115deg, transparent 46%, color-mix(in srgb, var(--g-primary, #d9b45f) 90%, #fff) 48%, transparent 50%), var(--ap-thumb-base)",
  beams: "repeating-linear-gradient(100deg, transparent 0 14px, color-mix(in srgb, var(--g-primary, #d9b45f) 22%, transparent) 14px 16px), var(--ap-thumb-base)",
  silk: "repeating-linear-gradient(160deg, color-mix(in srgb, var(--g-primary, #d9b45f) 18%, transparent) 0 6px, transparent 6px 14px), var(--ap-thumb-base)",
  waves: "repeating-radial-gradient(ellipse at 50% 140%, transparent 0 6px, color-mix(in srgb, var(--g-primary, #d9b45f) 26%, transparent) 6px 7px), var(--ap-thumb-base)",
  threads: "repeating-linear-gradient(175deg, transparent 0 5px, color-mix(in srgb, var(--g-fg, #fff) 16%, transparent) 5px 6px), var(--ap-thumb-base)",
  particles: "radial-gradient(circle, color-mix(in srgb, var(--g-primary, #d9b45f) 70%, transparent) 1px, transparent 1.6px) 0 0/12px 12px, radial-gradient(circle, color-mix(in srgb, var(--g-fg, #fff) 40%, transparent) 1px, transparent 1.6px) 6px 6px/17px 17px, var(--ap-thumb-base)",
  metaballs: "radial-gradient(circle at 35% 55%, color-mix(in srgb, var(--g-primary, #d9b45f) 70%, transparent) 0 14%, transparent 15%), radial-gradient(circle at 58% 45%, color-mix(in srgb, var(--g-accent, #a855f7) 70%, transparent) 0 18%, transparent 19%), var(--ap-thumb-base)",
  orb: "radial-gradient(circle at 50% 55%, color-mix(in srgb, var(--g-primary, #d9b45f) 85%, #fff) 0 8%, color-mix(in srgb, var(--g-primary, #d9b45f) 40%, transparent) 22%, transparent 42%), var(--ap-thumb-base)",
  balatro: "conic-gradient(from 30deg at 50% 50%, #de443b88, #006bb488, #16242388, #de443b88)",
  "letter-glitch": "repeating-linear-gradient(90deg, color-mix(in srgb, var(--g-primary, #d9b45f) 30%, transparent) 0 2px, transparent 2px 6px), repeating-linear-gradient(0deg, transparent 0 4px, #0006 4px 6px), var(--ap-thumb-base)",
  squares: "linear-gradient(color-mix(in srgb, var(--g-fg, #fff) 14%, transparent) 1px, transparent 1px) 0 0/14px 14px, linear-gradient(90deg, color-mix(in srgb, var(--g-fg, #fff) 14%, transparent) 1px, transparent 1px) 0 0/14px 14px, var(--ap-thumb-base)",
  "dot-grid": "radial-gradient(circle, color-mix(in srgb, var(--g-fg, #fff) 35%, transparent) 1px, transparent 1.5px) 0 0/8px 8px, var(--ap-thumb-base)",
  "faulty-terminal": "repeating-linear-gradient(0deg, #a7ef9e22 0 1px, transparent 1px 3px), radial-gradient(circle at 50% 50%, #a7ef9e33, transparent 70%), #050a05",
  grainient: "radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, var(--g-primary, #d9b45f) 50%, transparent), transparent 60%), radial-gradient(100% 90% at 100% 100%, color-mix(in srgb, var(--g-accent, #a855f7) 45%, transparent), transparent 60%), var(--ap-thumb-base)",
};

function styles(): TemplateResult {
  return html`
    <style>
      .sg-appearance { padding: 20px clamp(14px, 2.4vw, 30px) 96px; }
      .sg-appearance .ap-hero-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
      .sg-appearance .ap-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; box-shadow: 0 0 0 1px color-mix(in srgb, var(--sg-fg) 18%, transparent); }
      .sg-appearance .ap-dirty-pill { animation: ap-dirty-pulse 1.6s ease-in-out infinite; }
      @keyframes ap-dirty-pulse { 50% { opacity: 0.62; } }

      /* panels */
      .sg-appearance .ap-card { padding: 20px 22px; }
      .sg-appearance .ap-card > h2 { display: flex; align-items: center; gap: 10px; margin: 0 0 14px; color: var(--sg-fg); font-size: 15px; font-weight: 640; letter-spacing: -0.012em; text-transform: none; }
      .sg-appearance .ap-card > h2 .ap-h-ico { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 10px; color: var(--sg-gold); background: var(--glass-gold-a10); box-shadow: inset 0 0 0 1px var(--glass-gold-a24); }
      .sg-appearance .ap-card > h2 small { margin-left: auto; color: var(--sg-fg-3); font-size: 11.5px; font-weight: 500; letter-spacing: 0; }
      .sg-appearance .ap-note { margin: 0 0 12px; color: var(--sg-fg-2); font-size: 13px; line-height: 1.55; }
      .sg-appearance .ap-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
      .sg-appearance .ap-grid > pair-invite-panel { min-width: 0; }

      /* theme row: mode + live preview */
      .sg-appearance .ap-theme { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 20px; align-items: stretch; }
      .sg-appearance .ap-mode-seg { display: flex; width: 100%; padding: 5px; border-radius: 16px; }
      .sg-appearance .ap-mode-seg > button { flex: 1 1 0; justify-content: center; padding: 12px 10px; font-size: 13.5px; border-radius: 12px; }
      .sg-appearance .ap-mode-seg > button .sg-ico { opacity: 0.85; }
      .sg-appearance .ap-quick { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--glass-stroke); }
      .sg-appearance .ap-quick .ap-field { margin-bottom: 6px; }
      .sg-appearance .ap-mode-hint { margin: 10px 2px 0; color: var(--sg-fg-3); font-size: 12px; }

      /* live preview — painted from the brand tokens (the user's real colours) */
      .sg-appearance .ap-preview-frame { padding: 8px; border-radius: var(--sg-radius-md); background: var(--glass-3); box-shadow: inset 0 0 0 1px var(--glass-stroke), var(--glass-elev-1, none); }
      .sg-appearance .ap-preview-bar { display: flex; align-items: center; gap: 6px; padding: 2px 6px 8px; color: var(--sg-fg-3); font-size: 10.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
      .sg-appearance .ap-preview-bar i { width: 8px; height: 8px; border-radius: 50%; background: var(--sg-fg-4); }
      .sg-appearance .ap-preview-bar span { margin-left: 6px; }
      .sg-appearance .ap-preview {
        position: relative; overflow: hidden; padding: 20px; border-radius: calc(var(--sg-radius-md) - 4px);
        background: var(--g-gradient-ink, var(--g-bg, #0a0a0e)); color: var(--g-fg, #f5f5f4);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--g-primary, #d9b45f) 22%, transparent);
      }
      .sg-appearance .ap-preview::after { content: ""; position: absolute; inset: auto -20% -60% 30%; height: 120%; border-radius: 50%; background: radial-gradient(closest-side, color-mix(in srgb, var(--g-accent, #a855f7) 30%, transparent), transparent); pointer-events: none; }
      .sg-appearance .ap-preview > * { position: relative; z-index: 1; }
      .sg-appearance .ap-preview-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
      .sg-appearance .ap-preview-title { font-size: 18px; font-weight: 700; letter-spacing: -0.02em; background: var(--g-gradient-accent, var(--g-primary)); -webkit-background-clip: text; background-clip: text; color: transparent; }
      .sg-appearance .ap-preview-tag { font-size: 12px; color: color-mix(in srgb, var(--g-fg, #f5f5f4) 62%, transparent); }
      .sg-appearance .ap-preview-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .sg-appearance .ap-preview-btn { padding: 7px 13px; border-radius: 9px; font-size: 12px; font-weight: 650; color: #0a0a0e; background: var(--g-gradient-accent, var(--g-primary)); }
      .sg-appearance .ap-preview-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; border-radius: 999px; font-size: 11px; color: var(--g-primary); background: var(--g-primary-soft, transparent); border: 1px solid var(--g-primary-muted, currentColor); }
      .sg-appearance .ap-preview-chip i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; }
      .sg-appearance .ap-preview-lines { display: grid; gap: 6px; margin-top: 14px; }
      .sg-appearance .ap-preview-lines span { height: 7px; border-radius: 4px; background: color-mix(in srgb, var(--g-fg, #f5f5f4) 14%, transparent); }
      .sg-appearance .ap-logo-preview { flex: none; width: 52px; height: 52px; border-radius: 14px; display: grid; place-items: center; overflow: hidden; color: var(--g-primary, var(--sg-gold)); background: color-mix(in srgb, var(--g-primary, #d9b45f) 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--g-primary, #d9b45f) 30%, transparent); }
      .sg-appearance .ap-logo-preview img { max-width: 100%; max-height: 100%; object-fit: contain; }

      /* palettes — swatch cards painted from each palette's own tokens */
      .sg-appearance .ap-palettes { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 14px; }
      .sg-appearance .ap-palette { padding: 10px 10px 12px; outline: none; }
      .sg-appearance .ap-palette--active { box-shadow: 0 0 0 2px var(--sg-gold), 0 0 0 6px var(--glass-gold-a16), var(--glass-elev-2, none); }
      .sg-appearance .ap-palette--active::before { background: none; }
      .sg-appearance .ap-palette__mini { position: relative; display: grid; grid-template-columns: 26% 1fr; height: 92px; border-radius: 10px; overflow: hidden; background: var(--p-bg); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--p-fg) 12%, transparent); }
      .sg-appearance .ap-palette__side { display: grid; align-content: start; gap: 5px; padding: 9px 7px; background: color-mix(in srgb, var(--p-tint) 85%, var(--p-bg)); border-right: 1px solid color-mix(in srgb, var(--p-fg) 8%, transparent); }
      .sg-appearance .ap-palette__side i { display: block; height: 5px; border-radius: 3px; background: color-mix(in srgb, var(--p-fg) 22%, transparent); }
      .sg-appearance .ap-palette__side i:first-child { background: var(--p-primary); }
      .sg-appearance .ap-palette__body { display: grid; align-content: start; gap: 6px; padding: 10px; }
      .sg-appearance .ap-palette__body b { display: block; width: 62%; height: 7px; border-radius: 4px; background: var(--p-fg); opacity: 0.85; }
      .sg-appearance .ap-palette__body s { display: block; width: 84%; height: 5px; border-radius: 3px; background: color-mix(in srgb, var(--p-fg) 26%, transparent); }
      .sg-appearance .ap-palette__body u { display: inline-flex; width: 46px; height: 15px; margin-top: 4px; border-radius: 5px; background: var(--p-primary); box-shadow: 0 4px 12px -4px var(--p-primary); }
      .sg-appearance .ap-palette__body em { position: absolute; right: 9px; bottom: 9px; width: 14px; height: 14px; border-radius: 50%; background: var(--p-accent); box-shadow: 0 0 10px var(--p-accent); }
      .sg-appearance .ap-palette__swatch-row { display: flex; gap: 5px; margin: 10px 2px 0; }
      .sg-appearance .ap-palette__swatch { flex: 1; height: 8px; border-radius: 4px; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sg-fg) 14%, transparent); }
      .sg-appearance .ap-palette__meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 9px 2px 0; }
      .sg-appearance .ap-palette__name { color: var(--sg-fg); font-size: 13px; font-weight: 640; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sg-appearance .ap-palette__mode { color: var(--sg-fg-3); font-size: 9.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
      .sg-appearance .ap-palette__check { position: absolute; top: 16px; right: 16px; z-index: 2; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; color: var(--glass-ink, #0b0906); background: var(--glass-gold-fill, var(--sg-gold)); box-shadow: 0 4px 12px -2px var(--glass-gold-a40); }

      /* background effect tiles */
      .sg-appearance .ap-bg-feature { display: grid; grid-template-columns: minmax(0, 1fr); margin-bottom: 14px; }
      .sg-appearance .ap-bg-preview { position: relative; display: block; width: 100%; padding: 0; overflow: hidden; border-radius: var(--sg-radius-md); cursor: pointer; box-shadow: inset 0 0 0 1px var(--glass-stroke-strong), var(--glass-elev-1, none); transition: box-shadow var(--sg-dur) var(--sg-ease), transform var(--sg-dur) var(--sg-spring); }
      .sg-appearance .ap-bg-preview:hover { transform: var(--glass-lift, translateY(-1px)); }
      .sg-appearance .ap-bg-preview--active { box-shadow: 0 0 0 2px var(--sg-gold), 0 0 0 6px var(--glass-gold-a16), var(--glass-elev-2, none); }
      .sg-appearance .ap-bg-preview img { display: block; width: 100%; height: 86px; object-fit: cover; }
      .sg-appearance .ap-bg-preview span { position: absolute; left: 14px; bottom: 11px; font-size: 12.5px; font-weight: 650; color: #f4f1ea; text-shadow: 0 1px 6px rgba(0, 0, 0, 0.85); }
      .sg-appearance .ap-bg-preview span em { font-style: normal; color: var(--g-primary, #d9b45f); }
      .sg-appearance .ap-bg-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
      .sg-appearance .ap-bg-tile { display: flex; flex-direction: column; gap: 0; padding: 6px; text-align: left; border: 0; font: inherit; color: inherit; }
      .sg-appearance .ap-bg-tile__thumb { --ap-thumb-base: #0b0a0d; display: block; height: 48px; border-radius: 9px; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08); }
      .sg-appearance .ap-bg-tile__name { display: flex; align-items: center; gap: 6px; margin: 8px 4px 2px; color: var(--sg-fg); font-size: 12.5px; font-weight: 620; }
      .sg-appearance .ap-bg-tile__hint { margin: 0 4px 3px; color: var(--sg-fg-3); font-size: 11px; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sg-appearance .ap-mode-chip--active { box-shadow: 0 0 0 2px var(--sg-gold), 0 0 0 5px var(--glass-gold-a16), var(--glass-elev-1, none); }
      .sg-appearance .ap-mode-chip--active::before { background: none; }
      .sg-appearance .ap-mode-chip--active .ap-bg-tile__name { color: var(--sg-gold); }

      /* fields */
      .sg-appearance .ap-field { margin-bottom: 14px; }
      .sg-appearance .ap-field:last-child { margin-bottom: 0; }
      .sg-appearance .ap-label { display: block; margin-bottom: 7px; color: var(--sg-fg-3); font-size: 10.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
      .sg-appearance .ap-color-row { display: grid; grid-template-columns: 42px minmax(0, 1fr) 30px; gap: 8px; align-items: center; }
      .sg-appearance .ap-label-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
      .sg-appearance .ap-color-swatch { width: 42px; height: 38px; padding: 0; border: 0; border-radius: 11px; cursor: pointer; background: transparent; box-shadow: inset 0 0 0 1px var(--glass-stroke-strong), var(--glass-elev-1, none); }
      .sg-appearance .ap-color-swatch::-webkit-color-swatch-wrapper { padding: 3px; }
      .sg-appearance .ap-color-swatch::-webkit-color-swatch { border: 0; border-radius: 8px; }
      .sg-appearance .ap-color-swatch::-moz-color-swatch { border: 0; border-radius: 8px; }
      .sg-appearance .ap-input { font-family: var(--glass-font-mono, ui-monospace, monospace); font-size: 12.5px; }
      .sg-appearance .ap-input--text { font-family: inherit; font-size: 13.5px; }
      .sg-appearance .ap-color-key { color: var(--sg-fg-4); font-size: 11px; white-space: nowrap; font-family: var(--glass-font-mono, ui-monospace, monospace); }
      .sg-appearance .ap-color-reset { width: 30px; min-height: 30px; }
      .sg-appearance .ap-color-reset:hover:not([disabled]) { color: var(--sg-bad); }
      .sg-appearance .ap-color-reset-slot { width: 30px; }

      /* Apple-style switch */
      .sg-appearance .ap-toggle-row { display: flex; align-items: center; gap: 12px; cursor: pointer; user-select: none; min-height: 32px; }
      .sg-appearance .ap-toggle-row .ap-toggle-label { color: var(--sg-fg); font-size: 13.5px; font-weight: 560; }
      .sg-appearance .ap-toggle-input { position: absolute; opacity: 0; pointer-events: none; }
      .sg-appearance .ap-toggle-track { position: relative; flex: none; width: 46px; height: 28px; border-radius: 999px; background: color-mix(in srgb, var(--sg-fg) 16%, transparent); box-shadow: inset 0 0 0 1px var(--glass-stroke), inset 0 1px 2px rgba(0, 0, 0, 0.18); transition: background var(--sg-dur) var(--sg-ease), box-shadow var(--sg-dur) var(--sg-ease); }
      .sg-appearance .ap-toggle-thumb { position: absolute; top: 2px; left: 2px; width: 24px; height: 24px; border-radius: 50%; background: #fff; box-shadow: 0 3px 8px rgba(0, 0, 0, 0.3), 0 1px 1px rgba(0, 0, 0, 0.16); transition: transform var(--glass-dur, 240ms) var(--sg-spring); }
      .sg-appearance .ap-toggle-input:checked + .ap-toggle-track { background: var(--glass-gold-fill, var(--sg-gold)); box-shadow: inset 0 0 0 1px var(--glass-gold-a24), 0 0 14px -4px var(--glass-gold-a40); }
      .sg-appearance .ap-toggle-input:checked + .ap-toggle-track .ap-toggle-thumb { transform: translateX(18px); }
      .sg-appearance .ap-toggle-input:focus-visible + .ap-toggle-track { box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--sg-gold)); }

      /* sliders */
      .sg-appearance .ap-slider-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
      .sg-appearance .ap-slider__value { color: var(--sg-fg); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; padding: 2px 8px; border-radius: 7px; background: var(--glass-hover, transparent); }
      .sg-appearance .ap-slider { -webkit-appearance: none; appearance: none; width: 100%; height: 6px; margin: 6px 0 2px; border-radius: 999px; outline: none; cursor: pointer;
        background: linear-gradient(90deg, var(--sg-gold) 0, var(--sg-gold) var(--p, 50%), color-mix(in srgb, var(--sg-fg) 14%, transparent) var(--p, 50%)); }
      .sg-appearance .ap-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.12), 0 3px 8px rgba(0, 0, 0, 0.35); }
      .sg-appearance .ap-slider::-moz-range-thumb { width: 20px; height: 20px; border: 0; border-radius: 50%; background: #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.12), 0 3px 8px rgba(0, 0, 0, 0.35); }
      .sg-appearance .ap-slider:focus-visible::-webkit-slider-thumb { box-shadow: var(--glass-focus-ring); }

      /* logo row */
      .sg-appearance .ap-logo-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
      .sg-appearance .ap-logo-row .ap-logo-preview { width: 60px; height: 60px; }

      /* status banners */
      .sg-appearance .ap-status { display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-radius: var(--sg-radius-md); font-size: 13px; }
      .sg-appearance .ap-status--success { color: var(--sg-ok); background: color-mix(in srgb, var(--sg-ok) 10%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sg-ok) 28%, transparent); }
      .sg-appearance .ap-status--error { color: var(--sg-bad); background: color-mix(in srgb, var(--sg-bad) 10%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sg-bad) 28%, transparent); }

      /* sticky save bar */
      .sg-appearance .ap-actions { position: sticky; bottom: 14px; z-index: 5; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 18px;
        background: var(--glass-sheen, none), var(--glass-4, rgba(18, 17, 15, 0.92)); box-shadow: var(--glass-elev-3, 0 20px 50px -18px rgba(0, 0, 0, 0.8)); }
      .sg-appearance .ap-actions__msg { display: inline-flex; align-items: center; gap: 8px; color: var(--sg-fg-2); font-size: 13px; margin-right: auto; }
      .sg-appearance .ap-seg > button { min-width: 64px; justify-content: center; }

      @media (max-width: 1100px) {
        .sg-appearance .ap-theme { grid-template-columns: minmax(0, 1fr); }
      }
      @media (max-width: 900px) {
        .sg-appearance .ap-grid { grid-template-columns: minmax(0, 1fr); }
      }
      @media (max-width: 720px) {
        .sg-appearance { padding: 12px 12px 96px; }
        .sg-appearance .ap-card { padding: 16px; }
        .sg-appearance .ap-mode-seg > button { padding: 11px 6px; font-size: 12.5px; gap: 5px; }
        .sg-appearance .ap-palettes { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
        .sg-appearance .ap-palette__mini { height: 74px; }
        .sg-appearance .ap-bg-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .sg-appearance .ap-actions { bottom: 8px; }
        .sg-appearance .ap-actions__msg { flex-basis: 100%; }
        .sg-appearance .ap-actions .sg-btn { flex: 1 1 auto; }
      }
      @media (prefers-reduced-motion: reduce) {
        .sg-appearance .ap-dirty-pill, .sg-appearance .ap-toggle-thumb, .sg-appearance .ap-bg-preview { animation: none !important; transition: none !important; }
      }
      @media (prefers-reduced-transparency: reduce) {
        .sg-appearance .ap-actions { backdrop-filter: none; -webkit-backdrop-filter: none; background: var(--glass-solid, var(--glass-4)); }
      }
    </style>
  `;
}

function renderPreview(payload: AppBrandingPayload): TemplateResult {
  const logo = payload.branding.logoDataUrl || payload.branding.logoUrl;
  return html`
    <div class="ap-preview-frame" aria-label="Live brand preview">
      <div class="ap-preview-bar"><i></i><i></i><i></i><span>Live preview</span></div>
      <div class="ap-preview">
        <div class="ap-preview-head">
          <div class="ap-logo-preview">
            ${logo ? html`<img src=${logo} alt="logo" />` : sgIcon("spark", 22)}
          </div>
          <div style="min-width:0">
            <div class="ap-preview-title">${payload.branding.appName || "InfiniBot"}</div>
            <div class="ap-preview-tag">${payload.branding.tagline || "Control Terminal"}</div>
          </div>
        </div>
        <div class="ap-preview-row">
          <span class="ap-preview-btn">Primary action</span>
          <span class="ap-preview-chip"><i></i>live preview</span>
        </div>
        <div class="ap-preview-lines"><span style="width:88%"></span><span style="width:64%"></span><span style="width:76%"></span></div>
      </div>
    </div>
  `;
}

function renderThemeModeRow(state: AppViewState, draft: AppBrandingPayload): TemplateResult {
  return html`
    <div class="ap-field">
      <label class="ap-label">Mode</label>
      <div class="sg-seg ap-mode-seg ap-row" role="group" aria-label="Theme mode">
        ${THEME_MODE_OPTIONS.map(
          (opt) => html`
            <button
              class="ap-mode-chip ${draft.theme.mode === opt.id ? "ap-mode-chip--active active" : ""}"
              aria-pressed=${draft.theme.mode === opt.id ? "true" : "false"}
              @click=${() => updateDraftThemeMode(state, opt.id)}
            >
              ${sgIcon(THEME_MODE_ICONS[opt.id] ?? "eye", 15)} ${opt.label}
            </button>
          `,
        )}
      </div>
      <p class="ap-mode-hint">System follows your OS. HUD is the cinematic heads-up variant.</p>
    </div>
  `;
}

// Tiny inline SVG snapshot of the ambient-grid look (grid hairlines + deep
// vignette + a faint gold beam) so the default background has a real preview
// in the picker rather than just a chip. ~2 KB, no network fetch.
const AMBIENT_GRID_PREVIEW_SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 160 60' preserveAspectRatio='xMidYMid slice'>
  <defs>
    <pattern id='ag' width='10' height='10' patternUnits='userSpaceOnUse'>
      <path d='M10 0H0V10' fill='none' stroke='rgba(212,175,55,0.18)' stroke-width='0.6'/>
    </pattern>
    <radialGradient id='agv' cx='50%' cy='50%' r='75%'>
      <stop offset='0%' stop-color='rgba(15,15,15,0)'/>
      <stop offset='100%' stop-color='rgba(0,0,0,0.85)'/>
    </radialGradient>
    <linearGradient id='agb' x1='0' y1='0' x2='1' y2='0'>
      <stop offset='0%' stop-color='rgba(212,175,55,0)'/>
      <stop offset='50%' stop-color='rgba(212,175,55,0.10)'/>
      <stop offset='100%' stop-color='rgba(212,175,55,0)'/>
    </linearGradient>
  </defs>
  <rect width='160' height='60' fill='#0a0a0c'/>
  <rect width='160' height='60' fill='url(%23ag)'/>
  <rect x='40' width='80' height='60' fill='url(%23agb)'/>
  <rect width='160' height='60' fill='url(%23agv)'/>
</svg>`;

function renderBackgroundRow(state: AppViewState, draft: AppBrandingPayload): TemplateResult {
  // Mirror resolveBackgroundStyle: when no explicit bg is chosen, the
  // InfiniBot Noir palette pre-selects ambient-grid (its signature look).
  const current: BackgroundStyle =
    draft.theme.background ??
    (draft.theme.paletteId === "infinibot-gold" ? "ambient-grid" : "gradient");
  const previewUri = `data:image/svg+xml;utf8,${AMBIENT_GRID_PREVIEW_SVG.replace(/\n\s*/g, " ").replace(/#/g, "%23")}`;
  return html`
    <div class="ap-field">
      <div class="ap-bg-feature">
        <div
          class="ap-bg-preview ${current === "ambient-grid" ? "ap-bg-preview--active" : ""}"
          role="button"
          tabindex="0"
          aria-pressed=${current === "ambient-grid" ? "true" : "false"}
          title="Ambient Grid (default) — subtle gold grid with deep vignette. Always-on, GPU-friendly."
          @click=${() => updateDraftBackground(state, "ambient-grid")}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              updateDraftBackground(state, "ambient-grid");
            }
          }}
        >
          <img src=${previewUri} alt="Ambient Grid preview" />
          <span>Ambient Grid <em>· default</em></span>
        </div>
      </div>
      <div class="ap-bg-tiles ap-row">
        ${BACKGROUND_OPTIONS.map((opt) => {
          const active = current === opt.id;
          return html`
            <button
              class="sg-card sg-card--interactive ap-bg-tile ap-mode-chip ${active ? "ap-mode-chip--active" : ""}"
              title=${opt.hint}
              aria-pressed=${active ? "true" : "false"}
              @pointermove=${sgGloss}
              @click=${() => updateDraftBackground(state, opt.id)}
            >
              <span class="ap-bg-tile__thumb" style=${`background:${BG_THUMBS[opt.id] ?? "var(--ap-thumb-base)"}`}></span>
              <span class="ap-bg-tile__name">${active ? sgLed("gold") : nothing}${opt.label}</span>
              <span class="ap-bg-tile__hint">${opt.hint}</span>
            </button>
          `;
        })}
      </div>
    </div>
  `;
}

function renderPalettes(state: AppViewState, draft: AppBrandingPayload): TemplateResult {
  return html`
    <div class="ap-palettes">
      ${draft.palettes.map((p) => {
        const active = draft.theme.paletteId === p.id;
        const select = () => selectDraftPalette(state, p.id);
        const t = p.tokens;
        // Palette colours are painted straight from the palette's own tokens.
        const vars = [
          `--p-bg:${t.bg ?? (p.mode === "light" ? "#f4f4f5" : "#0a0a0e")}`,
          `--p-fg:${t.fg ?? (p.mode === "light" ? "#18181b" : "#f5f5f4")}`,
          `--p-primary:${t.primary ?? "#fbbf24"}`,
          `--p-accent:${t.accent ?? t.primary ?? "#a855f7"}`,
          `--p-tint:${t.surfaceTint ?? t.bg ?? "#1e1b2e"}`,
        ].join(";");
        return html`
          <div
            class="sg-card sg-card--interactive ap-palette ${active ? "ap-palette--active" : ""}"
            role="button"
            tabindex="0"
            style=${vars}
            aria-pressed=${active ? "true" : "false"}
            aria-label=${`${p.name} palette (${p.mode})`}
            @pointermove=${sgGloss}
            @click=${select}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                select();
              }
            }}
          >
            <div class="ap-palette__mini" aria-hidden="true">
              <div class="ap-palette__side"><i></i><i></i><i></i><i></i></div>
              <div class="ap-palette__body"><b></b><s></s><s style="width:58%"></s><u></u><em></em></div>
            </div>
            ${active ? html`<span class="ap-palette__check">${sgIcon("check", 13)}</span>` : nothing}
            <div class="ap-palette__swatch-row" aria-hidden="true">
              <div class="ap-palette__swatch" style="background:${t.primary}"></div>
              <div class="ap-palette__swatch" style="background:${t.accent}"></div>
              <div class="ap-palette__swatch" style="background:${t.surfaceTint}"></div>
            </div>
            <div class="ap-palette__meta">
              <span class="ap-palette__name">${p.name}</span>
              <span class="ap-palette__mode">${p.mode}</span>
            </div>
          </div>
        `;
      })}
    </div>
  `;
}

// Map each appearance-picker color token to the canonical CSS variable it
// drives, so when no explicit token override is set we can read the actual
// rendered colour off the document and show that in the swatch. Without this
// the picker would always show #000000 for tokens that aren't in any palette
// (overlayColor, glassTint, glassBorderColor) even when the page is painting
// a real colour through their CSS-var fallback chain.
const COLOR_TOKEN_VAR: Record<string, string> = {
  primary: "--g-primary",
  accent: "--g-accent",
  surfaceTint: "--g-surface",
  bg: "--g-bg",
  fg: "--g-fg",
  overlayColor: "--g-overlay-color",
  glassTint: "--g-glass-tint",
  glassBorderColor: "--g-border",
};

// Browser color inputs only accept #rrggbb. Try to coerce any rendered
// CSS colour to that form; bail to undefined if it's transparent/none/etc.
function coerceToHex(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed || trimmed === "transparent" || trimmed === "none") return undefined;
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    return "#" + trimmed.slice(1).split("").map((c) => c + c).join("");
  }
  // rgb()/rgba() — extract first three components
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(trimmed);
  if (m) {
    const toHex = (n: string) => Math.round(Math.max(0, Math.min(255, parseFloat(n)))).toString(16).padStart(2, "0");
    return `#${toHex(m[1]!)}${toHex(m[2]!)}${toHex(m[3]!)}`;
  }
  return undefined;
}

function readRenderedColor(key: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  const cssVar = COLOR_TOKEN_VAR[key];
  if (!cssVar) return undefined;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(cssVar);
  return coerceToHex(raw);
}

function renderColor(
  state: AppViewState,
  label: string,
  key: "primary" | "accent" | "surfaceTint" | "bg" | "fg" | "overlayColor" | "glassTint" | "glassBorderColor",
  draft: AppBrandingPayload,
): TemplateResult {
  const currentToken = draft.theme.tokens?.[key];
  const paletteToken = draft.palettes.find((p) => p.id === draft.theme.paletteId)?.tokens?.[key];
  // Resolution order: explicit user override → palette default → live computed
  // CSS var → opaque fallback. The computed-style read makes the swatch match
  // what's actually painting (e.g. a derived border color, a transparent
  // overlay) rather than always defaulting to #000000.
  const explicit = (currentToken as string | undefined) ?? (paletteToken as string | undefined);
  const computed = explicit ? undefined : readRenderedColor(key);
  const value = explicit ?? computed ?? "#000000";
  const isUnset = !explicit;
  const change = (v: string) => updateDraftTokens(state, { [key]: v } as any);
  const reset = () => updateDraftTokens(state, { [key]: undefined } as any);
  return html`
    <div class="ap-field">
      <div class="ap-label-row">
        <label class="ap-label">${label}</label>
        <span class="ap-color-key">${key}${isUnset ? " · auto" : ""}</span>
      </div>
      <div class="ap-color-row">
        <input
          type="color"
          class="ap-color-swatch"
          aria-label=${`${label} colour`}
          .value=${value}
          @input=${(e: Event) => change((e.target as HTMLInputElement).value)}
        />
        <input
          type="text"
          class="sg-input ap-input"
          aria-label=${`${label} hex`}
          .value=${value}
          @change=${(e: Event) => {
            const v = (e.target as HTMLInputElement).value.trim();
            if (/^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(v)) change(v);
          }}
        />
        ${explicit
          ? html`<button class="sg-btn sg-btn--ghost sg-btn--sm sg-btn--icon ap-color-reset" title="Reset to default" aria-label="Reset to default" @click=${reset}>${sgIcon("close", 14)}</button>`
          : html`<span class="ap-color-reset-slot"></span>`}
      </div>
    </div>
  `;
}

function renderToggle(
  state: AppViewState,
  label: string,
  key: "overlayEnabled" | "glassEnabled",
  draft: AppBrandingPayload,
  defaultOn: boolean,
): TemplateResult {
  const currentToken = draft.theme.tokens?.[key];
  const checked = (currentToken as boolean | undefined) ?? defaultOn;
  return html`
    <div class="ap-field">
      <label class="ap-toggle-row">
        <input
          type="checkbox"
          class="ap-toggle-input"
          role="switch"
          .checked=${checked}
          @change=${(e: Event) => {
            const v = (e.target as HTMLInputElement).checked;
            updateDraftTokens(state, { [key]: v } as any);
          }}
        />
        <span class="ap-toggle-track"><span class="ap-toggle-thumb"></span></span>
        <span class="ap-toggle-label">${label}</span>
      </label>
    </div>
  `;
}

function renderSlider(
  state: AppViewState,
  label: string,
  key: "blur" | "blurHeavy" | "radius" | "shadowDepth" | "surfaceAlpha" | "overlayOpacity" | "overlayBlur" | "glassTintStrength",
  min: number,
  max: number,
  step: number,
  draft: AppBrandingPayload,
): TemplateResult {
  const paletteToken = draft.palettes.find((p) => p.id === draft.theme.paletteId)?.tokens?.[key];
  const currentToken = draft.theme.tokens?.[key];
  const raw = (currentToken as number | undefined) ?? (paletteToken as number | undefined);
  // Snap fallback midpoint to the slider's step grid so the numeric label and
  // the slider thumb agree on first paint — without this, e.g. shadow depth
  // (range 0.2-2.5, step 0.1) computes midpoint 1.35 but the browser snaps the
  // slider to 1.4, leaving the readout off-by-one until first interaction.
  const snap = (n: number) => Number((Math.round(n / step) * step).toFixed(6));
  const display = raw != null ? raw : snap((min + max) / 2);
  const pct = Math.max(0, Math.min(100, ((Number(display) - min) / (max - min)) * 100));
  return html`
    <div class="ap-field">
      <div class="ap-slider-head">
        <label class="ap-label">${label}</label>
        <div class="ap-slider__value">${display}</div>
      </div>
      <input
        type="range"
        class="ap-slider"
        aria-label=${label}
        style=${`--p:${pct}%`}
        min=${min}
        max=${max}
        step=${step}
        .value=${String(display)}
        @input=${(e: Event) => {
          const input = e.target as HTMLInputElement;
          const v = Number(input.value);
          input.style.setProperty("--p", `${((v - min) / (max - min)) * 100}%`);
          updateDraftTokens(state, { [key]: v } as any);
        }}
      />
    </div>
  `;
}

function cardHead(icon: SgIconName, title: string, aside?: string): TemplateResult {
  return html`<h2><span class="ap-h-ico">${sgIcon(icon, 16)}</span>${title}${aside ? html`<small>${aside}</small>` : nothing}</h2>`;
}

function renderBrandingCard(
  state: AppViewState,
  draft: AppBrandingPayload,
): TemplateResult {
  const logo = draft.branding.logoDataUrl || draft.branding.logoUrl;
  return html`
    <div class="sg-panel ap-card">
      ${cardHead("brush", "Branding", "Name, tagline and logo")}

      <div class="ap-field">
        <label class="ap-label">App name</label>
        <input
          type="text"
          class="sg-input ap-input ap-input--text"
          placeholder="InfiniBot"
          .value=${draft.branding.appName ?? ""}
          @input=${(e: Event) =>
            updateDraftBranding(state, { appName: (e.target as HTMLInputElement).value })}
        />
      </div>

      <div class="ap-field">
        <label class="ap-label">Tagline</label>
        <input
          type="text"
          class="sg-input ap-input ap-input--text"
          placeholder="Control Terminal"
          .value=${draft.branding.tagline ?? ""}
          @input=${(e: Event) =>
            updateDraftBranding(state, { tagline: (e.target as HTMLInputElement).value })}
        />
      </div>

      <div class="ap-field">
        <label class="ap-label">Logo</label>
        <div class="ap-logo-row">
          <div class="ap-logo-preview">
            ${logo ? html`<img src=${logo} alt="logo" />` : sgIcon("spark", 22)}
          </div>
          <label class="sg-btn ap-btn" style="cursor:pointer;">
            ${sgIcon("upload", 15)} Upload image
            <input
              type="file"
              accept="image/*"
              style="display:none;"
              @change=${(e: Event) => {
                const f = (e.target as HTMLInputElement).files?.[0];
                if (f) void uploadLogoFile(state, f);
              }}
            />
          </label>
          ${logo
            ? html`<button
                class="sg-btn sg-btn--danger ap-btn ap-btn--danger"
                @click=${() => updateDraftBranding(state, { logoDataUrl: "", logoUrl: "" })}
              >${sgIcon("trash", 15)} Remove</button>`
            : html`<span class="sg-faint" style="font-size:12px">PNG or SVG, square works best.</span>`}
        </div>
      </div>

      <div class="ap-field">
        <label class="ap-label">Logo URL (override)</label>
        <input
          type="text"
          class="sg-input ap-input ap-input--text"
          placeholder="https://example.com/logo.png"
          .value=${draft.branding.logoUrl ?? ""}
          @change=${(e: Event) =>
            updateDraftBranding(state, { logoUrl: (e.target as HTMLInputElement).value.trim() })}
        />
      </div>
    </div>
  `;
}

const MODE_LABEL: Record<string, string> = { system: "System", dark: "Dark", light: "Light", hud: "HUD" };

export function renderAppearance(
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  ensureSystemGlass();
  const s = state.appBrandingState;
  if (!s) {
    void loadAppBranding(state, client);
    return html`${styles()}<div class="sg-page sg-appearance ap-root">
      ${sgAurora()}
      ${sgHero({ eyebrow: "Settings", title: "", accent: "Appearance", icon: "palette", sub: "Loading appearance…" })}
      <div class="sg-panel">${sgSkeleton(4, true)}</div>
    </div>`;
  }
  if (!s.draft) {
    return html`${styles()}<div class="sg-page sg-appearance ap-root">
      ${sgAurora()}
      ${sgHero({ eyebrow: "Settings", title: "", accent: "Appearance", icon: "palette", sub: "Initializing theme…" })}
      <div class="sg-panel">${sgSkeleton(4, true)}</div>
    </div>`;
  }
  const draft = s.draft;
  const dirty = isDraftDirty(s);
  const palette = draft.palettes.find((p) => p.id === draft.theme.paletteId);
  const bgId: BackgroundStyle =
    draft.theme.background ?? (draft.theme.paletteId === "infinibot-gold" ? "ambient-grid" : "gradient");
  const bgLabel = (BACKGROUND_OPTIONS.find((o) => o.id === bgId)?.label ?? bgId).replace(" (default)", "");
  const glassOn = draft.theme.tokens?.glassEnabled !== false;

  return html`
    ${styles()}
    <div class="sg-page sg-appearance ap-root">
      ${sgAurora()}
      ${sgHero({
        eyebrow: "Settings",
        title: "",
        accent: "Appearance",
        icon: "palette",
        sub: html`Theme, colours, glass intensity, app name and logo. Changes preview live and save to the gateway.
          <span class="ap-hero-chips">
            ${sgChip(html`${sgIcon(THEME_MODE_ICONS[draft.theme.mode] ?? "eye", 12)} ${MODE_LABEL[draft.theme.mode] ?? draft.theme.mode} mode`)}
            ${sgChip(html`<i class="ap-dot" style="background:${palette?.tokens.primary ?? "var(--g-primary)"}"></i>${palette?.name ?? "Custom"} palette`, "gold")}
            ${sgChip(html`${sgIcon("layers", 12)} ${bgLabel}`)}
            ${sgChip(glassOn ? "Glass on" : "Glass off", glassOn ? "ok" : undefined, glassOn)}
            ${dirty ? html`<span class="ap-dirty-pill" title="You have unsaved changes">${sgChip("Unsaved", "warn", true)}</span>` : nothing}
          </span>`,
        status: dirty ? { tone: "warn", label: "Unsaved changes" } : { tone: "ok", label: "Saved" },
      })}

      ${s.error
        ? html`<div class="ap-status ap-status--error" role="alert">${sgIcon("alert", 16)}${s.error}</div>`
        : nothing}
      ${getLastBackgroundError()
        ? html`<div class="ap-status ap-status--error" role="alert">${sgIcon("alert", 16)}${getLastBackgroundError()}</div>`
        : nothing}
      ${s.successMessage
        ? html`<div class="ap-status ap-status--success" role="status">${sgIcon("check", 16)}${s.successMessage}</div>`
        : nothing}

      <section class="sg-panel ap-card sg-enter">
        ${cardHead("sun", "Theme", "Applies instantly")}
        <div class="ap-theme">
          <div>
            ${renderThemeModeRow(state, draft)}
            <div class="ap-quick">
              <label class="ap-label">Quick switches</label>
              ${renderToggle(state, "Glass blur on panels", "glassEnabled", draft, true)}
              ${renderToggle(state, "Background overlay", "overlayEnabled", draft, true)}
            </div>
          </div>
          ${renderPreview(draft)}
        </div>
      </section>

      <section class="sg-panel ap-card sg-enter">
        ${cardHead("palette", "Palette", `${draft.palettes.length} palettes`)}
        ${renderPalettes(state, draft)}
      </section>

      <section class="sg-panel ap-card sg-enter">
        ${cardHead("layers", "Animated background", bgLabel)}
        ${renderBackgroundRow(state, draft)}
      </section>

      <div class="ap-grid">
        <div class="sg-panel ap-card">
          ${cardHead("palette", "Colors", "Overrides the palette")}
          ${renderColor(state, "Primary", "primary", draft)}
          ${renderColor(state, "Accent", "accent", draft)}
          ${renderColor(state, "Surface tint", "surfaceTint", draft)}
          ${renderColor(state, "Background", "bg", draft)}
        </div>

        <div class="sg-panel ap-card">
          ${cardHead("grid", "Surfaces")}
          ${renderSlider(state, "Blur", "blur", 0, 60, 1, draft)}
          ${renderSlider(state, "Heavy blur", "blurHeavy", 0, 80, 1, draft)}
          ${renderSlider(state, "Corner radius", "radius", 2, 32, 1, draft)}
          ${renderSlider(state, "Shadow depth", "shadowDepth", 0.2, 2.5, 0.1, draft)}
          ${renderSlider(state, "Surface opacity", "surfaceAlpha", 0, 1, 0.02, draft)}
        </div>

        <div class="sg-panel ap-card">
          ${cardHead("spark", "Glassmorphism")}
          ${renderToggle(state, "Enable glass blur", "glassEnabled", draft, true)}
          ${renderColor(state, "Glass tint", "glassTint", draft)}
          ${renderSlider(state, "Tint strength", "glassTintStrength", 0, 1, 0.02, draft)}
          ${renderColor(state, "Glass border", "glassBorderColor", draft)}
        </div>

        <div class="sg-panel ap-card">
          ${cardHead("eye", "Background overlay")}
          ${renderToggle(state, "Enable overlay", "overlayEnabled", draft, true)}
          ${renderColor(state, "Tint color", "overlayColor", draft)}
          ${renderSlider(state, "Tint opacity", "overlayOpacity", 0, 1, 0.02, draft)}
          ${renderSlider(state, "Backdrop blur", "overlayBlur", 0, 30, 1, draft)}
        </div>

        ${renderBrandingCard(state, draft)}

        <div class="sg-panel ap-card" data-ap-sidebar>
          ${cardHead("apps", "Sidebar")}
          <div class="ap-field">
            <label class="ap-toggle-row">
              <input
                type="checkbox"
                class="ap-toggle-input"
                role="switch"
                data-setup-highlight-toggle
                .checked=${isSetupHighlightEnabled()}
                @change=${(e: Event) => {
                  setSetupHighlightEnabled((e.target as HTMLInputElement).checked);
                  state.requestUpdate?.();
                }}
              />
              <span class="ap-toggle-track"><span class="ap-toggle-thumb"></span></span>
              <span class="ap-toggle-label">Highlight pages that need setup</span>
            </label>
          </div>
          <p class="ap-note">
            Pages that can't work yet (no email account, no model key, a plugin missing its settings) get a soft gold
            glow in the sidebar. Saved in this browser.
          </p>
          <button
            class="sg-btn ap-btn"
            title="Show optional setup hints you dismissed or snoozed"
            @click=${() => {
              clearSetupSnoozes();
              state.requestUpdate?.();
            }}
          >
            ${sgIcon("refresh", 15)} Restore dismissed hints
          </button>
        </div>

        <div class="sg-panel ap-card">
          ${cardHead("users", "Profiles")}
          <p class="ap-note">
            Separate data &amp; agent memory per profile; shared services. Appearance is saved per profile.
          </p>
          <button
            class="sg-btn ap-btn"
            @click=${() => {
              setGateEnabled(true);
              markGateUnpassed();
              state.requestUpdate?.();
            }}
          >
            ${sgIcon("user", 15)} Switch / manage profiles…
          </button>
        </div>

        ${renderChatFollowCard(state)}

        ${renderPerformanceCard(state)}

        <pair-invite-panel></pair-invite-panel>
      </div>

      <div class="sg-glass ap-actions">
        <span class="ap-actions__msg">
          ${dirty ? html`${sgLed("warn")} You have unsaved changes` : html`${sgLed("ok")} All changes saved`}
        </span>
        <button
          class="sg-btn ap-btn"
          ?disabled=${!dirty}
          @click=${() => revertDraft(state)}
        >Revert</button>
        <button class="sg-btn sg-btn--ghost ap-btn" @click=${() => resetDraftToDefault(state)}>Reset to default</button>
        <button
          class="sg-btn sg-btn--primary ap-btn ap-btn--primary"
          ?disabled=${s.saving || !dirty}
          @click=${() => void saveDraft(state, client)}
          title=${dirty ? "Persist changes to the gateway" : "No changes to save"}
        >
          ${sgIcon("check", 15)} ${s.saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
      </div>
    </div>
  `;
}
