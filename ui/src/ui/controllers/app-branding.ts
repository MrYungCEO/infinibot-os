/**
 * App-branding controller.
 *
 * Responsible for pulling the gateway's branding + theme tokens, applying
 * them to the DOM via theme-glass, and live-updating when other clients
 * edit via branding.update broadcasts.
 *
 * Distinct from `brand.ts` (which is business-brand identity for Canvas agent).
 */

import type { GatewayBrowserClient } from "../gateway.js";
import type { AppViewState } from "../app-view-state.js";
import { isLowPower } from "../perf.js";
import {
  applyPalette,
  applyThemeOverrides,
  clearThemeOverrides,
  setThemeMode,
  type ThemePalette,
  type ThemeTokens,
  BUILT_IN_PALETTES,
} from "../theme-glass.js";
import type { ThemeMode } from "../theme.js";
import { appAssetUrl } from "../app-base.js";

export type BackgroundStyle =
  | "none"
  | "gradient"
  | "ambient-grid"
  | "aurora"
  | "faulty-terminal"
  | "grainient"
  | "dither"
  | "iridescence"
  | "liquid-chrome"
  | "lightning"
  | "beams"
  | "silk"
  | "waves"
  | "hyperspeed"
  | "threads"
  | "particles"
  | "metaballs"
  | "orb"
  | "balatro"
  | "letter-glitch"
  | "squares"
  | "dot-grid";

export interface AppBrandingPayload {
  theme: {
    mode: ThemeMode;
    paletteId: string;
    background?: BackgroundStyle;
    tokens: ThemeTokens;
  };
  branding: {
    appName: string;
    tagline?: string;
    logoUrl?: string;
    logoDataUrl?: string;
    faviconUrl?: string;
  };
  palettes: ThemePalette[];
}

export interface AppBrandingState {
  loading: boolean;
  saving: boolean;
  error: string | null;
  successMessage: string | null;
  payload: AppBrandingPayload | null;
  /** Draft buffer for live-editing without committing. */
  draft: AppBrandingPayload | null;
  unsubscribe: (() => void) | null;
  beforeUnload: ((e: BeforeUnloadEvent) => void) | null;
}

export function createAppBrandingState(): AppBrandingState {
  return {
    loading: false,
    saving: false,
    error: null,
    successMessage: null,
    payload: null,
    draft: null,
    unsubscribe: null,
    beforeUnload: null,
  };
}

// Repo-default look — InfiniBot Noir palette + dark mode + ambient-grid bg.
// Kept in sync with the buildPayload() defaults in
// src/gateway/server-methods/branding.ts; if you change one, change both
// so a first-connect user sees identical visuals from both sides. (That
// server file is owned by a parallel agent and is out of scope here — if it
// still returns paletteId "noir" / "aurora", branding.get will override this
// client default for users with no saved branding; flag it for a follow-up.)
const DEFAULT_BRANDING: AppBrandingPayload = {
  theme: { mode: "dark", paletteId: "infinibot-gold", background: "ambient-grid", tokens: {} },
  branding: { appName: "InfiniBot", tagline: "Control Terminal" },
  palettes: BUILT_IN_PALETTES,
};

// The palette whose default background is ambient-grid, and which unlocks the
// premium gold animation suite (gated on :root[data-palette] in theme-glass).
const NOIR_PALETTE_ID = "infinibot-gold";

/**
 * Resolve the background to render for a payload. An explicit choice always
 * wins; when none is set, the InfiniBot Noir palette falls back to its
 * signature ambient-grid, everything else to the soft gradient.
 */
function resolveBackgroundStyle(payload: AppBrandingPayload): BackgroundStyle {
  if (payload.theme.background) return payload.theme.background;
  return payload.theme.paletteId === NOIR_PALETTE_ID ? "ambient-grid" : "gradient";
}

// v2: invalidates old caches that may contain reactbits styles we since
// disabled (dither/hyperspeed) due to upstream R3F bugs. Bumping the key
// makes any stale persisted "background" value harmless on next load.
// v3: invalidates v2 caches that may pin the removed "infinibot-noir"
// palette id. v4: wipes any v3 cached payload still pointing at an animated
// background (aurora/grainient/etc.) so first paint lands on the new
// ambient-grid default.
const CACHE_KEY = "infinibot.branding.cache.v4";

