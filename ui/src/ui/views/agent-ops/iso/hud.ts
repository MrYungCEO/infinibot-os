/**
 * Premium HUD elements for Galactic HQ: crisp vector-text labels, zone
 * label plates with hover/active states, and screen-space HUD chrome.
 *
 * Labels live in a dedicated label layer ABOVE the world and are
 * counter-scaled against the viewport zoom so they stay readable at any
 * zoom level (see ActivityMap.animate).
 */

import * as PIXI from 'pixi.js';
import gsap from 'gsap';

import { GALACTIC } from './galactic-theme';

const FONT_STACK = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';
export const GALACTIC_LABEL_IDLE_ALPHA = 0.25;
export const GALACTIC_LABEL_FADE_MS = 120;

export interface MakeTextOptions {
  size?: number;
  color?: number;
  weight?: string;
  spacing?: number;
  alpha?: number;
}

/** Crisp PIXI.Text — LINEAR-filtered at 2× resolution despite the global NEAREST mode. */
export function makeText(str: string, opts: MakeTextOptions = {}): PIXI.Text {
  const t = new PIXI.Text(str, new PIXI.TextStyle({
    fontFamily: FONT_STACK,
    fontSize: opts.size ?? 13,
    fontWeight: (opts.weight ?? '600') as PIXI.TextStyleFontWeight,
    fill: opts.color ?? GALACTIC.goldLt,
    letterSpacing: opts.spacing ?? 2,
  }));
  t.resolution = 2;
  t.texture.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
  if (opts.alpha !== undefined) t.alpha = opts.alpha;
  return t;
}

// ════════════════════════════════════════════════════════════════
// ZONE LABEL — glass plate with title/subtitle, hover + active states
// ════════════════════════════════════════════════════════════════

export class ZoneLabel {
  /** Outer container — counter-scaled by the map each frame. */
  container: PIXI.Container;

  private inner: PIXI.Container;
  private glow: PIXI.Graphics;
  private dot: PIXI.Graphics;
  private active = false;
  private hovered = false;
  private labelAlpha = GALACTIC_LABEL_IDLE_ALPHA;
  private targetLabelAlpha = GALACTIC_LABEL_IDLE_ALPHA;
  private breath: gsap.core.Tween | null = null;
  private dotPulse: gsap.core.Tween | null = null;

  /** Resting alpha (core sectors: GALACTIC_LABEL_IDLE_ALPHA; plugin rooms
   *  pass a higher one so their titles stay readable over the busier ring). */
  private readonly idleAlpha: number;

  constructor(title: string, subtitle?: string, opts: { titleSize?: number; idleAlpha?: number } = {}) {
    this.idleAlpha = opts.idleAlpha ?? GALACTIC_LABEL_IDLE_ALPHA;
    this.labelAlpha = this.idleAlpha;
    this.targetLabelAlpha = this.idleAlpha;
    this.container = new PIXI.Container();
    this.inner = new PIXI.Container();
    this.inner.alpha = this.labelAlpha;
    this.container.addChild(this.inner);

    const titleText = makeText(title.toUpperCase(), { size: opts.titleSize ?? 12 });
    const subText = subtitle
      ? makeText(subtitle.toUpperCase(), { size: 8, color: GALACTIC.muted, weight: '500', spacing: 1.5 })
      : null;

    const padX = 12;
    const padY = 5;
    const stem = 12;
    const dotSpace = 14;
    const w = Math.max(titleText.width, subText ? subText.width : 0) + padX * 2 + dotSpace;
    const h = padY * 2 + titleText.height + (subText ? subText.height + 1 : 0);
    const top = -h - stem;

    // Hover/active glow underlay
    this.glow = new PIXI.Graphics();
    this.glow.beginFill(GALACTIC.gold, 1);
    this.glow.drawRoundedRect(-w / 2 - 4, top - 4, w + 8, h + 8, 8);
    this.glow.endFill();
    this.glow.alpha = 0;
    this.inner.addChild(this.glow);

    // Glass plate
    const plate = new PIXI.Graphics();
    plate.beginFill(0x0a0a0c, 0.86);
    plate.drawRoundedRect(-w / 2, top, w, h, 5);
    plate.endFill();
    plate.lineStyle(1, GALACTIC.gold, 0.7);
    plate.drawRoundedRect(-w / 2, top, w, h, 5);
    plate.lineStyle(0);
    // Gold accent bar on the left edge
    plate.beginFill(GALACTIC.goldLt, 0.9);
    plate.drawRect(-w / 2 + 1.5, top + 3, 2.5, h - 6);
    plate.endFill();
    // Stem down to the anchor point
    plate.lineStyle(1, GALACTIC.gold, 0.5);
    plate.moveTo(0, -stem);
    plate.lineTo(0, -2);
    plate.lineStyle(0);
    plate.beginFill(GALACTIC.goldLt, 0.9);
    plate.drawRect(-2, -3, 4, 4);
    plate.endFill();
    this.inner.addChild(plate);

    titleText.position.set(-w / 2 + padX, top + padY - 1);
    this.inner.addChild(titleText);
    if (subText) {
      subText.position.set(-w / 2 + padX, top + padY + titleText.height);
      this.inner.addChild(subText);
    }

    // Activity dot
    this.dot = new PIXI.Graphics();
    this.dot.beginFill(GALACTIC.goldLt, 1);
    this.dot.drawCircle(0, 0, 3);
    this.dot.endFill();
    this.dot.beginFill(GALACTIC.goldLt, 0.3);
    this.dot.drawCircle(0, 0, 6);
    this.dot.endFill();
    this.dot.position.set(w / 2 - 10, top + 10);
    this.dot.alpha = 0;
    this.inner.addChild(this.dot);
  }

