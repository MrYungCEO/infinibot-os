/**
 * voice-controls-dock.ts — sleek sticky voice-controls dock for the Voice HUD.
 *
 * A single horizontal glass pill pinned to the bottom-CENTRE of the viewport
 * (position:fixed; bottom:22px; left:50%; translateX(-50%)) regardless of scroll
 * or panel collapse. Sleek at rest (icon-only row, ~48px tall, radius 999px);
 * expands smoothly on the chevron into a larger flat-rounded panel (radius 22px)
 * with labelled controls + secondary actions.
 *
 * This dock does NOT own any voice logic — every button emits a CustomEvent that
 * <voice-session-view> maps onto the Robovoice call (connect / disconnect /
 * toggle-mute / agent-change / toggle-blob / toggle-settings / HUD toggle /
 * exit). No duplicated state.
 *
 * Mounted by <voice-session-view> only in HUD mode.
 *
 * Dynamic theme tokens only — no literal hex.
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

@customElement('voice-controls-dock')
export class VoiceControlsDock extends LitElement {
  // ── Live state mirrored from voice-chat (read-only) ──
  @property({ type: Boolean }) connected = false;
  @property({ type: Boolean }) isConnecting = false;
  @property({ type: Boolean }) isMuted = false;
  @property({ type: Boolean }) isUserSpeaking = false;
  @property({ type: Boolean }) isAgentSpeaking = false;
  /** Robovoice voice agents that can take a call. */
  @property({ attribute: false }) agents: Array<{ id: string; name: string }> = [];
  /** Agent the next call goes to. */
  @property({ type: String }) agentId: string | null = null;
  /** Why a call can't start (wallet empty, no agent…); '' = it can. */
  @property({ type: String }) connectBlocked = '';

  // ── Dock UI state ──
  @state() private expanded = false;
  private reducedMotion = false;

  private static readonly EXPAND_KEY = 'voice-controls-dock:expanded';

  connectedCallback(): void {
    super.connectedCallback();
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    try { this.expanded = localStorage.getItem(VoiceControlsDock.EXPAND_KEY) === '1'; } catch { /* ignore */ }
  }

  private _emit(name: string, detail?: unknown) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private _toggleExpand(force?: boolean) {
    this.expanded = force ?? !this.expanded;
    try { localStorage.setItem(VoiceControlsDock.EXPAND_KEY, this.expanded ? '1' : '0'); } catch { /* ignore */ }
  }

  private _onDockClick(e: MouseEvent) {
    // Shift-click anywhere on the dock toggles expansion (power-user shortcut).
    if (e.shiftKey) { this._toggleExpand(); }
  }

  render() {
    const micState = !this.connected ? 'OFFLINE'
      : this.isMuted ? 'MUTED'
      : this.isUserSpeaking ? 'LISTENING'
      : this.isAgentSpeaking ? 'AGENT'
      : 'LIVE';

    return html`
      <div
        class="dock ${this.expanded ? 'expanded' : ''} ${this.reducedMotion ? 'reduced' : ''}"
        role="toolbar"
        aria-label="Voice controls dock"
        @click=${this._onDockClick}
      >
        <!-- ── Collapsed icon-only row (always present) ── -->
        <div class="row primary">
          <!-- Call: start / end the Robovoice call -->
          <button
            class="dbtn ${this.connected ? 'rec' : ''} ${this.isConnecting ? 'busy' : ''}"
            ?disabled=${!this.connected && !this.isConnecting && !!this.connectBlocked}
            title=${this.connected || this.isConnecting ? 'End call' : (this.connectBlocked || 'Start a Robovoice call')}
            aria-label=${this.connected ? 'End call' : 'Start call'}
            @click=${() => this._emit(this.connected || this.isConnecting ? 'disconnect' : 'connect')}
          >${this.isConnecting ? spinnerIcon() : this.connected ? stopIcon() : micIcon()}</button>

          <!-- Mute / unmute (LiveKit) -->
          <button
            class="dbtn ${this.isMuted ? 'off' : ''} ${this.isUserSpeaking ? 'speaking' : ''}"
            ?disabled=${!this.connected}
            title=${this.isMuted ? 'Unmute mic' : 'Mute mic'}
            aria-label=${this.isMuted ? 'Unmute microphone' : 'Mute microphone'}
            aria-pressed=${this.isMuted}
            @click=${() => this._emit('toggle-mute')}
          >${this.isMuted ? micOffIcon() : speakerIcon()}</button>

          <span class="vsep"></span>

          <!-- Blob style / visualizer picker -->
          <button class="dbtn" title="Visualizer style" aria-label="Visualizer style"
            @click=${() => this._emit('toggle-blob')}>${blobIcon()}</button>

          <span class="vsep"></span>

          <!-- HUD toggle -->
          <button class="dbtn active" title="Toggle HUD" aria-label="Toggle HUD"
            @click=${() => this._emit('toggle-hud')}>${hudIcon()}</button>

          <!-- Exit HUD -->
          <button class="dbtn danger" title="Exit HUD" aria-label="Exit HUD"
            @click=${() => this._emit('exit-hud')}>${exitIcon()}</button>

          <span class="vsep"></span>

          <!-- Expand / collapse chevron -->
          <button class="dbtn chev" title=${this.expanded ? 'Collapse controls' : 'Expand controls'}
            aria-label=${this.expanded ? 'Collapse controls' : 'Expand controls'}
            aria-expanded=${this.expanded}
            @click=${(e: Event) => { e.stopPropagation(); this._toggleExpand(); }}
          >${chevronIcon()}</button>
        </div>

        <!-- ── Expanded panel (labelled controls + secondary actions) ── -->
        ${this.expanded ? html`
          <div class="row secondary">
            <div class="seg">
              <span class="seg-label">CALL</span>
              ${!this.connected ? html`
                <button class="wbtn primary" ?disabled=${this.isConnecting || !!this.connectBlocked}
                  title=${this.connectBlocked}
                  @click=${() => this._emit('connect')}>
                  ${this.isConnecting ? 'CONNECTING…' : '⏻ CONNECT'}
                </button>
              ` : html`
                <button class="wbtn danger" @click=${() => this._emit('disconnect')}>⏼ DISCONNECT</button>
              `}
              <span class="mic-state state-${micState.toLowerCase()}">${micState}</span>
            </div>

            <span class="vsep tall"></span>

            <div class="seg agent">
              <span class="seg-label">AGENT</span>
              <select
                class="agent-select"
                aria-label="Voice agent"
                ?disabled=${this.connected || this.isConnecting || this.agents.length === 0}
                @change=${(e: Event) => this._emit('agent-change', { id: (e.target as HTMLSelectElement).value })}
              >
                ${this.agents.length === 0 ? html`<option value="">No voice agents</option>` : nothing}
                ${this.agents.map((a) => html`<option value=${a.id} ?selected=${a.id === this.agentId}>${a.name}</option>`)}
              </select>
            </div>

            <span class="vsep tall"></span>

            <div class="seg">
              <span class="seg-label">VISUAL</span>
              <button class="wbtn ghost" title="Visualizer + colors" @click=${() => this._emit('toggle-blob')}>
                ${blobIcon()} Colors
              </button>
              <button class="wbtn ghost" title="Settings" @click=${() => this._emit('toggle-settings')}>
                ${gearIcon()} Settings
              </button>
            </div>
          </div>
        ` : nothing}
      </div>
    `;
  }

  static styles = css`
    :host {
      position: fixed;
      bottom: 22px;
      left: 50%;
      transform: translateX(-50%);
      /* Above the mesh (z:9000) + insights (z:7 within host) but below modals
         (settings overlay z:99999). */
      z-index: 9700;
      pointer-events: none;
      font-family: 'JetBrains Mono', 'SF Mono', 'Consolas', monospace;
    }

    .agent-select {
      appearance: none;
      max-width: 200px;
      padding: 6px 10px;
      border-radius: 8px;
      border: 1px solid var(--g-border, rgba(255,255,255,0.12));
      background: rgba(0, 0, 0, 0.3);
      color: var(--g-fg, #e4e4e7);
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }
    .agent-select option { background: #0b0b0d; color: #e4e4e7; }

    .dock {
      pointer-events: auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      box-sizing: border-box;
      padding: 8px 12px;
      border-radius: 999px;
      width: auto;
      /* Glassmorphism — gradient peel + hairline + ambient glow. */
      background:
        linear-gradient(to bottom,
          rgba(255, 255, 255, 0.10) 0%,
          rgba(0, 0, 0, 0.18) 100%),
        var(--g-surface, rgba(18, 18, 22, 0.6));
      border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 28%, var(--g-border, rgba(255,255,255,0.12)));
      box-shadow:
        0 4px 22px -8px color-mix(in srgb, var(--g-primary, #fbbf24) 35%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.06);
      -webkit-backdrop-filter: blur(12px) saturate(140%);
      backdrop-filter: blur(12px) saturate(140%);
      transition:
        border-radius 220ms cubic-bezier(.2,.8,.2,1),
        padding 220ms cubic-bezier(.2,.8,.2,1),
        background 220ms ease,
        box-shadow 220ms ease;
    }
    .dock.reduced { transition: none; }

    .dock.expanded {
      border-radius: 22px;
      padding: 10px 14px;
      box-shadow:
        0 10px 34px -10px color-mix(in srgb, var(--g-primary, #fbbf24) 42%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.07);
    }

    .row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .row.primary { height: 32px; }
    .row.secondary {
      flex-wrap: wrap;
      justify-content: center;
      gap: 8px;
      padding-top: 8px;
      margin-top: 2px;
      border-top: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 14%, var(--g-border, rgba(255,255,255,0.10)));
      max-width: min(78vw, 820px);
    }

    /* ── Icon buttons (collapsed row) — ≥32px hit targets ── */
    .dbtn {
      width: 32px;
      height: 32px;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--g-fg-dim, rgba(245,245,244,0.72));
      cursor: pointer;
      transition: background 140ms ease, color 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
    }
    .dbtn:hover:not(:disabled) {
      color: var(--g-fg, #f5f5f4);
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
      border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 32%, transparent);
    }
    .dbtn:disabled { opacity: 0.4; cursor: default; }
    .dbtn svg { width: 17px; height: 17px; display: block; }
    .dbtn.active {
      color: var(--g-primary, #fbbf24);
      border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 36%, transparent);
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 12%, transparent);
    }
    .dbtn.rec {
      color: var(--g-accent, #f87171);
      border-color: color-mix(in srgb, var(--g-accent, #f87171) 45%, transparent);
      box-shadow: 0 0 10px -2px color-mix(in srgb, var(--g-accent, #f87171) 60%, transparent);
      animation: dock-pulse 1.4s ease-in-out infinite;
    }
    .dbtn.speaking {
      color: var(--g-primary, #fbbf24);
      box-shadow: 0 0 10px -2px color-mix(in srgb, var(--g-primary, #fbbf24) 60%, transparent);
    }
    .dbtn.off { color: var(--g-fg-dim, rgba(245,245,244,0.5)); }
    .dbtn.danger:hover {
      color: var(--g-accent, #f87171);
      border-color: color-mix(in srgb, var(--g-accent, #f87171) 40%, transparent);
      background: color-mix(in srgb, var(--g-accent, #f87171) 12%, transparent);
    }
    .dbtn.chev svg { transition: transform 220ms cubic-bezier(.2,.8,.2,1); }
    .dock.expanded .dbtn.chev svg { transform: rotate(180deg); }
    @keyframes dock-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.55; }
    }

    .vsep {
      width: 1px;
      height: 18px;
      flex-shrink: 0;
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 22%, var(--g-border, rgba(255,255,255,0.12)));
    }
    .vsep.tall { height: 26px; }

    /* ── Expanded segments ── */
    .seg {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .seg-label {
      font-size: 8px;
      letter-spacing: 0.16em;
      color: var(--g-fg-dim, rgba(245,245,244,0.5));
      margin-right: 2px;
    }
    .wbtn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 30px;
      padding: 0 11px;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 22%, var(--g-border, rgba(255,255,255,0.12)));
      background: color-mix(in srgb, var(--g-surface, rgba(18,18,22,0.6)) 70%, transparent);
      color: var(--g-fg, #f5f5f4);
      font-family: inherit;
      font-size: 10px;
      letter-spacing: 0.06em;
      cursor: pointer;
      white-space: nowrap;
      transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
    }
    .wbtn svg { width: 13px; height: 13px; }
    .wbtn:hover:not(:disabled) {
      border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 45%, transparent);
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 12%, transparent);
    }
    .wbtn:disabled { opacity: 0.5; cursor: default; }
    .wbtn.primary {
      border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 50%, transparent);
      color: var(--g-primary, #fbbf24);
    }
    .wbtn.danger { color: var(--g-accent, #f87171); border-color: color-mix(in srgb, var(--g-accent, #f87171) 35%, transparent); }
    .wbtn.ghost { background: transparent; color: var(--g-fg-dim, rgba(245,245,244,0.78)); }
    .wbtn.active {
      color: var(--g-primary, #fbbf24);
      border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 42%, transparent);
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 12%, transparent);
    }

    .seg.session { min-width: 0; }
    .seg.session voice-session-selector {
      min-width: 150px;
      max-width: 240px;
      font-size: 10px;
    }

    .seg.agent { min-width: 0; }
    .seg.agent agent-employee-selector {
      min-width: 140px;
      max-width: 220px;
      font-size: 10px;
    }

    .mic-state {
      font-size: 8px;
      letter-spacing: 0.14em;
      padding: 3px 8px;
      border-radius: 999px;
      border: 1px solid var(--g-border, rgba(255,255,255,0.12));
      color: var(--g-fg-dim, rgba(245,245,244,0.6));
    }
    .state-live { color: var(--g-primary, #fbbf24); border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 35%, transparent); }
    .state-listening { color: var(--g-accent, #34d399); border-color: color-mix(in srgb, var(--g-accent, #34d399) 35%, transparent); }
    .state-muted, .state-offline { color: var(--g-fg-dim, rgba(245,245,244,0.45)); }

    @media (prefers-reduced-motion: reduce) {
      .dock, .dbtn.chev svg { transition: none !important; animation: none !important; }
    }

    @media (max-width: 720px) {
      .row.secondary { max-width: 92vw; }
    }
  `;
}

