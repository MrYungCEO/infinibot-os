import fs from "node:fs";
import path from "node:path";
import { loadConfig, type InfinibotConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getHostLocalityChecker } from "../secure-mode/host-locality.js";
import { realDeps, type RuntimeDeps } from "./drivers.js";
import {
  LocalRuntimeManager,
  LocalRuntimeError,
  type InteractiveEvent,
  type Lease,
  type Priority,
  type SwapLogEntry,
  type SwapProgress,
} from "./manager.js";
import {
  findRuntimeForProvider,
  findRuntimeForUrl,
  resolveManagerPolicy,
  resolveRuntimeSpecs,
  type LocalRuntimeSpec,
} from "./registry.js";
import { localProvidersEnabled } from "../saas/config.js";

const log = createSubsystemLogger("local-runtimes");

export const LOCAL_RUNTIMES_STATUS_EVENT = "localRuntimes.status";

type Broadcast = (event: string, payload: unknown) => void;

let manager: LocalRuntimeManager | null = null;
let broadcaster: Broadcast | null = null;
let specCache: { cfg: unknown; specs: LocalRuntimeSpec[] } | null = null;

function cfgNow(): InfinibotConfig | undefined {
  try {
    return loadConfig();
  } catch {
    return undefined;
  }
}

function specsFor(cfg: InfinibotConfig | undefined): LocalRuntimeSpec[] {
  if (specCache && specCache.cfg === cfg) return specCache.specs;
  const specs = resolveRuntimeSpecs(cfg);
  specCache = { cfg, specs };
  return specs;
}

function swapLogPath(): string {
  return path.join(resolveStateDir(), "local-runtimes", "swaps.jsonl");
}

export function createLocalRuntimeManager(deps: RuntimeDeps = realDeps()): LocalRuntimeManager {
  return new LocalRuntimeManager({
    deps,
    getSpecs: () => specsFor(cfgNow()),
    getPolicy: () => resolveManagerPolicy(cfgNow()),
    log: (level, message, meta) =>
      level === "warn" ? log.warn(message, meta) : log.info(message, meta),
    appendLog: (entry: SwapLogEntry) => {
      const file = swapLogPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    },
    onStatus: ({ swap, reason }) => {
      broadcaster?.(LOCAL_RUNTIMES_STATUS_EVENT, { swap, reason, at: Date.now() });
    },
  });
}

export function getLocalRuntimeManager(): LocalRuntimeManager {
  manager ??= createLocalRuntimeManager();
  return manager;
}

/** Test seam. */
export function setLocalRuntimeManagerForTest(m: LocalRuntimeManager | null): void {
  manager = m;
  specCache = null;
}

/**
 * Gateway boot: wire status broadcasts, the idle-stop sweep, and start any
 * runtime the owner flagged `startAtBoot` (default: none — started on demand).
 */
export function startLocalRuntimeManager(broadcast: Broadcast): LocalRuntimeManager | null {
  // Hosted (InfiniBot Cloud): no local GPU runtimes to manage.
  if (!localProvidersEnabled()) return null;
  const cfg = cfgNow();
  if (!resolveManagerPolicy(cfg).enabled) return null;
  broadcaster = broadcast;
  const m = getLocalRuntimeManager();
  m.startIdleTimer();
  const specs = m.specs();
  log.info(
    `registry: ${specs.map((s) => `${s.id}(${s.kind}${s.unit ? ` ${s.unit}` : ""})`).join(", ") || "empty"}`,
  );
  for (const s of specs.filter((x) => x.startAtBoot)) {
    void m.start(s.id).catch((err) => log.warn(`startAtBoot ${s.id} failed: ${String(err)}`));
  }
  return m;
}

export function stopLocalRuntimeManager(): void {
  manager?.dispose();
  broadcaster = null;
}

export function runtimeForModel(
  cfg: InfinibotConfig | undefined,
  provider: string,
  model?: string,
): LocalRuntimeSpec | null {
  if (!resolveManagerPolicy(cfg).enabled) return null;
  return findRuntimeForProvider(specsFor(cfg), provider, model);
}

function emitRuntimeNotice(runId: string, sessionKey: string | undefined, p: SwapProgress): void {
  emitAgentEvent({
    runId,
    stream: "notice",
    ...(sessionKey ? { sessionKey } : {}),
    data: {
      kind: "runtime_status",
      level: p.phase === "failed" ? "warning" : "info",
      runtimeId: p.runtimeId,
      label: p.label,
      phase: p.phase,
      message: p.message,
      etaSec: p.etaSec,
      elapsedSec: p.elapsedSec,
      startedAt: p.startedAt,
      ...(p.fromLabel ? { fromLabel: p.fromLabel } : {}),
    },
  });
}

