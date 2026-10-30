/**
 * Billboard labels from one texture atlas — every name tag / building sign is
 * a slot in a single canvas texture, drawn by ONE instanced draw call.
 *
 * Per instance: world anchor, uv rect, world size, opacity. The vertex shader
 * billboards each quad in view space (constant world size, so labels shrink
 * with distance like the rest of the world) and lifts it by `aSize.y / 2` so
 * the anchor is the label's bottom edge.
 */
import * as THREE from "three";

/** Draws one label in CSS px (the atlas pre-scales by its pixel ratio). May return the drawn content width. */
export interface LabelDraw {
  (ctx: CanvasRenderingContext2D, w: number, h: number): number | void;
}

export interface LabelAtlasOptions {
  depthTest?: boolean;
  renderOrder?: number;
  /**
   * Screen-space labels: constant pixel size, snapped to the device pixel grid
   * (crisp at any zoom), drawn over the world (never hidden by props).
   */
  screenSpace?: boolean;
  /** Atlas pixels per CSS px (devicePixelRatio, capped). Default 1. */
  scale?: number;
}

export class LabelAtlas {
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
  readonly mesh: THREE.Mesh;
  private readonly ctx: CanvasRenderingContext2D;
  readonly slotW: number;
  readonly slotH: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly slotKeys: Array<string | null>;
  private readonly slotOf = new Map<string, number>();
  private readonly sigOf = new Map<string, string>();
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly aOffset: THREE.InstancedBufferAttribute;
  private readonly aUv: THREE.InstancedBufferAttribute;
  private readonly aSize: THREE.InstancedBufferAttribute;
  private readonly aAlpha: THREE.InstancedBufferAttribute;
  private readonly aShift: THREE.InstancedBufferAttribute;
  private count = 0;
  private dirtyTex = false;
  private readonly contentW = new Map<string, number>();
  readonly screenSpace: boolean;
  readonly scale: number;
  private readonly uViewport = { value: new THREE.Vector2(1, 1) };
  private readonly uDpr = { value: 1 };

  /** Slot size in CSS px (screen-space display size at scale 1). */
  readonly cssW: number;
  readonly cssH: number;

  constructor(
    cssSlotW: number,
    cssSlotH: number,
    texW: number,
    texH: number,
    opts: LabelAtlasOptions = {},
  ) {
    this.screenSpace = !!opts.screenSpace;
    this.scale = Math.max(1, opts.scale ?? 1);
    this.cssW = cssSlotW;
    this.cssH = cssSlotH;
    this.slotW = Math.round(cssSlotW * this.scale);
    this.slotH = Math.round(cssSlotH * this.scale);
    this.canvas = document.createElement("canvas");
    this.canvas.width = texW;
    this.canvas.height = texH;
    this.ctx = this.canvas.getContext("2d")!;
    this.cols = Math.floor(texW / this.slotW);
    this.rows = Math.floor(texH / this.slotH);
    this.slotKeys = new Array(this.cols * this.rows).fill(null);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    if (this.screenSpace) {
      // Drawn 1:1 with device pixels — no mips, no blur.
      this.texture.generateMipmaps = false;
      this.texture.minFilter = THREE.LinearFilter;
    } else {
      this.texture.generateMipmaps = true;
      this.texture.minFilter = THREE.LinearMipmapLinearFilter;
      this.texture.anisotropy = 4;
    }

    const cap = this.cols * this.rows;
    const base = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = base.index;
    this.geometry.setAttribute("position", base.getAttribute("position"));
    this.geometry.setAttribute("uv", base.getAttribute("uv"));
    this.aOffset = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.aUv = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
    this.aAlpha = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    this.aShift = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
    for (const a of [this.aOffset, this.aUv, this.aSize, this.aAlpha, this.aShift]) a.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("aOffset", this.aOffset);
    this.geometry.setAttribute("aUv", this.aUv);
    this.geometry.setAttribute("aSize", this.aSize);
    this.geometry.setAttribute("aAlpha", this.aAlpha);
    this.geometry.setAttribute("aShift", this.aShift);
    this.geometry.instanceCount = 0;
    base.dispose();

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: this.screenSpace ? false : opts.depthTest ?? true,
      uniforms: { uMap: { value: this.texture }, uViewport: this.uViewport, uDpr: this.uDpr },
      vertexShader: this.screenSpace
        ? /* glsl */ `
        uniform vec2 uViewport; uniform float uDpr;
        attribute vec3 aOffset; attribute vec4 aUv; attribute vec2 aSize; attribute float aAlpha; attribute vec2 aShift;
        varying vec2 vUv; varying float vAlpha;
        void main() {
          vUv = aUv.xy + uv * aUv.zw;
          vAlpha = aAlpha;
          vec4 clip = projectionMatrix * viewMatrix * vec4(aOffset, 1.0);
          if (clip.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          vec2 px = (clip.xy / clip.w * 0.5 + 0.5) * uViewport;
          // Anchor = bottom-centre; snap the anchor to device pixels so texels map 1:1.
          px += aShift;
          px = floor(px * uDpr + 0.5) / uDpr;
          px += vec2(position.x, position.y + 0.5) * aSize;
          vec2 ndc = px / uViewport * 2.0 - 1.0;
          gl_Position = vec4(ndc, 0.0, 1.0);
        }
      `
        : /* glsl */ `
        attribute vec3 aOffset; attribute vec4 aUv; attribute vec2 aSize; attribute float aAlpha;
        varying vec2 vUv; varying float vAlpha;
        void main() {
          vUv = aUv.xy + uv * aUv.zw;
          vAlpha = aAlpha;
          vec4 mv = viewMatrix * vec4(aOffset, 1.0);
          mv.xy += vec2(position.x, position.y + 0.5) * aSize;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap; varying vec2 vUv; varying float vAlpha;
        void main() {
          vec4 c = texture2D(uMap, vUv);
          c.a *= vAlpha;
          if (c.a < 0.02) discard;
          gl_FragColor = c;
          #include <colorspace_fragment>
        }
      `,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false; // per-label culling is done on the CPU
    this.mesh.renderOrder = opts.renderOrder ?? 10;
  }

