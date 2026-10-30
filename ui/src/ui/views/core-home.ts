/**
 * Core OS home — what /dashboard shows when no business pack is on.
 *
 * Business HQ belongs to the Business & Agency plugin. With that plugin off
 * (the default on a fresh install) the home page is this generic overview:
 * jump-off cards into the core surfaces and a way back into the getting-started
 * checklist. It deliberately calls no RPC and shows no business content.
 */

import { html, type TemplateResult } from "lit";

import { reopenFirstRun } from "../controllers/first-run";
import type { GatewayBrowserClient } from "../gateway";
import { icon, type IconName } from "../icons";
import { pathForTab, titleForTab, type Tab } from "../navigation";
import { renderDashboardCommandCenter } from "./dashboard";
import { renderKanbanSection } from "./kanban-section";
import { ensureHomeGlassStyles } from "./home-glass";

export interface CoreHomeHost {
  setTab: (tab: Tab) => void;
  requestUpdate?: () => void;
  basePath?: string;
  assistantName?: string;
  client?: GatewayBrowserClient | null;
}

type Tile = { tab: Tab; icon: IconName; blurb: string };

const TILES: Tile[] = [
  { tab: "webchat", icon: "messageSquare", blurb: "Talk to your agents and hand them work." },
  { tab: "voice", icon: "mic", blurb: "Hands-free: speak, listen, interrupt." },
  { tab: "projects", icon: "kanban", blurb: "Projects and tasks your agents pick up." },
  { tab: "notes", icon: "fileText", blurb: "Documents, notes and imports." },
  { tab: "schedule", icon: "calendar", blurb: "Schedules, reminders and recurring jobs." },
  { tab: "inbox", icon: "mail", blurb: "Email in one place, triaged by your agents." },
  { tab: "research", icon: "book", blurb: "Topics, watchlists and saved articles." },
  { tab: "agents", icon: "bot", blurb: "Your agent roster, tools and skills." },
];

function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function renderCoreHome(host: CoreHomeHost): TemplateResult {
  ensureHomeGlassStyles();
  const go = (tab: Tab) => (e: Event) => {
    e.preventDefault();
    host.setTab(tab);
  };
  return html`
    ${styles}
    <div class="core-home" data-testid="core-home">
      ${host.client
        ? html`<div class="core-home__command">
            ${renderDashboardCommandCenter(host as never, host.client)}
          </div>`
        : ""}
      <header class="core-home__head">
        <div class="core-home__eyebrow">HOME</div>
        <h1 class="core-home__title">${greeting()}.</h1>
        <p class="core-home__sub">
          Everything your AI OS can do from here. Add more — apps, channels and integrations —
          in <a href=${pathForTab("plugins" as Tab, host.basePath ?? "")} @click=${go("plugins" as Tab)}>Setup › Plugins</a>.
        </p>
      </header>
      <div class="core-home__grid">
        ${TILES.map(
          (t) => html`<a
            class="core-home__tile"
            data-tab=${t.tab}
            href=${pathForTab(t.tab, host.basePath ?? "")}
            @click=${go(t.tab)}
          >
            <span class="core-home__ic">${icon(t.icon)}</span>
            <span class="core-home__name">${titleForTab(t.tab)}</span>
            <span class="core-home__blurb">${t.blurb}</span>
          </a>`,
        )}
      </div>
      ${host.client
        ? html`<div class="core-home__board">
            ${renderKanbanSection(host as never, { variant: "dashboard" })}
          </div>`
        : ""}
      <p class="core-home__foot">
        <button
          class="core-home__link"
          @click=${() => {
            reopenFirstRun();
            host.requestUpdate?.();
          }}
        >
          Open the getting-started checklist
        </button>
      </p>
    </div>
  `;
}

const styles = html`<style>
  .core-home {
    --ch-primary: var(--g-primary, #fbbf24);
    --ch-text: var(--text, #e4e4e7);
    --ch-mute: color-mix(in srgb, var(--ch-text) 62%, transparent);
    --ch-border: color-mix(in srgb, var(--ch-primary) 18%, color-mix(in srgb, var(--ch-text) 10%, transparent));
    --ch-tile: color-mix(in srgb, var(--ch-text) 4%, transparent);
    max-width: 1040px; margin: 0 auto; padding: 32px 24px 48px; box-sizing: border-box; color: var(--ch-text);
  }
  .core-home__eyebrow { font-size: 11px; letter-spacing: .14em; color: var(--ch-primary); font-weight: 600; }
  .core-home__command { margin-bottom: 16px; }
  .core-home__title { margin: 6px 0 8px; font-size: clamp(24px, 3.4vw, 34px); font-weight: 750; letter-spacing: -.01em; }
  .core-home__sub { margin: 0; max-width: 620px; color: var(--ch-mute); font-size: 14px; line-height: 1.55; }
  .core-home__sub a { color: var(--ch-primary); text-decoration: none; }
  .core-home__board { margin-top: 24px; min-width: 0; }
  .core-home__grid { margin-top: 24px; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .core-home__tile { display: grid; grid-template-columns: 34px 1fr; grid-template-rows: auto auto; column-gap: 12px; row-gap: 3px;
    align-items: center; padding: 16px; border-radius: 14px; border: 1px solid var(--ch-border); background: var(--ch-tile);
    color: inherit; text-decoration: none; transition: border-color .15s ease, background .15s ease; min-width: 0; }
  .core-home__tile:hover, .core-home__tile:focus-visible { border-color: color-mix(in srgb, var(--ch-primary) 45%, transparent);
    background: color-mix(in srgb, var(--ch-primary) 8%, transparent); outline: none; }
  .core-home__ic { grid-row: span 2; width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center;
    color: var(--ch-primary); background: color-mix(in srgb, var(--ch-primary) 12%, transparent); }
  .core-home__ic svg { width: 17px; height: 17px; }
  .core-home__name { font-size: 15px; font-weight: 650; }
  .core-home__blurb { font-size: 12.5px; color: var(--ch-mute); line-height: 1.4; }
  .core-home__foot { margin: 22px 0 0; }
  .core-home__link { all: unset; cursor: pointer; font-size: 13px; color: var(--ch-mute); padding: 8px 12px; border-radius: 8px;
    border: 1px solid var(--ch-border); }
  .core-home__link:hover { color: var(--ch-text); }
  @media (max-width: 640px) {
    .core-home { padding: 20px 14px 36px; }
    .core-home__grid { grid-template-columns: 1fr; }
  }
</style>`;
