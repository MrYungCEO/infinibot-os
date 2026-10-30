/**
 * Documents workspace HTTP routes (binary traffic that doesn't fit the WS RPC):
 *
 *   POST /api/documents/upload?parentId=&name=[&mode=notion-zip][&t=]   raw body upload
 *   GET  /api/documents/file/<id>[?download=1][&t=]                      original (Range-aware)
 *   GET  /api/documents/assets/<hash>.<ext>[?t=]                         embedded doc asset
 *
 * All of /api/ is behind the gateway HTTP auth gate (bearer / session cookie),
 * so these routes never run unauthenticated. The optional `t` ticket (minted
 * by the documents.ticket RPC inside the caller's request scope) carries the
 * tenant/user id so uploads and reads land in the right per-user workspace; in
 * SaaS mode a ticket is mandatory so a tenant can never fall through to the
 * host owner's workspace.
 *
 * Uploaded content is never executed or rendered as active content on the
 * gateway origin: HTML/SVG/unknown types are served as text or attachments
 * with `nosniff` and a sandbox CSP.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { runWithUserId } from "../config/paths.js";
import { DOCUMENTS_MAX_UPLOAD_BYTES, mimeForExt } from "../documents/extract.js";
import { documentsStore, uploadFile } from "../documents/service.js";
import { assertDocumentsQuota } from "../documents/tenant-limits.js";

const SECRET = randomBytes(32);
// Hosted (SaaS) tickets also authenticate cross-site reads at the HTTP gate
// (isTicketedDocumentsRead), so they live 2 h there; the UI refreshes hourly.
const TICKET_TTL_MS = /^(1|true|yes|on)$/i.test(process.env.SAAS_MODE?.trim() ?? "")
  ? 2 * 60 * 60_000
  : 12 * 60 * 60_000;

export interface DocumentsTicket {
  u: string;
  exp: number;
}

export function mintDocumentsTicket(userId: string | undefined, ttlMs = TICKET_TTL_MS): string {
  const payload = Buffer.from(
    JSON.stringify({ u: userId ?? "", exp: Date.now() + ttlMs }),
  ).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyDocumentsTicket(t: string | null | undefined): DocumentsTicket | null {
  if (!t) return null;
  const [payload, sig] = t.split(".");
  if (!payload || !sig) return null;
  const want = createHmac("sha256", SECRET).update(payload).digest();
  let got: Buffer;
  try {
    got = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as DocumentsTicket;
    if (typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Hosted fleet only: a valid tenant documents ticket authenticates a READ of a
 * document original or embedded asset. The cloud UI runs on another site, so
 * <img>/<iframe>/<video> requests to the tenant gateway carry neither the Clerk
 * Bearer nor the (SameSite) session cookie — the signed, expiring, tenant-bound
 * ticket in the URL is the only credential they can carry. GET/HEAD only;
 * uploads still need the Bearer. Self-host is unchanged (cookie path).
 */
export function documentsTicketAuthorizesRead(
  method: string,
  url: URL,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!env.FLEET_TENANT_ID?.trim()) return false;
  if (method !== "GET" && method !== "HEAD") return false;
  const p = url.pathname;
  if (!p.startsWith("/api/documents/file/") && !p.startsWith("/api/documents/assets/"))
    return false;
  const ticket = verifyDocumentsTicket(url.searchParams.get("t"));
  return Boolean(ticket?.u);
}

/**
 * String-URL form of documentsTicketAuthorizesRead (same hosted-fleet-only,
 * GET/HEAD-only, tenant-bound ticket rules).
 */
export function isTicketedDocumentsRead(
  method: string,
  rawUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl ?? "/", "http://localhost");
  } catch {
    return false;
  }
  return documentsTicketAuthorizesRead(method, url, env);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/** Discard the rest of a refused request body (up to `max` bytes), then drop the socket. */
function drainThenClose(req: IncomingMessage, max: number): void {
  if (req.readableEnded || req.destroyed) return;
  let seen = 0;
  req.on("data", (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > max) req.destroy();
  });
  req.on("error", () => {});
  req.resume();
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit)
    throw Object.assign(new Error(`File too large (limit ${limit} bytes)`), { status: 413 });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit)
      throw Object.assign(new Error(`File too large (limit ${limit} bytes)`), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Types that are safe to render inline on the gateway origin. */
function inlineSafe(mime: string): boolean {
  return (
    mime === "application/pdf" ||
    (mime.startsWith("image/") && mime !== "image/svg+xml") ||
    mime.startsWith("audio/") ||
    mime.startsWith("video/")
  );
}

function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  opts: { mime: string; name: string; download: boolean },
): void {
  const st = fs.statSync(file);
  let mime = opts.mime;
  // Never let uploaded HTML/JS/etc. execute on our origin.
  if (!inlineSafe(mime) && mime !== "image/svg+xml") {
    mime =
      mime.startsWith("text/") || mime === "application/json"
        ? "text/plain; charset=utf-8"
        : "application/octet-stream";
  }
  const disposition =
    opts.download || mime === "application/octet-stream" ? "attachment" : "inline";
  const headers: Record<string, string | number> = {
    "Content-Type": mime,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=300",
    "Accept-Ranges": "bytes",
    "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(opts.name)}`,
  };
  if (mime !== "application/pdf") {
    headers["Content-Security-Policy"] =
      "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
  }
  const range = req.headers.range;
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : st.size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : st.size - 1;
    start = Math.max(0, start);
    end = Math.min(st.size - 1, end);
    if (start > end || start >= st.size) {
      res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      "Content-Range": `bytes ${start}-${end}/${st.size}`,
      "Content-Length": end - start + 1,
    });
    if (req.method === "HEAD") return void res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "Content-Length": st.size });
  if (req.method === "HEAD") return void res.end();
  fs.createReadStream(file).pipe(res);
}

