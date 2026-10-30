/**
 * FaultyTerminal WebGL Background
 * Converted from React to Lit for InfiniBot WebUI
 * Black and gold themed matrix-style effect
 */

import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { Renderer, Program, Mesh, Color, Triangle } from "ogl";
import { createCanvasPause, type CanvasPause } from "../lib/canvas-pause";
import { isLowPower } from "../perf.js";

/** True when WebGL is being emulated in software rather than run on a GPU. */
function isSoftwareRenderer(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
  try {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = info
      ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "")
      : String(gl.getParameter(gl.RENDERER) ?? "");
    return /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i.test(renderer);
  } catch {
    return false;
  }
}

/** Resolves once the page has painted actual content (or after 5 s, whichever first). */
function whenFirstContentfulPaint(): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      if (performance.getEntriesByName("first-contentful-paint").length > 0) {
        done();
        return;
      }
      const observer = new PerformanceObserver((list) => {
        if (list.getEntries().some((e) => e.name === "first-contentful-paint")) {
          observer.disconnect();
          done();
        }
      });
      observer.observe({ type: "paint", buffered: true });
    } catch {
      /* paint timing unsupported — fall through to the timeout */
    }
    setTimeout(done, 5_000);
  });
}

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
  float sum = digit(p + vec2(-off, -off)) +
              digit(p + vec2(0.0, -off)) +
              digit(p + vec2(off, -off)) +
              digit(p + vec2(-off, 0.0)) +
              digit(p + vec2(0.0, 0.0)) +
              digit(p + vec2(off, 0.0)) +
              digit(p + vec2(-off, off)) +
              digit(p + vec2(0.0, off)) +
              digit(p + vec2(off, off));
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
  if (h.length === 3) {
    h = h.split('').map(c => c + c).join('');
  }
  const num = parseInt(h, 16);
  return [
    ((num >> 16) & 255) / 255,
    ((num >> 8) & 255) / 255,
    (num & 255) / 255
  ];
}

@customElement("terminal-background")
export class TerminalBackground extends LitElement {
  static styles = css`
    :host {
      display: block;
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      z-index: 0; /* Base layer */
      pointer-events: none;
      overflow: hidden;
    }

    .terminal-canvas-container {
      width: 100%;
      height: 100%;
      position: absolute;
      top: 0;
      left: 0;
    }

    .terminal-canvas-container canvas {
      width: 100% !important;
      height: 100% !important;
      display: block;
    }

    /* Gradient overlay for black-to-gold fade */
    .gradient-overlay {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: linear-gradient(
        180deg,
        rgba(0, 0, 0, 0.7) 0%,
        rgba(0, 0, 0, 0.4) 30%,
        rgba(0, 0, 0, 0.2) 70%,
        rgba(0, 0, 0, 0.6) 100%
      );
      pointer-events: none;
    }
  `;

  @property({ type: Number }) scale = 1.5;
  @property({ type: Array }) gridMul: [number, number] = [2, 1];
  @property({ type: Number }) digitSize = 1.2;
  @property({ type: Number }) timeScale = 0.3;
  @property({ type: Boolean }) pause = false;
  @property({ type: Number }) scanlineIntensity = 0.3;
  @property({ type: Number }) glitchAmount = 0.8;
  @property({ type: Number }) flickerAmount = 0.5;
  @property({ type: Number }) noiseAmp = 0.8;
  @property({ type: Number }) chromaticAberration = 0;
  @property({ type: Number }) dither = 0;
  @property({ type: Number }) curvature = 0.05;
  @property({ type: String }) tint = "var(--g-primary)"; // Gold color
  @property({ type: Boolean }) mouseReact = true;
  @property({ type: Number }) mouseStrength = 0.3;
  @property({ type: Number }) dpr = Math.min(window.devicePixelRatio || 1, 1.25);
  @property({ type: Boolean }) pageLoadAnimation = true;
  @property({ type: Number }) brightness = 0.4; // Dimmer for background

  private containerRef: HTMLDivElement | null = null;
  private renderer: Renderer | null = null;
  private program: Program | null = null;
  private mesh: Mesh | null = null;
  private rafId: number = 0;
  private mouse = { x: 0.5, y: 0.5 };
  private smoothMouse = { x: 0.5, y: 0.5 };
  private frozenTime = 0;
  private loadAnimationStart = 0;
  private timeOffset = Math.random() * 100;
  private resizeObserver: ResizeObserver | null = null;
  private pauseCtrl: CanvasPause | null = null;
  private visibilityWatcher: MutationObserver | null = null;

