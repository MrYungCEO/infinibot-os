/**
 * Plugin District — the Pixi renderer for plugin rooms on the Galactic HQ map.
 *
 * Builds one iso block per PluginRoomSpec (iso/plugin-rooms.ts decides WHAT
 * and WHERE; this file decides HOW it looks): a floating platform slab with
 * the plugin's accent trim + floor tint, themed props from the shared bakery
 * (galactic-assets.ts — same per-renderer bake cache, so a GL context restore
 * re-bakes these with everything else), an accent holo sign showing the
 * plugin monogram, a crisp HUD label like the core sectors, hover/active
 * glow, and a click hit-area. Rooms build in with a rise+fade and dissolve
 * out the same way when a plugin is disabled. A transit loop of light
 * conduits joins every room to the Gateway Concourse.
 *
 * It also draws the in-room interaction FX for agents the engine says are
 * working there: typing sparks at a desk, a dashed "conversation" link between
 * two agents sharing a room, and a carried crate above an agent walking
 * between two plugin rooms.
 */

import * as PIXI from 'pixi.js';
import gsap from 'gsap';

import { GALACTIC } from './galactic-theme';
import { TILE_W, TILE_H } from './projection';
import { bakeGalacticTextures, buildPlatform, drawDashedLine, type GalacticTextures } from './galactic-assets';
import { ZoneLabel } from './hud';
import { computeWorkSlots, type SpreadSectorDef } from './agent-spread';
import { drawPixelText, measurePixelText } from './pixel-text';
import {
  CONCOURSE_GATE,
  RESERVED_RECTS,
  ROOM_TILES,
  districtConduits,
  planDistrict,
  type PlacedRoom,
  type PluginRoomSpec,
} from './plugin-rooms';

export interface PluginDistrictOptions {
  centerX: number;
  centerY: number;
  onRoomClick?: (spec: PluginRoomSpec) => void;
  /** Hover enter (screen point in canvas px) / leave (null). */
  onRoomHover?: (spec: PluginRoomSpec | null, screen: { x: number; y: number } | null) => void;
  reducedMotion?: boolean;
}

export interface DistrictRoom {
  spec: PluginRoomSpec;
  placed: PlacedRoom;
  /** World-space centre. */
  center: PIXI.Point;
  /** World-space diamond outline (flat). */
  poly: number[];
  /** World-space workstation slots (agent-spread seats). */
  workSlots: PIXI.Point[];
  label: ZoneLabel;
  container: PIXI.Container;
  highlight: PIXI.Graphics;
  hover: boolean;
  active: boolean;
  breath: gsap.core.Tween | null;
  /** Prop world positions, for the desk-side spark FX. */
  propPoints: PIXI.Point[];
  /** Everything gsap may be tweening for this room (killed on dissolve/destroy). */
  tweenTargets: object[];
  /** Zoom-fade wrapper around the monogram sign (alpha = zoom fade). */
  signWrap: PIXI.Container;
  /** The monogram sign itself (build-in alpha + bob tween live here). */
  sign: PIXI.Container;
  signCorner: 'east' | 'west' | null;
  signBob: gsap.core.Tween | null;
}

/** What the engine tells the district about each agent in a plugin room. */
export interface DistrictOccupant {
  key: string;
  roomId: string;
  /** World position of the sprite's feet. */
  x: number;
  y: number;
  /** Walking (routed) right now. */
  moving: boolean;
  /** Carrying an item between plugin rooms (cross-plugin task). */
  carrying: boolean;
}

const BUILD_MS = 0.75;
const DISSOLVE_MS = 0.55;
const SIGN_LIFT = 46;
/** Monogram signs are a close-up detail: below this zoom the counter-scaled
 *  HUD titles are the room identity and a sign would only collide with them. */
const PLUGIN_LABEL_IDLE_ALPHA = 0.6;
const SIGN_ZOOM_HIDE = 0.8;
const SIGN_ZOOM_FULL = 1.1;

