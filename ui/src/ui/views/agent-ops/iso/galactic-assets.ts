/**
 * Galactic HQ procedural asset bakery.
 *
 * All tiles and furniture are drawn once with PIXI.Graphics and baked to
 * RenderTextures via renderer.generateTexture() — no runtime asset loading,
 * no AI dependency. Mirrors the pattern used by cozy-room-assets.ts.
 */

import * as PIXI from 'pixi.js';

import { GALACTIC, mixColor } from './galactic-theme';
import { TILE_W, TILE_H, diamondPoints } from './projection';
import { drawPixelText, measurePixelText } from './pixel-text';
import { AGENT_SPRITE_SRC } from '../agent-sprites';

// ════════════════════════════════════════════════════════════════
// COLOR HELPERS
// ════════════════════════════════════════════════════════════════

/** Multiply a 0xRRGGBB color by factor f (0..1 darkens, >1 lightens). */
export function shade(color: number, f: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * f));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * f));
  const b = Math.min(255, Math.round((color & 0xff) * f));
  return (r << 16) | (g << 8) | b;
}

// ════════════════════════════════════════════════════════════════
// DRAWING HELPERS
// ════════════════════════════════════════════════════════════════

/**
 * Draw an isometric block: top diamond (top vertex at x,y) of w×h plus
 * left/right side faces of `depth` pixels, in the Isometric generator's
 * elevation style.
 */
export function drawIsoBlock(
  g: PIXI.Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  depth: number,
  base: number,
  edge: number = GALACTIC.goldDp,
  edgeAlpha = 0.5,
): void {
  // Side faces
  g.beginFill(shade(base, 0.55));
  g.drawPolygon([x - w / 2, y + h / 2, x, y + h, x, y + h + depth, x - w / 2, y + h / 2 + depth]);
  g.endFill();
  g.beginFill(shade(base, 0.72));
  g.drawPolygon([x + w / 2, y + h / 2, x, y + h, x, y + h + depth, x + w / 2, y + h / 2 + depth]);
  g.endFill();
  // Top
  g.beginFill(base);
  g.drawPolygon(diamondPoints(x, y, w, h));
  g.endFill();
  g.lineStyle(1, edge, edgeAlpha);
  g.drawPolygon(diamondPoints(x, y, w, h));
  g.lineStyle(0);
}

/** Manual dashed line (Pixi 6 has no native dash support). */
export function drawDashedLine(
  g: PIXI.Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  dash = 12,
  gap = 9,
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return;
  const ux = dx / len;
  const uy = dy / len;
  let dist = 0;
  while (dist < len) {
    const seg = Math.min(dash, len - dist);
    g.moveTo(x1 + ux * dist, y1 + uy * dist);
    g.lineTo(x1 + ux * (dist + seg), y1 + uy * (dist + seg));
    dist += dash + gap;
  }
}

/**
 * Dashed quadratic-bezier arc — reads as a light bridge bowing up over the
 * void between two iso platforms. `archFactor` is the rise (in world units)
 * at the curve's midpoint as a fraction of the chord length; 0.22 lands
 * "obviously 3D" without overshooting. Steps stay roughly dash-length-spaced
 * by walking parameter t in increments scaled to the chord (good enough at
 * these short bridges; not a true arc-length parameterization).
 */
export function drawDashedArc(
  g: PIXI.Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  dash = 12,
  gap = 9,
  archFactor = 0.22,
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const chord = Math.hypot(dx, dy);
  if (chord === 0) return;

  // Control point lifted "up" in screen space (negative y) relative to the
  // chord midpoint, so the curve reads as an iso-projected arc rather than
  // a flat dash.
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const lift = Math.max(40, chord * archFactor);
  const cx = mx;
  const cy = my - lift;

  const bezier = (t: number) => {
    const it = 1 - t;
    return {
      x: it * it * x1 + 2 * it * t * cx + t * t * x2,
      y: it * it * y1 + 2 * it * t * cy + t * t * y2,
    };
  };

  // Estimate the curve's arc length so dash spacing matches the requested
  // dash+gap world units regardless of how arched the bridge is.
  const SAMPLES = 64;
  let arcLen = 0;
  let prev = bezier(0);
  for (let i = 1; i <= SAMPLES; i++) {
    const p = bezier(i / SAMPLES);
    arcLen += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  if (arcLen === 0) return;

  const step = dash + gap;
  let dist = 0;
  // March along t, accumulating arc length; emit dash-then-gap segments.
  let tCursor = 0;
  let cursor = bezier(0);
  const advanceTo = (targetDist: number) => {
    // Use small fixed sub-steps to keep error bounded; cheap given dash sizes.
    const SUB = 6;
    while (tCursor < 1 && dist < targetDist) {
      const tNext = Math.min(1, tCursor + 1 / (SAMPLES * SUB));
      const next = bezier(tNext);
      dist += Math.hypot(next.x - cursor.x, next.y - cursor.y);
      cursor = next;
      tCursor = tNext;
    }
    return cursor;
  };

  while (dist < arcLen) {
    const start = { x: cursor.x, y: cursor.y };
    const end = advanceTo(dist + dash);
    g.moveTo(start.x, start.y);
    g.lineTo(end.x, end.y);
    advanceTo(dist + step);
  }
}

/**
 * Draw an upright SW-facing display screen (a billboard) anchored at its
 * bottom-left corner (ax,ay). Width W runs up-right along the iso wall axis,
 * height H rises straight up. Renders a gold bezel, an inset deep-panel
 * display, and `bars` horizontal "content rows" — used by desks, the big
 * wall display, and command consoles so screens read as real UI, not slabs.
 */
function drawWallScreen(g: PIXI.Graphics, ax: number, ay: number, W: number, H: number, bars = 3): void {
  const ux = 0.8944, uy = -0.4472;
  const BL = [ax, ay];
  const BR = [ax + W * ux, ay + W * uy];
  const TR = [BR[0], BR[1] - H];
  const TL = [ax, ay - H];
  // Gold bezel
  g.beginFill(GALACTIC.gold, 0.9);
  g.drawPolygon([BL[0], BL[1], BR[0], BR[1], TR[0], TR[1], TL[0], TL[1]]);
  g.endFill();
  // Inset deep-panel display area
  const cx = (BL[0] + BR[0] + TR[0] + TL[0]) / 4;
  const cy = (BL[1] + BR[1] + TR[1] + TL[1]) / 4;
  const ins = (p: number[]): number[] => [p[0] + (cx - p[0]) * 0.14, p[1] + (cy - p[1]) * 0.14];
  const iBL = ins(BL), iBR = ins(BR), iTR = ins(TR), iTL = ins(TL);
  g.beginFill(shade(GALACTIC.panel, 1.3));
  g.drawPolygon([iBL[0], iBL[1], iBR[0], iBR[1], iTR[0], iTR[1], iTL[0], iTL[1]]);
  g.endFill();
  // Content bars (top → down)
  const L = (p: number): number[] => [iBL[0] + (iTL[0] - iBL[0]) * p, iBL[1] + (iTL[1] - iBL[1]) * p];
  const R = (p: number): number[] => [iBR[0] + (iTR[0] - iBR[0]) * p, iBR[1] + (iTR[1] - iBR[1]) * p];
  const step = 0.5 / Math.max(1, bars - 1) + 0.06;
  for (let k = 0; k < bars; k++) {
    const c = 0.78 - k * step;
    const lo = Math.max(0.06, c - 0.06), hi = Math.min(0.94, c + 0.06);
    const llo = L(lo), lhi = L(hi), rlo = R(lo), rhi = R(hi);
    g.beginFill(k === 0 ? GALACTIC.goldLt : shade(GALACTIC.gold, 0.85), 0.85);
    g.drawPolygon([llo[0], llo[1], rlo[0], rlo[1], rhi[0], rhi[1], lhi[0], lhi[1]]);
    g.endFill();
  }
}

/** Small hex bolt (dark fill, gold edge) — corner fasteners on vault/crate. */
function drawHexBolt(g: PIXI.Graphics, cx: number, cy: number, r: number): void {
  const pts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + i * Math.PI / 3;
    pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.6);
  }
  g.beginFill(shade(GALACTIC.panel, 1.4));
  g.drawPolygon(pts);
  g.endFill();
  g.lineStyle(1, GALACTIC.gold, 0.7);
  g.drawPolygon(pts);
  g.lineStyle(0);
}

// ════════════════════════════════════════════════════════════════
// TEXTURE BAKERY
// ════════════════════════════════════════════════════════════════

export interface GalacticTextures {
  floorA: PIXI.RenderTexture;
  floorB: PIXI.RenderTexture;
  floorSeam: PIXI.RenderTexture;
  officePad: PIXI.RenderTexture;
  desk: PIXI.RenderTexture;
  bench: PIXI.RenderTexture;
  server: PIXI.RenderTexture;
  holoTable: PIXI.RenderTexture;
  bigDisplay: PIXI.RenderTexture;
  antenna: PIXI.RenderTexture;
  vaultDoor: PIXI.RenderTexture;
  crate: PIXI.RenderTexture;
  easel: PIXI.RenderTexture;
  crystal: PIXI.RenderTexture;
  telescope: PIXI.RenderTexture;
  consoleWide: PIXI.RenderTexture;
  commsBoard: PIXI.RenderTexture;
  micBooth: PIXI.RenderTexture;
  speaker: PIXI.RenderTexture;
  safe: PIXI.RenderTexture;
  ingots: PIXI.RenderTexture;
  roboArm: PIXI.RenderTexture;
  gateArch: PIXI.RenderTexture;
  pedestal: PIXI.RenderTexture;
  plantHolo: PIXI.RenderTexture;
  couch: PIXI.RenderTexture;
  /** Rest pod / bed — concourse furniture idle agents glide to and lie on. */
  bed: PIXI.RenderTexture;
  // ── Plugin-room props (iso/plugin-rooms.ts themes) ──
  /** Trading floor: wall board with candlesticks + scrolling ticker strip. */
  tickerBoard: PIXI.RenderTexture;
  /** Solana terminal: pillar with a floating, orbited coin. */
  coinPillar: PIXI.RenderTexture;
  /** Clinic: lab bench with flasks + microscope arm. */
  labBench: PIXI.RenderTexture;
  /** Media studio: tripod camera rig. */
  cameraRig: PIXI.RenderTexture;
  /** Media studio: softbox light on a stand. */
  softbox: PIXI.RenderTexture;
  /** Dojo: flat tatami mat. */
  dojoMat: PIXI.RenderTexture;
  /** Dojo: bonsai in a planter. */
  bonsai: PIXI.RenderTexture;
  /** Showroom: two-tier shelf rack with boxes. */
  shelfRack: PIXI.RenderTexture;
  /** Drawing studio: standing whiteboard with a sketch. */
  drawingBoard: PIXI.RenderTexture;
  /** Holo gallery: floating framed holo panel over a beam base. */
  holoFrame: PIXI.RenderTexture;
  /** Boardroom: long glass table with seats. */
  boardTable: PIXI.RenderTexture;
  /** Voice studio: wall screen showing a waveform. */
  waveformWall: PIXI.RenderTexture;
  /** Per-backend robot-ninja PNG sprites, loaded async from /agent-sprites/.
   *  Populated in-place as each PIXI.Texture.fromURL resolves, so holders of
   *  this object see new slots appear without re-fetching the registry. Empty
   *  until loadAgentSprites() completes (drawAgent falls back to pixel art). */
  agentSprite: Record<string, PIXI.Texture>;
}

