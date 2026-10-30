/**
 * Kokoro TTS bootstrap + health for the InfiniBot gateway.
 *
 * Kokoro is the local neural-voice TTS engine, shipped as the `kokoro` service
 * (container `infinibot-kokoro`, image `kokoro-fastapi-cpu`) in
 * `docker-compose.voice.yaml`. It serves an OpenAI-compatible API on host port
 * 8882 (→ container 8880).
 *
 * On gateway startup {@link ensureKokoroRunning} probes the local Kokoro
 * endpoint (`GET /v1/models`) and, *only when the user has selected Kokoro as
 * their TTS provider* (voice-settings.json `tts_provider === "kokoro"`),
 * autostarts the container via `docker compose -f docker-compose.voice.yaml up
 * -d kokoro`, then polls (timeout + backoff) until it answers. Docker is a soft
 * dependency: if the `docker` CLI is missing the bootstrap logs a warning and
 * the gateway keeps running (Kokoro just stays unavailable; TTS can fall back
 * to other providers).
 *
 * The resolved status is cached so the rest of the system — the
 * `/api/kokoro/health` endpoint and any UI status badge — can read
 * {@link getLastKokoroStatus} synchronously. A periodic health ping
 * ({@link startKokoroHealthPing}) keeps the flag fresh and re-launches Kokoro
 * if it stops while still selected.
 *
 * Nothing here forces TTS to use Kokoro; it only makes the container
 * *available* when the user has asked for it. The actual provider selection and
 * fallback chain live in `tts/tts.ts`.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveVoiceUrls } from "./server-voice-urls.js";
import { loadVoiceConfig } from "./voice/config.js";
import { checkDocker, DOCKER_INSTALL_URL } from "./voice/docker-check.js";
import { isLocalVoiceSetupRunning } from "./voice/local-setup/runner.js";
import {
  ensureNativeVoiceEngine,
  setupKokoroContainer,
  setupNativeEngine,
} from "./voice/local-setup/wire.js";

const COMPOSE_FILE = "docker-compose.voice.yaml";
const KOKORO_SERVICE = "kokoro";
const KOKORO_CONTAINER = "infinibot-kokoro";

export interface KokoroStatus {
  /** Base URL the status describes (no trailing slash). */
  url: string;
  /** Whether the Kokoro endpoint answered on the last probe. */
  ready: boolean;
  /** Whether Kokoro is the currently selected TTS provider. */
  selected: boolean;
  /** True when this process launched the container via docker compose. */
  startedByUs: boolean;
  /** Wall-clock time of the last probe. */
  lastCheckedMs: number;
  /**
   * True when Kokoro is selected but Docker (CLI or daemon) is unavailable, so
   * the container can never start. The control UI renders a banner from this
   * instead of letting TTS calls silently 503.
   */
  dockerMissing?: boolean;
  /** Human-readable explanation + remediation for {@link dockerMissing}. */
  warning?: string;
}

/** Banner message surfaced to the UI when Kokoro is selected but Docker is gone. */
function dockerMissingWarning(detail?: string): string {
  return (
    `Docker not detected — Kokoro TTS won't work. ` +
    `Switch to ElevenLabs (cloud TTS) or install Docker: ${DOCKER_INSTALL_URL}` +
    (detail ? ` (${detail})` : "")
  );
}

let lastStatus: KokoroStatus | null = null;
let ensurePromise: Promise<KokoroStatus> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
/** Guards the health-ping self-heal so overlapping ticks don't double-spawn. */
let restartInFlight = false;
/** Restarts issued since Kokoro last answered, and down ticks seen (for backoff). */
let failedRestarts = 0;
let downTicks = 0;