export function readCachedBranding(): AppBrandingPayload | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AppBrandingPayload;
    if (!parsed || !parsed.theme || !parsed.branding) return null;
    return {
      ...parsed,
      palettes:
        Array.isArray(parsed.palettes) && parsed.palettes.length > 0
          ? parsed.palettes
          : BUILT_IN_PALETTES,
    };
  } catch {
    return null;
  }
}

/** Default logo shipped in ui/public — used when no custom logo is set. */
export const BRAND_DEFAULT_LOGO = "./infinibot-logo.png";

let _logoMemo: { raw: string | null; url: string } | null = null;

/**
 * "./x.png" is relative to the document URL, which breaks on nested routes
 * (/webchat/<session> → /webchat/x.png). Anchor it to the app base path.
 */
function anchorToBasePath(url: string): string {
  return appAssetUrl(url);
}

/**
 * Effective brand logo URL (custom data URL → custom URL → default). Pass the
 * live payload's branding when available; otherwise reads the localStorage
 * cache (memoised on the raw string so per-message callers stay cheap).
 */
export function resolveBrandLogoUrl(branding?: AppBrandingPayload["branding"] | null): string {
  if (branding) {
    return anchorToBasePath(branding.logoDataUrl || branding.logoUrl || BRAND_DEFAULT_LOGO);
  }
  let raw: string | null = null;
  try {
    raw = typeof localStorage === "undefined" ? null : localStorage.getItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
  if (!_logoMemo || _logoMemo.raw !== raw) {
    const b = raw ? readCachedBranding()?.branding : null;
    _logoMemo = { raw, url: b?.logoDataUrl || b?.logoUrl || BRAND_DEFAULT_LOGO };
  }
  return anchorToBasePath(_logoMemo.url);
}

function writeCachedBranding(payload: AppBrandingPayload): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

/** Resolved branding + tokens for surfaces rendered before gateway connect. */
export function getBrandingForPreConnect(): AppBrandingPayload {
  return readCachedBranding() ?? DEFAULT_BRANDING;
}

/** Apply cached branding (if any) to the DOM — safe to call on bootstrap. */
export function applyCachedBranding(): void {
  const cached = readCachedBranding();
  if (cached) applyBrandingToDom(cached);
  else applyBrandingToDom(DEFAULT_BRANDING);
}

function ensureState(state: AppViewState): AppBrandingState {
  if (!state.appBrandingState) {
    state.appBrandingState = createAppBrandingState();
  }
  return state.appBrandingState;
}

/**
 * Resolve the effective tokens for a given payload: palette tokens merged
 * with any explicit per-user overrides.
 */
export function resolveEffectiveTokens(payload: AppBrandingPayload): ThemeTokens {
  const palette = payload.palettes.find((p) => p.id === payload.theme.paletteId);
  return {
    ...(palette?.tokens ?? {}),
    ...(payload.theme.tokens ?? {}),
  };
}

/**
 * Pluggable registry for animated background effects. Each entry knows how to
 * dynamically import its module and feed it the current theme tokens. Only
 * one effect is mounted at a time; switching tears down the previous.
 */

interface EffectHandle {
  /** Accepts either our ThemeTokens (reactbits adapters) or per-effect opts. */
  update(opts: ThemeTokens | Record<string, unknown>): void;
  dispose(): void;
}

interface EffectAdapter {
  /** Lazy-import + mount the effect. Returns the handle. */
  mount(container: HTMLElement, tokens: ThemeTokens): Promise<EffectHandle>;
  /** Push fresh token-derived options to an already-mounted handle. */
  reskin(handle: EffectHandle, tokens: ThemeTokens): void;
}

/**
 * Every registry entry is an async factory returning a handle with
 * `{ update(tokens), dispose() }`. Most defer to the reactbits adapter
 * table, which shares a single lifecycle; a couple of local ports
 * (FaultyTerminal, Grainient) have their own signatures.
 */
type EffectFactory = (container: HTMLElement, tokens: ThemeTokens) => Promise<EffectHandle>;

// Detect "Failed to fetch dynamically imported module" — browsers throw a
// TypeError when the hashed chunk in the cached HTML shell no longer exists
// on disk (typical after a dev-server rebuild). Reload once so the page picks
// up the new index.html; the sessionStorage flag prevents an infinite loop if
// the asset is genuinely missing.
const STALE_CHUNK_RELOAD_KEY = "infinibot:stale-chunk-reloaded";
function isChunkLoadError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message || "";
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(msg);
}

