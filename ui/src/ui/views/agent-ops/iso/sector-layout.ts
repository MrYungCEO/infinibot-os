/**
 * Galactic HQ sector floorplan (Phase 2 of the design,
 * docs/design/galactic-hq-activity-map.md).
 *
 * The station is a FIXED floorplan: each zone maps 1:1 to a real InfiniBot
 * subsystem, so the map reads as an honest systems diagram. Zones never
 * move — spatial memory matters. Every zone is decorated with themed
 * procedural props, carries a crisp HUD label (in a separate label layer
 * the map renders above the world), and supports hover highlights plus a
 * breathing glow when its sector is active.
 */

import * as PIXI from 'pixi.js';
import gsap from 'gsap';

import { GALACTIC } from './galactic-theme';
import { TILE_W, TILE_H } from './projection';
import {
  buildPlatform,
  bakeGalacticTextures,
  drawDashedLine,
  type GalacticTextures,
} from './galactic-assets';
import { ZoneLabel } from './hud';
import { computeWorkSlots, WORK_SECTOR_IDS } from './agent-spread';

// ════════════════════════════════════════════════════════════════
// SECTOR REGISTRY
// ════════════════════════════════════════════════════════════════

export { STATION_GRID, SECTORS, type SectorDef } from './sector-defs';
import type { SectorDef } from './sector-defs';
import { SECTORS, STATION_GRID } from './sector-defs';

/** Themed props per zone, in zone-relative tile coords. */
interface DecorItem {
  t: keyof GalacticTextures;
  c: number;
  r: number;
  s?: number;
}

const DECOR: Record<string, DecorItem[]> = {
  'observatory': [
    { t: 'telescope', c: 4.8, r: 1.8 },
    { t: 'holoTable', c: 2.6, r: 3.2 },
    { t: 'desk', c: 2, r: 5.4 },
    { t: 'crystal', c: 6.4, r: 1.6 },
    { t: 'plantHolo', c: 6.2, r: 5.2 },
    { t: 'crate', c: 5.2, r: 6.2 },
  ],
  'mission-control': [
    { t: 'bigDisplay', c: 4, r: 1.4 },
    { t: 'consoleWide', c: 2.6, r: 4 },
    { t: 'consoleWide', c: 5.2, r: 4.6 },
    { t: 'desk', c: 1.6, r: 5.8 },
    { t: 'plantHolo', c: 6.6, r: 2 },
  ],
  'comms-deck': [
    { t: 'antenna', c: 5.6, r: 1.4 },
    { t: 'commsBoard', c: 3, r: 1.8 },
    { t: 'desk', c: 2, r: 4.4 },
    { t: 'desk', c: 4, r: 5.2 },
    { t: 'speaker', c: 6.4, r: 3.4 },
    { t: 'crate', c: 6, r: 5.6 },
  ],
  'command-atrium': [
    { t: 'holoTable', c: 4, r: 4, s: 1.35 },
    { t: 'pedestal', c: 1.6, r: 1.6 },
    { t: 'pedestal', c: 6.4, r: 1.6 },
    { t: 'crystal', c: 1.6, r: 6.4 },
    { t: 'crystal', c: 6.4, r: 6.4 },
    { t: 'plantHolo', c: 4, r: 1.2 },
  ],
  'broadcast-studio': [
    { t: 'bigDisplay', c: 4, r: 0.9 },
    { t: 'micBooth', c: 2.6, r: 2.4 },
    { t: 'speaker', c: 5.4, r: 2.2 },
    { t: 'speaker', c: 6.2, r: 2.7 },
    { t: 'couch', c: 1.6, r: 3 },
  ],
  'the-vault': [
    { t: 'vaultDoor', c: 4, r: 0.9 },
    { t: 'gateArch', c: 4, r: 2.9 },
    { t: 'safe', c: 1.8, r: 2 },
    { t: 'safe', c: 2.6, r: 2.7 },
    { t: 'ingots', c: 5.8, r: 2.1 },
    { t: 'ingots', c: 6.4, r: 2.7 },
  ],
  'engineering-bay': [
    { t: 'server', c: 1.6, r: 1.4 },
    { t: 'server', c: 3.0, r: 1.4 },
    { t: 'server', c: 4.4, r: 1.4 },
    { t: 'roboArm', c: 6, r: 2 },
    { t: 'desk', c: 2.4, r: 4.6 },
    { t: 'crate', c: 5.4, r: 4.8 },
    { t: 'crate', c: 6.2, r: 5.6 },
    { t: 'plantHolo', c: 1.4, r: 6.2 },
  ],
  // Gateway Concourse doubles as the fleet rest area: a grid of beds (added
  // programmatically in buildStationComplex so their world slots can be handed
  // to the engine) plus a couple of arches + a plant for flavour.
  'gateway-concourse': [
    { t: 'gateArch', c: 0.9, r: 0.9 },
    { t: 'plantHolo', c: 7.0, r: 7.0 },
  ],
  'canvas-atrium': [
    { t: 'easel', c: 2, r: 2 },
    { t: 'easel', c: 4, r: 3 },
    { t: 'easel', c: 6, r: 2 },
    { t: 'pedestal', c: 2.4, r: 4.8 },
    { t: 'pedestal', c: 4.6, r: 5.6 },
    { t: 'holoTable', c: 6.2, r: 4.4, s: 0.8 },
    { t: 'plantHolo', c: 6.6, r: 6.2 },
  ],
  // agent-quarters gets live agent offices when a hub node is present,
  // plus a base layer of static decor so the sector reads as populated
  // even before the federation snapshot arrives.
  'agent-quarters': [
    { t: 'desk', c: 1.6, r: 1.6 },
    { t: 'desk', c: 3.4, r: 1.6 },
    { t: 'desk', c: 5.4, r: 1.6 },
    { t: 'consoleWide', c: 2.4, r: 4 },
    { t: 'consoleWide', c: 5.2, r: 4 },
    { t: 'crate', c: 6.4, r: 6 },
    { t: 'plantHolo', c: 1.4, r: 6.4 },
  ],
};

