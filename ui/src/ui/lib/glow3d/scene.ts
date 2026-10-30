/**
 * glow3d — a small, dependency-light toolkit for InfiniBot's "holographic"
 * three.js surfaces (knowledge graph, agent constellation, …).
 *
 * `createGlowScene` sets up the shared plumbing every glowing scene needs:
 * a WebGL renderer with a capped pixel ratio, a perspective camera with
 * damped OrbitControls (touch-friendly), an HDR render target feeding an
 * UnrealBloomPass, a deep-space gradient backdrop, and a set of uniforms
 * (time, fog) that the glow materials in this folder all share so fog and
 * animation stay coherent across layers.
 *
 * Nothing here knows about graphs or agents — it is pure scene plumbing.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

export interface GlowUniforms {
  uTime: THREE.IUniform<number>;
  uFogNear: THREE.IUniform<number>;
  uFogFar: THREE.IUniform<number>;
  uFogColor: THREE.IUniform<THREE.Color>;
  /** 0 = no idle motion (reduced motion), 1 = full ambience. */
  uMotion: THREE.IUniform<number>;
}

/**
 * A GL context the host already owns (React Native `expo-gl`): no DOM canvas
 * is created, the host reports the size and presents each frame.
 */
export interface GlowSurface {
  context: WebGL2RenderingContext;
  /** Canvas-like object for three (width/height/style + no-op listeners). */
  canvas: HTMLCanvasElement;
  /** Layout size (logical px). */
  size(): { w: number; h: number };
  /** Physical px per logical px of the drawing buffer. */
  pixelRatio(): number;
  /** Called after every frame (expo-gl: `gl.endFrameEXP()`). */
  present?(): void;
  /**
   * Run the post chain (tone mapping, optional bloom) even without bloom,
   * rendering the scene at `maxPixelRatio` and upscaling to the buffer.
   */
  postChain?: boolean;
  /** Render-target texel type for the post chain (half float when the GPU can render to it). */
  targetType?: THREE.TextureDataType;
  /**
   * Bloom resolution divisor (default 2 = half-res pyramid). The LDR fallback
   * (8-bit targets on GPUs without half-float render targets, or the low
   * tier) runs at quarter res.
   */
  bloomDivisor?: number;
}

export interface GlowSceneOptions {
  /** Element the canvas is appended to (position: relative/absolute host). */
  container?: HTMLElement;
  /** Host-owned GL context instead of a DOM canvas (native). */
  surface?: GlowSurface;
  /** Bloom settings; `false` disables the composer (plain render). */
  bloom?: { strength: number; radius: number; threshold: number } | false;
  /** Upper bound on devicePixelRatio (fill-rate guard). Default 1.5. */
  maxPixelRatio?: number;
  /** MSAA samples on the HDR target (0 on mobile). Default 4. */
  samples?: number;
  fog?: { near: number; far: number; color?: string };
  backdrop?: { top: string; bottom: string; glow: string };
  camera?: { fov?: number; near?: number; far?: number };
  /**
   * DOM hosts: keep rendering through the MSAA composer target even while
   * bloom is off (the canvas itself is created without antialias whenever
   * bloom is configured). Toggle later with `setCompose`.
   */
  composeAlways?: boolean;
}

export interface GlowScene {
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  composer: EffectComposer | null;
  bloomPass: UnrealBloomPass | null;
  uniforms: GlowUniforms;
  size: { w: number; h: number };
  /** Resize to the container's current box (call from a ResizeObserver). */
  resize(): void;
  /** Draw one frame. */
  render(): void;
  /** Toggle bloom without rebuilding (perf fallback). */
  setBloom(on: boolean): void;
  /** Render through the composer without bloom (MSAA) — false = plain render (cheapest). */
  setCompose(on: boolean): void;
  /** Cap the device pixel ratio (perf fallback); re-applies the size. */
  setMaxPixelRatio(ratio: number): void;
  /** Draw calls + triangles from the last render (for perf HUDs). */
  stats(): { calls: number; triangles: number };
  dispose(): void;
}

/** True when a WebGL2 context can be created in this browser/tab. */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") ?? c.getContext("webgl");
    if (!gl) return false;
    const ext = (gl as WebGLRenderingContext).getExtension("WEBGL_lose_context");
    ext?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** Deep-space backdrop: an inverted sphere with a vertical gradient plus a soft warm glow toward the origin. */
