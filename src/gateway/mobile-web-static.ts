/**
 * Static handler for the bundled Expo web export.
 *
 * Serves the contents of the parent repo's `mobile/dist` (built via
 * `pnpm mobile:web:build`, which runs `expo export --platform web
 * --output-dir dist`) at the `/mobile-web/*` path on the same gateway
 * HTTP port that hosts the control UI. With this in place the desktop
 * UI can iframe `/mobile-web/index.html` and serve the production
 * mobile experience without a Metro dev server.
 *
 * Resolution mirrors `control-ui.ts:resolveControlUiRoot()`:
 *   1. Packaged Electron: `<resources>/app/mobile-web/index.html`
 *   2. Dev (compiled): `dist/gateway/.. → mobile/dist/index.html`
 *   3. Fallback: `<cwd>/mobile/dist/index.html`
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

export const MOBILE_WEB_PREFIX = "/mobile-web";

let cachedRoot: string | null | undefined;
/** Test-only override of the directories searched for the bundle. */
let testCandidates: string[] | null = null;

function resolveMobileWebRoot(): string | null {
  if (cachedRoot !== undefined) return cachedRoot;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // process.execPath points at the Electron exe (or node) — when
  // packaged the structure is `<exec-dir>/resources/app/mobile-web`.
  const execResources = (() => {
    try {
      return path.resolve(
        path.dirname(fs.realpathSync(process.execPath)),
        "resources",
        "app",
        "mobile-web",
      );
    } catch {
      return null;
    }
  })();
  const repoRootEnv = process.env.INFINIBOT_REPO_ROOT;
  const candidates = [
    execResources,
    // Repo-root override (launcher.js sets this in the Electron app)
    repoRootEnv ? path.join(repoRootEnv, "mobile", "dist") : null,
    // Running from compiled dist/gateway/ → ../../mobile/dist
    path.resolve(here, "../../mobile/dist"),
    // Source tree: src/gateway/ → ../../mobile/dist
    path.resolve(here, "../../../mobile/dist"),
    // Last resort: cwd
    path.resolve(process.cwd(), "mobile", "dist"),
  ].filter((p): p is string => Boolean(p));

  for (const dir of testCandidates ?? candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) {
      cachedRoot = dir;
      return dir;
    }
  }
  // Don't remember a miss: the bundle is often exported AFTER the gateway
  // started (`npm run web:build` → mobile/dist), and caching null kept
  // /mobile-web on 503 until a restart. A miss costs a few existsSync calls.
  return null;
}

// Test-only: drop the cached root so a unit test can re-resolve after
// changing env vars or moving fixture directories.
export function _resetMobileWebRootForTests(candidates: string[] | null = null): void {
  cachedRoot = undefined;
  testCandidates = candidates;
}

function contentTypeForExt(ext: string): string {
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".wasm":
      return "application/wasm";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".otf":
      return "font/otf";
    default:
      return "application/octet-stream";
  }
}

function respondNotFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Not Found");
}

function isSafeRelativePath(relPath: string): boolean {
  if (!relPath) return true;
  const normalized = path.posix.normalize(relPath);
  if (normalized.startsWith("../") || normalized === "..") return false;
  if (normalized.includes("\0")) return false;
  return true;
}

function serveFile(res: ServerResponse, filePath: string): void {
  const ext = path.extname(filePath).toLowerCase();
  res.statusCode = 200;
  res.setHeader("Content-Type", contentTypeForExt(ext));
  // Assets from Expo's web export are hashed in filenames, so they're
  // safe to cache aggressively. index.html is not — fall back to
  // no-cache so a redeploy is picked up immediately.
  if (filePath.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-cache");
  } else {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }
  res.end(fs.readFileSync(filePath));
}

/**
 * Returns true when the request has been fully handled (response sent),
 * false when the caller should fall through to the next handler.
 */
export function handleMobileWebHttpRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const urlRaw = req.url;
  if (!urlRaw) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const url = new URL(urlRaw, "http://localhost");
  const pathname = url.pathname;
  if (pathname !== MOBILE_WEB_PREFIX && !pathname.startsWith(`${MOBILE_WEB_PREFIX}/`)) {
    return false;
  }

  const root = resolveMobileWebRoot();
  if (!root) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(
      "Mobile web bundle not found. Build it with `pnpm mobile:web:build` (writes to mobile/dist).",
    );
    return true;
  }

  // Trailing-slash redirect so relative asset URLs resolve correctly.
  if (pathname === MOBILE_WEB_PREFIX) {
    res.statusCode = 302;
    res.setHeader("Location", `${MOBILE_WEB_PREFIX}/${url.search}`);
    res.end();
    return true;
  }

  const rel = pathname.slice(`${MOBILE_WEB_PREFIX}/`.length);
  const requested = !rel || rel.endsWith("/") ? `${rel}index.html` : rel;
  if (!isSafeRelativePath(requested)) {
    respondNotFound(res);
    return true;
  }

  const filePath = path.join(root, requested);
  if (!filePath.startsWith(root)) {
    respondNotFound(res);
    return true;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    if (req.method === "HEAD") {
      res.statusCode = 200;
      res.setHeader("Content-Type", contentTypeForExt(path.extname(filePath).toLowerCase()));
      res.end();
      return true;
    }
    serveFile(res, filePath);
    return true;
  }

  // SPA fallback — Expo's web export uses client-side routing for
  // tab/stack navigators. Send index.html for anything that doesn't
  // resolve to a real file.
  const indexPath = path.join(root, "index.html");
  if (fs.existsSync(indexPath)) {
    serveFile(res, indexPath);
    return true;
  }

  respondNotFound(res);
  return true;
}