// ════════════════════════════════════════════════════════════════
// RUNTIME TYPES
// ════════════════════════════════════════════════════════════════

export interface ZoneRuntime {
  def: SectorDef;
  /** World-space center of the zone. */
  center: PIXI.Point;
  /** World-space diamond outline (flat point array). */
  poly: number[];
  label: ZoneLabel;
}

interface ZoneState extends ZoneRuntime {
  highlight: PIXI.Graphics;
  hover: boolean;
  active: boolean;
  touchPointers: Set<string>;
  touchOutTimer: ReturnType<typeof setTimeout> | null;
  breath: gsap.core.Tween | null;
}

export interface StationComplex {
  container: PIXI.Container;
  /** Crisp labels — the map adds this ABOVE the node layer and counter-scales its children. */
  labelLayer: PIXI.Container;
  zones: ZoneRuntime[];
  /** Layer for light bridges; sits UNDER the platform so line ends hide. */
  bridgeLayer: PIXI.Container;
  /** World-space anchors for satellite pods, in assignment order. */
  podAnchors: PIXI.Point[];
  /** World-space office slot centers inside Agent Quarters. */
  agentQuartersSlots: PIXI.Point[];
  /** World-space center of Agent Quarters (hub node plaque position). */
  agentQuartersCenter: PIXI.Point;
  /** World-space bed slots in the Gateway Concourse, in fill order. Idle agents
   *  glide here and park on a free bed (engine: routeAgentToConcourse). */
  concourseBedSlots: PIXI.Point[];
  /** World-space center of the Gateway Concourse rest area. */
  concourseCenter: PIXI.Point;
  /** World-space workstation slots per work sector (agent-spread.ts). */
  sectorWorkSlots: Record<string, PIXI.Point[]>;
  /** World-space center of the Command Atrium (bridge target). */
  atriumCenter: PIXI.Point;
  /** World-space center of the Executive Suite pad (review station). */
  executiveCenter: PIXI.Point;
  /** World-space bounds of the whole complex, for zoom-to-fit. */
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  /** Toggle the breathing "sector active" glow + label dot for a zone. */
  setZoneActive(sectorId: string, active: boolean): void;
  /** Show/hide every sector text label without changing per-label hover state. */
  setSectorLabelsVisible(visible: boolean): void;
  /** Advance shared per-frame label fade animation. */
  updateLabelAlphas(deltaMS: number): void;
  /** Kill all tweens and destroy the display objects (for theme rebuilds). */
  destroy(): void;
}

export interface StationComplexOptions {
  centerX: number;
  centerY: number;
  onZoneClick?: (sector: SectorDef) => void;
}

// ════════════════════════════════════════════════════════════════
// BUILDER
// ════════════════════════════════════════════════════════════════