// Baked RenderTextures live inside ONE WebGL context — they have no CPU-side
// source, so they can't be drawn by another renderer and can't be re-uploaded
// after a context loss. Several <agency-world-viz> engines (dashboard band,
// /mesh page, voice HUD backdrop) each own a renderer, so the bake cache is
// keyed per renderer. `baked` is the most recently baked/bound set, kept for
// the no-arg getGalacticTextures() callers.
const bakedByRenderer = new WeakMap<object, GalacticTextures>();
let baked: GalacticTextures | null = null;
let bakedOwner: object | null = null;

type AnyRenderer = PIXI.Renderer | PIXI.AbstractRenderer;

function bake(renderer: AnyRenderer, g: PIXI.Graphics, w: number, h: number): PIXI.RenderTexture {
  const texture = renderer.generateTexture(g, { region: new PIXI.Rectangle(0, 0, w, h) });
  g.destroy();
  // generateTexture can hand back a texture with a null baseTexture if the GL
  // context isn't ready yet (observed under high-DPR / cold contexts). Wrapping
  // such a texture in a Sprite/TilingSprite reads `baseTexture.valid` on null
  // and throws inside the ActivityMap constructor — blanking the ENTIRE world
  // map ("Failed to initialise: can't access property valid, t.baseTexture is
  // null"). Hand back a valid 1×1 fallback instead: it renders nothing this
  // frame but is destroyable like a real RenderTexture, and the world re-bakes
  // on the next resize/theme rebuild once the context is warm.
  if (!texture || !texture.baseTexture) {
    return PIXI.RenderTexture.create({ width: Math.max(1, w), height: Math.max(1, h) });
  }
  return texture;
}

function bakeFloorTile(renderer: AnyRenderer, fill: number, seamAlpha: number): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  g.beginFill(fill);
  g.drawPolygon(diamondPoints(TILE_W / 2, 0));
  g.endFill();
  g.lineStyle(1, GALACTIC.goldDp, seamAlpha);
  g.moveTo(TILE_W / 2, 0);
  g.lineTo(TILE_W, TILE_H / 2);
  g.moveTo(TILE_W / 2, 0);
  g.lineTo(0, TILE_H / 2);
  return bake(renderer, g, TILE_W, TILE_H);
}

/** 4×4-tile office floor pad with slab sides and gold hairline border. */
function bakeOfficePad(renderer: AnyRenderer): PIXI.RenderTexture {
  const cols = 4;
  const rows = 4;
  const w = ((cols + rows) * TILE_W) / 2; // 256
  const h = ((cols + rows) * TILE_H) / 2; // 128
  const depth = 8;
  const g = new PIXI.Graphics();
  const cx = w / 2;

  // Slab sides
  g.beginFill(0x080705);
  g.drawPolygon([0, h / 2, cx, h, cx, h + depth, 0, h / 2 + depth]);
  g.endFill();
  g.beginFill(0x0a0906);
  g.drawPolygon([w, h / 2, cx, h, cx, h + depth, w, h / 2 + depth]);
  g.endFill();

  // Floor tiles — lighter than the platform so pads read as rooms
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tx = cx + ((c - r) * TILE_W) / 2;
      const ty = ((c + r) * TILE_H) / 2;
      g.beginFill((c + r) % 2 === 0 ? shade(GALACTIC.floor, 2.4) : shade(GALACTIC.floorAlt, 2.2));
      g.drawPolygon(diamondPoints(tx, ty, TILE_W, TILE_H));
      g.endFill();
    }
  }

  // Faint directional grid hairlines across the surface
  g.lineStyle(1, GALACTIC.gold, 0.06);
  for (let r = 0; r <= rows; r++) {
    g.moveTo(cx + ((0 - r) * TILE_W) / 2, ((0 + r) * TILE_H) / 2);
    g.lineTo(cx + ((cols - r) * TILE_W) / 2, ((cols + r) * TILE_H) / 2);
  }
  for (let c = 0; c <= cols; c++) {
    g.moveTo(cx + ((c - 0) * TILE_W) / 2, ((c + 0) * TILE_H) / 2);
    g.lineTo(cx + ((c - rows) * TILE_W) / 2, ((c + rows) * TILE_H) / 2);
  }
  g.lineStyle(0);

  // Center floor decal (concentric gold rings)
  g.lineStyle(1.5, GALACTIC.gold, 0.35);
  g.drawEllipse(cx, h / 2, 24, 12);
  g.lineStyle(1, GALACTIC.goldLt, 0.4);
  g.drawEllipse(cx, h / 2, 13, 6.5);
  g.lineStyle(0);
  g.beginFill(GALACTIC.goldLt, 0.25);
  g.drawEllipse(cx, h / 2, 4, 2);
  g.endFill();

  // Gold hairline border
  g.lineStyle(1, GALACTIC.gold, 0.65);
  g.drawPolygon([cx, 0, w, h / 2, cx, h, 0, h / 2]);
  g.lineStyle(0);

  return bake(renderer, g, w, h + depth);
}

/** Dark console workstation: thin desktop on a leg + side cabinet, holo UI. */
function bakeDesk(renderer: AnyRenderer): PIXI.RenderTexture {
  const w = 96;
  const g = new PIXI.Graphics();
  // Left leg + right side cabinet beneath the desktop (drawn first so the
  // desktop slab caps their tops).
  drawIsoBlock(g, 26, 56, 10, 5, 30, shade(GALACTIC.panel, 1.7), GALACTIC.goldDp, 0.5);
  drawIsoBlock(g, 66, 50, 30, 15, 26, shade(GALACTIC.panel, 2.2), GALACTIC.gold, 0.7);
  // Drawer pulls (two gold seams on the cabinet's front-right face)
  g.lineStyle(1, GALACTIC.gold, 0.7);
  g.moveTo(81, 67.5); g.lineTo(66, 75);
  g.moveTo(81, 74.5); g.lineTo(66, 82);
  g.lineStyle(0);
  // Desktop slab (thin)
  drawIsoBlock(g, 48, 22, 96, 48, 8, shade(GALACTIC.panel, 2.6), GALACTIC.gold, 0.8);
  // Keyboard sliver on the front of the desktop
  g.beginFill(shade(GALACTIC.panel, 1.9));
  g.drawPolygon([34, 52, 60, 39, 70, 44, 44, 57]);
  g.endFill();
  g.lineStyle(1, GALACTIC.goldDp, 0.4);
  g.drawPolygon([34, 52, 60, 39, 70, 44, 44, 57]);
  g.lineStyle(0);
  g.beginFill(GALACTIC.goldLt, 0.5);
  for (let row = 0; row < 2; row++)
    for (let col = 0; col < 4; col++)
      g.drawRect(40 + col * 6 - row * 3, 49 - col * 3 + row * 4, 2, 1.5);
  g.endFill();
  // Coffee mug on the back-left corner
  g.beginFill(shade(GALACTIC.glass, 1.4));
  g.drawRect(16, 24, 8, 6);
  g.drawEllipse(20, 30, 4, 2);
  g.endFill();
  g.beginFill(GALACTIC.goldLt, 0.85);
  g.drawEllipse(20, 24, 4, 1.6);
  g.endFill();
  g.lineStyle(1, GALACTIC.gold, 0.7);
  g.arc(25, 27, 3, -1.2, 1.2);
  g.lineStyle(0);
  // Holo screen standing on the rear of the desktop
  drawWallScreen(g, 26, 30, 34, 13, 3);
  return bake(renderer, g, w, 92);
}

/** Glass bench (idle seat): backrest + seat slab + front legs. */
function bakeBench(renderer: AnyRenderer): PIXI.RenderTexture {
  const w = 56;
  const h = 28;
  const g = new PIXI.Graphics();
  // Backrest along the rear edge
  drawIsoBlock(g, 36, 0, 34, 17, 14, shade(GALACTIC.glass, 1.5), GALACTIC.goldDp, 0.7);
  // Front legs (drawn before the seat so the seat caps them)
  drawIsoBlock(g, 14, 28, 6, 3, 9, shade(GALACTIC.panel, 1.6), GALACTIC.goldDp, 0.4);
  drawIsoBlock(g, 42, 28, 6, 3, 9, shade(GALACTIC.panel, 1.6), GALACTIC.goldDp, 0.4);
  // Seat slab
  drawIsoBlock(g, 28, 8, 52, 26, 6, shade(GALACTIC.glass, 2.0), GALACTIC.gold, 0.7);
  // Soft cushion highlight along the seat's front edges
  g.lineStyle(1.5, shade(GALACTIC.glass, 2.6), 0.7);
  g.moveTo(2, 21); g.lineTo(28, 34); g.lineTo(54, 21);
  g.lineStyle(0);
  return bake(renderer, g, w, h + 12);
}

