/**
 * Voice onboarding HTTP endpoints — back the setup-wizard Voice step and the
 * dashboard "set up voice" card. All routes are under `/api/voice/*` and write
 * through the SAME canonical helpers the `infinibot voice` CLI uses
 * (saveVoiceConfig → ~/.infinibot/voice.json), so there is no parallel write
 * path.
 *
 *   GET  /api/voice/catalog        → provider catalog + env detection + current cfg
 *   GET  /api/voice/status         → { voiceJsonPresent, configured, mode, ... }
 *   GET  /api/voice/docker-check   → Docker availability (CLI + daemon)
 *   POST /api/voice/config         → persist a VoiceConfig (cloud / native / skip)
 *   POST /api/voice/native/install → SSE stream of the Whisper model download
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

import { STATE_DIR } from "../config/paths.js";
import {
  buildVoiceCatalog,
  isVoiceConfigured,
  loadVoiceConfig,
  normalizeVoiceConfig,
  saveVoiceConfig,
  type VoiceConfig,
} from "./voice/config.js";
import { checkDocker, DOCKER_INSTALL_URL } from "./voice/docker-check.js";
import { installNativeVoice } from "./voice/native/install.js";
import { whisperBinaryPath, whisperModelPath } from "./voice/native/paths.js";
import { installDockerVoiceStack } from "./voice/docker-install.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { authorizeHandlerRequest } from "./http-auth.js";

export type VoiceNativeAuthOpts = {
  auth?: ResolvedGatewayAuth;
  trustedProxies?: string[];
  preAuthorized?: boolean;
};

/**
 * Install routes spawn docker / native installers. Inside the gateway the
 * central HTTP gate (http-auth.ts) has already authenticated the caller;
 * direct callers must present the gateway credential. No loopback trust —
 * tunnels and `tailscale serve` make remote callers look local.
 */
async function ensureVoiceInstallAuthorized(
  req: IncomingMessage,
  res: ServerResponse,
  opts: VoiceNativeAuthOpts | undefined,
): Promise<boolean> {
  return authorizeHandlerRequest(req, res, opts ?? {});
}

const VOICE_SETTINGS_FILE = path.join(process.cwd(), "voice-settings.json");

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * Keep the legacy `voice-settings.json` (read by kokoro-bootstrap to decide
 * whether to autostart the Kokoro Docker container) in sync with the wizard's
 * Native choice. Native = local Whisper STT + Kokoro Docker TTS, so we stamp
 * `tts_provider: "kokoro"`. Cloud/skip never touch this file, so cloud-only
 * users never trigger a Docker spawn.
 */
function syncKokoroSelection(mode: VoiceConfig["mode"]): void {
  if (mode !== "native") return;
  try {
    let current: Record<string, unknown> = {};
    if (fs.existsSync(VOICE_SETTINGS_FILE)) {
      current = JSON.parse(fs.readFileSync(VOICE_SETTINGS_FILE, "utf-8")) as Record<
        string,
        unknown
      >;
    }
    if (current.tts_provider === "kokoro") return; // already set
    fs.writeFileSync(
      VOICE_SETTINGS_FILE,
      JSON.stringify({ ...current, tts_provider: "kokoro" }, null, 2),
      "utf-8",
    );
  } catch (err) {
    console.warn("[voice-native] failed to sync voice-settings.json kokoro selection:", err);
  }
}