/**
 * Before an agent run on `provider/model`: make the serving local runtime
 * ready (swapping the GPU if needed), streaming progress to the chat as
 * `runtime_status` notices. Returns null for models no runtime serves.
 */
export async function acquireRuntimeForRun(params: {
  cfg?: InfinibotConfig;
  provider: string;
  model: string;
  runId: string;
  sessionKey?: string;
  priority?: Priority;
}): Promise<Lease | null> {
  const cfg = params.cfg ?? cfgNow();
  const spec = runtimeForModel(cfg, params.provider, params.model);
  if (!spec) return null;
  return getLocalRuntimeManager().acquire(spec.id, {
    model: params.model,
    priority: params.priority ?? "interactive",
    reason: `run ${params.provider}/${params.model}`,
    onProgress: (p) => emitRuntimeNotice(params.runId, params.sessionKey, p),
  });
}

/**
 * Background (OCR / video) access to a local endpoint. Never forces a swap
 * while chat holds the GPU (interactive-first policy); waits instead.
 * Returns null when the URL isn't a registry runtime.
 */
export async function acquireRuntimeForEndpoint(params: {
  url: string;
  model?: string;
  reason: string;
  onProgress?: (p: SwapProgress) => void;
}): Promise<Lease | null> {
  const cfg = cfgNow();
  if (!resolveManagerPolicy(cfg).enabled) return null;
  const spec = findRuntimeForUrl(specsFor(cfg), params.url);
  if (!spec) return null;
  return getLocalRuntimeManager().acquire(spec.id, {
    model: params.model,
    priority: "background",
    reason: params.reason,
    onProgress: params.onProgress,
  });
}

/**
 * Vision routing for OCR: when a vision-capable registry runtime other than
 * the default endpoint is already up (e.g. vLLM serving a VL model), use it
 * instead of swapping the GPU back to Ollama.
 */
export async function pickActiveVisionRuntime(
  defaultUrl: string,
): Promise<{ baseUrl: string; model: string; runtimeId: string; verifiedLocal: boolean } | null> {
  const cfg = cfgNow();
  if (!resolveManagerPolicy(cfg).enabled) return null;
  const specs = specsFor(cfg);
  const def = findRuntimeForUrl(specs, defaultUrl);
  const m = getLocalRuntimeManager();
  for (const s of specs) {
    if (s.id === def?.id || s.kind !== "systemd" || s.visionModels.length === 0) continue;
    const p = await m.probe(s).catch(() => null);
    if (!p?.healthy) continue;
    // OCR is local-only: the runtime's host must be bound to this machine.
    const verdict = await getHostLocalityChecker()
      .check(new URL(s.baseUrl).hostname, cfg)
      .catch(() => null);
    if (!verdict?.local) continue;
    return { baseUrl: s.baseUrl, model: s.visionModels[0]!, runtimeId: s.id, verifiedLocal: true };
  }
  return null;
}

/**
 * Interactive-priority hooks for background queues (OCR / video):
 * - `withInteractiveRuntime(id, fn)` runs a chat-priority section;
 * - `onLocalRuntimeInteractive(cb)` fires `busy`/`idle` per runtime so a queue
 *   can pause and resume;
 * - `runtimeIdForEndpoint(url)` maps an endpoint (e.g. OCR's Ollama URL) to its id.
 */
export function withInteractiveRuntime<T>(runtimeId: string, fn: () => Promise<T>): Promise<T> {
  return getLocalRuntimeManager().withInteractive(runtimeId, fn);
}

export function onLocalRuntimeInteractive(listener: (e: InteractiveEvent) => void): () => void {
  return getLocalRuntimeManager().onInteractive(listener);
}

export function isLocalRuntimeInteractiveBusy(runtimeId: string): boolean {
  return getLocalRuntimeManager().isInteractiveBusy(runtimeId);
}

export function runtimeIdForEndpoint(url: string): string | null {
  const cfg = cfgNow();
  if (!resolveManagerPolicy(cfg).enabled) return null;
  return findRuntimeForUrl(specsFor(cfg), url)?.id ?? null;
}

export { LocalRuntimeError };
