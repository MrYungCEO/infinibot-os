/**
 * Shared glass layer for the agent / ops pages (Agents, Activity, Autonomy,
 * Memory, Characters, Reviews, Reports, Oversight, Mesh).
 *
 * Builds on the `.gt-*` primitives from glass-tools-shared.ts (the same
 * recipe as the tools pages and the Business hub: frosted panels, hairline
 * gold gradient edge, specular top light, slow gold aurora) and adds:
 *
 *   • `GLASS_AGENTS_SHADOW_CSS` — the same primitives rewritten for shadow
 *     roots (`:root[data-theme="light"] X` → `:host-context([data-theme="light"]) X`,
 *     `:root.perf-mode X` → `:host-context(.perf-mode) X`), so Lit elements
 *     with their own `static styles` can use `.gt-*` classes too.
 *   • `.ga-*` helpers shared by these pages: section panel, toolbar, stat
 *     tile with live light, skeleton rows and a guiding empty state.
 *
 * Every page that uses this wraps its root in `.gt-scope` plus its own page
 * class (e.g. `.ga-autonomy`) and keeps its page-specific overrides in its
 * own file, scoped under that page class.
 */
import { html, unsafeCSS, type TemplateResult } from "lit";
import { GLASS_TOOLS_CSS } from "./glass-tools-shared";

/** Extra helpers shared by the agent / ops pages. Light-DOM form. */
export const GLASS_AGENTS_CSS = /* css */ `
/* Section panel: frosted, gold hairline, specular top edge. */
.ga-panel {
  position: relative;
  padding: 18px 18px 16px;
  border-radius: var(--gt-radius);
  background: var(--gt-surface);
  -webkit-backdrop-filter: var(--gt-blur);
  backdrop-filter: var(--gt-blur);
  box-shadow: var(--gt-shadow);
}
.ga-panel::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(140deg, var(--gt-gold-hair) 0%, color-mix(in srgb, var(--gt-gold) 8%, transparent) 30%, var(--gt-line) 55%, color-mix(in srgb, var(--gt-gold) 26%, transparent) 100%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  pointer-events: none;
}
/* Card that sits on a panel: no blur (blur budget), hairline + lift. */
.ga-card {
  position: relative;
  border-radius: var(--gt-radius-sm);
  background: color-mix(in srgb, var(--gt-fg) 3.5%, transparent);
  border: 1px solid var(--gt-line);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
  transition: transform 360ms var(--gt-ease), border-color 220ms ease, box-shadow 360ms var(--gt-ease), background 220ms ease;
}
.ga-card:hover {
  border-color: color-mix(in srgb, var(--gt-gold) 32%, transparent);
  background: color-mix(in srgb, var(--gt-fg) 5.5%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent), 0 14px 34px -18px color-mix(in srgb, var(--gt-gold) 45%, transparent);
}
.ga-section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 12px;
  font: 600 10.5px/1 var(--mono);
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--gt-gold-ink);
}
.ga-section-head::after {
  content: "";
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--gt-gold) 40%, transparent), transparent);
}
.ga-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.ga-skel-row { height: 46px; margin-bottom: 8px; border-radius: 12px; }
.ga-skel-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.ga-skel-card { height: 120px; border-radius: 16px; }
.ga-mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
@media (max-width: 640px) {
  .ga-panel { padding: 14px 12px 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .ga-card { transition: none !important; }
}
:root.perf-mode .ga-panel { -webkit-backdrop-filter: none; backdrop-filter: none; background: var(--gt-surface-solid); }
@media (prefers-reduced-transparency: reduce) {
  .ga-panel { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; background: var(--gt-surface-solid) !important; }
}
`;

/** Rewrite document-level theme selectors so they work inside a shadow root. */
export function toShadowCss(cssText: string): string {
  return cssText
    .replace(/:root\[data-theme="light"\]\s+/g, ':host-context([data-theme="light"]) ')
    .replace(/:root\.perf-mode\s+/g, ":host-context(.perf-mode) ");
}

/** Light-DOM `<style>` text: tools primitives + agent helpers. */
export const GLASS_AGENTS_LIGHT_CSS = GLASS_TOOLS_CSS + GLASS_AGENTS_CSS;

/** Shadow-DOM version, ready for `static styles = [GLASS_AGENTS_SHADOW_CSS, css\`…\`]`. */
export const GLASS_AGENTS_SHADOW_CSS = unsafeCSS(toShadowCss(GLASS_AGENTS_LIGHT_CSS));

/** `<style>` tag for light-DOM views. Safe to render more than once. */
export const glassAgentsStyle = (extra = "") => html`<style>${GLASS_AGENTS_LIGHT_CSS}${extra}</style>`;

/** Skeleton placeholder rows (shimmer, honours reduced motion). */
export function glassSkeletonRows(count = 4): TemplateResult {
  return html`<div aria-busy="true" aria-label="Loading">
    ${Array.from({ length: count }, () => html`<div class="gt-skel ga-skel-row"></div>`)}
  </div>`;
}

/** Skeleton placeholder card grid. */
export function glassSkeletonCards(count = 6): TemplateResult {
  return html`<div class="ga-skel-grid" aria-busy="true" aria-label="Loading">
    ${Array.from({ length: count }, () => html`<div class="gt-skel ga-skel-card"></div>`)}
  </div>`;
}

const EMPTY_ICON = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L4.8 8.3l5-.7z"/></svg>`;

/** Guiding empty state: orb icon, title, one-line hint and an optional action. */
export function glassEmpty(opts: { title: string; sub?: string; icon?: unknown; action?: unknown }): TemplateResult {
  return html`<div class="gt-empty">
    <div class="gt-empty-orb">${opts.icon ?? EMPTY_ICON}</div>
    <div class="gt-empty-title">${opts.title}</div>
    ${opts.sub ? html`<div class="gt-empty-sub">${opts.sub}</div>` : null}
    ${opts.action ?? null}
  </div>`;
}

export { glassAurora, glassHero, glassSparkline, GLASS_TOOLS_CSS } from "./glass-tools-shared";
