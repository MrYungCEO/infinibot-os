/**
 * Achievements UI — earned-badge popups + the <achievements-modal> element.
 *
 * The data layer lives in `src/achievements/` (sqlite); this module only
 * renders. The host pushes earned records (popup) and the full earned list
 * (modal). A self-contained catalogue mirrors the server defs so the modal can
 * show locked badges too without importing server code into the browser bundle.
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { UiAchievement } from "./types.js";

export const TIER_COLORS = {
  bronze: "#cd7f32",
  silver: "#c0c6d4",
  gold: "#d4af37",
  legendary: "#b06bff",
} as const;

/** Static catalogue mirroring src/achievements/kinds.ts (label/icon/tier). */
export const UI_ACHIEVEMENT_CATALOGUE: Array<Omit<UiAchievement, "id" | "earnedAt">> = [
  { kind: "clean_shipment", label: "Clean Shipment", description: "Shipped a task with zero failed sub-agent runs.", icon: "📦", tier: "bronze" },
  { kind: "ten_shipments", label: "Ten Down", description: "Completed 10 shipments.", icon: "🔟", tier: "silver" },
  { kind: "ship_streak_7day", label: "Seven-Day Streak", description: "Shipped clean work seven days in a row.", icon: "🔥", tier: "gold" },
  { kind: "federation_milestone", label: "Federation Online", description: "Grew the federation mesh to a new node milestone.", icon: "🛰️", tier: "gold" },
  { kind: "focus_session_2h", label: "In The Zone", description: "Held a focus session for two unbroken hours.", icon: "🎯", tier: "silver" },
  { kind: "marathon_focus_4h", label: "Marathon Mind", description: "Sustained a four-hour focus session.", icon: "🏃", tier: "gold" },
  { kind: "hourly_insight_acted", label: "Coachable", description: "Acted on a proactive hourly insight.", icon: "💡", tier: "bronze" },
  { kind: "zero_failed_day", label: "Flawless Day", description: "Closed a full day with zero failed runs.", icon: "✨", tier: "gold" },
  { kind: "first_drag_assign", label: "Hands On", description: "Assigned a task by drag-and-drop for the first time.", icon: "🖐️", tier: "bronze" },
  { kind: "director_mode_first", label: "Take The Chair", description: "Entered Director Mode for the first time.", icon: "🎬", tier: "silver" },
  { kind: "first_voice_command", label: "Speak & Ship", description: "Issued your first voice command to the fleet.", icon: "🎙️", tier: "bronze" },
  { kind: "night_owl", label: "Night Owl", description: "Shipped clean work between midnight and 5am.", icon: "🦉", tier: "legendary" },
];

/**
 * Build a transient badge-popup DOM node (top-right toast). The host appends
 * it; it animates in, lingers, then removes itself.
 */
export function createBadgePopup(ach: UiAchievement, onClick: () => void): HTMLElement {
  const tier = TIER_COLORS[ach.tier] ?? TIER_COLORS.gold;
  const el = document.createElement("div");
  el.className = "wo-badge-pop";
  el.style.cssText = [
    "pointer-events:auto",
    "display:flex",
    "align-items:center",
    "gap:10px",
    "padding:10px 14px 10px 10px",
    "border-radius:12px",
    "background:linear-gradient(135deg, rgba(16,18,28,.96), rgba(24,20,12,.96))",
    `border:1px solid ${tier}`,
    `box-shadow:0 8px 30px rgba(0,0,0,.5), 0 0 24px ${hexA(tier, 0.45)}`,
    "color:#fff",
    "font:13px/1.3 ui-sans-serif, system-ui, sans-serif",
    "cursor:pointer",
    "transform:translateX(120%)",
    "transition:transform .45s cubic-bezier(.2,.8,.2,1), opacity .4s",
    "max-width:300px",
  ].join(";");
  el.innerHTML = `
    <div style="width:40px;height:40px;border-radius:10px;display:grid;place-items:center;
      font-size:22px;background:${hexA(tier, 0.16)};border:1px solid ${hexA(tier, 0.5)};flex:0 0 auto">
      ${ach.icon}
    </div>
    <div style="min-width:0">
      <div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:${tier};font-weight:700">
        Achievement Unlocked
      </div>
      <div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ach.label}</div>
      <div style="opacity:.7;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ach.description}</div>
    </div>`;
  el.addEventListener("click", onClick);
  // animate in next frame
  requestAnimationFrame(() => {
    el.style.transform = "translateX(0)";
  });
  // auto-dismiss
  setTimeout(() => {
    el.style.transform = "translateX(120%)";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 500);
  }, 5200);
  return el;
}

