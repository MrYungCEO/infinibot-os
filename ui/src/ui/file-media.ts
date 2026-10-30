/**
 * In-memory media loading for the Files browser + viewer.
 *
 * Bytes arrive over RPC as base64 and become blob: URLs or downscaled data:
 * thumbnails held only in memory. Nothing is written to disk or to any
 * browser cache. Secure-lane media is decrypted on view via
 * files.secure.download / files.video.media({secure}), and its thumbnails sit
 * in a separate map that is wiped the moment Secure Mode locks.
 */
import type { BrowserItem } from "./files-organize";
import { mimeForName } from "./file-mime";

export interface MediaClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

const THUMB_PX = 360;
const THUMB_MAX_BYTES = 12 * 1024 * 1024;
const THUMB_CACHE_MAX = 240;
const FALLBACK_MAX_BYTES = 2.5 * 1024 * 1024;

const thumbs = new Map<string, string>();
const secureThumbs = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();
let queue: Array<() => void> = [];
let active = 0;
const CONCURRENCY = 5;
/** null = untested, false = this gateway has no files.thumb (fall back to full downloads). */
let thumbRpc: boolean | null = null;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let paused = 0;
let resumeWaiters: Array<() => void> = [];

/** While the viewer is open its full-size media gets the socket; thumbnails wait. */
export function pauseThumbs(): () => void {
  paused++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    paused = Math.max(0, paused - 1);
    if (!paused) {
      const w = resumeWaiters;
      resumeWaiters = [];
      for (const r of w) r();
    }
  };
}

async function limit<T>(fn: () => Promise<T>): Promise<T> {
  while (paused) await new Promise<void>((r) => resumeWaiters.push(r));
  if (active >= CONCURRENCY) await new Promise<void>((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

/** Full file bytes → blob: URL (caller revokes). */
export async function loadFileBlob(
  client: MediaClient,
  item: Pick<BrowserItem, "name" | "path" | "ocrId" | "secure">,
): Promise<{ url: string; mime: string; size: number } | null> {
  if (item.secure) {
    if (!item.ocrId) return null;
    const r = await client.request<{ content: string; mime: string; name: string }>("files.secure.download", { id: item.ocrId });
    if (!r?.content) return null;
    const bytes = b64ToBytes(r.content);
    const mime = r.mime || mimeForName(item.name);
    return { url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })), mime, size: bytes.length };
  }
  if (!item.path) return null;
  const r = await client.request<{ content: string; name: string }>("files.download", { path: item.path });
  if (!r?.content) return null;
  const bytes = b64ToBytes(r.content);
  const mime = mimeForName(item.name);
  return { url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })), mime, size: bytes.length };
}

/** The 360p video proxy the video pipeline made (works in both lanes). */
export async function loadVideoProxy(client: MediaClient, ref: Record<string, unknown>): Promise<string | null> {
  const parts: BlobPart[] = [];
  let offset = 0;
  for (let i = 0; i < 400; i++) {
    const r = await client.request<{ found: boolean; content?: string; done?: boolean }>("files.video.media", { ...ref, offset });
    if (!r?.found || !r.content) break;
    const bin = b64ToBytes(r.content);
    parts.push(bin as BlobPart);
    offset += bin.length;
    if (r.done) break;
  }
  return parts.length ? URL.createObjectURL(new Blob(parts, { type: "video/mp4" })) : null;
}

async function downscale(src: string): Promise<string | null> {
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const scale = Math.min(1, THUMB_PX / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
  const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  try {
    return c.toDataURL("image/webp", 0.82);
  } catch {
    return null;
  }
}

function remember(map: Map<string, string>, key: string, url: string) {
  map.set(key, url);
  if (map.size > THUMB_CACHE_MAX) map.delete(map.keys().next().value as string);
}

export function cachedThumb(item: Pick<BrowserItem, "key" | "secure">): string | null {
  return (item.secure ? secureThumbs : thumbs).get(item.key) ?? null;
}

/** Downscaled in-memory thumbnail for images and analysed videos. */
export function loadThumb(client: MediaClient, item: BrowserItem): Promise<string | null> {
  const map = item.secure ? secureThumbs : thumbs;
  const hit = map.get(item.key);
  if (hit) return Promise.resolve(hit);
  const k = `${item.secure ? "s" : "n"}:${item.key}`;
  const pending = inflight.get(k);
  if (pending) return pending;
  const p = limit(async () => {
    try {
      if (item.kind === "image" && !item.secure && item.path && thumbRpc !== false) {
        // files.thumb: server-side 360px webp (gateways from this release on).
        try {
          const r = await client.request<{ mime: string; content: string }>("files.thumb", { path: item.path, size: THUMB_PX });
          if (r?.content) {
            thumbRpc = true;
            const t = `data:${r.mime || "image/webp"};base64,${r.content}`;
            remember(map, item.key, t);
            return t;
          }
        } catch (err) {
          if (/unknown method|not found|unsupported/i.test(String((err as Error)?.message ?? err)) && thumbRpc === null) thumbRpc = false;
        }
      }
      if (item.kind === "image") {
        // Full-file fallback (secure lane, or gateways without files.thumb): base64 over
        // the socket is slow, so very large normal-lane originals keep their icon tile.
        const cap = item.secure ? THUMB_MAX_BYTES : FALLBACK_MAX_BYTES;
        if (item.size > cap || /\.(heic|heif|tiff?)$/i.test(item.name)) return null;
        const blob = await loadFileBlob(client, item);
        if (!blob) return null;
        try {
          const t = await downscale(blob.url);
          if (t) remember(map, item.key, t);
          return t;
        } finally {
          URL.revokeObjectURL(blob.url);
        }
      }
      if (item.kind === "video" && item.ocrId) {
        const ref = { id: item.ocrId, ...(item.secure ? { secure: true } : {}) };
        const v = await client.request<{ found: boolean; video?: { keyframes?: Array<{ id: string; t: number }> } | null }>("files.video.get", ref);
        const kf = v?.video?.keyframes?.[Math.min(1, (v.video.keyframes.length || 1) - 1)];
        if (!kf) return null;
        const f = await client.request<{ found: boolean; mime?: string; content?: string }>("files.video.frame", { ...ref, frame: kf.id });
        if (!f?.found || !f.content) return null;
        const t = (await downscale(`data:${f.mime ?? "image/jpeg"};base64,${f.content}`)) ?? null;
        if (t) remember(map, item.key, t);
        return t;
      }
    } catch {
      /* thumbnail is best-effort */
    }
    return null;
  }).finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

/** Secure Mode locked → drop every decrypted thumbnail. */
export function clearSecureThumbs() {
  secureThumbs.clear();
}
