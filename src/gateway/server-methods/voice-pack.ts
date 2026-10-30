/**
 * Voice-pack RPC handlers — download/manage the OPT-IN local voice engines
 * (Kokoro TTS, Whisper STT, Piper TTS). Gated to CEO+ via the license
 * feature `infinibot_voice_pack`.
 *
 * ── CDN decision ──────────────────────────────────────────────────────────
 * Binaries are pulled from `INFINIBOT_VOICE_PACK_BASE` if set, else from the
 * canonical CDN `https://cdn.infinibot.app/voice-packs/`. Until that domain is
 * live, set the env to the GitHub-releases fallback
 * (`.../InfiniBot-releases/releases/download/voice-packs-v1/`). See
 * voice-pack-catalog.ts for both bases.
 *
 * ⚠️  The sha256 values in voice-pack-catalog.ts are PLACEHOLDERS
 *     ("TODO: rotate from CDN"). They MUST be filled with the real artifact
 *     digests before public release, otherwise download verification is a
 *     no-op (we skip verify when the digest is a TODO placeholder).
 *
 * ── License coupling ────────────────────────────────────────────────────────
 * We import `requireFeature` (src/license/middleware.ts) / `hasFeature`
 * (src/license/state.ts), which Phase D owns. Those modules may not exist when
 * this file is compiled/run — we load them lazily and fall back to an
 * UNGATED dev path (logged) when absent. THE GATEWAY MUST BE RESTARTED after
 * Phase D lands for the gate to actually enforce, and the dev fallback must
 * never reach production.
 *
 * RPC surface:
 *   - voicePack.list                  (public)  → catalogue + installed state
 *   - voicePack.download  (gated CEO+)          → streamed install + sha256 verify
 *   - voicePack.remove                          → delete installed pack files
 *   - voicePack.verify                          → re-check installed sha256
 *
 * Progress streams over the gateway event bus on channel `voicePack:progress`
 * with `{ id, bytes, total, phase, error? }`.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { resolveStateDir } from "../../config/paths.js";
import {
  type VoicePackEntry,
  type VoicePackId,
  getVoicePack,
  hasRealSha256,
  listVoicePacks,
  resolveVoicePackUrl,
} from "../../voice/voice-pack-catalog.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

// ── License bridge (Phase D) ──────────────────────────────────────────────
// Loaded lazily so this file compiles and runs whether or not Phase D's
// modules exist yet.
type RequireFeatureFn = <T>(feature: string, handler: T) => T;
type HasFeatureFn = (feature: string) => boolean;

let _licenseLoaded = false;
let _requireFeature: RequireFeatureFn | null = null;
let _hasFeature: HasFeatureFn | null = null;
let _warnedDevFallback = false;

async function ensureLicense(): Promise<void> {
  if (_licenseLoaded) return;
  _licenseLoaded = true;
  try {
    const mw = (await import("../../license/middleware.js")) as {
      requireFeature?: RequireFeatureFn;
    };
    if (typeof mw.requireFeature === "function") _requireFeature = mw.requireFeature;
  } catch {
    // Phase D not present yet — dev fallback below.
  }
  try {
    const st = (await import("../../license/state.js")) as { hasFeature?: HasFeatureFn };
    if (typeof st.hasFeature === "function") _hasFeature = st.hasFeature;
  } catch {
    // Phase D not present yet — dev fallback below.
  }
}

/** Plan name surfaced to the UI when a feature is gated. */
const REQUIRED_PLAN = "ceo";

/**
 * Run `handler` only if the caller holds `feature`. Mirrors the semantics of
 * Phase D's `requireFeature`, delegating to it when available. When the gate
 * is denied we respond with the structured `{ ok:false, gated:true,
 * requiredPlan }` payload (RPC itself succeeds) so the UI can show an upsell.
 */
