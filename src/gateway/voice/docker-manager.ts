/**
 * Unified local-voice Docker manager.
 *
 * One place that knows how to inspect and drive the `docker-compose.voice.yaml`
 * stack (kokoro / speaches / livekit / voice-agent / autoheal): per-container
 * status + health, per-service up/down/restart, bounded logs, GPU detection,
 * and a preflight that the wizard gates on. Everything here is NODE-LOCAL — a
 * satellite manages ITS OWN containers, so these never proxy to master.
 *
 * Reuses the existing primitives instead of reinventing them:
 *   - resolveComposeFile()  (kokoro-bootstrap.ts) — finds the compose file
 *   - checkDocker()         (voice/docker-check.ts) — CLI + daemon preflight
 *   - ensureVoiceEnvFile()  (voice/docker-install.ts) — LiveKit secrets in .env
 */

import { execFile, spawn } from "node:child_process";
import { dirname } from "node:path";

import { resolveComposeFile } from "../kokoro-bootstrap.js";
import { checkDocker, DOCKER_INSTALL_URL, type DockerStatus } from "./docker-check.js";
import { ensureVoiceEnvFile } from "./docker-install.js";
import { coerceString } from "../../shared/text/coerce.js";

export type VoiceServiceName = "kokoro" | "speaches" | "livekit" | "voice-agent" | "autoheal";

export interface VoiceServiceSpec {
  name: VoiceServiceName;
  /** docker container name (from docker-compose.voice.yaml `container_name`). */
  container: string;
  /** Host URL to probe for "actually answering" health (undefined → state only). */
  healthUrl?: string;
  /** Needs an NVIDIA GPU (speaches CUDA image) — gated in the wizard. */
  requiresGpu?: boolean;
  /** Needs LiveKit API key/secret (ensured via ensureVoiceEnvFile). */
  requiresCreds?: boolean;
  description: string;
}

/** Canonical service catalog — mirrors docker-compose.voice.yaml. */
export const VOICE_SERVICES: readonly VoiceServiceSpec[] = [
  {
    name: "kokoro",
    container: "infinibot-kokoro",
    healthUrl: "http://localhost:8882/v1/models",
    description: "Local neural TTS (CPU, no keys, no GPU)",
  },
  {
    name: "speaches",
    container: "infinibot-speaches",
    healthUrl: "http://localhost:8002/v1/models",
    requiresGpu: true,
    description: "Local STT (requires NVIDIA GPU)",
  },
  {
    name: "livekit",
    container: "infinibot-livekit",
    healthUrl: "http://localhost:7882",
    requiresCreds: true,
    description: "Realtime media server (LiveKit secrets)",
  },
  {
    name: "voice-agent",
    container: "infinibot-voice-agent",
    requiresCreds: true,
    description: "Voice agent bridge (LiveKit secrets, depends on the others)",
  },
  {
    name: "autoheal",
    container: "infinibot-autoheal",
    description: "Restarts unhealthy containers",
  },
];

const VALID_SERVICE_NAMES = new Set<string>(VOICE_SERVICES.map((s) => s.name));

/** True for a service name we recognize (guards the per-service RPCs). */
export function isVoiceServiceName(v: unknown): v is VoiceServiceName {
  return typeof v === "string" && VALID_SERVICE_NAMES.has(v);
}

/**
 * `docker compose` interpolates the ENTIRE file before starting any service, so
 * the required `${LIVEKIT_API_KEY:?…}` / `${LIVEKIT_API_SECRET:?…}` vars abort
 * the parse even when we only touch `kokoro`. Inject harmless placeholders so
 * the file parses; the real secrets (when needed) live in ~/.infinibot/.env.
 */
export function composeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY || "placeholder-dev-key",
    LIVEKIT_API_SECRET:
      process.env.LIVEKIT_API_SECRET || "placeholder-dev-secret-change-me-0000000000",
  };
}

interface ExecResult {
  code: number | null;
  out: string;
  err: string;
}