/** Server rack: stacked rack-units with seams, status LEDs, vents, a base plate. */
function bakeServer(renderer: AnyRenderer): PIXI.RenderTexture {
  const w = 36;
  const h = 18;
  const depth = 46;
  const g = new PIXI.Graphics();
  drawIsoBlock(g, w / 2, 0, w, h, depth, shade(GALACTIC.panel, 2.3), GALACTIC.goldDp, 0.8);
  // Front-left face: F(s,d) = (18s, 9+9s + d), s across [0,1], d down [0,46].
  const F = (s: number, d: number): [number, number] => [18 * s, 9 + 9 * s + d];
  const LED = [GALACTIC.ok, GALACTIC.gold, GALACTIC.info];
  for (let u = 0; u < 4; u++) {
    const dTop = 3 + u * 10.5;
    // Rack-unit seam
    g.lineStyle(1, GALACTIC.gold, 0.6);
    const s0 = F(0, dTop), s1 = F(1, dTop);
    g.moveTo(s0[0], s0[1]); g.lineTo(s1[0], s1[1]);
    g.lineStyle(0);
    // Status LEDs
    [0.18, 0.42, 0.66].forEach((s, i) => {
      const p = F(s, dTop + 2.5);
      g.beginFill(LED[i % 3], 0.95);
      g.drawRect(p[0] - 1, p[1] - 1, 2, 2);
      g.endFill();
    });
    // Ventilation slits
    g.lineStyle(1, shade(GALACTIC.panel, 1.2), 0.8);
    [5, 6.8, 8.6].forEach((dd) => {
      const a = F(0.12, dTop + dd), b = F(0.82, dTop + dd);
      g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
    });
    g.lineStyle(0);
  }
  // Base plinth plate at the foot
  g.beginFill(shade(GALACTIC.panel, 1.6));
  g.drawPolygon(diamondPoints(18, 46, 36, 17));
  g.endFill();
  g.lineStyle(1, GALACTIC.goldDp, 0.6);
  g.drawPolygon(diamondPoints(18, 46, 36, 17));
  g.lineStyle(0);
  return bake(renderer, g, w, h + depth);
}

/** Round holo-projector table: pedestal stem, ellipse top, floating hologram. */
function bakeHoloTable(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  // Base ring on the floor
  g.beginFill(shade(GALACTIC.panel, 1.6));
  g.drawEllipse(36, 66, 16, 7);
  g.endFill();
  g.lineStyle(1, GALACTIC.goldDp, 0.6);
  g.drawEllipse(36, 66, 16, 7);
  g.lineStyle(0);
  // Central pedestal stem
  g.beginFill(shade(GALACTIC.panel, 2.2));
  g.drawPolygon([31, 64, 41, 64, 39, 44, 33, 44]);
  g.endFill();
  // Round tabletop (iso ellipse) with a little thickness
  g.beginFill(shade(GALACTIC.glass, 1.3));
  g.drawEllipse(36, 46, 32, 15);
  g.endFill();
  g.beginFill(shade(GALACTIC.glass, 1.9));
  g.drawEllipse(36, 42, 32, 15);
  g.endFill();
  g.lineStyle(1, GALACTIC.gold, 0.7);
  g.drawEllipse(36, 42, 32, 15);
  g.lineStyle(0);
  // Floating hologram: soft glow + stacked translucent quads
  g.beginFill(GALACTIC.goldLt, 0.1);
  g.drawEllipse(36, 24, 22, 16);
  g.endFill();
  g.beginFill(GALACTIC.gold, 0.22);
  g.drawPolygon([36, 12, 50, 20, 36, 28, 22, 20]);
  g.endFill();
  g.lineStyle(1, GALACTIC.goldLt, 0.6);
  g.drawPolygon([36, 12, 50, 20, 36, 28, 22, 20]);
  g.lineStyle(0);
  g.beginFill(GALACTIC.goldLt, 0.3);
  g.drawPolygon([36, 22, 46, 27, 36, 32, 26, 27]);
  g.endFill();
  return bake(renderer, g, 72, 76);
}

/** Wide wall display: bezel + dashboard screen + corner logo + wall mount. */
function bakeBigDisplay(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  drawIsoBlock(g, 60, 4, 120, 28, 52, shade(GALACTIC.panel, 2.0), GALACTIC.gold, 0.8);
  // Wall-mount support strut peeking at the bottom
  g.beginFill(shade(GALACTIC.panel, 1.4));
  g.drawPolygon([53, 74, 63, 80, 63, 84, 53, 80]);
  g.endFill();
  // Bezel (gold frame) on the front-left face
  g.beginFill(GALACTIC.gold, 0.85);
  g.drawPolygon([8, 21, 56, 41, 56, 79, 8, 59]);
  g.endFill();
  // Inner display area (deep panel)
  g.beginFill(shade(GALACTIC.panel, 1.2));
  g.drawPolygon([12, 25, 52, 41.5, 52, 73, 12, 56]);
  g.endFill();
  // Dashboard content bars
  g.beginFill(GALACTIC.goldLt, 0.85);
  g.drawPolygon([16, 30, 44, 41.5, 44, 46, 16, 35]);
  g.endFill();
  g.beginFill(shade(GALACTIC.gold, 0.9), 0.8);
  g.drawPolygon([16, 40, 48, 53, 48, 57, 16, 45]);
  g.drawPolygon([16, 49, 38, 58, 38, 62, 16, 55]);
  g.endFill();
  // INFINIBOT corner indicator
  g.beginFill(GALACTIC.goldLt, 0.95);
  g.drawCircle(48, 69, 2);
  g.endFill();
  return bake(renderer, g, 120, 96);
}

/** Comms antenna: tripod base, mast, parabolic dish, feed-horn beacon. */
function bakeAntenna(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  // Tripod base struts
  g.lineStyle(2, shade(GALACTIC.panel, 2.4), 1);
  g.moveTo(24, 40); g.lineTo(12, 84);
  g.moveTo(24, 40); g.lineTo(36, 84);
  g.moveTo(24, 40); g.lineTo(24, 86);
  g.lineStyle(0);
  // Foot pads
  g.beginFill(shade(GALACTIC.panel, 1.6));
  for (const fx of [12, 24, 36]) g.drawEllipse(fx, fx === 24 ? 86 : 84, 3, 1.5);
  g.endFill();
  // Mast
  g.lineStyle(2, shade(GALACTIC.panel, 3.0), 1);
  g.moveTo(24, 40); g.lineTo(24, 24);
  g.lineStyle(0);
  // Parabolic dish (gold), tilted up
  g.beginFill(GALACTIC.gold, 0.18);
  g.drawEllipse(24, 20, 16, 8);
  g.endFill();
  g.lineStyle(2, GALACTIC.goldLt, 0.9);
  g.arc(24, 20, 15, Math.PI * 0.15, Math.PI * 0.85);
  g.lineStyle(1, GALACTIC.gold, 0.7);
  g.drawEllipse(24, 20, 16, 8);
  g.lineStyle(0);
  // Feed horn + beacon
  g.lineStyle(1, GALACTIC.goldDp, 0.7);
  g.moveTo(24, 20); g.lineTo(24, 12);
  g.lineStyle(0);
  g.beginFill(GALACTIC.goldLt, 0.3);
  g.drawCircle(24, 11, 5);
  g.endFill();
  g.beginFill(GALACTIC.goldLt, 0.95);
  g.drawCircle(24, 11, 2.5);
  g.endFill();
  return bake(renderer, g, 48, 88);
}

/** Massive vault door: inset frame, hex bolts, concentric lock wheel + spokes. */
function bakeVaultDoor(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  drawIsoBlock(g, 55, 4, 110, 55, 32, shade(GALACTIC.panel, 2.4), GALACTIC.gold, 0.9);
  // Inset frame along the front-right face perimeter
  g.lineStyle(1, GALACTIC.gold, 0.5);
  g.drawPolygon([102, 37, 60, 58, 60, 84, 102, 63]);
  g.lineStyle(0);
  // Hex bolts at the inset frame corners
  for (const [bx, by] of [[98, 41], [64, 58], [64, 80], [98, 62]] as const) {
    drawHexBolt(g, bx, by, 3.4);
  }
  // Concentric vault wheel on the face
  const cx = 81, cy = 60;
  g.lineStyle(2, GALACTIC.goldLt, 0.9); g.drawCircle(cx, cy, 12);
  g.lineStyle(1.5, GALACTIC.gold, 0.8); g.drawCircle(cx, cy, 8);
  g.lineStyle(1, GALACTIC.goldLt, 0.7); g.drawCircle(cx, cy, 4);
  // Spokes (flattened for the iso face)
  g.lineStyle(2, GALACTIC.gold, 0.85);
  for (const a of [0, Math.PI / 3, (2 * Math.PI) / 3]) {
    g.moveTo(cx - Math.cos(a) * 12, cy - Math.sin(a) * 7);
    g.lineTo(cx + Math.cos(a) * 12, cy + Math.sin(a) * 7);
  }
  g.lineStyle(0);
  g.beginFill(GALACTIC.goldLt, 0.9); g.drawCircle(cx, cy, 2); g.endFill();
  return bake(renderer, g, 110, 96);
}

/** Cargo crate: cross-braced faces, corner rivets, and a label panel. */
function bakeCrate(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  drawIsoBlock(g, 20, 2, 40, 20, 15, shade(GALACTIC.glass, 1.7), GALACTIC.goldDp, 0.7);
  // Cross-braces (gold X) on the two front faces
  g.lineStyle(1.5, GALACTIC.gold, 0.7);
  g.moveTo(0, 12); g.lineTo(20, 37);
  g.moveTo(20, 22); g.lineTo(0, 27);
  g.moveTo(40, 12); g.lineTo(20, 37);
  g.moveTo(20, 22); g.lineTo(40, 27);
  g.lineStyle(0);
  // Corner rivets
  g.beginFill(GALACTIC.goldLt, 0.85);
  for (const [rx, ry] of [[2, 13], [38, 13], [20, 35], [20, 23]] as const) g.drawCircle(rx, ry, 1.2);
  g.endFill();
  // Label panel on the top diamond
  g.beginFill(shade(GALACTIC.panel, 2.4));
  g.drawPolygon([8, 6, 18, 11, 14, 13, 4, 8]);
  g.endFill();
  g.lineStyle(0.8, GALACTIC.gold, 0.6);
  g.drawPolygon([8, 6, 18, 11, 14, 13, 4, 8]);
  g.lineStyle(0);
  return bake(renderer, g, 40, 40);
}

