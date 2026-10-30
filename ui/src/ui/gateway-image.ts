/**
 * Images served by the gateway's protected HTTP routes (e.g. plugin listing
 * covers under /api/plugins/assets/…) for `<img src>`.
 *
 * Same origin (self-hosted): the path is used as-is — the session cookie
 * authenticates it. Hosted cloud: the UI is on another site than the tenant
 * gateway, so an `<img>` can carry neither the Bearer nor the cookie. There the
 * image is fetched with the Clerk Bearer (the gateway fetch wrapper adds it)
 * and shown from a `blob:` URL.
 */

import { gatewayHttpBase } from "./gateway-http-auth";

type Entry = { url: string | null; pending?: Promise<void> };
const cache = new Map<string, Entry>();

/** True when `src` is a gateway path that needs the cross-site loader. */
export function needsGatewayImageLoader(src: string | undefined): boolean {
  return Boolean(src && src.startsWith("/") && !src.startsWith("//") && gatewayHttpBase() !== "");
}

/**
 * The `<img src>` to use now. For a cross-site gateway path this starts a
 * Bearer fetch and returns undefined until it resolves; `onChange` fires once
 * the blob URL (or a failure → `onError`) is known.
 */
export function gatewayImageSrc(
  src: string | undefined,
  onChange: () => void,
  onError?: () => void,
): string | undefined {
  if (!src) return undefined;
  if (!needsGatewayImageLoader(src)) return src;
  const hit = cache.get(src);
  if (hit) {
    if (hit.url) return hit.url;
    if (!hit.pending) {
      onError?.();
      return undefined;
    }
    void hit.pending.then(onChange);
    return undefined;
  }
  const entry: Entry = { url: null };
  entry.pending = (async () => {
    try {
      const res = await fetch(`${gatewayHttpBase()}${src}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      entry.url = URL.createObjectURL(await res.blob());
    } catch {
      entry.url = null;
      onError?.();
    } finally {
      entry.pending = undefined;
    }
  })();
  cache.set(src, entry);
  void entry.pending.then(onChange);
  return undefined;
}
