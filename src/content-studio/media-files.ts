/**
 * Content Studio media files — durable storage for images, video and audio
 * embedded in content pages or attached to pipeline items.
 *
 * Core's media store (src/media/store.ts) is a 2-minute scratch area for
 * channel attachments, so studio media lives in the plugin data dir instead:
 * `<stateDir>/plugin-data/content-studio/media/<id><ext>`. Mime sniffing,
 * extension mapping and remote fetches reuse core's media helpers; remote
 * imports go through the SSRF hostname guard.
 *
 * Served by GET /plugins/content-studio/media?id=<mediaId> (gated like every
 * /plugins/ route; Range-capable so video/audio seek). Uploads are a raw-body
 * POST to the same path (see handleMediaHttp) so large files skip the
 * WebSocket frame cap.
 */

import { createReadStream } from "node:fs";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { assertPublicHostname } from "../infra/net/ssrf.js";
import { fetchRemoteMedia, type FetchLike } from "../media/fetch.js";
import { detectMime, extensionForMime } from "../media/mime.js";
import type {
  ContentPipelineStore,
  MediaKind,
  MediaRecord,
  MediaSource,
} from "./pipeline-store.js";

export const MEDIA_ROUTE = "/plugins/content-studio/media";
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

export function mediaKindForMime(mime: string, filename = ""): MediaKind {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(filename)) return "image";
  if (/\.(mp4|webm|mov|m4v)$/i.test(filename)) return "video";
  if (/\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(filename)) return "audio";
  return "file";
}

/** Browser URL for a media record. */
export function mediaUrl(m: MediaRecord): string {
  return m.file ? `${MEDIA_ROUTE}?id=${encodeURIComponent(m.id)}` : (m.externalUrl ?? "");
}

export type MediaView = MediaRecord & { url: string };

export function viewMedia(m: MediaRecord): MediaView {
  return { ...m, url: mediaUrl(m) };
}

function safeFilename(name: string): string {
  const base = path
    .basename(name || "")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .trim();
  return base.slice(0, 120) || "file";
}

export class ContentStudioMedia {
  constructor(
    private readonly store: ContentPipelineStore,
    readonly mediaDir: string,
  ) {}

  /** Absolute path of a stored file, refusing anything outside the media dir. */
  filePath(m: MediaRecord): string | null {
    if (!m.file) return null;
    const abs = path.resolve(this.mediaDir, m.file);
    return abs.startsWith(path.resolve(this.mediaDir) + path.sep) ? abs : null;
  }

  async saveBuffer(input: {
    buffer: Buffer;
    filename?: string;
    contentType?: string;
    source: MediaSource;
    caption?: string;
  }): Promise<MediaRecord> {
    if (input.buffer.byteLength === 0) throw new Error("empty upload");
    if (input.buffer.byteLength > MAX_UPLOAD_BYTES) {
      throw new Error(`media exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB`);
    }
    const filename = safeFilename(input.filename ?? "");
    const mime =
      (await detectMime({
        buffer: input.buffer,
        headerMime: input.contentType,
        filePath: filename,
      })) ?? "application/octet-stream";
    const ext = extensionForMime(mime) ?? path.extname(filename).toLowerCase();
    fs.mkdirSync(this.mediaDir, { recursive: true });
    const record = this.store.insertMedia({
      kind: mediaKindForMime(mime, filename),
      mime,
      filename,
      size: input.buffer.byteLength,
      source: input.source,
      file: null,
      externalUrl: null,
      caption: input.caption ?? "",
    });
    const file = `${record.id}${/^\.[a-z0-9]{1,6}$/i.test(ext) ? ext : ""}`;
    fs.writeFileSync(path.join(this.mediaDir, file), input.buffer, { mode: 0o600 });
    this.store.db.prepare("UPDATE cs_media SET file = ? WHERE id = ?").run(file, record.id);
    return this.store.getMedia(record.id)!;
  }

