/**
 * Voice Docker control — start/stop/inspect the local voice stack
 * (docker-compose.voice.yaml: livekit / speaches / kokoro / voice-agent) from
 * the UI.
 *
 * The compose-file path is resolved SERVER-SIDE via resolveComposeFile() so the
 * browser never needs to know the install directory. (The old client-side
 * `cd <hardcoded C:/Users/Admin/...> && docker compose ...` broke on every
 * machine except the one it was authored on.)
 */
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { resolveComposeFile } from "../kokoro-bootstrap.js";
import { checkDocker, DOCKER_INSTALL_URL } from "../voice/docker-check.js";
import {
  detectGpu,
  getStackStatus,
  isVoiceServiceName,
  preflight,
  serviceAction,
  serviceLogs,
} from "../voice/docker-manager.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * `docker compose` interpolates the ENTIRE file before starting any service, so
 * the `${LIVEKIT_API_KEY:?...}` / `${LIVEKIT_API_SECRET:?...}` required vars in
 * the livekit + voice-agent services abort the parse even when we only want to
 * start `kokoro`. Provide harmless placeholders (never used unless those
 * services are actually started) so the file parses and local TTS/STT can come
 * up without LiveKit credentials.
 */
function composeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY || "placeholder-dev-key",
    LIVEKIT_API_SECRET:
      process.env.LIVEKIT_API_SECRET || "placeholder-dev-secret-change-me-0000000000",
  };
}

function runCompose(
  composeFile: string,
  action: "up" | "down",
  services: string[],
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const args =
      action === "up"
        ? ["compose", "-f", composeFile, "up", "-d", ...services]
        : ["compose", "-f", composeFile, "down"];
    let out = "";
    let err = "";
    try {
      // Run in the compose file's directory so its relative volume mounts
      // (./docker/kokoro/...) resolve correctly.
      const child = spawn("docker", args, {
        cwd: dirname(composeFile),
        windowsHide: true,
        env: composeEnv(),
      });
      child.stdout?.on("data", (d) => (out += String(d)));
      child.stderr?.on("data", (d) => (err += String(d)));
      child.on("error", (e) => resolve({ code: null, out, err: `${err}${String(e)}` }));
      child.on("close", (code) => resolve({ code, out, err }));
    } catch (e) {
      resolve({ code: null, out, err: String(e) });
    }
  });
}