function applyZoneVisual(zone: ZoneState): void {
  zone.breath?.kill();
  zone.breath = null;
  if (zone.active) {
    const lo = zone.hover ? 0.12 : 0.08;
    const hi = zone.hover ? 0.24 : 0.18;
    zone.highlight.alpha = lo;
    zone.breath = gsap.to(zone.highlight, { alpha: hi, duration: 1.2, yoyo: true, repeat: -1, ease: 'sine.inOut' });
  } else {
    gsap.to(zone.highlight, { alpha: zone.hover ? 0.08 : 0, duration: 0.2 });
  }
  zone.label.setActive(zone.active);
}

function readPointerType(event: unknown): string | undefined {
  const e = event as { pointerType?: string; data?: { pointerType?: string } };
  return e.data?.pointerType ?? e.pointerType;
}

function readPointerId(event: unknown): string {
  const e = event as {
    pointerId?: string | number;
    identifier?: string | number;
    data?: { pointerId?: string | number; identifier?: string | number };
  };
  return String(e.data?.pointerId ?? e.data?.identifier ?? e.pointerId ?? e.identifier ?? 'touch');
}

function setZoneHover(zone: ZoneState, hover: boolean): void {
  if (zone.hover === hover) return;
  zone.hover = hover;
  applyZoneVisual(zone);
  zone.label.setHover(hover);
}

function scheduleTouchHoverOff(zone: ZoneState): void {
  if (zone.touchOutTimer) clearTimeout(zone.touchOutTimer);
  zone.touchOutTimer = setTimeout(() => {
    zone.touchOutTimer = null;
    if (zone.touchPointers.size === 0) setZoneHover(zone, false);
  }, 180);
}

