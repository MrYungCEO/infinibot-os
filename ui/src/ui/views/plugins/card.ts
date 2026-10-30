/**
 * Plugins page — the one store card, icon tile and detail hero used by both
 * tabs: Installed (index.ts, a PluginSummary) and Marketplace (packages.ts, a
 * registry entry). Each caller maps its own data onto a CardSpec / HeroSpec,
 * so the markup and the CSS (market-styles.ts `.pm-card`, `.pm-cover`,
 * `.pm-dhero`…) live in one place and the two tabs can't drift apart.
 *
 * No DOM access here: plain Lit templates, safe to import in node tests.
 */

import { html, nothing, type TemplateResult } from "lit";

type Slot = TemplateResult | typeof nothing | string;

export type CardIcon = {
  /** Listing icon URL (undefined: none, still loading, or broken → monogram). */
  src?: string;
  monogram: string;
  onError?: () => void;
  /** Installed plugins tint the monogram tile with their own accent. */
  scopeId?: string;
  scopeStyle?: string;
};

export type IconSize = "sm" | "md" | "lg" | "xl";

export function renderCardIcon(icon: CardIcon, size: IconSize = "md"): TemplateResult {
  if (icon.src) {
    return html`<span class="pm-icon ${size} has-img" aria-hidden="true"><img src=${icon.src} alt="" @error=${() => icon.onError?.()} /></span>`;
  }
  return html`<span class="pm-icon ${size}" aria-hidden="true" data-plugin-scope=${icon.scopeId ?? nothing} style=${icon.scopeStyle ?? nothing}>${icon.monogram}</span>`;
}

export type CardSpec = {
  id: string;
  /** "plugin" → data-plugin-card (Installed tab), "market" → data-market-card (Marketplace tab). */
  kind: "plugin" | "market";
  name: string;
  /** Cover URL: the listing cover, or generatedCover() when there is none / it broke. */
  cover: string;
  onCoverError?: () => void;
  icon: CardIcon;
  /** Opens the detail page (the whole card is the hit area; footer actions sit above it). */
  onOpen: () => void;
  publisher: string;
  verified?: boolean;
  version?: string | null;
  tagline: string;
  /** Overlays on the cover: trust tier (top-left), update chip / price (bottom-right). */
  coverBadges?: Slot;
  /** Chips row (Included in CEO plan, category, tags…). */
  tags?: Slot;
  /** Short notes between the chips and the footer (errors, a download link). */
  extra?: Slot;
  /** Footer left: status (installed) or a link / installed state (marketplace). */
  footStart?: Slot;
  footActions?: Slot;
  className?: string;
  /** The card an install deep link pointed at: outlined. */
  focused?: boolean;
};

const CHECK = html`<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10" /></svg>`;

export function renderVerified(): TemplateResult {
  return html`<span class="pk-verified" title="Verified publisher">${CHECK}<span class="pp-sr">Verified publisher</span></span>`;
}

export function renderPluginCard(c: CardSpec): TemplateResult {
  return html`<article
    class="pm-card ${c.className ?? ""} ${c.focused ? "pk-focus" : ""}"
    data-plugin-card=${c.kind === "plugin" ? c.id : nothing}
    data-plugin-row=${c.kind === "plugin" ? c.id : nothing}
    data-market-card=${c.kind === "market" ? c.id : nothing}
    ?data-market-focus=${c.kind === "market" && Boolean(c.focused)}
  >
    <div class="pm-cover">
      <img src=${c.cover} alt="" loading="lazy" decoding="async" @error=${() => c.onCoverError?.()} />
      ${c.coverBadges ?? nothing}
    </div>
    <div class="pm-card-body">
      <div class="pm-card-head">
        ${renderCardIcon(c.icon, "md")}
        <div class="pm-card-title">
          <h3 class="pm-name"><button
            class="pm-stretch"
            data-open-detail=${c.kind === "plugin" ? c.id : nothing}
            data-market-detail=${c.kind === "market" ? c.id : nothing}
            @click=${() => c.onOpen()}
            aria-label=${`${c.name} — details`}
          >${c.name}</button></h3>
          <div class="pm-byline">${c.publisher}${c.verified ? renderVerified() : nothing}${c.version ? html`<span aria-hidden="true"> · </span>v${c.version}` : nothing}</div>
        </div>
      </div>
      <p class="pm-desc">${c.tagline || html`<span class="pp-muted">No description.</span>`}</p>
      ${c.tags ? html`<div class="pm-tags">${c.tags}</div>` : nothing}
      ${c.extra ?? nothing}
      <div class="pm-card-foot">
        ${c.footStart ?? html`<span></span>`}
        <span class="pm-foot-actions">${c.footActions ?? nothing}</span>
      </div>
    </div>
  </article>`;
}

