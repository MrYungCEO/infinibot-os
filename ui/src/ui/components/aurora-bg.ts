/**
 * Aurora — WebGL animated background layer.
 *
 * Uses the bundled `ogl` renderer to run a fragment shader that samples a
 * simplex-noise field and maps it through a horizontal color ramp, producing
 * the slow-drifting aurora effect that matches the design shown in reference.
 *
 * Standalone, framework-free — we attach a canvas to any container and drive
 * it with requestAnimationFrame. Call `createAurora(container, opts)` to
 * mount; call the returned `dispose()` to tear it down.
 *
 * Resilient to WebGL context loss and container resize via ResizeObserver.
 */

import { Renderer, Program, Mesh, Color, Triangle } from "ogl";
import { createCanvasPause } from "../lib/canvas-pause";

export interface AuroraOptions {
  /** Three hex colors blended across the horizontal ramp. */
  colorStops?: [string, string, string];
  /** Scales the noise height. Default 1.0. Safe range 0.4 – 2.0. */
  amplitude?: number;
  /** Soft-edge size for the aurora falloff. Default 0.5. Safe range 0.1 – 1.0. */
  blend?: number;
  /** Animation speed multiplier. Default 1.0. */
  speed?: number;
}

export interface AuroraHandle {
  /** Push new options at runtime without recreating the canvas. */
  update(opts: Partial<AuroraOptions>): void;
  /** Stop the animation loop, remove the canvas, release GL resources. */
  dispose(): void;
}

const VERT = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

// Fragment shader: simplex noise → horizontal color ramp → soft-edge aurora.
// The simplex implementation is Ashima Arts / Ian McEwan's standard GLSL port.
const FRAG = `#version 300 es
precision highp float;

uniform float uTime;
uniform float uAmplitude;
uniform float uBlend;
uniform vec3  uColorStops[3];
uniform vec2  uResolution;

out vec4 fragColor;

vec3 permute(vec3 x) {
  return mod(((x * 34.0) + 1.0) * x, 289.0);
}

float snoise(vec2 v) {
  const vec4 C = vec4(
    0.211324865405187,
    0.366025403784439,
   -0.577350269189626,
    0.024390243902439
  );
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(
    permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0)
  );
  vec3 m = max(0.5 - vec3(
    dot(x0, x0),
    dot(x12.xy, x12.xy),
    dot(x12.zw, x12.zw)
  ), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

vec3 rampColor(vec3 c0, vec3 c1, vec3 c2, float t) {
  // Two-segment ramp: stops at 0.0, 0.5, 1.0.
  return t < 0.5
    ? mix(c0, c1, t * 2.0)
    : mix(c1, c2, (t - 0.5) * 2.0);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;

  vec3 base = rampColor(uColorStops[0], uColorStops[1], uColorStops[2], uv.x);

  float noise = snoise(vec2(uv.x * 2.0 + uTime * 0.1, uTime * 0.25)) * 0.5 * uAmplitude;
  noise = exp(noise);
  float height = (uv.y * 2.0 - noise + 0.2);
  float intensity = 0.6 * height;

  float mid = 0.20;
  float alpha = smoothstep(mid - uBlend * 0.5, mid + uBlend * 0.5, intensity);

  fragColor = vec4(intensity * base * alpha, alpha);
}
`;

const DEFAULTS: Required<AuroraOptions> = {
  colorStops: ["#5227FF", "#8B5CF6", "#A855F7"],
  amplitude: 1.0,
  blend: 0.5,
  speed: 1.0,
};

function toRgb(hex: string): [number, number, number] {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
}

export function createAurora(
  container: HTMLElement,
  options: AuroraOptions = {},
): AuroraHandle {
  const state: Required<AuroraOptions> = { ...DEFAULTS, ...options };

  const renderer = new Renderer({
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
    dpr: Math.min(window.devicePixelRatio || 1, 1.25),
  });
  const gl = renderer.gl;
  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.canvas.style.background = "transparent";
  gl.canvas.style.display = "block";
  gl.canvas.style.width = "100%";
  gl.canvas.style.height = "100%";

  const geometry = new Triangle(gl);
  // Triangle adds a uv attribute by default; aurora only needs position.
  if ((geometry as any).attributes.uv) delete (geometry as any).attributes.uv;

  const program = new Program(gl, {
    vertex: VERT,
    fragment: FRAG,
    uniforms: {
      uTime: { value: 0 },
      uAmplitude: { value: state.amplitude },
      uBlend: { value: state.blend },
      uColorStops: { value: state.colorStops.map(toRgb) },
      uResolution: { value: [container.offsetWidth, container.offsetHeight] },
    },
  });

  const mesh = new Mesh(gl, { geometry, program });
  container.appendChild(gl.canvas);

  const resize = () => {
    const w = container.offsetWidth || window.innerWidth;
    const h = container.offsetHeight || window.innerHeight;
    renderer.setSize(w, h);
    program.uniforms.uResolution.value = [w, h];
  };

  const ro = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(resize)
    : null;
  ro?.observe(container);
  window.addEventListener("resize", resize);
  resize();

  let rafId = 0;
  let running = true;
  const tick = (t: number) => {
    if (!running) return;
    if (!pauseCtrl.isActive()) {
      rafId = 0;
      return;
    }
    rafId = requestAnimationFrame(tick);
    if (!pauseCtrl.wantsFrame(t)) return;
    program.uniforms.uTime.value = t * 0.01 * state.speed * 0.1;
    program.uniforms.uAmplitude.value = state.amplitude;
    program.uniforms.uBlend.value = state.blend;
    renderer.render({ scene: mesh });
  };
  const pauseCtrl = createCanvasPause(container, { throttleWhenBlurred: true });
  pauseCtrl.onChange = (active) => {
    if (active && running && !rafId) rafId = requestAnimationFrame(tick);
  };
  pauseCtrl.start();
  rafId = requestAnimationFrame(tick);

  return {
    update(next: Partial<AuroraOptions>) {
      if (next.colorStops && next.colorStops.length === 3) {
        state.colorStops = next.colorStops;
        program.uniforms.uColorStops.value = next.colorStops.map(toRgb);
      }
      if (typeof next.amplitude === "number") state.amplitude = next.amplitude;
      if (typeof next.blend === "number") state.blend = next.blend;
      if (typeof next.speed === "number") state.speed = next.speed;
    },
    dispose() {
      running = false;
      cancelAnimationFrame(rafId);
      pauseCtrl.stop();
      window.removeEventListener("resize", resize);
      ro?.disconnect();
      if (gl.canvas.parentNode === container) {
        container.removeChild(gl.canvas);
      }
      // Encourage the browser to release the underlying GL context.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
