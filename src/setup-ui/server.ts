/**
 * Standalone HTTP server that hosts the InfiniBot setup wizard.
 *
 * Why a dedicated server (vs hosting the wizard inside the gateway like the
 * older `infinibot quickstart` did): the gateway needs auth credentials to
 * accept connections, but those credentials are exactly what the wizard
 * exists to capture. Hosting the wizard inside the thing it's configuring
 * created a chicken-and-egg loop, plus a restart-during-setup pit (the
 * wizard's "Restart InfiniBot" button would kill the very process serving
 * the wizard and leave the user polling a dead port). Running standalone
 * sidesteps both: the setup server has no auth state to load, no gateway
 * lifecycle to entangle with, and no reason to ever restart mid-setup.
 *
 * Security model:
 *   - Bound to 127.0.0.1 only. Never reachable from the network.
 *   - Every /api/* request must carry the one-shot token the launcher
 *     minted (header `X-Setup-Token` or `?token=…` query param). The
 *     token also rides in the URL hash on the launch URL so the page JS
 *     picks it up without a copy-paste.
 *   - Token is process-local and never persisted. Restarting `setup-ui`
 *     mints a fresh one.
 */
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dispatchSetupRpc } from "./dispatch.js";
import { renderSetupPage } from "./page.js";

export interface SetupUiServerOptions {
  /** Port to bind to. Defaults to 18790. Pass 0 to pick an ephemeral port. */
  port?: number;
  /** One-shot token clients must present on /api/* */
  token: string;
  /** Optional logger; defaults to console. */
  log?: (msg: string) => void;
}

export interface SetupUiServer {
  url: string;
  port: number;
  /** Resolves when the server has fully shut down. */
  stop: () => Promise<void>;
  /** Resolves when the user finalizes setup (or the server is stopped). */
  done: Promise<void>;
  /** Resolves when the wizard asks to release the port (`/api/exit`) or the server stops. */
  exited: Promise<void>;
  /** Which wizard is served at `/`: the premium console, or the legacy page. */
  page: "console" | "legacy";
}

/**
 * Where the built control UI lives. The premium wizard is its `setup.html`
 * entry (ui/setup.html → dist/control-ui/setup.html), sharing the hosted
 * onboarding's console chrome. Checked: an explicit override, next to this
 * module in a build (dist/setup-ui → dist/control-ui), then the repo's dist
 * when running from source.
 */
export function resolveSetupPageRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    env.INFINIBOT_SETUP_UI_DIR?.trim(),
    path.resolve(here, "../control-ui"),
    path.resolve(here, "../../dist/control-ui"),
  ].filter((p): p is string => Boolean(p));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "setup.html"))) return dir;
  }
  return null;
}

const STATIC_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
};

