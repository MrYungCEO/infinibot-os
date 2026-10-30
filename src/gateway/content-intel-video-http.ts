/**
 * GET /plugins/content-studio/video?shortcode=<sc> (served by the
 * content-studio plugin; this was core's /api/content-intel/video/<sc>.mp4)
 *
 * Streams the locally-downloaded reel video for a shortcode so the Content
 * Intelligence dashboard can play covers inline (click a thumbnail → lightbox
 * <video>). The mp4s live under the reel-pipeline output dir keyed by an opaque
 * media id, so we resolve shortcode → path via the same sidecar scan the
 * pipeline uses (cached in-process — the output tree is large).
 *
 * Supports HTTP Range requests (206 Partial Content) so the browser can seek
 * and stream without downloading the whole file up front. We never copy the
 * 1.6GB of videos into ui/public — they're streamed on demand from disk.
 */

import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import { resolveReelVideoPath } from "../content/intelligence/pipeline-wrapper.js";

/** shortcode → resolved mp4 path (or null if no local file). */
const pathCache = new Map<string, string | null>();

function resolvePath(shortcode: string): string | null {
  if (pathCache.has(shortcode)) return pathCache.get(shortcode)!;
  const p = resolveReelVideoPath(shortcode);
  pathCache.set(shortcode, p);
  return p;
}

export async function streamReelVideo(
  shortcode: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  // Shortcodes are alphanumeric + - and _ — reject anything else (path safety).
  if (!shortcode || !/^[A-Za-z0-9_-]+$/.test(shortcode)) {
    res.statusCode = 400;
    res.end();
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end();
    return true;
  }

  const path = resolvePath(shortcode);
  if (!path) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("no local video for this reel");
    return true;
  }

  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    pathCache.delete(shortcode); // stale cache entry — force re-resolve next time
    res.statusCode = 404;
    res.end();
    return true;
  }

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "public, max-age=86400");

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (Number.isNaN(start)) start = 0;
      if (Number.isNaN(end) || end >= size) end = size - 1;
      if (start > end || start >= size) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${size}`);
        res.end();
        return true;
      }
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", String(end - start + 1));
      if (req.method === "HEAD") {
        res.end();
        return true;
      }
      createReadStream(path, { start, end }).pipe(res);
      return true;
    }
  }

  res.statusCode = 200;
  res.setHeader("Content-Length", String(size));
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(path).pipe(res);
  return true;
}
