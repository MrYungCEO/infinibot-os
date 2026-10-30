/**
 * Agency Sprite Atlas — pre-renders character + decor sprites ONCE.
 *
 * The Agency World engine normally redraws each agent's PIXI.Graphics every
 * frame. That is expensive (per-pixel beginFill/drawRect on every tick). This
 * module bakes every provider × facing × frame combination into a static
 * PIXI.Texture up front, so the engine can simply swap `sprite.texture` per
 * frame instead of re-issuing draw calls (~85% cheaper per-agent draw).
 *
 * The character pixel logic is copied verbatim from
 * ui/src/ui/views/agent-ops/agency-world.ts (drawCharacter + PROVIDER_PALETTE)
 * so the baked sprites are pixel-identical to the live fallback renderer, plus
 * two extra idle frames (4 & 5) that add a subtle blink.
 *
 * Build is synchronous and fast; `ready` resolves immediately after the
 * character sheet is generated. Decor textures lazy-load from existing PNGs
 * under ui/public/assets/cozy-room/ and never block readiness.
 *
 * Side-effect-free on import: only declarations live at module scope.
 */

import * as PIXI from "pixi.js";

// ════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════

export type Facing = "S" | "N" | "E" | "W";

export interface SpriteAtlas {
  ready: Promise<void>;
  isReady(): boolean;
  /** frame 0..3 = walk cycle, 4..5 = idle. Returns null until ready. */
  charTexture(provider: string, facing: Facing, frame: number): PIXI.Texture | null;
  /** logical decor names: "chair" "desk" "laptop" "plant" "coffee". null if asset unavailable. */
  decorTexture(name: string): PIXI.Texture | null;
  destroy(): void;
}

// ════════════════════════════════════════════════════════════════
// PALETTES + STATUS COLORS (copied from agency-world.ts)
// ════════════════════════════════════════════════════════════════

const PROVIDERS = ["claude", "openai", "gemini", "ollama", "xai", "default"] as const;
const FACINGS: Facing[] = ["S", "N", "E", "W"];
const FRAME_COUNT = 6; // 0..3 walk, 4..5 idle

const SHADOW = 0x000000;

interface Palette {
  shirt: number;
  hair: number;
  skin: number;
  accent: number;
}

const PROVIDER_PALETTE: Record<string, Palette> = {
  claude: { shirt: 0xc97a4a, hair: 0x4a3324, skin: 0xf5d0a9, accent: 0xff9a4f },
  openai: { shirt: 0x10a37f, hair: 0x2a2a2a, skin: 0xf5d0a9, accent: 0x1be3a5 },
  gemini: { shirt: 0x4285f4, hair: 0x3a2a1a, skin: 0xf5d0a9, accent: 0x60a5fa },
  ollama: { shirt: 0x6b46c1, hair: 0x2a1a3a, skin: 0xf5d0a9, accent: 0xa78bfa },
  xai: { shirt: 0x111111, hair: 0xe4e4e7, skin: 0xf5d0a9, accent: 0xe4e4e7 },
  default: { shirt: 0x5a7a5a, hair: 0x3a3a4a, skin: 0xf5d0a9, accent: 0xffd700 },
};

// The baked sprites carry no status dot — the engine drives status via the
// live blink overlay. We bake with a neutral "working" tint so the character
// reads identically regardless of state; status indication stays a separate
// per-agent graphic in the engine. Kept here for parity with the reference.
const NEUTRAL_STATUS = "working";
const STATUS_COLORS: Record<string, number> = {
  starting: 0x3b82f6,
  idle: 0x6a8a6a,
  working: 0xffd700,
  blocked: 0xe74c3c,
  finishing: 0xf59e0b,
  completed: 0x22c55e,
  failed: 0xef4444,
};

// ════════════════════════════════════════════════════════════════
// CHARACTER PIXEL ART (copied + extended from agency-world.ts)
//   frames 0..3 = walk cycle (arm/leg swing on 1 & 3)
//   frames 4..5 = idle (5 = blink)
// ════════════════════════════════════════════════════════════════

/**
 * Map a requested frame to its canonical (pixel-distinct) frame. Frames 0
 * (walk stand), 2 (walk stand) and 4 (idle open) render identically, so they
 * all collapse to frame 0. Frames 1, 3 (swing) and 5 (blink) are distinct.
 */
function canonicalFrame(frame: number): number {
  if (frame === 2 || frame === 4) return 0;
  return frame;
}