/** Artist easel: tripod stand, gold-framed canvas, paint splash at the foot. */
function bakeEasel(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  // Tripod legs
  g.lineStyle(2, shade(GALACTIC.panel, 2.6), 1);
  g.moveTo(10, 24); g.lineTo(4, 47);
  g.moveTo(30, 22); g.lineTo(36, 47);
  g.moveTo(20, 26); g.lineTo(20, 46);
  g.lineStyle(0);
  // Cross support
  g.lineStyle(1.5, shade(GALACTIC.panel, 2.2), 0.9);
  g.moveTo(8, 34); g.lineTo(32, 34);
  g.lineStyle(0);
  // Canvas (gold-framed)
  g.beginFill(shade(GALACTIC.panel, 2.3));
  g.drawPolygon([7, 30, 33, 18, 33, -6, 7, 6]);
  g.endFill();
  g.lineStyle(1.5, GALACTIC.gold, 0.9);
  g.drawPolygon([7, 30, 33, 18, 33, -6, 7, 6]);
  g.lineStyle(0);
  // Painted highlight + a splash of color inside
  g.beginFill(GALACTIC.goldLt, 0.28);
  g.drawPolygon([11, 26, 29, 17, 29, 0, 11, 9]);
  g.endFill();
  g.beginFill(GALACTIC.gold, 0.5);
  g.drawPolygon([13, 18, 22, 14, 24, 20, 15, 24]);
  g.endFill();
  // Paint splash dots at the base
  for (const [sx, sy, sr] of [[6, 45, 1.6], [12, 46, 1.2], [34, 45, 1.4]] as const) {
    g.beginFill(GALACTIC.goldLt, 0.7);
    g.drawCircle(sx, sy, sr);
    g.endFill();
  }
  return bake(renderer, g, 42, 48);
}

/** Data-crystal cluster: faceted primary shard + side shards over a glow base. */
function bakeCrystal(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  // Soft inner glow beneath
  g.beginFill(GALACTIC.goldLt, 0.16);
  g.drawEllipse(16, 34, 14, 9);
  g.endFill();
  // Base
  g.beginFill(shade(GALACTIC.panel, 1.8));
  g.drawEllipse(16, 38, 11, 5);
  g.endFill();
  g.lineStyle(1, GALACTIC.goldDp, 0.6);
  g.drawEllipse(16, 38, 11, 5);
  g.lineStyle(0);
  // Smaller side shards
  g.beginFill(shade(GALACTIC.gold, 0.7), 0.9);
  g.drawPolygon([8, 38, 11, 22, 14, 38]);
  g.drawPolygon([24, 38, 22, 26, 18, 38]);
  g.endFill();
  // Primary shard (faceted: darker outer, lighter right facet, glint)
  g.beginFill(GALACTIC.gold, 0.92);
  g.drawPolygon([16, 2, 22, 16, 16, 36, 10, 16]);
  g.endFill();
  g.beginFill(GALACTIC.goldLt, 0.95);
  g.drawPolygon([16, 2, 22, 16, 16, 36]);
  g.endFill();
  g.beginFill(0xffffff, 0.4);
  g.drawPolygon([16, 6, 19, 16, 16, 26, 14, 16]);
  g.endFill();
  return bake(renderer, g, 32, 44);
}

/** Observatory telescope: tripod + angled tube with a glowing lens. */
function bakeTelescope(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  // Tripod
  g.lineStyle(2, shade(GALACTIC.panel, 2.6), 1);
  g.moveTo(22, 36); g.lineTo(12, 56);
  g.moveTo(22, 36); g.lineTo(32, 56);
  g.moveTo(22, 36); g.lineTo(22, 58);
  g.lineStyle(0);
  // Tube (angled up-right)
  g.beginFill(shade(GALACTIC.panel, 2.4));
  g.drawPolygon([14, 38, 40, 12, 46, 17, 20, 43]);
  g.endFill();
  g.lineStyle(1, GALACTIC.gold, 0.85);
  g.drawPolygon([14, 38, 40, 12, 46, 17, 20, 43]);
  g.lineStyle(0);
  // Lens glow
  g.beginFill(GALACTIC.goldLt, 0.95);
  g.drawCircle(44, 13, 3.5);
  g.endFill();
  g.beginFill(GALACTIC.goldLt, 0.3);
  g.drawCircle(44, 13, 7);
  g.endFill();
  return bake(renderer, g, 56, 62);
}

/** Wide command console: rear monitors, lit control strip, a chair peeking behind. */
function bakeConsoleWide(renderer: AnyRenderer): PIXI.RenderTexture {
  const w = 110;
  const g = new PIXI.Graphics();
  // Command chair backrest peeking behind the console
  drawIsoBlock(g, 70, 2, 20, 10, 20, shade(GALACTIC.glass, 1.5), GALACTIC.goldDp, 0.6);
  // Desk
  drawIsoBlock(g, w / 2, 16, w, 34, 18, shade(GALACTIC.panel, 2.5), GALACTIC.gold, 0.8);
  // Rear monitors (standing screens)
  drawWallScreen(g, 18, 30, 22, 12, 2);
  drawWallScreen(g, 46, 36, 22, 12, 2);
  // Front control strip
  g.beginFill(shade(GALACTIC.panel, 1.6));
  g.drawPolygon([24, 34, 86, 34, 80, 26, 30, 26]);
  g.endFill();
  g.lineStyle(1, GALACTIC.goldDp, 0.5);
  g.drawPolygon([24, 34, 86, 34, 80, 26, 30, 26]);
  g.lineStyle(0);
  // Rows of LED buttons along the strip
  const LED = [GALACTIC.goldLt, GALACTIC.ok, GALACTIC.info];
  for (let i = 0; i < 8; i++) {
    g.beginFill(LED[i % 3], 0.9);
    g.drawRect(33 + i * 6.5, 29, 3, 2);
    g.endFill();
  }
  return bake(renderer, g, w, 70);
}

/** Comms patch board: wide flat wall with a blinking light grid. */
function bakeCommsBoard(renderer: AnyRenderer): PIXI.RenderTexture {
  const w = 90;
  const h = 18;
  const depth = 44;
  const g = new PIXI.Graphics();
  drawIsoBlock(g, w / 2, 2, w, h, depth, shade(GALACTIC.panel, 2.1), GALACTIC.gold, 0.8);
  // Light grid on the front-left face
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 5; col++) {
      const lit = (row * 5 + col) % 3 !== 1;
      g.beginFill(lit ? GALACTIC.goldLt : shade(GALACTIC.panel, 3), lit ? 0.95 : 0.8);
      const bx = 8 + col * 7.5;
      const by = 16 + col * 3.7 + row * 9;
      g.drawRect(bx, by, 4, 3);
      g.endFill();
    }
  }
  return bake(renderer, g, w, 82);
}

/** Broadcast mic stand with pop filter. */
function bakeMicBooth(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  // Base
  g.beginFill(shade(GALACTIC.panel, 2.2));
  g.drawEllipse(16, 52, 10, 4.5);
  g.endFill();
  // Pole
  g.lineStyle(2, shade(GALACTIC.panel, 2.8), 1);
  g.moveTo(16, 52); g.lineTo(16, 16);
  g.lineStyle(0);
  // Mic head
  g.beginFill(GALACTIC.goldLt, 0.95);
  g.drawRoundedRect(11, 6, 10, 14, 5);
  g.endFill();
  g.lineStyle(1, GALACTIC.goldDp, 0.8);
  g.drawRoundedRect(11, 6, 10, 14, 5);
  // Pop filter arc
  g.lineStyle(1.5, GALACTIC.gold, 0.6);
  g.arc(16, 13, 12, -Math.PI * 0.8, -Math.PI * 0.2);
  g.lineStyle(0);
  return bake(renderer, g, 32, 60);
}

/** Studio speaker stack with glowing cones. */
function bakeSpeaker(renderer: AnyRenderer): PIXI.RenderTexture {
  const w = 36;
  const h = 18;
  const depth = 38;
  const g = new PIXI.Graphics();
  drawIsoBlock(g, w / 2, 2, w, h, depth, shade(GALACTIC.panel, 2.0), GALACTIC.goldDp, 0.8);
  // Cones on the front-left face
  for (const [cy, r] of [[26, 6], [42, 4.5]] as const) {
    g.lineStyle(1.5, GALACTIC.goldLt, 0.9);
    g.drawEllipse(11, cy, r, r * 0.8);
    g.lineStyle(0);
    g.beginFill(GALACTIC.goldLt, 0.5);
    g.drawEllipse(11, cy, r * 0.4, r * 0.32);
    g.endFill();
  }
  return bake(renderer, g, w, 64);
}

/** Vault safe with a dial. */
function bakeSafe(renderer: AnyRenderer): PIXI.RenderTexture {
  const w = 44;
  const h = 22;
  const depth = 26;
  const g = new PIXI.Graphics();
  drawIsoBlock(g, w / 2, 2, w, h, depth, shade(GALACTIC.panel, 2.6), GALACTIC.gold, 0.85);
  // Dial on the front-right face
  g.lineStyle(1.5, GALACTIC.goldLt, 0.9);
  g.drawCircle(31, 30, 5);
  g.lineStyle(1, GALACTIC.goldLt, 0.7);
  g.moveTo(31, 26); g.lineTo(31, 34);
  g.lineStyle(0);
  g.beginFill(GALACTIC.goldLt, 0.9);
  g.drawCircle(31, 30, 1.5);
  g.endFill();
  return bake(renderer, g, w, 52);
}