  setHover(hovered: boolean): void {
    this.hovered = hovered;
    this.targetLabelAlpha = hovered ? 1 : this.idleAlpha;
    this.applyGlow();
    gsap.to(this.inner.scale, { x: hovered ? 1.07 : 1, y: hovered ? 1.07 : 1, duration: 0.18, ease: 'power2.out' });
  }

  updateLabelAlpha(deltaMS: number): void {
    if (this.labelAlpha === this.targetLabelAlpha) return;
    const step = (deltaMS / GALACTIC_LABEL_FADE_MS) * (1 - this.idleAlpha);
    if (this.labelAlpha < this.targetLabelAlpha) {
      this.labelAlpha = Math.min(this.targetLabelAlpha, this.labelAlpha + step);
    } else {
      this.labelAlpha = Math.max(this.targetLabelAlpha, this.labelAlpha - step);
    }
    this.inner.alpha = this.labelAlpha;
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.applyGlow();

    this.dotPulse?.kill();
    this.dotPulse = null;
    if (active) {
      gsap.to(this.dot, { alpha: 1, duration: 0.25 });
      this.dotPulse = gsap.to(this.dot.scale, { x: 1.5, y: 1.5, duration: 0.7, yoyo: true, repeat: -1, ease: 'sine.inOut' });
    } else {
      gsap.to(this.dot, { alpha: 0, duration: 0.25 });
      this.dot.scale.set(1);
    }
  }

  private applyGlow(): void {
    this.breath?.kill();
    this.breath = null;
    if (this.active) {
      this.glow.alpha = Math.max(this.glow.alpha, 0.12);
      this.breath = gsap.to(this.glow, { alpha: 0.3, duration: 1.2, yoyo: true, repeat: -1, ease: 'sine.inOut' });
    } else {
      gsap.to(this.glow, { alpha: this.hovered ? 0.22 : 0, duration: 0.2 });
    }
  }

  /** Kill animations without destroying display objects (parent layer owns those). */
  killTweens(): void {
    this.breath?.kill();
    this.dotPulse?.kill();
    gsap.killTweensOf(this.glow);
    gsap.killTweensOf(this.dot);
    gsap.killTweensOf(this.inner.scale);
  }

  destroy(): void {
    this.killTweens();
    this.container.destroy({ children: true });
  }
}

// ════════════════════════════════════════════════════════════════
// CINEMATIC OVERLAY — premium screen-space film grain / scanlines,
// vignette, and an accent "god-ray" glow from the central hub dome.
// Pure screen space, never blocks pointer events, reduced-motion aware.
// ════════════════════════════════════════════════════════════════

function hex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}

export class CinematicOverlay {
  container: PIXI.Container;

