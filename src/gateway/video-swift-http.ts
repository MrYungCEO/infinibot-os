/**
 * /api/video-swift/* — Native silence-cutter HTTP endpoints.
 *
 * Mirrors VideoSwift's FastAPI surface so the moltbot UI can target the
 * gateway itself (same origin: no CORS, no subprocess, no Python dependency).
 *
 *   GET  /api/video-swift/health       → { status: "ok", native: true, ffmpeg: boolean }
 *   POST /api/video-swift/process      → JSON body { video_url, silence_threshold_db, min_silence_len }
 *                                         returns video/mp4 bytes
 *   POST /api/video-swift/process_file → multipart form with `file` field + threshold/min length
 *                                         returns video/mp4 bytes
 */

import { randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../config/config.js";
import { cutSilences, downloadVideoToPath, isFfmpegAvailable } from "../media/silence-cutter.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const ROUTE_PREFIX = "/api/video-swift";

type VideoSwiftConfig = {
  enabled: boolean;
  thresholdDb: number;
  minSilenceLen: number;
  ffmpegBin?: string;
};

function readRuntimeConfig(): VideoSwiftConfig {
  const cfg = loadConfig() as Record<string, unknown>;
  const raw = (cfg?.videoSwift as Record<string, unknown> | undefined) ?? {};
  return {
    enabled: raw.enabled === false ? false : true,
    thresholdDb: typeof raw.thresholdDb === "number" ? raw.thresholdDb : -35,
    minSilenceLen: typeof raw.minSilenceLen === "number" ? raw.minSilenceLen : 0.5,
    ffmpegBin: typeof raw.ffmpegBin === "string" ? raw.ffmpegBin : undefined,
  };
}

function sendBlocked(res: ServerResponse, reason: string) {
  sendJson(res, 403, { error: reason });
}

async function readJsonBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function streamBodyToFile(
  req: IncomingMessage,
  targetPath: string,
  maxBytes = 2 * 1024 * 1024 * 1024,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(targetPath);
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        out.destroy();
        req.destroy();
        reject(new Error("Video too large (limit 2GB)"));
        return;
      }
      if (!out.write(chunk)) req.pause();
    });
    out.on("drain", () => req.resume());
    req.on("end", () => out.end(() => resolve()));
    req.on("error", reject);
    out.on("error", reject);
  });
}

export function parseMultipartBoundary(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const m = /boundary=("?)([^";]+)\1/.exec(contentType);
  return m ? m[2]! : null;
}

export type MultipartField =
  | { kind: "text"; name: string; value: string }
  | { kind: "file"; name: string; filename: string; mime: string; path: string; size: number };

/**
 * Parses a multipart/form-data request body streamed to disk.
 * Only extracts:
 *   - text fields (silence_threshold_db, min_silence_len)
 *   - one file field named "file" → saved to a temp file
 * This is intentionally minimal — we don't need full RFC 2388 coverage.
 */