/** Stack of glowing ingots. */
function bakeIngots(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  const bar = (x: number, y: number) => {
    g.beginFill(GALACTIC.gold, 0.95);
    g.drawPolygon([x, y + 5, x + 9, y, x + 24, y + 7, x + 15, y + 12]);
    g.endFill();
    g.beginFill(GALACTIC.goldLt, 0.85);
    g.drawPolygon([x, y + 5, x + 9, y, x + 11, y + 1, x + 2, y + 6]);
    g.endFill();
    g.lineStyle(0.8, GALACTIC.goldDp, 0.9);
    g.drawPolygon([x, y + 5, x + 9, y, x + 24, y + 7, x + 15, y + 12]);
    g.lineStyle(0);
  };
  bar(2, 18);
  bar(20, 20);
  bar(11, 8);
  return bake(renderer, g, 48, 34);
}

/** Engineering robot arm: base, two segments, glowing claw. */
function bakeRoboArm(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  // Base
  drawIsoBlock(g, 24, 50, 30, 15, 10, shade(GALACTIC.panel, 2.3), GALACTIC.goldDp, 0.8);
  // Segments
  g.lineStyle(4, shade(GALACTIC.panel, 3.0), 1);
  g.moveTo(24, 54); g.lineTo(14, 30);
  g.moveTo(14, 30); g.lineTo(34, 14);
  g.lineStyle(0);
  // Joints
  for (const [jx, jy] of [[24, 54], [14, 30], [34, 14]] as const) {
    g.beginFill(GALACTIC.gold, 0.95);
    g.drawCircle(jx, jy, 3.5);
    g.endFill();
  }
  // Claw
  g.lineStyle(2, GALACTIC.goldLt, 0.95);
  g.moveTo(34, 14); g.lineTo(42, 10);
  g.moveTo(34, 14); g.lineTo(41, 19);
  g.lineStyle(0);
  g.beginFill(GALACTIC.goldLt, 0.35);
  g.drawCircle(42, 14, 6);
  g.endFill();
  return bake(renderer, g, 52, 76);
}

/** Security gate arch with a scan field, oriented along the SE axis. */
function bakeGateArch(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  const ax = 10, ay = 36;   // left pillar base
  const bx = 46, by = 54;   // right pillar base (SE direction)
  const ph = 34;            // pillar height
  // Scan field between pillars
  g.beginFill(GALACTIC.goldLt, 0.16);
  g.drawPolygon([ax, ay, bx, by, bx, by - ph + 4, ax, ay - ph + 4]);
  g.endFill();
  // Pillars
  for (const [px, py] of [[ax, ay], [bx, by]] as const) {
    g.beginFill(shade(GALACTIC.panel, 2.5));
    g.drawRect(px - 3, py - ph, 6, ph);
    g.endFill();
    g.lineStyle(1, GALACTIC.gold, 0.85);
    g.drawRect(px - 3, py - ph, 6, ph);
    g.lineStyle(0);
    g.beginFill(GALACTIC.goldLt, 0.95);
    g.drawRect(px - 2, py - ph - 3, 4, 3);
    g.endFill();
  }
  // Top beam
  g.lineStyle(3, GALACTIC.gold, 0.9);
  g.moveTo(ax, ay - ph);
  g.lineTo(bx, by - ph);
  g.lineStyle(0);
  return bake(renderer, g, 56, 60);
}

/** Two-tier display pedestal with a floating mini-crystal artifact. */
function bakePedestal(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  // Wide base tier
  drawIsoBlock(g, 18, 35, 30, 15, 13, shade(GALACTIC.glass, 1.6), GALACTIC.gold, 0.7);
  // Narrow top tier
  drawIsoBlock(g, 18, 24, 20, 10, 12, shade(GALACTIC.glass, 1.9), GALACTIC.gold, 0.8);
  // Gold trim ring on the top edge
  g.lineStyle(1.5, GALACTIC.goldLt, 0.8);
  g.drawPolygon(diamondPoints(18, 24, 20, 10));
  g.lineStyle(0);
  // Floating artifact (mini crystal) with glow
  g.beginFill(GALACTIC.goldLt, 0.2);
  g.drawEllipse(18, 12, 8, 8);
  g.endFill();
  g.beginFill(GALACTIC.gold, 0.95);
  g.drawPolygon([18, 2, 24, 11, 18, 20, 12, 11]);
  g.endFill();
  g.beginFill(0xffffff, 0.45);
  g.drawPolygon([18, 5, 21, 11, 18, 17, 15, 11]);
  g.endFill();
  return bake(renderer, g, 36, 64);
}

/** Holographic plant: matte planter with a glowing stack of holo leaves above. */
function bakePlantHolo(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  // Planter pot with a gold rim
  drawIsoBlock(g, 18, 34, 22, 11, 9, shade(GALACTIC.panel, 2.2), GALACTIC.gold, 0.7);
  g.lineStyle(1.5, GALACTIC.goldLt, 0.8);
  g.drawPolygon(diamondPoints(18, 34, 22, 11));
  g.lineStyle(0);
  // Holo glow halo
  g.beginFill(GALACTIC.ok, 0.1);
  g.drawEllipse(18, 22, 13, 18);
  g.endFill();
  // Stacked translucent leaves (green→gold)
  const leaf = mixColor(GALACTIC.ok, GALACTIC.goldLt, 0.5);
  g.beginFill(GALACTIC.ok, 0.4);
  g.drawPolygon([18, 40, 8, 28, 12, 20, 18, 32]);
  g.drawPolygon([18, 40, 28, 26, 25, 18, 18, 32]);
  g.endFill();
  g.lineStyle(1, GALACTIC.goldLt, 0.5);
  g.drawPolygon([18, 40, 8, 28, 12, 20, 18, 32]);
  g.drawPolygon([18, 40, 28, 26, 25, 18, 18, 32]);
  g.lineStyle(0);
  g.beginFill(leaf, 0.45);
  g.drawPolygon([18, 36, 14, 14, 18, 4, 22, 14]);
  g.endFill();
  g.lineStyle(1, GALACTIC.goldLt, 0.6);
  g.drawPolygon([18, 36, 14, 14, 18, 4, 22, 14]);
  g.lineStyle(0);
  return bake(renderer, g, 36, 54);
}

/** Executive couch: armrests, 3 back cushions, and 3 seat cushions. */
function bakeCouch(renderer: AnyRenderer): PIXI.RenderTexture {
  const w = 76;
  const h = 38;
  const g = new PIXI.Graphics();
  // Back cushions (3) along the rear edge, tiering up to the right
  for (let i = 0; i < 3; i++) {
    drawIsoBlock(g, 34 + i * 16, 14 - i * 8, 18, 9, 20,
      shade(GALACTIC.glass, 1.5), GALACTIC.goldDp, 0.5);
  }
  // Left armrest (drawn behind the seat)
  drawIsoBlock(g, 8, 18, 16, 10, 18, shade(GALACTIC.glass, 1.7), GALACTIC.gold, 0.6);
  // Seat base
  drawIsoBlock(g, w / 2, 16, w, h, 10, shade(GALACTIC.glass, 1.8), GALACTIC.gold, 0.7);
  // Seat cushions (3) across the seat
  for (let i = 0; i < 3; i++) {
    drawIsoBlock(g, 18 + i * 16, 24 + i * 8, 20, 10, 4,
      shade(GALACTIC.glass, 2.3), GALACTIC.goldDp, 0.5);
  }
  // Right armrest (front, drawn last)
  drawIsoBlock(g, 70, 34, 16, 10, 18, shade(GALACTIC.glass, 1.7), GALACTIC.gold, 0.6);
  return bake(renderer, g, w + 14, 70);
}

/** Rest pod / bed (concourse): low frame, mattress slab, raised pillow, blanket seam. */
function bakeBed(renderer: AnyRenderer): PIXI.RenderTexture {
  const w = 66;
  const h = 36;
  const g = new PIXI.Graphics();
  // Frame / base plinth
  drawIsoBlock(g, 33, 8, 60, 30, 8, shade(GALACTIC.panel, 1.2), GALACTIC.goldDp, 0.55);
  // Mattress slab
  drawIsoBlock(g, 33, 5, 54, 26, 6, shade(GALACTIC.glass, 1.7), GALACTIC.gold, 0.6);
  // Raised pillow at the rear-left head of the bed
  drawIsoBlock(g, 18, 1, 18, 12, 5, shade(GALACTIC.glass, 2.4), GALACTIC.goldLt, 0.7);
  // Blanket seam highlight across the foot of the mattress
  g.lineStyle(1.5, shade(GALACTIC.glass, 2.2), 0.6);
  g.moveTo(10, 19); g.lineTo(33, 31); g.lineTo(56, 19);
  g.lineStyle(0);
  return bake(renderer, g, w, h + 12);
}

// ════════════════════════════════════════════════════════════════
// PLUGIN-ROOM PROPS — themed furniture for the Plugin District
// (iso/plugin-rooms.ts). Same palette + iso conventions as the core
// props above: floor contact point = bottom centre of the texture.
// ════════════════════════════════════════════════════════════════