export function buildStationComplex(
  renderer: PIXI.Renderer | PIXI.AbstractRenderer,
  options: StationComplexOptions,
): StationComplex {
  const textures = bakeGalacticTextures(renderer);
  const { cols, rows } = STATION_GRID;
  const { centerX, centerY } = options;

  const container = new PIXI.Container();
  const labelLayer = new PIXI.Container();
  const tweens: gsap.core.Tween[] = [];

  // World-space projection of a station grid cell
  const ox = centerX - ((cols - rows) * TILE_W) / 4;
  const oy = centerY - ((cols + rows) * TILE_H) / 4;
  const cell = (c: number, r: number) =>
    new PIXI.Point(ox + ((c - r) * TILE_W) / 2, oy + ((c + r) * TILE_H) / 2);

  // ── Nebula wash ─────────────────────────────────────────────────
  const nebula = new PIXI.Graphics();
  nebula.beginFill(GALACTIC.nebula, 0.35);
  nebula.drawEllipse(centerX, centerY, ((cols + rows) * TILE_W) / 2 * 0.95, ((cols + rows) * TILE_H) / 2 * 1.05);
  nebula.endFill();
  container.addChild(nebula);

  // ── Light-bridge layer (under platforms) ────────────────────────
  const bridgeLayer = new PIXI.Container();
  container.addChild(bridgeLayer);

  // ── Main platform ───────────────────────────────────────────────
  const platform = buildPlatform(renderer, cols, rows, { seamEvery: 0, trim: true });
  platform.container.position.set(centerX, centerY);
  container.addChild(platform.container);

  // ── Zones: border + highlight + decor + label + interactivity ───
  const zones: ZoneState[] = [];
  const zoneGraphics = new PIXI.Graphics();
  container.addChild(zoneGraphics);

  // Floor highlights live under the decor
  const highlightLayer = new PIXI.Container();
  container.addChild(highlightLayer);

  // Decor sits above highlights, depth-sorted within itself
  const decorLayer = new PIXI.Container();
  decorLayer.sortableChildren = true;
  container.addChild(decorLayer);

  for (const def of SECTORS) {
    const pTop = cell(def.c, def.r);
    const pRight = cell(def.c + def.w, def.r);
    const pBottom = cell(def.c + def.w, def.r + def.h);
    const pLeft = cell(def.c, def.r + def.h);
    const center = cell(def.c + def.w / 2, def.r + def.h / 2);
    const poly = [pTop.x, pTop.y, pRight.x, pRight.y, pBottom.x, pBottom.y, pLeft.x, pLeft.y];

    // Zone border (hairline)
    zoneGraphics.lineStyle(1, GALACTIC.goldDp, 0.45);
    zoneGraphics.drawPolygon(poly);
    zoneGraphics.lineStyle(0);

    // Hover/active floor glow
    const highlight = new PIXI.Graphics();
    highlight.beginFill(GALACTIC.gold, 1);
    highlight.drawPolygon(poly);
    highlight.endFill();
    highlight.alpha = 0;
    highlightLayer.addChild(highlight);

    // Themed props
    for (const item of DECOR[def.id] ?? []) {
      const sprite = new PIXI.Sprite(textures[item.t]);
      sprite.anchor.set(0.5, 1);
      if (item.s) sprite.scale.set(item.s);
      const p = cell(def.c + item.c, def.r + item.r);
      sprite.position.set(p.x, p.y + TILE_H / 2);
      sprite.zIndex = sprite.y;
      decorLayer.addChild(sprite);
    }

    // Crisp HUD label anchored to the zone's top vertex
    const label = new ZoneLabel(def.name, def.system);
    label.container.position.set(pTop.x, pTop.y - 2);
    labelLayer.addChild(label.container);

    const zone: ZoneState = {
      def,
      center,
      poly,
      label,
      highlight,
      hover: false,
      active: false,
      touchPointers: new Set(),
      touchOutTimer: null,
      breath: null,
    };

    // Interactivity: hover highlight + optional click
    const hit = new PIXI.Graphics();
    hit.beginFill(0xffffff, 0.001);
    hit.drawPolygon(poly);
    hit.endFill();
    (hit as any).interactive = true;
    if (options.onZoneClick) (hit as any).buttonMode = true;
    (hit as any).on('pointerover', () => {
      setZoneHover(zone, true);
    });
    (hit as any).on('pointerout', () => {
      if (zone.touchPointers.size === 0) setZoneHover(zone, false);
    });
    (hit as any).on('pointerdown', (event: unknown) => {
      if (readPointerType(event) !== 'touch') return;
      if (zone.touchOutTimer) {
        clearTimeout(zone.touchOutTimer);
        zone.touchOutTimer = null;
      }
      zone.touchPointers.add(readPointerId(event));
      setZoneHover(zone, true);
    });
    const releaseTouchHover = (event: unknown) => {
      if (readPointerType(event) !== 'touch') return;
      zone.touchPointers.delete(readPointerId(event));
      if (zone.touchPointers.size === 0) scheduleTouchHoverOff(zone);
    };
    (hit as any).on('pointerup', releaseTouchHover);
    (hit as any).on('pointerupoutside', releaseTouchHover);
    (hit as any).on('pointercancel', releaseTouchHover);
    if (options.onZoneClick) {
      (hit as any).on('pointerdown', () => {
        // Click flash
        gsap.fromTo(highlight, { alpha: 0.26 }, { alpha: zone.active ? 0.1 : 0, duration: 0.45, ease: 'power2.out' });
        options.onZoneClick!(zone.def);
      });
    }
    container.addChild(hit);

    zones.push(zone);
  }

  // ── Gateway Concourse rest area: a grid of beds idle agents glide to ──
  // 16 beds (4×4) — comfortably more than the 12 simultaneous resters the
  // engine plans for. Slots are world-space so the engine can route agents
  // straight onto a bed and have them lie at full size (no shrink-in-place).
  const concourse = SECTORS.find(s => s.id === 'gateway-concourse')!;
  const concourseBedSlots: PIXI.Point[] = [];
  {
    const cols = 4, rows = 4;
    const inset = 1.5;                               // keep beds off the zone border
    const stepC = (concourse.w - inset * 2) / (cols - 1);
    const stepR = (concourse.h - inset * 2) / (rows - 1);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const gc = concourse.c + inset + c * stepC;
        const gr = concourse.r + inset + r * stepR;
        const p = cell(gc, gr);
        const bed = new PIXI.Sprite(textures.bed);
        bed.anchor.set(0.5, 1);
        bed.scale.set(0.72);
        bed.position.set(p.x, p.y + TILE_H / 2);
        bed.zIndex = p.y;
        decorLayer.addChild(bed);
        // Park point: where the agent lies down (a touch above the bed foot).
        concourseBedSlots.push(new PIXI.Point(p.x, p.y - 2));
      }
    }
  }

  // ── Workstation slots: seats at each sector's desks/consoles, then open
  // floor, so working agents sit at distinct desks (engine: agent spread).
  const sectorWorkSlots: Record<string, PIXI.Point[]> = {};
  for (const def of SECTORS) {
    if (!WORK_SECTOR_IDS.includes(def.id)) continue;
    sectorWorkSlots[def.id] = computeWorkSlots(def, DECOR[def.id] ?? []).map(s => {
      const p = cell(def.c + s.c, def.r + s.r);
      return new PIXI.Point(p.x, p.y);
    });
  }

  // ── Atrium ring: slow-rotating segmented halo ───────────────────
  const atrium = zones.find(z => z.def.id === 'command-atrium')!;
  const ringWrap = new PIXI.Container();
  ringWrap.position.copyFrom(atrium.center);
  ringWrap.scale.y = 0.5; // iso foreshortening
  const ringR = TILE_W * 1.9;
  const ringInner = new PIXI.Graphics();
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * Math.PI * 2;
    ringInner.lineStyle(2.5, GALACTIC.goldLt, 0.4);
    ringInner.arc(0, 0, ringR, a0 + 0.08, a0 + (Math.PI / 4) - 0.08);
    ringInner.lineStyle(0);
  }
  // Radial ticks
  ringInner.lineStyle(1, GALACTIC.gold, 0.3);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ringInner.moveTo(Math.cos(a) * (ringR - 10), Math.sin(a) * (ringR - 10));
    ringInner.lineTo(Math.cos(a) * (ringR - 2), Math.sin(a) * (ringR - 2));
  }
  ringInner.lineStyle(0);
  ringWrap.addChild(ringInner);
  const ringInner2 = new PIXI.Graphics();
  ringInner2.lineStyle(1, GALACTIC.gold, 0.22);
  ringInner2.drawCircle(0, 0, ringR * 0.78);
  ringInner2.lineStyle(0);
  ringWrap.addChild(ringInner2);
  container.addChild(ringWrap);
  tweens.push(gsap.to(ringInner, { rotation: Math.PI * 2, duration: 28, repeat: -1, ease: 'none' }));
  tweens.push(gsap.to(ringInner2, { rotation: -Math.PI * 2, duration: 40, repeat: -1, ease: 'none' }));

  // ── Executive Suite: small elevated pad off the NE edge ─────────
  const execCenter = new PIXI.Point(centerX + 640, centerY - 330);
  const execPad = buildPlatform(renderer, 6, 6, { trim: true, trimAlpha: 0.7, sideDepth: 40 });
  execPad.container.position.copyFrom(execCenter);
  container.addChild(execPad.container);

  // Executive furniture
  for (const item of [
    { t: 'consoleWide' as const, x: -16, y: 0, s: 1.15 },
    { t: 'couch' as const, x: 70, y: 42, s: 1 },
    { t: 'pedestal' as const, x: -96, y: 30, s: 1 },
    { t: 'plantHolo' as const, x: 10, y: 64, s: 1 },
  ]) {
    const sprite = new PIXI.Sprite(textures[item.t]);
    sprite.anchor.set(0.5, 1);
    sprite.scale.set(item.s);
    sprite.position.set(execCenter.x + item.x, execCenter.y + item.y);
    container.addChild(sprite);
  }

  const execLabel = new ZoneLabel('EXECUTIVE SUITE', 'business + crm');
  execLabel.container.position.set(execCenter.x, execCenter.y - execPad.height / 2 - 6);
  labelLayer.addChild(execLabel.container);

  // Bridge from the executive pad down to the platform's NE edge
  const execBridge = new PIXI.Graphics();
  execBridge.lineStyle(2, GALACTIC.gold, 0.5);
  const neEdge = cell(18, 0);
  drawDashedLine(execBridge, execCenter.x, execCenter.y, neEdge.x, neEdge.y);
  execBridge.lineStyle(0);
  bridgeLayer.addChild(execBridge);

  // ── Station sign ────────────────────────────────────────────────
  const top = cell(0, 0);
  const hqLabel = new ZoneLabel('INFINIBOT HQ', 'galactic operations', { titleSize: 17 });
  hqLabel.container.position.set(top.x, top.y - 36);
  labelLayer.addChild(hqLabel.container);
  tweens.push(gsap.to(hqLabel.container, { y: hqLabel.container.y - 6, duration: 2.4, yoyo: true, repeat: -1, ease: 'sine.inOut' }));

  // ── Agent Quarters office slots (2×2 of 4×4 pads fills the zone) ─
  const aq = SECTORS.find(s => s.id === 'agent-quarters')!;
  const agentQuartersSlots: PIXI.Point[] = [];
  for (const sr of [aq.r + 2.2, aq.r + 5.8]) {
    for (const sc of [aq.c + 2.2, aq.c + 5.8]) {
      agentQuartersSlots.push(cell(sc, sr));
    }
  }

  // ── Pod anchors for satellite (federation) nodes ────────────────
  // Mirror the Executive Suite's offset (+640, -330) onto the south
  // half of the platform: same radial distance from center, inverted
  // vertically so the satellites sit below the HQ instead of flying
  // off into the upper void. Two primary anchors flank the south edge
  // at (±640, +330); two secondaries sit just outside them for the
  // 3rd/4th federation peers — still within the auto-fit frame.
  // Satellite federation peers sit on the SOUTH side of the HQ
  // platform — far enough off the platform's south corner that their
  // 16×16 mini-HQ footprints (≈ 512×256) don't overlap with the main
  // 24×24 station, but close enough that the auto-fit camera keeps
  // both in frame on a typical 16:9 panel. The HQ south corner is at
  // (centerX, centerY+384); anchors sit ~720 units further south and
  // are spaced 1100 apart horizontally so adjacent satellite islands
  // never clip each other.
  const SAT_DX = 550;
  const SAT_DY_PRIMARY = 1100;
  const SAT_DY_SECONDARY = 1480;
  const podAnchors = [
    new PIXI.Point(centerX + SAT_DX, centerY + SAT_DY_PRIMARY),
    new PIXI.Point(centerX - SAT_DX, centerY + SAT_DY_PRIMARY),
    new PIXI.Point(centerX + SAT_DX + 350, centerY + SAT_DY_SECONDARY),
    new PIXI.Point(centerX - SAT_DX - 350, centerY + SAT_DY_SECONDARY),
  ];

  // Bounds frame the HQ + first-row satellites only. zoomToFit also
  // unions live node positions, so a 2nd-row satellite (if it shows
  // up) will pull the camera further south on its own — the static
  // bounds shouldn't pre-allocate that space, or the HQ gets cut
  // off at the top when only first-row satellites are present.
  const bounds = {
    minX: centerX - SAT_DX - 280,
    maxX: centerX + SAT_DX + 280,
    minY: centerY - 330 - execPad.height / 2 - 90,
    maxY: centerY + SAT_DY_PRIMARY + 260,
  };

  return {
    container,
    labelLayer,
    zones,
    bridgeLayer,
    podAnchors,
    agentQuartersSlots,
    agentQuartersCenter: zones.find(z => z.def.id === 'agent-quarters')!.center,
    concourseBedSlots,
    sectorWorkSlots,
    concourseCenter: zones.find(z => z.def.id === 'gateway-concourse')!.center,
    atriumCenter: atrium.center,
    executiveCenter: execCenter.clone(),
    bounds,
    setZoneActive(sectorId: string, active: boolean): void {
      const zone = zones.find(z => z.def.id === sectorId);
      if (!zone || zone.active === active) return;
      zone.active = active;
      applyZoneVisual(zone);
    },
    setSectorLabelsVisible(visible: boolean): void {
      labelLayer.visible = visible;
    },
    updateLabelAlphas(deltaMS: number): void {
      for (const zone of zones) zone.label.updateLabelAlpha(deltaMS);
      execLabel.updateLabelAlpha(deltaMS);
      hqLabel.updateLabelAlpha(deltaMS);
    },
    destroy(): void {
      for (const tween of tweens) tween.kill();
      for (const zone of zones) {
        if (zone.touchOutTimer) clearTimeout(zone.touchOutTimer);
        zone.breath?.kill();
        gsap.killTweensOf(zone.highlight);
        zone.label.killTweens();
      }
      execLabel.killTweens();
      hqLabel.killTweens();
      container.destroy({ children: true });
      labelLayer.destroy({ children: true });
    },
  };
}

