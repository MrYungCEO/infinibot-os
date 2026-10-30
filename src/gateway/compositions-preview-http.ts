/**
 * GET /api/compositions/:compositionId/preview.html
 *
 * Returns the hyperframes-rendered HTML for a composition with the
 * runtime IIFE inlined. Served from the gateway origin so the embedded
 * iframe in the video editor stage resolves `/media/...` asset URLs
 * against the same host that's serving them. Used by the editor's
 * "HF Stage" mode to drive a live hyperframes preview from the
 * existing playhead via `iframe.contentWindow.__player.seek(t)`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { resolveStateDir } from "../config/paths.js";
import { getCompositionsStore } from "../compositions/store.js";

const PREFIX = "/api/compositions/";
const SUFFIX = "/preview.html";

export async function handleCompositionPreviewRequest(
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

  try {
    const store = getCompositionsStore(resolveStateDir());
    const comp = store.getWithChildren(compositionId);
    if (!comp) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`Composition ${compositionId} not found`);
      return true;
    }
    const { buildRenderHtml } = await import("../compositions/render.js");
    const html = buildRenderHtml(comp);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(html);
    }
    return true;
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end((err as Error).message);
    return true;
  }
}
