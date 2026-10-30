/**
 * Gateway-start voice runtime bootstrap.
 *
 * Reads voice.json and, based on the saved mode, makes the voice stack actually
 * available without the user re-running the wizard:
 *
 *   mode === "docker" → idempotently `docker compose up -d` the voice stack
 *                       (LiveKit + Speaches + Kokoro). `up -d` is a no-op when
 *                       already running. The gateway owns the lifecycle.
 *   mode === "native" → verify the whisper.cpp binary + model are on disk. The
 *                       native path execs per-request / runs kokoro in-process,
 *                       so there is no long-lived server to start — presence is
 *                       the readiness signal the router checks. Pre-warm kokoro
 *                       so the first synth isn't slow.
 *   mode === "cloud"  → nothing to start.
 *
 * Everything here is best-effort and fire-and-forget: a failure logs a warning
 * and never blocks gateway boot.
 */

import * as fs from "node:fs";

import { loadVoiceConfig, resolveVoiceNode } from "./config.js";
import { whisperBinaryPath, whisperModelPath } from "./native/paths.js";
import { ensureVoiceStackHealthy } from "./docker-manager.js";
import { ensureNativeVoiceEngine, setupUsesDocker } from "./local-setup/wire.js";
import { resolveVoiceUrlsForNode } from "../server-voice-urls.js";
import { localProvidersEnabled } from "../../saas/config.js";

export interface BootstrapLog {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/** Pre-warm the in-process kokoro-js engine so the first synth isn't slow. */
async function prewarmKokoro(log: BootstrapLog): Promise<void> {
  try {
    await import(/* @vite-ignore */ "kokoro-js" as any);
    log.info("[VOICE] native TTS engine (kokoro-js) resolved");
  } catch {
    log.warn(
      "[VOICE] native TTS engine (kokoro-js) not installed — TTS will be unavailable until `npm i kokoro-js`",
    );
  }
}

/**
 * Bootstrap the voice runtime according to voice.json. Safe to call once at
 * gateway start. Returns nothing; status is observable via voice.runtime.status.
 */
export async function bootstrapVoiceRuntime(log: BootstrapLog): Promise<void> {
  const cfg = loadVoiceConfig();
  if (!cfg) {
    log.info("[VOICE] no voice.json — voice not configured");
    return;
  }

  // Cloud-only mode: never bring up the local Docker stack or verify on-device
  // whisper/kokoro binaries. Cloud STT/TTS providers need no bootstrap.
  if (!localProvidersEnabled() && (cfg.mode === "docker" || cfg.mode === "native")) {
    log.info(`[VOICE] mode=${cfg.mode} skipped — cloud-only mode (local providers disabled)`);
    return;
  }

  // One-click voice setup ("Set up voice for me") owns the engine it set up:
  // the built-in engine starts here (and restarts itself on crash); containers
  // it created come back on their own via their unless-stopped policy, so the
  // repo compose file must not be started on top of them.
  if (cfg.mode === "docker") {
    if (await ensureNativeVoiceEngine()) {
      log.info("[VOICE] built-in voice engine starting (one-click setup)");
      return;
    }
    if (setupUsesDocker()) {
      log.info("[VOICE] Docker voice from one-click setup — containers restart on their own");
      return;
    }
  }

  if (cfg.mode === "docker") {
    // Satellite coordination: if THIS node is set to use the MASTER's voice
    // (voiceNode="master") and a master is actually configured (its URLs differ
    // from localhost), do NOT start local containers — the satellite borrows the
    // master's stack. Only autostart local Docker when this node prefers local,
    // or when there's no master (a standalone/master node). This stops a
    // master-preferring satellite from needlessly spinning up its own Docker.
    const node = resolveVoiceNode();
    const local = resolveVoiceUrlsForNode("local");
    const master = resolveVoiceUrlsForNode("master");
    const masterConfigured = master.kokoro !== local.kokoro || master.speaches !== local.speaches;
    if (node === "master" && masterConfigured) {
      log.info(
        `[VOICE] mode=docker but voiceNode=master — using master's voice stack (${master.kokoro}); ` +
          `skipping local container autostart`,
      );
      return;
    }

    log.info("[VOICE] mode=docker — ensuring local voice stack is up");
    // Reliable autostart: preflights GPU/creds, starts only host-runnable core
    // services (so a non-GPU host never hangs on Speaches), AWAITS health, and
    // surfaces the real per-service reason instead of a soft boolean.
    const res = await ensureVoiceStackHealthy();
    if (res.skippedReason) {
      log.warn(`[VOICE] docker voice stack not started: ${res.skippedReason}`);
    } else if (res.ok) {
      log.info(`[VOICE] docker voice stack healthy: ${res.healthy.join(", ") || "none"}`);
    } else {
      log.warn(
        `[VOICE] docker voice stack partially up — healthy: [${res.healthy.join(", ") || "none"}]; ` +
          `unhealthy: ${res.unhealthy.map((u) => `${u.name} (${u.reason})`).join("; ") || "none"}`,
      );
    }
    for (const note of res.notes) log.info(`[VOICE] ${note}`);
    return;
  }

  if (cfg.mode === "native") {
    const binary = cfg.stt.binary || whisperBinaryPath();
    const modelPath = cfg.stt.modelPath || whisperModelPath(cfg.stt.model || "ggml-base.en");
    const binOk = fs.existsSync(binary);
    const modelOk = fs.existsSync(modelPath);
    if (binOk && modelOk) {
      log.info(`[VOICE] mode=native — STT ready (${binary})`);
    } else {
      log.warn(
        `[VOICE] mode=native but STT not installed (${!binOk ? "binary missing" : "model missing"}). ` +
          `Run Quickstart → Voice → Install, or \`infinibot voice up --native\`.`,
      );
    }
    // kokoro-js resolves its import before its phonemizer data has finished
    // initializing. On some Windows installs that later initialization throws
    // outside the import promise and crashes the entire gateway. Keep startup
    // resilient and let the first TTS request initialize it unless an operator
    // explicitly opts into eager prewarming.
    if (process.env.INFINIBOT_VOICE_PREWARM === "1") {
      await prewarmKokoro(log);
    } else {
      log.info("[VOICE] native TTS prewarm skipped; engine will load on first use");
    }
    return;
  }

  log.info("[VOICE] mode=cloud — nothing to start");
}
