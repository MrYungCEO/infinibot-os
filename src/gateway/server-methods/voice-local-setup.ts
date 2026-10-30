/**
 * One-click local voice setup RPCs ("Set up voice for me" on the onboarding
 * Voice step and Setup › Voice):
 *
 *   voice.local.detect   check this computer (OS, RAM/disk, GPU, Docker) + preview
 *   voice.local.status   current / last setup run (resumable record)
 *   voice.local.install  start or resume the setup; progress streams as
 *                        `voice.local.progress` events (and via status polling)
 *   voice.local.cancel   stop a running setup
 *
 * Node-local (never proxied to a federation master) and owner/admin only: none
 * of these are in the READ/WRITE method sets, so they need operator.admin, and
 * multi-user members are denied by default (src/access/authz.ts).
 * On InfiniBot Cloud local voice doesn't exist: every method says so plainly.
 */

import { localProvidersEnabled } from "../../saas/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { detectHost, realDetectDeps } from "../voice/local-setup/detect.js";
import {
  APPROX_DOWNLOAD_MB,
  gpuUsable,
  installGuide,
  planServices,
} from "../voice/local-setup/plan.js";
import {
  getLocalVoiceSetup,
  type SetupOptions,
  type SetupState,
} from "../voice/local-setup/runner.js";
import { modelsPresent } from "../voice/native-engine/fetch-models.js";
import {
  KOKORO_MODEL,
  chooseWhisperSize,
  modelsDir,
  whisperModel,
} from "../voice/native-engine/models.js";
import { getVoiceEngine } from "../voice/native-engine/supervisor.js";
import { loadVoiceConfig } from "../voice/config.js";
import { DockerOps } from "../voice/local-setup/docker-ops.js";
import { realExec, type HostReport } from "../voice/local-setup/detect.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

export const VOICE_LOCAL_PROGRESS_EVENT = "voice.local.progress";

const CLOUD = {
  supported: false,
  reason: "cloud",
  message:
    "On InfiniBot Cloud, voice runs in the cloud with Robovoice. Local voice is for InfiniBot on your own computer.",
};

let subscribed = false;
function subscribe(opts: GatewayRequestHandlerOptions): void {
  if (subscribed) return;
  subscribed = true;
  const context = opts.context;
  getLocalVoiceSetup().onChange((state) => {
    try {
      context.broadcast(VOICE_LOCAL_PROGRESS_EVENT, state, { dropIfSlow: true });
    } catch {
      /* ui may be gone */
    }
  });
}

function parseOptions(p: Record<string, unknown>): SetupOptions {
  const opts: SetupOptions = {};
  if (typeof p.project === "string" && p.project.trim()) opts.project = p.project.trim();
  const ports = p.ports as Record<string, unknown> | undefined;
  if (ports && typeof ports === "object") {
    const port = (v: unknown) =>
      typeof v === "number" && Number.isInteger(v) && v > 1024 && v < 65536 ? v : undefined;
    opts.ports = { kokoro: port(ports.kokoro), speaches: port(ports.speaches) };
    if (!opts.ports.kokoro && !opts.ports.speaches) delete opts.ports;
  }
  if (p.cpuOnly === true) opts.cpuOnly = true;
  if (typeof p.sttModel === "string" && p.sttModel.trim()) opts.sttModel = p.sttModel.trim();
  if (p.wire === false) opts.wire = false;
  if (p.engine === "native" || p.engine === "docker") opts.engine = p.engine;
  return opts;
}

/**
 * Built-in engine unless this computer already has voice in Docker (the
 * owner's own Kokoro/Speaches containers) — that is kept, never replaced.
 */
async function recommendedEngine(
  state: SetupState,
  host: HostReport,
): Promise<"native" | "docker"> {
  if (state.engine && state.phase === "done") return state.engine;
  if (loadVoiceConfig()?.mode === "docker") return "docker";
  if (host.docker.state === "running" && host.docker.cli) {
    const ops = new DockerOps(host.docker.cli, realExec);
    for (const name of ["infinibot-kokoro", "infinibot-voice-kokoro"]) {
      if (await ops.inspectContainer(name)) return "docker";
    }
  }
  return "native";
}

export const voiceLocalSetupHandlers: GatewayRequestHandlers = {
  "voice.local.detect": async (opts) => {
    if (!localProvidersEnabled()) return opts.respond(true, CLOUD);
    try {
      const stateDir = resolveStateDir();
      const host = await detectHost(realDetectDeps(stateDir), stateDir);
      const state = getLocalVoiceSetup().status();
      const plans = planServices(host);
      // Built-in engine: what it would download (speech model sized to memory).
      const stt = whisperModel(chooseWhisperSize(host.ramGb));
      const nativeFiles = [...stt.files, ...KOKORO_MODEL.files];
      const nativeOnDisk = modelsPresent(nativeFiles, modelsDir(stateDir));
      const nativeMb = Math.round(nativeFiles.reduce((n, f) => n + f.approxBytes, 0) / 1024 ** 2);
      opts.respond(true, {
        supported: true,
        host,
        gpu: gpuUsable(host),
        recommendedEngine: await recommendedEngine(state, host),
        native: {
          sttModel: stt.repo,
          approxMb: nativeOnDisk ? 0 : nativeMb,
          downloaded: nativeOnDisk,
        },
        engine: getVoiceEngine().state,
        plan: plans.map((p) => ({
          id: p.id,
          label: p.label,
          image: p.image,
          port: p.hostPort,
          gpu: p.gpu,
          approxMb: APPROX_DOWNLOAD_MB[p.image] ?? null,
          model: p.model,
        })),
        guide: host.docker.state === "missing" ? installGuide(host.os, host.arch) : null,
        state,
      });
    } catch (err) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  "voice.local.status": async (opts) => {
    if (!localProvidersEnabled()) return opts.respond(true, CLOUD);
    subscribe(opts);
    opts.respond(true, {
      supported: true,
      state: getLocalVoiceSetup().status(),
      engine: getVoiceEngine().state,
    });
  },

  "voice.local.install": async (opts) => {
    if (!localProvidersEnabled()) {
      return opts.respond(false, undefined, { code: "UNAVAILABLE", message: CLOUD.message });
    }
    subscribe(opts);
    const p = (opts.params ?? {}) as Record<string, unknown>;
    const runner = getLocalVoiceSetup();
    runner.start(parseOptions(p));
    if (p.wait === true) {
      opts.respond(true, { supported: true, state: await runner.settle() });
      return;
    }
    opts.respond(true, { supported: true, state: runner.status() });
  },

  "voice.local.cancel": async (opts) => {
    if (!localProvidersEnabled()) return opts.respond(true, CLOUD);
    opts.respond(true, { supported: true, state: getLocalVoiceSetup().cancel() });
  },
};
