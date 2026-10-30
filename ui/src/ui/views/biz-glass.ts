/**
 * Funnels & Forms glass kit — the Business hub's look (layered frosted glass,
 * hairline gold edges, specular top light, a slow gold aurora, Apple type)
 * for the light-DOM funnel builder, forms/qualifier and lead pages.
 *
 * Everything is scoped under `.bzg`, so nothing leaks into other pages:
 *   - It re-points the legacy `--g-*` / `--text` / `--accent` variables these
 *     pages already read to the global `--glass-*` tokens (docs/ui/GLASS.md),
 *     so dark, light, palette, reduced-transparency and reduced-motion all
 *     follow automatically.
 *   - It ships the shared parts: hero header, segmented nav, glass panel,
 *     KPI tile, buttons, chips, skeletons, guiding empty states and the
 *     "lives in the Business hub" hand-off card.
 *
 * Lead, pipeline and landing-page data are owned by the Business hub
 * (docs/business/DATA_MODEL.md). `openHubSection()` is the one way these
 * pages send people there.
 */

import { html, nothing, type TemplateResult } from "lit";
import { icons as hubIcons } from "./business-hub/icons";

export const bizIcons = hubIcons;
export type BizIcon = keyof typeof hubIcons;

/** Business hub sections these pages hand off to (`/hub?view=…`). */
export type HubSection =
  | "overview"
  | "leads"
  | "pipeline"
  | "contacts"
  | "clients"
  | "campaigns"
  | "tracking"
  | "imports"
  | "revenue";

/** Open a Business hub section (updates the URL, so Back returns here). */
export function openHubSection(section: HubSection): void {
  const app = document.querySelector("infinibot-app") as unknown as {
    setTab?: (t: string) => void;
    setHostView?: (v: string) => void;
  } | null;
  if (app?.setTab && app.setHostView) {
    app.setTab("hub");
    app.setHostView(section);
    return;
  }
  location.assign(`/hub?view=${encodeURIComponent(section)}`);
}