/** Trading floor wall board: candlestick columns + a ticker strip. */
function bakeTickerBoard(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  drawIsoBlock(g, 64, 4, 128, 30, 54, shade(GALACTIC.panel, 2.0), GALACTIC.gold, 0.8);
  // Support struts
  g.beginFill(shade(GALACTIC.panel, 1.4));
  g.drawPolygon([20, 62, 30, 67, 30, 86, 20, 81]);
  g.drawPolygon([98, 78, 108, 73, 108, 92, 98, 97]);
  g.endFill();
  // Bezel on the front-left face
  g.beginFill(GALACTIC.gold, 0.85);
  g.drawPolygon([6, 22, 60, 44, 60, 84, 6, 62]);
  g.endFill();
  g.beginFill(shade(GALACTIC.panel, 1.15));
  g.drawPolygon([10, 26, 56, 44.5, 56, 79, 10, 60]);
  g.endFill();
  // Candlesticks: x across the face, height along the face's vertical
  const yAt = (x: number, p: number) => 26 + (x - 10) * (18.5 / 46) + p * 32; // p 0..1 top→bottom inside panel
  const heights = [0.55, 0.35, 0.7, 0.45, 0.8, 0.3, 0.6, 0.5];
  heights.forEach((h, i) => {
    const x = 14 + i * 5.4;
    const up = i % 3 !== 1;
    const c = up ? GALACTIC.ok : GALACTIC.err;
    const top = 0.15 + (1 - h) * 0.45;
    g.lineStyle(1, c, 0.9);
    g.moveTo(x + 1.2, yAt(x, top - 0.08)); g.lineTo(x + 1.2, yAt(x, top + h * 0.5 + 0.06));
    g.lineStyle(0);
    g.beginFill(c, 0.95);
    g.drawRect(x, yAt(x, top), 2.4, Math.max(2, h * 14));
    g.endFill();
  });
  // Trend line
  g.lineStyle(1.2, GALACTIC.goldLt, 0.9);
  g.moveTo(13, yAt(13, 0.6)); g.lineTo(24, yAt(24, 0.5)); g.lineTo(34, yAt(34, 0.58)); g.lineTo(45, yAt(45, 0.3)); g.lineTo(54, yAt(54, 0.22));
  g.lineStyle(0);
  // Ticker strip along the bottom of the panel
  g.beginFill(shade(GALACTIC.panel, 1.6));
  g.drawPolygon([10, 54, 56, 72.5, 56, 79, 10, 60.5]);
  g.endFill();
  for (let i = 0; i < 7; i++) {
    const x = 12 + i * 6.2;
    g.beginFill(i % 2 ? GALACTIC.goldLt : GALACTIC.gold, 0.85);
    g.drawRect(x, 56 + (x - 10) * 0.4, 3.6, 1.6);
    g.endFill();
  }
  return bake(renderer, g, 128, 100);
}

/** Solana terminal pillar: tiered plinth with an orbited floating coin. */
function bakeCoinPillar(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  drawIsoBlock(g, 20, 48, 34, 17, 12, shade(GALACTIC.glass, 1.5), GALACTIC.gold, 0.7);
  drawIsoBlock(g, 20, 34, 18, 9, 16, shade(GALACTIC.glass, 1.9), GALACTIC.gold, 0.8);
  // Orbit ring (iso ellipse) around the coin
  g.lineStyle(1, GALACTIC.goldLt, 0.55);
  g.drawEllipse(20, 20, 16, 6);
  g.lineStyle(0);
  // Coin: gold disc with an inner ring + slot glyph
  g.beginFill(GALACTIC.goldLt, 0.22);
  g.drawCircle(20, 18, 12);
  g.endFill();
  g.beginFill(GALACTIC.gold, 0.98);
  g.drawCircle(20, 18, 8.5);
  g.endFill();
  g.lineStyle(1.2, GALACTIC.goldDp, 0.9);
  g.drawCircle(20, 18, 6);
  g.lineStyle(0);
  g.beginFill(0xffffff, 0.5);
  g.drawRect(16.5, 15.5, 7, 1.6);
  g.drawRect(16.5, 19.5, 7, 1.6);
  g.endFill();
  // Orbit motes
  for (const [mx, my] of [[4, 20], [36, 20], [20, 26]] as const) {
    g.beginFill(GALACTIC.goldLt, 0.9);
    g.drawCircle(mx, my, 1.2);
    g.endFill();
  }
  return bake(renderer, g, 40, 78);
}

/** Lab bench: slab with flasks, a rack of vials and a microscope arm. */
function bakeLabBench(renderer: AnyRenderer): PIXI.RenderTexture {
  const w = 96;
  const g = new PIXI.Graphics();
  drawIsoBlock(g, 24, 58, 10, 5, 28, shade(GALACTIC.panel, 1.7), GALACTIC.goldDp, 0.5);
  drawIsoBlock(g, 72, 58, 10, 5, 28, shade(GALACTIC.panel, 1.7), GALACTIC.goldDp, 0.5);
  drawIsoBlock(g, 48, 28, 96, 48, 7, shade(GALACTIC.glass, 2.3), GALACTIC.gold, 0.8);
  // Flasks (conical) with glowing contents
  for (const [fx, fy, fill] of [[26, 40, GALACTIC.ok], [36, 46, GALACTIC.info], [46, 51, GALACTIC.goldLt]] as const) {
    g.beginFill(shade(GALACTIC.glass, 2.6), 0.75);
    g.drawPolygon([fx - 5, fy, fx + 5, fy, fx + 2, fy - 12, fx - 2, fy - 12]);
    g.endFill();
    g.beginFill(fill, 0.85);
    g.drawPolygon([fx - 4, fy - 1, fx + 4, fy - 1, fx + 2.5, fy - 5, fx - 2.5, fy - 5]);
    g.endFill();
    g.lineStyle(1, GALACTIC.gold, 0.6);
    g.drawPolygon([fx - 5, fy, fx + 5, fy, fx + 2, fy - 12, fx - 2, fy - 12]);
    g.lineStyle(0);
  }
  // Vial rack on the right
  g.beginFill(shade(GALACTIC.panel, 2.0));
  g.drawPolygon([58, 40, 78, 30, 84, 33, 64, 43]);
  g.endFill();
  for (let i = 0; i < 4; i++) {
    g.beginFill(i % 2 ? GALACTIC.ok : GALACTIC.info, 0.9);
    g.drawRect(61 + i * 5, 29 - i * 2.4, 2, 9);
    g.endFill();
  }
  // Microscope arm at the back-left
  g.lineStyle(2.5, shade(GALACTIC.panel, 2.8), 1);
  g.moveTo(14, 34); g.lineTo(14, 14); g.lineTo(22, 10);
  g.lineStyle(0);
  g.beginFill(GALACTIC.gold, 0.95);
  g.drawCircle(22, 12, 3);
  g.endFill();
  return bake(renderer, g, w, 92);
}

/** Tripod camera rig with lens + tally light. */
function bakeCameraRig(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  g.lineStyle(2, shade(GALACTIC.panel, 2.6), 1);
  g.moveTo(22, 30); g.lineTo(8, 62);
  g.moveTo(22, 30); g.lineTo(36, 62);
  g.moveTo(22, 30); g.lineTo(24, 60);
  g.lineStyle(0);
  // Camera body
  drawIsoBlock(g, 22, 12, 28, 14, 12, shade(GALACTIC.panel, 2.4), GALACTIC.gold, 0.8);
  // Lens barrel pointing front-left
  g.beginFill(shade(GALACTIC.panel, 1.8));
  g.drawEllipse(9, 27, 6, 4);
  g.endFill();
  g.lineStyle(1, GALACTIC.gold, 0.9);
  g.drawEllipse(9, 27, 6, 4);
  g.lineStyle(0);
  g.beginFill(GALACTIC.info, 0.85);
  g.drawEllipse(9, 27, 3, 2);
  g.endFill();
  // Viewfinder + tally light
  g.beginFill(shade(GALACTIC.panel, 2.8));
  g.drawRect(30, 8, 8, 6);
  g.endFill();
  g.beginFill(GALACTIC.err, 0.95);
  g.drawCircle(35, 6, 1.6);
  g.endFill();
  return bake(renderer, g, 44, 64);
}

/** Softbox studio light on a stand — a bright glowing panel. */
function bakeSoftbox(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  g.beginFill(shade(GALACTIC.panel, 2.2));
  g.drawEllipse(18, 66, 10, 4.5);
  g.endFill();
  g.lineStyle(2, shade(GALACTIC.panel, 2.8), 1);
  g.moveTo(18, 66); g.lineTo(18, 26);
  g.lineStyle(0);
  // Glow halo
  g.beginFill(GALACTIC.goldLt, 0.16);
  g.drawEllipse(20, 18, 22, 16);
  g.endFill();
  // Panel (angled quad) with warm gradient bands
  g.beginFill(0xfff7e0, 0.95);
  g.drawPolygon([4, 22, 30, 8, 36, 22, 10, 36]);
  g.endFill();
  g.beginFill(GALACTIC.goldLt, 0.35);
  g.drawPolygon([8, 24, 28, 13, 31, 20, 11, 31]);
  g.endFill();
  g.lineStyle(1.5, GALACTIC.gold, 0.9);
  g.drawPolygon([4, 22, 30, 8, 36, 22, 10, 36]);
  g.lineStyle(0);
  return bake(renderer, g, 40, 70);
}

/** Tatami mat: flat iso pad with weave lines and a gold border. */
function bakeDojoMat(renderer: AnyRenderer): PIXI.RenderTexture {
  const w = 128;
  const h = 64;
  const g = new PIXI.Graphics();
  drawIsoBlock(g, w / 2, 0, w, h, 3, shade(GALACTIC.floorAlt, 1.9), GALACTIC.gold, 0.75);
  // Two halves with a centre seam + weave hairlines
  g.lineStyle(1, GALACTIC.goldDp, 0.5);
  g.moveTo(w / 2 - w / 4, h / 4); g.lineTo(w / 2 + w / 4, h * 3 / 4);
  g.lineStyle(1, shade(GALACTIC.floorAlt, 2.6), 0.35);
  for (let i = 1; i < 8; i++) {
    const t = i / 8;
    g.moveTo(w / 2 - (w / 2) * t, (h / 2) * t);
    g.lineTo(w / 2 + (w / 2) * (1 - t), (h / 2) + (h / 2) * (1 - t) - (h / 2) * (1 - t) * 0 );
  }
  g.lineStyle(0);
  // Centre emblem ring
  g.lineStyle(1.5, GALACTIC.gold, 0.55);
  g.drawEllipse(w / 2, h / 2, 12, 6);
  g.lineStyle(0);
  return bake(renderer, g, w, h + 3);
}