/**
 * Build a satellite pod platform (8×8 tiles) with office slots, centered on
 * its local origin so it can live inside a NodeArea container.
 */
export interface PodLayout {
  platform: PIXI.Container;
  slots: PIXI.Point[];
  labelY: number;
  height: number;
  /** Diamond perimeter corners (pod-local space) for the animated island aura. */
  corners: { top: PIXI.Point; right: PIXI.Point; bottom: PIXI.Point; left: PIXI.Point };
}

export function buildPod(renderer: PIXI.Renderer | PIXI.AbstractRenderer): PodLayout {
  // Satellite federation peers should read as miniature InfiniBot HQ
  // outposts — same iconography, same mini-zone partitioning, just at
  // half scale. 16×16 tiles split into 4 quadrants (Ops / Quarters /
  // Comms / Vault) each decorated with the matching HQ furniture so
  // the satellite reads as "another HQ" rather than an empty platform.
  const cols = 16;
  const rows = 16;
  const textures = bakeGalacticTextures(renderer);
  const pod = buildPlatform(renderer, cols, rows, { trim: true, trimAlpha: 0.85, sideDepth: 32 });

  // Local cell projection (pod centered on origin)
  const ox = (-(cols - rows) * TILE_W) / 4;
  const oy = (-(cols + rows) * TILE_H) / 4;
  const cell = (c: number, r: number) =>
    new PIXI.Point(ox + ((c - r) * TILE_W) / 2, oy + ((c + r) * TILE_H) / 2);

  // Themed mini-zones laid out in a 2×2 quadrant grid (each quadrant is
  // 8×8 tiles), giving the pod the same "4 wings around a central
  // atrium" gestalt as the main station — just compact.
  type Decor = { t: keyof typeof textures; c: number; r: number; s?: number };
  const decor: Decor[] = [
    // ── NW: Mini Observatory / Ops ────────────────────────────────
    { t: 'telescope', c: 2.6, r: 1.6, s: 0.85 },
    { t: 'holoTable', c: 4.6, r: 3.0, s: 0.9 },
    { t: 'desk', c: 1.6, r: 3.4, s: 0.85 },
    { t: 'crystal', c: 3.2, r: 5.4, s: 0.8 },
    { t: 'plantHolo', c: 6.0, r: 1.4, s: 0.85 },

    // ── NE: Mini Comms Deck ────────────────────────────────────────
    { t: 'antenna', c: 12.4, r: 1.4, s: 0.9 },
    { t: 'commsBoard', c: 10.4, r: 2.6, s: 0.85 },
    { t: 'speaker', c: 13.4, r: 3.4, s: 0.85 },
    { t: 'desk', c: 9.8, r: 5.0, s: 0.85 },
    { t: 'crate', c: 13.6, r: 6.2, s: 0.85 },

    // ── Central Atrium: holo table + pedestals ────────────────────
    { t: 'holoTable', c: 8.0, r: 8.0, s: 1.0 },
    { t: 'pedestal', c: 6.0, r: 7.0, s: 0.85 },
    { t: 'pedestal', c: 10.0, r: 7.0, s: 0.85 },

    // ── SW: Mini Engineering / Storage ────────────────────────────
    { t: 'consoleWide', c: 3.0, r: 10.4, s: 0.85 },
    { t: 'crate', c: 1.8, r: 12.2, s: 0.9 },
    { t: 'crate', c: 5.2, r: 13.0, s: 0.9 },
    { t: 'desk', c: 3.4, r: 14.2, s: 0.85 },

    // ── SE: Mini Quarters / Lounge ────────────────────────────────
    { t: 'couch', c: 11.0, r: 11.0, s: 0.85 },
    { t: 'plantHolo', c: 13.4, r: 10.0, s: 0.85 },
    { t: 'pedestal', c: 9.8, r: 13.2, s: 0.85 },
    { t: 'crystal', c: 13.0, r: 14.0, s: 0.85 },
    { t: 'plantHolo', c: 14.2, r: 13.0, s: 0.85 },
  ];

  for (const item of decor) {
    const sprite = new PIXI.Sprite(textures[item.t]);
    sprite.anchor.set(0.5, 1);
    sprite.scale.set(item.s ?? 1);
    const p = cell(item.c, item.r);
    sprite.position.set(p.x, p.y + TILE_H / 2);
    pod.container.addChild(sprite);
  }

  // 4 office slots — one per quadrant — so agents arriving on the
  // satellite spread out across the mini-HQ instead of stacking in
  // one corner.
  const slots = [
    cell(4.5, 4.5),
    cell(11.5, 4.5),
    cell(4.5, 11.5),
    cell(11.5, 11.5),
  ];

  return {
    platform: pod.container,
    slots,
    labelY: -pod.height / 2 - 46,
    height: pod.height,
    corners: pod.corners,
  };
}
