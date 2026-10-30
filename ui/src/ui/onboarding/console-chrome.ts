/**
 * The onboarding console: shared chrome for the hosted SaaS quickstart
 * (views/saas-onboarding.ts) and the local `infinibot quickstart` wizard
 * (views/local-setup.ts). The hero, the glass console with its power-on doors,
 * the step rail, the step header and the footer live here so both flows look
 * and move the same; each flow only renders its step bodies.
 *
 * No emoji anywhere: providers get two-letter marks, the assistant a monogram.
 */
import { html, nothing, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { icon } from "../icons";
import { renderTerminalGround, terminalAmbientStyles } from "../saas-terminal-ambient";
import { onboardingStyles } from "./console-styles";

/** Tight-cropped brand mark (the globe + infinity), 354×384 with transparency. */
export const BRAND_MARK_SRC = "./infinibot-mark.png";
const MARK_W = 354;
const MARK_H = 384;

/**
 * The real logo at its own aspect ratio. Explicit width/height attributes
 * reserve the box before the image loads (no layout shift) and match the
 * intrinsic ratio, so it can never be stretched.
 */
export function renderBrandMark(height: number, extraClass = ""): TemplateResult {
  const width = Math.round((height * MARK_W) / MARK_H);
  return html`<img
    class="sob-mark ${extraClass}"
    src=${BRAND_MARK_SRC}
    width=${width}
    height=${height}
    style="--mark-h:${height}px"
    alt=""
    decoding="async"
  />`;
}

export const SIGIL = html`<svg class="sob-sigil__svg" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">
  <path d="M24 4 41.3 14v20L24 44 6.7 34V14z" opacity=".5" />
  <path d="M24 13l9.5 5.5v11L24 35l-9.5-5.5v-11z" />
  <path d="M24 4v9M24 35v9M6.7 14l7.8 4.5M41.3 14l-7.8 4.5M6.7 34l7.8-4.5M41.3 34l-7.8-4.5" opacity=".45" />
  <circle cx="24" cy="24" r="2.6" fill="currentColor" stroke="none" />
</svg>`;

/** Padlock; the open variant's shackle lifts on mount — the key-verified / unlock beat. */
export const lockIcon = (open: boolean) => html`<svg class="sob-lock ${open ? "is-open" : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path class="sob-lock__shackle" d=${open ? "M7 11V7a5 5 0 0 1 9.9-1" : "M7 11V7a5 5 0 0 1 10 0v4"} />
  <rect width="18" height="11" x="3" y="11" rx="2" />
</svg>`;

/**
 * The assistant's mark: initials from the name — two for a multi-word name,
 * one otherwise. Letters and digits only, so an emoji in the name never ends
 * up in the mark. Empty when the name has nothing usable.
 */
export function monogramFor(name: string): string {
  const initials = name
    .trim()
    .split(/[\s\-_.]+/)
    .map((word) => [...word].find((ch) => /[\p{L}\p{N}]/u.test(ch)))
    .filter((ch): ch is string => Boolean(ch));
  return initials.slice(0, initials.length >= 2 ? 2 : 1).join("").toUpperCase();
}

export type SigilSize = "sm" | "lg" | "xl";

export function renderSigil(name: string, size: SigilSize): TemplateResult {
  const mono = monogramFor(name);
  return html`<span class="sob-sigil sob-sigil--${size} ${mono ? "" : "is-empty"}" aria-hidden="true">
    ${size === "sm" ? nothing : html`<span class="sob-sigil__halo"></span><span class="sob-sigil__orbit"></span>`}
    <span class="sob-sigil__face"
      >${mono ? keyed(mono, html`<span class="sob-sigil__glyph">${mono}</span>`) : SIGIL}</span
    >
  </span>`;
}

/** Registry labels carry a parenthetical ("xAI (Grok)"): split it into title + sub. */
export function splitProviderLabel(label: string): { title: string; sub: string | null } {
  const m = /^(.*?)\s*\((.+)\)\s*$/.exec(label);
  return m ? { title: m[1], sub: m[2] } : { title: label, sub: null };
}

/** Two-letter, periodic-table style marks. Text only: the registry's emoji icons are never shown. */
const PROVIDER_MARKS: Record<string, string> = {
  anthropic: "An",
  openai: "Oa",
  google: "Gm",
  groq: "Gq",
  together: "Tg",
  deepseek: "Ds",
  mistral: "Mi",
  cohere: "Co",
  perplexity: "Px",
  fireworks: "Fw",
  openrouter: "Or",
  xai: "Xa",
  cerebras: "Cb",
  zai: "Zg",
  llamacloud: "Ll",
  "ollama-cloud": "Ol",
  ollama: "Lo",
  replicate: "Rp",
};

/** A provider's mark; unknown (newly registered) providers get initial + next consonant. */
export function providerMark(p: { id: string; label: string }): string {
  const known = PROVIDER_MARKS[p.id];
  if (known) return known;
  const chars = [...splitProviderLabel(p.label).title].filter((ch) => /[\p{L}\p{N}]/u.test(ch));
  if (chars.length === 0) return "--";
  const second = chars.slice(1).find((ch) => /[bcdfghjklmnpqrstvwxz]/i.test(ch)) ?? chars[1] ?? "";
  return `${chars[0].toUpperCase()}${second.toLowerCase()}`;
}

// ── Console shell ────────────────────────────────────────────────────────────

export type ConsoleStep = {
  key: string;
  label: string;
  hint: string;
  /** Informational step this install can't run: shown, always skippable. */
  locked?: boolean;
};

export const COUNT_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];