function hexA(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

@customElement("achievements-modal")
export class AchievementsModal extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: none;
      align-items: center;
      justify-content: center;
      pointer-events: auto;
    }
    :host([open]) {
      display: flex;
    }
    .scrim {
      position: absolute;
      inset: 0;
      background: rgba(4, 6, 12, 0.72);
      backdrop-filter: blur(6px);
    }
    .panel {
      position: relative;
      width: min(720px, 92vw);
      max-height: 82vh;
      overflow: auto;
      border-radius: 18px;
      background: linear-gradient(160deg, rgba(18, 20, 30, 0.98), rgba(12, 13, 20, 0.98));
      border: 1px solid rgba(212, 175, 55, 0.35);
      box-shadow: 0 30px 90px rgba(0, 0, 0, 0.6);
      padding: 22px 24px 26px;
      color: #f4f5fa;
      font: 14px/1.4 ui-sans-serif, system-ui, sans-serif;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    h2 {
      margin: 0;
      font-size: 18px;
      letter-spacing: 0.02em;
    }
    .sub {
      opacity: 0.6;
      font-size: 12px;
      margin-bottom: 16px;
    }
    .close {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #fff;
      width: 30px;
      height: 30px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 16px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 12px;
    }
    .card {
      display: flex;
      gap: 10px;
      padding: 12px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .card.locked {
      opacity: 0.42;
      filter: grayscale(0.8);
    }
    .ic {
      width: 42px;
      height: 42px;
      flex: 0 0 auto;
      border-radius: 10px;
      display: grid;
      place-items: center;
      font-size: 22px;
    }
    .ttl {
      font-weight: 700;
      font-size: 13px;
    }
    .desc {
      opacity: 0.65;
      font-size: 11px;
      margin-top: 2px;
    }
    .when {
      font-size: 10px;
      opacity: 0.5;
      margin-top: 4px;
    }
  `;

  @state() private earned: UiAchievement[] = [];

  setAchievements(list: UiAchievement[]): void {
    this.earned = [...list];
  }

  open(): void {
    this.setAttribute("open", "");
  }
  close(): void {
    this.removeAttribute("open");
  }

  render() {
    const earnedByKind = new Map(this.earned.map((a) => [a.kind, a]));
    const count = this.earned.length;
    const total = UI_ACHIEVEMENT_CATALOGUE.length;
    return html`
      <div class="scrim" @click=${() => this.close()}></div>
      <div class="panel">
        <header>
          <h2>🏆 Achievements</h2>
          <button class="close" @click=${() => this.close()}>✕</button>
        </header>
        <div class="sub">${count} of ${total} unlocked</div>
        <div class="grid">
          ${UI_ACHIEVEMENT_CATALOGUE.map((def) => {
            const got = earnedByKind.get(def.kind);
            const color = TIER_COLORS[def.tier];
            return html`
              <div class="card ${got ? "" : "locked"}">
                <div
                  class="ic"
                  style="background:${hexA(color, 0.16)};border:1px solid ${hexA(color, 0.5)}"
                >
                  ${got ? def.icon : "🔒"}
                </div>
                <div>
                  <div class="ttl" style="color:${got ? color : "#cbd0dd"}">${def.label}</div>
                  <div class="desc">${def.description}</div>
                  ${got
                    ? html`<div class="when">Earned ${formatWhen(got.earnedAt)}</div>`
                    : nothing}
                </div>
              </div>
            `;
          })}
        </div>
      </div>
    `;
  }
}

function formatWhen(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "achievements-modal": AchievementsModal;
  }
}