const CSS = `
.bzg {
  /* legacy page variables → glass tokens (theme / palette / a11y aware) */
  --g-surface: color-mix(in srgb, var(--glass-fg) 4%, transparent);
  --g-surface-strong: color-mix(in srgb, var(--glass-gold) 12%, transparent);
  --g-surface-hover: var(--glass-hover);
  --g-border: var(--glass-stroke);
  --g-border-strong: var(--glass-stroke-gold);
  --g-glass-border: var(--glass-stroke);
  --g-fg: var(--glass-fg);
  --g-fg-dim: var(--glass-fg-2);
  --g-fg-faint: var(--glass-fg-3);
  --g-fg-mute: var(--glass-fg-4);
  --g-text: var(--glass-fg);
  --g-muted: var(--glass-fg-3);
  --g-radius: var(--glass-radius);
  --g-radius-sm: var(--glass-radius-sm);
  --g-radius-lg: var(--glass-radius-lg);
  --g-shadow-sm: var(--glass-elev-1);
  --g-shadow-lg: var(--glass-elev-3);
  --g-accent: var(--glass-gold-hi);
  --g-accent-soft: var(--glass-gold-a16);
  --g-accent-muted: var(--glass-gold-a40);
  --g-primary-strong: var(--glass-gold-deep);
  --g-primary-soft: var(--glass-gold-a16);
  --g-primary-muted: var(--glass-gold-a40);
  --g-glass-tint: var(--glass-gold-a06);
  --g-gradient-surface: linear-gradient(180deg, color-mix(in srgb, var(--glass-fg) 5%, transparent), color-mix(in srgb, var(--glass-fg) 2%, transparent));
  --g-font-family: var(--glass-font);
  --text: var(--glass-fg);
  --accent: var(--glass-gold);
  --info: var(--glass-gold-hi);
  --hw-info: var(--glass-gold-hi);
  --font-sans: var(--glass-font);
  position: relative;
  isolation: isolate;
  color: var(--glass-fg);
  font-family: var(--glass-font);
  -webkit-font-smoothing: antialiased;
  font-feature-settings: "cv11", "ss01";
}
.bzg *:focus-visible { outline: none; box-shadow: var(--glass-focus-ring); border-radius: var(--glass-radius-xs); }

/* ── aurora: two slow gold orbs behind the page ───────────── */
.bzg-aurora { position: absolute; inset: 0; overflow: hidden; z-index: -1; pointer-events: none; }
.bzg-aurora::before, .bzg-aurora::after {
  content: ""; position: absolute; width: 58vmax; height: 58vmax; border-radius: 50%; filter: blur(90px); opacity: .26;
  background: radial-gradient(circle, color-mix(in srgb, var(--glass-gold) 55%, transparent), transparent 62%);
  top: -34vmax; left: -14vmax; animation: bzg-drift 38s var(--glass-ease) infinite alternate;
}
.bzg-aurora::after {
  background: radial-gradient(circle, color-mix(in srgb, var(--glass-gold-deep) 45%, transparent), transparent 60%);
  top: auto; bottom: -42vmax; left: auto; right: -20vmax; animation-duration: 46s; opacity: .18;
}
:root[data-theme="light"] .bzg-aurora::before { opacity: .2; }
:root[data-theme="light"] .bzg-aurora::after { opacity: .12; }
@keyframes bzg-drift { from { transform: translate3d(0,0,0) scale(1); } to { transform: translate3d(8vmax,5vmax,0) scale(1.12); } }

/* ── glass surface: frosted, gold hairline edge, specular top light ── */
.bzg-glass {
  position: relative; border-radius: var(--glass-radius-lg);
  background: var(--glass-sheen), var(--glass-tint), var(--glass-2);
  backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
  box-shadow: var(--glass-elev-2);
}
.bzg-glass::before {
  content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1px; pointer-events: none; z-index: 0;
  background: var(--glass-edge);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
}
.bzg-glass > * { position: relative; z-index: 1; }
/* card on a panel: no blur of its own (one blur per stack) */
.bzg-card {
  position: relative; border-radius: var(--glass-radius);
  background: var(--glass-sheen), var(--glass-3);
  border: 1px solid var(--glass-stroke);
  box-shadow: var(--glass-elev-1);
  transition: transform var(--glass-dur) var(--glass-spring), box-shadow var(--glass-dur) var(--glass-ease), border-color var(--glass-dur) var(--glass-ease);
}
.bzg-card.is-interactive { cursor: pointer; }
.bzg-card.is-interactive:hover { transform: var(--glass-lift); border-color: var(--glass-stroke-gold); box-shadow: var(--glass-elev-3), var(--glass-glow-soft); }

/* ── hero header (Business hub pattern) ───────────────────── */
.bzg-hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin: 0 0 16px; }
.bzg-hero__text { min-width: 0; }
.bzg-eyebrow { font-size: 11px; letter-spacing: .18em; text-transform: uppercase; color: var(--glass-gold); font-weight: 600; display: inline-flex; align-items: center; gap: 8px; }
.bzg-eyebrow .bzg-live { width: 7px; height: 7px; border-radius: 50%; background: var(--glass-gold); box-shadow: 0 0 10px var(--glass-gold); }
.bzg-title { margin: 4px 0 0; font-family: var(--font-ui-display, var(--glass-font)); font-size: clamp(24px, 2.5vw, 32px); font-weight: 650; letter-spacing: -.025em; line-height: 1.1; color: var(--glass-fg); text-transform: none; }
.bzg-gold { background: linear-gradient(120deg, var(--glass-gold-hi), var(--glass-gold) 45%, var(--glass-gold-deep)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.bzg-sub { color: var(--glass-fg-2); margin: 6px 0 0; max-width: 720px; font-size: 14px; line-height: 1.45; }
.bzg-hero__actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

/* ── segmented nav ────────────────────────────────────────── */
.bzg-seg { display: flex; gap: 2px; padding: 5px; overflow-x: auto; scrollbar-width: none; border-radius: 16px; max-width: 100%; }
.bzg-seg::-webkit-scrollbar { display: none; }
.bzg-seg__btn {
  position: relative; flex: 0 0 auto; border: 0; background: transparent; padding: 8px 14px; border-radius: 11px; cursor: pointer;
  color: var(--glass-fg-2); font: inherit; font-weight: 560; font-size: 13px; letter-spacing: 0; text-transform: none;
  transition: color .2s, background .25s var(--glass-ease); display: inline-flex; align-items: center; gap: 7px; white-space: nowrap;
}
.bzg-seg__btn:hover { color: var(--glass-fg); background: var(--glass-gold-a06); }
.bzg-seg__btn[aria-selected="true"] {
  color: var(--glass-fg);
  background: linear-gradient(180deg, color-mix(in srgb, var(--glass-gold) 22%, transparent), color-mix(in srgb, var(--glass-gold) 10%, transparent));
  box-shadow: inset 0 0 0 1px var(--glass-stroke-gold), 0 6px 18px -8px var(--glass-gold-a40);
}
.bzg-seg__btn svg { width: 15px; height: 15px; opacity: .85; }
.bzg-seg__btn .bzg-ext { width: 12px; height: 12px; opacity: .55; margin-left: -2px; }
.bzg-seg__sep { width: 1px; align-self: stretch; margin: 6px 4px; background: var(--glass-stroke-strong); flex: 0 0 auto; }

/* ── buttons / chips / inputs ─────────────────────────────── */
.bzg-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 36px; padding: 0 14px; border-radius: 11px;
  border: 1px solid var(--glass-stroke-gold); background: color-mix(in srgb, var(--glass-3) 80%, transparent); color: var(--glass-fg);
  cursor: pointer; font: inherit; font-weight: 560; font-size: 13px; letter-spacing: 0; text-transform: none; white-space: nowrap;
  transition: transform .15s var(--glass-ease), background .2s, border-color .2s, box-shadow .2s;
}
.bzg-btn:hover:not(:disabled) { border-color: var(--glass-gold); background: var(--glass-hover); }
.bzg-btn:active:not(:disabled) { transform: translateY(1px) scale(.99); }
.bzg-btn:disabled { opacity: .5; cursor: not-allowed; }
.bzg-btn--primary { border-color: transparent; color: var(--glass-ink); background: var(--glass-gold-fill); box-shadow: inset 0 1px 0 rgba(255,255,255,.45), 0 10px 24px -10px var(--glass-gold-a40); }
.bzg-btn--primary:hover:not(:disabled) { filter: brightness(1.06); background: var(--glass-gold-fill); border-color: transparent; }
.bzg-btn--ghost { background: transparent; border-color: transparent; color: var(--glass-fg-2); }
.bzg-btn--ghost:hover:not(:disabled) { color: var(--glass-fg); background: var(--glass-gold-a06); border-color: transparent; }
.bzg-btn--sm { min-height: 30px; padding: 0 10px; font-size: 12px; border-radius: 9px; }
.bzg-btn svg { width: 15px; height: 15px; }
.bzg-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 560; border: 1px solid var(--glass-stroke); color: var(--glass-fg-2); background: var(--glass-gold-a06); white-space: nowrap; }
.bzg-chip--gold { color: var(--glass-gold); border-color: var(--glass-stroke-gold); }
.bzg-chip strong { color: var(--glass-fg); font-variant-numeric: tabular-nums; font-weight: 650; }

/* ── KPI tiles ────────────────────────────────────────────── */
.bzg-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 16px; }
.bzg-kpi { padding: 16px 18px 14px; min-height: 112px; display: flex; flex-direction: column; gap: 6px; overflow: hidden; transition: transform .35s var(--glass-ease), box-shadow .35s var(--glass-ease); text-align: left; border: 0; font: inherit; color: inherit; }
button.bzg-kpi { cursor: pointer; }
.bzg-kpi:hover { transform: translateY(-2px); box-shadow: var(--glass-elev-3), var(--glass-glow-soft); }
.bzg-kpi__label { font-size: 12px; color: var(--glass-fg-2); font-weight: 560; display: flex; align-items: center; gap: 6px; }
.bzg-kpi__value { font-size: clamp(22px, 2vw, 30px); font-weight: 660; letter-spacing: -.03em; font-variant-numeric: tabular-nums; line-height: 1.1; color: var(--glass-fg); }
.bzg-kpi__foot { margin-top: auto; font-size: 12px; color: var(--glass-fg-3); }

/* ── section heads, bars, lists ───────────────────────────── */
.bzg-panel { padding: 18px; }
.bzg-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.bzg-head h2 { margin: 0; font-size: 15px; font-weight: 620; letter-spacing: -.01em; color: var(--glass-fg); text-transform: none; }
.bzg-head .bzg-meta { color: var(--glass-fg-3); font-size: 12px; }
.bzg-grid { display: grid; gap: 16px; }
.bzg-cols { grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); }
.bzg-bars { display: grid; gap: 9px; }
.bzg-bar { display: grid; grid-template-columns: minmax(90px, 1.1fr) 2fr minmax(48px, auto); gap: 10px; align-items: center; font-size: 13px; }
.bzg-bar__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--glass-fg-2); }
.bzg-bar__track { height: 8px; border-radius: 5px; background: color-mix(in srgb, var(--glass-fg) 7%, transparent); overflow: hidden; }
.bzg-bar__fill { height: 100%; border-radius: 5px; background: linear-gradient(90deg, var(--glass-gold-deep), var(--glass-gold) 60%, var(--glass-gold-hi)); transform-origin: left; animation: bzg-grow .9s var(--glass-ease) both; }
.bzg-bar__value { text-align: right; font-variant-numeric: tabular-nums; color: var(--glass-fg-2); }
@keyframes bzg-grow { from { transform: scaleX(0); } }
.bzg-list { display: grid; gap: 6px; }
.bzg-li { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 12px; border: 1px solid transparent; background: transparent; color: inherit; font: inherit; text-align: left; width: 100%; }
button.bzg-li { cursor: pointer; transition: background .15s, border-color .15s; }
button.bzg-li:hover { background: var(--glass-gold-a06); border-color: var(--glass-stroke); }
.bzg-li__main { flex: 1; min-width: 0; }
.bzg-li__main b { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bzg-li__main span { display: block; color: var(--glass-fg-3); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bzg-num { font-variant-numeric: tabular-nums; }
.bzg-muted { color: var(--glass-fg-2); }
.bzg-faint { color: var(--glass-fg-3); }

/* ── hand-off to the Business hub ─────────────────────────── */
.bzg-handoff { display: flex; align-items: center; gap: 14px; padding: 16px 18px; width: 100%; text-align: left; font: inherit; color: inherit; cursor: pointer; }
.bzg-handoff__glyph { width: 42px; height: 42px; border-radius: 13px; flex: 0 0 auto; display: grid; place-items: center; color: var(--glass-gold);
  background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--glass-gold) 30%, transparent), transparent 70%), var(--glass-gold-a06); box-shadow: inset 0 0 0 1px var(--glass-stroke-gold); }
.bzg-handoff__glyph svg { width: 20px; height: 20px; }
.bzg-handoff__text { flex: 1; min-width: 0; }
.bzg-handoff__text b { display: block; font-weight: 620; color: var(--glass-fg); }
.bzg-handoff__text span { display: block; color: var(--glass-fg-2); font-size: 13px; margin-top: 2px; }
.bzg-handoff__go { color: var(--glass-gold); display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; white-space: nowrap; }
.bzg-handoff__go svg { width: 16px; height: 16px; transition: transform .25s var(--glass-spring); }
.bzg-handoff:hover .bzg-handoff__go svg { transform: translateX(3px); }
.bzg-handoffs { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }

/* ── skeleton + empty state ───────────────────────────────── */
.bzg-sk { border-radius: 10px; background: linear-gradient(90deg, color-mix(in srgb, var(--glass-fg) 5%, transparent) 0%, color-mix(in srgb, var(--glass-fg) 11%, transparent) 50%, color-mix(in srgb, var(--glass-fg) 5%, transparent) 100%); background-size: 220% 100%; animation: bzg-shimmer 1.4s linear infinite; }
@keyframes bzg-shimmer { to { background-position: -220% 0; } }
.bzg-empty { text-align: center; padding: 40px 20px; display: grid; justify-items: center; gap: 10px; }
.bzg-empty__glyph { width: 60px; height: 60px; border-radius: 20px; display: grid; place-items: center; color: var(--glass-gold);
  background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--glass-gold) 30%, transparent), transparent 70%), var(--glass-gold-a06); box-shadow: inset 0 0 0 1px var(--glass-stroke-gold); }
.bzg-empty__glyph svg { width: 26px; height: 26px; }
.bzg-empty h2 { margin: 0; font-size: 18px; font-weight: 640; letter-spacing: -.015em; color: var(--glass-fg); text-transform: none; }
.bzg-empty p { margin: 0; color: var(--glass-fg-2); max-width: 460px; font-size: 14px; }
.bzg-empty__actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin-top: 6px; }
.bzg-banner { display: flex; gap: 12px; align-items: center; padding: 12px 16px; margin-bottom: 14px; flex-wrap: wrap; border-radius: var(--glass-radius); }

@media (max-width: 1100px) { .bzg-cols { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 720px) {
  .bzg-hero { align-items: flex-start; }
  .bzg-hero__actions { width: 100%; }
  .bzg-hero__actions .bzg-btn { flex: 1; }
  .bzg-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .bzg-kpi { min-height: 98px; padding: 13px 14px 12px; }
  .bzg-handoff { padding: 14px; }
  .bzg-handoff__go span { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .bzg *, .bzg *::before, .bzg *::after, .bzg-aurora::before, .bzg-aurora::after { animation: none !important; transition: none !important; }
}
@media (prefers-reduced-transparency: reduce) {
  .bzg-glass { backdrop-filter: none; -webkit-backdrop-filter: none; background: var(--glass-solid); }
  .bzg-aurora { display: none; }
}
:root.perf-mode .bzg-aurora, :root.low-power .bzg-aurora, .low-power .bzg-aurora { display: none; }
`;

