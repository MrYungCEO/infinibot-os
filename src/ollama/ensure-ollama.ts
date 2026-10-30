/**
 * Ollama bootstrap + health for InfiniBot federation nodes.
 *
 * On gateway startup every node calls {@link ensureOllamaRunning}: it probes the
 * local Ollama daemon (`GET /api/tags`) and, if nothing answers on a *local*
 * host, spawns `ollama serve` detached and polls (timeout + backoff) until the
 * daemon reports healthy. The resolved status (running + installed models) is
 * cached so the rest of the system — default-provider resolution, the
 * `/api/ollama/health` endpoint, and the federation manifest — can read it
 * synchronously via {@link getLastOllamaStatus}.
 *
 * Nothing here hard-codes provider selection; it only makes Ollama *available
 * and discoverable*. The default-provider fallback lives in
 * `agents/model-selection.ts` and reads {@link getLastOllamaStatus}.
 */

import { spawn } from "node:child_process";
import { hostname as osHostname } from "node:os";

import type { InfinibotConfig } from "../config/config.js";

/** Default Ollama host when nothing is configured. */
const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";

export interface OllamaStatus {
  /** Base URL the status describes (no trailing slash). */
  host: string;
  /** Whether `/api/tags` answered on the last probe. */
  running: boolean;
  /** Installed model names, as Ollama reported them. */
  models: string[];
  /** True when this process spawned `ollama serve`. */
  startedByUs: boolean;
  /** Wall-clock time of the last probe. */
  lastCheckedMs: number;
}

let lastStatus: OllamaStatus | null = null;
let ensurePromise: Promise<OllamaStatus> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;