  get capacity(): number {
    return this.slotKeys.length;
  }

  /** Ensure `key` has a slot drawn with `draw` (redrawn only when `sig` changes). */
  ensure(key: string, sig: string, draw: LabelDraw): number | null {
    let slot = this.slotOf.get(key);
    if (slot === undefined) {
      const free = this.slotKeys.indexOf(null);
      if (free < 0) return null;
      slot = free;
      this.slotKeys[slot] = key;
      this.slotOf.set(key, slot);
    }
    if (this.sigOf.get(key) !== sig) {
      this.sigOf.set(key, sig);
      const x = (slot % this.cols) * this.slotW;
      const y = Math.floor(slot / this.cols) * this.slotH;
      const ctx = this.ctx;
      ctx.save();
      ctx.clearRect(x, y, this.slotW, this.slotH);
      ctx.beginPath();
      ctx.rect(x, y, this.slotW, this.slotH);
      ctx.clip();
      ctx.translate(x, y);
      ctx.scale(this.scale, this.scale);
      const cw = draw(ctx, this.cssW, this.cssH);
      ctx.restore();
      this.contentW.set(key, typeof cw === "number" ? cw : this.cssW);
      this.dirtyTex = true;
    }
    return slot;
  }

  release(key: string): void {
    const slot = this.slotOf.get(key);
    if (slot === undefined) return;
    this.slotKeys[slot] = null;
    this.slotOf.delete(key);
    this.sigOf.delete(key);
    this.contentW.delete(key);
  }

  /** Drawn content width (CSS px) of a label — for screen-space decluttering. */
  contentWidth(key: string): number {
    return this.contentW.get(key) ?? this.cssW;
  }

  /** Screen-space: viewport in CSS px + device pixel ratio (call on resize / per frame). */
  setViewport(w: number, h: number, dpr: number): void {
    this.uViewport.value.set(Math.max(1, w), Math.max(1, h));
    this.uDpr.value = dpr;
  }

  keys(): string[] {
    return [...this.slotOf.keys()];
  }

  /** Start a frame's instance list. */
  begin(): void {
    this.count = 0;
  }

  /**
   * Queue one visible label. World mode: `size` = world width. Screen-space
   * mode: `size` = display scale (1 = the slot's CSS size).
   */
  push(key: string, x: number, y: number, z: number, size: number, alpha: number, shiftX = 0, shiftY = 0): void {
    const slot = this.slotOf.get(key);
    if (slot === undefined || this.count >= this.capacity) return;
    const i = this.count++;
    const tw = this.canvas.width;
    const th = this.canvas.height;
    const sx = (slot % this.cols) * this.slotW;
    const sy = Math.floor(slot / this.cols) * this.slotH;
    this.aOffset.setXYZ(i, x, y, z);
    // Canvas y grows down, texture v grows up (flipY).
    this.aUv.setXYZW(i, sx / tw, 1 - (sy + this.slotH) / th, this.slotW / tw, this.slotH / th);
    if (this.screenSpace) this.aSize.setXY(i, this.cssW * size, this.cssH * size);
    else this.aSize.setXY(i, size, (size * this.slotH) / this.slotW);
    this.aAlpha.setX(i, alpha);
    this.aShift.setXY(i, shiftX, shiftY);
  }

  end(): void {
    this.geometry.instanceCount = this.count;
    for (const a of [this.aOffset, this.aUv, this.aSize, this.aAlpha, this.aShift]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count * a.itemSize);
      a.needsUpdate = true;
    }
    if (this.dirtyTex) {
      this.texture.needsUpdate = true;
      this.dirtyTex = false;
    }
  }

  get visibleCount(): number {
    return this.count;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.canvas.width = this.canvas.height = 0;
  }
}

/** Rounded-rect path helper for label art. */
export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