async function makeReactbitsEffect(
  container: HTMLElement,
  tokens: ThemeTokens,
  keyInAdapters: string,
): Promise<EffectHandle> {
  let mod: Record<string, EffectFactory>;
  try {
    mod = (await import("../components/backgrounds/reactbits-adapters.js")) as unknown as Record<string, EffectFactory>;
    // Successful load — clear the stale-chunk reload guard so a future rebuild
    // can trigger a fresh auto-reload.
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(STALE_CHUNK_RELOAD_KEY);
  } catch (err) {
    if (isChunkLoadError(err) && typeof window !== "undefined" && typeof sessionStorage !== "undefined") {
      const alreadyReloaded = sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY);
      if (!alreadyReloaded) {
        sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, String(Date.now()));
        console.warn("[branding] stale chunk for reactbits-adapters — reloading once to refresh asset hashes");
        window.location.reload();
        // Throw a placeholder so the caller's catch fires and the gradient
        // fallback paints during the reload window.
        throw new Error("Reloading to refresh stale asset chunks");
      }
    }
    throw err;
  }
  const factory = mod[keyInAdapters];
  if (typeof factory !== "function") throw new Error(`Adapter not found: ${keyInAdapters}`);
  return factory(container, tokens);
}

const EFFECTS: Partial<Record<BackgroundStyle, EffectAdapter>> = {
  // Ambient Grid — CSS-only deep-noir grid (no WebGL, no RAF). Default
  // background for the InfiniBot Noir palette. Lazy-loaded like the rest.
  "ambient-grid": {
    async mount(container, tokens) {
      const mod = await import("../components/backgrounds/ambient-grid.js");
      return mod.createAmbientGrid(container, tokens);
    },
    reskin(handle, tokens) {
      handle.update(tokens);
    },
  },
  aurora: {
    mount: (c, t) => makeReactbitsEffect(c, t, "createAurora"),
    reskin: (h, t) => h.update(t),
  },
  "faulty-terminal": {
    async mount(container, tokens) {
      const mod = await import("../components/backgrounds/faulty-terminal.js");
      return mod.createFaultyTerminal(container, { tint: tokens.primary ?? "#A7EF9E" });
    },
    reskin(handle, tokens) {
      handle.update({ tint: tokens.primary ?? "#A7EF9E" });
    },
  },
  grainient: {
    async mount(container, tokens) {
      const mod = await import("../components/backgrounds/grainient.js");
      return mod.createGrainient(container, {
        color1: tokens.primary ?? "#FF9FFC",
        color2: tokens.accent ?? "#5227FF",
        color3: tokens.surfaceTint ?? "#B497CF",
      });
    },
    reskin(handle, tokens) {
      handle.update({
        color1: tokens.primary ?? "#FF9FFC",
        color2: tokens.accent ?? "#5227FF",
        color3: tokens.surfaceTint ?? "#B497CF",
      });
    },
  },
  // Dither + Hyperspeed disabled: upstream emits a <style> element inside an
  // R3F <Canvas> tree, which the R3F reconciler tries to construct as a THREE
  // primitive ("Style is not part of the THREE namespace") and permanently
  // crashes the WebGL context for the page. Re-enable when upstream ships a
  // fix or migrate to a vendored copy with the <style> moved out of the Canvas.
  iridescence:    { mount: (c, t) => makeReactbitsEffect(c, t, "createIridescence"),   reskin: (h, t) => h.update(t) },
  "liquid-chrome":{ mount: (c, t) => makeReactbitsEffect(c, t, "createLiquidChrome"),  reskin: (h, t) => h.update(t) },
  lightning:      { mount: (c, t) => makeReactbitsEffect(c, t, "createLightning"),     reskin: (h, t) => h.update(t) },
  beams:          { mount: (c, t) => makeReactbitsEffect(c, t, "createBeams"),         reskin: (h, t) => h.update(t) },
  silk:           { mount: (c, t) => makeReactbitsEffect(c, t, "createSilk"),          reskin: (h, t) => h.update(t) },
  waves:          { mount: (c, t) => makeReactbitsEffect(c, t, "createWaves"),         reskin: (h, t) => h.update(t) },
  threads:        { mount: (c, t) => makeReactbitsEffect(c, t, "createThreads"),       reskin: (h, t) => h.update(t) },
  particles:      { mount: (c, t) => makeReactbitsEffect(c, t, "createParticles"),     reskin: (h, t) => h.update(t) },
  metaballs:      { mount: (c, t) => makeReactbitsEffect(c, t, "createMetaBalls"),     reskin: (h, t) => h.update(t) },
  orb:            { mount: (c, t) => makeReactbitsEffect(c, t, "createOrb"),           reskin: (h, t) => h.update(t) },
  balatro:        { mount: (c, t) => makeReactbitsEffect(c, t, "createBalatro"),       reskin: (h, t) => h.update(t) },
  "letter-glitch":{ mount: (c, t) => makeReactbitsEffect(c, t, "createLetterGlitch"),  reskin: (h, t) => h.update(t) },
  squares:        { mount: (c, t) => makeReactbitsEffect(c, t, "createSquares"),       reskin: (h, t) => h.update(t) },
  "dot-grid":     { mount: (c, t) => makeReactbitsEffect(c, t, "createDotGrid"),       reskin: (h, t) => h.update(t) },
};