export const voiceDockerHandlers: GatewayRequestHandlers = {
  /**
   * Generic Docker availability probe, independent of the voice stack.
   *
   * The setup flow needs to know only "is Docker usable here?" before it
   * offers container-backed options; it previously called `docker.status`,
   * which had no handler at all. Reuses the same cached `checkDocker()` probe
   * the voice handlers use, and includes the voice-stack container list when
   * the daemon is up so the setup page can show what is already running.
   */
  "docker.status": async ({ respond }) => {
    const docker = await checkDocker();
    if (!docker.available) {
      respond(true, {
        running: false,
        available: false,
        cliPresent: docker.cliPresent,
        version: docker.version ?? null,
        error: docker.error,
        installUrl: DOCKER_INSTALL_URL,
        containers: [],
      });
      return;
    }

    let containers: unknown[] = [];
    try {
      containers = (await getStackStatus()).services ?? [];
    } catch {
      // Compose file missing or unreadable — daemon is still up.
    }

    respond(true, {
      running: true,
      available: true,
      cliPresent: docker.cliPresent,
      version: docker.version ?? null,
      containers,
    });
  },

  /**
   * Where the compose file lives + whether Docker is usable. Drives the popup's
   * "run this command here" guidance and enables/disables the one-click start.
   */
  "voice.docker.info": async ({ respond }) => {
    const composeFile = resolveComposeFile();
    const docker = await checkDocker();
    respond(true, {
      composeFile,
      composeDir: composeFile ? dirname(composeFile) : null,
      command: composeFile
        ? `docker compose -f "${composeFile}" up -d`
        : "docker compose -f docker-compose.voice.yaml up -d",
      docker,
      installUrl: DOCKER_INSTALL_URL,
    });
  },

  /** One-click start of the local voice containers (optionally a subset). */
  "voice.docker.up": async ({ params, respond }) => {
    const composeFile = resolveComposeFile();
    if (!composeFile) {
      respond(true, { ok: false, error: "docker-compose.voice.yaml not found near the gateway." });
      return;
    }
    const docker = await checkDocker({ force: true });
    if (!docker.available) {
      respond(true, {
        ok: false,
        dockerMissing: !docker.cliPresent,
        daemonStopped: docker.cliPresent && !docker.daemonRunning,
        composeDir: dirname(composeFile),
        installUrl: DOCKER_INSTALL_URL,
        error: docker.error || "Docker not available",
      });
      return;
    }
    // Default to just `kokoro` (local TTS): it needs no API keys and no GPU,
    // unlike livekit/voice-agent (LiveKit creds) and speaches (NVIDIA GPU). The
    // caller can pass an explicit service list for the full stack.
    const requested = (params as { services?: unknown })?.services;
    const services =
      Array.isArray(requested) && requested.length ? (requested as string[]) : ["kokoro"];
    const r = await runCompose(composeFile, "up", services);
    const ok = r.code === 0;
    respond(true, {
      ok,
      composeDir: dirname(composeFile),
      composeFile,
      output: r.out,
      error: ok ? null : r.err || `exited ${r.code}`,
    });
  },

  /** Stop the local voice containers. */
  "voice.docker.down": async ({ respond }) => {
    const composeFile = resolveComposeFile();
    if (!composeFile) {
      respond(true, { ok: false, error: "compose file not found" });
      return;
    }
    const r = await runCompose(composeFile, "down", []);
    const ok = r.code === 0;
    respond(true, { ok, error: ok ? null : r.err || `exited ${r.code}` });
  },

  // --- Node-local stack management (NOT proxied to master) ----------------
  // A satellite manages ITS OWN containers, so these always run on the node
  // that receives the request. The wizard drives them for live provisioning.

  /** Per-container state + health for the whole voice stack. */
  "voice.docker.status": async ({ respond }) => {
    const status = await getStackStatus();
    respond(true, status);
  },

  /** Start one service (`kokoro` | `speaches` | `livekit` | `voice-agent` | `autoheal`). */
  "voice.docker.service.up": async ({ params, respond }) => {
    const name = (params as { name?: unknown })?.name;
    if (!isVoiceServiceName(name)) {
      respond(true, { ok: false, error: `Unknown voice service: ${String(name)}` });
      return;
    }
    respond(true, await serviceAction("up", name));
  },

  /** Stop one service (keeps the rest of the stack running). */
  "voice.docker.service.down": async ({ params, respond }) => {
    const name = (params as { name?: unknown })?.name;
    if (!isVoiceServiceName(name)) {
      respond(true, { ok: false, error: `Unknown voice service: ${String(name)}` });
      return;
    }
    respond(true, await serviceAction("down", name));
  },

  /** Restart one service. */
  "voice.docker.service.restart": async ({ params, respond }) => {
    const name = (params as { name?: unknown })?.name;
    if (!isVoiceServiceName(name)) {
      respond(true, { ok: false, error: `Unknown voice service: ${String(name)}` });
      return;
    }
    respond(true, await serviceAction("restart", name));
  },

  /** Bounded recent logs for one service (for the wizard's troubleshooting view). */
  "voice.docker.logs": async ({ params, respond }) => {
    const p = (params as { name?: unknown; tail?: unknown }) || {};
    if (!isVoiceServiceName(p.name)) {
      respond(true, { ok: false, error: `Unknown voice service: ${String(p.name)}` });
      return;
    }
    const tail = typeof p.tail === "number" ? p.tail : 200;
    respond(true, await serviceLogs(p.name, tail));
  },

  /** NVIDIA GPU detection — gates the STT (speaches) service in the wizard. */
  "voice.docker.gpu": async ({ respond }) => {
    respond(true, await detectGpu());
  },

  /** Full preflight: docker usable? GPU? creds ready? which services can run here. */
  "voice.docker.preflight": async ({ respond }) => {
    respond(true, await preflight());
  },
};
