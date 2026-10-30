/**
 * InfiniBot Terminal Background - OGL Implementation
 * Uses the ogl library (already in package.json)
 */

import { Renderer, Program, Mesh, Color, Triangle } from 'ogl';
import { rafLoop, type SchedulerHandle } from './perf/visibility-scheduler';

const vertexShader = `
attribute vec2 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fragmentShader = `
precision mediump float;
varying vec2 vUv;
uniform float iTime;
uniform vec3 iResolution;
uniform float uScale;
uniform vec2 uGridMul;
uniform float uDigitSize;
uniform float uScanlineIntensity;
uniform float uGlitchAmount;
uniform float uFlickerAmount;
uniform float uNoiseAmp;
uniform float uChromaticAberration;
uniform float uDither;
uniform float uCurvature;
uniform vec3 uTint;
uniform vec2 uMouse;
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

float noise(vec2 p) {
  return sin(p.x * 10.0) * sin(p.y * (3.0 + sin(time * 0.090909))) + 0.2;
}

mat2 rotate(float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return mat2(c, -s, s, c);
}

float fbm(vec2 p) {
  p *= 1.1;
  float f = 0.0;
  float amp = 0.5 * uNoiseAmp;
  mat2 modify0 = rotate(time * 0.02);
  f += amp * noise(p);
  p = modify0 * p * 2.0;
  amp *= 0.454545;
  mat2 modify1 = rotate(time * 0.02);
  f += amp * noise(p);
  p = modify1 * p * 2.0;
  amp *= 0.454545;
  mat2 modify2 = rotate(time * 0.08);
  f += amp * noise(p);
  return f;
}

float pattern(vec2 p, out vec2 q, out vec2 r) {
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

float onOff(float a, float b, float c) {
  return step(c, sin(iTime + a * cos(iTime * b))) * uFlickerAmount;
}

float displace(vec2 look) {
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

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const num = parseInt(h, 16);
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
}

export function initTerminalBackgroundOGL(container: HTMLElement) {
  try {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const tintRgb = hexToRgb('var(--g-primary)');
    const mouseRef = { x: 0.5, y: 0.5 };
    const smoothMouseRef = { x: 0.5, y: 0.5 };
    let timeOffsetRef = Math.random() * 100;

    // Create container for canvas
    const canvasContainer = document.createElement('div');
    canvasContainer.style.cssText = 'position: absolute; inset: 0; z-index: 0; pointer-events: none;';
    container.insertBefore(canvasContainer, container.firstChild);

    // Create renderer
    const renderer = new Renderer({ dpr, canvas: undefined });
    const gl = renderer.gl;
    
    gl.clearColor(0, 0, 0, 1);
    canvasContainer.appendChild(gl.canvas);

    // Create geometry and program
    const geometry = new Triangle(gl);
    const program = new Program(gl, {
      vertex: vertexShader,
      fragment: fragmentShader,
      uniforms: {
        iTime: { value: 0 },
        iResolution: { value: new Color(gl.canvas.width, gl.canvas.height, gl.canvas.width / gl.canvas.height) },
        uScale: { value: 1.2 },
        uGridMul: { value: new Float32Array([2, 1]) },
        uDigitSize: { value: 1.5 },
        uScanlineIntensity: { value: 0.3 },
        uGlitchAmount: { value: 1.1 },
        uFlickerAmount: { value: 0.5 },
        uNoiseAmp: { value: 0.3 },
        uChromaticAberration: { value: 0 },
        uDither: { value: 0.3 },
        uCurvature: { value: 0.1 },
        uTint: { value: new Color(tintRgb[0], tintRgb[1], tintRgb[2]) },
        uMouse: { value: new Float32Array([smoothMouseRef.x, smoothMouseRef.y]) },
        uMouseStrength: { value: 0.2 },
        uUseMouse: { value: 1 },
        uPageLoadProgress: { value: 0 },
        uUsePageLoadAnimation: { value: 0 },
        uBrightness: { value: 0.75 },
      },
    });

    const mesh = new Mesh(gl, { geometry, program });

    const handleMouseMove = (e: MouseEvent) => {
      const rect = gl.canvas.getBoundingClientRect();
      mouseRef.x = (e.clientX - rect.left) / rect.width;
      mouseRef.y = 1 - (e.clientY - rect.top) / rect.height;
    };

    const resize = () => {
      renderer.setSize(container.offsetWidth, container.offsetHeight);
      program.uniforms.iResolution.value = new Color(
        gl.canvas.width,
        gl.canvas.height,
        gl.canvas.width / gl.canvas.height
      );
    };

    const resizeObserver = new ResizeObserver(() => resize());
    resizeObserver.observe(container);
    resize();

    let rafLoopHandle: SchedulerHandle | null = null;
    let glLost = false;
    // Timer that fires after 60s of hidden state to release the GPU context.
    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    const onVisibility = () => {
      if (document.hidden) {
        // Schedule GPU context release 60 s after window goes dark.
        if (!hideTimer) {
          hideTimer = setTimeout(() => {
            hideTimer = null;
            if (document.hidden && !glLost) {
              gl.getExtension('WEBGL_lose_context')?.loseContext();
            }
          }, 60_000);
        }
      } else {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      }
    };

    // Handle WebGL context loss/restoration (triggered by hide-timer or browser
    // pressure). preventDefault() on 'webglcontextlost' is required so the
    // browser allows restoration.
    const onContextLost = (e: Event) => {
      e.preventDefault();
      glLost = true;
      rafLoopHandle?.pause();
    };
    const onContextRestored = () => {
      glLost = false;
      // Randomise the time offset so the animation doesn't jump back to where
      // it was before the context was lost.
      timeOffsetRef = Math.random() * 100;
      rafLoopHandle?.resume();
    };
    gl.canvas.addEventListener('webglcontextlost', onContextLost, false);
    gl.canvas.addEventListener('webglcontextrestored', onContextRestored, false);
    document.addEventListener('visibilitychange', onVisibility, { passive: true });

    const update = (t: number) => {
      // Stop the loop immediately if the tab is hidden or context was lost.
      if (document.hidden || glLost) return;

      const elapsed = (t * 0.001 + timeOffsetRef) * 0.3;

      program.uniforms.iTime.value = elapsed;

      if (smoothMouseRef.x !== mouseRef.x || smoothMouseRef.y !== mouseRef.y) {
        const dampingFactor = 0.08;
        smoothMouseRef.x += (mouseRef.x - smoothMouseRef.x) * dampingFactor;
        smoothMouseRef.y += (mouseRef.y - smoothMouseRef.y) * dampingFactor;
        const mouseUniform = program.uniforms.uMouse.value as Float32Array;
        mouseUniform[0] = smoothMouseRef.x;
        mouseUniform[1] = smoothMouseRef.y;
      }

      renderer.render({ scene: mesh });
    };

    rafLoopHandle = rafLoop(update);
    container.addEventListener('mousemove', handleMouseMove);

    console.log('[TerminalBG] OGL initialized successfully');

    // Return cleanup function
    return () => {
      rafLoopHandle?.cancel();
      rafLoopHandle = null;
      if (hideTimer) clearTimeout(hideTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      gl.canvas.removeEventListener('webglcontextlost', onContextLost);
      gl.canvas.removeEventListener('webglcontextrestored', onContextRestored);
      resizeObserver.disconnect();
      container.removeEventListener('mousemove', handleMouseMove);
      if (canvasContainer.parentElement === container) container.removeChild(canvasContainer);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  } catch (e) {
    console.error('[TerminalBG] OGL initialization failed:', e);
  }
}