/** Same-origin assets only; fonts may come from Google Fonts, as in the hosted app. */
const CONSOLE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** A file under `root` for this URL path, or null (traversal, dotfiles, other HTML entries). */
export function resolveStaticFile(root: string, pathname: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (!rel || rel.split(/[\\/]/).some((seg) => seg === ".." || seg.startsWith("."))) return null;
  const ext = path.extname(rel).toLowerCase();
  if (!STATIC_TYPES[ext]) return null;
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB — wizard payloads stay well under this

export async function startSetupUiServer(opts: SetupUiServerOptions): Promise<SetupUiServer> {
  const port = opts.port ?? 18790;
  const log = opts.log ?? ((m: string) => console.log(m));
  const token = opts.token;

  let doneResolve!: () => void;
  const done = new Promise<void>((res) => {
    doneResolve = res;
  });
  let exitedResolve!: () => void;
  const exited = new Promise<void>((res) => {
    exitedResolve = res;
  });
  let stopped = false;
  const pageRoot = resolveSetupPageRoot();

  const server = createServer((req, res) => {
    handle(req, res, {
      token,
      log,
      pageRoot,
      onFinalize: () => doneResolve(),
      onExit: () => {
        doneResolve();
        exitedResolve();
      },
    }).catch((err) => {
      log(`[setup-ui] handler error: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: "Server error" } }),
        );
      } else {
        try {
          res.end();
        } catch {
          // socket already destroyed
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const boundPort = addr?.port ?? port;
  const url = `http://127.0.0.1:${boundPort}/#token=${encodeURIComponent(token)}`;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    doneResolve();
    exitedResolve();
  };

  return { url, port: boundPort, stop, done, exited, page: pageRoot ? "console" : "legacy" };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    token: string;
    log: (m: string) => void;
    pageRoot: string | null;
    onFinalize: () => void;
    onExit: () => void;
  },
): Promise<void> {
  // Reject anything that isn't loopback, even if a future change accidentally
  // binds wider. Defense in depth: the token alone shouldn't be the only gate.
  const remote = req.socket.remoteAddress ?? "";
  if (!isLoopback(remote)) {
    res.statusCode = 403;
    res.end("Forbidden: setup-ui is loopback-only.");
    return;
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;

  // ── Premium console wizard (built control-UI `setup.html` entry) ─────────
  if (ctx.pageRoot && (req.method === "GET" || req.method === "HEAD")) {
    const file =
      pathname === "/" || pathname === "/index.html" || pathname === "/setup.html"
        ? path.join(ctx.pageRoot, "setup.html")
        : resolveStaticFile(ctx.pageRoot, pathname);
    if (file) {
      const isHtml = file.endsWith(".html");
      res.statusCode = 200;
      res.setHeader(
        "Content-Type",
        isHtml ? "text/html; charset=utf-8" : STATIC_TYPES[path.extname(file).toLowerCase()],
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Cache-Control",
        isHtml
          ? "no-cache"
          : pathname.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
      );
      if (isHtml) res.setHeader("Content-Security-Policy", CONSOLE_CSP);
      if (req.method === "HEAD") {
        res.end();
      } else {
        res.end(fs.readFileSync(file));
      }
      return;
    }
  }

  // ── Legacy page (no built UI, or explicitly at /legacy) ────────────────────
  if (
    pathname === "/legacy" ||
    (!ctx.pageRoot && (pathname === "/" || pathname === "/index.html"))
  ) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      res.end();
      return;
    }
    const html = renderSetupPage();
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    );
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(html);
    }
    return;
  }

  // Friendly health probe used by the launcher's "is it up yet?" loop.
  if (pathname === "/health") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, service: "infinibot-setup-ui" }));
    return;
  }

  // ── /api/<method> RPC ────────────────────────────────────────────────────
  if (pathname.startsWith("/api/")) {
    if (!checkToken(req, url, ctx.token)) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "UNAUTHORIZED", message: "Setup token missing or invalid." },
        }),
      );
      return;
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end();
      return;
    }

    const method = decodeURIComponent(pathname.slice("/api/".length));

    // Binary upload for the "Import your notes" step: an Obsidian vault ZIP or a
    // Notion "Markdown & CSV" export ZIP. Starts a background import job.
    if (method === "upload") {
      await handleImportUpload(req, res, url);
      return;
    }
    if (!method) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({ ok: false, error: { code: "BAD_REQUEST", message: "Method missing" } }),
      );
      return;
    }

    let body: Record<string, unknown> = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "BAD_REQUEST", message: (err as Error).message },
        }),
      );
      return;
    }

    if (method === "exit") {
      // Explicit shutdown signal — used by the "Done" button when the
      // wizard wants to release the port.
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, data: { exiting: true } }));
      ctx.onExit();
      return;
    }

    const result = await dispatchSetupRpc(method, body);
    res.statusCode = result.ok ? 200 : 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));

    // Treat a successful finalize as the natural shutdown signal so the
    // launcher can tear down the server without making the user click
    // anything else.
    if (result.ok && (method === "quickstart.finalize" || method === "setup.finalize")) {
      ctx.onFinalize();
    }
    return;
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain");
  res.end("Not Found");
}

function checkToken(req: IncomingMessage, url: URL, expected: string): boolean {
  const headerVal = req.headers["x-setup-token"];
  const header = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  const fromHeader = (header ?? "").toString();
  const fromQuery = url.searchParams.get("token") ?? "";
  // timing-safe compare on the larger of the two so a missing token still
  // takes a constant-time path
  return constantTimeEquals(fromHeader, expected) || constantTimeEquals(fromQuery, expected);
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function isLoopback(addr: string): boolean {
  if (!addr) return false;
  // ::ffff:127.0.0.1 etc.
  return (
    addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1" || addr.startsWith("127.")
  );
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  if (total === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf-8");
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("Body must be a JSON object");
  } catch (err) {
    throw new Error(`Invalid JSON body: ${(err as Error).message}`);
  }
}

const MAX_IMPORT_ZIP_BYTES = 500 * 1024 * 1024;

async function handleImportUpload(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const reply = (status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };
  const mode = url.searchParams.get("mode");
  if (mode !== "obsidian-zip" && mode !== "notion-zip") {
    reply(400, {
      ok: false,
      error: { code: "BAD_REQUEST", message: "mode must be obsidian-zip or notion-zip" },
    });
    return;
  }
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_IMPORT_ZIP_BYTES) {
    res.setHeader("Connection", "close");
    reply(413, { ok: false, error: { code: "TOO_LARGE", message: "ZIP is larger than 500 MB" } });
    return;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_IMPORT_ZIP_BYTES) {
      res.setHeader("Connection", "close");
      reply(413, { ok: false, error: { code: "TOO_LARGE", message: "ZIP is larger than 500 MB" } });
      return;
    }
    chunks.push(buf);
  }
  const data = Buffer.concat(chunks);
  if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) {
    reply(400, {
      ok: false,
      error: { code: "BAD_REQUEST", message: "That file isn't a ZIP archive" },
    });
    return;
  }
  const name = (url.searchParams.get("name") || "import.zip").slice(0, 200);
  const { importJobs } = await import("../documents/import-jobs.js");
  const jobs = await importJobs();
  const job =
    mode === "notion-zip"
      ? jobs.startZip({ data, name, parentId: null })
      : jobs.startObsidian({
          source: "zip",
          origin: name,
          data,
          parentId: null,
          vaultName: url.searchParams.get("vaultName")?.slice(0, 200) || undefined,
          createTasks: url.searchParams.get("createTasks") === "1",
        }).job;
  reply(202, { ok: true, data: { jobId: job.id, job } });
}
