import type { IncomingMessage, ServerResponse } from "node:http";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createInviteToken, listInviteTokens } from "./pairing-invites.js";
import { resolveGatewayAuth } from "./auth.js";
import { timingSafeEqual } from "node:crypto";
import { loadConfig } from "../config/io.js";
import { readSavedRemoteUrl } from "../infra/tailscale-remote.js";

// Vendor QR library (ships with qrcode-terminal, no extra install needed).
// Resolved next to this module first (src/ or dist/ → the package's own
// node_modules), then from process.cwd(). cwd-only resolution crashed the
// desktop app's gateway at boot: Electron runs it with cwd = the state dir,
// which has no node_modules ("Cannot find module 'qrcode-terminal/…'").
function loadVendorQr(): any {
  const id = "qrcode-terminal/vendor/QRCode/index.js";
  let lastErr: unknown;
  for (const base of [import.meta.url, resolve(process.cwd(), "package.json")]) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return createRequire(base)(id);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
const QRCode = loadVendorQr();

function makeSvg(text: string): string {
  const qr = new QRCode(-1, 1 /* M */);
  qr.addData(text);
  qr.make();
  const n: number = qr.moduleCount;
  const cell = 7;
  const pad = 20;
  const size = n * cell + pad * 2;
  let cells = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) {
        cells += `<rect x="${pad + c * cell}" y="${pad + r * cell}" width="${cell}" height="${cell}"/>`;
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="100%" height="100%" fill="#0a0a0e" rx="12"/>` +
    `<g fill="#d4af37">${cells}</g>` +
    `</svg>`
  );
}

type TailnetInfo = {
  hostname: string | null;
  // URL via Tailscale Serve (HTTPS, port 443) — preferred for other devices
  serveUrl: string | null;
  // Direct gateway URL (HTTP, raw port) — fallback if Serve not configured
  directUrl: string | null;
};

function getTailnetInfo(port: number): TailnetInfo {
  try {
    const out = execSync("tailscale status --json 2>/dev/null", { timeout: 3000 }).toString();
    const data = JSON.parse(out) as any;
    const self = data?.Self;
    if (!self) return { hostname: null, serveUrl: null, directUrl: null };
    const suffix: string = data?.MagicDNSSuffix ?? "";
    const rawHost: string = self.HostName ?? self.DNSName?.replace(/\.$/, "") ?? "";
    if (!rawHost || !suffix) return { hostname: null, serveUrl: null, directUrl: null };
    const hostname = rawHost.includes(".") ? rawHost : `${rawHost}.${suffix}`;

    // Check if Tailscale Serve is proxying our port at the root path (HTTPS).
    // `tailscale serve status --json` lists serve rules; look for our port.
    let serveUrl: string | null = null;
    try {
      const serveOut = execSync("tailscale serve status --json 2>/dev/null", {
        timeout: 3000,
      }).toString();
      const serve = JSON.parse(serveOut) as any;
      const web: Record<string, any> = serve?.Web ?? {};
      for (const [svcKey, svc] of Object.entries(web)) {
        const handlers: Record<string, any> = (svc as any)?.Handlers ?? {};
        for (const [path, handler] of Object.entries(handlers)) {
          const proxyUrl: string = (handler as any)?.Proxy ?? "";
          if (proxyUrl.includes(`:${port}`) && path === "/") {
            // svcKey is like "my-pc.tailXXXX.ts.net:443"
            const colonIdx = svcKey.lastIndexOf(":");
            const svcPort = colonIdx !== -1 ? svcKey.slice(colonIdx + 1) : "443";
            const svcHost = colonIdx !== -1 ? svcKey.slice(0, colonIdx) : svcKey;
            serveUrl = svcPort === "443" ? `https://${svcHost}` : `https://${svcHost}:${svcPort}`;
            break;
          }
        }
        if (serveUrl) break;
      }
    } catch {
      // tailscale serve status not available or not JSON — ignore
    }

    const directUrl = `http://${hostname}:${port}`;
    return { hostname, serveUrl, directUrl };
  } catch {
    return { hostname: null, serveUrl: null, directUrl: null };
  }
}

type PairingInfo = {
  tailnetUrl: string | null;
  tailnetDirectUrl: string | null;
  tailnetHostname: string | null;
  qrSvg: string | null;
  port: number;
};

