/**
 * FaultyTerminal — CRT/glitch animated background.
 *
 * Based on the FaultyTerminal effect from the reactbits.dev components
 * library (MIT). Shader kept intact; React lifecycle rewritten as a
 * framework-free create/update/dispose module that slots into the same
 * pipeline as aurora-bg.
 */

import { Renderer, Program, Mesh, Color, Triangle } from "ogl";
import { createCanvasPause } from "../../lib/canvas-pause";

export interface FaultyTerminalOptions {
  scale?: number;
  gridMul?: [number, number];
  digitSize?: number;
  timeScale?: number;
  pause?: boolean;
  scanlineIntensity?: number;
  glitchAmount?: number;
  flickerAmount?: number;
  noiseAmp?: number;
  chromaticAberration?: number;
  dither?: number;
  curvature?: number;
  tint?: string;
  mouseReact?: boolean;
  mouseStrength?: number;
  pageLoadAnimation?: boolean;
  brightness?: number;
}

export interface FaultyTerminalHandle {
  update(opts: Partial<FaultyTerminalOptions>): void;
  dispose(): void;
}

const VERT = `
attribute vec2 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAG = `
precision mediump float;

varying vec2 vUv;

uniform float iTime;
uniform vec3  iResolution;
uniform float uScale;

uniform vec2  uGridMul;
uniform float uDigitSize;
uniform float uScanlineIntensity;
uniform float uGlitchAmount;
uniform float uFlickerAmount;
uniform float uNoiseAmp;
uniform float uChromaticAberration;
uniform float uDither;
uniform float uCurvature;
uniform vec3  uTint;
uniform vec2  uMouse;
uniform float uMouseStrength;
uniform float uUseMouse;
uniform float uPageLoadProgress;
uniform float uUsePageLoadAnimation;
uniform float uBrightness;

float time;

float hash21(vec2 p){
  p = fract(p * 234.56);
  p += dot(p, p + 34.56);
  return fract(p.x * p.y);
}

float noise(vec2 p){
  return sin(p.x * 10.0) * sin(p.y * (3.0 + sin(time * 0.090909))) + 0.2;
}

mat2 rotate(float angle){
  float c = cos(angle);
  float s = sin(angle);
  return mat2(c, -s, s, c);
}

float fbm(vec2 p){
  p *= 1.1;
  float f = 0.0;
  float amp = 0.5 * uNoiseAmp;

  f += amp * noise(p);
  p = rotate(time * 0.02) * p * 2.0;
  amp *= 0.454545;

  f += amp * noise(p);
  p = rotate(time * 0.02) * p * 2.0;
  amp *= 0.454545;

  f += amp * noise(rotate(time * 0.08) * p);

  return f;
}

float pattern(vec2 p, out vec2 q, out vec2 r){
  vec2 offset1 = vec2(1.0);
  vec2 offset0 = vec2(0.0);
  mat2 rot01 = rotate(0.1 * time);
  mat2 rot1 = rotate(0.1);

  q = vec2(fbm(p + offset1), fbm(rot01 * p + offset1));
  r = vec2(fbm(rot1 * q + offset0), fbm(q + offset0));
  return fbm(p + r);
}

float digit(vec2 p){
    vec2 grid = uGridMul * 15.0;
    vec2 s = floor(p * grid) / grid;
    p = p * grid;
    vec2 q, r;
    float intensity = pattern(s * 0.1, q, r) * 1.3 - 0.03;

    if(uUseMouse > 0.5){
        vec2 mouseWorld = uMouse * uScale;
        float distToMouse = distance(s, mouseWorld);
        float mouseInfluence = exp(-distToMouse * 8.0) * uMouseStrength * 10.0;
        intensity += mouseInfluence;
        float ripple = sin(distToMouse * 20.0 - iTime * 5.0) * 0.1 * mouseInfluence;
        intensity += ripple;
    }

    if(uUsePageLoadAnimation > 0.5){
        float cellRandom = fract(sin(dot(s, vec2(12.9898, 78.233))) * 43758.5453);
        float cellDelay = cellRandom * 0.8;
        float cellProgress = clamp((uPageLoadProgress - cellDelay) / 0.2, 0.0, 1.0);
        float fadeAlpha = smoothstep(0.0, 1.0, cellProgress);
        intensity *= fadeAlpha;
    }

    p = fract(p);
    p *= uDigitSize;

    float px5 = p.x * 5.0;
    float py5 = (1.0 - p.y) * 5.0;
    float x = fract(px5);
    float y = fract(py5);

    float i = floor(py5) - 2.0;
    float j = floor(px5) - 2.0;
    float n = i * i + j * j;
    float f = n * 0.0625;

    float isOn = step(0.1, intensity - f);
    float brightness = isOn * (0.2 + y * 0.8) * (0.75 + x * 0.25);

    return step(0.0, p.x) * step(p.x, 1.0) * step(0.0, p.y) * step(p.y, 1.0) * brightness;
}

