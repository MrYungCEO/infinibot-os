/**
 * Where the tap card floats: the web graph's hover-card placement
 * (knowledge-graph.ts positionOverlays): beside the node, clear of its halo
 * and status ring; flipped to the left when it would leave the right edge;
 * clamped 8 px inside the stage; vertically centred on the node and clamped.
 *
 * `p` = the node on screen ({ x, y, r } stage px, from stage.screenOf),
 * `card` = { w, h } of the card, `host` = { w, h } of the stage.
 * `insets` keeps it off bottom chrome (the dock / Signals pill).
 */
export const CARD_W = 280;
export const CARD_W_PHONE = 240;

export function cardWidthFor(stageW) {
  // `.kg-hovercard { width: 240px }` at ≤ 640 px, 280 px wider.
  return Math.min(stageW - 16, stageW <= 640 ? CARD_W_PHONE : CARD_W);
}

export function floatCardPos(p, card, host, insets = {}) {
  const W = host.w;
  const H = host.h;
  const cw = card.w || CARD_W;
  const ch = card.h || 200;
  const top = 8 + (insets.top || 0);
  const bottom = 8 + (insets.bottom || 0);
  // Clear the halo + status ring and the node's own label.
  const pr = p.r * 2.1;
  let x = p.x + pr + 14;
  let side = 'right';
  if (x + cw > W - 8) {
    x = p.x - pr - 14 - cw;
    side = 'left';
  }
  x = Math.max(8, Math.min(W - cw - 8, x));
  const y = Math.max(top, Math.min(H - ch - bottom, p.y - ch / 2));
  return { x: Math.round(x), y: Math.round(Math.max(top, y)), side };
}
