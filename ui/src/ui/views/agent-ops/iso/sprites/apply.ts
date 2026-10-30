import * as PIXI from "pixi.js";
import type { SpriteDescriptor } from "./types";

type SpriteTarget = PIXI.Container | PIXI.Sprite;

const SPRITE_CHILD_NAME = "agency-agent-kind-sprite";

export function applySprite(target: SpriteTarget, descriptor: SpriteDescriptor): PIXI.Sprite {
  const sprite = target instanceof PIXI.Sprite ? target : ensureSpriteChild(target);
  const texturePath = descriptor.anim?.sheet || descriptor.textureKey.split("#")[0] || descriptor.textureKey;

  sprite.texture = PIXI.Texture.from(texturePath);
  sprite.tint = hexToNumber(descriptor.accentColor);
  sprite.name = SPRITE_CHILD_NAME;
  sprite.anchor.set(0.5, 0.72);
  sprite.scale.set(descriptor.scale ?? 1);
  sprite.visible = true;

  const anySprite = sprite as any;
  anySprite.agencySprite = descriptor;
  anySprite.agencySpriteVariant = descriptor.variant;
  return sprite;
}

function ensureSpriteChild(container: PIXI.Container): PIXI.Sprite {
  const existing = container.children.find((child) => child.name === SPRITE_CHILD_NAME);
  if (existing instanceof PIXI.Sprite) return existing;
  const sprite = new PIXI.Sprite();
  sprite.name = SPRITE_CHILD_NAME;
  sprite.zIndex = -10;
  container.addChildAt(sprite, 0);
  return sprite;
}

function hexToNumber(hex: string): number {
  const clean = hex.replace("#", "");
  return Number.parseInt(clean.length === 3 ? clean.split("").map((ch) => `${ch}${ch}`).join("") : clean, 16);
}