  private scanlines: PIXI.TilingSprite;
  private vignette: PIXI.Sprite;
  private godRay: PIXI.Sprite;
  private motes: PIXI.Container | null = null;
  private moteSprites: { s: PIXI.Sprite; vy: number; sway: number; phase: number; baseAlpha: number }[] = [];
  private elapsed = 0;
  private reduced: boolean;
  private width = 0;
  private height = 0;

  private static readonly MOTE_COUNT = 26;

  constructor(width: number, height: number, reducedMotion: boolean) {
    this.reduced = reducedMotion;
    this.container = new PIXI.Container();
    // Never intercept clicks / hovers meant for the world or HUD.
    (this.container as any).eventMode = 'none';
    this.container.interactiveChildren = false;

    // Scanlines — a tiny repeating texture tiled across the screen.
    this.scanlines = new PIXI.TilingSprite(CinematicOverlay.scanlineTexture(), width, height);
    this.scanlines.alpha = 0.5;
    this.container.addChild(this.scanlines);

    // Accent god-ray glow from the top-center (hub dome direction).
    this.godRay = new PIXI.Sprite(CinematicOverlay.godRayTexture(GALACTIC.goldLt));
    (this.godRay as any).blendMode = PIXI.BLEND_MODES.ADD;
    this.godRay.alpha = 0.16;
    this.container.addChild(this.godRay);

    // Ambient gold motes drifting upward (skipped under reduced motion).
    if (!this.reduced) {
      this.motes = new PIXI.Container();
      (this.motes as any).blendMode = PIXI.BLEND_MODES.ADD;
      const tex = CinematicOverlay.moteTexture();
      for (let i = 0; i < CinematicOverlay.MOTE_COUNT; i++) {
        const s = new PIXI.Sprite(tex);
        s.anchor.set(0.5);
        s.tint = GALACTIC.goldLt;
        const scale = 0.4 + ((i * 37) % 100) / 100 * 0.9;
        s.scale.set(scale);
        const baseAlpha = 0.1 + ((i * 53) % 100) / 100 * 0.22;
        this.moteSprites.push({
          s,
          vy: 5 + ((i * 17) % 100) / 100 * 10,            // px/sec upward
          sway: 6 + ((i * 29) % 100) / 100 * 14,
          phase: ((i * 71) % 100) / 100 * Math.PI * 2,
          baseAlpha,
        });
        this.motes.addChild(s);
      }
      this.container.addChild(this.motes);
    }

    // Vignette — darkened edges for a premium framed look (topmost so motes
    // sink into the dark border).
    this.vignette = new PIXI.Sprite(CinematicOverlay.vignetteTexture());
    this.container.addChild(this.vignette);

    this.resize(width, height);
    this.seedMotes(width, height);
  }

  private static moteTexture(): PIXI.Texture {
    const size = 16;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return PIXI.Texture.from(c);
  }

  private seedMotes(width: number, height: number): void {
    this.moteSprites.forEach((m, i) => {
      m.s.x = ((i * 97) % 100) / 100 * width;
      m.s.y = ((i * 41) % 100) / 100 * height;
    });
  }

  private static scanlineTexture(): PIXI.Texture {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 3;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(0, 0, 1, 1);
    const tex = PIXI.Texture.from(c);
    tex.baseTexture.scaleMode = PIXI.SCALE_MODES.NEAREST;
    return tex;
  }