float onOff(float a, float b, float c){
  return step(c, sin(iTime + a * cos(iTime * b))) * uFlickerAmount;
}

float displace(vec2 look){
    float y = look.y - mod(iTime * 0.25, 1.0);
    float window = 1.0 / (1.0 + 50.0 * y * y);
    return sin(look.y * 20.0 + iTime) * 0.0125 * onOff(4.0, 2.0, 0.8) * (1.0 + cos(iTime * 60.0)) * window;
}

vec3 getColor(vec2 p){
    float bar = step(mod(p.y + time * 20.0, 1.0), 0.2) * 0.4 + 1.0;
    bar *= uScanlineIntensity;

    float displacement = displace(p);
    p.x += displacement;

    if (uGlitchAmount != 1.0) {
      float extra = displacement * (uGlitchAmount - 1.0);
      p.x += extra;
    }

    float middle = digit(p);

    const float off = 0.002;
    float sum = digit(p + vec2(-off, -off)) + digit(p + vec2(0.0, -off)) + digit(p + vec2(off, -off)) +
                digit(p + vec2(-off, 0.0)) + digit(p + vec2(0.0, 0.0)) + digit(p + vec2(off, 0.0)) +
                digit(p + vec2(-off, off)) + digit(p + vec2(0.0, off)) + digit(p + vec2(off, off));

    vec3 baseColor = vec3(0.9) * middle + sum * 0.1 * vec3(1.0) * bar;
    return baseColor;
}

vec2 barrel(vec2 uv){
  vec2 c = uv * 2.0 - 1.0;
  float r2 = dot(c, c);
  c *= 1.0 + uCurvature * r2;
  return c * 0.5 + 0.5;
}

