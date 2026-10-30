/**
 * GET /api/verification/file?path=<abs path> — serves verified-completion
 * artifacts (visual_verify screenshots, report.json) to the control UI.
 * Behind the HTTP auth gate (protected route); only files inside
 * `<stateDir>/verification/` are served.
 *
 * `&thumb=1` on an image returns a cached ~360px WebP thumbnail
 * (`<stateDir>/verification/.thumbs/`) — the mesh map's screenshot gallery
 * never loads full PNGs.
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { verificationDir } from "../verification/store.js";

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json",
};

export function resolveVerificationFile(raw: string): string | null {
  if (!raw || !path.isAbsolute(raw)) return null;
  const root = path.resolve(verificationDir());
  let real: string;
  try {
    real = realpathSync(raw);
  } catch {
    return null;
  }
  const rootReal = existsSync(root) ? realpathSync(root) : root;
  if (!real.startsWith(`${rootReal}${path.sep}`)) return null;
  if (!TYPES[path.extname(real).toLowerCase()]) return null;
  return real;
}

export async function handleVerificationHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/api/verification/file") return false;
  if ((req.method ?? "GET").toUpperCase() !== "GET") {
    res.writeHead(405).end();
    return true;
  }
  const file = resolveVerificationFile(url.searchParams.get("path") ?? "");
  if (!file || !statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    return true;
  }
  if (url.searchParams.get("thumb") === "1" && /\.(png|jpe?g|webp)$/i.test(file)) {
    const thumb = await thumbnailFor(file).catch(() => null);
    if (thumb) {
      res.writeHead(200, {
        "Content-Type": "image/webp",
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      });
      createReadStream(thumb).pipe(res);
      return true;
    }
  }
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file).toLowerCase()],
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(file).pipe(res);
  return true;
}

const THUMB_WIDTH = 360;
const pendingThumbs = new Map<string, Promise<string | null>>();

/** Cached WebP thumbnail for an image already resolved inside the verification dir. */
export async function thumbnailFor(file: string): Promise<string | null> {
  const st = statSync(file);
  const key = createHash("sha1").update(`${file}:${st.mtimeMs}:${st.size}`).digest("hex");
  const dir = path.join(verificationDir(), ".thumbs");
  const out = path.join(dir, `${key}.webp`);
  if (existsSync(out)) return out;
  const inflight = pendingThumbs.get(out);
  if (inflight) return inflight;
  const job = (async () => {
    try {
      mkdirSync(dir, { recursive: true });
      const sharp = (await import("sharp")).default;
      await sharp(file, { limitInputPixels: 80_000_000 })
        .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
        .webp({ quality: 72 })
        .toFile(out);
      return out;
    } catch {
      return null;
    } finally {
      pendingThumbs.delete(out);
    }
  })();
  pendingThumbs.set(out, job);
  return job;
}