async function withFeature(
  feature: string,
  opts: GatewayRequestHandlerOptions,
  handler: (opts: GatewayRequestHandlerOptions) => Promise<void> | void,
): Promise<void> {
  await ensureLicense();

  // Prefer Phase D's wrapper when present — it owns the canonical gate.
  if (_requireFeature) {
    await _requireFeature(feature, handler)(opts);
    return;
  }

  // Fallback gate using hasFeature() if state.ts is available.
  if (_hasFeature) {
    if (!_hasFeature(feature)) {
      opts.respond(true, { ok: false, gated: true, requiredPlan: REQUIRED_PLAN, feature });
      return;
    }
    await handler(opts);
    return;
  }

  // Dev fallback — no license modules at all. NEVER deploy this ungated.
  if (!_warnedDevFallback) {
    _warnedDevFallback = true;
    opts.context.logGateway?.warn?.(
      `[voice-pack] license module absent — feature "${feature}" UNGATED (dev fallback). ` +
        `Restart gateway after Phase D lands to enforce.`,
    );
  }
  await handler(opts);
}

// ── Install-path helpers ───────────────────────────────────────────────────
function voicePacksRoot(): string {
  return path.join(resolveStateDir(), "voice-packs");
}

function packDir(id: VoicePackId): string {
  return path.join(voicePacksRoot(), id);
}

function packFilePath(entry: VoicePackEntry): string {
  return path.join(packDir(entry.id), entry.installPath);
}

function metaPath(id: VoicePackId): string {
  return path.join(packDir(id), ".installed.json");
}

interface InstalledMeta {
  path: string;
  bytes: number;
  installedAt: string;
  sha256?: string;
}

async function readInstalled(entry: VoicePackEntry): Promise<InstalledMeta | null> {
  const file = packFilePath(entry);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(file);
  } catch {
    return null; // not installed
  }
  // Prefer the recorded meta; synthesize from stat if it's missing.
  try {
    const raw = await fs.readFile(metaPath(entry.id), "utf8");
    const meta = JSON.parse(raw) as Partial<InstalledMeta>;
    return {
      path: file,
      bytes: typeof meta.bytes === "number" ? meta.bytes : stat.size,
      installedAt:
        typeof meta.installedAt === "string" ? meta.installedAt : stat.mtime.toISOString(),
      sha256: typeof meta.sha256 === "string" ? meta.sha256 : undefined,
    };
  } catch {
    return { path: file, bytes: stat.size, installedAt: stat.mtime.toISOString() };
  }
}

// ── sha256 ───────────────────────────────────────────────────────────────
async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead <= 0) break;
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return hash.digest("hex");
}

// ── Streamed download with retries ──────────────────────────────────────────
type ProgressPhase = "downloading" | "verifying" | "installed" | "failed";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stream `url` to `dest`, hashing as we go. Returns the bytes written and the
 * computed sha256. Never buffers the whole file in memory. Caller is
 * responsible for retry/cleanup orchestration.
 */