/** Last known Ollama status, or `null` if never probed. Synchronous. */
export function getLastOllamaStatus(): OllamaStatus | null {
  return lastStatus;
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[OLLAMA-BOOTSTRAP] ${msg}`);
}

/**
 * Resolve the Ollama base URL from config, env, then the local default.
 * Accepts both `providers.ollama.baseUrl` and the legacy
 * `integrations.ollama.host` shapes, and bare `host:port` (adds `http://`).
 */
export function resolveOllamaHost(cfg?: InfinibotConfig): string {
  const providerBaseUrl = (cfg as { providers?: { ollama?: { baseUrl?: string } } } | undefined)
    ?.providers?.ollama?.baseUrl;
  if (typeof providerBaseUrl === "string" && providerBaseUrl.trim()) {
    return providerBaseUrl.trim().replace(/\/+$/, "");
  }
  const integrationsHost = (cfg as { integrations?: { ollama?: { host?: string } } } | undefined)
    ?.integrations?.ollama?.host;
  if (typeof integrationsHost === "string" && integrationsHost.trim()) {
    const h = integrationsHost.trim();
    return (h.startsWith("http") ? h : `http://${h}`).replace(/\/+$/, "");
  }
  const envHost = process.env.OLLAMA_HOST?.trim();
  if (envHost) {
    return (envHost.startsWith("http") ? envHost : `http://${envHost}`).replace(/\/+$/, "");
  }
  return DEFAULT_OLLAMA_HOST;
}

/** Whether a base URL points at this machine (so we may autostart the daemon). */
function isLocalHost(host: string): boolean {
  try {
    const { hostname } = new URL(host);
    const local = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", osHostname().toLowerCase()]);
    return local.has(hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Hit `/api/tags`; returns reachability + installed model names. */
async function probeTags(
  host: string,
  timeoutMs = 3000,
): Promise<{ ok: boolean; models: string[] }> {
  try {
    const res = await fetch(`${host}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, models: [] };
    const data = (await res.json()) as { models?: Array<{ name?: unknown }> };
    const models = Array.isArray(data?.models)
      ? data.models
          .map((m) => (typeof m?.name === "string" ? m.name.trim() : ""))
          .filter((name): name is string => name.length > 0)
      : [];
    return { ok: true, models };
  } catch {
    return { ok: false, models: [] };
  }
}

function setStatus(next: OllamaStatus): OllamaStatus {
  lastStatus = next;
  return next;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Spawn `ollama serve` detached. Resolves false if the binary is missing. */
function spawnOllamaServe(): boolean {
  try {
    const child = spawn("ollama", ["serve"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.on("error", (err) => {
      log(`failed to spawn 'ollama serve': ${err instanceof Error ? err.message : String(err)}`);
    });
    child.unref();
    return true;
  } catch (err) {
    log(`failed to spawn 'ollama serve': ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export interface EnsureOllamaOptions {
  cfg?: InfinibotConfig;
  /** Max health-probe attempts after a start (default 12). */
  maxAttempts?: number;
  /** Force a fresh run instead of returning the cached boot result. */
  force?: boolean;
}

/**
 * Ensure a local Ollama daemon is up, autostarting it if needed.
 * Idempotent per process: the first call's promise is cached.
 */
export function ensureOllamaRunning(opts?: EnsureOllamaOptions): Promise<OllamaStatus> {
  if (ensurePromise && !opts?.force) return ensurePromise;
  ensurePromise = doEnsure(opts);
  return ensurePromise;
}

async function doEnsure(opts?: EnsureOllamaOptions): Promise<OllamaStatus> {
  const host = resolveOllamaHost(opts?.cfg);
  const autostart = !["0", "false", "no"].includes(
    (process.env.INFINIBOT_OLLAMA_AUTOSTART ?? "").trim().toLowerCase(),
  );

  // Already healthy?
  const first = await probeTags(host);
  if (first.ok) {
    log(`ollama already running at ${host} (${first.models.length} models)`);
    return setStatus({
      host,
      running: true,
      models: first.models,
      startedByUs: false,
      lastCheckedMs: Date.now(),
    });
  }

  const local = isLocalHost(host);
  if (!local) {
    log(`ollama not reachable at remote host ${host}; cannot autostart, will keep health-checking`);
    return setStatus({
      host,
      running: false,
      models: [],
      startedByUs: false,
      lastCheckedMs: Date.now(),
    });
  }
  if (!autostart) {
    log(`ollama not running at ${host} and autostart disabled (INFINIBOT_OLLAMA_AUTOSTART=0)`);
    return setStatus({
      host,
      running: false,
      models: [],
      startedByUs: false,
      lastCheckedMs: Date.now(),
    });
  }

  log(`ollama not running at ${host}; starting 'ollama serve'...`);
  const spawned = spawnOllamaServe();

  // Poll with exponential backoff until healthy or attempts exhausted.
  const maxAttempts = opts?.maxAttempts ?? 12;
  let delay = 500;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(delay);
    const probe = await probeTags(host, 2500);
    if (probe.ok) {
      log(`ollama healthy after ${attempt} attempt(s) — ${probe.models.length} models at ${host}`);
      return setStatus({
        host,
        running: true,
        models: probe.models,
        startedByUs: spawned,
        lastCheckedMs: Date.now(),
      });
    }
    log(`ollama not ready yet (attempt ${attempt}/${maxAttempts}, waited ${delay}ms)`);
    delay = Math.min(Math.round(delay * 1.5), 4000);
  }

  log(`ollama failed to become healthy at ${host} after ${maxAttempts} attempts`);
  return setStatus({
    host,
    running: false,
    models: [],
    startedByUs: spawned,
    lastCheckedMs: Date.now(),
  });
}

/** One-shot health probe that refreshes the cached status. */
export async function refreshOllamaStatus(cfg?: InfinibotConfig): Promise<OllamaStatus> {
  const host = lastStatus?.host ?? resolveOllamaHost(cfg);
  const probe = await probeTags(host);
  return setStatus({
    host,
    running: probe.ok,
    models: probe.ok ? probe.models : [],
    startedByUs: lastStatus?.startedByUs ?? false,
    lastCheckedMs: Date.now(),
  });
}

export interface OllamaHealthPingOptions {
  cfg?: InfinibotConfig;
  /** Probe interval in ms (default 30s). */
  intervalMs?: number;
  /** Called when running-state or model count changes. */
  onChange?: (status: OllamaStatus) => void;
}

/** Start a periodic `/api/tags` ping so the gateway tracks Ollama availability. */
export function startOllamaHealthPing(opts?: OllamaHealthPingOptions): void {
  if (pingTimer) return;
  const intervalMs = opts?.intervalMs ?? 30_000;
  const tick = async () => {
    const prev = lastStatus;
    const next = await refreshOllamaStatus(opts?.cfg);
    const changed =
      !prev || prev.running !== next.running || prev.models.length !== next.models.length;
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
export function stopOllamaHealthPing(): void {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

/** Reset module state. Tests only. */
export function __resetOllamaBootstrapForTests(): void {
  lastStatus = null;
  ensurePromise = null;
  stopOllamaHealthPing();
}