// ── Inline icons (stroke = currentColor) ─────────────────────────────────────
function micIcon() {
  return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line>
  </svg>`;
}
function micOffIcon() {
  return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="1" y1="1" x2="23" y2="23"></line>
    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path>
    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>
    <line x1="12" y1="19" x2="12" y2="23"></line>
  </svg>`;
}
function speakerIcon() {
  return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
  </svg>`;
}
function stopIcon() {
  return html`<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>`;
}
function spinnerIcon() {
  return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation: spin 1s linear infinite;"><circle cx="12" cy="12" r="10" stroke-dasharray="30 60"></circle></svg>`;
}
function characterIcon() {
  return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="8" r="4"></circle><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"></path>
  </svg>`;
}
function blobIcon() {
  return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="9"></circle><path d="M12 3a9 9 0 0 0 0 18M3 12h18"></path>
  </svg>`;
}
function hudIcon() {
  return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M3 9h18M9 21V9"></path>
  </svg>`;
}
function exitIcon() {
  return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line>
  </svg>`;
}
function chevronIcon() {
  return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>`;
}
function gearIcon() {
  return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="3"></circle>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
  </svg>`;
}
function pauseIcon() {
  return html`<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"></rect><rect x="14" y="5" width="4" height="14" rx="1"></rect></svg>`;
}
function playIcon() {
  return html`<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>`;
}

declare global {
  interface HTMLElementTagNameMap {
    'voice-controls-dock': VoiceControlsDock;
  }
}