let activeHandle: EffectHandle | null = null;
let activeStyle: BackgroundStyle | null = null;
let activeContainer: HTMLElement | null = null;
// Monotonic token for mount requests. Every call to applyBackgroundStyle
// increments this; anything awaiting an older token must discard its
// result so we never leave stale canvases stacked in the DOM.
let mountToken = 0;

function createFreshContainer(): HTMLElement {
  // Wipe any pre-existing bg layer (from prior mount or race) before the
  // next effect attaches. Targets by class so we catch orphan layers too.
  for (const orphan of Array.from(document.querySelectorAll(".infinibot-bg-layer"))) {
    orphan.parentNode?.removeChild(orphan);
  }
  const el = document.createElement("div");
  el.className = "infinibot-bg-layer";
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = [
    // inset:0, not 100vw/100vh: body is zoomed (viewport-scale.css) and
    // viewport units don't follow zoom, so a vw/vh box paints at 70%.
    "position:fixed",
    "inset:0",
    "z-index:-3",
    "pointer-events:none",
    "overflow:hidden",
    "opacity:1",
  ].join(";") + ";";
  document.body.prepend(el);
  return el;
}

function disposeActive(): void {
  if (activeHandle) {
    try { activeHandle.dispose(); } catch { /* ignore */ }
    activeHandle = null;
  }
  if (activeContainer && activeContainer.parentNode) {
    activeContainer.parentNode.removeChild(activeContainer);
  }
  // Also clean up any orphaned layers (e.g. from a race-lost mount).
  for (const orphan of Array.from(document.querySelectorAll(".infinibot-bg-layer"))) {
    orphan.parentNode?.removeChild(orphan);
  }
  activeContainer = null;
  activeStyle = null;
}

/**
 * Effects we know are safe to mount. Anything else (e.g. removed reactbits
 * components like dither/hyperspeed that crash R3F) gets coerced to "none"
 * so a stale persisted value can't keep crashing the WebGL context on
 * every page load.
 */
const SAFE_BG_STYLES = new Set<BackgroundStyle>([
  "none",
  "gradient",
  ...(Object.keys(EFFECTS) as BackgroundStyle[]),
]);

