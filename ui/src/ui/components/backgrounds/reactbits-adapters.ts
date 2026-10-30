/**
 * Adapters for reactbits.dev animated backgrounds.
 *
 * One file per effect would be needlessly verbose — each adapter is a tiny
 * shim that lazy-imports the component and maps our theme tokens to its
 * prop shape, then defers to mountReactComponent. Keep the file short:
 * anything non-trivial belongs as a reusable utility above the table.
 */

import { mountReactComponent, type ReactMountHandle } from "./react-mount.js";
import type { ThemeTokens } from "../../theme-glass.js";

// Single-entrypoint lazy loader for the reactbits bundle. The package is
// large (~1 MB) and we only need a subset at runtime, so we cache one
// dynamic import and pick components off the namespace record.
type ReactbitsNamespace = Record<string, React.ComponentType<any>>;
let reactbitsPromise: Promise<ReactbitsNamespace> | null = null;
function loadReactbits(): Promise<ReactbitsNamespace> {
  if (!reactbitsPromise) {
    reactbitsPromise = import("@appletosolutions/reactbits") as Promise<ReactbitsNamespace>;
  }
  return reactbitsPromise;
}

export interface BgHandle {
  update(tokens: ThemeTokens): void;
  dispose(): void;
}

// ── Color helpers ─────────────────────────────────────────────────────────

function hexToRgb01(hex: string, fallback: [number, number, number]): [number, number, number] {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function hexToHue(hex: string, fallback = 210): number {
  const [r, g, b] = hexToRgb01(hex, [0, 0, 0]);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 1e-5) return fallback;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return (h + 360) % 360;
}

function p(tokens: ThemeTokens) {
  return {
    primary: tokens.primary ?? "#8b5cf6",
    accent: tokens.accent ?? "#ec4899",
    surface: tokens.surfaceTint ?? "#1a1435",
    bg: tokens.bg ?? "#0a0a0e",
  };
}

// ── Generic factory ───────────────────────────────────────────────────────

interface AdapterSpec<P extends object> {
  /** Export name from @appletosolutions/reactbits. */
  exportName: string;
  toProps(tokens: ThemeTokens): P;
}

async function createAdapter<P extends object>(
  container: HTMLElement,
  tokens: ThemeTokens,
  spec: AdapterSpec<P>,
): Promise<BgHandle> {
  const ns = await loadReactbits();
  const Component = ns[spec.exportName] as React.ComponentType<P> | undefined;
  if (!Component) {
    throw new Error(`Reactbits component "${spec.exportName}" not found in package export`);
  }
  // React renders are sync after the createRoot.render call, so any thrown
  // error during the first commit reaches the error boundary and resolves
  // the surfaceError promise. We await one microtask + one frame to give
  // React time to commit before declaring success.
  let surfaceError: ((e: unknown) => void) | null = null;
  const errorPromise = new Promise<never>((_, reject) => {
    surfaceError = (e: unknown) => reject(e instanceof Error ? e : new Error(String(e)));
  });
  const handle: ReactMountHandle<P> = mountReactComponent(
    container,
    Component,
    spec.toProps(tokens),
    (err) => surfaceError?.(err),
  );
  // Wait for first commit + a paint tick. If the boundary caught a render
  // error, errorPromise rejects and we re-throw; otherwise we proceed.
  try {
    await Promise.race([
      new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      errorPromise,
    ]);
  } catch (err) {
    handle.dispose();
    throw err;
  }
  return {
    update(t) { handle.update(spec.toProps(t)); },
    dispose() { handle.dispose(); },
  };
}

// ── Per-effect factories ──────────────────────────────────────────────────

export const createAurora = (c: HTMLElement, t: ThemeTokens) => createAdapter(c, t, {
  exportName: "Aurora",
  toProps: (tokens) => {
    const { primary, accent, surface } = p(tokens);
    return { colorStops: [primary, accent, surface], amplitude: 1, blend: 0.5, speed: 1 };
  },
});

export const createDither = (c: HTMLElement, t: ThemeTokens) => createAdapter(c, t, {
  exportName: "Dither",
  toProps: (tokens) => ({
    waveColor: hexToRgb01(p(tokens).primary, [0.5, 0.5, 0.5]),
    waveSpeed: 0.05,
    waveFrequency: 3,
    waveAmplitude: 0.3,
    colorNum: 4,
    pixelSize: 2,
    enableMouseInteraction: true,
    mouseRadius: 1,
  }),
});

export const createIridescence = (c: HTMLElement, t: ThemeTokens) => createAdapter(c, t, {
  exportName: "Iridescence",
  toProps: (tokens) => ({
    color: hexToRgb01(p(tokens).primary, [1, 1, 1]),
    speed: 1,
    amplitude: 0.1,
    mouseReact: true,
  }),
});

export const createLiquidChrome = (c: HTMLElement, t: ThemeTokens) => createAdapter(c, t, {
  exportName: "LiquidChrome",
  toProps: (tokens) => ({
    baseColor: hexToRgb01(p(tokens).accent, [0.1, 0.1, 0.1]),
    speed: 0.3,
    amplitude: 0.4,
    frequencyX: 2,
    frequencyY: 2,
    interactive: true,
  }),
});

