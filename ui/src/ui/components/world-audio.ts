/**
 * <world-audio> — sound design layer for the Agency World map.
 *
 * Self-contained: owns a {@link WorldSounds} synth engine (vanilla WebAudio, no
 * assets, no deps) and a small bottom-right control puck that expands into a
 * volume + per-category panel. It never touches the viz.
 *
 * ── DATA CONTRACT ─────────────────────────────────────────────────────────
 * It plays sounds in response to agency-world events, mirroring the
 * <agent-fx-layer> / <agent-emotes-layer> contract. Feed it either way:
 *   1. dispatch a window event the layer already listens for:
 *        window.dispatchEvent(new CustomEvent("infinibot:world-event",
 *          { detail: { kind: "agent.complete", success: true } }));
 *   2. call the global shim it installs:  window.__worldAudio?.trigger("agent.spawn")
 *   3. drive it directly:                 el.trigger("agent.complete", true)
 *
 * `kind` values match agency-data-bridge's WorldEvent union; unknown kinds are
 * ignored. Autoplay policy is respected: muted until the first user gesture on
 * the puck unlocks the AudioContext.
 *
 * ── MOUNT ONE-LINER ────────────────────────────────────────────────────────
 *   import "./components/world-audio.js";
 *   host.appendChild(document.createElement("world-audio")); // inside .host
 * and forward events in <agency-world-viz>.applyBatch():
 *   window.dispatchEvent(new CustomEvent("infinibot:world-event",{detail:e}));
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  WORLD_SOUND_CATEGORIES,
  WORLD_SOUND_LABELS,
  getWorldSounds,
  type WorldSoundCategory,
  type WorldSoundsSettings,
} from "../../../../src/audio/world-sounds.js";

type WorldEventKind = string;

declare global {
  interface Window {
    __worldAudio?: {
      trigger: (kind: WorldEventKind, success?: boolean) => void;
      play: (cat: Exclude<WorldSoundCategory, "ambient">) => void;
    };
  }
}

/** agency-world WorldEvent.kind → sound category. */
function kindToCategory(
  kind: WorldEventKind,
  success?: boolean,
): Exclude<WorldSoundCategory, "ambient"> | null {
  switch (kind) {
    case "agent.complete":
      return success === false ? "error" : "complete";
    case "agent.spawn":
      return "spawn";
    case "fed.msg.send":
    case "fed.msg.ack":
    case "fed.peer.connect":
    case "ssh.connection.opened":
      return "beam";
    case "fed.msg.fail":
    case "fed.peer.disconnect":
    case "ssh.connection.error":
    case "ssh.error":
      return "error";
    case "achievement":
    case "agent.achievement":
      return "achievement";
    default:
      return null;
  }
}

@customElement("world-audio")
export class WorldAudio extends LitElement {
  static styles = css`
    :host {
      position: absolute;
      right: var(--world-audio-right, 16px);
      bottom: var(--world-audio-bottom, 16px);
      z-index: 6;
      font-family: var(--mono, ui-monospace, monospace);
      color: var(--world-text, #e4e4e7);
      pointer-events: none;
    }
    .puck,
    .panel {
      pointer-events: auto;
    }
    .puck {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      cursor: pointer;
      background: color-mix(in srgb, var(--world-surface, #0f0f0f) 88%, transparent);
      border: 1px solid var(--world-border, rgba(255, 255, 255, 0.14));
      color: var(--world-accent, #f5c451);
      backdrop-filter: blur(8px);
      transition: transform 0.12s ease, box-shadow 0.12s ease, border-color 0.12s ease;
    }
    .puck:hover {
      transform: translateY(-1px);
      border-color: var(--world-accent, #f5c451);
      box-shadow: 0 0 0 1px var(--world-accent, #f5c451),
        0 6px 22px color-mix(in srgb, var(--world-accent, #f5c451) 30%, transparent);
    }
    .puck.live {
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--world-accent, #f5c451) 60%, transparent);
    }
    .puck svg {
      width: 18px;
      height: 18px;
    }
    .panel {
      position: absolute;
      right: 0;
      bottom: 48px;
      width: 232px;
      padding: 14px;
      border-radius: 12px;
      background: color-mix(in srgb, var(--world-surface, #0f0f0f) 94%, transparent);
      border: 1px solid var(--world-border, rgba(255, 255, 255, 0.14));
      backdrop-filter: blur(14px);
      box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55);
      display: grid;
      gap: 12px;
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      font-size: 11.5px;
    }
    .title {
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--world-muted, #a1a1aa);
    }
    .master {
      display: grid;
      gap: 8px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--world-border, rgba(255, 255, 255, 0.1));
    }
    input[type="range"] {
      width: 100%;
      accent-color: var(--world-accent, #f5c451);
    }
    .cats {
      display: grid;
      gap: 7px;
    }
    .cat {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      cursor: pointer;
      color: var(--world-text, #e4e4e7);
    }
    .cat span {
      opacity: 0.92;
    }
    .sw {
      position: relative;
      width: 30px;
      height: 17px;
      border-radius: 999px;
      background: var(--world-idle, #3a3a3a);
      transition: background 0.14s ease;
      flex: none;
    }
    .sw.on {
      background: var(--world-accent, #f5c451);
    }
    .sw::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 13px;
      height: 13px;
      border-radius: 50%;
      background: #0a0a0a;
      transition: transform 0.14s ease;
    }
    .sw.on::after {
      transform: translateX(13px);
    }
    .mute-btn {
      font: inherit;
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 5px 10px;
      border-radius: 7px;
      cursor: pointer;
      background: var(--world-accent, #f5c451);
      color: #0a0a0a;
      border: none;
    }
    .mute-btn.muted {
      background: transparent;
      color: var(--world-muted, #a1a1aa);
      border: 1px solid var(--world-border, rgba(255, 255, 255, 0.18));
    }
  `;

