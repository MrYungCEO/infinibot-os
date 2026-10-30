/**
 * Object cover — the reusable Notion-style cover banner + card thumbnail.
 *
 * One self-contained module (module-level cache, mirrors `related-panel.ts`)
 * so it drops into ANY detail surface — the Opportunity focus page, the Clients
 * detail pane, the kanban project drawer — without touching app-view-state or
 * the host view's data flow. Two entry points:
 *
 *   renderCoverBanner(app, client, type, id, opts) → wide hero banner with the
 *     Notion affordances: empty state "Add cover"; on hover "Change cover /
 *     Upload / Add link / Reposition / Remove". Accepts drag-drop + paste.
 *   renderCoverThumb(app, client, type, id, opts)  → card thumbnail (object-fit
 *     cover, rounded) with a deterministic gradient placeholder when unset.
 *
 * Backed by the `covers.*` RPCs. Upload covers are stored as files-root paths
 * and lazily materialized to data URLs through `files.download` (exactly how the
 * issues view loads screenshots); link covers render their URL directly, so GIFs
 * animate for free.
 *
 * Graceful degradation: `covers.*` are new RPCs, so a gateway that predates them
 * rejects the request. The component then renders as if no cover were set (and
 * the affordances surface the error inline) rather than crashing the host view.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";

// ── Model (mirrors src/covers/types.ts) ──
export interface ObjectCover {
  id: string;
  objectType: string;
  objectId: string;
  source: "upload" | "link";
  url: string;
  path: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  positionY: number;
  createdAt: number;
  updatedAt: number;
}

interface Entry {
  loading: boolean;
  loaded: boolean;
  cover: ObjectCover | null;
  error: string | null;
}

const covers = new Map<string, Entry>();
/** Types whose full cover set has already been batch-fetched. */
const batched = new Set<string>();
/** type → earliest time a failed batch may be retried (see ensureCovers). */
const batchRetryAt = new Map<string, number>();
/** `type:id` → earliest time a failed single fetch may be retried. */
const coverRetryAt = new Map<string, number>();
/**
 * How long to wait before re-attempting a failed fetch. `covers.*` are new
 * RPCs, so an un-restarted gateway rejects every call — back off rather than
 * re-requesting on each render, but do keep retrying, because a gateway
 * restart is exactly what makes them start working (and it does NOT reload the
 * page, so a permanent "no cover" cache would strand every surface).
 */
const RETRY_MS = 15_000;
/** path → data URL, for upload-sourced covers pulled via files.download. */
const imageCache = new Map<string, string>();
const imageInflight = new Set<string>();
/** Per-object transient UI state (menu open, link input, busy, error). */
interface UiState {
  menuOpen: boolean;
  linkOpen: boolean;
  linkValue: string;
  busy: boolean;
  error: string | null;
}
const uiStates = new Map<string, UiState>();

const keyFor = (type: string, id: string) => `${type}:${id}`;

function entryFor(type: string, id: string): Entry {
  const k = keyFor(type, id);
  let e = covers.get(k);
  if (!e) {
    e = { loading: false, loaded: false, cover: null, error: null };
    covers.set(k, e);
  }
  return e;
}

function uiFor(type: string, id: string): UiState {
  const k = keyFor(type, id);
  let s = uiStates.get(k);
  if (!s) {
    s = { menuOpen: false, linkOpen: false, linkValue: "", busy: false, error: null };
    uiStates.set(k, s);
  }
  return s;
}

/** Drop the cached cover so the next render re-fetches. */
export function invalidateCover(type: string, id: string): void {
  covers.delete(keyFor(type, id));
  coverRetryAt.delete(keyFor(type, id));
  batched.delete(type);
  batchRetryAt.delete(type);
}

// ═══════════════════════════════════════════════════════════════════
// LOADING
// ═══════════════════════════════════════════════════════════════════

function rerender(app: AppViewState) {
  app.requestUpdate?.();
}

