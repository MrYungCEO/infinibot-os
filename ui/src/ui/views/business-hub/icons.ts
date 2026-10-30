/** Business hub — inline SVG icons (1.6px strokes, currentColor). */

import { html, svg, type TemplateResult } from "lit";

const wrap = (body: TemplateResult) =>
  html`<svg class="i" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  overview: () => wrap(svg`<rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/>`),
  leads: () => wrap(svg`<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>`),
  pipeline: () => wrap(svg`<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>`),
  contacts: () => wrap(svg`<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.6c1.8.7 3 2.5 3.5 5.4"/>`),
  clients: () => wrap(svg`<rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7M3 12.5h18"/>`),
  campaigns: () => wrap(svg`<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/>`),
  tracking: () => wrap(svg`<path d="M3 12h4l3-8 4 16 3-8h4"/>`),
  imports: () => wrap(svg`<path d="M12 15V3M7.5 7.5 12 3l4.5 4.5"/><path d="M4 14v4.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V14"/>`),
  revenue: () => wrap(svg`<path d="M3 17 9 11l4 4 8-8"/><path d="M15 7h6v6"/>`),
  offers: () => wrap(svg`<path d="M20 13 13 20a2 2 0 0 1-2.8 0L4 13.8a2 2 0 0 1 0-2.8L11 4h7a2 2 0 0 1 2 2z"/><circle cx="16" cy="8" r="1.2"/>`),
  autopilot: () => wrap(svg`<path d="M4 15.5 12 3l8 12.5-8 5.5z"/><path d="M12 8v8M8.5 13 12 16l3.5-3"/>`),
  inbox: () => wrap(svg`<path d="M4 4h16v13H4z"/><path d="M4 13h4l2 3h4l2-3h4"/>`),
  bookings: () => wrap(svg`<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M8 3v4M16 3v4M3 10h18M8 14h3M13 14h3M8 18h3"/>`),
  plus: () => wrap(svg`<path d="M12 5v14M5 12h14"/>`),
  search: () => wrap(svg`<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`),
  x: () => wrap(svg`<path d="M6 6l12 12M18 6 6 18"/>`),
  refresh: () => wrap(svg`<path d="M20 11a8 8 0 0 0-14.8-4M4 4v4h4M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4"/>`),
  mail: () => wrap(svg`<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/>`),
  phone: () => wrap(svg`<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>`),
  globe: () => wrap(svg`<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>`),
  clock: () => wrap(svg`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`),
  sparkle: () => wrap(svg`<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>`),
  check: () => wrap(svg`<path d="m5 12 4.5 4.5L19 7"/>`),
  arrowRight: () => wrap(svg`<path d="M5 12h14M13 6l6 6-6 6"/>`),
  link: () => wrap(svg`<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>`),
  file: () => wrap(svg`<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>`),
  undo: () => wrap(svg`<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>`),
  merge: () => wrap(svg`<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7M8 6.7c5 0 6.5 2.3 8 4.3"/>`),
  copy: () => wrap(svg`<rect x="8" y="8" width="13" height="13" rx="2.5"/><path d="M16 8V5.5A2.5 2.5 0 0 0 13.5 3h-8A2.5 2.5 0 0 0 3 5.5v8A2.5 2.5 0 0 0 5.5 16H8"/>`),
  play: () => wrap(svg`<path d="M7 4.5v15l12-7.5z"/>`),
  pause: () => wrap(svg`<path d="M8 5v14M16 5v14"/>`),
  shield: () => wrap(svg`<path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6z"/>`),
  flame: () => wrap(svg`<path d="M12 21c-3.9 0-7-2.7-7-6.5 0-3.4 2.4-5.4 4-8 .5 2 1.8 3 3 3.5 0-2.6 1-5.3 3-7 .3 3 4 5.4 4 10.5 0 4.6-3.1 7.5-7 7.5z"/>`),
};
