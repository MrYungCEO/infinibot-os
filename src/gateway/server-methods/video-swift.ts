/**
 * Gateway Methods — VideoSwift (native silence cutter)
 *
 * The silence-cutter pipeline runs in-process via ffmpeg, exposed on the HTTP
 * surface under /api/video-swift/*. These RPC methods are only for:
 *   - reading / writing the persisted feature flag and defaults
 *   - reporting whether ffmpeg is available on the host
 *
 * No subprocess, no Python. Config persists at $STATE_DIR/video-swift.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../../config/paths.js";
import { isFfmpegAvailable } from "../../media/silence-cutter.js";
import type { GatewayRequestHandlers } from "./types.js";

const CONFIG_FILE = path.join(STATE_DIR, "video-swift.json");

type VideoSwiftConfig = {
  enabled: boolean;
  thresholdDb: number;
  minSilenceLen: number;
  ffmpegBin?: string;
};

const DEFAULT_CONFIG: VideoSwiftConfig = {
  enabled: true,
  thresholdDb: -35,
  minSilenceLen: 0.5,
};

function readConfig(): VideoSwiftConfig {
  try {
    if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Record<string, unknown>;
    return {
      enabled: raw.enabled === false ? false : true,
      thresholdDb:
        typeof raw.thresholdDb === "number" ? raw.thresholdDb : DEFAULT_CONFIG.thresholdDb,
      minSilenceLen:
        typeof raw.minSilenceLen === "number"
          ? raw.minSilenceLen
          : DEFAULT_CONFIG.minSilenceLen,
      ffmpegBin: typeof raw.ffmpegBin === "string" ? raw.ffmpegBin : undefined,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(cfg: VideoSwiftConfig): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
}

export const videoSwiftHandlers: GatewayRequestHandlers = {
  "videoSwift.config.get": async ({ respond }) => {
    respond(true, { ...readConfig(), configFile: CONFIG_FILE });
  },

  "videoSwift.config.set": async ({ respond, params }) => {
    try {
      const current = readConfig();
      const next: VideoSwiftConfig = {
        enabled:
          typeof params.enabled === "boolean" ? params.enabled : current.enabled,
        thresholdDb:
          typeof params.thresholdDb === "number" && Number.isFinite(params.thresholdDb)
            ? params.thresholdDb
            : current.thresholdDb,
        minSilenceLen:
          typeof params.minSilenceLen === "number" && Number.isFinite(params.minSilenceLen)
            ? params.minSilenceLen
            : current.minSilenceLen,
        ffmpegBin:
          typeof params.ffmpegBin === "string" && params.ffmpegBin.trim().length > 0
            ? params.ffmpegBin.trim()
            : current.ffmpegBin,
      };
      writeConfig(next);
      respond(true, { ...next, configFile: CONFIG_FILE });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "videoSwift.status": async ({ respond }) => {
    try {
      const cfg = readConfig();
      const ffmpeg = await isFfmpegAvailable(cfg.ffmpegBin);
      respond(true, {
        enabled: cfg.enabled,
        ffmpegAvailable: ffmpeg,
        thresholdDb: cfg.thresholdDb,
        minSilenceLen: cfg.minSilenceLen,
        ffmpegBin: cfg.ffmpegBin ?? "ffmpeg",
        // The HTTP surface is mounted inside this same gateway process, so
        // "native mode" is simply on when enabled && ffmpeg is present.
        nativeEndpoint: "/api/video-swift",
      });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
};