async function loadCover(app: AppViewState, client: GatewayBrowserClient, type: string, id: string) {
  const e = entryFor(type, id);
  if (e.loading || e.loaded) return;
  const k = keyFor(type, id);
  const retryAt = coverRetryAt.get(k);
  if (retryAt !== undefined && Date.now() < retryAt) return;
  e.loading = true;
  try {
    const res = (await client.request("covers.get", { objectType: type, objectId: id })) as {
      cover?: ObjectCover | null;
    };
    e.cover = res?.cover ?? null;
    e.loaded = true;
    e.error = null;
    coverRetryAt.delete(k);
  } catch (err) {
    // Render as "no cover", but leave the entry unloaded so a later attempt
    // (post gateway restart) can still find one.
    e.loaded = false;
    e.cover = null;
    e.error = String(err);
    coverRetryAt.set(k, Date.now() + RETRY_MS);
  } finally {
    e.loading = false;
    rerender(app);
  }
}

/**
 * Batch-prefetch every cover of a type in one round-trip. Call this from a
 * list/grid view before rendering cards so N cards cost 1 request, not N.
 */
export function ensureCovers(
  app: AppViewState,
  client: GatewayBrowserClient,
  type: string,
  ids: string[],
): void {
  if (batched.has(type)) return;
  // A gateway that predates `covers.*` rejects this call. Views re-render often,
  // so back off instead of re-requesting on every frame — but do keep retrying
  // periodically, since a restart is exactly what makes it start working.
  const retryAt = batchRetryAt.get(type);
  if (retryAt !== undefined && Date.now() < retryAt) return;
  batched.add(type);
  void (async () => {
    try {
      const res = (await client.request("covers.list", { objectType: type })) as {
        covers?: ObjectCover[];
      };
      const list = Array.isArray(res?.covers) ? res.covers : [];
      const seen = new Set<string>();
      for (const c of list) {
        covers.set(keyFor(type, c.objectId), {
          loading: false,
          loaded: true,
          cover: c,
          error: null,
        });
        seen.add(c.objectId);
      }
      // Everything asked for but absent from the response has no cover — mark
      // it loaded so each card doesn't fall back to its own covers.get.
      for (const id of ids) {
        if (seen.has(id)) continue;
        covers.set(keyFor(type, id), { loading: false, loaded: true, cover: null, error: null });
      }
      batchRetryAt.delete(type);
      rerender(app);
    } catch {
      // Un-restarted gateway: allow a later retry (and per-object fallback in
      // the meantime) without hammering it on every render.
      batched.delete(type);
      batchRetryAt.set(type, Date.now() + RETRY_MS);
    }
  })();
}

function mimeFromPath(path: string): string {
  const ext = (path.split(".").pop() || "").toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "avif") return "image/avif";
  if (ext === "svg") return "image/svg+xml";
  return "image/png";
}

/** Lazily materialize an upload-sourced cover into a data URL. */
function ensureImage(app: AppViewState, client: GatewayBrowserClient, path: string) {
  if (!path || imageCache.has(path) || imageInflight.has(path)) return;
  imageInflight.add(path);
  void (async () => {
    try {
      const res = (await client.request("files.download", { path })) as { content?: string };
      if (res?.content) {
        imageCache.set(path, `data:${mimeFromPath(path)};base64,${res.content}`);
        rerender(app);
      }
    } catch {
      /* leave uncached — the placeholder shows instead */
    } finally {
      imageInflight.delete(path);
    }
  })();
}

/** Resolve a cover to something an <img src> accepts, or undefined if pending. */
function coverSrc(
  app: AppViewState,
  client: GatewayBrowserClient,
  cover: ObjectCover | null,
): string | undefined {
  if (!cover) return undefined;
  if (cover.source === "link") return cover.url || undefined;
  ensureImage(app, client, cover.path);
  return imageCache.get(cover.path);
}

// ═══════════════════════════════════════════════════════════════════
// MUTATIONS
// ═══════════════════════════════════════════════════════════════════