  private sounds = getWorldSounds();
  private unsub?: () => void;

  @state() private open = false;
  @state() private settings: WorldSoundsSettings = this.sounds.getSettings();
  @state() private live = false;
  private liveTimer = 0;

  private onWorldEvent = (ev: Event) => {
    const detail = (ev as CustomEvent).detail as { kind?: string; success?: boolean } | undefined;
    if (detail?.kind) this.trigger(detail.kind, detail.success);
  };

  connectedCallback(): void {
    super.connectedCallback();
    this.unsub = this.sounds.onChange((s) => {
      this.settings = s;
    });
    window.addEventListener("infinibot:world-event", this.onWorldEvent as EventListener);
    window.__worldAudio = {
      trigger: (k, s) => this.trigger(k, s),
      play: (c) => this.sounds.play(c),
    };
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsub?.();
    window.removeEventListener("infinibot:world-event", this.onWorldEvent as EventListener);
    if (window.__worldAudio?.trigger) delete window.__worldAudio;
    clearTimeout(this.liveTimer);
  }

  /** Public: map a WorldEvent kind to a sound and play it. */
  trigger(kind: WorldEventKind, success?: boolean): void {
    const cat = kindToCategory(kind, success);
    if (!cat) return;
    this.sounds.play(cat);
    if (!this.sounds.isMuted()) this.flashLive();
  }

  private flashLive(): void {
    this.live = true;
    clearTimeout(this.liveTimer);
    this.liveTimer = window.setTimeout(() => {
      this.live = false;
    }, 240);
  }

  private async togglePanel(): Promise<void> {
    await this.sounds.unlock(); // first gesture unlocks the AudioContext
    this.open = !this.open;
  }

  private toggleMute(): void {
    this.sounds.setMuted(!this.settings.muted);
  }

  private setVolume(e: Event): void {
    this.sounds.setMasterVolume(Number((e.target as HTMLInputElement).value) / 100);
  }

  private toggleCat(cat: WorldSoundCategory): void {
    this.sounds.setCategoryEnabled(cat, !this.settings.enabled[cat]);
  }

  private icon() {
    if (this.settings.muted) {
      return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round">
        <path d="M11 5 6 9H2v6h4l5 4z" /><line x1="23" y1="9" x2="17" y2="15" />
        <line x1="17" y1="9" x2="23" y2="15" />
      </svg>`;
    }
    return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 5 6 9H2v6h4l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M19 5a9 9 0 0 1 0 14" />
    </svg>`;
  }

  render() {
    const s = this.settings;
    return html`
      <button
        class="puck ${this.live ? "live" : ""}"
        title="World audio"
        aria-label="World audio settings"
        @click=${() => this.togglePanel()}
      >
        ${this.icon()}
      </button>
      ${this.open
        ? html`
            <div class="panel" role="dialog" aria-label="World audio">
              <div class="master">
                <div class="row">
                  <span class="title">World Audio</span>
                  <button
                    class="mute-btn ${s.muted ? "muted" : ""}"
                    @click=${() => this.toggleMute()}
                  >
                    ${s.muted ? "Muted" : "On"}
                  </button>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  .value=${String(Math.round(s.masterVolume * 100))}
                  ?disabled=${s.muted}
                  @input=${(e: Event) => this.setVolume(e)}
                />
              </div>
              <div class="cats">
                ${WORLD_SOUND_CATEGORIES.map(
                  (cat) => html`
                    <div class="cat" @click=${() => this.toggleCat(cat)}>
                      <span>${WORLD_SOUND_LABELS[cat]}</span>
                      <div class="sw ${s.enabled[cat] ? "on" : ""}"></div>
                    </div>
                  `,
                )}
              </div>
            </div>
          `
        : nothing}
    `;
  }
}