/** Run a `docker …` command in the compose dir, capturing stdout/stderr. */
function dockerExec(composeFile: string, args: string[], timeoutMs = 120_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    try {
      const child = spawn("docker", args, {
        cwd: dirname(composeFile),
        windowsHide: true,
        env: composeEnv(),
      });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, timeoutMs);
      child.stdout?.on("data", (d) => (out += String(d)));
      child.stderr?.on("data", (d) => (err += String(d)));
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: null, out, err: `${err}${String(e)}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, out, err });
      });
    } catch (e) {
      resolve({ code: null, out, err: String(e) });
    }
  });
}

export type ServiceState = "running" | "exited" | "restarting" | "starting" | "not_found";
export type ServiceHealth = "healthy" | "unhealthy" | "starting" | "none";

export interface VoiceServiceStatus {
  name: VoiceServiceName;
  container: string;
  state: ServiceState;
  /** docker health (from compose `Health`) reconciled with an HTTP probe. */
  health: ServiceHealth;
  /** The container is up AND its host endpoint answered (when it has one). */
  reachable: boolean;
  requiresGpu: boolean;
  requiresCreds: boolean;
  description: string;
}

export interface StackStatus {
  composeFile: string | null;
  docker: DockerStatus;
  services: VoiceServiceStatus[];
}

/** Hit a host URL; true when it answers at all (any status). */
async function probeUrl(url: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status > 0;
  } catch {
    return false;
  }
}

/** Parse `docker compose ps --format json` (NDJSON on newer docker, array on older). */
function parseComposePs(raw: string): Array<Record<string, unknown>> {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const asArray = JSON.parse(trimmed);
    if (Array.isArray(asArray)) return asArray as Array<Record<string, unknown>>;
  } catch {
    /* fall through to NDJSON */
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* skip non-JSON noise */
    }
  }
  return rows;
}

function mapState(raw: string): ServiceState {
  const s = raw.toLowerCase();
  if (s.includes("running") || s.includes("up")) return "running";
  if (s.includes("restart")) return "restarting";
  if (s.includes("created") || s.includes("starting")) return "starting";
  if (s.includes("exit") || s.includes("dead") || s.includes("stopped")) return "exited";
  return "not_found";
}

/**
 * Per-container status for the whole voice stack. Combines `docker compose ps`
 * (state + docker health) with a live HTTP probe of each service's host port so
 * a container that's "running" but not yet answering reads as `starting`, not
 * `healthy`. Never throws — returns a best-effort snapshot.
 */
export async function getStackStatus(): Promise<StackStatus> {
  const composeFile = resolveComposeFile();
  const docker = await checkDocker();
  if (!composeFile || !docker.available) {
    return {
      composeFile,
      docker,
      services: VOICE_SERVICES.map((spec) => ({
        name: spec.name,
        container: spec.container,
        state: "not_found",
        health: "none",
        reachable: false,
        requiresGpu: !!spec.requiresGpu,
        requiresCreds: !!spec.requiresCreds,
        description: spec.description,
      })),
    };
  }

  const ps = await dockerExec(
    composeFile,
    ["compose", "-f", composeFile, "ps", "-a", "--format", "json"],
    15_000,
  );
  const rows = parseComposePs(ps.out);
  const byService = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const svc = coerceString(row.Service ?? row.service);
    if (svc) byService.set(svc, row);
  }

  const services = await Promise.all(
    VOICE_SERVICES.map(async (spec): Promise<VoiceServiceStatus> => {
      const row = byService.get(spec.name);
      const state: ServiceState = row
        ? mapState(coerceString(row.State ?? row.Status))
        : "not_found";
      const dockerHealth = coerceString(row?.Health).toLowerCase();
      const reachable =
        state === "running" && spec.healthUrl ? await probeUrl(spec.healthUrl) : false;

      let health: ServiceHealth = "none";
      if (dockerHealth === "healthy") health = "healthy";
      else if (dockerHealth === "unhealthy") health = "unhealthy";
      else if (dockerHealth === "starting") health = "starting";
      else if (spec.healthUrl) {
        // No docker healthcheck → derive from the HTTP probe.
        if (state === "running") health = reachable ? "healthy" : "starting";
        else if (state === "exited" || state === "not_found") health = "unhealthy";
      }

      return {
        name: spec.name,
        container: spec.container,
        state,
        health,
        reachable: spec.healthUrl ? reachable : state === "running",
        requiresGpu: !!spec.requiresGpu,
        requiresCreds: !!spec.requiresCreds,
        description: spec.description,
      };
    }),
  );

  return { composeFile, docker, services };
}

export interface ServiceActionResult {
  ok: boolean;
  output?: string;
  error?: string;
}

/**
 * Start / stop / restart a single voice service.
 *   - up      → `compose up -d <svc>` (ensures LiveKit secrets first if needed)
 *   - down    → `compose stop <svc>` (per-service stop; keeps the rest running)
 *   - restart → `compose restart <svc>`
 */
export async function serviceAction(
  action: "up" | "down" | "restart",
  name: VoiceServiceName,
): Promise<ServiceActionResult> {
  const composeFile = resolveComposeFile();
  if (!composeFile)
    return { ok: false, error: "docker-compose.voice.yaml not found near the gateway." };

  if (action === "up") {
    const docker = await checkDocker({ force: true });
    if (!docker.available) {
      return {
        ok: false,
        error: docker.cliPresent
          ? "Docker is installed but the daemon isn't running — start Docker Desktop, then try again."
          : `Docker not found. Install it: ${DOCKER_INSTALL_URL}`,
      };
    }
    const spec = VOICE_SERVICES.find((s) => s.name === name);
    if (spec?.requiresCreds) ensureVoiceEnvFile();
  }

  const args =
    action === "up"
      ? ["compose", "-f", composeFile, "up", "-d", name]
      : action === "down"
        ? ["compose", "-f", composeFile, "stop", name]
        : ["compose", "-f", composeFile, "restart", name];

  const r = await dockerExec(composeFile, args);
  const ok = r.code === 0;
  return { ok, output: r.out || undefined, error: ok ? undefined : r.err || `exited ${r.code}` };
}

/** Bounded logs for one service (default last 200 lines). */
export async function serviceLogs(
  name: VoiceServiceName,
  tail = 200,
): Promise<ServiceActionResult> {
  const composeFile = resolveComposeFile();
  if (!composeFile) return { ok: false, error: "compose file not found" };
  const safeTail = Math.max(1, Math.min(2000, Math.floor(tail) || 200));
  const r = await dockerExec(
    composeFile,
    [
      "compose",
      "-f",
      composeFile,
      "logs",
      "--no-color",
      "--no-log-prefix",
      "--tail",
      String(safeTail),
      name,
    ],
    15_000,
  );
  const ok = r.code === 0;
  // `docker compose logs` may emit container output on stderr; fold both streams
  // into `output` so the caller always sees the lines.
  return {
    ok,
    output: (r.out + (r.err || "")).trim() || undefined,
    error: ok ? undefined : r.err || `exited ${r.code}`,
  };
}

export interface GpuStatus {
  /** nvidia-smi present and answered. */
  present: boolean;
  /** Number of GPUs reported (0 when absent). */
  count: number;
  error?: string;
}

/** Detect NVIDIA GPUs (gates the speaches STT service in the wizard). */
export function detectGpu(timeoutMs = 4000): Promise<GpuStatus> {
  return new Promise((resolve) => {
    try {
      execFile(
        "nvidia-smi",
        ["--query-gpu=count", "--format=csv,noheader"],
        { timeout: timeoutMs, windowsHide: true },
        (err, stdout) => {
          if (err) {
            resolve({ present: false, count: 0, error: "nvidia-smi not found / no NVIDIA GPU" });
            return;
          }
          const first = String(stdout).trim().split(/\r?\n/)[0]?.trim() ?? "";
          const count = Number.parseInt(first, 10);
          resolve({
            present: Number.isFinite(count) && count > 0,
            count: Number.isFinite(count) ? count : 0,
          });
        },
      );
    } catch {
      resolve({ present: false, count: 0, error: "failed to run nvidia-smi" });
    }
  });
}

export interface PreflightReport {
  ok: boolean;
  composeFile: string | null;
  docker: DockerStatus;
  gpu: GpuStatus;
  /** True after ensureVoiceEnvFile guaranteed LiveKit secrets exist. */
  credsReady: boolean;
  installUrl: string;
  /** Services that can run on this host given GPU/creds/docker. */
  runnable: VoiceServiceName[];
  notes: string[];
}

/**
 * Wizard preflight: is Docker usable, is there a GPU, are creds ready, which
 * services can actually run here. Drives gating + clear guidance before the
 * wizard attempts to provision anything.
 */
export async function preflight(): Promise<PreflightReport> {
  const composeFile = resolveComposeFile();
  const docker = await checkDocker({ force: true });
  const gpu = await detectGpu();
  const notes: string[] = [];

  let credsReady = false;
  if (docker.available && composeFile) {
    try {
      ensureVoiceEnvFile();
      credsReady = true;
    } catch (e) {
      notes.push(`Could not write LiveKit secrets: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!composeFile) notes.push("docker-compose.voice.yaml not found near the gateway.");
  if (!docker.available) {
    notes.push(
      docker.cliPresent
        ? "Docker daemon isn't running — start Docker Desktop."
        : `Docker CLI not found — install it: ${DOCKER_INSTALL_URL}`,
    );
  }
  if (!gpu.present)
    notes.push(
      "No NVIDIA GPU — local STT (speaches) is unavailable; Kokoro TTS still works (CPU).",
    );

  const runnable: VoiceServiceName[] = [];
  if (docker.available && composeFile) {
    for (const s of VOICE_SERVICES) {
      if (s.requiresGpu && !gpu.present) continue;
      if (s.requiresCreds && !credsReady) continue;
      runnable.push(s.name);
    }
  }

  return {
    ok: docker.available && !!composeFile,
    composeFile,
    docker,
    gpu,
    credsReady,
    installUrl: DOCKER_INSTALL_URL,
    runnable,
    notes,
  };
}

