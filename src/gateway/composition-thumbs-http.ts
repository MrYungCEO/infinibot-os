/**
 * GET /api/compositions/:compositionId/thumbnail.png
 *
 * Returns the cached PNG thumbnail for a composition. If the file isn't
 * cached yet, kicks off generation in the background and responds 202.
 * Operator UIs (the templates gallery, the composition picker) just
 * stitch the URL into their `<img src>` and re-load when the request
 * eventually succeeds.
 */

import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import { resolveStateDir } from "../config/paths.js";
import { getCompositionsStore } from "../compositions/store.js";
import { ensureThumbnail, lookupThumbnail } from "../compositions/thumbnails.js";

const PREFIX = "/api/compositions/";
const SUFFIX = "/thumbnail.png";

export async function handleCompositionThumbnailRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? "";
  if (!url.startsWith(PREFIX)) return false;
  const tail = url.slice(PREFIX.length).split("?")[0]!;
  if (!tail.endsWith(SUFFIX)) return false;

  const compositionId = decodeURIComponent(tail.slice(0, -SUFFIX.length));
  if (!compositionId) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end();
    return true;
  }

  const store = getCompositionsStore(resolveStateDir());
  const comp = store.get(compositionId);
  if (!comp) {
    res.statusCode = 404;
    res.end();
    return true;
  }
  const rev = comp.updatedAt ?? 0;
  const info = lookupThumbnail(compositionId, rev);

  if (info.ready) {
    serveFile(res, info.path);
    return true;
  }

  // Kick off generation in the background; respond with a placeholder
  // immediately. The operator UI re-fetches once it sees the 202.
  const gatewayPort = Number(process.env.INFINIBOT_GATEWAY_PORT) || 18789;
  void ensureThumbnail(compositionId, rev, gatewayPort).catch(() => {
    /* generation errors are logged inside ensureThumbnail */
  });
  res.statusCode = 202;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Retry-After", "3");
  res.end("generating");
  return true;
}

function serveFile(res: ServerResponse, path: string): void {
  try {
    const stat = statSync(path);
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", String(stat.size));
    // Bake the rev into the file name → URL — so we can let the browser
    // cache aggressively.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    createReadStream(path).pipe(res);
  } catch {
    res.statusCode = 404;
    res.end();
  }
}