/** The kit's stylesheet. Render once per page root (light DOM). */
export function bizGlassStyles(): TemplateResult {
  return html`<style>${CSS}</style>`;
}

/** Raw CSS, for shadow-DOM components that adopt the kit. */
export const BIZ_GLASS_CSS = CSS;

export function bizAurora(): TemplateResult {
  return html`<div class="bzg-aurora" aria-hidden="true"></div>`;
}

export function bizHero(o: {
  eyebrow: string;
  title: string | TemplateResult;
  sub?: string | TemplateResult;
  actions?: TemplateResult;
  live?: boolean;
}): TemplateResult {
  return html`<header class="bzg-hero">
    <div class="bzg-hero__text">
      <div class="bzg-eyebrow">${o.live ? html`<i class="bzg-live" aria-hidden="true"></i>` : nothing}${o.eyebrow}</div>
      <h1 class="bzg-title">${o.title}</h1>
      ${o.sub ? html`<p class="bzg-sub">${o.sub}</p>` : nothing}
    </div>
    ${o.actions ? html`<div class="bzg-hero__actions">${o.actions}</div>` : nothing}
  </header>`;
}

export type BizSegItem<T extends string> = {
  id: T;
  label: string;
  icon?: BizIcon;
  /** Opens a Business hub section instead of switching locally. */
  hub?: HubSection;
  learnId?: string;
  title?: string;
};

