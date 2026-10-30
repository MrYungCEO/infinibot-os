/**
 * Design page — HTTP handler for artifact files.
 *
 * Serves `/api/design/preview/<projectId>/<...path>` straight from the
 * project's workspace dir. Used as the `src` of the iframe preview pane.
 *
 * Path traversal is rejected (no leading `/`, no `..` segments). The
 * project must exist in the store; the artifact must exist on disk.
 */

import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import { STATE_DIR } from "../config/paths.js";
import { getDesignStore } from "../design/store.js";
import { resolveArtifactPath } from "../design/artifacts.js";

const PREFIX = "/api/design/preview/";

export async function handleDesignPreviewRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!req.url || !req.url.startsWith(PREFIX)) return false;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
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
  const [projectId, ...rel] = pathPart.split("/");
  if (!projectId) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("missing projectId");
    return true;
  }
  const relativePath = decodeURIComponent(rel.join("/") || "index.html");
  const project = getDesignStore(STATE_DIR).getProject(projectId);
  if (!project) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("project not found");
    return true;
  }
  const abs = resolveArtifactPath(project.workspaceDir, relativePath);
  if (!abs) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("file not found");
    return true;
  }
  try {
    const stat = statSync(abs);
    const ct = mimeFor(abs);
    res.writeHead(200, {
      "Content-Type": ct,
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
      // Allow the host UI's iframe to load this regardless of origin.
      "Access-Control-Allow-Origin": "*",
      // Permit fetching from the host UI even when served on a different port.
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    createReadStream(abs).pipe(res);
    return true;
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(String(err));
    return true;
  }
}

function mimeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
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
    case "pdf":
      return "application/pdf";
    case "txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