/**
 * The "core" voice services needed for basic TTS/STT — Kokoro (TTS, always) and
 * Speaches (STT, GPU-gated). LiveKit + voice-agent power the realtime agent and
 * are NOT required for plain speak/transcribe, so autostart leaves them to the
 * explicit wizard flow (which has the LiveKit-creds step).
 */
const CORE_VOICE_SERVICES: VoiceServiceName[] = ["kokoro", "speaches"];

export interface EnsureStackResult {
  ok: boolean;
  /** Services we attempted to start (host-runnable subset of the core set). */
  started: VoiceServiceName[];
  /** Services that became reachable within the health window. */
  healthy: VoiceServiceName[];
  /** Services that never answered (with the reason, when known). */
  unhealthy: Array<{ name: VoiceServiceName; reason: string }>;
  /** Why the whole thing was a no-op (docker missing, no compose, etc.). */
  skippedReason?: string;
  notes: string[];
}

/**
 * Reliable autostart for the local Docker voice stack: unlike the old
 * fire-and-forget `up -d <everything>`, this
 *   1. preflights (docker usable? GPU? creds?) and only starts services that can
 *      actually run here — so a non-GPU host never hangs trying to boot Speaches;
 *   2. brings up each runnable core service, then AWAITS its HTTP health with a
 *      bounded poll;
 *   3. returns a structured per-service result so the caller can log/ surface the
 *      real reason instead of a soft boolean.
 * Never throws — boot must continue regardless.
 */
