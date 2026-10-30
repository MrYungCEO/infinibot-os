/**
 * Tiny inline-SVG sprites for each emote type.
 *
 * Every factory returns a self-contained `<svg>` string sized within a 48×48
 * viewBox. They are intentionally markup-only (no <style>/animation inside the
 * SVG): motion is driven by the layer via the Web Animations API so we can
 * honour `prefers-reduced-motion` from one place and keep a single concurrency
 * cap. Colours lean on the premium palette already used across the world map —
 * gold accents, status reds/ambers, soft glows.
 */

import type { EmoteType } from "./types.js";

const GOLD = "#ffcf5c";
const GOLD_DEEP = "#f5a623";
const RED = "#ff5d5d";
const AMBER = "#ffb547";
const SKY = "#7cc7ff";
const WHITE = "#ffffff";

/** Soft drop-glow filter reused by several sprites. */
function glow(id: string, color: string): string {
  return `<filter id="${id}" x="-60%" y="-60%" width="220%" height="220%">
    <feDropShadow dx="0" dy="0" stdDeviation="2.2" flood-color="${color}" flood-opacity="0.9"/>
  </filter>`;
}

const success = (): string => `
<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" overflow="visible">
  <defs>
    <radialGradient id="eg-suc" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${GOLD}" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="${GOLD}" stop-opacity="0"/>
    </radialGradient>
    ${glow("gf-suc", GOLD_DEEP)}
  </defs>
  <circle cx="24" cy="24" r="22" fill="url(#eg-suc)"/>
  <g data-burst stroke="${GOLD}" stroke-width="2.4" stroke-linecap="round">
    <line x1="24" y1="4" x2="24" y2="11"/>
    <line x1="24" y1="37" x2="24" y2="44"/>
    <line x1="4" y1="24" x2="11" y2="24"/>
    <line x1="37" y1="24" x2="44" y2="24"/>
    <line x1="10" y1="10" x2="15" y2="15"/>
    <line x1="33" y1="33" x2="38" y2="38"/>
    <line x1="38" y1="10" x2="33" y2="15"/>
    <line x1="15" y1="33" x2="10" y2="38"/>
  </g>
  <circle cx="24" cy="24" r="13" fill="${GOLD_DEEP}" filter="url(#gf-suc)"/>
  <path d="M17 24.5 L22 29.5 L32 18.5" fill="none" stroke="${WHITE}" stroke-width="3.2"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const fail = (): string => `
<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" overflow="visible">
  <defs>${glow("gf-fail", RED)}</defs>
  <circle cx="24" cy="24" r="13" fill="${RED}" filter="url(#gf-fail)"/>
  <g data-crack stroke="${WHITE}" stroke-width="1.4" stroke-linecap="round" opacity="0.85">
    <path d="M24 11 L21 18 L26 22 L22 28" fill="none"/>
    <path d="M34 22 L29 24 L31 28" fill="none"/>
  </g>
  <path d="M18 18 L30 30 M30 18 L18 30" stroke="${WHITE}" stroke-width="3.2"
        stroke-linecap="round"/>
</svg>`;

const blocked = (): string => `
<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" overflow="visible">
  <defs>
    <radialGradient id="eg-blk" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${AMBER}" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="${AMBER}" stop-opacity="0"/>
    </radialGradient>
    ${glow("gf-blk", AMBER)}
  </defs>
  <circle data-pulse cx="24" cy="24" r="20" fill="url(#eg-blk)"/>
  <path d="M24 9 L41 37 L7 37 Z" fill="${AMBER}" filter="url(#gf-blk)"
        stroke="${WHITE}" stroke-width="1.4" stroke-linejoin="round"/>
  <rect x="22.4" y="19" width="3.2" height="9" rx="1.6" fill="#3a2a00"/>
  <circle cx="24" cy="32" r="1.9" fill="#3a2a00"/>