  connectedCallback() {
    super.connectedCallback();
    // Low-power devices: skip the WebGL shader loop entirely (it runs every
    // frame and is a major lag source on older / ~8 GB / integrated-GPU
    // machines). The CSS background remains as a static fallback.
    if (isLowPower()) return;
    /*
     * Compiling the matrix fragment shader costs ~0.9-3.0 s of synchronous
     * main-thread work (ogl's Program constructor calls getShaderInfoLog /
     * LINK_STATUS, which stall on the driver). This used to run in the
     * microtask right after the element's first render — i.e. before the
     * browser had painted anything — so it pushed FCP on /agency-operations
     * out past 4 s for a purely decorative background that has a CSS
     * fallback already on screen.
     *
     * Gate on the real first-contentful-paint entry (a bare rAF is not
     * enough — the shell can render several empty frames before the app has
     * any content, and the compile would slot straight into one of them),
     * then wait for an idle slot. Both waits have timeouts so the effect
     * still appears on pages that never go idle.
     */
    void this.updateComplete.then(() => {
      void whenFirstContentfulPaint().then(() =>
        requestAnimationFrame(() => requestAnimationFrame(() => this.scheduleInit())),
      );
    });
  }

  /**
   * This element is the page-load default background, but theme-glass.ts hides
   * it (`:root[data-background] terminal-background { display: none }`) as soon
   * as the user has picked any background — including the very common "none".
   * It was still compiling the shader and running a rAF loop forever while
   * invisible. Only touch the GPU when the element is actually rendered, and
   * watch for it becoming visible later.
   */
  private isRendered(): boolean {
    try {
      const check = (this as unknown as { checkVisibility?: () => boolean }).checkVisibility;
      if (typeof check === "function") return check.call(this);
    } catch {
      /* older engines */
    }
    const rect = this.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  private scheduleInit(): void {
    if (!this.isConnected || this.renderer) return;
    if (!this.isRendered()) {
      this.watchForVisibility();
      return;
    }
    const idle = (window as Window & { requestIdleCallback?: typeof requestIdleCallback })
      .requestIdleCallback;
    const start = () => {
      if (!this.isConnected || this.renderer || !this.isRendered()) return;
      this.initWebGL();
    };
    if (typeof idle === "function") idle(start, { timeout: 2_000 });
    else setTimeout(start, 300);
  }

  private watchForVisibility(): void {
    if (this.visibilityWatcher) return;
    const observer = new MutationObserver(() => {
      if (!this.isRendered()) return;
      observer.disconnect();
      this.visibilityWatcher = null;
      this.scheduleInit();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-background", "class", "style"],
    });
    observer.observe(this, { attributes: true, attributeFilter: ["class", "style", "hidden"] });
    this.visibilityWatcher = observer;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.cleanup();
  }

  private cleanup() {
    if (this.visibilityWatcher) {
      this.visibilityWatcher.disconnect();
      this.visibilityWatcher = null;
    }
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.pauseCtrl) {
      this.pauseCtrl.stop();
      this.pauseCtrl = null;
    }
    if (this.renderer) {
      const gl = this.renderer.gl;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      if (gl.canvas.parentElement === this.containerRef) {
        this.containerRef?.removeChild(gl.canvas);
      }
      this.renderer = null;
    }
    window.removeEventListener('mousemove', this.handleMouseMove);
  }

  private handleMouseMove = (e: MouseEvent) => {
    const ctn = this.containerRef;
    if (!ctn) return;
    const rect = ctn.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = 1 - (e.clientY - rect.top) / rect.height;
    this.mouse = { x, y };
  };

  private webglFailed = false;

