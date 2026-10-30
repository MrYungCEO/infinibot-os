import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { InfinibotConfig } from "../config/config.js";
import { isSaasMode, getClerkConfig } from "../saas/config.js";
import { DEFAULT_ASSISTANT_IDENTITY, resolveAssistantIdentity } from "./assistant-identity.js";
import {
  buildControlUiAvatarUrl,
  CONTROL_UI_AVATAR_PREFIX,
  normalizeControlUiBasePath,
  resolveAssistantAvatarUrl,
} from "./control-ui-shared.js";

const ROOT_PREFIX = "/";

export type ControlUiRequestOptions = {
  basePath?: string;
  config?: InfinibotConfig;
  agentId?: string;
};

function resolveControlUiRoot(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const execDir = (() => {
    try {
      return path.dirname(fs.realpathSync(process.execPath));
    } catch {
      return null;
    }
  })();
  const candidates = [
    // Packaged app: control-ui lives alongside the executable.
    execDir ? path.resolve(execDir, "control-ui") : null,
    // Running from dist: dist/gateway/control-ui.js -> dist/control-ui
    path.resolve(here, "../control-ui"),
    // Running from source: src/gateway/control-ui.ts -> dist/control-ui
    path.resolve(here, "../../dist/control-ui"),
    // Fallback to cwd (dev)
    path.resolve(process.cwd(), "dist", "control-ui"),
  ].filter((dir): dir is string => Boolean(dir));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

function contentTypeForExt(ext: string): string {
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      // ESM module scripts (.mjs) require a JavaScript MIME — without this,
      // strict module-script enforcement rejects loads like
      // ort-wasm-simd-threaded.mjs from onnxruntime-web with
      // "Expected a JavaScript-or-Wasm module script". That breaks the
      // VAD-Web silero model load and kills local Whisper STT.
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
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".wasm":
      // Required for WebAssembly streaming compile + module-script imports.
      return "application/wasm";
    case ".onnx":
      // ONNX models are loaded as fetched binaries; the browser doesn't
      // require a specific MIME but octet-stream is fine — keep explicit.
      return "application/octet-stream";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

export type ControlUiAvatarResolution =
  | { kind: "none"; reason: string }
  | { kind: "local"; filePath: string }
  | { kind: "remote"; url: string }
  | { kind: "data"; url: string };

type ControlUiAvatarMeta = {
  avatarUrl: string | null;
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(JSON.stringify(body));
}

function isValidAgentId(agentId: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agentId);
}

export function handleControlUiAvatarRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { basePath?: string; resolveAvatar: (agentId: string) => ControlUiAvatarResolution },
): boolean {
  const urlRaw = req.url;
  if (!urlRaw) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts.basePath);
  const pathname = url.pathname;
  const pathWithBase = basePath
    ? `${basePath}${CONTROL_UI_AVATAR_PREFIX}/`
    : `${CONTROL_UI_AVATAR_PREFIX}/`;
  if (!pathname.startsWith(pathWithBase)) return false;

  const agentIdParts = pathname.slice(pathWithBase.length).split("/").filter(Boolean);
  const agentId = agentIdParts[0] ?? "";
  if (agentIdParts.length !== 1 || !agentId || !isValidAgentId(agentId)) {
    respondNotFound(res);
    return true;
  }

  if (url.searchParams.get("meta") === "1") {
    const resolved = opts.resolveAvatar(agentId);
    const avatarUrl =
      resolved.kind === "local"
        ? buildControlUiAvatarUrl(basePath, agentId)
        : resolved.kind === "remote" || resolved.kind === "data"
          ? resolved.url
          : null;
    sendJson(res, 200, { avatarUrl } satisfies ControlUiAvatarMeta);
    return true;
  }

  const resolved = opts.resolveAvatar(agentId);
  if (resolved.kind !== "local") {
    respondNotFound(res);
    return true;
  }

  if (req.method === "HEAD") {
    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypeForExt(path.extname(resolved.filePath).toLowerCase()));
    res.setHeader("Cache-Control", "no-cache");
    res.end();
    return true;
  }

  serveFile(res, resolved.filePath);
  return true;
}

function respondNotFound(res: ServerResponse) {
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Not Found");
}

export function renderControlUiNotBuiltPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>InfiniBot Control UI not built</title>
    <style>
      :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #090909; color: #f5f1e8; }
      main { max-width: 42rem; margin: 2rem; padding: 2rem; border: 1px solid #5c4a22; border-radius: 1rem; background: #14120e; }
      h1 { margin-top: 0; color: #e7bd62; }
      code { display: inline-block; padding: .2rem .45rem; border-radius: .35rem; background: #242018; color: #ffe1a0; }
    </style>
  </head>
  <body>
    <main>
      <h1>Control UI not built</h1>
      <p>Build it from the InfiniBot repository, then reload this page.</p>
      <p><code>pnpm -C ui build</code></p>
    </main>
  </body>
</html>`;
}

function serveFile(res: ServerResponse, filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader("Content-Type", contentTypeForExt(ext));
  // Static UI should never be cached aggressively while iterating; allow the
  // browser to revalidate.
  res.setHeader("Cache-Control", "no-cache");
  res.end(fs.readFileSync(filePath));
}

interface ControlUiInjectionOpts {
  basePath: string;
  assistantName?: string;
  assistantAvatar?: string;
}

function injectControlUiConfig(html: string, opts: ControlUiInjectionOpts): string {
  const { basePath, assistantName, assistantAvatar } = opts;
  // SaaS mode: expose the Clerk publishable key + frontend API to the SPA so it
  // can mount a Clerk sign-in gate and pass the session token to the gateway on
  // WS connect. The secret key is never sent to the browser. When SAAS_MODE is
  // off these are absent and the SPA runs its normal local auth flow.
  const saas = isSaasMode();
  const clerk = saas ? getClerkConfig() : undefined;
  const script =
    `<script>` +
    `window.__INFINIBOT_CONTROL_UI_BASE_PATH__=${JSON.stringify(basePath)};` +
    `window.__INFINIBOT_ASSISTANT_NAME__=${JSON.stringify(
      assistantName ?? DEFAULT_ASSISTANT_IDENTITY.name,
    )};` +
    `window.__INFINIBOT_ASSISTANT_AVATAR__=${JSON.stringify(
      assistantAvatar ?? DEFAULT_ASSISTANT_IDENTITY.avatar,
    )};` +
    `window.__INFINIBOT_SAAS_MODE__=${JSON.stringify(saas)};` +
    (clerk
      ? `window.__INFINIBOT_CLERK_PUBLISHABLE_KEY__=${JSON.stringify(clerk.publishableKey)};` +
        `window.__INFINIBOT_CLERK_FRONTEND_API__=${JSON.stringify(clerk.frontendApi)};`
      : "") +
    `</script>`;
  // Check if already injected
  if (html.includes("__INFINIBOT_ASSISTANT_NAME__")) return html;
  const headClose = html.indexOf("</head>");
  if (headClose !== -1) {
    return `${html.slice(0, headClose)}${script}${html.slice(headClose)}`;
  }
  return `${script}${html}`;
}

interface ServeIndexHtmlOpts {
  basePath: string;
  config?: InfinibotConfig;
  agentId?: string;
}

function serveIndexHtml(res: ServerResponse, indexPath: string, opts: ServeIndexHtmlOpts) {
  const { basePath, config, agentId } = opts;
  const identity = config
    ? resolveAssistantIdentity({ cfg: config, agentId })
    : DEFAULT_ASSISTANT_IDENTITY;
  const resolvedAgentId =
    typeof (identity as { agentId?: string }).agentId === "string"
      ? (identity as { agentId?: string }).agentId
      : agentId;
  const avatarValue =
    resolveAssistantAvatarUrl({
      avatar: identity.avatar,
      agentId: resolvedAgentId,
      basePath,
    }) ?? identity.avatar;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  const raw = fs.readFileSync(indexPath, "utf8");
  res.end(
    injectControlUiConfig(raw, {
      basePath,
      assistantName: identity.name,
      assistantAvatar: avatarValue,
    }),
  );
}

function isSafeRelativePath(relPath: string) {
  if (!relPath) return false;
  const normalized = path.posix.normalize(relPath);
  if (normalized.startsWith("../") || normalized === "..") return false;
  if (normalized.includes("\0")) return false;
  return true;
}

// Paths that should NOT be handled by control UI (reserved for other handlers)
const RESERVED_PATHS = [
  "/install.sh",
  "/install.ps1",
  "/install",
  "/install/",
  "/api/",
  "/hook",
  "/hooks/",
  "/media/",
];

export function handleControlUiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: ControlUiRequestOptions,
): boolean {
  const urlRaw = req.url;
  if (!urlRaw) return false;

  // Check for reserved paths that should not be caught by control UI
  const urlPath = urlRaw.split("?")[0];
  const isReserved = RESERVED_PATHS.some((p) => urlPath === p || urlPath.startsWith(p));
  if (isReserved) {
    // Don't handle - let other handlers take care of it
    return false;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts?.basePath);
  const pathname = url.pathname;

  if (!basePath) {
    if (pathname === "/ui" || pathname.startsWith("/ui/")) {
      respondNotFound(res);
      return true;
    }
  }

  if (basePath) {
    if (pathname === basePath) {
      res.statusCode = 302;
      res.setHeader("Location", `${basePath}/${url.search}`);
      res.end();
      return true;
    }
    if (!pathname.startsWith(`${basePath}/`)) return false;
  }

  const root = resolveControlUiRoot();
  if (!root) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.end(req.method === "HEAD" ? undefined : renderControlUiNotBuiltPage());
    return true;
  }

  const uiPath =
    basePath && pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
  const rel = (() => {
    if (uiPath === ROOT_PREFIX) return "";
    const assetsIndex = uiPath.indexOf("/assets/");
    if (assetsIndex >= 0) return uiPath.slice(assetsIndex + 1);
    return uiPath.slice(1);
  })();
  const requested = rel && !rel.endsWith("/") ? rel : `${rel}index.html`;
  const fileRel = requested || "index.html";
  if (!isSafeRelativePath(fileRel)) {
    respondNotFound(res);
    return true;
  }

  const filePath = path.join(root, fileRel);
  if (!filePath.startsWith(root)) {
    respondNotFound(res);
    return true;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    if (path.basename(filePath) === "index.html") {
      serveIndexHtml(res, filePath, {
        basePath,
        config: opts?.config,
        agentId: opts?.agentId,
      });
      return true;
    }
    serveFile(res, filePath);
    return true;
  }

  // SPA fallback (client-side router): serve index.html for unknown paths.
  const indexPath = path.join(root, "index.html");
  if (fs.existsSync(indexPath)) {
    serveIndexHtml(res, indexPath, {
      basePath,
      config: opts?.config,
      agentId: opts?.agentId,
    });
    return true;
  }

  respondNotFound(res);
  return true;
}

/**
 * Serve media files from ~/.infinibot/media/
 * Used by the UI to display browser screenshots and other media.
 */
export function handleMediaFileRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: { basePath?: string },
): boolean {
  const urlRaw = req.url;
  if (!urlRaw) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts?.basePath);
  const pathname = url.pathname;

  // Check for /media/ prefix (with or without base path)
  const mediaPrefix = basePath ? `${basePath}/media/` : "/media/";
  if (!pathname.startsWith(mediaPrefix)) return false;

  const relativePath = pathname.slice(mediaPrefix.length);
  if (!relativePath || !isSafeRelativePath(relativePath)) {
    respondNotFound(res);
    return true;
  }

  // Resolve the appropriate directory based on path
  const homeDir = os.homedir();
  let filePath: string;
  let allowedDir: string;

  if (relativePath.startsWith("characters/")) {
    // Character images: serve from state directory's characters folder
    const stateDir = process.env.INFINIBOT_STATE_DIR || path.join(homeDir, ".infinibot");
    allowedDir = path.join(stateDir, "characters");
    filePath = path.join(stateDir, relativePath);
  } else {
    // Default: serve from ~/.infinibot/media/
    allowedDir = path.join(homeDir, ".infinibot", "media");
    filePath = path.join(allowedDir, relativePath);
  }

  // Security: ensure the resolved path is still inside the allowed directory
  if (!filePath.startsWith(allowedDir)) {
    respondNotFound(res);
    return true;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    respondNotFound(res);
    return true;
  }

  if (req.method === "HEAD") {
    const ext = path.extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypeForExt(ext));
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.end();
    return true;
  }

  // Serve the file
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader("Content-Type", contentTypeForExt(ext));
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.end(fs.readFileSync(filePath));
  return true;
}
