/**
 * Android APK distribution for the InfiniBot mobile app.
 *
 * Artifacts are published by `scripts/mobile-apk-publish.mjs` into
 * `<shared state dir>/mobile/apk/` as `infinibot-<version>.apk` plus a
 * `latest.json` manifest.
 *
 *   GET  /api/mobile/apk            manifest JSON (`available:false` when none)  [gated]
 *   GET  /api/mobile/apk/download   stream the latest APK (HEAD + Range)          [gated]
 *   POST /api/mobile/apk/link       mint a 10-minute signed link + QR SVG         [gated]
 *   GET  /mobile-apk/<file>?exp&sig  signed download for a phone with no session  [public]
 *
 * The signed route sits outside /api/, so the HTTP gate classifies GET/HEAD as
 * "static" (Host-checked, no credential). It serves bytes ONLY when the HMAC
 * over `file + exp` verifies (timingSafeEqual) and `exp` has not passed; every
 * other request gets 403. The HMAC key is persisted at
 * `<shared dir>/credentials/mobile-apk-link.key` (0600) so links minted before
 * a restart keep working until they expire.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

import { resolveSharedDir } from "../config/paths.js";

const API_MANIFEST = "/api/mobile/apk";
const API_DOWNLOAD = "/api/mobile/apk/download";
const API_LINK = "/api/mobile/apk/link";
const SIGNED_PREFIX = "/mobile-apk/";
export const MOBILE_APK_LINK_TTL_MS = 10 * 60_000;
const APK_MIME = "application/vnd.android.package-archive";
/** Only files the publish script writes are ever served. */
export const SAFE_APK_NAME = /^infinibot-[A-Za-z0-9._-]{1,80}\.apk$/;

export type MobileApkManifest = {
  version: string;
  versionCode?: number;
  buildDate: string;
  size: number;
  sha256: string;
  file: string;
  package?: string;
  minSdk?: number;
  notes?: string;
};

export type MobileApkHttpOptions = {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

export function mobileApkDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSharedDir(env), "mobile", "apk");
}

function linkKeyPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveSharedDir(env), "credentials", "mobile-apk-link.key");
}

const keyCache = new Map<string, Buffer>();

/** Persisted (0600) HMAC key for signed links; created on first use. */
export function getMobileApkLinkKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const file = linkKeyPath(env);
  const cached = keyCache.get(file);
  if (cached) return cached;
  try {
    const existing = fs.readFileSync(file);
    if (existing.length >= 32) {
      keyCache.set(file, existing);
      return existing;
    }
  } catch {
    // create below
  }
  const key = randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, key, { mode: 0o600 });
  } catch {
    // Unwritable state dir: links just won't survive a restart.
  }
  keyCache.set(file, key);
  return key;
}

/** Test hook. */
export function resetMobileApkLinkKeyCacheForTest(): void {
  keyCache.clear();
}

export function signMobileApkLink(file: string, exp: number, key: Buffer): string {
  return createHmac("sha256", key).update(`${file}\n${exp}`).digest("base64url");
}

export function verifyMobileApkLink(
  file: string,
  expRaw: string | null,
  sig: string | null,
  key: Buffer,
  nowMs: number,
): boolean {
  if (!SAFE_APK_NAME.test(file) || !expRaw || !sig) return false;
  if (!/^\d{1,16}$/.test(expRaw)) return false;
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp) || exp < nowMs) return false;
  const want = Buffer.from(signMobileApkLink(file, exp, key));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Read + validate latest.json; null when nothing (usable) is published. */
export function readMobileApkManifest(dir: string): MobileApkManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, "latest.json"), "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const file = typeof m.file === "string" ? m.file : "";
  if (!SAFE_APK_NAME.test(file)) return null;
  const resolved = resolveApkFile(dir, file);
  if (!resolved) return null;
  let size: number;
  try {
    const st = fs.statSync(resolved);
    if (!st.isFile()) return null;
    size = st.size;
  } catch {
    return null;
  }
  const out: MobileApkManifest = {
    version: typeof m.version === "string" ? m.version : "unknown",
    buildDate: typeof m.buildDate === "string" ? m.buildDate : new Date(0).toISOString(),
    // The file on disk is the truth for Content-Length.
    size,
    sha256: typeof m.sha256 === "string" ? m.sha256 : "",
    file,
  };
  if (typeof m.versionCode === "number") out.versionCode = m.versionCode;
  if (typeof m.package === "string") out.package = m.package;
  if (typeof m.minSdk === "number") out.minSdk = m.minSdk;
  if (typeof m.notes === "string") out.notes = m.notes;
  return out;
}

/** Path-contained absolute path for a safe APK name, or null. */
function resolveApkFile(dir: string, file: string): string | null {
  if (!SAFE_APK_NAME.test(file)) return null;
  const base = path.resolve(dir);
  const full = path.resolve(base, file);
  const rel = path.relative(base, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) return null;
  return full;
}

// ── QR (vendored qrcode-terminal, same library as server-pairing-http.ts) ────

type QrCodeCtor = new (
  typeNumber: number,
  level: number,
) => {
  addData(s: string): void;
  make(): void;
  moduleCount: number;
  isDark(r: number, c: number): boolean;
};

let qrCtor: QrCodeCtor | null = null;
function loadQrCode(): QrCodeCtor {
  if (qrCtor) return qrCtor;
  const id = "qrcode-terminal/vendor/QRCode/index.js";
  try {
    qrCtor = createRequire(import.meta.url)(id) as QrCodeCtor;
  } catch {
    qrCtor = createRequire(path.resolve(process.cwd(), "package.json"))(id) as QrCodeCtor;
  }
  return qrCtor;
}