/** "Step 03 —— Label", the title and the lead line at the top of a step body. */
export function renderStepHeader(
  steps: readonly ConsoleStep[],
  key: string,
  title: TemplateResult | string,
  sub: TemplateResult | string,
): TemplateResult {
  const i = Math.max(0, steps.findIndex((step) => step.key === key));
  return html`
    <div class="sob-eyebrow">
      <span class="sob-eyebrow__code">Step ${String(i + 1).padStart(2, "0")}</span>
      <span class="sob-eyebrow__rule"></span>
      <span>${steps[i]?.label}</span>
    </div>
    <h2 class="sob-title">${title}</h2>
    <p class="sob-sub">${sub}</p>
  `;
}

export type ConsoleShellOptions = {
  steps: readonly ConsoleStep[];
  /** Index of the current step. */
  step: number;
  /** Setup is complete: the rail shows every step done and the footer hides. */
  finished: boolean;
  /** The current step allows moving on (gates clicking the next rail node). */
  canNext: boolean;
  onGo: (index: number) => void;
  hero: { eyebrow: string; title: string; sub: string };
  /** Mono path after the brand in the console bar, e.g. "/ workspace-init". */
  barPath: string;
  /** Left of the step counter in the bar. */
  barStatus?: TemplateResult;
  /** The step body (rendered inside the keyed panel so it animates in). */
  body: TemplateResult;
  /** Footer (Back / note / Continue); omitted when finished. */
  footer: TemplateResult | typeof nothing;
  /** The exit flash is playing. */
  opening?: boolean;
  testid: string;
  /** Flow-specific styles, emitted after the shared ones so they can refine them. */
  extraStyles?: TemplateResult;
};