export const createLightning = (c: HTMLElement, t: ThemeTokens) => createAdapter(c, t, {
  exportName: "Lightning",
  toProps: (tokens) => ({ hue: hexToHue(p(tokens).primary, 230), intensity: 1, size: 1, speed: 1, xOffset: 0 }),
});

export const createBeams = (c: HTMLElement, t: ThemeTokens) => createAdapter(c, t, {
  exportName: "Beams",
  toProps: (tokens) => ({
    lightColor: p(tokens).primary,
    speed: 2,
    scale: 0.2,
    noiseIntensity: 1.75,
    rotation: 30,
    beamNumber: 12,
    beamWidth: 2,
    beamHeight: 15,
  }),
});

export const createSilk = (c: HTMLElement, t: ThemeTokens) => createAdapter(c, t, {
  exportName: "Silk",
  toProps: (tokens) => ({
    color: p(tokens).accent,
    speed: 5,
    scale: 1,
    noiseIntensity: 1.5,
    rotation: 0,
  }),
});

export const createWaves = (c: HTMLElement, t: ThemeTokens) => createAdapter(c, t, {
  exportName: "Waves",
  toProps: (tokens) => ({
    lineColor: p(tokens).primary,
    backgroundColor: "rgba(0,0,0,0)",
    waveSpeedX: 0.02,
    waveSpeedY: 0.01,
    waveAmpX: 40,
    waveAmpY: 20,
    friction: 0.9,
    tension: 0.01,
    maxCursorMove: 120,
    xGap: 12,
    yGap: 36,
  }),
});

export const createHyperspeed = (c: HTMLElement, t: ThemeTokens) => createAdapter(c, t, {
  exportName: "Hyperspeed",
  toProps: () => ({ effectOptions: undefined as unknown }),
});

export const createThreads = (c: HTMLElement, t: ThemeTokens) => createAdapter(c, t, {
  exportName: "Threads",
  toProps: (tokens) => ({
    color: hexToRgb01(p(tokens).primary, [1, 1, 1]),
    amplitude: 1,
    distance: 0,
    enableMouseInteraction: true,
  }),
});

export const createParticles = (c: HTMLElement, t: ThemeTokens) => createAdapter(c, t, {
  // Note: the package exports this lowercase in its index.
  exportName: "particles",
  toProps: (tokens) => {
    const { primary, accent, surface } = p(tokens);
    return {
      particleColors: [primary, accent, surface],
      particleCount: 200,
      particleSpread: 10,
      speed: 0.1,
      moveParticlesOnHover: true,
      particleHoverFactor: 1,
      alphaParticles: true,
      particleBaseSize: 100,
      sizeRandomness: 1,
      cameraDistance: 20,
      disableRotation: false,
    };
  },
});

export const createMetaBalls = (c: HTMLElement, t: ThemeTokens) => createAdapter(c, t, {
  exportName: "MetaBalls",
  toProps: (tokens) => ({
    color: p(tokens).primary,
    cursorBallColor: p(tokens).accent,
    speed: 0.3,
    enableMouseInteraction: true,
    hoverSmoothness: 0.05,
    animationSize: 30,
    ballCount: 15,
    clumpFactor: 1,
    cursorBallSize: 3,
    enableTransparency: true,
  }),
});

export const createOrb = (c: HTMLElement, t: ThemeTokens) => createAdapter(c, t, {
  exportName: "Orb",
  toProps: (tokens) => ({ hue: hexToHue(p(tokens).primary, 270), hoverIntensity: 0.5, rotateOnHover: true, forceHoverState: false }),
});

export const createBalatro = (c: HTMLElement, t: ThemeTokens) => createAdapter(c, t, {
  exportName: "Balatro",
  toProps: (tokens) => {
    const { primary, accent, surface } = p(tokens);
    return {
      spinRotation: -2,
      spinSpeed: 7,
      offset: [0, 0] as [number, number],
      color1: primary,
      color2: accent,
      color3: surface,
      contrast: 3.5,
      lighting: 0.4,
      spinAmount: 0.25,
      pixelFilter: 745,
      spinEase: 1,
      isRotate: false,
      mouseInteraction: true,
    };
  },
});

export const createLetterGlitch = (c: HTMLElement, t: ThemeTokens) => createAdapter(c, t, {
  exportName: "LetterGlitch",
  toProps: (tokens) => {
    const { primary, accent, surface } = p(tokens);
    return {
      glitchColors: [primary, accent, surface],
      glitchSpeed: 50,
      centerVignette: false,
      outerVignette: true,
      smooth: true,
    };
  },
});

export const createSquares = (c: HTMLElement, t: ThemeTokens) => createAdapter(c, t, {
  exportName: "Squares",
  toProps: (tokens) => ({
    direction: "diagonal" as const,
    speed: 0.5,
    borderColor: p(tokens).primary,
    hoverFillColor: p(tokens).accent,
    squareSize: 40,
  }),
});

export const createDotGrid = (c: HTMLElement, t: ThemeTokens) => createAdapter(c, t, {
  exportName: "DotGrid",
  toProps: (tokens) => ({
    dotSize: 5,
    gap: 15,
    baseColor: p(tokens).surface,
    activeColor: p(tokens).primary,
    proximity: 120,
    shockRadius: 250,
    shockStrength: 5,
    resistance: 750,
    returnDuration: 1.5,
  }),
});