/** Bonsai: planter block, trunk and a canopy of glowing leaf pads. */
function bakeBonsai(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  drawIsoBlock(g, 18, 40, 24, 12, 10, shade(GALACTIC.panel, 2.2), GALACTIC.gold, 0.7);
  g.lineStyle(2.5, shade(GALACTIC.panel, 3.0), 1);
  g.moveTo(18, 44); g.lineTo(17, 32); g.lineTo(11, 24);
  g.moveTo(17, 32); g.lineTo(24, 22);
  g.moveTo(17, 32); g.lineTo(19, 16);
  g.lineStyle(0);
  for (const [cx, cy, rx, ry] of [[10, 22, 8, 4], [25, 20, 8, 4], [18, 12, 9, 4.5]] as const) {
    g.beginFill(GALACTIC.ok, 0.22);
    g.drawEllipse(cx, cy, rx + 3, ry + 2);
    g.endFill();
    g.beginFill(shade(GALACTIC.ok, 0.8), 0.9);
    g.drawEllipse(cx, cy, rx, ry);
    g.endFill();
    g.lineStyle(1, GALACTIC.goldLt, 0.5);
    g.drawEllipse(cx, cy, rx, ry);
    g.lineStyle(0);
  }
  return bake(renderer, g, 36, 54);
}

/** Two-tier shelf rack stocked with small boxes. */
function bakeShelfRack(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  // Uprights
  g.lineStyle(2, shade(GALACTIC.panel, 2.6), 1);
  g.moveTo(6, 22); g.lineTo(6, 70);
  g.moveTo(34, 36); g.lineTo(34, 84);
  g.lineStyle(0);
  // Shelves (thin slabs)
  drawIsoBlock(g, 20, 52, 40, 20, 3, shade(GALACTIC.panel, 2.4), GALACTIC.gold, 0.8);
  drawIsoBlock(g, 20, 26, 40, 20, 3, shade(GALACTIC.panel, 2.4), GALACTIC.gold, 0.8);
  // Boxes on each shelf
  const box = (x: number, y: number, c: number) => {
    drawIsoBlock(g, x, y, 12, 6, 7, c, GALACTIC.goldDp, 0.6);
    g.lineStyle(1, GALACTIC.goldLt, 0.6);
    g.moveTo(x - 6, y + 3); g.lineTo(x, y + 6); g.lineTo(x + 6, y + 3);
    g.lineStyle(0);
  };
  box(14, 18, shade(GALACTIC.panel, 2.9));
  box(26, 24, shade(GALACTIC.glass, 2.2));
  box(12, 44, shade(GALACTIC.glass, 2.2));
  box(24, 50, shade(GALACTIC.panel, 2.9));
  // Price tag glow on the top box
  g.beginFill(GALACTIC.goldLt, 0.9);
  g.drawRect(11, 27, 4, 2);
  g.endFill();
  return bake(renderer, g, 44, 90);
}

/** Standing whiteboard with a sketched flow (boxes + arrows). */
function bakeDrawingBoard(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  // Legs
  g.lineStyle(2, shade(GALACTIC.panel, 2.6), 1);
  g.moveTo(14, 46); g.lineTo(10, 70);
  g.moveTo(74, 22); g.lineTo(78, 46);
  g.moveTo(14, 46); g.lineTo(18, 70);
  g.moveTo(74, 22); g.lineTo(70, 46);
  g.lineStyle(0);
  // Board (angled quad, light surface)
  g.beginFill(0xe9e4d8, 0.96);
  g.drawPolygon([8, 46, 80, 18, 80, -14, 8, 14]);
  g.endFill();
  g.lineStyle(2, GALACTIC.gold, 0.9);
  g.drawPolygon([8, 46, 80, 18, 80, -14, 8, 14]);
  g.lineStyle(0);
  // Sketch: two boxes joined by an arrow, plus a squiggle
  const ink = 0x1f2933;
  g.lineStyle(1.4, ink, 0.85);
  g.drawPolygon([16, 34, 32, 28, 32, 16, 16, 22]);
  g.drawPolygon([50, 22, 68, 15, 68, 3, 50, 10]);
  g.moveTo(33, 22); g.lineTo(49, 16);
  g.moveTo(45, 13); g.lineTo(49, 16); g.lineTo(45, 19);
  g.moveTo(18, 40); g.lineTo(28, 36); g.lineTo(38, 34); g.lineTo(48, 30);
  g.lineStyle(0);
  g.beginFill(GALACTIC.err, 0.8);
  g.drawCircle(60, 27, 1.8);
  g.endFill();
  // Marker tray
  g.beginFill(shade(GALACTIC.panel, 2.2));
  g.drawPolygon([8, 48, 80, 20, 80, 23, 8, 51]);
  g.endFill();
  return bake(renderer, g, 88, 72);
}

/** Floating holo frame: beam base + framed glowing panel. */
function bakeHoloFrame(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  drawIsoBlock(g, 24, 58, 20, 10, 6, shade(GALACTIC.glass, 1.6), GALACTIC.gold, 0.7);
  // Beam
  g.lineStyle(1, GALACTIC.goldLt, 0.5);
  g.moveTo(24, 60); g.lineTo(24, 40);
  g.lineStyle(0);
  g.beginFill(GALACTIC.goldLt, 0.12);
  g.drawPolygon([14, 60, 34, 60, 40, 40, 8, 40]);
  g.endFill();
  // Frame (angled panel)
  g.beginFill(GALACTIC.gold, 0.9);
  g.drawPolygon([4, 40, 44, 24, 44, -6, 4, 10]);
  g.endFill();
  g.beginFill(shade(GALACTIC.glass, 1.4), 0.95);
  g.drawPolygon([7, 37, 41, 23.5, 41, -2, 7, 11.5]);
  g.endFill();
  // Holographic "artwork": layered translucent shapes
  g.beginFill(GALACTIC.accent2, 0.45);
  g.drawPolygon([11, 33, 30, 25, 30, 12, 11, 20]);
  g.endFill();
  g.beginFill(GALACTIC.goldLt, 0.55);
  g.drawCircle(31, 9, 5);
  g.endFill();
  g.beginFill(0xffffff, 0.35);
  g.drawPolygon([9, 14, 39, 2, 39, 0, 9, 12]);
  g.endFill();
  return bake(renderer, g, 48, 66);
}

/** Long glass boardroom table with seats around it. */
function bakeBoardTable(renderer: AnyRenderer): PIXI.RenderTexture {
  const w = 132;
  const g = new PIXI.Graphics();
  // Seats (small glass blocks) — rear row first so the table caps them
  const seat = (x: number, y: number) => drawIsoBlock(g, x, y, 12, 6, 8, shade(GALACTIC.glass, 1.9), GALACTIC.goldDp, 0.6);
  seat(30, 18); seat(54, 6); seat(78, 6); seat(102, 18);
  // Pedestal legs
  drawIsoBlock(g, 46, 56, 10, 5, 22, shade(GALACTIC.panel, 1.7), GALACTIC.goldDp, 0.5);
  drawIsoBlock(g, 86, 56, 10, 5, 22, shade(GALACTIC.panel, 1.7), GALACTIC.goldDp, 0.5);
  // Table top (thin glass slab)
  drawIsoBlock(g, 66, 22, 116, 58, 6, shade(GALACTIC.glass, 2.2), GALACTIC.gold, 0.85);
  // Front seats
  seat(30, 62); seat(54, 74); seat(78, 74); seat(102, 62);
  // Centre holo projector + glow
  g.beginFill(GALACTIC.goldLt, 0.18);
  g.drawEllipse(66, 46, 18, 9);
  g.endFill();
  g.beginFill(GALACTIC.gold, 0.9);
  g.drawEllipse(66, 50, 5, 2.5);
  g.endFill();
  g.lineStyle(1, GALACTIC.goldLt, 0.7);
  g.drawEllipse(66, 42, 10, 5);
  g.lineStyle(0);
  // Tablets at the seats (tiny glowing rects on the table)
  g.beginFill(GALACTIC.goldLt, 0.7);
  for (const [tx, ty] of [[38, 34], [58, 26], [78, 26], [98, 34], [38, 56], [98, 56]] as const) g.drawRect(tx, ty, 5, 2.5);
  g.endFill();
  return bake(renderer, g, w, 96);
}

/** Voice studio wall screen: live waveform bars in a gold bezel. */
function bakeWaveformWall(renderer: AnyRenderer): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  drawIsoBlock(g, 56, 4, 112, 26, 46, shade(GALACTIC.panel, 2.0), GALACTIC.gold, 0.8);
  g.beginFill(shade(GALACTIC.panel, 1.4));
  g.drawPolygon([50, 66, 60, 71, 60, 78, 50, 73]);
  g.endFill();
  g.beginFill(GALACTIC.gold, 0.85);
  g.drawPolygon([6, 20, 52, 39, 52, 73, 6, 54]);
  g.endFill();
  g.beginFill(shade(GALACTIC.panel, 1.15));
  g.drawPolygon([10, 24, 48, 39.5, 48, 68, 10, 52.5]);
  g.endFill();
  // Waveform bars mirrored about the panel's centre line
  const amps = [0.2, 0.45, 0.8, 0.55, 1, 0.65, 0.35, 0.7, 0.5, 0.25, 0.6, 0.3];
  amps.forEach((a, i) => {
    const x = 12 + i * 3;
    const mid = 38 + (x - 10) * (14 / 38);
    const hh = 2 + a * 11;
    g.beginFill(i % 4 === 2 ? GALACTIC.goldLt : GALACTIC.accent2, 0.9);
    g.drawRect(x, mid - hh, 2, hh * 2);
    g.endFill();
  });
  // Rec dot
  g.beginFill(GALACTIC.err, 0.95);
  g.drawCircle(45, 64, 1.8);
  g.endFill();
  return bake(renderer, g, 112, 82);
}

/** False once any baked RenderTexture has been destroyed (baseTexture nulled). */
export function galacticTexturesUsable(textures: GalacticTextures | null | undefined): boolean {
  if (!textures) return false;
  for (const [key, texture] of Object.entries(textures)) {
    if (key === 'agentSprite') continue;
    const t = texture as PIXI.RenderTexture;
    if (!t || !t.baseTexture || (t.baseTexture as { destroyed?: boolean }).destroyed) return false;
  }
  return true;
}