/** Even-odd point-in-polygon on a flat [x0,y0,x1,y1,…] outline. */
export function pointInPolygon(x: number, y: number, poly: number[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 2 ** 32;
}

/** Accent-coloured glass sign with the plugin monogram, floating on a beam. */
function buildMonogramSign(text: string, accent: number): PIXI.Container {
  const sign = new PIXI.Container();
  const scale = 3;
  const width = measurePixelText(text, scale);
  const padX = 10;
  const padY = 5;
  const h = 5 * scale + padY * 2;
  const w = width + padX * 2;
  const plate = new PIXI.Graphics();
  // Beam down to the floor anchor
  plate.beginFill(accent, 0.1);
  plate.drawPolygon([-w / 2 + 4, h, w / 2 - 4, h, w / 4, h + SIGN_LIFT, -w / 4, h + SIGN_LIFT]);
  plate.endFill();
  plate.lineStyle(1, accent, 0.45);
  plate.moveTo(0, h);
  plate.lineTo(0, h + SIGN_LIFT);
  plate.lineStyle(0);
  // Glass plate
  plate.beginFill(0x0a0a0c, 0.82);
  plate.drawRoundedRect(-w / 2, 0, w, h, 3);
  plate.endFill();
  plate.lineStyle(1.2, accent, 0.95);
  plate.drawRoundedRect(-w / 2, 0, w, h, 3);
  plate.lineStyle(0);
  plate.beginFill(accent, 0.9);
  plate.drawRect(-w / 2 + 2, 3, 2, h - 6);
  plate.endFill();
  sign.addChild(plate);
  const label = new PIXI.Graphics();
  drawPixelText(label, text, -width / 2 + 2, padY, accent, scale);
  sign.addChild(label);
  return sign;
}

export class PluginDistrict {
  /** World-space root (platforms, props, signs, conduits). */
  readonly container = new PIXI.Container();
  /** Crisp labels — the engine mounts this in its label layer and counter-scales children. */
  readonly labelLayer = new PIXI.Container();
  /** In-room interaction FX — mounted above the agent layer. */
  readonly fxLayer = new PIXI.Container();

  private readonly renderer: PIXI.Renderer | PIXI.AbstractRenderer;
  private readonly options: PluginDistrictOptions;
  private textures: GalacticTextures;
  private readonly rooms = new Map<string, DistrictRoom>();
  private plan = new Map<string, PlacedRoom>();
  private readonly conduitG = new PIXI.Graphics();
  private readonly roomsLayer = new PIXI.Container();
  private gateSprite: PIXI.Sprite | null = null;
  private readonly fxG = new PIXI.Graphics();
  private fxTime = 0;
  private lastOccupants: DistrictOccupant[] = [];
  private destroyed = false;
  // DOM pointer routing (attachDom)
  private domCanvas: HTMLElement | null = null;
  private domToWorld: ((x: number, y: number) => { x: number; y: number }) | null = null;
  private domBlockClick: ((world: { x: number; y: number }) => boolean) | null = null;
  private domHover: DistrictRoom | null = null;
  private domDown: { x: number; y: number; roomId: string | null } | null = null;
  private domCursorSet = false;

  constructor(renderer: PIXI.Renderer | PIXI.AbstractRenderer, options: PluginDistrictOptions) {
    this.renderer = renderer;
    this.options = options;
    this.textures = bakeGalacticTextures(renderer);
    this.container.addChild(this.conduitG);
    this.roomsLayer.sortableChildren = true;
    this.container.addChild(this.roomsLayer);
    this.fxLayer.addChild(this.fxG);
  }

  // ── Projection (same anchoring as sector-layout.ts buildStationComplex) ──

  private cell(c: number, r: number): PIXI.Point {
    const { centerX, centerY } = this.options;
    const ox = centerX; // (cols - rows) = 0 for the 24×24 core
    const oy = centerY - (48 * TILE_H) / 4;
    return new PIXI.Point(ox + ((c - r) * TILE_W) / 2, oy + ((c + r) * TILE_H) / 2);
  }

  // ── Public API ────────────────────────────────────────────────────────

  /** Rooms currently on the map, by sector id (`plugin:<id>`). */
  list(): DistrictRoom[] {
    return [...this.rooms.values()];
  }

  room(id: string): DistrictRoom | undefined {
    return this.rooms.get(id);
  }

  has(id: string): boolean {
    return this.rooms.has(id);
  }

  size(): number {
    return this.rooms.size;
  }

  center(id: string): PIXI.Point | null {
    return this.rooms.get(id)?.center ?? null;
  }

  workSlots(id: string): PIXI.Point[] | undefined {
    return this.rooms.get(id)?.workSlots;
  }

  /** Tile-space defs for the spread planner (id, c, r, w, h). */
  sectorDefs(): SpreadSectorDef[] {
    return [...this.rooms.values()].map((r) => ({ id: r.spec.id, c: r.placed.c, r: r.placed.r, w: r.placed.w, h: r.placed.h }));
  }

  /** World bounds of every room (null when empty). */
  bounds(): { minX: number; maxX: number; minY: number; maxY: number } | null {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const room of this.rooms.values()) {
      for (let i = 0; i < room.poly.length; i += 2) {
        minX = Math.min(minX, room.poly[i]);
        maxX = Math.max(maxX, room.poly[i]);
        minY = Math.min(minY, room.poly[i + 1]);
        maxY = Math.max(maxY, room.poly[i + 1]);
      }
    }
    if (!isFinite(minX)) return null;
    return { minX, maxX, minY: minY - 70, maxY: maxY + 30 };
  }

  /**
   * Reconcile the district with the wanted room specs: dissolve rooms whose
   * plugin left, build rooms that are new, leave the rest in place (sticky
   * placement). Returns the ids that changed.
   */
  sync(specs: readonly PluginRoomSpec[], animate = true): { added: string[]; removed: string[] } {
    const wanted = new Map(specs.map((s) => [s.id, s]));
    const removed: string[] = [];
    for (const id of [...this.rooms.keys()]) {
      const next = wanted.get(id);
      const cur = this.rooms.get(id)!.spec;
      const changed = !next || next.size !== cur.size || next.theme !== cur.theme || next.placement !== cur.placement
        || next.accent !== cur.accent || next.title !== cur.title || next.monogram !== cur.monogram
        || JSON.stringify(next.decor) !== JSON.stringify(cur.decor);
      if (changed) {
        this.dissolveRoom(id, animate);
        removed.push(id);
      }
    }
    const previous = new Map<string, PlacedRoom>();
    for (const [id, room] of this.rooms) previous.set(id, room.placed);
    this.plan = planDistrict(specs, previous);
    const added: string[] = [];
    for (const placed of this.plan.values()) {
      if (this.rooms.has(placed.spec.id)) continue;
      this.buildRoom(placed, animate);
      added.push(placed.spec.id);
    }
    // Signs: (re)pick each room's corner against the full set of title
    // anchors — a new neighbour can make an existing room's corner crowded.
    for (const room of this.rooms.values()) this.placeSign(room, animate && !added.includes(room.spec.id));
    this.drawConduits();
    return { added, removed };
  }

  setActive(id: string, active: boolean): void {
    const room = this.rooms.get(id);
    if (!room || room.active === active) return;
    room.active = active;
    this.applyVisual(room);
  }

  setLabelsVisible(visible: boolean): void {
    this.labelLayer.visible = visible;
  }

  updateLabelAlphas(deltaMS: number): void {
    for (const room of this.rooms.values()) room.label.updateLabelAlpha(deltaMS);
  }

  /** Per-frame: in-room interaction FX for the occupants the engine reports. */
  frame(dt: number, occupants: DistrictOccupant[]): void {
    if (this.destroyed) return;
    this.fxTime += dt;
    this.lastOccupants = occupants;
    const g = this.fxG;
    g.clear();
    if (!occupants.length) return;
    const t = this.fxTime;
    const byRoom = new Map<string, DistrictOccupant[]>();
    for (const o of occupants) {
      const room = this.rooms.get(o.roomId);
      if (!room) continue;
      const list = byRoom.get(o.roomId) ?? [];
      list.push(o);
      byRoom.set(o.roomId, list);
    }
    for (const [roomId, list] of byRoom) {
      const room = this.rooms.get(roomId)!;
      const accent = room.spec.accent;
      const still = list.filter((o) => !o.moving).sort((a, b) => (a.key < b.key ? -1 : 1));
      // Working sparks: three dots cycling beside the head of each seated agent.
      for (const o of list) {
        const seed = hashSeed(o.key);
        if (o.moving) {
          if (o.carrying) this.drawCarriedCrate(g, o.x, o.y - 50 + Math.sin(t * 6 + seed * 6) * 1.5, accent);
          continue;
        }
        const phase = t * 3.2 + seed * 6.28;
        for (let i = 0; i < 3; i++) {
          const a = 0.35 + 0.65 * Math.max(0, Math.sin(phase - i * 0.9));
          g.beginFill(accent, a);
          g.drawCircle(o.x + 12 + i * 5, o.y - 46 - Math.max(0, Math.sin(phase - i * 0.9)) * 2, 1.4);
          g.endFill();
        }
        // Faint holo glyph line: a "screen" flicker above the seat
        g.lineStyle(1, accent, 0.18 + 0.12 * Math.sin(t * 5 + seed * 9));
        g.moveTo(o.x + 10, o.y - 40);
        g.lineTo(o.x + 24, o.y - 40);
        g.lineStyle(0);
      }
      // Conversations: pair seated neighbours (max 3 pairs per room).
      for (let i = 0, pairs = 0; i + 1 < still.length && pairs < 3; i += 2, pairs++) {
        const a = still[i], b = still[i + 1];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 160 || d < 8) continue;
        const ax = a.x, ay = a.y - 30, bx = b.x, by = b.y - 30;
        const pulse = 0.35 + 0.25 * Math.sin(t * 2.4 + i);
        g.lineStyle(1, accent, pulse);
        drawDashedLine(g, ax, ay, bx, by, 5, 5);
        g.lineStyle(0);
        // Speech pips at the midpoint, alternating who "talks"
        const mx = (ax + bx) / 2, my = (ay + by) / 2 - 6;
        const talker = Math.floor(t / 1.6 + i) % 2 === 0 ? -1 : 1;
        g.beginFill(0x0a0a0c, 0.85);
        g.drawRoundedRect(mx - 9, my - 5, 18, 9, 3);
        g.endFill();
        g.lineStyle(1, accent, 0.8);
        g.drawRoundedRect(mx - 9, my - 5, 18, 9, 3);
        g.lineStyle(0);
        for (let k = 0; k < 3; k++) {
          const on = Math.floor(t * 4) % 3 === k;
          g.beginFill(accent, on ? 1 : 0.35);
          g.drawCircle(mx - 4 + k * 4 + talker * 0.5, my - 0.5, 1.1);
          g.endFill();
        }
      }
    }
  }

  private drawCarriedCrate(g: PIXI.Graphics, x: number, y: number, accent: number): void {
    // Tiny iso crate held overhead
    g.beginFill(GALACTIC.panel);
    g.drawPolygon([x - 7, y + 3, x, y + 7, x, y + 14, x - 7, y + 10]);
    g.endFill();
    g.beginFill(GALACTIC.panel * 1);
    g.drawPolygon([x + 7, y + 3, x, y + 7, x, y + 14, x + 7, y + 10]);
    g.endFill();
    g.beginFill(GALACTIC.goldLt);
    g.drawPolygon([x, y, x + 7, y + 3, x, y + 7, x - 7, y + 3]);
    g.endFill();
    g.lineStyle(1, accent, 0.9);
    g.drawPolygon([x, y, x + 7, y + 3, x, y + 7, x - 7, y + 3]);
    g.moveTo(x - 7, y + 3); g.lineTo(x - 7, y + 10); g.lineTo(x, y + 14); g.lineTo(x + 7, y + 10); g.lineTo(x + 7, y + 3);
    g.lineStyle(0);
  }

  /** Occupants last reported (for hover tooltips). */
  occupantsOf(roomId: string): DistrictOccupant[] {
    return this.lastOccupants.filter((o) => o.roomId === roomId);
  }

  destroy(): void {
    this.destroyed = true;
    this.detachDom();
    for (const id of [...this.rooms.keys()]) this.dissolveRoom(id, false);
    this.container.destroy({ children: true });
    this.labelLayer.destroy({ children: true });
    this.fxLayer.destroy({ children: true });
  }

  // ── DOM pointer routing ────────────────────────────────────────────────

  /**
   * Route hover + click from the map canvas: pointer → world (via the
   * viewport) → point-in-polygon over the rooms. `blockClick` lets the engine
   * keep agent clicks (Agent Focus) from also opening a room.
   */
  attachDom(
    canvas: HTMLElement,
    toWorld: (x: number, y: number) => { x: number; y: number },
    blockClick?: (world: { x: number; y: number }) => boolean,
  ): void {
    this.detachDom();
    this.domCanvas = canvas;
    this.domToWorld = toWorld;
    this.domBlockClick = blockClick ?? null;
    canvas.addEventListener('pointermove', this.onDomMove);
    canvas.addEventListener('pointerleave', this.onDomLeave);
    canvas.addEventListener('pointerdown', this.onDomDown);
    canvas.addEventListener('pointerup', this.onDomUp);
  }

  detachDom(): void {
    const c = this.domCanvas;
    if (!c) return;
    c.removeEventListener('pointermove', this.onDomMove);
    c.removeEventListener('pointerleave', this.onDomLeave);
    c.removeEventListener('pointerdown', this.onDomDown);
    c.removeEventListener('pointerup', this.onDomUp);
    if (this.domCursorSet) { c.style.cursor = ''; this.domCursorSet = false; }
    this.domCanvas = null;
    this.domToWorld = null;
    this.domHover = null;
    this.domDown = null;
  }

  /** Room whose floor diamond contains a canvas-relative point, if any. */
  roomAtScreen(sx: number, sy: number): DistrictRoom | null {
    if (!this.domToWorld) return null;
    const w = this.domToWorld(sx, sy);
    for (const room of this.rooms.values()) {
      if (pointInPolygon(w.x, w.y, room.poly)) return room;
    }
    return null;
  }

  private domPoint(e: PointerEvent): { x: number; y: number } {
    const r = this.domCanvas!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private readonly onDomMove = (e: PointerEvent): void => {
    if (this.destroyed || !this.domCanvas) return;
    const p = this.domPoint(e);
    const room = this.roomAtScreen(p.x, p.y);
    if (room !== this.domHover) {
      if (this.domHover) this.setHover(this.domHover, false);
      this.domHover = room;
      if (room) this.setHover(room, true);
      if (this.options.onRoomClick) {
        if (room && !this.domCursorSet) { this.domCanvas.style.cursor = 'pointer'; this.domCursorSet = true; }
        else if (!room && this.domCursorSet) { this.domCanvas.style.cursor = ''; this.domCursorSet = false; }
      }
      if (!room) this.options.onRoomHover?.(null, null);
    }
    if (room) this.options.onRoomHover?.(room.spec, p);
  };

  private readonly onDomLeave = (): void => {
    if (this.domHover) this.setHover(this.domHover, false);
    this.domHover = null;
    if (this.domCursorSet && this.domCanvas) { this.domCanvas.style.cursor = ''; this.domCursorSet = false; }
    this.options.onRoomHover?.(null, null);
  };

  private readonly onDomDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.domCanvas) return;
    const p = this.domPoint(e);
    this.domDown = { x: p.x, y: p.y, roomId: this.roomAtScreen(p.x, p.y)?.spec.id ?? null };
  };

  private readonly onDomUp = (e: PointerEvent): void => {
    const down = this.domDown;
    this.domDown = null;
    if (!down || e.button !== 0 || !this.domCanvas || !this.options.onRoomClick) return;
    const p = this.domPoint(e);
    if (Math.hypot(p.x - down.x, p.y - down.y) > 6) return; // a pan, not a click
    const room = this.roomAtScreen(p.x, p.y);
    if (!room || room.spec.id !== down.roomId) return;
    if (this.domBlockClick && this.domToWorld && this.domBlockClick(this.domToWorld(p.x, p.y))) return;
    gsap.fromTo(room.highlight, { alpha: 0.3 }, { alpha: room.active ? 0.12 : 0, duration: 0.45, ease: 'power2.out' });
    this.options.onRoomClick(room.spec);
  };

  // ── Building ───────────────────────────────────────────────────────────

  private buildRoom(placed: PlacedRoom, animate: boolean): void {
    const { spec } = placed;
    const tiles = ROOM_TILES[spec.size];
    const accent = spec.accent;
    const container = new PIXI.Container();
    container.sortableChildren = true;
    const center = this.cell(placed.c + tiles / 2, placed.r + tiles / 2);
    container.position.copyFrom(center);
    // Depth-sort rooms by their centre so a south room's slab overlaps a north one correctly.
    container.zIndex = center.y;

    // Platform slab (centred on local origin)
    const platform = buildPlatform(this.renderer, tiles, tiles, { trim: true, trimAlpha: 0.75, sideDepth: 26 });
    container.addChild(platform.container);

    const pTop = this.cell(placed.c, placed.r);
    const pRight = this.cell(placed.c + tiles, placed.r);
    const pBottom = this.cell(placed.c + tiles, placed.r + tiles);
    const pLeft = this.cell(placed.c, placed.r + tiles);
    const poly = [pTop.x, pTop.y, pRight.x, pRight.y, pBottom.x, pBottom.y, pLeft.x, pLeft.y];
    const localPoly = poly.map((v, i) => (i % 2 === 0 ? v - center.x : v - center.y));

    // Accent floor tint + inner hairline (the platform's own trim stays gold,
    // so the room reads as part of the station with a plugin-coloured wash).
    const tint = new PIXI.Graphics();
    tint.beginFill(accent, 0.1);
    tint.drawPolygon(localPoly);
    tint.endFill();
    const inset = localPoly.map((v) => v * 0.9);
    tint.lineStyle(1.5, accent, 0.55);
    tint.drawPolygon(inset);
    tint.lineStyle(0);
    // Corner studs in the accent
    for (let i = 0; i < 8; i += 2) {
      tint.beginFill(accent, 0.9);
      tint.drawRect(inset[i] - 2, inset[i + 1] - 2, 4, 4);
      tint.endFill();
    }
    container.addChild(tint);

    // Hover/active glow
    const highlight = new PIXI.Graphics();
    highlight.beginFill(accent, 1);
    highlight.drawPolygon(localPoly);
    highlight.endFill();
    highlight.alpha = 0;
    container.addChild(highlight);

    // Props (depth sorted within the room)
    const decorLayer = new PIXI.Container();
    decorLayer.sortableChildren = true;
    const propPoints: PIXI.Point[] = [];
    const sprites: PIXI.Sprite[] = [];
    for (const item of spec.decor) {
      const tex = (this.textures as unknown as Record<string, PIXI.RenderTexture>)[item.t];
      if (!tex) continue;
      const sprite = new PIXI.Sprite(tex);
      sprite.anchor.set(0.5, 1);
      if (item.s) sprite.scale.set(item.s);
      const p = this.cell(placed.c + item.c, placed.r + item.r);
      sprite.position.set(p.x - center.x, p.y - center.y + TILE_H / 2);
      sprite.zIndex = sprite.y;
      decorLayer.addChild(sprite);
      sprites.push(sprite);
      propPoints.push(new PIXI.Point(p.x, p.y + TILE_H / 2));
    }
    container.addChild(decorLayer);

    // Monogram sign: a holo plate on a beam at the east or west corner stud —
    // no theme furnishes the corners (a sign hung at the back edge disappears
    // behind back-wall props such as a big display or ticker board). The
    // corner is chosen per room by placeSign(): the one farthest from every
    // HUD title anchor (neighbour rooms, the HQ title, the Executive Suite
    // pad), because those labels are counter-scaled and grow at low zoom.
    // Drawn in front of the props: it is a hologram, and it must always be
    // legible. Faded out below SIGN_ZOOM_HIDE (see setZoom).
    const signWrap = new PIXI.Container();
    signWrap.zIndex = 1e6;
    signWrap.alpha = this.signZoomAlpha;
    const sign = buildMonogramSign(spec.monogram, accent);
    signWrap.addChild(sign);
    container.addChild(signWrap);

    // Crisp HUD label at the top vertex. Plugin rooms rest brighter than the
    // core sectors: their titles hang over the ring gap and the neighbour's
    // floor, and at the core's 0.25 idle alpha they read as covered.
    const label = new ZoneLabel(spec.title, spec.subtitle, { idleAlpha: PLUGIN_LABEL_IDLE_ALPHA });
    label.container.position.set(pTop.x, pTop.y - 2);
    this.labelLayer.addChild(label.container);

    // Workstation slots (seats first, then open floor)
    const workSlots = computeWorkSlots({ w: tiles, h: tiles }, spec.decor, { max: spec.size === 'L' ? 12 : spec.size === 'S' ? 6 : 9 }).map((s) => {
      const p = this.cell(placed.c + s.c, placed.r + s.r);
      return new PIXI.Point(p.x, p.y);
    });

    const room: DistrictRoom = {
      spec, placed, center, poly, workSlots, label, container, highlight,
      hover: false, active: false, breath: null, propPoints,
      tweenTargets: [container, sign, signWrap, label.container, highlight, ...sprites.map((sp) => sp.scale)],
      signWrap, sign, signCorner: null, signBob: null,
    };

    // Hover/click are DOM-driven (attachDom): Pixi's interaction manager does
    // not receive pointer events on every host surface (the /mesh page), so a
    // point-in-polygon test on the canvas is the one path that works everywhere.
    this.roomsLayer.addChild(container);
    this.rooms.set(spec.id, room);

    // Build-in: slab rises + fades in, props pop with a stagger, label fades.
    if (animate && !this.options.reducedMotion) {
      container.alpha = 0;
      container.y = center.y + 36;
      gsap.to(container, { alpha: 1, y: center.y, duration: BUILD_MS, ease: 'back.out(1.4)' });
      sprites.forEach((s, i) => {
        const sy = s.scale.y;
        s.scale.set(s.scale.x, 0.01);
        gsap.to(s.scale, { y: sy, duration: 0.42, delay: 0.25 + i * 0.05, ease: 'back.out(2)' });
      });
      sign.alpha = 0;
      gsap.to(sign, { alpha: 1, duration: 0.5, delay: 0.5 });
      label.container.alpha = 0;
      gsap.to(label.container, { alpha: 1, duration: 0.5, delay: 0.4 });
    }
  }

  private dissolveRoom(id: string, animate: boolean): void {
    const room = this.rooms.get(id);
    if (!room) return;
    this.rooms.delete(id);
    if (this.domHover === room) { this.domHover = null; this.options.onRoomHover?.(null, null); }
    room.breath?.kill();
    room.signBob?.kill();
    room.signBob = null;
    // Kill every tween that could still be driving this room (build-in rise,
    // prop pops, sign bob, glow) BEFORE destroying anything: a tween that
    // outlives its Pixi target throws "reading 'position' of null" each frame.
    for (const t of room.tweenTargets) gsap.killTweensOf(t);
    room.label.killTweens();
    const finish = () => {
      for (const t of room.tweenTargets) gsap.killTweensOf(t);
      if (room.label.container.parent) room.label.container.parent.removeChild(room.label.container);
      room.label.container.destroy({ children: true });
      if (room.container.parent) room.container.parent.removeChild(room.container);
      room.container.destroy({ children: true });
    };
    if (animate && !this.options.reducedMotion && !this.destroyed) {
      gsap.to(room.label.container, { alpha: 0, duration: 0.3 });
      gsap.to(room.container, { alpha: 0, y: room.container.y + 30, duration: DISSOLVE_MS, ease: 'power2.in', onComplete: finish });
    } else {
      finish();
    }
  }

  private setHover(room: DistrictRoom, hover: boolean): void {
    if (room.hover === hover) return;
    room.hover = hover;
    this.applyVisual(room);
    room.label.setHover(hover);
  }

  private applyVisual(room: DistrictRoom): void {
    room.breath?.kill();
    room.breath = null;
    if (room.active) {
      const lo = room.hover ? 0.14 : 0.09;
      const hi = room.hover ? 0.26 : 0.2;
      room.highlight.alpha = lo;
      room.breath = gsap.to(room.highlight, { alpha: hi, duration: 1.2, yoyo: true, repeat: -1, ease: 'sine.inOut' });
    } else {
      gsap.to(room.highlight, { alpha: room.hover ? 0.1 : 0, duration: 0.2 });
    }
    room.label.setActive(room.active);
  }

  // ── Monogram signs ─────────────────────────────────────────────────────

  private signZoomAlpha = 1;

  /** Per frame from the engine: fade the signs with the viewport zoom. */
  setZoom(zoom: number): void {
    const a = Math.max(0, Math.min(1, (zoom - SIGN_ZOOM_HIDE) / (SIGN_ZOOM_FULL - SIGN_ZOOM_HIDE)));
    if (a === this.signZoomAlpha) return;
    this.signZoomAlpha = a;
    for (const room of this.rooms.values()) {
      room.signWrap.alpha = a;
      room.signWrap.visible = a > 0.01;
    }
  }

  /** World points every HUD title hangs from: room top vertices, the HQ
   *  title (core top vertex) and the reserved pads' top vertices. */
  private titleAnchors(except: string): PIXI.Point[] {
    const out: PIXI.Point[] = [this.cell(0, 0)];
    for (const res of RESERVED_RECTS) out.push(this.cell(res.c, res.r));
    for (const room of this.rooms.values()) {
      if (room.spec.id === except) continue;
      out.push(this.cell(room.placed.c, room.placed.r));
    }
    return out;
  }

  /**
   * Hang the sign at the corner (east or west) farthest from every title
   * anchor. Titles sit ABOVE their anchor, so the distance is measured to a
   * point 40px above it. Moves an existing sign (tweened) when the best
   * corner changes after a re-plan; restarts the idle bob at the new spot.
   */
  private placeSign(room: DistrictRoom, animate: boolean): void {
    const { placed, spec, center } = room;
    const tiles = ROOM_TILES[spec.size];
    const corners: Array<{ id: 'east' | 'west'; at: PIXI.Point }> = [
      { id: 'east', at: this.cell(placed.c + tiles - 0.5, placed.r + 0.5) },
      { id: 'west', at: this.cell(placed.c + 0.5, placed.r + tiles - 0.5) },
    ];
    const anchors = this.titleAnchors(spec.id);
    const score = (p: PIXI.Point) => {
      const sy = p.y - SIGN_LIFT - 10;
      let best = Infinity;
      for (const a of anchors) best = Math.min(best, Math.hypot(p.x - a.x, sy - (a.y - 40)));
      return best;
    };
    const east = score(corners[0].at), west = score(corners[1].at);
    // Prefer the east corner unless the west one is clearly freer (hysteresis
    // so a re-plan doesn't flip a sign for a few pixels).
    const pick = room.signCorner === 'west'
      ? (east > west + 24 ? corners[0] : corners[1])
      : (west > east + 24 ? corners[1] : corners[0]);
    if (room.signCorner === pick.id) return;
    room.signCorner = pick.id;
    const x = pick.at.x - center.x;
    const y = pick.at.y - center.y - SIGN_LIFT - 10;
    room.signBob?.kill();
    gsap.killTweensOf(room.sign, 'x,y'); // keep the build-in alpha fade alive
    const startBob = () => {
      room.signBob = gsap.to(room.sign, { y: y - 4, duration: 2.2 + hashSeed(spec.id), yoyo: true, repeat: -1, ease: 'sine.inOut' });
    };
    if (animate && !this.options.reducedMotion && !this.destroyed) {
      gsap.to(room.sign, { x, y, duration: 0.6, ease: 'power2.inOut', onComplete: startBob });
    } else {
      room.sign.position.set(x, y);
      startBob();
    }
  }

  // ── Conduits ───────────────────────────────────────────────────────────

  private drawConduits(): void {
    const g = this.conduitG;
    g.clear();
    if (this.rooms.size === 0) {
      if (this.gateSprite) { this.gateSprite.destroy(); this.gateSprite = null; }
      return;
    }
    const segs = districtConduits([...this.rooms.values()].map((r) => r.placed));
    for (const seg of segs) {
      const a = this.cell(seg.a.c, seg.a.r);
      const b = this.cell(seg.b.c, seg.b.r);
      if (seg.kind === 'loop') {
        g.lineStyle(1.5, GALACTIC.gold, 0.28);
        drawDashedLine(g, a.x, a.y, b.x, b.y, 10, 10);
      } else if (seg.kind === 'spoke') {
        g.lineStyle(1.5, GALACTIC.gold, 0.3);
        drawDashedLine(g, a.x, a.y, b.x, b.y, 10, 8);
      } else if (seg.kind === 'trunk') {
        g.lineStyle(2.5, GALACTIC.goldLt, 0.65);
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
      } else {
        const room = seg.roomId ? this.rooms.get(seg.roomId) : undefined;
        const accent = room?.spec.accent ?? GALACTIC.gold;
        g.lineStyle(2, accent, 0.6);
        drawDashedLine(g, a.x, a.y, b.x, b.y, 8, 6);
        // Docking pad where the stub meets the loop
        g.lineStyle(0);
        g.beginFill(accent, 0.85);
        g.drawCircle(b.x, b.y, 2.5);
        g.endFill();
      }
      g.lineStyle(0);
    }
    // Loop junction nodes at the corners
    const corners = segs.filter((s) => s.kind === 'loop').map((s) => this.cell(s.a.c, s.a.r));
    for (const c of corners) {
      g.beginFill(GALACTIC.gold, 0.7);
      g.drawCircle(c.x, c.y, 2.2);
      g.endFill();
    }
    // District gate: an arch where the trunk leaves the Gateway Concourse
    if (!this.gateSprite) {
      const gate = new PIXI.Sprite(this.textures.gateArch);
      gate.anchor.set(0.5, 1);
      gate.scale.set(0.85);
      const p = this.cell(CONCOURSE_GATE.c, CONCOURSE_GATE.r + 0.9);
      gate.position.set(p.x, p.y + TILE_H / 2);
      gate.zIndex = -1e9;
      this.roomsLayer.addChild(gate);
      this.gateSprite = gate;
    }
  }
}