  private static godRayTexture(color: number): PIXI.Texture {
    const size = 256;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(size / 2, 0, 0, size / 2, 0, size);
    g.addColorStop(0, hex(color));
    g.addColorStop(0.4, `${hex(color)}55`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return PIXI.Texture.from(c);
  }

  private static vignetteTexture(): PIXI.Texture {
    const size = 512;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.32, size / 2, size / 2, size * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return PIXI.Texture.from(c);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.scanlines.width = width;
    this.scanlines.height = height;
    this.vignette.width = width;
    this.vignette.height = height;
    // God-ray fans from the top-center down ~55% of the view.
    const rw = Math.max(width * 0.7, 360);
    const rh = Math.max(height * 0.6, 320);
    this.godRay.width = rw;
    this.godRay.height = rh;
    this.godRay.position.set((width - rw) / 2, -rh * 0.08);
  }

  /** Subtle breathing of the god-ray; scanline drift unless reduced motion. */
  update(deltaMS: number): void {
    this.elapsed += deltaMS;
    const breath = 0.13 + Math.sin(this.elapsed / 2600) * 0.05;
    this.godRay.alpha = breath;
    if (!this.reduced) {
      this.scanlines.tilePosition.y = (this.elapsed / 60) % 3;
      const dt = deltaMS / 1000;
      for (const m of this.moteSprites) {
        m.s.y -= m.vy * dt;
        m.s.x += Math.sin(this.elapsed / 1000 + m.phase) * m.sway * dt;
        if (m.s.y < -8) {                 // wrap from the bottom
          m.s.y = this.height + 8;
          m.s.x = ((m.phase * 1000) % this.width + this.width) % this.width;
        }
        m.s.alpha = m.baseAlpha * (0.6 + 0.4 * Math.sin(this.elapsed / 1400 + m.phase));
      }
    }
  }

  refreshTint(): void {
    const old = this.godRay.texture;
    this.godRay.texture = CinematicOverlay.godRayTexture(GALACTIC.goldLt);
    old.destroy(true);
    this.moteSprites.forEach(m => (m.s.tint = GALACTIC.goldLt));
    this.resize(this.width, this.height);
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}

// ════════════════════════════════════════════════════════════════
// THEME PICKER — accent swatches simulating the dynamic theme system
// ════════════════════════════════════════════════════════════════

export interface ThemePickerPreset {
  name: string;
  color: number;
}

export class ThemePicker {
  container: PIXI.Container;

  constructor(presets: ThemePickerPreset[], current: number, onPick: (color: number) => void) {
    this.container = new PIXI.Container();

    const title = makeText('THEME', { size: 8, color: GALACTIC.muted, spacing: 2.5 });
    title.position.set(0, 0);
    this.container.addChild(title);

    presets.forEach((preset, i) => {
      const swatch = new PIXI.Graphics();
      const x = i * 22 + 8;
      const y = 22;
      // Selection ring
      if (preset.color === current) {
        swatch.lineStyle(1.5, 0xffffff, 0.9);
        swatch.drawCircle(x, y, 10);
        swatch.lineStyle(0);
      }
      swatch.beginFill(preset.color, 1);
      swatch.drawCircle(x, y, 7);
      swatch.endFill();
      swatch.lineStyle(1, 0x000000, 0.4);
      swatch.drawCircle(x, y, 7);
      swatch.lineStyle(0);
      (swatch as any).interactive = true;
      (swatch as any).buttonMode = true;
      (swatch as any).hitArea = new PIXI.Circle(x, y, 11);
      (swatch as any).on('pointerdown', () => onPick(preset.color));
      this.container.addChild(swatch);
    });
  }
}

// ════════════════════════════════════════════════════════════════
// SCREEN-SPACE HUD CHROME — corner brackets + status readout
// ════════════════════════════════════════════════════════════════

export interface HudMetrics {
  agents: number;
  toolsPerMin: number;
  tokensPerHr: number;
}

export class HudOverlay {
  container: PIXI.Container;

  private brackets: PIXI.Graphics;
  private statsText: PIXI.Text;
  private titleText: PIXI.Text;

  // Live metrics panel (top-left thin gold-stroke glass card).
  private panel: PIXI.Container;
  private panelBg: PIXI.Graphics;
  private metricLabels: PIXI.Text[] = [];
  private metricValues: PIXI.Text[] = [];
  private metrics: HudMetrics = { agents: 0, toolsPerMin: 0, tokensPerHr: 0 };
  private lastWidth = 0;
  private lastHeight = 0;

  private static readonly METRIC_DEFS = [
    { key: 'agents' as const, label: 'ONLINE AGENTS' },
    { key: 'toolsPerMin' as const, label: 'TOOLS / MIN' },
    { key: 'tokensPerHr' as const, label: 'TOKENS / HR' },
  ];
  private static readonly PANEL_W = 178;
  private static readonly ROW_H = 26;

  constructor(width: number, height: number) {
    this.container = new PIXI.Container();

    this.brackets = new PIXI.Graphics();
    this.container.addChild(this.brackets);

    this.titleText = makeText('ORBITAL VIEW', { size: 9, color: GALACTIC.muted, weight: '600', spacing: 3 });
    this.container.addChild(this.titleText);

    this.statsText = makeText('', { size: 10, color: GALACTIC.gold, weight: '600', spacing: 2 });
    this.container.addChild(this.statsText);

    // ── Live metrics panel ──
    this.panel = new PIXI.Container();
    this.panelBg = new PIXI.Graphics();
    this.panel.addChild(this.panelBg);
    HudOverlay.METRIC_DEFS.forEach((def, i) => {
      const y = 30 + i * HudOverlay.ROW_H;
      const label = makeText(def.label, { size: 8, color: GALACTIC.muted, weight: '600', spacing: 1.5 });
      label.position.set(12, y + 6);
      const value = makeText('0', { size: 15, color: GALACTIC.goldLt, weight: '700', spacing: 1 });
      value.anchor.set(1, 0);
      value.position.set(HudOverlay.PANEL_W - 12, y + 2);
      this.metricLabels.push(label);
      this.metricValues.push(value);
      this.panel.addChild(label, value);
    });
    this.container.addChild(this.panel);
    this.drawPanel();

    this.resize(width, height);
  }

  private drawPanel(): void {
    const g = this.panelBg;
    const w = HudOverlay.PANEL_W;
    const h = 30 + HudOverlay.METRIC_DEFS.length * HudOverlay.ROW_H + 8;
    g.clear();
    // Glass body
    g.beginFill(0x07070a, 0.66);
    g.drawRoundedRect(0, 0, w, h, 8);
    g.endFill();
    // Thin gold stroke
    g.lineStyle(1, GALACTIC.gold, 0.55);
    g.drawRoundedRect(0, 0, w, h, 8);
    g.lineStyle(0);
    // Header bar
    g.beginFill(GALACTIC.gold, 0.1);
    g.drawRoundedRect(1, 1, w - 2, 22, 7);
    g.endFill();
    g.beginFill(GALACTIC.goldLt, 0.85);
    g.drawRect(0, 0, 3, h);
    g.endFill();
  }

  resize(width: number, height: number): void {
    this.lastWidth = width;
    this.lastHeight = height;
    const g = this.brackets;
    const inset = 10;
    const arm = 26;
    g.clear();
    g.lineStyle(2, GALACTIC.gold, 0.55);
    // Top-left
    g.moveTo(inset, inset + arm); g.lineTo(inset, inset); g.lineTo(inset + arm, inset);
    // Top-right
    g.moveTo(width - inset - arm, inset); g.lineTo(width - inset, inset); g.lineTo(width - inset, inset + arm);
    // Bottom-left
    g.moveTo(inset, height - inset - arm); g.lineTo(inset, height - inset); g.lineTo(inset + arm, height - inset);
    // Bottom-right
    g.moveTo(width - inset - arm, height - inset); g.lineTo(width - inset, height - inset); g.lineTo(width - inset, height - inset - arm);
    g.lineStyle(0);

    this.titleText.position.set(inset + 12, inset + 6);
    this.statsText.position.set(inset + 12, height - inset - 24);
    this.panel.position.set(inset + 8, inset + 26);
  }

  /** Hide the top-left title + metrics card when the host renders its own DOM
   *  HUD column (agency-world-viz) so the two never stack on each other. */
  setMetricsPanelVisible(visible: boolean): void {
    this.panel.visible = visible;
    this.titleText.visible = visible;
  }

  setStats(text: string): void {
    if (this.statsText.text !== text) this.statsText.text = text;
  }

  /** Header label inside the metrics panel (drawn as the title row). */
  setMetrics(m: HudMetrics): void {
    this.metrics = m;
    const fmt = (n: number): string => {
      if (!Number.isFinite(n)) return '0';
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
      if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'k';
      return String(Math.round(n));
    };
    HudOverlay.METRIC_DEFS.forEach((def, i) => {
      const next = fmt(m[def.key]);
      if (this.metricValues[i].text !== next) this.metricValues[i].text = next;
    });
  }

  /** Recolor every palette-driven element after a theme swap (no rebuild). */
  refreshTint(): void {
    this.titleText.style.fill = GALACTIC.muted;
    this.statsText.style.fill = GALACTIC.gold;
    this.metricLabels.forEach(l => (l.style.fill = GALACTIC.muted));
    this.metricValues.forEach(v => (v.style.fill = GALACTIC.goldLt));
    this.drawPanel();
    if (this.lastWidth > 0) this.resize(this.lastWidth, this.lastHeight);
  }
}