  /** Stores a URL reference without downloading it (embed-only). */
  reference(input: { url: string; caption?: string; kind?: MediaKind }): MediaRecord {
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      throw new Error("invalid url");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("only http(s) urls can be referenced");
    }
    const filename = safeFilename(decodeURIComponent(parsed.pathname.split("/").pop() ?? ""));
    const kind = input.kind ?? mediaKindForMime("", filename);
    return this.store.insertMedia({
      kind: kind === "file" ? "image" : kind,
      mime: "",
      filename,
      size: 0,
      source: "url",
      file: null,
      externalUrl: parsed.toString(),
      caption: input.caption ?? "",
    });
  }

  /**
   * Downloads a public URL into the media dir (e.g. a FlyPic output, whose
   * CDN links expire). Each hop is checked against the SSRF guard.
   */
  async importUrl(input: {
    url: string;
    caption?: string;
    source?: MediaSource;
    fetchImpl?: FetchLike;
    assertHost?: (hostname: string) => Promise<void>;
  }): Promise<MediaRecord> {
    const assertHost = input.assertHost ?? ((h: string) => assertPublicHostname(h));
    const base = input.fetchImpl ?? globalThis.fetch;
    const guarded: FetchLike = async (url) => {
      let current = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      for (let hop = 0; hop < 4; hop++) {
        const u = new URL(current);
        if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("only http(s) urls");
        await assertHost(u.hostname);
        const res = await base(current, { redirect: "manual" });
        const loc = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && loc) {
          current = new URL(loc, current).toString();
          continue;
        }
        return res;
      }
      throw new Error("too many redirects");
    };
    const got = await fetchRemoteMedia({
      url: input.url,
      fetchImpl: guarded,
      maxBytes: MAX_IMPORT_BYTES,
    });
    return this.saveBuffer({
      buffer: got.buffer,
      filename: got.fileName ?? new URL(input.url).pathname.split("/").pop() ?? "media",
      contentType: got.contentType,
      source: input.source ?? "url",
      caption: input.caption,
    });
  }

  /** Copies a local file (agent-produced render, screenshot…) into the store. */
  async importFile(input: { path: string; caption?: string }): Promise<MediaRecord> {
    const abs = path.resolve(input.path);
    const stat = fs.statSync(abs);
    if (!stat.isFile()) throw new Error("not a file");
    if (stat.size > MAX_UPLOAD_BYTES) throw new Error("file too large");
    return this.saveBuffer({
      buffer: fs.readFileSync(abs),
      filename: path.basename(abs),
      source: "agent",
      caption: input.caption,
    });
  }

  delete(id: unknown): MediaRecord {
    const media = this.store.deleteMedia(id);
    const abs = this.filePath(media);
    if (abs) fs.rmSync(abs, { force: true });
    return media;
  }

  /** GET (serve, Range-aware) and POST (raw-body upload) on MEDIA_ROUTE. */
  async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = (req.method ?? "GET").toUpperCase();
    if (method === "POST") {
      await this.handleUpload(req, res, url);
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const media = this.store.getMedia(url.searchParams.get("id") ?? "");
    const abs = media ? this.filePath(media) : null;
    let size = 0;
    try {
      size = abs ? fs.statSync(abs).size : 0;
    } catch {
      size = 0;
    }
    if (!media || !abs || size === 0) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    res.setHeader("Content-Type", media.mime || "application/octet-stream");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // SVG and other active types render as attachments, never inline documents.
    if (!/^(image\/(png|jpe?g|gif|webp|avif)|video\/|audio\/)/i.test(media.mime)) {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${media.filename.replace(/"/g, "")}"`,
      );
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? "").trim());
    if (m && (m[1] || m[2])) {
      let start = m[1] ? parseInt(m[1], 10) : size - parseInt(m[2]!, 10);
      let end = m[1] && m[2] ? parseInt(m[2], 10) : size - 1;
      start = Math.max(0, start);
      end = Math.min(end, size - 1);
      if (start > end) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${size}`);
        res.end();
        return;
      }
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", String(end - start + 1));
      if (method === "HEAD") res.end();
      else createReadStream(abs, { start, end }).pipe(res);
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Length", String(size));
    if (method === "HEAD") res.end();
    else createReadStream(abs).pipe(res);
  }

  private async handleUpload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of req) {
        const buf = chunk as Buffer;
        total += buf.byteLength;
        if (total > MAX_UPLOAD_BYTES) {
          sendJson(res, 413, { error: `upload exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB` });
          req.destroy();
          return;
        }
        chunks.push(buf);
      }
      const ownerKind = url.searchParams.get("ownerKind");
      const ownerId = url.searchParams.get("ownerId");
      // Validate the owner before writing anything, so a bad id leaves no orphan.
      if (ownerKind && ownerId) this.store.listMediaFor(ownerKind, ownerId);
      const filename = url.searchParams.get("filename") ?? "";
      const media = await this.saveBuffer({
        buffer: Buffer.concat(chunks),
        filename,
        contentType: String(req.headers["content-type"] ?? "").split(";")[0] || undefined,
        source: url.searchParams.get("source") === "flypic" ? "flypic" : "upload",
        caption: url.searchParams.get("caption") ?? "",
      });
      if (ownerKind && ownerId) this.store.linkMedia(media.id, ownerKind, ownerId);
      sendJson(res, 200, { media: viewMedia(media) });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}