void main() {
    time = iTime * 0.333333;
    vec2 uv = vUv;

    if(uCurvature != 0.0){
      uv = barrel(uv);
    }

    vec2 p = uv * uScale;
    vec3 col = getColor(p);

    if(uChromaticAberration != 0.0){
      vec2 ca = vec2(uChromaticAberration) / iResolution.xy;
      col.r = getColor(p + ca).r;
      col.b = getColor(p - ca).b;
    }

    col *= uTint;
    col *= uBrightness;

    if(uDither > 0.0){
      float rnd = hash21(gl_FragCoord.xy);
      col += (rnd - 0.5) * (uDither * 0.003922);
    }

    gl_FragColor = vec4(col, 1.0);
}
`;

const DEFAULTS: Required<FaultyTerminalOptions> = {
  scale: 1.5,
  gridMul: [2, 1],
  digitSize: 1.2,
  timeScale: 0.5,
  pause: false,
  scanlineIntensity: 0.5,
  glitchAmount: 1,
  flickerAmount: 1,
  noiseAmp: 1,
  chromaticAberration: 0,
  dither: 0,
  curvature: 0.1,
  tint: "#A7EF9E",
  mouseReact: true,
  mouseStrength: 0.5,
  pageLoadAnimation: true,
  brightness: 0.6,
};

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function createFaultyTerminal(
  container: HTMLElement,
  options: FaultyTerminalOptions = {},
): FaultyTerminalHandle {
  const state: Required<FaultyTerminalOptions> = { ...DEFAULTS, ...options };

  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const renderer = new Renderer({ dpr });
  const gl = renderer.gl;
  gl.clearColor(0, 0, 0, 1);
  gl.canvas.style.width = "100%";
  gl.canvas.style.height = "100%";
  gl.canvas.style.display = "block";

  const geometry = new Triangle(gl);

  const tintVec = hexToRgb(state.tint);
  const program = new Program(gl, {
    vertex: VERT,
    fragment: FRAG,
    uniforms: {
      iTime: { value: 0 },
      iResolution: {
        value: new Color(gl.canvas.width, gl.canvas.height, gl.canvas.width / gl.canvas.height),
      },
      uScale: { value: state.scale },
      uGridMul: { value: new Float32Array(state.gridMul) },
      uDigitSize: { value: state.digitSize },
      uScanlineIntensity: { value: state.scanlineIntensity },
      uGlitchAmount: { value: state.glitchAmount },
      uFlickerAmount: { value: state.flickerAmount },
      uNoiseAmp: { value: state.noiseAmp },
      uChromaticAberration: { value: state.chromaticAberration },
      uDither: { value: state.dither },
      uCurvature: { value: state.curvature },
      uTint: { value: new Color(tintVec[0], tintVec[1], tintVec[2]) },
      uMouse: { value: new Float32Array([0.5, 0.5]) },
      uMouseStrength: { value: state.mouseStrength },
      uUseMouse: { value: state.mouseReact ? 1 : 0 },
      uPageLoadProgress: { value: state.pageLoadAnimation ? 0 : 1 },
      uUsePageLoadAnimation: { value: state.pageLoadAnimation ? 1 : 0 },
      uBrightness: { value: state.brightness },
    },
  });

  const mesh = new Mesh(gl, { geometry, program });
  container.appendChild(gl.canvas);

  const mouse = { x: 0.5, y: 0.5 };
  const smooth = { x: 0.5, y: 0.5 };
  const onMouseMove = (e: MouseEvent) => {
    const rect = container.getBoundingClientRect();
    mouse.x = (e.clientX - rect.left) / rect.width;
    mouse.y = 1 - (e.clientY - rect.top) / rect.height;
  };
  if (state.mouseReact) container.addEventListener("mousemove", onMouseMove);

  const resize = () => {
    const w = container.offsetWidth || window.innerWidth;
    const h = container.offsetHeight || window.innerHeight;
    renderer.setSize(w, h);
    program.uniforms.iResolution.value = new Color(
      gl.canvas.width,
      gl.canvas.height,
      gl.canvas.width / gl.canvas.height,
    );
  };
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
  ro?.observe(container);
  window.addEventListener("resize", resize);
  resize();

  let rafId = 0;
  let running = true;
  let loadStart = 0;
  let frozen = 0;
  const offset = Math.random() * 100;

  const pauseCtrl = createCanvasPause(container, { throttleWhenBlurred: true });
  const tick = (t: number) => {
    if (!running) return;
    if (!pauseCtrl.isActive()) {
      rafId = 0;
      return;
    }
    rafId = requestAnimationFrame(tick);
    if (!pauseCtrl.wantsFrame(t)) return;
    if (state.pageLoadAnimation && loadStart === 0) loadStart = t;

    if (!state.pause) {
      const elapsed = (t * 0.001 + offset) * state.timeScale;
      program.uniforms.iTime.value = elapsed;
      frozen = elapsed;
    } else {
      program.uniforms.iTime.value = frozen;
    }

    if (state.pageLoadAnimation && loadStart > 0) {
      const progress = Math.min((t - loadStart) / 2000, 1);
      program.uniforms.uPageLoadProgress.value = progress;
    }

    if (state.mouseReact) {
      const damp = 0.08;
      smooth.x += (mouse.x - smooth.x) * damp;
      smooth.y += (mouse.y - smooth.y) * damp;
      const u = program.uniforms.uMouse.value as Float32Array;
      u[0] = smooth.x;
      u[1] = smooth.y;
    }

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
      if (next.tint) {
        const t = hexToRgb(next.tint);
        (program.uniforms.uTint.value as Color).set(t[0], t[1], t[2]);
      }
      if (next.scale != null) program.uniforms.uScale.value = next.scale;
      if (next.digitSize != null) program.uniforms.uDigitSize.value = next.digitSize;
      if (next.scanlineIntensity != null) program.uniforms.uScanlineIntensity.value = next.scanlineIntensity;
      if (next.glitchAmount != null) program.uniforms.uGlitchAmount.value = next.glitchAmount;
      if (next.flickerAmount != null) program.uniforms.uFlickerAmount.value = next.flickerAmount;
      if (next.noiseAmp != null) program.uniforms.uNoiseAmp.value = next.noiseAmp;
      if (next.chromaticAberration != null) program.uniforms.uChromaticAberration.value = next.chromaticAberration;
      if (next.dither != null) program.uniforms.uDither.value = next.dither;
      if (next.curvature != null) program.uniforms.uCurvature.value = next.curvature;
      if (next.brightness != null) program.uniforms.uBrightness.value = next.brightness;
      if (next.mouseStrength != null) program.uniforms.uMouseStrength.value = next.mouseStrength;
    },
    dispose() {
      running = false;
      cancelAnimationFrame(rafId);
      pauseCtrl.stop();
      window.removeEventListener("resize", resize);
      ro?.disconnect();
      if (state.mouseReact) container.removeEventListener("mousemove", onMouseMove);
      if (gl.canvas.parentNode === container) container.removeChild(gl.canvas);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