/**
 * Dark-on-light QR with a 4-module quiet zone — phone camera scanners are
 * unreliable with inverted (light-on-dark) codes.
 */
export function renderQrSvg(text: string): string {
  const QRCode = loadQrCode();
  const qr = new QRCode(-1, 1 /* L: long signed URLs stay low-density */);
  qr.addData(text);
  qr.make();
  const n = qr.moduleCount;
  const quiet = 4;
  const size = n + quiet * 2;
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
    `<path fill="#000000" d="${d}"/>` +
    `</svg>`
  );
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function forbidden(res: ServerResponse): void {
  json(res, 403, {
    error: { message: "Forbidden", type: "forbidden", reason: "invalid_or_expired_link" },
  });
}

async function readSmallJson(
  req: IncomingMessage,
  maxBytes = 8 * 1024,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > maxBytes) throw new Error("payload too large");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/** http(s) origin from a caller-supplied base URL, else null. */
export function normalizeBaseOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function contentDisposition(file: string): string {
  return `attachment; filename="${file}"; filename*=UTF-8''${encodeURIComponent(file)}`;
}

function streamApk(
  req: IncomingMessage,
  res: ServerResponse,
  full: string,
  file: string,
  extra: Record<string, string> = {},
): void {
  let size: number;
  try {
    const st = fs.statSync(full);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    json(res, 404, { error: "apk_not_found" });
    return;
  }
  const headers: Record<string, string> = {
    "Content-Type": APK_MIME,
    "Content-Disposition": contentDisposition(file),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes",
    ...extra,
  };
  const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end || start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(full, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "Content-Length": String(size) });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(full).pipe(res);
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader("Allow", allow);
  json(res, 405, { error: "method_not_allowed" });
}

/**
 * Chained after the HTTP security gate in server-http.ts. The /api/ routes
 * therefore only run authenticated; the /mobile-apk/ route verifies its own
 * signature.
 */
export async function handleMobileApkHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: MobileApkHttpOptions = {},
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    return false;
  }
  const pathname = url.pathname;
  const isApi = pathname === API_MANIFEST || pathname === API_DOWNLOAD || pathname === API_LINK;
  const isSigned = pathname.startsWith(SIGNED_PREFIX);
  if (!isApi && !isSigned) return false;

  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const method = (req.method ?? "GET").toUpperCase();
  const dir = mobileApkDir(env);
  const isRead = method === "GET" || method === "HEAD";

  if (isSigned) {
    if (!isRead) {
      methodNotAllowed(res, "GET, HEAD");
      return true;
    }
    let file: string;
    try {
      file = decodeURIComponent(pathname.slice(SIGNED_PREFIX.length));
    } catch {
      forbidden(res);
      return true;
    }
    const full = resolveApkFile(dir, file);
    if (
      !full ||
      !verifyMobileApkLink(
        file,
        url.searchParams.get("exp"),
        url.searchParams.get("sig"),
        getMobileApkLinkKey(env),
        now(),
      )
    ) {
      forbidden(res);
      return true;
    }
    streamApk(req, res, full, file, { "Referrer-Policy": "no-referrer" });
    return true;
  }

  if (pathname === API_MANIFEST) {
    if (!isRead) {
      methodNotAllowed(res, "GET, HEAD");
      return true;
    }
    const manifest = readMobileApkManifest(dir);
    json(
      res,
      200,
      manifest
        ? { available: true, ...manifest, downloadPath: API_DOWNLOAD }
        : { available: false },
    );
    return true;
  }

  if (pathname === API_DOWNLOAD) {
    if (!isRead) {
      methodNotAllowed(res, "GET, HEAD");
      return true;
    }
    const manifest = readMobileApkManifest(dir);
    const full = manifest ? resolveApkFile(dir, manifest.file) : null;
    if (!manifest || !full) {
      json(res, 404, { error: "no_apk_published" });
      return true;
    }
    streamApk(req, res, full, manifest.file);
    return true;
  }

  // API_LINK
  if (method !== "POST") {
    methodNotAllowed(res, "POST");
    return true;
  }
  let body: Record<string, unknown> = {};
  try {
    body = await readSmallJson(req);
  } catch {
    json(res, 400, { error: "invalid_json" });
    return true;
  }
  const manifest = readMobileApkManifest(dir);
  if (!manifest) {
    json(res, 404, { error: "no_apk_published" });
    return true;
  }
  const expiresAt = now() + MOBILE_APK_LINK_TTL_MS;
  const sig = signMobileApkLink(manifest.file, expiresAt, getMobileApkLinkKey(env));
  const relative = `${SIGNED_PREFIX}${encodeURIComponent(manifest.file)}?exp=${expiresAt}&sig=${sig}`;
  const origin = normalizeBaseOrigin(body.baseUrl);
  const urlOut = origin ? `${origin}${relative}` : relative;
  let qrSvg: string | null = null;
  if (origin) {
    try {
      qrSvg = renderQrSvg(urlOut);
    } catch {
      qrSvg = null;
    }
  }
  json(res, 200, {
    url: urlOut,
    path: relative,
    expiresAt,
    ttlMs: MOBILE_APK_LINK_TTL_MS,
    file: manifest.file,
    version: manifest.version,
    qrSvg,
  });
  return true;
}