/** Loading placeholders shaped like the cards (both tabs). */
export function renderCardSkeletons(count = 6, label = "Loading plugins"): TemplateResult {
  return html`<div class="pm-grid" aria-busy="true" aria-label=${label} data-card-skeletons>
    ${Array.from({ length: count }, () => html`<div class="pm-card pm-skel" aria-hidden="true"><div class="pm-cover"></div><div class="pm-card-body"><div class="sk w60"></div><div class="sk w90"></div><div class="sk w40"></div></div></div>`)}
  </div>`;
}

export type Screenshot = { src: string; caption?: string };

/** Horizontal screenshot strip; each shot opens the lightbox. */
export function renderGallery(opts: {
  name: string;
  shots: Screenshot[];
  src: (s: Screenshot) => string | undefined;
  onError: (s: Screenshot) => void;
  onOpen: (index: number, from: HTMLElement) => void;
}): TemplateResult | typeof nothing {
  const { shots } = opts;
  if (!shots.length) return nothing;
  return html`<div class="pm-gallery" role="list" aria-label="Screenshots" data-gallery>
    ${shots.map(
      (s, i) => html`<figure class="pm-shot" role="listitem">
        <button class="pm-shot-btn" aria-label=${`Open screenshot ${i + 1} of ${shots.length}${s.caption ? `: ${s.caption}` : ""}`} @click=${(e: Event) => opts.onOpen(i, e.currentTarget as HTMLElement)}>
          <img src=${opts.src(s) ?? ""} alt=${s.caption ?? `${opts.name} screenshot ${i + 1}`} loading="lazy" decoding="async" @error=${() => opts.src(s) && opts.onError(s)} />
        </button>
        ${s.caption ? html`<figcaption>${s.caption}</figcaption>` : nothing}
      </figure>`,
    )}
  </div>`;
}

export type HeroSpec = {
  name: string;
  cover: string;
  onCoverError?: () => void;
  icon: CardIcon;
  kicker: string;
  tagline: string;
  /** Tier, badges, publisher, version, status / price. */
  meta: Slot;
  actions?: Slot;
  backLabel: string;
  onBack: () => void;
};

const BACK = html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>`;

/** The detail page's cover hero (installed and marketplace detail). */
export function renderDetailHero(h: HeroSpec): TemplateResult {
  return html`<div class="pm-dhero">
    <div class="pm-dhero-cover" aria-hidden="true"><img src=${h.cover} alt="" @error=${() => h.onCoverError?.()} /></div>
    <div class="pm-dhero-shade" aria-hidden="true"></div>
    <button class="pm-back" data-back @click=${() => h.onBack()} aria-label=${`Back to ${h.backLabel.toLowerCase()}`}>${BACK}<span>${h.backLabel}</span></button>
    <div class="pm-dhero-body">
      ${renderCardIcon(h.icon, "xl")}
      <div class="pm-dhero-text" data-learn-id="plugin-detail-hero">
        <div class="pm-dhero-kicker">${h.kicker}</div>
        <h1 class="pm-dname">${h.name}</h1>
        ${h.tagline ? html`<p class="pm-dtagline">${h.tagline}</p>` : nothing}
        <div class="pm-dmeta">${h.meta}</div>
      </div>
      ${h.actions ? html`<div class="pm-dactions">${h.actions}</div>` : nothing}
    </div>
  </div>`;
}
