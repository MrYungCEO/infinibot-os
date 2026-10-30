/**
 * Gateway wiring for video analysis:
 *   - registers the "video" extraction handler with the auto-OCR queue
 *     (call before startOcrWorker so queued videos never hit "unsupported");
 *   - the per-state-dir VideoAnalysisService singleton (agent analyses +
 *     follow-ups) and its worker;
 *   - per-lane frame stores (normal disk / Secure Mode vault).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { registerExtractionHandler } from "../../ocr/handlers.js";
import { secureScratchDir } from "../../ocr/store.js";
import { getOcrService } from "../../ocr/runtime.js";
import type { OcrLane } from "../../ocr/types.js";
import { getSecureModeRuntime } from "../../secure-mode/runtime.js";
import type { SecureVault } from "../../secure-mode/vault.js";
import { NormalFrameStore, SecureFrameStore, type FrameStore } from "./frame-store.js";
import { ANALYST_TEMPLATES, ensureAnalystAgents, ensureTemplateAgent } from "./personas.js";
import { processVideo, realMediaTools, type MediaTools } from "./pipeline.js";
import { VideoAnalysisService } from "./service.js";
import { createLocalTranscriber, resolveSttConfig, type Transcriber } from "./transcribe.js";
import { VIDEO_EXTS, VIDEO_MIME } from "./types.js";

const log = createSubsystemLogger("video-analysis");

function secureVault(): SecureVault | null {
  try {
    const rt = getSecureModeRuntime();
    return rt.isUnlocked() ? rt.requireVault() : null;
  } catch {
    return null;
  }
}

function stateDir() {
  return resolveStateDir(process.env, os.homedir);
}

const frameStores = new Map<string, FrameStore>();

export function getFrameStore(lane: OcrLane): FrameStore {
  const key = `${lane}:${stateDir()}`;
  let s = frameStores.get(key);
  if (!s) {
    s =
      lane === "secure"
        ? new SecureFrameStore(secureVault)
        : new NormalFrameStore(path.join(stateDir(), "video-analysis", "frames"));
    frameStores.set(key, s);
  }
  return s;
}

let tools: MediaTools | null = null;
let transcriber: Transcriber | null = null;

function mediaTools() {
  return (tools ??= realMediaTools());
}

function localTranscriber() {
  if (!transcriber) {
    const cfg = resolveSttConfig();
    if (cfg.urlRefused) log.warn(cfg.urlRefused);
    transcriber = createLocalTranscriber(cfg);
  }
  return transcriber;
}

let unregister: (() => void) | null = null;

/** Register the video handler with the OCR queue (idempotent). */
export function registerVideoHandler() {
  if (unregister) return;
  unregister = registerExtractionHandler({
    id: "video",
    exts: [...VIDEO_EXTS],
    mimes: [/^video\//],
    defaultMime: VIDEO_MIME,
    extract: (params, helpers) =>
      processVideo(params, helpers, {
        tools: mediaTools(),
        transcriber: localTranscriber(),
        frames: getFrameStore,
      }),
  });
}

const services = new Map<string, VideoAnalysisService>();
let override: VideoAnalysisService | null = null;

export function getVideoAnalysisService(): VideoAnalysisService {
  if (override) return override;
  const dir = stateDir();
  let svc = services.get(dir);
  if (!svc) {
    svc = new VideoAnalysisService({
      stateDir: dir,
      ocr: getOcrService,
      frames: getFrameStore,
      tools: mediaTools(),
      secureVault,
      ensureAgent: async (agentId) =>
        ANALYST_TEMPLATES.some((t) => t.id === agentId)
          ? await ensureTemplateAgent(agentId)
          : agentId,
      log: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
    });
    services.set(dir, svc);
  }
  return svc;
}

export function setVideoAnalysisServiceForTests(svc: VideoAnalysisService | null) {
  override = svc;
}

/**
 * Secure Mode locked: remove decrypted scratch (video copies, frames, sheets)
 * right away instead of waiting for in-flight jobs to finish. Interrupted jobs
 * fail their attempt and retry after the next unlock.
 */
export function wipeSecureScratch(dir = secureScratchDir()): number {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^(va-|ib-video-|j-)/.test(name)) continue;
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      removed++;
    }
  } catch {
    /* nothing to wipe */
  }
  return removed;
}

/** Gateway boot: handler + worker + Archaeologist seed + orphan-frame sweep. */
export function startVideoAnalysis() {
  registerVideoHandler();
  if (process.env.INFINIBOT_OCR_DISABLED === "1") return;
  if (process.env.VITEST && process.env.INFINIBOT_OCR_TEST_ENABLE !== "1") return;
  const svc = getVideoAnalysisService();
  svc.start();
  try {
    const rt = getSecureModeRuntime();
    rt.onChange(() => {
      if (!rt.isUnlocked()) wipeSecureScratch();
      svc.kick();
    });
  } catch {
    /* secure mode unavailable */
  }
  void ensureAnalystAgents().catch((err) =>
    log.warn(`could not seed the Archaeologist analyst: ${String(err)}`),
  );
  setTimeout(() => {
    const normal = getFrameStore("normal") as NormalFrameStore;
    svc.sweepOrphans(
      "normal",
      () => {
        try {
          return fs.readdirSync(normal.root);
        } catch {
          return [];
        }
      },
      (k) => normal.removeAll(k),
    );
  }, 60_000).unref?.();
}