  private initWebGL() {
    const ctn = this.shadowRoot?.querySelector('.terminal-canvas-container') as HTMLDivElement;
    if (!ctn) {
      console.error('[TerminalBackground] Container not found!');
      return;
    }
    this.containerRef = ctn;
    
    // Skip if WebGL already failed
    if (this.webglFailed) {
      return;
    }

    // Pre-check WebGL availability
    const testCanvas = document.createElement('canvas');
    const testGl = testCanvas.getContext('webgl2') || testCanvas.getContext('webgl');
    if (!testGl) {
      console.warn('[TerminalBackground] WebGL not available, using CSS fallback');
      this.webglFailed = true;
      ctn.classList.add('no-webgl');
      return;
    }

    // No hardware GPU (SwiftShader / llvmpipe / Mesa softpipe — remote
    // desktops, VMs, headless, machines with blocklisted drivers). Compiling
    // this fragment shader on a software rasteriser costs seconds of blocked
    // main thread and then renders the animation at a few frames a second.
    // The CSS fallback is strictly better there.
    if (isSoftwareRenderer(testGl)) {
      console.info('[TerminalBackground] Software WebGL renderer, using CSS fallback');
      this.webglFailed = true;
      ctn.classList.add('no-webgl');
      return;
    }

    console.log('[TerminalBackground] Initializing WebGL...', { width: ctn.offsetWidth, height: ctn.offsetHeight });

    try {
      const renderer = new Renderer({ dpr: this.dpr });
      if (!renderer || !renderer.gl) {
        throw new Error('Renderer creation failed');
      }
      this.renderer = renderer;
      const gl = renderer.gl;
      gl.clearColor(0, 0, 0, 1);
      console.log('[TerminalBackground] WebGL context created');

      const geometry = new Triangle(gl);
      const tintVec = hexToRgb(this.tint);

      const program = new Program(gl, {
        vertex: vertexShader,
        fragment: fragmentShader,
        uniforms: {
          iTime: { value: 0 },
          iResolution: { value: new Color(gl.canvas.width, gl.canvas.height, gl.canvas.width / gl.canvas.height) },
          uScale: { value: this.scale },
          uGridMul: { value: new Float32Array(this.gridMul) },
          uDigitSize: { value: this.digitSize },
          uScanlineIntensity: { value: this.scanlineIntensity },
          uGlitchAmount: { value: this.glitchAmount },
          uFlickerAmount: { value: this.flickerAmount },
          uNoiseAmp: { value: this.noiseAmp },
          uChromaticAberration: { value: this.chromaticAberration },
          uDither: { value: this.dither },
          uCurvature: { value: this.curvature },
          uTint: { value: new Color(tintVec[0], tintVec[1], tintVec[2]) },
          uMouse: { value: new Float32Array([this.smoothMouse.x, this.smoothMouse.y]) },
          uMouseStrength: { value: this.mouseStrength },
          uUseMouse: { value: this.mouseReact ? 1 : 0 },
          uPageLoadProgress: { value: this.pageLoadAnimation ? 0 : 1 },
          uUsePageLoadAnimation: { value: this.pageLoadAnimation ? 1 : 0 },
          uBrightness: { value: this.brightness }
        }
      });
      this.program = program;

      const mesh = new Mesh(gl, { geometry, program });
      this.mesh = mesh;

      const resize = () => {
        if (!ctn || !renderer || !program) return;
        renderer.setSize(ctn.offsetWidth, ctn.offsetHeight);
        program.uniforms.iResolution.value = new Color(
          gl.canvas.width,
          gl.canvas.height,
          gl.canvas.width / gl.canvas.height
        );
      };

      this.resizeObserver = new ResizeObserver(() => resize());
      this.resizeObserver.observe(ctn);
      resize();

      const update = (t: number) => {
        if (!this.pauseCtrl?.isActive()) {
          this.rafId = 0;
          return;
        }
        this.rafId = requestAnimationFrame(update);

        if (this.pageLoadAnimation && this.loadAnimationStart === 0) {
          this.loadAnimationStart = t;
        }

        if (!this.pause) {
          const elapsed = (t * 0.001 + this.timeOffset) * this.timeScale;
          program.uniforms.iTime.value = elapsed;
          this.frozenTime = elapsed;
        } else {
          program.uniforms.iTime.value = this.frozenTime;
        }

        if (this.pageLoadAnimation && this.loadAnimationStart > 0) {
          const animationDuration = 2000;
          const animationElapsed = t - this.loadAnimationStart;
          const progress = Math.min(animationElapsed / animationDuration, 1);
          program.uniforms.uPageLoadProgress.value = progress;
        }

        if (this.mouseReact) {
          const dampingFactor = 0.08;
          this.smoothMouse.x += (this.mouse.x - this.smoothMouse.x) * dampingFactor;
          this.smoothMouse.y += (this.mouse.y - this.smoothMouse.y) * dampingFactor;
          const mouseUniform = program.uniforms.uMouse.value as Float32Array;
          mouseUniform[0] = this.smoothMouse.x;
          mouseUniform[1] = this.smoothMouse.y;
        }

        renderer.render({ scene: mesh });
      };

      this.pauseCtrl = createCanvasPause(ctn);
      this.pauseCtrl.onChange = (active) => {
        if (active && !this.rafId) {
          this.rafId = requestAnimationFrame(update);
        }
      };
      this.pauseCtrl.start();
      this.rafId = requestAnimationFrame(update);
      ctn.appendChild(gl.canvas);

      if (this.mouseReact) {
        window.addEventListener('mousemove', this.handleMouseMove, { passive: true });
      }
    } catch (err) {
      console.warn('[TerminalBackground] WebGL init failed:', err);
      this.webglFailed = true;
      ctn.classList.add('no-webgl');
    }
  }

  render() {
    return html`
      <div class="terminal-canvas-container"></div>
      <div class="gradient-overlay"></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "terminal-background": TerminalBackground;
  }
}