</svg>`;

const shipping = (): string => `
<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" overflow="visible">
  <defs>
    <linearGradient id="eg-shp" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${GOLD}"/>
      <stop offset="100%" stop-color="${GOLD_DEEP}"/>
    </linearGradient>
    ${glow("gf-shp", GOLD_DEEP)}
  </defs>
  <g data-trail stroke="${GOLD}" stroke-width="2.4" stroke-linecap="round" opacity="0.85">
    <line x1="24" y1="34" x2="24" y2="46"/>
    <line x1="19" y1="36" x2="19" y2="44"/>
    <line x1="29" y1="36" x2="29" y2="44"/>
  </g>
  <g filter="url(#gf-shp)">
    <path d="M24 6 C31 12 32 22 28 31 L20 31 C16 22 17 12 24 6 Z" fill="url(#eg-shp)"/>
    <circle cx="24" cy="18" r="3.4" fill="${WHITE}"/>
    <path d="M20 30 L15 35 L19 32 Z M28 30 L33 35 L29 32 Z" fill="${GOLD_DEEP}"/>
  </g>
</svg>`;

const spawn = (): string => `
<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" overflow="visible">
  <defs>
    <radialGradient id="eg-spw" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${SKY}" stop-opacity="0.6"/>
      <stop offset="100%" stop-color="${SKY}" stop-opacity="0"/>
    </radialGradient>
    ${glow("gf-spw", SKY)}
  </defs>
  <circle cx="24" cy="24" r="22" fill="url(#eg-spw)"/>
  <g data-spark fill="${WHITE}" filter="url(#gf-spw)">
    <path d="M24 12 L26 22 L36 24 L26 26 L24 36 L22 26 L12 24 L22 22 Z"/>
  </g>
  <g data-sparkmini fill="${SKY}">
    <path d="M37 13 L38 16 L41 17 L38 18 L37 21 L36 18 L33 17 L36 16 Z"/>
    <path d="M11 30 L12 32.5 L14.5 33.5 L12 34.5 L11 37 L10 34.5 L7.5 33.5 L10 32.5 Z"/>
  </g>
</svg>`;

const levelup = (): string => `
<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" overflow="visible">
  <defs>${glow("gf-lvl", GOLD_DEEP)}</defs>
  <g fill="none" stroke="${GOLD}" stroke-width="3.4" stroke-linecap="round"
     stroke-linejoin="round" filter="url(#gf-lvl)">
    <path data-chev1 d="M14 34 L24 24 L34 34"/>
    <path data-chev2 d="M14 26 L24 16 L34 26"/>
    <path data-chev3 d="M14 18 L24 8 L34 18"/>
  </g>
</svg>`;

const thinking = (): string => `
<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" overflow="visible">
  <defs>${glow("gf-thk", "#9fb4ff")}</defs>
  <g filter="url(#gf-thk)">
    <ellipse cx="24" cy="20" rx="17" ry="11" fill="${WHITE}" opacity="0.96"/>
    <circle cx="13" cy="35" r="3.4" fill="${WHITE}" opacity="0.9"/>
    <circle cx="8" cy="41" r="2.1" fill="${WHITE}" opacity="0.8"/>
  </g>
  <g fill="#5566aa">
    <circle data-dot1 cx="16" cy="20" r="2.6"/>
    <circle data-dot2 cx="24" cy="20" r="2.6"/>
    <circle data-dot3 cx="32" cy="20" r="2.6"/>
  </g>
</svg>`;

const FACTORIES: Record<EmoteType, () => string> = {
  success,
  fail,
  blocked,
  shipping,
  spawn,
  levelup,
  thinking,
};

/** Build the inline-SVG markup for an emote type. */
export function emoteSvg(type: EmoteType): string {
  return (FACTORIES[type] ?? success)().trim();
}

/** Base pixel size of an emote sprite before per-emote scaling. */
export const EMOTE_SIZE = 48;