export async function ensureVoiceStackHealthy(opts?: {
  services?: VoiceServiceName[];
  /** Total health-wait budget in ms (default 45s — covers a cold CPU boot). */
  timeoutMs?: number;
}): Promise<EnsureStackResult> {
  const notes: string[] = [];
  const pre = await preflight();
  notes.push(...pre.notes);

  if (!pre.composeFile) {
    return {
      ok: false,
      started: [],
      healthy: [],
      unhealthy: [],
      skippedReason: "compose file not found",
      notes,
    };
  }
  if (!pre.docker.available) {
    return {
      ok: false,
      started: [],
      healthy: [],
      unhealthy: [],
      skippedReason: pre.docker.cliPresent ? "docker daemon not running" : "docker CLI not found",
      notes,
    };
  }

  const want = opts?.services ?? CORE_VOICE_SERVICES;
  // Intersect the request with what this host can actually run (GPU/creds gated).
  const toStart = want.filter((s) => pre.runnable.includes(s));
  const skipped = want.filter((s) => !pre.runnable.includes(s));
  for (const s of skipped) {
    const spec = VOICE_SERVICES.find((v) => v.name === s);
    if (spec?.requiresGpu) notes.push(`Skipping ${s}: needs an NVIDIA GPU.`);
    else if (spec?.requiresCreds) notes.push(`Skipping ${s}: LiveKit secrets unavailable.`);
  }

  if (!toStart.length) {
    return {
      ok: false,
      started: [],
      healthy: [],
      unhealthy: [],
      skippedReason: "no runnable voice services on this host",
      notes,
    };
  }

  // Start each runnable service (up -d is idempotent — no-op if already running).
  for (const name of toStart) {
    const r = await serviceAction("up", name);
    if (!r.ok) notes.push(`'up ${name}' reported: ${r.error ?? "unknown error"}`);
  }

  // Await health: poll each started service's endpoint until reachable or budget
  // exhausted. Services without a healthUrl are considered healthy once started.
  const deadline = Date.now() + (opts?.timeoutMs ?? 45_000);
  const pending = new Set(toStart);
  const healthy: VoiceServiceName[] = [];
  while (pending.size && Date.now() < deadline) {
    await Promise.all(
      [...pending].map(async (name) => {
        const spec = VOICE_SERVICES.find((v) => v.name === name);
        const ok = spec?.healthUrl ? await probeUrl(spec.healthUrl) : true;
        if (ok) {
          healthy.push(name);
          pending.delete(name);
        }
      }),
    );
    if (pending.size) await new Promise((r) => setTimeout(r, 2000));
  }

  const unhealthy = [...pending].map((name) => ({
    name,
    reason:
      name === "speaches"
        ? "STT container did not answer (CUDA image — needs a working NVIDIA GPU)"
        : "container did not answer within the health window",
  }));

  return { ok: unhealthy.length === 0, started: toStart, healthy, unhealthy, notes };
}