/** Last known Kokoro status, or `null` if never probed. Synchronous. */
export function getLastKokoroStatus(): KokoroStatus | null {
  return lastStatus;
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[KOKORO-BOOTSTRAP] ${msg}`);
}

/** Resolve the host-side Kokoro base URL (config > env > localhost:8882). */
export function resolveKokoroUrl(): string {
  return resolveVoiceUrls().kokoro.replace(/\/+$/, "");
}

/**
 * Locate `docker-compose.voice.yaml`. Tries the gateway cwd first (matches how
 * `server-voice-config.ts` finds `voice-settings.json`), then walks up the
 * directory tree from this module's compiled location. Returns `null` if not
 * found.
 */
export function resolveComposeFile(): string | null {
  const cwdCandidate = join(process.cwd(), COMPOSE_FILE);
  if (existsSync(cwdCandidate)) return cwdCandidate;

  // Packaged app: electron-builder ships the compose file (and ./docker config)
  // into resources/app/ via extraResources. process.resourcesPath points at the
  // app's `resources` dir even under ELECTRON_RUN_AS_NODE, so the installed app
  // — which has no repo checkout — can still locate it. The sibling ./docker
  // dir ships alongside it so the kokoro volume mount resolves.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (typeof resourcesPath === "string" && resourcesPath) {
    for (const c of [join(resourcesPath, "app", COMPOSE_FILE), join(resourcesPath, COMPOSE_FILE)]) {
      if (existsSync(c)) return c;
    }
  }

  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, COMPOSE_FILE);
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // import.meta.url unavailable (e.g. odd bundling) — fall through.
  }
  return null;
}

/**
 * Whether the user wants the local Kokoro TTS container running. True when
 * EITHER source of truth asks for it:
 *   1. canonical `~/.infinibot/voice.json` `mode === "docker"` (the wizard's
 *      local-Docker stack), OR
 *   2. legacy `voice-settings.json` `tts_provider === "kokoro"`.
 *
 * Honoring voice.json fixes the silent-skip where a wizard-provisioned Docker
 * install (which writes voice.json, not voice-settings.json) never autostarted
 * Kokoro. Defaults to `false` when neither file asks for it, so we never start
 * Kokoro for cloud/native users.
 */
export function isKokoroSelected(): boolean {
  // 1) Canonical voice.json — the wizard's local-Docker mode.
  try {
    const cfg = loadVoiceConfig();
    if (cfg?.mode === "docker") return true;
  } catch {
    // fall through to the legacy file
  }
  // 2) Legacy voice-settings.json tts_provider.
  try {
    const file = join(process.cwd(), "voice-settings.json");
    if (!existsSync(file)) return false;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      tts_provider?: unknown;
    };
    return parsed?.tts_provider === "kokoro";
  } catch {
    return false;
  }
}

/** Hit `GET /v1/models`; returns whether Kokoro answered. */
async function probeKokoro(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(`${url}/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function setStatus(next: KokoroStatus): KokoroStatus {
  lastStatus = next;
  return next;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Launch the Kokoro container detached via `docker compose up -d kokoro`.
 * Returns false if Docker is missing or the spawn fails — the caller treats
 * this as a soft failure and keeps the gateway running.
 */
function spawnKokoroCompose(composeFile: string): boolean {
  try {
    const child = spawn("docker", ["compose", "-f", composeFile, "up", "-d", KOKORO_SERVICE], {
      // Run in the compose file's directory so its relative volume mounts
      // (./docker/kokoro/...) resolve correctly.
      cwd: dirname(composeFile),
      detached: true,
      stdio: "ignore",
      // `docker compose` interpolates the WHOLE file first, so the required
      // ${LIVEKIT_API_KEY:?...} / ${LIVEKIT_API_SECRET:?...} vars in the
      // livekit/voice-agent services abort the parse even though we only start
      // kokoro. Supply harmless placeholders (kokoro itself uses neither).
      env: {
        ...process.env,
        LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY || "placeholder-dev-key",
        LIVEKIT_API_SECRET:
          process.env.LIVEKIT_API_SECRET || "placeholder-dev-secret-change-me-0000000000",
      },
    });
    child.on("error", (err) => {
      log(
        `failed to run 'docker compose up -d ${KOKORO_SERVICE}' (is Docker installed?): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
    child.unref();
    return true;
  } catch (err) {
    log(
      `failed to spawn docker compose (is Docker installed?): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/** `docker container inspect` state ("running", "exited", …) or null when absent. */
function containerState(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        "docker",
        ["container", "inspect", name, "--format", "{{.State.Status}}"],
        { timeout: 5000, windowsHide: true },
        (err, stdout) => resolve(err ? null : String(stdout).trim() || null),
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Bring Kokoro back without fighting anything else that manages it:
 *   - a running one-click setup owns the containers → do nothing;
 *   - a known container (the one the setup created, or the older compose
 *     `infinibot-kokoro`) that Docker is already running/restarting under its
 *     `unless-stopped` policy → leave it to Docker;
 *   - a known container that is stopped → `docker start` it (never a second
 *     `compose up`, which collides on the container name);
 *   - otherwise fall back to `compose up -d kokoro`.
 * Returns whether a start was issued.
 */
export async function restartKokoro(composeFile: string | null): Promise<boolean> {
  if (isLocalVoiceSetupRunning()) {
    log("voice setup is running — leaving kokoro to it");
    return false;
  }
  // Built-in engine (no Docker): its supervisor owns it — just make sure it runs.
  if (setupNativeEngine()) return ensureNativeVoiceEngine();
  const candidates = [setupKokoroContainer(), KOKORO_CONTAINER].filter((c): c is string =>
    Boolean(c),
  );
  for (const name of candidates) {
    const state = await containerState(name);
    if (!state) continue;
    if (state === "running" || state === "restarting") {
      log(`container '${name}' is ${state} under Docker's restart policy — waiting for it`);
      return false;
    }
    log(`starting existing container '${name}' (was ${state})`);
    try {
      const child = spawn("docker", ["start", name], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", () => undefined);
      child.unref();
      return true;
    } catch {
      return false;
    }
  }
  return composeFile ? spawnKokoroCompose(composeFile) : false;
}

export interface EnsureKokoroOptions {
  /** Max health-probe attempts after a start (default 18). */
  maxAttempts?: number;
  /** Force a fresh run instead of returning the cached boot result. */
  force?: boolean;
}

/**
 * Ensure Kokoro is up *if it's the selected TTS provider*, autostarting the
 * container if needed. Idempotent per process: the first call's promise is
 * cached. No-op (records `selected:false`) when the user isn't on Kokoro.
 */
export function ensureKokoroRunning(opts?: EnsureKokoroOptions): Promise<KokoroStatus> {
  if (ensurePromise && !opts?.force) return ensurePromise;
  ensurePromise = doEnsure(opts);
  return ensurePromise;
}

async function doEnsure(opts?: EnsureKokoroOptions): Promise<KokoroStatus> {
  const url = resolveKokoroUrl();
  const selected = isKokoroSelected();
  const autostart = !["0", "false", "no"].includes(
    (process.env.INFINIBOT_KOKORO_AUTOSTART ?? "").trim().toLowerCase(),
  );

  // Gate on provider selection — no point starting Kokoro for elevenlabs/edge
  // users (requirement #4). We still record a status so the health endpoint can
  // report `selected:false`.
  if (!selected) {
    log(`tts_provider is not "kokoro"; skipping Kokoro autostart`);
    return setStatus({
      url,
      ready: false,
      selected: false,
      startedByUs: false,
      lastCheckedMs: Date.now(),
    });
  }

  // Already healthy?
  if (await probeKokoro(url)) {
    log(`kokoro already running at ${url}`);
    return setStatus({
      url,
      ready: true,
      selected: true,
      startedByUs: false,
      lastCheckedMs: Date.now(),
    });
  }

  if (!autostart) {
    log(`kokoro not running at ${url} and autostart disabled (INFINIBOT_KOKORO_AUTOSTART=0)`);
    return setStatus({
      url,
      ready: false,
      selected: true,
      startedByUs: false,
      lastCheckedMs: Date.now(),
    });
  }

  // Built-in engine (no Docker): start it through its supervisor and wait for
  // it to load — never warn about Docker for an install that doesn't use it.
  if (setupNativeEngine()) {
    await ensureNativeVoiceEngine();
    for (let i = 0; i < 60; i++) {
      if (await probeKokoro(url, 2500)) {
        log(`built-in voice engine ready at ${url}`);
        return setStatus({
          url,
          ready: true,
          selected: true,
          startedByUs: true,
          lastCheckedMs: Date.now(),
        });
      }
      await sleep(2000);
    }
    log(`built-in voice engine not ready at ${url} yet`);
    return setStatus({
      url,
      ready: false,
      selected: true,
      startedByUs: true,
      lastCheckedMs: Date.now(),
    });
  }

  // Docker preflight — Kokoro runs in a container, so a missing Docker CLI or a
  // stopped daemon means the autostart can never succeed. Surface a clear,
  // structured warning (boot log + status flag the UI banner reads) instead of
  // letting later TTS calls silently 503.
  const docker = await checkDocker();
  if (!docker.available) {
    const detail =
      docker.error ?? (docker.cliPresent ? "docker daemon not running" : "docker CLI not found");
    log(`⚠ ${dockerMissingWarning(detail)}`);
    return setStatus({
      url,
      ready: false,
      selected: true,
      startedByUs: false,
      lastCheckedMs: Date.now(),
      dockerMissing: true,
      warning: dockerMissingWarning(detail),
    });
  }

  const composeFile = resolveComposeFile();
  const known =
    setupKokoroContainer() ?? ((await containerState(KOKORO_CONTAINER)) ? KOKORO_CONTAINER : null);
  if (!composeFile && !known) {
    log(`cannot find ${COMPOSE_FILE}; skipping Kokoro autostart`);
    return setStatus({
      url,
      ready: false,
      selected: true,
      startedByUs: false,
      lastCheckedMs: Date.now(),
    });
  }

  log(`kokoro not running at ${url}; starting it...`);
  const spawned = await restartKokoro(composeFile);

  // Poll with exponential backoff until healthy or attempts exhausted. The
  // CPU image boots in ~10-15s, but a cold image pull can take much longer, so
  // we give it a generous default window.
  const maxAttempts = opts?.maxAttempts ?? 18;
  let delay = 1000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(delay);
    if (await probeKokoro(url, 2500)) {
      log(`kokoro healthy after ${attempt} attempt(s) at ${url}`);
      return setStatus({
        url,
        ready: true,
        selected: true,
        startedByUs: spawned,
        lastCheckedMs: Date.now(),
      });
    }
    log(`kokoro not ready yet (attempt ${attempt}/${maxAttempts}, waited ${delay}ms)`);
    delay = Math.min(Math.round(delay * 1.4), 5000);
  }

  log(`kokoro failed to become healthy at ${url} after ${maxAttempts} attempts`);
  return setStatus({
    url,
    ready: false,
    selected: true,
    startedByUs: spawned,
    lastCheckedMs: Date.now(),
  });
}

/** One-shot health probe that refreshes the cached status. */
export async function refreshKokoroStatus(): Promise<KokoroStatus> {
  const url = lastStatus?.url ?? resolveKokoroUrl();
  const selected = isKokoroSelected();
  const ready = selected ? await probeKokoro(url) : false;
  return setStatus({
    url,
    ready,
    selected,
    startedByUs: lastStatus?.startedByUs ?? false,
    lastCheckedMs: Date.now(),
  });
}

export interface KokoroHealthPingOptions {
  /** Probe interval in ms (default 30s). */
  intervalMs?: number;
  /** Called when ready/selected state changes. */
  onChange?: (status: KokoroStatus) => void;
}

/**
 * Start a periodic Kokoro health ping. While Kokoro is the selected provider
 * and the endpoint stops answering, this re-launches the container
 * (requirement #3). Self-healing is best-effort and never throws into the loop.
 */
export function startKokoroHealthPing(opts?: KokoroHealthPingOptions): void {
  if (pingTimer) return;
  const intervalMs = opts?.intervalMs ?? 30_000;
  const tick = async () => {
    const prev = lastStatus;
    const next = await refreshKokoroStatus();

    // Restart Kokoro if it's selected but went down (and we're allowed to).
    const autostart = !["0", "false", "no"].includes(
      (process.env.INFINIBOT_KOKORO_AUTOSTART ?? "").trim().toLowerCase(),
    );
    if (next.ready) failedRestarts = 0;
    if (next.selected && !next.ready && autostart && !restartInFlight) {
      // Back off after repeated failures: a container that can't come up
      // (bad image, port taken) shouldn't be poked every 30 s forever.
      downTicks++;
      const due = failedRestarts < 3 || downTicks % 10 === 0;
      if (due) {
        // De-race: hold the in-flight flag across a short settle window so a
        // slow probe on the next tick can't trigger a second concurrent spawn.
        restartInFlight = true;
        try {
          log(
            failedRestarts < 3
              ? `kokoro down while selected — attempting restart`
              : `kokoro still down after ${failedRestarts} restarts — retrying every ~5 min`,
          );
          const spawned = await restartKokoro(resolveComposeFile());
          if (spawned) {
            failedRestarts++;
            setStatus({ ...next, startedByUs: true });
          }
          // Give the container a moment to begin booting before releasing the
          // guard, so we don't immediately re-spawn on the very next tick.
          await sleep(5000);
        } finally {
          restartInFlight = false;
        }
      }
    }

    const changed = !prev || prev.ready !== next.ready || prev.selected !== next.selected;
    if (changed && opts?.onChange) {
      try {
        opts.onChange(next);
      } catch {
        // never let a listener break the ping loop
      }
    }
  };
  pingTimer = setInterval(() => void tick(), intervalMs);
  if (typeof pingTimer.unref === "function") pingTimer.unref();
  void tick();
}

/** Stop the periodic health ping (primarily for tests / shutdown). */
export function stopKokoroHealthPing(): void {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

/** Reset module state. Tests only. */
export function __resetKokoroBootstrapForTests(): void {
  lastStatus = null;
  ensurePromise = null;
  restartInFlight = false;
  failedRestarts = 0;
  downTicks = 0;
  stopKokoroHealthPing();
}