function createBackdrop(opts: { top: string; bottom: string; glow: string }): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1, 24, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      uTop: { value: new THREE.Color(opts.top) },
      uBottom: { value: new THREE.Color(opts.bottom) },
      uGlow: { value: new THREE.Color(opts.glow) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        // Follow the camera so the backdrop never clips, whatever the zoom.
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_Position.z = gl_Position.w * 0.999999;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop; uniform vec3 uBottom; uniform vec3 uGlow;
      varying vec3 vDir;
      void main() {
        float t = smoothstep(-0.9, 0.9, vDir.y);
        vec3 col = mix(uBottom, uTop, t);
        // Warm core glow looking "into" the graph (the camera orbits the origin).
        // Kept tight + faint: a broad glow washes the whole view gold once
        // ACES tone mapping and bloom lift it.
        float core = pow(max(0.0, -vDir.z), 18.0);
        col += uGlow * core * 0.1;
        // Faint horizon band so depth reads even with nothing in frame.
        float band = exp(-abs(vDir.y) * 9.0) * 0.035;
        col += uGlow * band;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}

/** Point every bloom render target at `type` (8-bit LDR bloom fallback). */
export function retypeBloomTargets(pass: UnrealBloomPass, type: THREE.TextureDataType): void {
  const rts = [pass.renderTargetBright, ...pass.renderTargetsHorizontal, ...pass.renderTargetsVertical];
  for (const rt of rts) {
    if (!rt) continue;
    rt.texture.type = type;
    rt.texture.needsUpdate = true;
  }
}

export function createGlowScene(opts: GlowSceneOptions): GlowScene {
  const container = opts.container ?? null;
  const surface = opts.surface ?? null;
  if (!container && !surface) throw new Error("createGlowScene needs a container or a surface");
  const deviceDpr = (): number => (surface ? surface.pixelRatio() : globalThis.devicePixelRatio || 1);
  let maxDpr = opts.maxPixelRatio ?? 1.5;
  const bloomOpts = opts.bloom === undefined ? { strength: 1.05, radius: 0.55, threshold: 0.42 } : opts.bloom;
  const fog = opts.fog ?? { near: 900, far: 2600 };
  const backdropColors = opts.backdrop ?? { top: "#0b0a1c", bottom: "#030208", glow: "#d4af37" };

  const renderer = new THREE.WebGLRenderer({
    antialias: !bloomOpts && !surface, // MSAA goes on the composer target when bloom is on
    alpha: false,
    powerPreference: "high-performance",
    stencil: false,
    ...(surface ? { canvas: surface.canvas, context: surface.context } : {}),
  });
  // Native: the drawing buffer is fixed at the device ratio; the post chain
  // renders the scene at the capped ratio and upscales into it.
  const postChain = !!surface && (surface.postChain ?? true);
  const rendererDpr = (): number => (postChain ? deviceDpr() : Math.min(deviceDpr(), maxDpr));
  renderer.setPixelRatio(rendererDpr());
  // The composer runs several passes per frame; keep info across them so
  // `stats()` reports the whole frame, reset manually in `render()`.
  renderer.info.autoReset = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(new THREE.Color(backdropColors.bottom), 1);
  const canvas = renderer.domElement;
  if (container) {
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.touchAction = "none";
    container.appendChild(canvas);
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    opts.camera?.fov ?? 48,
    1,
    opts.camera?.near ?? 1,
    opts.camera?.far ?? 20_000,
  );
  camera.position.set(0, 220, 900);

  // Native hosts drive the controls from their own gestures (see the stage).
  const controls = new OrbitControls(camera, container ? canvas : null);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.9;
  controls.panSpeed = 0.8;
  controls.screenSpacePanning = true;
  controls.minDistance = 40;
  controls.maxDistance = 6000;
  controls.autoRotateSpeed = 0.25;

  const uniforms: GlowUniforms = {
    uTime: { value: 0 },
    uFogNear: { value: fog.near },
    uFogFar: { value: fog.far },
    uFogColor: { value: new THREE.Color(fog.color ?? backdropColors.bottom) },
    uMotion: { value: 1 },
  };

  const backdrop = createBackdrop(backdropColors);
  backdrop.scale.setScalar((opts.camera?.far ?? 20_000) * 0.45);
  scene.add(backdrop);

  const size = { w: 1, h: 1 };
  let composer: EffectComposer | null = null;
  let bloomPass: UnrealBloomPass | null = null;
  let renderPass: RenderPass | null = null;
  let outputPass: OutputPass | null = null;
  let target: THREE.WebGLRenderTarget | null = null;
  let composeAlways = !!opts.composeAlways;
  if (bloomOpts || postChain || composeAlways) {
    target = new THREE.WebGLRenderTarget(1, 1, {
      type: surface?.targetType ?? THREE.HalfFloatType,
      samples: opts.samples ?? 4,
    });
    composer = new EffectComposer(renderer, target);
    renderPass = new RenderPass(scene, camera);
    if (bloomOpts) {
      bloomPass = new UnrealBloomPass(
        new THREE.Vector2(1, 1),
        bloomOpts.strength,
        bloomOpts.radius,
        bloomOpts.threshold,
      );
      // The pass allocates half-float targets. A GPU that can't render to
      // them still gets bloom on 8-bit targets (lazy: retyped before first use).
      if (surface?.targetType != null && surface.targetType !== THREE.HalfFloatType) retypeBloomTargets(bloomPass, surface.targetType);
    }
    outputPass = new OutputPass();
    composer.addPass(renderPass);
    if (bloomPass) composer.addPass(bloomPass);
    composer.addPass(outputPass);
  }

  const resize = (force = false): void => {
    const rect = surface ? { width: surface.size().w, height: surface.size().h } : container!.getBoundingClientRect();
    const w = Math.max(2, Math.floor(rect.width));
    const h = Math.max(2, Math.floor(rect.height));
    if (!force && w === size.w && h === size.h) return;
    size.w = w;
    size.h = h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(rendererDpr());
    renderer.setSize(w, h, false);
    if (composer) {
      composer.setPixelRatio(Math.min(deviceDpr(), maxDpr));
      composer.setSize(w, h);
      // Bloom works on a half-res pyramid — plenty for soft halos, half the fill.
      const div = Math.max(1, surface?.bloomDivisor ?? 2);
      bloomPass?.setSize(Math.ceil(w / div), Math.ceil(h / div));
    }
  };

  let bloomOn = !!bloomOpts;
  const render = (): void => {
    renderer.info.reset();
    backdrop.position.copy(camera.position);
    if (composer && (bloomOn || postChain || composeAlways)) {
      if (bloomPass) bloomPass.enabled = bloomOn;
      composer.render();
    } else renderer.render(scene, camera);
    surface?.present?.();
  };

  const setBloom = (on: boolean): void => {
    bloomOn = on && !!bloomPass;
  };

  const setCompose = (on: boolean): void => {
    composeAlways = on && !!composer;
  };

  const setMaxPixelRatio = (ratio: number): void => {
    maxDpr = Math.max(0.5, ratio);
    resize(true);
  };

  const stats = () => ({
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
  });

  const dispose = (): void => {
    controls.dispose();
    composer?.dispose();
    bloomPass?.dispose();
    target?.dispose();
    (backdrop.material as THREE.Material).dispose();
    backdrop.geometry.dispose();
    scene.clear();
    renderer.dispose();
    if (container) {
      renderer.forceContextLoss();
      canvas.remove();
    }
  };

  resize();
  return {
    renderer,
    canvas,
    scene,
    camera,
    controls,
    composer,
    bloomPass,
    uniforms,
    size,
    resize: () => resize(false),
    render,
    setBloom,
    setCompose,
    setMaxPixelRatio,
    stats,
    dispose,
  };
}

/** Shared GLSL for fog (depth fade toward the backdrop colour). */
export const FOG_GLSL = {
  uniforms: /* glsl */ `
    uniform float uFogNear; uniform float uFogFar; uniform vec3 uFogColor;
  `,
  /** Call with the view-space z (negative in front of the camera). */
  factor: /* glsl */ `
    float fogFactor(float viewZ) { return smoothstep(uFogNear, uFogFar, -viewZ); }
  `,
};