async function applyBackgroundStyle(
  style: BackgroundStyle,
  tokens: ThemeTokens,
): Promise<void> {
  if (typeof document === "undefined") return;
  // Coerce unknown / disabled styles to "gradient" so we never hand a
  // crashing effect to the React mount path.
  // Low-power devices: force the static `gradient` background — the animated
  // WebGL/canvas effects are the biggest lag source on older / ~8 GB /
  // integrated-GPU machines.
  const safeStyle: BackgroundStyle = isLowPower()
    ? "gradient"
    : SAFE_BG_STYLES.has(style)
      ? style
      : "gradient";
  document.documentElement.dataset.background = safeStyle;
  const adapter = EFFECTS[safeStyle];
  if (!adapter) {
    // "none" / "gradient" — tear down any active effect + invalidate pending.
    mountToken += 1;
    disposeActive();
    return;
  }
  style = safeStyle;
  // Same effect + already mounted → just reskin.
  if (activeHandle && activeStyle === style) {
    try { adapter.reskin(activeHandle, tokens); } catch { /* ignore */ }
    return;
  }
  // Different effect. Invalidate any pending mount, tear down the current
  // effect, then start a new mount under a fresh token.
  const myToken = ++mountToken;
  disposeActive();
  const container = createFreshContainer();
  // Wait one paint tick so the container has a real bounding rect before
  // the effect's WebGL renderer reads its size. Without this, R3F-based
  // effects mount with 0×0 textures and immediately error.
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  if (myToken !== mountToken) {
    if (container.parentNode) container.parentNode.removeChild(container);
    return;
  }
  try {
    const handle = await adapter.mount(container, tokens);
    if (myToken !== mountToken) {
      // Overtaken by a newer call — dispose ourselves and bail.
      try { handle.dispose(); } catch { /* ignore */ }
      if (container.parentNode) container.parentNode.removeChild(container);
      return;
    }
    activeHandle = handle;
    activeStyle = style;
    activeContainer = container;
    lastBackgroundError = null;
  } catch (err) {
    if (myToken !== mountToken) return; // stale error from abandoned mount
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[branding] background "${style}" failed to start`, err);
    lastBackgroundError = `Background "${style}" failed: ${msg}`;
    if (container.parentNode) container.parentNode.removeChild(container);
    document.documentElement.dataset.background = "gradient";
  }
}

let lastBackgroundError: string | null = null;
export function getLastBackgroundError(): string | null {
  return lastBackgroundError;
}

/**
 * Apply payload to the DOM: theme mode + palette/tokens + favicon + title
 * + animated background style.
 */
export function applyBrandingToDom(payload: AppBrandingPayload): void {
  if (typeof document === "undefined") return;
  setThemeMode(payload.theme.mode);
  // Expose the active palette id on :root so palette-scoped CSS (e.g. the
  // InfiniBot Noir premium gold animation suite in theme-glass.ts) can gate
  // on it. data-theme carries the light/dark/hud *mode* and would not track
  // the palette across mode switches, so the palette gets its own attribute.
  document.documentElement.dataset.palette = payload.theme.paletteId || "";
  clearThemeOverrides();
  const tokens = resolveEffectiveTokens(payload);
  if (Object.keys(tokens).length > 0) {
    applyThemeOverrides(tokens);
  }
  // Title — prefix with a tab tag so the OS-level window can be mapped back
  // to a UI-control instance for voice/multi-monitor routing. Two forms:
  //   [Alpha] InfiniBot                 (gateway-assigned codename, preferred)
  //   [infinibot:abc123] InfiniBot      (fallback before codename arrives)
  // The current title is the source of truth — strip and re-prepend, so
  // brand updates don't lose whichever form is active.
  const name = payload.branding.appName || "InfiniBot";
  const current = document.title || name;
  const m = current.match(/^\[(infinibot:[0-9a-f]+|[A-Za-z][A-Za-z\d-]*)\]\s*/i);
  const stripped = m ? current.slice(m[0].length) : current;
  const tagFromTitle = m?.[1];
  // Fallback if we somehow lost the tag: rederive the hex form from sessionStorage.
  let tag = tagFromTitle;
  if (!tag) {
    try {
      if (typeof window !== "undefined" && window.sessionStorage) {
        const id = window.sessionStorage.getItem("infinibot.tabInstanceId");
        if (id) tag = `infinibot:${id.replace(/-/g, "").slice(0, 6)}`;
      }
    } catch { /* private mode / sandboxed iframe — no tag */ }
  }
  const titled = tag ? `[${tag}] ${name}` : name;
  // Preserve any non-name suffix (e.g. " — Master Terminal" from index.html).
  const final = stripped.startsWith(name) ? titled + stripped.slice(name.length) : titled;
  if (document.title !== final) document.title = final;
  // Favicon
  const iconHref = payload.branding.faviconUrl || payload.branding.logoUrl || payload.branding.logoDataUrl;
  if (iconHref) {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    if (link.href !== iconHref) link.href = iconHref;
  }
  // Background style — drives the animated bg layer. Noir defaults to its
  // signature ambient-grid when the user hasn't picked one explicitly.
  const style: BackgroundStyle = resolveBackgroundStyle(payload);
  void applyBackgroundStyle(style, tokens);
}

/**
 * Fetch branding from gateway and apply immediately. Also subscribes to
 * "branding.update" events so peers live-update.
 */
export async function loadAppBranding(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const s = ensureState(state);
  s.loading = true;
  s.error = null;
  state.requestUpdate?.();

  try {
    const payload = (await client.request("branding.get", {})) as AppBrandingPayload;
    const withPalettes: AppBrandingPayload = {
      ...payload,
      palettes:
        Array.isArray(payload?.palettes) && payload.palettes.length > 0
          ? payload.palettes
          : BUILT_IN_PALETTES,
    };
    s.payload = withPalettes;
    s.draft = clonePayload(withPalettes);
    applyBrandingToDom(withPalettes);
    writeCachedBranding(withPalettes);
  } catch (err) {
    s.error = String((err as Error)?.message ?? err);
    // Apply the bundled defaults so the UI is never un-themed.
    s.payload = DEFAULT_BRANDING;
    s.draft = clonePayload(DEFAULT_BRANDING);
    applyBrandingToDom(DEFAULT_BRANDING);
  } finally {
    s.loading = false;
    state.requestUpdate?.();
  }

  // Subscribe to live broadcasts from peers.
  if (s.unsubscribe) {
    try {
      s.unsubscribe();
    } catch {
      /* ignore */
    }
    s.unsubscribe = null;
  }

  // Install a single beforeunload guard so users don't lose in-progress edits
  // by accidentally closing the tab. Uninstall first to avoid duplicates.
  if (s.beforeUnload && typeof window !== "undefined") {
    window.removeEventListener("beforeunload", s.beforeUnload);
  }
  const handler = (e: BeforeUnloadEvent) => {
    if (!state.appBrandingState) return;
    if (!isDraftDirty(state.appBrandingState)) return;
    e.preventDefault();
    e.returnValue = "";
  };
  s.beforeUnload = handler;
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", handler);
  }
  s.unsubscribe = client.subscribe((evt) => {
    if (!evt || (evt as any).event !== "branding.update") return;
    const next = (evt as any).payload as AppBrandingPayload | undefined;
    if (!next) return;
    const dirty = isDraftDirty(s);
    s.payload = next;
    writeCachedBranding(next);
    // Only overwrite draft + DOM when the user doesn't have unsaved edits.
    // Otherwise we'd wipe their in-progress work every time a peer saves.
    if (!dirty) {
      s.draft = clonePayload(next);
      applyBrandingToDom(next);
    }
    state.requestUpdate?.();
  });
}

export function stopAppBranding(state: AppViewState): void {
  const s = state.appBrandingState;
  if (!s) return;
  if (s.unsubscribe) {
    try {
      s.unsubscribe();
    } catch {
      /* ignore */
    }
    s.unsubscribe = null;
  }
  if (s.beforeUnload && typeof window !== "undefined") {
    try {
      window.removeEventListener("beforeunload", s.beforeUnload);
    } catch {
      /* ignore */
    }
    s.beforeUnload = null;
  }
}

function clonePayload(p: AppBrandingPayload): AppBrandingPayload {
  return {
    theme: { ...p.theme, tokens: { ...p.theme.tokens } },
    branding: { ...p.branding },
    palettes: p.palettes,
  };
}

/**
 * True when the draft has unsaved changes relative to the server payload.
 * Used to guard against broadcast events clobbering in-progress edits.
 */
export function isDraftDirty(state: AppBrandingState): boolean {
  if (!state.payload || !state.draft) return false;
  // Compare via JSON — tokens objects + branding struct are tiny.
  const norm = (p: AppBrandingPayload) =>
    JSON.stringify({ theme: p.theme, branding: p.branding });
  return norm(state.payload) !== norm(state.draft);
}

// ── Draft edits (not yet saved) ───────────────────────────────────────────

export function updateDraftThemeMode(state: AppViewState, mode: ThemeMode): void {
  const s = ensureState(state);
  if (!s.draft) return;
  s.draft = { ...s.draft, theme: { ...s.draft.theme, mode } };
  previewDraft(state);
  scheduleAutoSaveDraft(state);
  state.requestUpdate?.();
}

export function updateDraftBackground(
  state: AppViewState,
  background: BackgroundStyle,
): void {
  const s = ensureState(state);
  if (!s.draft) return;
  s.draft = { ...s.draft, theme: { ...s.draft.theme, background } };
  previewDraft(state);
  scheduleAutoSaveDraft(state);
  state.requestUpdate?.();
}

export function selectDraftPalette(state: AppViewState, paletteId: string): void {
  const s = ensureState(state);
  if (!s.draft) return;
  // Swapping palette clears token overrides so the palette shows through.
  // Also auto-match the theme mode to the palette's native mode (light/dark)
  // unless the user has explicitly pinned "system" or "hud" — those are
  // mode preferences we respect regardless of palette.
  const palette = s.draft.palettes.find((p) => p.id === paletteId);
  const currentMode = s.draft.theme.mode;
  const mode: ThemeMode =
    currentMode === "system" || currentMode === "hud"
      ? currentMode
      : palette?.mode ?? currentMode;
  s.draft = {
    ...s.draft,
    theme: { mode, paletteId, tokens: {} },
  };
  previewDraft(state);
  scheduleAutoSaveDraft(state);
  state.requestUpdate?.();
}

export function updateDraftTokens(state: AppViewState, tokens: Partial<ThemeTokens>): void {
  const s = ensureState(state);
  if (!s.draft) return;
  // Layer the user's edits ON TOP of the active palette without changing
  // paletteId. The palette stays the source of truth for any tokens the user
  // hasn't touched, so:
  //   - applyThemeOverrides only writes inline values for the keys actually
  //     overridden, leaving the rest to cascade from :root[data-theme="..."]
  //     rules in theme-glass.ts (HUD mode's --g-bg, --g-blur-heavy, custom
  //     radii, etc. survive a slider tweak instead of being overwritten by
  //     the palette's defaults)
  //   - the appearance picker's renderColor/renderSlider lookup already does
  //     `currentToken ?? paletteToken`, so untouched fields keep showing the
  //     palette default (and its × reset affordance) without us snapshotting
  //     anything
  // Pruning undefined keys keeps a × reset truly clearing — `{primary: undefined}`
  // shouldn't sit in tokens and shadow the palette default.
  const merged: ThemeTokens = { ...s.draft.theme.tokens, ...tokens };
  for (const k of Object.keys(merged) as Array<keyof ThemeTokens>) {
    if (merged[k] === undefined) delete merged[k];
  }
  s.draft = {
    ...s.draft,
    theme: { ...s.draft.theme, tokens: merged },
  };
  previewDraft(state);
  scheduleAutoSaveDraft(state);
  state.requestUpdate?.();
}

export function updateDraftBranding(
  state: AppViewState,
  patch: Partial<AppBrandingPayload["branding"]>,
): void {
  const s = ensureState(state);
  if (!s.draft) return;
  s.draft = { ...s.draft, branding: { ...s.draft.branding, ...patch } };
  previewDraft(state);
  scheduleAutoSaveDraft(state);
  state.requestUpdate?.();
}

/** Apply the draft to the DOM for instant preview without persisting. */
export function previewDraft(state: AppViewState): void {
  const s = ensureState(state);
  if (!s.draft) return;
  applyBrandingToDom(s.draft);
}

// ── Auto-save (debounced) ────────────────────────────────────────────────
//
// Every draft mutator already calls previewDraft for the live in-DOM
// preview; without an additional persist call, the change is lost as soon
// as the gateway restarts (the preview was DOM-only, never saved). The
// "Save changes" button is correct but users routinely expect modern
// settings panels to persist on tweak — so we schedule a debounced
// saveDraft right after every preview. 600ms is short enough that the
// final keystroke / slider tick survives a gateway kill but long enough
// to coalesce a flurry of changes (palette pick → mode change → color
// nudge) into one round-trip.

let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
const AUTO_SAVE_DELAY_MS = 600;

/** Cancel any pending debounced save. Used when the user explicitly hits
 *  Save (so we don't double-fire) or reverts/resets a draft. */
function cancelAutoSave(): void {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
}

/**
 * Schedule a debounced persist of the current draft. Safe to call on every
 * preview tick — the timer resets each call so we save once the user goes
 * quiet for AUTO_SAVE_DELAY_MS. Bails out if there's no client yet, or if
 * a save is already in flight (the in-flight save will write the latest
 * draft on completion).
 */
export function scheduleAutoSaveDraft(state: AppViewState): void {
  const s = ensureState(state);
  if (!state.client) return;
  if (!s.draft) return;
  cancelAutoSave();
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    if (!state.client) return;
    if (state.appBrandingState?.saving) return;
    // Only persist when the draft actually differs from the last saved
    // payload — avoids churn when the user opens the picker, peeks, and
    // backs out without changes.
    if (state.appBrandingState && !isDraftDirty(state.appBrandingState)) return;
    void saveDraft(state, state.client);
  }, AUTO_SAVE_DELAY_MS);
}

export function revertDraft(state: AppViewState): void {
  const s = ensureState(state);
  if (!s.payload) return;
  // Cancel any pending debounced save before reverting — otherwise the
  // user's "Revert" would re-fire as a save the moment AUTO_SAVE_DELAY_MS
  // elapses, undoing the revert.
  cancelAutoSave();
  s.draft = clonePayload(s.payload);
  applyBrandingToDom(s.payload);
  state.requestUpdate?.();
}

/** Reset to first built-in palette and clear overrides. */
export function resetDraftToDefault(state: AppViewState): void {
  const s = ensureState(state);
  if (!s.draft) return;
  s.draft = {
    ...s.draft,
    // Match DEFAULT_BRANDING so the UI's "Reset" button restores the same
    // first-run look (dark + InfiniBot Noir + ambient-grid + no overrides).
    theme: { mode: "dark", paletteId: "infinibot-gold", background: "ambient-grid", tokens: {} },
  };
  previewDraft(state);
  scheduleAutoSaveDraft(state);
  state.requestUpdate?.();
}

/** Persist draft via branding.set. */
export async function saveDraft(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const s = ensureState(state);
  if (!s.draft) return;
  // Cancel the debounced auto-save — we're saving NOW, no need for the
  // queued one to fire 600ms later with stale data.
  cancelAutoSave();
  s.saving = true;
  s.error = null;
  state.requestUpdate?.();
  try {
    const persisted = (await client.request("branding.set", {
      theme: {
        mode: s.draft.theme.mode,
        paletteId: s.draft.theme.paletteId,
        background: s.draft.theme.background,
        tokens: s.draft.theme.tokens,
      },
      branding: s.draft.branding,
    })) as AppBrandingPayload;
    s.payload = { ...persisted, palettes: s.payload?.palettes ?? BUILT_IN_PALETTES };
    s.draft = clonePayload(s.payload);
    applyBrandingToDom(s.payload);
    writeCachedBranding(s.payload);
    s.successMessage = "Theme + branding saved";
    setTimeout(() => {
      if (state.appBrandingState) state.appBrandingState.successMessage = null;
      state.requestUpdate?.();
    }, 3000);
  } catch (err) {
    s.error = String((err as Error)?.message ?? err);
  } finally {
    s.saving = false;
    state.requestUpdate?.();
  }
}

// ── Logo upload (data URL) ───────────────────────────────────────────────

export async function uploadLogoFile(state: AppViewState, file: File): Promise<void> {
  if (!file.type.startsWith("image/")) {
    const s = ensureState(state);
    s.error = "Logo must be an image";
    state.requestUpdate?.();
    return;
  }
  const dataUrl = await fileToDataUrl(file);
  updateDraftBranding(state, { logoDataUrl: dataUrl, logoUrl: "" });
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export { BUILT_IN_PALETTES };