export async function parseMultipartToDisk(
  req: IncomingMessage,
  boundary: string,
  tmpDir: string,
  maxBytes = 2 * 1024 * 1024 * 1024,
): Promise<MultipartField[]> {
  return new Promise((resolve, reject) => {
    const fields: MultipartField[] = [];
    const delimiter = Buffer.from(`--${boundary}`);
    const CRLF = Buffer.from("\r\n");
    const CRLFCRLF = Buffer.from("\r\n\r\n");

    let buf = Buffer.alloc(0);
    let total = 0;
    let state: "preamble" | "headers" | "body" = "preamble";
    let currentHeaders: Record<string, string> = {};
    let currentFilePath: string | null = null;
    let currentFileStream: ReturnType<typeof createWriteStream> | null = null;
    let currentFileSize = 0;
    let currentTextChunks: Buffer[] | null = null;

    function parseHeaderBlock(block: string): Record<string, string> {
      const out: Record<string, string> = {};
      for (const line of block.split("\r\n")) {
        const idx = line.indexOf(":");
        if (idx < 0) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        out[key] = line.slice(idx + 1).trim();
      }
      return out;
    }

    function startPart(headers: Record<string, string>) {
      currentHeaders = headers;
      const disp = headers["content-disposition"] ?? "";
      const isFile = /filename="/.test(disp);
      if (isFile) {
        currentFilePath = path.join(tmpDir, `upload_${randomUUID()}.bin`);
        currentFileStream = createWriteStream(currentFilePath);
        currentFileSize = 0;
        currentTextChunks = null;
      } else {
        currentFilePath = null;
        currentFileStream = null;
        currentTextChunks = [];
      }
    }

    function finishPart() {
      const disp = currentHeaders["content-disposition"] ?? "";
      const nameMatch = /name="([^"]+)"/.exec(disp);
      const name = nameMatch ? nameMatch[1]! : "";
      if (currentFileStream && currentFilePath) {
        currentFileStream.end();
        const filenameMatch = /filename="([^"]*)"/.exec(disp);
        const filename = filenameMatch ? filenameMatch[1]! : "upload.bin";
        fields.push({
          kind: "file",
          name,
          filename,
          mime: currentHeaders["content-type"] ?? "application/octet-stream",
          path: currentFilePath,
          size: currentFileSize,
        });
        currentFileStream = null;
        currentFilePath = null;
      } else if (currentTextChunks) {
        fields.push({
          kind: "text",
          name,
          value: Buffer.concat(currentTextChunks).toString("utf8"),
        });
        currentTextChunks = null;
      }
      currentHeaders = {};
    }

    function processBuffer() {
      while (true) {
        if (state === "preamble") {
          const idx = buf.indexOf(delimiter);
          if (idx < 0) return;
          buf = buf.slice(idx + delimiter.length);
          // After the first delimiter we expect CRLF (or `--` for end)
          if (buf.slice(0, 2).toString() === "--") return; // empty body
          if (buf.slice(0, 2).equals(CRLF)) buf = buf.slice(2);
          state = "headers";
          continue;
        }
        if (state === "headers") {
          const idx = buf.indexOf(CRLFCRLF);
          if (idx < 0) return;
          const headerText = buf.slice(0, idx).toString("utf8");
          buf = buf.slice(idx + CRLFCRLF.length);
          startPart(parseHeaderBlock(headerText));
          state = "body";
          continue;
        }
        // state === "body"
        const nextDelim = buf.indexOf(Buffer.concat([CRLF, delimiter]));
        if (nextDelim < 0) {
          // Emit what we safely can, keep a tail for boundary matching.
          const keep = delimiter.length + 4;
          if (buf.length > keep) {
            const emitLen = buf.length - keep;
            if (currentFileStream) {
              currentFileStream.write(buf.slice(0, emitLen));
              currentFileSize += emitLen;
            } else if (currentTextChunks) {
              currentTextChunks.push(buf.slice(0, emitLen));
            }
            buf = buf.slice(emitLen);
          }
          return;
        }
        const partData = buf.slice(0, nextDelim);
        if (currentFileStream) {
          currentFileStream.write(partData);
          currentFileSize += partData.length;
        } else if (currentTextChunks) {
          currentTextChunks.push(partData);
        }
        finishPart();
        buf = buf.slice(nextDelim + CRLF.length + delimiter.length);
        // After delimiter, either "--" end-of-body or CRLF + more headers
        if (buf.slice(0, 2).toString() === "--") {
          buf = Buffer.alloc(0);
          state = "preamble"; // done
          return;
        }
        if (buf.slice(0, 2).equals(CRLF)) buf = buf.slice(2);
        state = "headers";
      }
    }

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("Upload too large (limit 2GB)"));
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      try {
        processBuffer();
      } catch (e) {
        reject(e);
      }
    });
    req.on("end", () => resolve(fields));
    req.on("error", reject);
  });
}