export function bizSeg<T extends string>(
  items: ReadonlyArray<BizSegItem<T> | "sep">,
  active: T,
  onSelect: (id: T) => void,
  label: string,
): TemplateResult {
  return html`<div class="g-glass bzg-seg bzg-glass" role="tablist" aria-label=${label}>
    ${items.map((it) =>
      it === "sep"
        ? html`<span class="bzg-seg__sep" aria-hidden="true"></span>`
        : html`<button
            class="g-btn g-btn--ghost bzg-seg__btn"
            role="tab"
            data-learn-id=${it.learnId ?? nothing}
            title=${it.title ?? (it.hub ? `Opens Business hub › ${it.label}` : nothing)}
            aria-selected=${!it.hub && active === it.id ? "true" : "false"}
            @click=${() => (it.hub ? openHubSection(it.hub) : onSelect(it.id))}
          >
            ${it.icon ? hubIcons[it.icon]() : nothing}<span>${it.label}</span>${it.hub
              ? html`<svg class="bzg-ext" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>`
              : nothing}
          </button>`,
    )}
  </div>`;
}

/** A glass card that sends the user to a Business hub section. */
export function hubHandoff(o: { section: HubSection; icon: BizIcon; title: string; text: string; cta?: string }): TemplateResult {
  return html`<button class="g-glass bzg-glass bzg-handoff" @click=${() => openHubSection(o.section)}>
    <span class="bzg-handoff__glyph">${hubIcons[o.icon]()}</span>
    <span class="bzg-handoff__text"><b>${o.title}</b><span>${o.text}</span></span>
    <span class="bzg-handoff__go"><span>${o.cta ?? "Open in Business hub"}</span>${hubIcons.arrowRight()}</span>
  </button>`;
}

