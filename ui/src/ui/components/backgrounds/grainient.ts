/**
 * Grainient — warped gradient with film grain.
 *
 * Based on the Grainient effect from reactbits.dev (MIT). Shader kept
 * intact; React wrapper rewritten for our framework-free pipeline.
 */

import { Renderer, Program, Mesh, Triangle } from "ogl";
import { createCanvasPause } from "../../lib/canvas-pause";

export interface GrainientOptions {
  color1?: string;
  color2?: string;
  color3?: string;
  timeSpeed?: number;
  colorBalance?: number;
  warpStrength?: number;
  warpFrequency?: number;
  warpSpeed?: number;
  warpAmplitude?: number;
  blendAngle?: number;
  blendSoftness?: number;
  rotationAmount?: number;
  noiseScale?: number;
  grainAmount?: number;
  grainScale?: number;
  grainAnimated?: boolean;
  contrast?: number;
  gamma?: number;
  saturation?: number;
  centerX?: number;
  centerY?: number;
  zoom?: number;
}

export interface GrainientHandle {
  update(opts: Partial<GrainientOptions>): void;
  dispose(): void;
}

const VERT = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2  iResolution;
uniform float iTime;
uniform float uTimeSpeed;
uniform float uColorBalance;
uniform float uWarpStrength;
uniform float uWarpFrequency;
uniform float uWarpSpeed;
uniform float uWarpAmplitude;
uniform float uBlendAngle;
uniform float uBlendSoftness;
uniform float uRotationAmount;
uniform float uNoiseScale;
uniform float uGrainAmount;
uniform float uGrainScale;
uniform float uGrainAnimated;
uniform float uContrast;
uniform float uGamma;
uniform float uSaturation;
uniform vec2  uCenterOffset;
uniform float uZoom;
uniform vec3  uColor1;
uniform vec3  uColor2;
uniform vec3  uColor3;
out vec4 fragColor;

#define S(a,b,t) smoothstep(a,b,t)
mat2 Rot(float a){ float s=sin(a), c=cos(a); return mat2(c,-s,s,c); }

vec2 hash(vec2 p){
  p = vec2(dot(p, vec2(2127.1, 81.17)), dot(p, vec2(1269.5, 283.37)));
  return fract(sin(p) * 43758.5453);
}