function readFileAsBase64(file: File): Promise<{ base64: string; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      resolve({
        base64: dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl,
        dataUrl,
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function uploadCoverFile(
  app: AppViewState,
  client: GatewayBrowserClient,
  type: string,
  id: string,
  file: File,
): Promise<void> {
  const ui = uiFor(type, id);
  const e = entryFor(type, id);
  ui.busy = true;
  ui.error = null;
  rerender(app);
  try {
    const { base64, dataUrl } = await readFileAsBase64(file);
    const res = (await client.request("covers.upload", {
      objectType: type,
      objectId: id,
      name: file.name || "cover.png",
      content: base64,
      mimeType: file.type || "image/png",
    })) as { cover?: ObjectCover };
    if (res?.cover) {
      // Seed the cache from the bytes we already hold — no download round-trip.
      if (res.cover.path) imageCache.set(res.cover.path, dataUrl);
      e.cover = res.cover;
      e.loaded = true;
    }
    ui.menuOpen = false;
    ui.linkOpen = false;
  } catch (err) {
    ui.error = `Cover upload failed: ${String(err)}`;
  } finally {
    ui.busy = false;
    rerender(app);
  }
}

export async function setCoverLink(
  app: AppViewState,
  client: GatewayBrowserClient,
  type: string,
  id: string,
  url: string,
): Promise<void> {
  const ui = uiFor(type, id);
  const e = entryFor(type, id);
  const trimmed = url.trim();
  if (!trimmed) return;
  ui.busy = true;
  ui.error = null;
  rerender(app);
  try {
    const res = (await client.request("covers.setLink", {
      objectType: type,
      objectId: id,
      url: trimmed,
    })) as { cover?: ObjectCover };
    if (res?.cover) {
      e.cover = res.cover;
      e.loaded = true;
    }
    ui.linkOpen = false;
    ui.menuOpen = false;
    ui.linkValue = "";
  } catch (err) {
    ui.error = `Could not use that link: ${String(err)}`;
  } finally {
    ui.busy = false;
    rerender(app);
  }
}

export async function clearCover(
  app: AppViewState,
  client: GatewayBrowserClient,
  type: string,
  id: string,
): Promise<void> {
  const ui = uiFor(type, id);
  const e = entryFor(type, id);
  ui.busy = true;
  ui.error = null;
  rerender(app);
  try {
    await client.request("covers.clear", { objectType: type, objectId: id });
    e.cover = null;
    e.loaded = true;
    ui.menuOpen = false;
  } catch (err) {
    ui.error = `Could not remove the cover: ${String(err)}`;
  } finally {
    ui.busy = false;
    rerender(app);
  }
}

async function nudgePosition(
  app: AppViewState,
  client: GatewayBrowserClient,
  type: string,
  id: string,
  delta: number,
): Promise<void> {
  const e = entryFor(type, id);
  if (!e.cover) return;
  const next = Math.max(0, Math.min(100, (e.cover.positionY ?? 50) + delta));
  e.cover = { ...e.cover, positionY: next };
  rerender(app);
  try {
    await client.request("covers.setPosition", {
      objectType: type,
      objectId: id,
      positionY: next,
    });
  } catch {
    /* optimistic — the crop stays local if the gateway predates the RPC */
  }
}

// ═══════════════════════════════════════════════════════════════════
// PLACEHOLDER
// ═══════════════════════════════════════════════════════════════════

/**
 * Initials for the placeholder monogram. Splits on non-alphanumerics so a name
 * like "Northlake — Patient Intake" yields "NP", not "N—".
 */
export function monogramFor(name: string, max = 2): string {
  return (name || "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, max)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/** Stable 32-bit hash so an object's placeholder never shifts between renders. */
function hashOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * A deterministic gold-on-obsidian gradient standing in for a missing cover —
 * varied enough that a grid of cards reads as distinct, restrained enough that
 * it still looks like one designed system.
 */
export function placeholderGradient(seed: string): string {
  const h = hashOf(seed);
  const angle = 100 + (h % 80);
  const warm = 28 + (h % 26); // amber → gold band
  const cool = (h >> 5) % 2 === 0 ? 262 : 202; // violet or steel accent
  const lift = 6 + ((h >> 9) % 8);
  return `radial-gradient(120% 140% at ${18 + (h % 40)}% -10%, hsla(${warm}, 88%, ${34 + lift}%, 0.42) 0%, transparent 58%),
          radial-gradient(90% 120% at ${70 + ((h >> 3) % 24)}% 115%, hsla(${cool}, 62%, 32%, 0.30) 0%, transparent 62%),
          linear-gradient(${angle}deg, #14110a 0%, #0b0b0d 52%, #100e12 100%)`;
}

/** Faint diagonal weave layered over the placeholder so it reads as texture. */
const PLACEHOLDER_WEAVE = `repeating-linear-gradient(115deg, rgba(255,191,36,0.055) 0px, rgba(255,191,36,0.055) 1px, transparent 1px, transparent 11px)`;

// ═══════════════════════════════════════════════════════════════════
// SHARED STYLE TOKENS (black & gold glass — matches the object views)
// ═══════════════════════════════════════════════════════════════════

const C = {
  gold: "var(--g-primary)",
  goldDim: "color-mix(in srgb, var(--g-primary) 80%, #fafafa)",
  border: "color-mix(in srgb, var(--g-primary) 14%, transparent)",
  borderHover: "color-mix(in srgb, var(--g-primary) 34%, transparent)",
  text: "#f1f5f9",
  textDim: "#a1a1aa",
  textMuted: "#71717a",
  font: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
  glass: "rgba(10,10,12,0.72)",
};

const chipStyle = `
  display:inline-flex; align-items:center; gap:5px;
  background:${C.glass}; backdrop-filter:blur(10px);
  border:1px solid ${C.border}; color:${C.goldDim};
  border-radius:7px; padding:5px 10px;
  font-family:${C.font}; font-size:10.5px; font-weight:600;
  letter-spacing:0.03em; cursor:pointer; white-space:nowrap;
`;

// ═══════════════════════════════════════════════════════════════════
// BANNER
// ═══════════════════════════════════════════════════════════════════

export interface CoverBannerOptions {
  /** Banner height in px. Default 200. */
  height?: number;
  /** Seed for the placeholder gradient (defaults to the object id). */
  seed?: string;
  /** Rendered over the scrim at the bottom-left — usually the object title. */
  overlay?: TemplateResult | typeof nothing;
  /** Corner rounding, e.g. "14px 14px 0 0". Default "14px". */
  radius?: string;
  /** Hide the edit affordances (read-only surfaces). */
  readonly?: boolean;
}

/**
 * The Notion-style hero banner. Renders the cover (or an inviting empty state),
 * a gradient scrim for text legibility, and a hover toolbar with the full
 * Upload / Add link / Reposition / Remove affordance set. Accepts dropped and
 * pasted images directly onto the banner.
 */
export function renderCoverBanner(
  app: AppViewState,
  client: GatewayBrowserClient,
  type: string,
  id: string,
  opts: CoverBannerOptions = {},
): TemplateResult {
  const e = entryFor(type, id);
  if (!e.loaded && !e.loading) void loadCover(app, client, type, id);
  const ui = uiFor(type, id);
  const height = opts.height ?? 200;
  const radius = opts.radius ?? "14px";
  const cover = e.cover;
  const src = coverSrc(app, client, cover);
  const inputId = `cover-file-${type}-${id}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  const editable = !opts.readonly;

  const onFiles = (files: FileList | null) => {
    const image = files ? Array.from(files).find((f) => f.type.startsWith("image/")) : undefined;
    if (image) void uploadCoverFile(app, client, type, id, image);
  };

  const toolbar = html`
    <div
      class="cover-toolbar"
      style="position:absolute; top:12px; right:12px; z-index:3; display:flex; align-items:center; gap:6px; opacity:0; transition:opacity 160ms ease;"
    >
      ${cover
        ? html`
            <button
              title="Move the crop up"
              style=${chipStyle}
              @click=${() => void nudgePosition(app, client, type, id, -10)}
            >↑</button>
            <button
              title="Move the crop down"
              style=${chipStyle}
              @click=${() => void nudgePosition(app, client, type, id, 10)}
            >↓</button>
          `
        : nothing}
      <label for=${inputId} style=${chipStyle} title="Upload an image or GIF">
        ${ui.busy ? "Uploading…" : cover ? "Change cover" : "Upload"}
      </label>
      <button
        style=${chipStyle}
        title="Use an image or GIF URL"
        @click=${() => {
          ui.linkOpen = !ui.linkOpen;
          rerender(app);
        }}
      >Add link</button>
      ${cover
        ? html`<button
            style=${chipStyle + "color:#f87171;"}
            title="Remove this cover"
            @click=${() => void clearCover(app, client, type, id)}
          >Remove</button>`
        : nothing}
    </div>
  `;

  const linkRow = ui.linkOpen
    ? html`
        <div
          style="position:absolute; top:48px; right:12px; z-index:4; display:flex; gap:6px; align-items:center; background:${C.glass}; backdrop-filter:blur(12px); border:1px solid ${C.borderHover}; border-radius:9px; padding:7px 8px;"
          @click=${(ev: Event) => ev.stopPropagation()}
        >
          <input
            placeholder="https://…/image.gif"
            style="width:270px; background:rgba(255,255,255,0.04); border:1px solid ${C.border}; border-radius:7px; color:${C.text}; font-family:${C.font}; font-size:11px; padding:6px 9px; outline:none;"
            .value=${ui.linkValue}
            @input=${(ev: Event) => {
              ui.linkValue = (ev.target as HTMLInputElement).value;
            }}
            @keydown=${(ev: KeyboardEvent) => {
              if (ev.key === "Enter") void setCoverLink(app, client, type, id, ui.linkValue);
              if (ev.key === "Escape") {
                ui.linkOpen = false;
                rerender(app);
              }
            }}
          />
          <button
            style=${chipStyle + `background:${C.gold}; color:#1a1206; border-color:transparent;`}
            @click=${() => void setCoverLink(app, client, type, id, ui.linkValue)}
          >${ui.busy ? "…" : "Set"}</button>
        </div>
      `
    : nothing;

  return html`
    <div
      style="position:relative; width:100%; height:${height}px; flex:0 0 auto; border-radius:${radius}; overflow:hidden; box-sizing:border-box; font-family:${C.font};
             border:1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
             box-shadow:inset 0 1px 0 rgba(255,255,255,0.07),
                        inset 0 0 0 1px rgba(0,0,0,0.35),
                        0 16px 44px -16px rgba(0,0,0,0.8);"
      @mouseenter=${(ev: Event) => {
        const tb = (ev.currentTarget as HTMLElement).querySelector<HTMLElement>(".cover-toolbar");
        if (tb) tb.style.opacity = "1";
      }}
      @mouseleave=${(ev: Event) => {
        const tb = (ev.currentTarget as HTMLElement).querySelector<HTMLElement>(".cover-toolbar");
        if (tb && !ui.linkOpen) tb.style.opacity = "0";
      }}
      @dragover=${(ev: DragEvent) => {
        if (!editable) return;
        ev.preventDefault();
        (ev.currentTarget as HTMLElement).style.borderColor = C.borderHover;
      }}
      @dragleave=${(ev: DragEvent) => {
        (ev.currentTarget as HTMLElement).style.borderColor = C.border;
      }}
      @drop=${(ev: DragEvent) => {
        if (!editable) return;
        ev.preventDefault();
        (ev.currentTarget as HTMLElement).style.borderColor = C.border;
        onFiles(ev.dataTransfer?.files ?? null);
      }}
      @paste=${(ev: ClipboardEvent) => {
        if (!editable) return;
        const items = ev.clipboardData?.items;
        if (!items) return;
        for (const it of Array.from(items)) {
          if (it.kind === "file" && it.type.startsWith("image/")) {
            const f = it.getAsFile();
            if (f) {
              void uploadCoverFile(app, client, type, id, f);
              return;
            }
          }
        }
        const text = ev.clipboardData?.getData("text/plain")?.trim();
        if (text && /^https?:\/\/\S+$/i.test(text)) void setCoverLink(app, client, type, id, text);
      }}
    >
      <!-- Image / placeholder -->
      ${src
        ? html`<img
            src=${src}
            alt=${cover?.name || "cover"}
            style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover; object-position:50% ${cover?.positionY ?? 50}%; display:block;"
          />`
        : html`<div
            style="position:absolute; inset:0; background:${PLACEHOLDER_WEAVE}, ${placeholderGradient(opts.seed || id)};"
          ></div>`}

      <!-- Scrim: keeps the overlaid title legible over any image -->
      <div
        style="position:absolute; inset:0; z-index:1; pointer-events:none;
               background:linear-gradient(180deg, rgba(0,0,0,0.30) 0%, rgba(0,0,0,0) 36%, rgba(0,0,0,0.40) 74%, rgba(0,0,0,0.82) 100%),
                          radial-gradient(120% 90% at 0% 100%, rgba(0,0,0,0.45) 0%, transparent 62%);"
      ></div>

      ${editable ? toolbar : nothing}
      ${editable ? linkRow : nothing}

      <!-- Empty-state invitation (only when there is genuinely no cover) -->
      ${!cover && editable
        ? html`<label
            for=${inputId}
            style="position:absolute; left:14px; top:12px; z-index:3; ${chipStyle} border-style:dashed; color:${C.textDim};"
            title="Upload an image or GIF, drop one here, or paste a link"
          >＋ Add cover</label>`
        : nothing}

      ${ui.error
        ? html`<div
            style="position:absolute; left:14px; top:48px; z-index:4; max-width:60%; background:rgba(30,8,8,0.86); border:1px solid rgba(248,113,113,0.4); color:#f87171; border-radius:8px; padding:6px 9px; font-size:10.5px;"
          >${ui.error}</div>`
        : nothing}

      <!-- Host-supplied overlay (title block) sits above the scrim -->
      ${opts.overlay
        ? html`<div
            style="position:absolute; left:22px; right:22px; bottom:16px; z-index:2;
                   text-shadow:0 1px 10px rgba(0,0,0,0.9), 0 0 26px rgba(0,0,0,0.55);"
          >
            ${opts.overlay}
          </div>`
        : nothing}

      <input
        id=${inputId}
        type="file"
        accept="image/*"
        style="display:none;"
        @change=${(ev: Event) => {
          const input = ev.target as HTMLInputElement;
          onFiles(input.files);
          input.value = "";
        }}
      />
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════
// CARD THUMBNAIL
// ═══════════════════════════════════════════════════════════════════

export interface CoverThumbOptions {
  /** Thumbnail height in px. Default 84. */
  height?: number;
  /** Placeholder gradient seed (defaults to the object id). */
  seed?: string;
  /** Corner rounding. Default "8px 8px 0 0" (sits flush at a card's top). */
  radius?: string;
  /** Two-or-three-letter monogram drawn on the placeholder. */
  monogram?: string;
}

/**
 * The card-grid thumbnail: object-fit cover, rounded, with the deterministic
 * gradient placeholder (plus an optional monogram) when the object has no cover.
 * Read-only by design — covers are set from the object's detail page.
 */
export function renderCoverThumb(
  app: AppViewState,
  client: GatewayBrowserClient,
  type: string,
  id: string,
  opts: CoverThumbOptions = {},
): TemplateResult {
  const e = entryFor(type, id);
  // Only fall back to a per-object fetch when no batch prefetch covered us.
  if (!e.loaded && !e.loading && !batched.has(type)) void loadCover(app, client, type, id);
  const height = opts.height ?? 84;
  const radius = opts.radius ?? "8px 8px 0 0";
  const src = coverSrc(app, client, e.cover);
  const mono = (opts.monogram || "").slice(0, 3).toUpperCase();

  return html`
    <div
      style="position:relative; width:100%; height:${height}px; border-radius:${radius}; overflow:hidden; flex:0 0 auto;"
    >
      ${src
        ? html`<img
            src=${src}
            alt=${e.cover?.name || ""}
            loading="lazy"
            style="width:100%; height:100%; object-fit:cover; object-position:50% ${e.cover?.positionY ?? 50}%; display:block;"
          />`
        : html`<div
            style="width:100%; height:100%; background:${PLACEHOLDER_WEAVE}, ${placeholderGradient(opts.seed || id)}; display:flex; align-items:center; justify-content:center;"
          >
            ${mono
              ? html`<span
                  style="font-family:${C.font}; font-size:${Math.round(height / 3.4)}px; font-weight:800; letter-spacing:0.14em; color:color-mix(in srgb, var(--g-primary) 34%, transparent);"
                >${mono}</span>`
              : nothing}
          </div>`}
      <!-- Bottom fade so card text below the thumb doesn't fight the image -->
      <div
        style="position:absolute; inset:0; background:linear-gradient(180deg, rgba(0,0,0,0.06) 0%, transparent 46%, rgba(0,0,0,0.40) 100%); pointer-events:none;"
      ></div>
    </div>
  `;
}