export async function handleDocumentsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/documents/")) return false;
  const rawTicket =
    url.searchParams.get("t") ?? (req.headers["x-documents-ticket"] as string | undefined);
  const ticket = verifyDocumentsTicket(rawTicket);
  if (rawTicket && !ticket) {
    json(res, 403, { ok: false, error: "invalid or expired ticket" });
    return true;
  }
  if (!ticket) {
    const { isSaasMode } = await import("../saas/config.js");
    if (isSaasMode()) {
      json(res, 403, { ok: false, error: "documents ticket required" });
      return true;
    }
  }
  await runWithUserId(ticket?.u || undefined, async () => {
    try {
      await route(req, res, url);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      if (status === 413 && !res.headersSent) {
        // Refused before (or while) reading the body: the client may still be
        // sending it. Close the connection after the reply and drain a bounded
        // amount so the 413 actually reaches the browser (behind a TLS proxy
        // an unread body otherwise stalls the upload until it times out).
        res.setHeader("Connection", "close");
        json(res, 413, { ok: false, error: String((err as Error)?.message ?? err) });
        drainThenClose(req, DOCUMENTS_MAX_UPLOAD_BYTES * 2);
      } else if (!res.headersSent)
        json(res, status, { ok: false, error: String((err as Error)?.message ?? err) });
      else res.end();
    }
  });
  return true;
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const parts = url.pathname.slice("/api/documents/".length).split("/").map(decodeURIComponent);

  if (parts[0] === "upload" && method === "POST") {
    const parentId = url.searchParams.get("parentId") || null;
    const name =
      url.searchParams.get("name") ||
      (req.headers["x-file-name"] as string | undefined) ||
      "upload";
    const mode = url.searchParams.get("mode");
    const data = await readBody(req, DOCUMENTS_MAX_UPLOAD_BYTES);
    if (mode === "asset") {
      // Pasted/dropped editor images: content-addressed asset, referenced by URL.
      const { validateUpload } = await import("../documents/extract.js");
      const v = await validateUpload(name, data);
      if (v.category !== "image" && v.category !== "video" && v.category !== "audio") {
        throw Object.assign(new Error("Only images and media can be embedded"), { status: 415 });
      }
      assertDocumentsQuota(documentsStore().root, data.length);
      json(res, 200, {
        ok: true,
        url: documentsStore().addAsset(data, v.ext || ".bin"),
        mime: v.mime,
      });
      return;
    }
    if (mode === "obsidian-zip") {
      // An Obsidian vault exported/zipped by the user (works on hosted plans,
      // where folder paths and git URLs aren't available).
      if (parentId) {
        const parent = documentsStore().getNode(parentId);
        if (!parent || parent.kind !== "folder") {
          throw Object.assign(new Error(`Parent folder "${parentId}" not found`), { status: 404 });
        }
      }
      assertDocumentsQuota(documentsStore().root, data.length);
      const { importJobs } = await import("../documents/import-jobs.js");
      const vaultName = url.searchParams.get("vaultName")?.slice(0, 200) || undefined;
      const { job } = (await importJobs()).startObsidian({
        source: "zip",
        origin: name,
        data,
        vaultName,
        parentId,
        createTasks: url.searchParams.get("createTasks") === "1",
      });
      json(res, 202, { ok: true, jobId: job.id, job });
      return;
    }
    if (mode === "notion-zip") {
      // Large exports take minutes to unpack + write: run as a background job
      // (progress via documents.import.progress / documents.notion.jobs.get).
      if (parentId) {
        const parent = documentsStore().getNode(parentId);
        if (!parent || parent.kind !== "folder") {
          throw Object.assign(new Error(`Parent folder "${parentId}" not found`), { status: 404 });
        }
      }
      // SaaS: the ZIP counts against the workspace quota before it is unpacked.
      assertDocumentsQuota(documentsStore().root, data.length);
      const { importJobs } = await import("../documents/import-jobs.js");
      const job = (await importJobs()).startZip({ data, name, parentId });
      json(res, 202, { ok: true, jobId: job.id, job });
      return;
    }
    const node = await uploadFile({
      parentId,
      name,
      data,
      mime: (req.headers["content-type"] as string | undefined)?.split(";")[0],
      author: "user",
    });
    json(res, 200, { ok: true, node });
    return;
  }

  if ((method === "GET" || method === "HEAD") && parts[0] === "file" && parts[1]) {
    const store = documentsStore();
    const node = store.getNode(parts[1]);
    const file = node ? store.originalPath(node.id) : null;
    if (!node?.file || !file) return json(res, 404, { ok: false, error: "not found" });
    sendFile(req, res, file, {
      mime: node.file.mime,
      name: node.file.name,
      download: url.searchParams.get("download") === "1",
    });
    return;
  }

  if ((method === "GET" || method === "HEAD") && parts[0] === "assets" && parts[1]) {
    const store = documentsStore();
    const file = store.assetPath(parts[1]);
    if (!file) return json(res, 404, { ok: false, error: "not found" });
    const ext = path.extname(parts[1]);
    sendFile(req, res, file, { mime: mimeForExt(ext), name: parts[1], download: false });
    return;
  }

  json(res, 404, { ok: false, error: "not found" });
}