export async function handleVoiceNativeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: VoiceNativeAuthOpts,
): Promise<boolean> {
  if (!req.url) return false;
  let pathname: string;
  try {
    pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
  } catch {
    return false;
  }

  const routes = new Set([
    "/api/voice/catalog",
    "/api/voice/status",
    "/api/voice/docker-check",
    "/api/voice/config",
    "/api/voice/native/install",
    "/api/voice/native/status",
    "/api/voice/docker/install",
  ]);
  if (!routes.has(pathname)) return false;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type",
    });
    res.end();
    return true;
  }

  // ── GET /api/voice/catalog ─────────────────────────────────────────────
  if (pathname === "/api/voice/catalog" && req.method === "GET") {
    sendJson(res, 200, buildVoiceCatalog());
    return true;
  }

  // ── GET /api/voice/status ──────────────────────────────────────────────
  if (pathname === "/api/voice/status" && req.method === "GET") {
    const cfg = loadVoiceConfig();
    sendJson(res, 200, {
      voiceJsonPresent: cfg !== null,
      configured: isVoiceConfigured(),
      mode: cfg?.mode ?? null,
      stt: cfg?.stt.provider ?? null,
      tts: cfg?.tts.provider ?? null,
    });
    return true;
  }

  // ── GET /api/voice/docker-check ────────────────────────────────────────
  if (pathname === "/api/voice/docker-check" && req.method === "GET") {
    const status = await checkDocker({ force: true });
    sendJson(res, 200, { ...status, installUrl: DOCKER_INSTALL_URL });
    return true;
  }

  // ── GET /api/voice/native/status ───────────────────────────────────────
  // Re-entrance support: lets the wizard detect an existing install so it can
  // offer "use existing" vs "reinstall" instead of blindly re-downloading.
  if (pathname === "/api/voice/native/status" && req.method === "GET") {
    let model = "ggml-base.en";
    try {
      model =
        new URL(req.url, `http://${req.headers.host || "localhost"}`).searchParams.get("model") ||
        model;
    } catch {
      /* default */
    }
    const binary = whisperBinaryPath();
    const modelPath = whisperModelPath(model);
    const binaryPresent = fs.existsSync(binary);
    const modelPresent = fs.existsSync(modelPath);
    sendJson(res, 200, {
      installed: binaryPresent && modelPresent,
      binaryPresent,
      modelPresent,
      binary,
      modelPath,
    });
    return true;
  }

  // ── POST /api/voice/config ─────────────────────────────────────────────
  if (pathname === "/api/voice/config" && req.method === "POST") {
    try {
      const raw = JSON.parse((await readBody(req)) || "{}");
      // "skip" is a wizard-only sentinel — no voice.json is written so the
      // gateway keeps using whatever (if anything) was there before.
      if (raw?.mode === "skip") {
        sendJson(res, 200, { ok: true, skipped: true });
        return true;
      }
      const cfg = normalizeVoiceConfig(raw);
      saveVoiceConfig(cfg);
      syncKokoroSelection(cfg.mode);
      sendJson(res, 200, { ok: true, mode: cfg.mode, path: path.join(STATE_DIR, "voice.json") });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // ── POST /api/voice/native/install (SSE) ───────────────────────────────
  if (pathname === "/api/voice/native/install" && req.method === "POST") {
    if (!(await ensureVoiceInstallAuthorized(req, res, opts))) return true;
    const bodyRaw = await readBody(req).catch(() => "");
    let model = "ggml-base.en";
    try {
      const parsed = JSON.parse(bodyRaw || "{}");
      if (typeof parsed.model === "string" && parsed.model.trim()) model = parsed.model.trim();
    } catch {
      /* default model */
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const startedAt = Date.now();
    let lastEmit = 0;
    // Cancel support: a client disconnect aborts in-flight work where possible.
    let cancelled = false;
    req.on("close", () => {
      cancelled = true;
    });
    try {
      send("start", { model });
      const report = await installNativeVoice(
        { model },
        {
          onLine: (line) => send("log", { line }),
          onPhase: (phase: string, status: string) => send("phase", { phase, status }),
          onProgress: (received, total) => {
            if (cancelled) return;
            // Throttle structured progress to ~5/sec to avoid flooding the stream.
            const now = Date.now();
            if (now - lastEmit < 200 && received !== total) return;
            lastEmit = now;
            const pct = total ? received / total : 0;
            const elapsed = (now - startedAt) / 1000;
            const etaSec = pct > 0.01 && total ? Math.max(0, elapsed / pct - elapsed) : null;
            send("progress", {
              receivedMb: +(received / 1024 / 1024).toFixed(1),
              totalMb: total ? +(total / 1024 / 1024).toFixed(1) : null,
              percent: total ? Math.floor(pct * 100) : null,
              etaSec: etaSec !== null ? Math.round(etaSec) : null,
            });
          },
        },
      );
      send("done", {
        ok: report.ok,
        binaryPath: report.binaryPath,
        binaryReady: report.binaryReady,
        modelPath: report.modelPath,
        modelReady: report.modelReady,
        ttsReady: report.ttsReady,
        selfTestPassed: report.selfTestPassed,
        notes: report.notes,
      });
    } catch (err) {
      send("error", { ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      res.end();
    }
    return true;
  }

  // ── POST /api/voice/docker/install (SSE) ───────────────────────────────
  // Verify docker → ensure .env secrets → pull images → compose up -d → poll
  // Speaches/Kokoro/LiveKit. Fails loud (SSE `error`) if docker is down or the
  // stack never becomes reachable, so the wizard step stays incomplete.
  if (pathname === "/api/voice/docker/install" && req.method === "POST") {
    if (!(await ensureVoiceInstallAuthorized(req, res, opts))) return true;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      send("start", {});
      const report = await installDockerVoiceStack({
        onLine: (line) => send("log", { line }),
        onPhase: (phase: string, status: string) => send("phase", { phase, status }),
      });
      send("done", { ok: report.ok, services: report.services, notes: report.notes });
    } catch (err) {
      send("error", { ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      res.end();
    }
    return true;
  }

  // Matched a route but not a method.
  sendJson(res, 405, { error: "method_not_allowed" });
  return true;
}
