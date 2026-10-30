/**
 * GET /api/plugin-assets/<pluginId>/<path>
 *
 * Serves the images a plugin's store `listing` declares (cover, icon,
 * screenshots) for Setup › Plugins. Safety, in order:
 *  - behind the central HTTP gate: `/api/` is never public, so the gateway
 *    credential (header or session cookie) is required;
 *  - only files the listing DECLARES are served — anything else is a 404,
 *    so traversal (`..`, encoded slashes, absolute paths) has nothing to hit;
 *  - the resolved real path must still sit inside the plugin folder
 *    (symlinks can't escape) and be a regular file under 2 MB;
 *  - `nosniff` + a locked-down CSP (SVGs can't run script even if opened
 *    directly).
 */

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import {
  LISTING_IMAGE_EXTENSIONS,
  PLUGIN_ASSET_ROUTE_PREFIX,
  isSafeListingAssetPath,
  listingAssetPaths,
} from "../plugins/listing.js";
import type { PluginRecord } from "../plugins/registry.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";

const MAX_ASSET_BYTES = 2 * 1024 * 1024;

export type PluginAssetResolution =
  | { ok: true; file: string; contentType: string; size: number }
  | { ok: false; status: 400 | 404; reason: string };

/**
 * Map a request path tail (`<id>/<path>`, still URL-encoded) to a file on
 * disk, or refuse. Pure apart from fs reads; exported for tests.
 */
export function resolvePluginAsset(
  tail: string,
  plugins: Pick<PluginRecord, "id" | "rootDir" | "listing">[],
): PluginAssetResolution {
  const slash = tail.indexOf("/");
  if (slash <= 0) return { ok: false, status: 400, reason: "expected <pluginId>/<path>" };
  let id: string;
  let rel: string;
  try {
    id = decodeURIComponent(tail.slice(0, slash));
    // Decode each segment separately so an encoded "/" can't create a segment.
    const parts = tail
      .slice(slash + 1)
      .split("/")
      .map((s) => decodeURIComponent(s));
    if (parts.some((s) => s.includes("/") || s.includes("\\"))) {
      return { ok: false, status: 400, reason: "bad path" };
    }
    rel = parts.join("/");
  } catch {
    return { ok: false, status: 400, reason: "bad encoding" };
  }
  if (!isSafeListingAssetPath(rel)) return { ok: false, status: 400, reason: "bad path" };
  const record = plugins.find((p) => p.id === id);
  if (!record?.rootDir) return { ok: false, status: 404, reason: "unknown plugin" };
  if (!listingAssetPaths(record.listing).includes(rel)) {
    return { ok: false, status: 404, reason: "not a declared listing asset" };
  }
  let root: string;
  let file: string;
  try {
    root = fs.realpathSync(record.rootDir);
    file = fs.realpathSync(path.join(root, ...rel.split("/")));
  } catch {
    return { ok: false, status: 404, reason: "missing file" };
  }
  const relToRoot = path.relative(root, file);
  if (!relToRoot || relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
    return { ok: false, status: 404, reason: "outside the plugin folder" };
  }
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) {
    return { ok: false, status: 404, reason: "not a servable file" };
  }
  const contentType = LISTING_IMAGE_EXTENSIONS[path.extname(file).toLowerCase()];
  if (!contentType) return { ok: false, status: 404, reason: "not an image" };
  return { ok: true, file, contentType, size: stat.size };
}

export function handlePluginAssetRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url ?? "";
  if (!url.startsWith(PLUGIN_ASSET_ROUTE_PREFIX)) return false;
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return true;
  }
  const tail = url.slice(PLUGIN_ASSET_ROUTE_PREFIX.length).split(/[?#]/)[0] ?? "";
  const result = resolvePluginAsset(tail, getActivePluginRegistry()?.plugins ?? []);
  if (!result.ok) {
    res.writeHead(result.status, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(result.reason);
    return true;
  }
  res.writeHead(200, {
    "Content-Type": result.contentType,
    "Content-Length": String(result.size),
    "Cache-Control": "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  if (method === "HEAD") {
    res.end();
    return true;
  }
  fs.createReadStream(result.file).pipe(res);
  return true;
}