async function sendFile(
  res: ServerResponse,
  filePath: string,
  opts: { mime: string; downloadName?: string; cleanup?: () => void },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const size = statSync(filePath).size;
    res.statusCode = 200;
    res.setHeader("Content-Type", opts.mime);
    res.setHeader("Content-Length", String(size));
    if (opts.downloadName) {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${opts.downloadName.replace(/"/g, "")}"`,
      );
    }
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    res.on("close", () => {
      try {
        opts.cleanup?.();
      } catch {
        /* noop */
      }
    });
    stream.on("end", () => {
      try {
        opts.cleanup?.();
      } catch {
        /* noop */
      }
      resolve();
    });
    stream.pipe(res);
  });
}

function ensureWorkDir(): string {
  const base = path.join(tmpdir(), "moltbot-video-swift");
  if (!existsSync(base)) mkdirSync(base, { recursive: true });
  return base;
}

/**
 * Mount point. Returns true when the request was handled.
 */
export async function handleVideoSwiftHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (!url.pathname.startsWith(ROUTE_PREFIX)) return false;
  const subPath = url.pathname.slice(ROUTE_PREFIX.length) || "/";

  const cfg = readRuntimeConfig();
  if (!cfg.enabled) {
    sendBlocked(res, "Silence cutter is disabled in config (videoSwift.enabled = false).");
    return true;
  }

  // CORS — the UI is same-origin in production, but the dev server runs on a
  // separate Vite port, so allow any origin for these read-only-ish endpoints.
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }

  try {
    if (subPath === "/health" || subPath === "/") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return true;
      }
      const ffmpegOk = await isFfmpegAvailable(cfg.ffmpegBin);
      sendJson(res, 200, {
        status: ffmpegOk ? "ok" : "degraded",
        native: true,
        ffmpeg: ffmpegOk,
        defaults: {
          thresholdDb: cfg.thresholdDb,
          minSilenceLen: cfg.minSilenceLen,
        },
      });
      return true;
    }

    if (subPath === "/process") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res, "POST");
        return true;
      }
      const body = (await readJsonBody(req)) as {
        video_url?: string;
        silence_threshold_db?: number;
        min_silence_len?: number;
      };
      if (!body?.video_url || typeof body.video_url !== "string") {
        sendJson(res, 400, { error: "Missing video_url" });
        return true;
      }
      const workDir = ensureWorkDir();
      const id = randomUUID();
      const inputPath = path.join(workDir, `in_${id}.mp4`);
      const outputPath = path.join(workDir, `out_${id}.mp4`);
      try {
        await downloadVideoToPath(body.video_url, inputPath);
        const result = await cutSilences(inputPath, outputPath, {
          thresholdDb:
            typeof body.silence_threshold_db === "number"
              ? body.silence_threshold_db
              : cfg.thresholdDb,
          minSilenceLen:
            typeof body.min_silence_len === "number" ? body.min_silence_len : cfg.minSilenceLen,
          ffmpegBin: cfg.ffmpegBin,
        });
        await sendFile(res, result.outputPath, {
          mime: "video/mp4",
          downloadName: "no_silence.mp4",
          cleanup: () => {
            try {
              rmSync(inputPath, { force: true });
            } catch {
              /* noop */
            }
            try {
              rmSync(outputPath, { force: true });
            } catch {
              /* noop */
            }
          },
        });
      } catch (e) {
        try {
          rmSync(inputPath, { force: true });
        } catch {
          /* noop */
        }
        try {
          rmSync(outputPath, { force: true });
        } catch {
          /* noop */
        }
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    if (subPath === "/process_file") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res, "POST");
        return true;
      }

      const contentType = req.headers["content-type"] ?? "";
      const workDir = ensureWorkDir();
      const id = randomUUID();
      const outputPath = path.join(workDir, `out_${id}.mp4`);
      let inputPath: string;
      let thresholdDb = cfg.thresholdDb;
      let minSilenceLen = cfg.minSilenceLen;

      if (contentType.toLowerCase().startsWith("multipart/form-data")) {
        const boundary = parseMultipartBoundary(contentType);
        if (!boundary) {
          sendJson(res, 400, { error: "Missing multipart boundary" });
          return true;
        }
        const fields = await parseMultipartToDisk(req, boundary, workDir);
        const filePart = fields.find((f) => f.kind === "file") as
          | Extract<MultipartField, { kind: "file" }>
          | undefined;
        if (!filePart) {
          sendJson(res, 400, { error: "Missing file field" });
          return true;
        }
        inputPath = filePart.path;
        for (const f of fields) {
          if (f.kind !== "text") continue;
          if (f.name === "silence_threshold_db") {
            const n = Number(f.value);
            if (Number.isFinite(n)) thresholdDb = n;
          } else if (f.name === "min_silence_len") {
            const n = Number(f.value);
            if (Number.isFinite(n)) minSilenceLen = n;
          }
        }
      } else {
        // Accept raw bytes too: treat the body as the video file.
        inputPath = path.join(workDir, `in_${id}.mp4`);
        await streamBodyToFile(req, inputPath);
        const qThresh = Number(url.searchParams.get("silence_threshold_db") ?? "");
        const qMin = Number(url.searchParams.get("min_silence_len") ?? "");
        if (Number.isFinite(qThresh)) thresholdDb = qThresh;
        if (Number.isFinite(qMin)) minSilenceLen = qMin;
      }

      try {
        const result = await cutSilences(inputPath, outputPath, {
          thresholdDb,
          minSilenceLen,
          ffmpegBin: cfg.ffmpegBin,
        });
        await sendFile(res, result.outputPath, {
          mime: "video/mp4",
          downloadName: "no_silence.mp4",
          cleanup: () => {
            try {
              rmSync(inputPath, { force: true });
            } catch {
              /* noop */
            }
            try {
              rmSync(outputPath, { force: true });
            } catch {
              /* noop */
            }
          },
        });
      } catch (e) {
        try {
          rmSync(inputPath, { force: true });
        } catch {
          /* noop */
        }
        try {
          rmSync(outputPath, { force: true });
        } catch {
          /* noop */
        }
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    sendJson(res, 404, { error: `No route for ${subPath}` });
    return true;
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    return true;
  }
}