/** The console with hero, bar, rail, panel and footer. Styles included. */
export function renderConsoleShell(o: ConsoleShellOptions): TemplateResult {
  const { steps } = o;
  const progress = o.finished ? 1 : steps.length > 1 ? o.step / (steps.length - 1) : 1;
  const counter = `${String(o.step + 1).padStart(2, "0")} / ${String(steps.length).padStart(2, "0")}`;
  const long = steps.length > 4;
  const current = steps[o.step];
  return html`
    ${terminalAmbientStyles()} ${onboardingStyles()} ${o.extraStyles ?? nothing}
    <div class="sob-screen ${o.opening ? "is-opening" : ""} ${long ? "is-long" : ""}" data-testid=${o.testid}>
      ${renderTerminalGround()}
      <main class="sob-stage">
        <header class="sob-hero">
          <div class="sob-hero__eyebrow"><span class="sob-led is-on"></span>${o.hero.eyebrow}</div>
          <h1 class="sob-hero__title">${o.hero.title}</h1>
          <p class="sob-hero__sub">${o.hero.sub}</p>
        </header>

        <div class="sob-console" style="--sob-progress:${progress};--sob-steps:${steps.length}">
          <span class="sob-corner sob-corner--tl"></span><span class="sob-corner sob-corner--tr"></span>
          <span class="sob-corner sob-corner--bl"></span><span class="sob-corner sob-corner--br"></span>
          <span class="sob-console__trace"></span>
          <span class="sob-console__doors" aria-hidden="true"
            ><span class="sob-door sob-door--top"></span><span class="sob-door sob-door--bottom"></span
          ></span>

          <div class="sob-console__inner">
            <div class="sob-bar">
              <div class="sob-bar__brand">
                ${renderBrandMark(22)}
                <span class="sob-bar__name">InfiniBot</span>
                <span class="sob-bar__path">${o.barPath}</span>
              </div>
              <div class="sob-bar__status">
                ${o.barStatus ?? html`<span class="sob-bar__link"><span class="sob-led is-on"></span>Link active</span>`}
                <span class="sob-bar__count">${o.finished ? "Unlocked" : counter}</span>
              </div>
            </div>

            <div class="sob-body">
              <nav class="sob-rail ${long ? "is-long" : ""}" aria-label="Setup progress">
                <span class="sob-rail__track"><span class="sob-rail__fill"></span></span>
                ${steps.map((step, i) => {
                  const reachable = i <= o.step || (i === o.step + 1 && o.canNext);
                  const done = i < o.step || o.finished;
                  const active = i === o.step && !o.finished;
                  return html`<button
                    type="button"
                    class="sob-node ${active ? "is-active" : ""} ${done ? "is-done" : ""}"
                    aria-current=${active ? "step" : "false"}
                    aria-label=${`Step ${i + 1}: ${step.label}`}
                    ?disabled=${!reachable || o.finished}
                    @click=${() => o.onGo(i)}
                  >
                    <span class="sob-node__dot">
                      ${done ? icon("check") : html`<span class="sob-node__num">${i + 1}</span>`}
                    </span>
                    <span class="sob-node__text">
                      <span class="sob-node__code">${String(i + 1).padStart(2, "0")}</span>
                      <span class="sob-node__label">${step.label}</span>
                      <span class="sob-node__hint">${step.hint}</span>
                    </span>
                  </button>`;
                })}
              </nav>
              ${long && !o.finished && current
                ? html`<div class="sob-rail__now" aria-hidden="true">
                    <span class="sob-rail__now-code">${String(o.step + 1).padStart(2, "0")}</span>${current.label}<span
                      class="sob-dot"
                    ></span
                    ><span class="sob-rail__now-hint">${current.hint}</span>
                  </div>`
                : nothing}

              <section class="sob-panel">
                ${keyed(o.finished ? "done" : `${current?.key ?? ""}:${o.step}`, html`<div class="sob-panel__step">${o.body}</div>`)}
              </section>
            </div>

            ${o.finished ? nothing : o.footer}
          </div>
        </div>
      </main>
      ${o.opening ? html`<div class="sob-flash" aria-hidden="true"></div>` : nothing}
    </div>
  `;
}

/** Footer with Back, an optional note, and a primary action. */
export function renderConsoleFooter(o: {
  canBack: boolean;
  onBack: () => void;
  note: string | null;
  primary: TemplateResult;
}): TemplateResult {
  return html`<footer class="sob-foot">
    <button type="button" class="sob-btn sob-btn--ghost" ?disabled=${!o.canBack} @click=${o.onBack}>
      ${icon("arrowLeft")}Back
    </button>
    <span class="sob-foot__spacer"></span>
    ${o.note ? html`<span class="sob-foot__note"><span class="sob-led"></span>${o.note}</span>` : nothing}
    ${o.primary}
  </footer>`;
}