export function bakeGalacticTextures(renderer: AnyRenderer): GalacticTextures {
  const existing = bakedByRenderer.get(renderer);
  if (existing && galacticTexturesUsable(existing)) {
    baked = existing;
    bakedOwner = renderer;
    return existing;
  }
  const fresh: GalacticTextures = {
    floorA: bakeFloorTile(renderer, GALACTIC.floor, 0.22),
    floorB: bakeFloorTile(renderer, GALACTIC.floorAlt, 0.22),
    floorSeam: bakeFloorTile(renderer, GALACTIC.panel, 0.5),
    officePad: bakeOfficePad(renderer),
    desk: bakeDesk(renderer),
    bench: bakeBench(renderer),
    server: bakeServer(renderer),
    holoTable: bakeHoloTable(renderer),
    bigDisplay: bakeBigDisplay(renderer),
    antenna: bakeAntenna(renderer),
    vaultDoor: bakeVaultDoor(renderer),
    crate: bakeCrate(renderer),
    easel: bakeEasel(renderer),
    crystal: bakeCrystal(renderer),
    telescope: bakeTelescope(renderer),
    consoleWide: bakeConsoleWide(renderer),
    commsBoard: bakeCommsBoard(renderer),
    micBooth: bakeMicBooth(renderer),
    speaker: bakeSpeaker(renderer),
    safe: bakeSafe(renderer),
    ingots: bakeIngots(renderer),
    roboArm: bakeRoboArm(renderer),
    gateArch: bakeGateArch(renderer),
    pedestal: bakePedestal(renderer),
    plantHolo: bakePlantHolo(renderer),
    couch: bakeCouch(renderer),
    bed: bakeBed(renderer),
    tickerBoard: bakeTickerBoard(renderer),
    coinPillar: bakeCoinPillar(renderer),
    labBench: bakeLabBench(renderer),
    cameraRig: bakeCameraRig(renderer),
    softbox: bakeSoftbox(renderer),
    dojoMat: bakeDojoMat(renderer),
    bonsai: bakeBonsai(renderer),
    shelfRack: bakeShelfRack(renderer),
    drawingBoard: bakeDrawingBoard(renderer),
    holoFrame: bakeHoloFrame(renderer),
    boardTable: bakeBoardTable(renderer),
    waveformWall: bakeWaveformWall(renderer),
    // Same persistent reference every bake — survives resetGalacticTextures so
    // the PNGs never reload on a theme rebuild.
    agentSprite: agentSpriteCache,
  };
  bakedByRenderer.set(renderer, fresh);
  baked = fresh;
  bakedOwner = renderer;
  // Kick off async sprite load (idempotent); fills agentSpriteCache as each
  // texture resolves.
  void loadAgentSprites();
  return fresh;
}

/**
 * Baked textures for `renderer` (or the most recently baked set when omitted),
 * or null if bakeGalacticTextures() hasn't run for it yet.
 */
export function getGalacticTextures(renderer?: AnyRenderer): GalacticTextures | null {
  if (renderer) return bakedByRenderer.get(renderer) ?? null;
  return baked;
}

// ════════════════════════════════════════════════════════════════
// AGENT SPRITES (async PNG load — distinct from the synchronous bakery)
// ════════════════════════════════════════════════════════════════

// Persistent across theme rebuilds — PNGs are theme-independent, so we never
// reload them. Filled in-place as each PIXI.Texture.fromURL resolves.
const agentSpriteCache: Record<string, PIXI.Texture> = {};
let agentSpritePromise: Promise<Record<string, PIXI.Texture>> | null = null;

/**
 * Load each per-backend robot-ninja PNG once via PIXI.Texture.fromURL (Pixi 6's
 * awaitable loader) into the persistent agentSpriteCache. Idempotent — repeat
 * calls return the same promise. A failed slot is skipped (drawAgent falls back
 * to the pixel pattern).
 */
export function loadAgentSprites(): Promise<Record<string, PIXI.Texture>> {
  if (agentSpritePromise) return agentSpritePromise;
  agentSpritePromise = Promise.all(
    Object.entries(AGENT_SPRITE_SRC).map(async ([slot, url]) => {
      try {
        agentSpriteCache[slot] = await PIXI.Texture.fromURL(url);
      } catch (err) {
        // Missing/invalid PNG — leave the slot empty so the pixel art shows.
        console.warn(`[agent-sprites] failed to load ${slot} (${url})`, err);
      }
    }),
  ).then(() => agentSpriteCache);
  return agentSpritePromise;
}

/** Loaded agent-sprite textures (may be partial/empty before loads finish). */
export function getAgentSpriteTextures(): Record<string, PIXI.Texture> {
  return agentSpriteCache;
}

/**
 * Destroy the bake cache so the next bakeGalacticTextures() call re-renders
 * everything with the CURRENT palette. Call only after the sprites using
 * these textures have been destroyed (i.e. during a world rebuild).
 */
export function resetGalacticTextures(renderer?: AnyRenderer): void {
  const owner = renderer ?? bakedOwner;
  const set = owner ? bakedByRenderer.get(owner) : baked;
  if (owner) bakedByRenderer.delete(owner);
  if (set && set === baked) {
    baked = null;
    bakedOwner = null;
  }
  if (!set) return;
  // agentSprite holds the persistent PNG cache (not a RenderTexture) — skip it
  // so the loaded sprites survive the rebuild and don't reload.
  for (const [key, texture] of Object.entries(set)) {
    if (key === 'agentSprite') continue;
    try { (texture as PIXI.RenderTexture).destroy(true); } catch { /* already gone */ }
  }
}

// ════════════════════════════════════════════════════════════════
// PLATFORM BUILDER
// ════════════════════════════════════════════════════════════════

export interface PlatformOptions {
  seamEvery?: number;
  trim?: boolean;
  trimAlpha?: number;
  sideDepth?: number;
}

export interface Platform {
  container: PIXI.Container;
  /** Diamond corner points in the platform's LOCAL space (center = 0,0). */
  corners: { top: PIXI.Point; right: PIXI.Point; bottom: PIXI.Point; left: PIXI.Point };
  width: number;
  height: number;
}

/**
 * Build a floating platform slab of cols×rows floor tiles, centered on its
 * local origin. Caller positions the returned container in world space.
 */
export function buildPlatform(
  renderer: AnyRenderer,
  cols: number,
  rows: number,
  options: PlatformOptions = {},
): Platform {
  const textures = bakeGalacticTextures(renderer);
  const seamEvery = options.seamEvery ?? 0;
  const sideDepth = options.sideDepth ?? TILE_H / 2;

  const container = new PIXI.Container();
  const ox = (-(cols - rows) * TILE_W) / 4;
  const oy = (-(cols + rows) * TILE_H) / 4;

  const corner = (c: number, r: number) =>
    new PIXI.Point(ox + ((c - r) * TILE_W) / 2, oy + ((c + r) * TILE_H) / 2);
  const corners = {
    top: corner(0, 0),
    right: corner(cols, 0),
    bottom: corner(cols, rows),
    left: corner(0, rows),
  };

  // Slab side faces (under the floor)
  const sides = new PIXI.Graphics();
  sides.beginFill(0x080705);
  sides.drawPolygon([
    corners.left.x, corners.left.y,
    corners.bottom.x, corners.bottom.y,
    corners.bottom.x, corners.bottom.y + sideDepth,
    corners.left.x, corners.left.y + sideDepth,
  ]);
  sides.endFill();
  sides.beginFill(0x0a0906);
  sides.drawPolygon([
    corners.bottom.x, corners.bottom.y,
    corners.right.x, corners.right.y,
    corners.right.x, corners.right.y + sideDepth,
    corners.bottom.x, corners.bottom.y + sideDepth,
  ]);
  sides.endFill();
  container.addChild(sides);

  // Floor tiles
  const floor = new PIXI.Container();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const onSeam = seamEvery > 0 && (c % seamEvery === 0 || r % seamEvery === 0);
      const texture = onSeam
        ? textures.floorSeam
        : (c + r) % 2 === 0
          ? textures.floorA
          : textures.floorB;
      const tile = new PIXI.Sprite(texture);
      const p = corner(c, r);
      tile.position.set(p.x - TILE_W / 2, p.y);
      floor.addChild(tile);
    }
  }
  container.addChild(floor);

  // Gold perimeter trim
  if (options.trim !== false) {
    const trim = new PIXI.Graphics();
    trim.lineStyle(3, GALACTIC.gold, options.trimAlpha ?? 0.9);
    trim.drawPolygon([
      corners.top.x, corners.top.y,
      corners.right.x, corners.right.y,
      corners.bottom.x, corners.bottom.y,
      corners.left.x, corners.left.y,
    ]);
    trim.lineStyle(0);
    for (const p of [corners.top, corners.right, corners.bottom, corners.left]) {
      trim.beginFill(GALACTIC.goldLt, 0.95);
      trim.drawRect(p.x - 3, p.y - 3, 6, 6);
      trim.endFill();
    }
    container.addChild(trim);
  }

  return {
    container,
    corners,
    width: ((cols + rows) * TILE_W) / 2,
    height: ((cols + rows) * TILE_H) / 2,
  };
}

// ════════════════════════════════════════════════════════════════
// HOLO SIGN
// ════════════════════════════════════════════════════════════════

/** Glass plate with gold pixel text, anchored at its horizontal center. */
export function buildHoloSign(text: string, scale = 3, beam = 32): PIXI.Container {
  const sign = new PIXI.Container();
  const width = measurePixelText(text, scale);
  const padX = 8 + scale * 2;
  const padY = 4 + scale;
  const height = 5 * scale + padY * 2;

  const plate = new PIXI.Graphics();
  plate.beginFill(GALACTIC.glass, 0.55);
  plate.drawRect(-width / 2 - padX, 0, width + padX * 2, height);
  plate.endFill();
  plate.lineStyle(1, GALACTIC.gold, 0.8);
  plate.drawRect(-width / 2 - padX, 0, width + padX * 2, height);
  if (beam > 0) {
    plate.lineStyle(1, GALACTIC.goldDp, 0.4);
    plate.moveTo(0, height);
    plate.lineTo(0, height + beam);
  }
  sign.addChild(plate);

  const label = new PIXI.Graphics();
  drawPixelText(label, text, -width / 2, padY, GALACTIC.goldLt, scale);
  sign.addChild(label);

  return sign;
}
