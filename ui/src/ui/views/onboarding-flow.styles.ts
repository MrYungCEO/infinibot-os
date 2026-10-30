/**
 * Styles for <ib-onboarding-flow> that the cloud console stylesheet
 * (saas-onboarding.ts / saas-onboarding-setup.ts) doesn't already cover.
 * Same tokens (--sob-*), black-gold, dark in every theme.
 */
import { html } from "lit";

export const onboardingFlowStyles = html`<style>
  ib-onboarding-flow { display: block; }
  /* Full-screen like the cloud workspace setup: above the app chrome. */
  /* Starts under the app top bar (measured at runtime) so nothing hides behind it. */
  .sob-screen.iob-screen { z-index: 1000; top: var(--iob-top, 0px); }
  .iob-screen .sob-foot {
    position: sticky; bottom: 0; z-index: 3;
    background: #0b0a07; box-shadow: 0 -18px 24px -8px rgba(5, 4, 3, 0.9);
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    border-bottom-left-radius: inherit; border-bottom-right-radius: inherit;
  }
  .iob-screen .sob-panel h2:focus { outline: none; }
  .iob-screen .sob-panel h2:focus-visible { outline: 2px solid var(--sob-gold); outline-offset: 4px; border-radius: 6px; }

  .iob-exit {
    appearance: none; border: 1px solid var(--sob-line); background: transparent; color: var(--sob-fg-3);
    font: 500 11px/1 var(--sob-mono); letter-spacing: 0.12em; text-transform: uppercase;
    padding: 7px 10px; border-radius: 999px; cursor: pointer; min-height: 32px;
  }
  .iob-exit:hover, .iob-exit:focus-visible { color: var(--sob-gold); border-color: var(--sob-line-2); outline: none; }

  .iob-again { margin: 18px auto 0; display: block; }

  /* Setup › Your setup › Edit: one step, no rail. */
  .iob-edit .sob-body.iob-edit__body { grid-template-columns: minmax(0, 1fr); }
  .iob-edit .sob-stage { padding-top: 28px; }
  .iob-edit .iob-exit { display: inline-flex; align-items: center; gap: 6px; }
  .iob-edit .iob-exit svg { width: 13px; height: 13px; }
  .iob-edit__applies { margin-right: 14px; max-width: 46ch; text-align: right; }
  .iob-edit > .sob-stage .iob-msg { margin: 0 28px 12px; }
  @media (max-width: 720px) { .iob-edit__applies { display: none; } }
  .sob-node.is-skipped .sob-node__dot { border-style: dashed; }
  .sob-node.is-skipped .sob-node__hint { color: var(--sob-fg-4); }

  /* Use-case cards */
  .iob-usecases { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 230px), 1fr)); gap: 10px; }
  .iob-uc { padding-right: 40px; min-height: 92px; }
  .iob-check {
    position: absolute; top: 12px; right: 12px; width: 18px; height: 18px; border-radius: 5px;
    border: 1px solid var(--sob-line-2); display: grid; place-items: center; color: #0b0a08;
  }
  .iob-check svg { width: 12px; height: 12px; stroke-width: 3; }
  .iob-uc.is-selected .iob-check { background: var(--sob-gold); border-color: var(--sob-gold); box-shadow: var(--sob-glow-soft); }
  .iob-count { margin-top: 12px; }

  /* Generic panels / rows */
  .iob-panel {
    margin-top: 14px; padding: 16px; border-radius: 14px;
    background: rgba(0, 0, 0, 0.28); border: 1px solid var(--sob-line);
    display: grid; gap: 10px;
  }
  .iob-row { display: flex; align-items: center; gap: 10px; font-size: 14px; color: var(--sob-fg-2); }
  .iob-row strong { color: var(--sob-fg); font-weight: 600; }
  /* Learning path preview (Finish) */
  .iob-path { margin: 18px auto 6px; max-width: 560px; text-align: left; padding: 16px; border-radius: 14px; background: rgba(0, 0, 0, 0.28); border: 1px solid var(--sob-line-2); display: grid; gap: 12px; }
  .iob-path__head { display: flex; gap: 12px; align-items: flex-start; }
  .iob-path__icon { width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; color: var(--sob-gold); border: 1px solid var(--sob-line-2); background: color-mix(in srgb, var(--sob-gold) 10%, transparent); flex-shrink: 0; }
  .iob-path__icon svg { width: 18px; height: 18px; }
  .iob-path__title { font-weight: 650; color: var(--sob-fg); font-size: 15px; }
  .iob-path__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .iob-path__list li { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 10px; align-items: center; font-size: 14px; color: var(--sob-fg-2); }
  .iob-path__n { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font: 600 11px/1 var(--sob-mono); color: #0b0a08; background: var(--sob-gold); }
  .iob-path__name { min-width: 0; color: var(--sob-fg); }
  .iob-path__min { font: 500 12px/1 var(--sob-mono); color: var(--sob-fg-3); }
  .iob-path__more { grid-template-columns: 1fr !important; }
  .iob-voice-setup { margin-top: 14px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .iob-led { width: 8px; height: 8px; border-radius: 50%; background: var(--sob-fg-4); flex-shrink: 0; }
  .iob-led.is-on { background: var(--sob-ok); box-shadow: 0 0 8px color-mix(in srgb, var(--sob-ok) 70%, transparent); }
  .iob-actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .iob-actions--center { justify-content: center; margin-top: 8px; }
  .iob-seg { margin: 4px 0 2px; }
  .iob-current {
    display: inline-flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 13px; color: var(--sob-fg-2);
  }
  .iob-current svg { width: 16px; height: 16px; color: var(--sob-ok); }
  .iob-current code, .iob-screen code { font-family: var(--sob-mono); font-size: 12px; color: var(--sob-gold); }
  .iob-providers { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 190px), 1fr)); gap: 10px; margin: 14px 0 6px; }
  .iob-prov__badge {
    display: inline-block; margin: 0 6px 2px 0; padding: 2px 7px; border-radius: 999px; vertical-align: 1px;
    font: 600 10px/1.3 var(--sob-mono); letter-spacing: 0.06em; text-transform: uppercase;
    color: #0b0a08; background: var(--sob-gold);
  }
  .iob-more-providers { margin: 2px 0 8px; }
  .iob-models-empty { margin: 6px 0 14px; }
  .iob-model-tools { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
  .iob-model-search { flex: 1; min-width: 0; }
  .iob-free-toggle {
    appearance: none; display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; cursor: pointer;
    padding: 7px 12px; border-radius: 999px; border: 1px solid var(--sob-line-2); background: transparent;
    color: var(--sob-fg-2); font: 500 12.5px/1 inherit;
  }
  .iob-free-toggle svg { width: 13px; height: 13px; }
  .iob-free-toggle.is-on { color: var(--sob-ok); border-color: var(--sob-ok); }
  .iob-models {
    display: grid; gap: 4px; max-height: 260px; overflow-y: auto; padding: 4px; margin-bottom: 14px;
    border: 1px solid var(--sob-line); border-radius: 12px;
  }
  .iob-model {
    appearance: none; display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; cursor: pointer;
    padding: 8px 10px; border-radius: 9px; border: 1px solid transparent; background: transparent; color: var(--sob-fg);
    font: inherit; font-size: 13.5px;
  }
  .iob-model:hover, .iob-model:focus-visible { background: rgba(255, 255, 255, 0.04); outline: none; border-color: var(--sob-line); }
  .iob-model.is-selected { border-color: var(--sob-gold); background: rgba(212, 175, 55, 0.08); }
  .iob-model__name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .iob-model__id {
    flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: var(--sob-mono); font-size: 11.5px; color: var(--sob-fg-3);
  }
  .iob-free {
    display: inline-flex; align-items: center; gap: 4px; margin-left: auto; flex-shrink: 0;
    padding: 2px 8px; border-radius: 999px; border: 1px solid var(--sob-ok); color: var(--sob-ok);
    font: 600 10.5px/1.4 var(--sob-mono); letter-spacing: 0.06em; text-transform: uppercase;
  }
  .sob-label .iob-free { margin-left: 8px; vertical-align: 1px; }
  .iob-free svg { width: 11px; height: 11px; }
  .iob-msg {
    margin-top: 12px; display: flex; gap: 10px; align-items: flex-start; padding: 11px 14px; border-radius: 12px;
    font-size: 13.5px; line-height: 1.45; border: 1px solid var(--sob-line);
  }
  .iob-msg svg { width: 16px; height: 16px; flex-shrink: 0; margin-top: 2px; }
  .iob-msg.is-ok { color: var(--sob-fg); border-color: color-mix(in srgb, var(--sob-ok) 40%, transparent); background: color-mix(in srgb, var(--sob-ok) 8%, transparent); }
  .iob-msg.is-ok svg { color: var(--sob-ok); }
  .iob-msg.is-bad { color: var(--sob-fg); border-color: color-mix(in srgb, var(--sob-danger) 45%, transparent); background: color-mix(in srgb, var(--sob-danger) 8%, transparent); }
  .iob-msg.is-bad svg { color: var(--sob-danger); }
  .iob-testmode {
    display: flex; gap: 8px; align-items: center; font-size: 12.5px; color: var(--sob-gold);
    padding: 8px 12px; border-radius: 10px; border: 1px dashed var(--sob-line-2);
  }
  .iob-testmode svg { width: 14px; height: 14px; }
  .iob-steps { margin: 0; padding-left: 20px; color: var(--sob-fg-2); font-size: 14px; display: grid; gap: 4px; }
  .iob-qr { width: 180px; padding: 8px; background: #fff; border-radius: 12px; }
  .iob-qr img { display: block; width: 100%; image-rendering: pixelated; }
  .iob-code {
    font: 600 26px/1 var(--sob-mono); letter-spacing: 0.2em; color: var(--sob-gold);
    padding: 14px 18px; border-radius: 12px; border: 1px solid var(--sob-line-2); width: fit-content;
  }
  .iob-note {
    margin-top: 14px; display: flex; gap: 10px; align-items: flex-start; font-size: 13.5px; color: var(--sob-fg-2);
  }
  .iob-note svg { width: 16px; height: 16px; color: var(--sob-gold); flex-shrink: 0; margin-top: 2px; }
  .iob-cloud { padding: 12px 14px; border-radius: 12px; border: 1px solid color-mix(in srgb, var(--sob-gold) 22%, transparent); background: color-mix(in srgb, var(--sob-gold) 5%, transparent); text-align: left; }
  .iob-cloud b { color: var(--sob-fg); font-weight: 600; }
  .iob-cloud a { color: var(--sob-gold); text-decoration: underline; text-underline-offset: 3px; white-space: nowrap; }
  .sob-done .iob-cloud { max-width: 560px; margin: 18px auto 0; }

  /* AI brain: "Which of these do you already have?" */
  .iob-have { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 16px 0 4px; }
  .iob-have__card { min-height: 92px; padding-right: 48px; }
  .iob-have__card--wide { grid-column: 1 / -1; }
  .iob-have__card .sob-opt__icon { width: 44px; height: 44px; border-radius: 12px; }
  .iob-have__card .sob-opt__icon svg { width: 22px; height: 22px; }
  .iob-have__card .sob-opt__title { font-size: 17px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .iob-have__card.is-recommended { border-color: color-mix(in srgb, var(--sob-ok) 45%, transparent); }
  .iob-have__card.is-skeleton { cursor: default; opacity: 0.4; animation: iob-pulse 1.4s ease-in-out infinite; }
  .iob-have__go { position: absolute; right: 16px; top: 50%; margin-top: -9px; color: var(--sob-fg-4); transition: transform 0.25s var(--sob-ease), color 0.25s; }
  .iob-have__go svg { width: 18px; height: 18px; }
  .iob-have__card:hover .iob-have__go, .iob-have__card:focus-visible .iob-have__go { color: var(--sob-gold); transform: translateX(3px); }
  .iob-have__none { margin: 10px 0 0; }
  .iob-have__none strong { color: var(--sob-fg); }
  .iob-chip {
    font: 600 10px/1 var(--sob-mono); letter-spacing: 0.08em; text-transform: uppercase; white-space: nowrap;
    padding: 5px 8px; border-radius: 999px; border: 1px solid var(--sob-line); color: var(--sob-fg-3);
  }
  .iob-chip.is-free { color: #0b0a08; background: var(--sob-ok); border-color: var(--sob-ok); }
  .iob-more { margin-top: 18px; border-top: 1px solid var(--sob-line); padding-top: 12px; }
  .iob-more__toggle, .iob-linkbtn {
    appearance: none; background: none; border: 0; padding: 6px 0; cursor: pointer; font: inherit; min-height: 36px;
    display: inline-flex; align-items: center; gap: 6px; color: var(--sob-fg-3); font-size: 13.5px; text-align: left;
  }
  .iob-more__toggle svg, .iob-linkbtn svg { width: 14px; height: 14px; flex-shrink: 0; }
  .iob-more__toggle:hover, .iob-more__toggle:focus-visible, .iob-linkbtn:hover, .iob-linkbtn:focus-visible { color: var(--sob-gold); outline: none; }
  .iob-more__body { margin-top: 8px; }
  .iob-linkbtn { text-decoration: underline; text-underline-offset: 3px; }

  /* Automatic setup checklist */
  .iob-setup {
    margin-top: 16px; padding: 18px; border-radius: 16px; display: grid; gap: 14px;
    background: linear-gradient(180deg, color-mix(in srgb, var(--sob-gold) 6%, transparent), rgba(0, 0, 0, 0.28));
    border: 1px solid var(--sob-line-2);
  }
  .iob-setup__bar { height: 6px; border-radius: 999px; overflow: hidden; background: rgba(255, 255, 255, 0.06); }
  .iob-setup__bar span {
    display: block; height: 100%; border-radius: inherit; transition: width 0.5s var(--sob-ease);
    background: linear-gradient(90deg, color-mix(in srgb, var(--sob-gold) 60%, #7a4b00), var(--sob-gold)); box-shadow: var(--sob-glow-soft);
  }
  .iob-setup.iob-ph-done .iob-setup__bar span { background: var(--sob-ok); }
  .iob-setup.iob-ph-fail .iob-setup__bar span { background: var(--sob-danger); }
  .iob-setup__steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
  .iob-setup__step { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 12px; align-items: start; color: var(--sob-fg-3); }
  .iob-setup__mark {
    width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; flex-shrink: 0;
    border: 1px solid var(--sob-line-2); font: 600 12px/1 var(--sob-mono); color: var(--sob-fg-3);
  }
  .iob-setup__mark svg { width: 15px; height: 15px; }
  .iob-setup__mark .sob-spinner { width: 14px; height: 14px; color: var(--sob-gold); }
  .iob-setup__text { display: grid; gap: 2px; padding-top: 4px; min-width: 0; }
  .iob-setup__label { font-size: 15px; line-height: 1.4; }
  .iob-setup__step.iob-st-active { color: var(--sob-fg); }
  .iob-setup__step.iob-st-active .iob-setup__mark { border-color: var(--sob-gold); box-shadow: var(--sob-glow-soft); }
  .iob-setup__step.iob-st-active .iob-setup__label { font-weight: 600; }
  .iob-setup__step.iob-st-done, .iob-setup__step.iob-st-skipped { color: var(--sob-fg-2); }
  .iob-setup__step.iob-st-done .iob-setup__mark, .iob-setup__step.iob-st-skipped .iob-setup__mark { color: #0b0a08; background: var(--sob-ok); border-color: var(--sob-ok); }
  .iob-setup__step.iob-st-fail { color: var(--sob-fg); }
  .iob-setup__step.iob-st-fail .iob-setup__mark { color: var(--sob-danger); border-color: color-mix(in srgb, var(--sob-danger) 60%, transparent); }
  .iob-setup__line { margin: 0; font-size: 14px; line-height: 1.5; color: var(--sob-fg-2); }
  .iob-setup__err { margin-top: 0; }
  .iob-setup__err .iob-linkbtn { display: inline; padding: 0 0 0 4px; min-height: 0; font-size: 13px; color: var(--sob-fg-3); }
  .iob-setup__details { display: block; margin-top: 6px; font: 12px/1.45 var(--sob-mono); color: var(--sob-fg-3); overflow-wrap: anywhere; }
  .iob-setup__code { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
  .iob-setup__code > .sob-hint { flex-basis: 100%; }
  .iob-setup__link { display: grid; gap: 6px; min-width: 0; }
  .iob-setup__url {
    display: block; min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(246, 200, 115, 0.18);
    background: rgba(0, 0, 0, 0.35); font-size: 12px; color: rgba(255, 255, 255, 0.78);
    user-select: all;
  }
  .iob-setup__linkbtns { display: flex; flex-wrap: wrap; gap: 8px; }
  .iob-setup__mini {
    min-height: 34px; padding: 6px 14px; font-size: 12.5px; font-weight: 600; gap: 6px;
    display: inline-flex; align-items: center; border-radius: 10px; cursor: pointer;
    color: #f6c873; background: rgba(246, 200, 115, 0.08); border: 1px solid rgba(246, 200, 115, 0.38);
  }
  .iob-setup__mini:hover { background: rgba(246, 200, 115, 0.16); border-color: rgba(246, 200, 115, 0.6); color: #ffe2a6; }
  .iob-setup__mini:focus-visible { outline: 2px solid #f6c873; outline-offset: 2px; }
  .iob-setup__mini svg { width: 14px; height: 14px; }
  .iob-setup__paste { margin: 0; min-width: 0; }
  .iob-setup__paste .sob-input { width: 100%; box-sizing: border-box; }
  .iob-setup > * { min-width: 0; }
  .iob-setup__warn { margin: 0; color: var(--sob-danger); }
  .iob-setup__reply { margin: 0; display: grid; gap: 8px; }
  .iob-setup__reply figcaption { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--sob-ok); }
  .iob-setup__reply figcaption svg { width: 15px; height: 15px; }
  .iob-setup__reply blockquote {
    margin: 0; padding: 12px 14px; border-radius: 14px 14px 14px 4px; font-size: 14.5px; line-height: 1.5; color: var(--sob-fg);
    background: rgba(255, 255, 255, 0.04); border: 1px solid var(--sob-line); white-space: pre-wrap; overflow-wrap: anywhere;
    max-height: 180px; overflow: auto;
  }
  .iob-setup__actions { justify-content: flex-start; }
  .iob-setup__primary { min-width: 200px; justify-content: center; }
  .iob-setup__nudge { justify-self: start; }
  .iob-setup .iob-note { margin-top: 0; font-size: 12.5px; color: var(--sob-fg-3); }
  @keyframes iob-pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.2; } }

  /* Mic test */
  .iob-mic {
    margin-top: 16px; padding: 16px; border-radius: 14px; display: grid; gap: 12px;
    background: linear-gradient(180deg, color-mix(in srgb, var(--sob-gold) 6%, transparent), rgba(0,0,0,0.25));
    border: 1px solid var(--sob-line-2);
  }
  .iob-mic__head { display: flex; gap: 12px; align-items: center; }
  .iob-mic__icon, .iob-secure__icon {
    width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center; flex-shrink: 0;
    color: var(--sob-gold); border: 1px solid var(--sob-line-2); box-shadow: var(--sob-glow-soft);
  }
  .iob-mic__icon svg, .iob-secure__icon svg { width: 18px; height: 18px; }
  .iob-mic__title { font-size: 15px; font-weight: 600; color: var(--sob-fg); }
  .iob-meter { display: grid; grid-template-columns: repeat(24, 1fr); gap: 3px; height: 26px; align-items: end; }
  .iob-meter span { display: block; height: 100%; border-radius: 3px; background: rgba(255,255,255,0.06); transition: background 0.08s; }
  .iob-meter span.is-on { background: linear-gradient(180deg, var(--sob-gold), color-mix(in srgb, var(--sob-gold) 55%, #7a4b00)); box-shadow: 0 0 6px color-mix(in srgb, var(--sob-gold) 50%, transparent); }
  .iob-mic__status { margin: 0; font-size: 14px; color: var(--sob-fg-2); min-height: 1.5em; }
  .iob-transcript { display: grid; gap: 4px; }
  .iob-transcript q { font-size: 15px; color: var(--sob-fg); }
  .iob-audio { width: 100%; max-width: 360px; height: 36px; }

  /* Secure Mode */
  .iob-secure { display: flex; align-items: center; gap: 14px; }
  .iob-secure__text { flex: 1; min-width: 0; }
  .iob-switch {
    appearance: none; position: relative; width: 46px; height: 26px; border-radius: 999px; cursor: pointer; flex-shrink: 0;
    border: 1px solid var(--sob-line-2); background: rgba(255,255,255,0.06); padding: 0;
  }
  .iob-switch span {
    position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%;
    background: var(--sob-fg-3); transition: transform 0.25s var(--sob-ease), background 0.25s;
  }
  .iob-switch.is-on { background: color-mix(in srgb, var(--sob-gold) 30%, transparent); border-color: var(--sob-gold); }
  .iob-switch.is-on span { transform: translateX(20px); background: var(--sob-gold); box-shadow: var(--sob-glow-soft); }
  .iob-switch:focus-visible { outline: 2px solid var(--sob-gold); outline-offset: 3px; }
  .iob-switch:disabled { opacity: 0.45; cursor: not-allowed; }

  /* Plan */
  .iob-section + .iob-section { margin-top: 18px; }
  .iob-h3 {
    display: flex; align-items: center; gap: 8px; margin: 0 0 10px;
    font: 500 11px/1 var(--sob-mono); letter-spacing: 0.22em; text-transform: uppercase; color: var(--sob-gold);
  }
  .iob-h3 svg { width: 14px; height: 14px; }
  .iob-plugins { display: grid; gap: 8px; }
  .iob-kv { display: grid; gap: 6px; margin-top: 12px; }
  .iob-kv .sob-hint { margin: 0; }
  .iob-plugin {
    display: flex; align-items: center; gap: 14px; padding: 12px 14px; border-radius: 12px;
    border: 1px solid var(--sob-line); background: rgba(255,255,255,0.02);
  }
  .iob-plugin.is-selected { border-color: color-mix(in srgb, var(--sob-gold) 55%, transparent); background: color-mix(in srgb, var(--sob-gold) 6%, transparent); }
  .iob-plugin__main { flex: 1; min-width: 0; display: grid; gap: 2px; }
  .iob-plugin__name { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-weight: 600; color: var(--sob-fg); }
  .iob-plugin__note { font-size: 12px; color: var(--sob-gold); }
  .iob-badge {
    font: 600 10px/1 var(--sob-mono); letter-spacing: 0.1em; text-transform: uppercase;
    padding: 4px 7px; border-radius: 999px; border: 1px solid var(--sob-line);
    color: var(--sob-fg-3);
  }
  .iob-badge--pro, .iob-badge--paid { color: #0b0a08; background: var(--sob-gold); border-color: var(--sob-gold); }
  .iob-badge--desktop { color: var(--sob-gold); border-color: var(--sob-line-2); }
  .iob-state { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--sob-ok); }
  .iob-state svg { width: 15px; height: 15px; }
  .iob-state.is-muted { color: var(--sob-fg-4); }
  .iob-small { padding: 7px 12px; min-height: 36px; font-size: 13px; }
  .iob-small svg { width: 13px; height: 13px; }
  .iob-courses { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .iob-course { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 10px; border: 1px solid var(--sob-line); }
  .iob-course__num { font: 500 11px/1 var(--sob-mono); color: var(--sob-gold); }
  .iob-course__title { font-size: 14px; color: var(--sob-fg); }
  .iob-check-row { display: flex; gap: 10px; align-items: flex-start; font-size: 14px; color: var(--sob-fg-2); padding: 6px 0; cursor: pointer; }
  .iob-check-row input { accent-color: var(--sob-gold); width: 18px; height: 18px; margin-top: 2px; flex-shrink: 0; }
  .iob-check-row strong { color: var(--sob-gold); font-weight: 600; }

  /* Finish */
  .iob-applied { list-style: none; margin: 14px auto 6px; padding: 0; display: grid; gap: 8px; max-width: 520px; text-align: left; }
  .iob-applied__row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 14px; color: var(--sob-fg-2); }
  .iob-applied__row svg { width: 16px; height: 16px; flex-shrink: 0; }
  .iob-applied__row.is-ok svg { color: var(--sob-ok); }
  .iob-applied__row.is-fail svg { color: var(--sob-danger); }
  .iob-applied__row.is-skip { color: var(--sob-fg-4); }
  .iob-applied__row.is-pending svg { color: var(--sob-gold); animation: iob-spin 1s linear infinite; }
  .iob-applied__row .sob-hint { width: 100%; padding-left: 24px; margin: 0; }
  @keyframes iob-spin { to { transform: rotate(360deg); } }

  /* Touch targets + phones */
  .iob-screen .sob-btn { min-height: 44px; }
  @media (max-width: 720px) {
    .iob-usecases, .iob-providers, .iob-have { grid-template-columns: minmax(0, 1fr); }
    .iob-have__card { min-height: 0; }
    .iob-setup { padding: 14px; }
    .iob-setup__actions .sob-btn { flex: 1 1 100%; justify-content: center; }
    .iob-setup__actions .iob-linkbtn { margin: 0 auto; }
    .iob-uc { min-height: 0; }
    .iob-plugin { flex-wrap: wrap; }
    /* One row on phones: Back · Skip · Continue, compact. */
    .iob-screen .sob-foot { flex-wrap: nowrap; gap: 8px; padding: 10px 12px; }
    .iob-screen .sob-foot .sob-foot__spacer { display: none; }
    .iob-screen .sob-foot .sob-btn { flex: 1 1 0; min-width: 0; padding-inline: 10px; justify-content: center; }
    .iob-exit { padding: 6px 8px; }
    .sob-bar__path, .sob-bar__name { display: none; }
    .iob-screen .sob-bar__status { gap: 6px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .iob-switch span, .iob-meter span { transition: none; }
    .iob-applied__row.is-pending svg { animation: none; }
    .iob-have__card.is-skeleton { animation: none; }
    .iob-setup__bar span, .iob-have__go { transition: none; }
  }
/* Setup-guide video buttons (ui/src/ui/setup-guide-video.ts) */
.sob-hero__guide { margin-top: 14px; display: flex; justify-content: center; }
.sob-guide-chip { margin: 2px 0 14px; }
</style>`;