async function streamDownload(
  url: string,
  dest: string,
  expectedTotal: number,
  onProgress: (bytes: number, total: number) => void,
): Promise<{ bytes: number; sha256: string }> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText || ""} for ${url}`.trim());
  }
  const headerTotal = Number(res.headers.get("content-length") || "");
  const total = Number.isFinite(headerTotal) && headerTotal > 0 ? headerTotal : expectedTotal;

  const hash = createHash("sha256");
  const out = createWriteStream(dest);
  let written = 0;
  try {
    // res.body is a web ReadableStream (async-iterable in Node 18+).
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      const buf = Buffer.from(chunk);
      hash.update(buf);
      written += buf.length;
      await new Promise<void>((resolve, reject) => {
        out.write(buf, (err) => (err ? reject(err) : resolve()));
      });
      onProgress(written, total);
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
  return { bytes: written, sha256: hash.digest("hex") };
}

async function safeUnlink(file: string): Promise<void> {
  try {
    await fs.unlink(file);
  } catch {
    /* already gone */
  }
}

// ── Handlers ───────────────────────────────────────────────────────────────
export const voicePackHandlers: GatewayRequestHandlers = {
  /**
   * Public: returns the catalogue plus a map of which packs are installed.
   */
  "voicePack.list": async ({ respond }) => {
    try {
      const packs = listVoicePacks();
      const installed: Record<string, InstalledMeta> = {};
      for (const entry of packs) {
        const meta = await readInstalled(entry);
        if (meta) installed[entry.id] = meta;
      }
      respond(true, { packs, installed });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Gated (CEO+): stream-download a pack to ~/.infinibot/voice-packs/<id>/,
   * verifying sha256 when the catalogue carries a real digest. Emits
   * `voicePack:progress` events throughout.
   */
  "voicePack.download": async (opts) =>
    withFeature("infinibot_voice_pack", opts, async ({ params, respond, context }) => {
      const id = typeof params.id === "string" ? params.id : "";
      const entry = getVoicePack(id);
      if (!entry) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Unknown voice pack: ${id}` });
        return;
      }

      const dir = packDir(entry.id);
      const dest = packFilePath(entry);
      const url = resolveVoicePackUrl(entry);

      const emit = (phase: ProgressPhase, bytes: number, total: number, error?: string) => {
        context.broadcast("voicePack:progress", { id: entry.id, bytes, total, phase, error });
      };

      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (e) {
        respond(false, undefined, {
          code: "INTERNAL_ERROR",
          message: e instanceof Error ? e.message : String(e),
        });
        return;
      }

      // 3 attempts, exponential backoff. Partial file is removed between tries.
      const maxAttempts = 3;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          emit("downloading", 0, entry.bytes);
          const { bytes, sha256 } = await streamDownload(url, dest, entry.bytes, (b, t) =>
            emit("downloading", b, t),
          );

          // Verify sha256 unless the catalogue digest is still a TODO placeholder.
          if (hasRealSha256(entry)) {
            emit("verifying", bytes, bytes);
            if (sha256.toLowerCase() !== entry.sha256.toLowerCase()) {
              await safeUnlink(dest);
              const msg = `sha256 mismatch for ${entry.id}: expected ${entry.sha256}, got ${sha256}`;
              emit("failed", bytes, entry.bytes, msg);
              respond(false, undefined, { code: "CHECKSUM_MISMATCH", message: msg });
              return;
            }
          }

          const meta: InstalledMeta = {
            path: dest,
            bytes,
            installedAt: new Date().toISOString(),
            sha256: hasRealSha256(entry) ? sha256 : undefined,
          };
          await fs.writeFile(metaPath(entry.id), JSON.stringify(meta, null, 2), "utf8");

          emit("installed", bytes, bytes);
          respond(true, { ok: true, path: dest, bytes });
          return;
        } catch (e) {
          lastErr = e;
          await safeUnlink(dest);
          if (attempt < maxAttempts) {
            await sleep(500 * 2 ** (attempt - 1)); // 500ms, 1s, ...
          }
        }
      }

      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      emit("failed", 0, entry.bytes, msg);
      respond(false, undefined, {
        code: "DOWNLOAD_FAILED",
        message: `Failed to download ${entry.id} after ${maxAttempts} attempts: ${msg}`,
      });
    }),

  /**
   * Delete an installed pack's files (and its meta). Idempotent.
   */
  "voicePack.remove": async ({ params, respond }) => {
    try {
      const id = typeof params.id === "string" ? params.id : "";
      const entry = getVoicePack(id);
      if (!entry) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Unknown voice pack: ${id}` });
        return;
      }
      await fs.rm(packDir(entry.id), { recursive: true, force: true });
      respond(true, { ok: true, id: entry.id });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Re-hash the installed file and compare to the catalogue digest. Returns
   * `{ installed, verified, expected, actual }`. When the catalogue digest is
   * a TODO placeholder, `verified` is null (cannot verify).
   */
  "voicePack.verify": async ({ params, respond }) => {
    try {
      const id = typeof params.id === "string" ? params.id : "";
      const entry = getVoicePack(id);
      if (!entry) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Unknown voice pack: ${id}` });
        return;
      }
      const meta = await readInstalled(entry);
      if (!meta) {
        respond(true, { id: entry.id, installed: false, verified: null });
        return;
      }
      if (!hasRealSha256(entry)) {
        respond(true, {
          id: entry.id,
          installed: true,
          verified: null,
          expected: entry.sha256,
          note: "catalogue sha256 is a placeholder — cannot verify",
        });
        return;
      }
      const actual = await sha256OfFile(packFilePath(entry));
      respond(true, {
        id: entry.id,
        installed: true,
        verified: actual.toLowerCase() === entry.sha256.toLowerCase(),
        expected: entry.sha256,
        actual,
      });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

// In-process exports for tests/tooling.
export { packDir, packFilePath, sha256OfFile, voicePacksRoot };