function drawCharacterFrame(
  g: PIXI.Graphics,
  facing: Facing,
  frame: number,
  palette: Palette,
  status: string,
) {
  // 8 wide × 12 tall, drawn centered on (0,0) with feet at y≈+6.
  // Pixel size is 1 PIXI unit; sprites are upscaled by AGENT_SCALE in-engine.
  g.clear();
  const px = (x: number, y: number, c: number) => {
    g.beginFill(c);
    g.drawRect(x, y, 1, 1);
    g.endFill();
  };

  const isWalk = frame <= 3;
  const isBlink = frame === 5;
  // Walk swing only applies to frames 1 & 3 (matches reference drawCharacter).
  const walkFrame = isWalk ? frame : 0;

  // Shadow (always under feet)
  g.beginFill(SHADOW, 0.3);
  g.drawEllipse(0, 7, 3, 1);
  g.endFill();

  // Head (4x4 block)
  const headY = -6;
  for (let yy = 0; yy < 4; yy++)
    for (let xx = 0; xx < 4; xx++) px(-2 + xx, headY + yy, palette.skin);

  // Hair on top
  for (let xx = 0; xx < 4; xx++) px(-2 + xx, headY, palette.hair);
  if (facing !== "N") {
    // Side fringe on south/E/W
    px(-2, headY + 1, palette.hair);
    px(1, headY + 1, palette.hair);
  }

  // Eyes / mouth — only on non-blink frames (idle frame 5 closes the eyes).
  if (!isBlink) {
    if (facing === "S") {
      px(-1, headY + 2, SHADOW);
      px(0, headY + 2, SHADOW);
    } else if (facing === "E") {
      px(1, headY + 2, SHADOW);
    } else if (facing === "W") {
      px(-2, headY + 2, SHADOW);
    }
    // N: no eyes (back of head)
  }

  // Torso (4w x 4h) — shirt color
  const torsoY = -2;
  for (let yy = 0; yy < 4; yy++)
    for (let xx = 0; xx < 4; xx++) px(-2 + xx, torsoY + yy, palette.shirt);

  // Belt accent
  for (let xx = 0; xx < 4; xx++) px(-2 + xx, torsoY + 3, palette.accent);

  // Arms — 1px each side, shift on walk frames for swing
  const armSwing = walkFrame === 1 ? 1 : walkFrame === 3 ? -1 : 0;
  px(-3, torsoY + armSwing, palette.shirt);
  px(-3, torsoY + 1 + armSwing, palette.shirt);
  px(2, torsoY - armSwing, palette.shirt);
  px(2, torsoY + 1 - armSwing, palette.shirt);

  // Legs — alternate per frame
  const legY = 2;
  const legShift = walkFrame === 1 ? 1 : walkFrame === 3 ? -1 : 0;
  // left leg
  px(-1, legY, palette.shirt);
  px(-1, legY + 1, SHADOW);
  px(-1, legY + 2 + legShift, SHADOW);
  // right leg
  px(0, legY, palette.shirt);
  px(0, legY + 1, SHADOW);
  px(0, legY + 2 - legShift, SHADOW);

  // Status indicator dot above head (baked neutral; engine overlays live state).
  const sc = STATUS_COLORS[status] || STATUS_COLORS.idle;
  g.beginFill(sc);
  g.drawRect(-1, headY - 3, 2, 2);
  g.endFill();
  g.beginFill(sc, 0.3);
  g.drawRect(-2, headY - 4, 4, 3);
  g.endFill();
}

// ════════════════════════════════════════════════════════════════
// DECOR — lazy textures from existing cozy-room PNGs
// ════════════════════════════════════════════════════════════════

const DECOR_URLS: Record<string, string> = {
  chair: "/assets/cozy-room/Chairs/Chairs.png",
  desk: "/assets/cozy-room/Desks/Desks.png",
  laptop: "/assets/cozy-room/Decorations/Laptops.png",
  plant: "/assets/cozy-room/Plants/Plant.png",
  coffee: "/assets/cozy-room/Decorations/CoffeeCups.png",
};

// ════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ════════════════════════════════════════════════════════════════

// `PIXI.IRenderer` does not exist in PixiJS 6.5.10 (it is a v7+ name), so the
// public factory accepts the concrete renderer types that `app.renderer`
// actually carries — both expose `generateTexture`.
type AnyRenderer = PIXI.Renderer | PIXI.AbstractRenderer;