let _cache: { info: PairingInfo; ts: number } | null = null;

function getPairingInfo(port: number): PairingInfo {
  const now = Date.now();
  if (_cache && now - _cache.ts < 30_000) return _cache.info;

  const { hostname, serveUrl, directUrl } = getTailnetInfo(port);
  // Prefer HTTPS Serve URL for the QR code — works in browsers without SSL errors.
  // Fall back to direct HTTP URL if Serve isn't configured.
  const tailnetUrl = readSavedRemoteUrl() ?? serveUrl ?? directUrl;
  const qrSvg = tailnetUrl ? makeSvg(tailnetUrl) : null;

  const info: PairingInfo = {
    tailnetUrl,
    tailnetDirectUrl: directUrl,
    tailnetHostname: hostname,
    qrSvg,
    port,
  };
  _cache = { info, ts: now };
  return info;
}

/**
 * Validate an X-Invite-Create-Auth header against the live gateway password/token.
 * Returns true if the header value matches the configured secret.
 */
function validateInviteCreateAuth(headerValue: string | string[] | undefined): boolean {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!value || typeof value !== "string") return false;
  try {
    const cfg = loadConfig() as { gateway?: { auth?: { token?: string; password?: string } } };
    const secret = cfg?.gateway?.auth?.password ?? cfg?.gateway?.auth?.token;
    if (!secret) return false;
    if (value.length !== secret.length) return false;
    return timingSafeEqual(Buffer.from(value), Buffer.from(secret));
  } catch {
    return false;
  }
}

export async function handlePairingRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { port: number },
): Promise<boolean> {
  const rawUrl = req.url ?? "";
  // Strip query string for path matching
  const urlPath = rawUrl.split("?")[0];

  if (urlPath === "/api/pairing/info" && req.method === "GET") {
    const info = getPairingInfo(opts.port);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    });
    res.end(JSON.stringify({ ok: true, ...info }));
    return true;
  }

  if (urlPath === "/api/pairing/qr.svg" && req.method === "GET") {
    const info = getPairingInfo(opts.port);
    if (!info.qrSvg) {
      res.writeHead(404);
      res.end("Tailscale not available");
      return true;
    }
    res.writeHead(200, {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "no-cache",
    });
    res.end(info.qrSvg);
    return true;
  }

  // ── Invite link endpoints ──────────────────────────────────────────────────

  if (urlPath === "/api/pairing/invite" && req.method === "POST") {
    if (!validateInviteCreateAuth(req.headers["x-invite-create-auth"])) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return true;
    }
    const { token, expiresAt } = createInviteToken();
    const { serveUrl, directUrl } = getTailnetInfo(opts.port);
    const baseUrl =
      readSavedRemoteUrl() ?? serveUrl ?? directUrl ?? `http://localhost:${opts.port}`;
    const url = `${baseUrl}/?invite=${token}`;
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    });
    res.end(JSON.stringify({ ok: true, token, expiresAt, url }));
    return true;
  }

  if (urlPath === "/api/pairing/invites" && req.method === "GET") {
    if (!validateInviteCreateAuth(req.headers["x-invite-create-auth"])) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return true;
    }
    const invites = listInviteTokens().map((e) => ({
      tokenPrefix: e.token.slice(0, 8),
      expiresAt: e.expiresAt,
      createdAt: e.createdAt,
      remainingMs: Math.max(0, e.expiresAt - Date.now()),
    }));
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    });
    res.end(JSON.stringify({ ok: true, invites }));
    return true;
  }

  if (urlPath === "/api/pairing/qr-invite.svg" && req.method === "GET") {
    // No auth required — the token param is already a secret opaque value
    const qs = new URLSearchParams(
      rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?") + 1) : "",
    );
    const token = qs.get("token");
    if (!token) {
      res.writeHead(400);
      res.end("Missing token");
      return true;
    }
    const { serveUrl, directUrl } = getTailnetInfo(opts.port);
    const baseUrl =
      readSavedRemoteUrl() ?? serveUrl ?? directUrl ?? `http://localhost:${opts.port}`;
    const inviteUrl = `${baseUrl}/?invite=${token}`;
    const svg = makeSvg(inviteUrl);
    res.writeHead(200, {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "no-cache",
    });
    res.end(svg);
    return true;
  }

  return false;
}
