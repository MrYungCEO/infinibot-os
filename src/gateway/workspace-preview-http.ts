/**
 * Workspace preview — static file server for the workspace UI's iframe.
 *
 * GET /api/workspace/preview/<directoryId>/<rel-path>
 *
 * Streams files from the directory entry's local path so the workspace
 * Preview pane can render local HTML/CSS/JS sites without needing a dev
 * server. Path traversal is rejected by anchoring the resolved file path
 * back to the entry's root.
 */
import { createReadStream, statSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { resolveStateDir } from "../config/paths.js";
import { getDirectoryStore } from "../directories/store.js";

const PREFIX = "/api/workspace/preview/";

export async function handleWorkspacePreviewRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!req.url || !req.url.startsWith(PREFIX)) return false;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    });
    res.end();
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return true;
  }

  const rest = req.url.slice(PREFIX.length);
  const queryIdx = rest.indexOf("?");
  const pathPart = queryIdx >= 0 ? rest.slice(0, queryIdx) : rest;
  const [directoryId, ...rel] = pathPart.split("/");
  if (!directoryId) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("missing directoryId");
    return true;
  }

  const relativePath = decodeURIComponent(rel.join("/") || "index.html");
  const entry = getDirectoryStore(resolveStateDir()).get(decodeURIComponent(directoryId));
  if (!entry) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("workspace not found");
    return true;
  }

  // Stored paths may use backslashes (the store normalises to Windows
  // separators); flip them to forward slashes so resolvePath works on
  // POSIX hosts too.
  const root = resolvePath(entry.path.replace(/\\/g, "/"));
  const abs = resolvePath(root, relativePath);
  // Anchor strictly within the workspace root to block `..` traversal.
  if (abs !== root && !abs.startsWith(root + sep)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("forbidden");
    return true;
  }

  try {
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      // Auto-serve an index.html from a directory request — same convention
      // as static hosts so links like `/sub/` work in user HTML.
      const indexAbs = resolvePath(abs, "index.html");
      try {
        const idxStat = statSync(indexAbs);
        sendFile(req, res, indexAbs, idxStat.size);
        return true;
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("directory has no index.html");
        return true;
      }
    }
    sendFile(req, res, abs, stat.size);
    return true;
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("file not found");
    return true;
  }
}

function sendFile(req: IncomingMessage, res: ServerResponse, abs: string, size: number): void {
  res.writeHead(200, {
    "Content-Type": mimeFor(abs),
    "Content-Length": size,
    "Cache-Control": "no-cache",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(abs).pipe(res);
}

function mimeFor(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "js":
    case "mjs":
    case "cjs":
      return "text/javascript; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "map":
      return "application/json; charset=utf-8";
    case "md":
      return "text/markdown; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "ico":
      return "image/x-icon";
    case "woff":
      return "font/woff";
    case "woff2":
      return "font/woff2";
    case "ttf":
      return "font/ttf";
    case "otf":
      return "font/otf";
    case "pdf":
      return "application/pdf";
    case "txt":
      return "text/plain; charset=utf-8";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    default:
      return "application/octet-stream";
  }
}