class SpriteAtlasImpl implements SpriteAtlas {
  ready: Promise<void>;

  private renderer: AnyRenderer;
  private charTextures = new Map<string, PIXI.Texture>();
  // Distinct generated textures (the charTextures map shares these across
  // duplicate frame keys, so only this list is iterated for destruction).
  private ownedTextures: PIXI.Texture[] = [];
  private decorTextures = new Map<string, PIXI.Texture>();
  private built = false;
  private destroyed = false;

  constructor(renderer: AnyRenderer) {
    this.renderer = renderer;
    // Build is synchronous; resolve immediately so callers can await once.
    try {
      this.buildCharacterSheet();
      this.built = true;
      this.ready = Promise.resolve();
    } catch (err) {
      this.ready = Promise.reject(err);
    }
  }

  private key(provider: string, facing: Facing, frame: number): string {
    return `${provider}:${facing}:${frame}`;
  }

  private buildCharacterSheet() {
    const g = new PIXI.Graphics();
    for (const provider of PROVIDERS) {
      const palette = PROVIDER_PALETTE[provider] || PROVIDER_PALETTE.default;
      for (const facing of FACINGS) {
        // Frames 0, 2 and 4 are pixel-identical (neutral pose, no swing/blink),
        // so we generate one texture per *distinct* canonical frame and share it
        // across the duplicate keys. This keeps all FRAME_COUNT keys valid while
        // cutting generated texture memory by ~1/3 (stays well under 40KB).
        const canonical = new Map<number, PIXI.Texture>();
        for (let frame = 0; frame < FRAME_COUNT; frame++) {
          const c = canonicalFrame(frame);
          let tex = canonical.get(c);
          if (!tex) {
            drawCharacterFrame(g, facing, c, palette, NEUTRAL_STATUS);
            tex = this.renderer.generateTexture(g, {
              scaleMode: PIXI.SCALE_MODES.NEAREST,
              resolution: 1,
            });
            // Cold GL contexts can hand back a texture with a null baseTexture;
            // a later `new PIXI.Sprite(tex)` then reads `.valid` on null and
            // throws. Fall back to a valid 1×1 render texture so character draw
            // degrades to an empty frame instead of crashing world init.
            if (!tex || !tex.baseTexture) {
              tex = PIXI.RenderTexture.create({ width: 1, height: 1 });
            }
            canonical.set(c, tex);
            this.ownedTextures.push(tex);
          }
          this.charTextures.set(this.key(provider, facing, frame), tex);
        }
      }
    }
    g.destroy();
  }

  isReady(): boolean {
    return this.built && !this.destroyed;
  }

  charTexture(provider: string, facing: Facing, frame: number): PIXI.Texture | null {
    if (!this.isReady()) return null;
    const p = PROVIDER_PALETTE[provider] ? provider : "default";
    const f = Math.max(0, Math.min(FRAME_COUNT - 1, Math.floor(frame || 0)));
    return this.charTextures.get(this.key(p, facing, f)) || null;
  }

  decorTexture(name: string): PIXI.Texture | null {
    if (this.destroyed) return null;
    const url = DECOR_URLS[String(name || "").toLowerCase()];
    if (!url) return null;
    let tex = this.decorTextures.get(url);
    if (!tex) {
      // Lazy load: returns immediately, fills in once the PNG decodes. If the
      // URL 404s the texture stays empty (the engine falls back); we never throw.
      tex = PIXI.Texture.from(url);
      this.decorTextures.set(url, tex);
    }
    return tex;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.built = false;
    this.ownedTextures.forEach((t) => {
      try {
        // true: also free the generated base texture (we own it exclusively).
        t.destroy(true);
      } catch {
        /* ignore */
      }
    });
    this.ownedTextures = [];
    this.charTextures.clear();
    this.decorTextures.forEach((t) => {
      try {
        // false: leave the shared base texture cache intact for re-use.
        t.destroy(false);
      } catch {
        /* ignore */
      }
    });
    this.decorTextures.clear();
  }
}

/**
 * Build the sprite atlas. Call once with `app.renderer`. Character textures are
 * generated synchronously; `ready` resolves on the next microtask. Decor
 * textures lazy-load independently and never affect `isReady()`.
 */
export function buildSpriteAtlas(renderer: AnyRenderer): SpriteAtlas {
  return new SpriteAtlasImpl(renderer);
}