export function bizEmpty(o: {
  icon: BizIcon;
  title: string;
  text: string | TemplateResult;
  actions?: Array<{ label: string; primary?: boolean; run: () => void }>;
  bare?: boolean;
}): TemplateResult {
  return html`<section class="${o.bare ? "" : "g-panel bzg-glass"} bzg-empty">
    <div class="bzg-empty__glyph">${hubIcons[o.icon]()}</div>
    <h2>${o.title}</h2>
    <p>${o.text}</p>
    ${o.actions?.length
      ? html`<div class="bzg-empty__actions">${o.actions.map(
          (a) => html`<button class="g-btn ${a.primary ? "g-btn--primary" : ""} bzg-btn ${a.primary ? "bzg-btn--primary" : ""}" @click=${a.run}>${a.label}</button>`,
        )}</div>`
      : nothing}
  </section>`;
}

export function bizKpi(o: { label: string; value: string; foot?: string; onClick?: () => void }): TemplateResult {
  return o.onClick
    ? html`<button class="g-glass bzg-glass bzg-kpi" @click=${o.onClick}>
        <span class="bzg-kpi__label">${o.label}</span><span class="bzg-kpi__value">${o.value}</span>${o.foot ? html`<span class="bzg-kpi__foot">${o.foot}</span>` : nothing}
      </button>`
    : html`<div class="g-glass bzg-glass bzg-kpi">
        <span class="bzg-kpi__label">${o.label}</span><span class="bzg-kpi__value">${o.value}</span>${o.foot ? html`<span class="bzg-kpi__foot">${o.foot}</span>` : nothing}
      </div>`;
}

export function bizSkeletonKpis(n = 4): TemplateResult {
  return html`<div class="bzg-kpis" aria-busy="true">${Array.from(
    { length: n },
    () => html`<div class="g-glass bzg-glass bzg-kpi"><div class="bzg-sk" style="height:12px;width:40%"></div><div class="bzg-sk" style="height:28px;width:60%;margin-top:8px"></div><div class="bzg-sk" style="height:10px;width:80%;margin-top:auto"></div></div>`,
  )}</div>`;
}

export function bizSkeletonRows(n = 5): TemplateResult {
  return html`<div class="g-panel bzg-glass bzg-panel bzg-list" aria-busy="true">${Array.from(
    { length: n },
    () => html`<div class="bzg-li"><div class="bzg-sk" style="width:34px;height:34px;border-radius:11px"></div><div class="bzg-li__main" style="display:grid;gap:6px"><div class="bzg-sk" style="height:11px;width:42%"></div><div class="bzg-sk" style="height:9px;width:26%"></div></div><div class="bzg-sk" style="height:11px;width:60px"></div></div>`,
  )}</div>`;
}
