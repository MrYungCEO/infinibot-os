/**
 * Work pages glass kit — shared hero / stat / empty-state templates that
 * pair with ./base.css. Import this module from a view to pull the CSS in
 * (Vite injects it with the lazy chunk). See base.css for the design notes.
 */
import { html, nothing, type TemplateResult } from "lit";
import "./base.css";

/** The slow gold aurora. Place as the first child of a `.wg-page` root. */
export const wgAurora = (): TemplateResult => html`<div class="wg-aurora" aria-hidden="true"></div>`;

export function wgHero(opts: {
  eyebrow: string;
  title: unknown;
  sub?: unknown;
  actions?: unknown;
}): TemplateResult {
  return html`<header class="wg-hero">
    <div class="wg-hero__text">
      <div class="wg-eyebrow">${opts.eyebrow}</div>
      <h1 class="wg-title">${opts.title}</h1>
      ${opts.sub ? html`<p class="wg-sub">${opts.sub}</p>` : nothing}
    </div>
    ${opts.actions ? html`<div class="wg-hero__actions">${opts.actions}</div>` : nothing}
  </header>`;
}

export function wgStat(label: string, value: unknown, hint?: unknown): TemplateResult {
  return html`<div class="wg-card wg-stat">
    <div class="wg-stat__label">${label}</div>
    <div class="wg-stat__value">${value}</div>
    ${hint ? html`<div class="wg-stat__hint">${hint}</div>` : nothing}
  </div>`;
}

export function wgEmpty(opts: { icon?: TemplateResult; title: string; body?: unknown; action?: unknown }): TemplateResult {
  return html`<div class="wg-empty">
    ${opts.icon ? html`<div class="wg-empty__icon">${opts.icon}</div>` : nothing}
    <div class="wg-empty__title">${opts.title}</div>
    ${opts.body ? html`<div class="wg-empty__body">${opts.body}</div>` : nothing}
    ${opts.action ?? nothing}
  </div>`;
}
