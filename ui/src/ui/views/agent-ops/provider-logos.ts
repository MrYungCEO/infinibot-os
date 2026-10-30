/**
 * Coder-backend badges for the agent mesh map.
 *
 * Each coder agent shows which CLI it runs on (Claude Code, Codex, Gemini,
 * OpenCode) as a small badge above its head. The badge is InfiniBot's own
 * neutral letter monogram (C / X / G / O, gold on a dark disc), never the
 * provider's logo: third-party logos need the owner's permission, so the CLI
 * is named in text (PROVIDER_LOGO_LABEL) in chips, tooltips and alt text.
 * Rasterized from `ui/public/providers/mono-<letter>.png` / `@2x.png` (see
 * ui/scripts/gen-provider-logos.mjs). Agents without a coder backend get the
 * InfiniBot mark. See docs/licensing/BRAND-USAGE.md.
 *
 * Textures load once per page and are shared by every badge. The logo sprite
 * switches between the 96px and 192px texture based on its on-screen size, so
 * it never gets magnified past its source resolution.
 */
import * as PIXI from 'pixi.js';

export type ProviderLogoId = 'claude' | 'codex' | 'gemini' | 'opencode' | 'infinibot';
export type CoderBackendLike = 'claude-code' | 'opencode' | 'codex' | 'gemini' | undefined | null;

export const PROVIDER_LOGO_IDS: readonly ProviderLogoId[] = ['claude', 'codex', 'gemini', 'opencode', 'infinibot'];

/** Badge image per id: neutral letter monograms, InfiniBot mark as fallback. */
const PROVIDER_BADGE_FILE: Record<ProviderLogoId, string> = {
  claude: 'mono-c',
  codex: 'mono-x',
  gemini: 'mono-g',
  opencode: 'mono-o',
  infinibot: 'infinibot',
};

/** Public URL of a backend badge. `hi` = the 192px (@2x) variant. */
export function providerLogoUrl(id: ProviderLogoId, hi = false): string {
  return `/providers/${PROVIDER_BADGE_FILE[id]}${hi ? '@2x' : ''}.png`;
}

/** Coder backend → logo id. Unknown / unset falls back to the InfiniBot mark. */
export function providerLogoFor(backend: CoderBackendLike | string): ProviderLogoId {
  switch (backend) {
    case 'claude-code':
    case 'claude':
      return 'claude';
    case 'codex':
    case 'openai':
      return 'codex';
    case 'gemini':
      return 'gemini';
    case 'opencode':
      return 'opencode';
    default:
      return 'infinibot';
  }
}

/** Human label for tooltips / HUD chips. */
export const PROVIDER_LOGO_LABEL: Record<ProviderLogoId, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
  infinibot: 'InfiniBot',
};

// ── Shared texture cache ────────────────────────────────────────────────────

interface LogoTextures { lo: PIXI.Texture; hi: PIXI.Texture }
const textureCache = new Map<ProviderLogoId, LogoTextures>();

function loadTexture(url: string): PIXI.Texture {
  const base = PIXI.BaseTexture.from(url, {
    scaleMode: PIXI.SCALE_MODES.LINEAR,
    // Mipmaps give clean minification when zoomed out (WebGL2; WebGL1 ignores
    // them for these non-power-of-two sizes and falls back to linear).
    mipmap: PIXI.MIPMAP_MODES.ON,
    anisotropicLevel: 4,
  });
  return new PIXI.Texture(base);
}

/** Get (and on first call, start loading) the shared textures for a logo. */
export function getProviderLogoTextures(id: ProviderLogoId): LogoTextures {
  let t = textureCache.get(id);
  if (!t) {
    t = { lo: loadTexture(providerLogoUrl(id)), hi: loadTexture(providerLogoUrl(id, true)) };
    textureCache.set(id, t);
  }
  return t;
}

/** Kick off loading every provider logo once (call when the map mounts). */
export function preloadProviderLogos(): void {
  for (const id of PROVIDER_LOGO_IDS) getProviderLogoTextures(id);
}

// ── Badge ───────────────────────────────────────────────────────────────────

/** Badge radius in local (pre-counter-scale) pixels. */
export const PROVIDER_BADGE_RADIUS = 9;
/** Badge image size as a fraction of the badge diameter (the monogram has its own disc). */
const LOGO_FRACTION = 0.9;
/** Use the 192px texture once the logo is drawn larger than this on screen. */
const HI_RES_THRESHOLD_PX = 40;

export interface ProviderBadgeLayout {
  x: number;
  y: number;
  /** Counter-scale applied to the whole badge (keeps it readable when zoomed). */
  scale: number;
  /** Live viewport zoom, used to pick the right texture resolution. */
  viewZoom: number;
  /** Device pixel ratio of the renderer (defaults to window.devicePixelRatio). */
  resolution?: number;
}

/**
 * One agent's badge. `view` is added to the agent's room container; call
 * `setBackend` when the backend changes and `layout` every time the agent
 * redraws.
 */
export class ProviderBadge {
  readonly view: PIXI.Container;
  private readonly logo: PIXI.Sprite;
  private logoId: ProviderLogoId | null = null;
  private hiRes = false;

  constructor() {
    this.view = new PIXI.Container();
    this.logo = new PIXI.Sprite(PIXI.Texture.EMPTY);
    this.logo.anchor.set(0.5);
    this.view.addChild(this.logo);
  }

  /** Swap the backend badge. Returns true when it actually changed. */
  setBackend(backend: CoderBackendLike | string): boolean {
    const id = providerLogoFor(backend);
    if (id === this.logoId) return false;
    this.logoId = id;
    this.applyTexture();
    return true;
  }

  get currentLogo(): ProviderLogoId | null {
    return this.logoId;
  }

  layout(l: ProviderBadgeLayout): void {
    this.view.position.set(l.x, l.y);
    this.view.scale.set(l.scale);
    const res = l.resolution ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
    const logoPx = PROVIDER_BADGE_RADIUS * 2 * LOGO_FRACTION * l.scale * l.viewZoom * res;
    const wantHi = logoPx > HI_RES_THRESHOLD_PX;
    if (wantHi !== this.hiRes) {
      this.hiRes = wantHi;
      this.applyTexture();
    }
  }

  destroy(): void {
    // Textures are shared across badges — never destroy them here.
    this.view.destroy({ children: true, texture: false, baseTexture: false });
  }

  private applyTexture(): void {
    if (!this.logoId) return;
    const t = getProviderLogoTextures(this.logoId);
    this.logo.texture = this.hiRes ? t.hi : t.lo;
    const size = PROVIDER_BADGE_RADIUS * 2 * LOGO_FRACTION;
    // width/height would read the texture frame, which is 1×1 until loaded;
    // scale from the known source size instead.
    const src = this.hiRes ? 192 : 96;
    this.logo.scale.set(size / src);
  }
}