float noise(vec2 p){
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float n = mix(
    mix(dot(-1.0 + 2.0 * hash(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0)),
        dot(-1.0 + 2.0 * hash(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
    mix(dot(-1.0 + 2.0 * hash(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)),
        dot(-1.0 + 2.0 * hash(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x),
    u.y
  );
  return 0.5 + 0.5 * n;
}

void main() {
  float t = iTime * uTimeSpeed;
  vec2 uv = gl_FragCoord.xy / iResolution.xy;
  float ratio = iResolution.x / iResolution.y;
  vec2 tuv = uv - 0.5 + uCenterOffset;
  tuv /= max(uZoom, 0.001);

  float degree = noise(vec2(t * 0.1, tuv.x * tuv.y) * uNoiseScale);
  tuv.y *= 1.0 / ratio;
  tuv *= Rot(radians((degree - 0.5) * uRotationAmount + 180.0));
  tuv.y *= ratio;

  float frequency = uWarpFrequency;
  float ws = max(uWarpStrength, 0.001);
  float amplitude = uWarpAmplitude / ws;
  float warpTime = t * uWarpSpeed;
  tuv.x += sin(tuv.y * frequency + warpTime) / amplitude;
  tuv.y += sin(tuv.x * (frequency * 1.5) + warpTime) / (amplitude * 0.5);

  float b = uColorBalance;
  float s = max(uBlendSoftness, 0.0);
  mat2 blendRot = Rot(radians(uBlendAngle));
  float blendX = (tuv * blendRot).x;
  float edge0 = -0.3 - b - s;
  float edge1 =  0.2 - b + s;
  float v0 =  0.5 - b + s;
  float v1 = -0.3 - b - s;
  vec3 layer1 = mix(uColor3, uColor2, S(edge0, edge1, blendX));
  vec3 layer2 = mix(uColor2, uColor1, S(edge0, edge1, blendX));
  vec3 col = mix(layer1, layer2, S(v0, v1, tuv.y));

  vec2 grainUv = uv * max(uGrainScale, 0.001);
  if (uGrainAnimated > 0.5) grainUv += vec2(iTime * 0.05);
  float grain = fract(sin(dot(grainUv, vec2(12.9898, 78.233))) * 43758.5453);
  col += (grain - 0.5) * uGrainAmount;

  col = (col - 0.5) * uContrast + 0.5;
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, uSaturation);
  col = pow(max(col, 0.0), vec3(1.0 / max(uGamma, 0.001)));
  col = clamp(col, 0.0, 1.0);

  fragColor = vec4(col, 1.0);
}
`;

const DEFAULTS: Required<GrainientOptions> = {
  color1: "#FF9FFC",
  color2: "#5227FF",
  color3: "#B497CF",
  timeSpeed: 0.25,
  colorBalance: 0,
  warpStrength: 1,
  warpFrequency: 5,
  warpSpeed: 2,
  warpAmplitude: 50,
  blendAngle: 0,
  blendSoftness: 0.05,
  rotationAmount: 500,
  noiseScale: 2,
  grainAmount: 0.1,
  grainScale: 2,
  grainAnimated: false,
  contrast: 1.5,
  gamma: 1,
  saturation: 1,
  centerX: 0,
  centerY: 0,
  zoom: 0.9,
};

function hexToRgb(hex: string): [number, number, number] {
  const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!r) return [1, 1, 1];
  return [parseInt(r[1]!, 16) / 255, parseInt(r[2]!, 16) / 255, parseInt(r[3]!, 16) / 255];
}

export function createGrainient(
  container: HTMLElement,
  options: GrainientOptions = {},
): GrainientHandle {
  const state: Required<GrainientOptions> = { ...DEFAULTS, ...options };

  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const renderer = new Renderer({ webgl: 2, alpha: true, antialias: false, dpr });
  const gl = renderer.gl;
  gl.canvas.style.width = "100%";
  gl.canvas.style.height = "100%";
  gl.canvas.style.display = "block";
  container.appendChild(gl.canvas);

  const program = new Program(gl, {
    vertex: VERT,
    fragment: FRAG,
    uniforms: {
      iTime: { value: 0 },
      iResolution: { value: new Float32Array([1, 1]) },
      uTimeSpeed: { value: state.timeSpeed },
      uColorBalance: { value: state.colorBalance },
      uWarpStrength: { value: state.warpStrength },
      uWarpFrequency: { value: state.warpFrequency },
      uWarpSpeed: { value: state.warpSpeed },
      uWarpAmplitude: { value: state.warpAmplitude },
      uBlendAngle: { value: state.blendAngle },
      uBlendSoftness: { value: state.blendSoftness },
      uRotationAmount: { value: state.rotationAmount },
      uNoiseScale: { value: state.noiseScale },
      uGrainAmount: { value: state.grainAmount },
      uGrainScale: { value: state.grainScale },
      uGrainAnimated: { value: state.grainAnimated ? 1 : 0 },
      uContrast: { value: state.contrast },
      uGamma: { value: state.gamma },
      uSaturation: { value: state.saturation },
      uCenterOffset: { value: new Float32Array([state.centerX, state.centerY]) },
      uZoom: { value: state.zoom },
      uColor1: { value: new Float32Array(hexToRgb(state.color1)) },
      uColor2: { value: new Float32Array(hexToRgb(state.color2)) },
      uColor3: { value: new Float32Array(hexToRgb(state.color3)) },
    },
  });
  const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });

  const resize = () => {
    const w = Math.max(1, container.offsetWidth || window.innerWidth);
    const h = Math.max(1, container.offsetHeight || window.innerHeight);
    renderer.setSize(w, h);
    const res = program.uniforms.iResolution.value as Float32Array;
    res[0] = gl.drawingBufferWidth;
    res[1] = gl.drawingBufferHeight;
  };
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
  ro?.observe(container);
  window.addEventListener("resize", resize);
  resize();

  let rafId = 0;
  let running = true;
  const t0 = performance.now();
  const pauseCtrl = createCanvasPause(container, { throttleWhenBlurred: true });
  const tick = (t: number) => {
    if (!running) return;
    if (!pauseCtrl.isActive()) {
      rafId = 0;
      return;
    }
    rafId = requestAnimationFrame(tick);
    if (!pauseCtrl.wantsFrame(t)) return;
    program.uniforms.iTime.value = (t - t0) * 0.001;
    renderer.render({ scene: mesh });
  };
  pauseCtrl.onChange = (active) => {
    if (active && running && !rafId) rafId = requestAnimationFrame(tick);
  };
  pauseCtrl.start();
  rafId = requestAnimationFrame(tick);

  return {
    update(next) {
      Object.assign(state, next);
      const set = (key: string, v: unknown) => {
        if (program.uniforms[key]) program.uniforms[key].value = v as any;
      };
      if (next.timeSpeed != null) set("uTimeSpeed", next.timeSpeed);
      if (next.colorBalance != null) set("uColorBalance", next.colorBalance);
      if (next.warpStrength != null) set("uWarpStrength", next.warpStrength);
      if (next.warpFrequency != null) set("uWarpFrequency", next.warpFrequency);
      if (next.warpSpeed != null) set("uWarpSpeed", next.warpSpeed);
      if (next.warpAmplitude != null) set("uWarpAmplitude", next.warpAmplitude);
      if (next.blendAngle != null) set("uBlendAngle", next.blendAngle);
      if (next.blendSoftness != null) set("uBlendSoftness", next.blendSoftness);
      if (next.rotationAmount != null) set("uRotationAmount", next.rotationAmount);
      if (next.noiseScale != null) set("uNoiseScale", next.noiseScale);
      if (next.grainAmount != null) set("uGrainAmount", next.grainAmount);
      if (next.grainScale != null) set("uGrainScale", next.grainScale);
      if (next.grainAnimated != null) set("uGrainAnimated", next.grainAnimated ? 1 : 0);
      if (next.contrast != null) set("uContrast", next.contrast);
      if (next.gamma != null) set("uGamma", next.gamma);
      if (next.saturation != null) set("uSaturation", next.saturation);
      if (next.zoom != null) set("uZoom", next.zoom);
      if (next.centerX != null || next.centerY != null) {
        const c = program.uniforms.uCenterOffset.value as Float32Array;
        c[0] = next.centerX ?? state.centerX;
        c[1] = next.centerY ?? state.centerY;
      }
      if (next.color1) (program.uniforms.uColor1.value as Float32Array).set(hexToRgb(next.color1));
      if (next.color2) (program.uniforms.uColor2.value as Float32Array).set(hexToRgb(next.color2));
      if (next.color3) (program.uniforms.uColor3.value as Float32Array).set(hexToRgb(next.color3));
    },
    dispose() {
      running = false;
      cancelAnimationFrame(rafId);
      pauseCtrl.stop();
      ro?.disconnect();
      window.removeEventListener("resize", resize);
      if (gl.canvas.parentNode === container) container.removeChild(gl.canvas);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
