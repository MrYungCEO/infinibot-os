import {
  gpuInfo,
  httpOk,
  ollamaLoad,
  ollamaLoaded,
  ollamaUnload,
  systemdActiveState,
  systemdLastError,
  systemdSubState,
  systemdStart,
  systemdStop,
  type GpuInfo,
  type RuntimeDeps,
} from "./drivers.js";
import { modelMatches, type LocalRuntimeSpec, type ManagerPolicy } from "./registry.js";

export type RuntimeState = "stopped" | "starting" | "ready" | "stopping" | "failed" | "unavailable";

export type SwapPhase =
  | "waiting"
  | "draining"
  | "freeing"
  | "starting"
  | "loading"
  | "ready"
  | "failed";

export type SwapProgress = {
  runtimeId: string;
  label: string;
  model?: string;
  phase: SwapPhase;
  message: string;
  startedAt: number;
  elapsedSec: number;
  etaSec: number;
  fromRuntimeId?: string;
  fromLabel?: string;
  error?: string;
};

export type SwapLogEntry = {
  at: number;
  kind: "swap" | "start" | "stop" | "idle-stop" | "failed" | "restore" | "drain-timeout";
  runtimeId: string;
  from?: string;
  model?: string;
  reason?: string;
  durationMs?: number;
  message: string;
};

export type RuntimeStatus = {
  id: string;
  label: string;
  kind: LocalRuntimeSpec["kind"];
  unit?: string;
  baseUrl: string;
  providers: string[];
  state: RuntimeState;
  /** systemd ActiveState (systemd runtimes). */
  activeState?: string;
  healthy: boolean;
  holdsGpu: boolean;
  loadedModels: Array<{ name: string; vramMb: number }>;
  inflight: number;
  lastUsedAt?: number;
  readySince?: number;
  idleStopMinutes: number;
  idleStopAt?: number;
  vramMb: number;
  etaSec: number;
  error?: string;
};

export type ManagerStatus = {
  enabled: boolean;
  gpu: GpuInfo | null;
  runtimes: RuntimeStatus[];
  swap: SwapProgress | null;
  log: SwapLogEntry[];
};

export type Priority = "interactive" | "background";

export type AcquireOptions = {
  model?: string;
  priority?: Priority;
  reason?: string;
  onProgress?: (p: SwapProgress) => void;
};

export type InteractiveEvent = { runtimeId: string; state: "busy" | "idle"; at: number };

export type Lease = { runtimeId: string; swapped: boolean; release: () => void };

export class LocalRuntimeError extends Error {
  readonly code = "local_runtime_unavailable";
  readonly runtimeId: string;
  readonly restoredTo?: string;
  constructor(
    message: string,
    params: { runtimeId: string; restoredTo?: string; cause?: unknown },
  ) {
    super(message, { cause: params.cause });
    this.name = "LocalRuntimeError";
    this.runtimeId = params.runtimeId;
    this.restoredTo = params.restoredTo;
  }
}

type Live = {
  state: RuntimeState;
  activeState?: string;
  healthy: boolean;
  holdsGpu: boolean;
  loaded: Array<{ name: string; vramMb: number }>;
  inflight: number;
  /** In-flight interactive (chat) leases — background work pauses while > 0. */
  interactive: number;
  lastUsedAt?: number;
  lastInteractiveAt?: number;
  readySince?: number;
  error?: string;
};

type Probe = Pick<Live, "healthy" | "holdsGpu" | "loaded" | "activeState"> & {
  state: RuntimeState;
};

type SwapOp = {
  target: string;
  model?: string;
  progress: SwapProgress;
  subscribers: Set<(p: SwapProgress) => void>;
  promise: Promise<void>;
};

export type ManagerOptions = {
  deps: RuntimeDeps;
  getSpecs: () => LocalRuntimeSpec[];
  getPolicy: () => ManagerPolicy;
  log?: (level: "info" | "warn", message: string, meta?: Record<string, unknown>) => void;
  appendLog?: (entry: SwapLogEntry) => void;
  onStatus?: (event: { swap: SwapProgress | null; reason: string }) => void;
  /** Health poll interval while starting (ms). */
  pollMs?: number;
};

const LOG_RING = 60;

/**
 * Owns the GPU across local runtimes. One swap at a time; requests for the
 * runtime being started batch onto that swap; a swap waits for in-flight
 * requests on the runtime it evicts. Only registry units/models are touched.
 */
export class LocalRuntimeManager {
  private readonly live = new Map<string, Live>();
  private current: SwapOp | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private readonly ring: SwapLogEntry[] = [];
  private changeWaiters: Array<() => void> = [];
  private readonly interactiveListeners = new Set<(e: InteractiveEvent) => void>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pollMs: number;

  constructor(private readonly opts: ManagerOptions) {
    this.pollMs = opts.pollMs ?? 2000;
  }

  // ── registry ──────────────────────────────────────────────────────────

  specs(): LocalRuntimeSpec[] {
    return this.opts.getSpecs();
  }

  spec(id: string): LocalRuntimeSpec | undefined {
    return this.specs().find((s) => s.id === id);
  }

  private liveOf(id: string): Live {
    let l = this.live.get(id);
    if (!l) {
      l = {
        state: "stopped",
        healthy: false,
        holdsGpu: false,
        loaded: [],
        inflight: 0,
        interactive: 0,
      };
      this.live.set(id, l);
    }
    return l;
  }

  // ── probing ───────────────────────────────────────────────────────────

  async probe(spec: LocalRuntimeSpec): Promise<Probe> {
    const { deps } = this.opts;
    const l = this.liveOf(spec.id);
    let p: Probe;
    if (spec.kind === "systemd") {
      const activeState = await systemdActiveState(deps, spec.unit!);
      const holdsGpu = ["active", "activating", "deactivating", "reloading"].includes(activeState);
      const healthy = activeState === "active" && (await httpOk(deps, spec.healthUrl));
      const state: RuntimeState =
        l.state === "stopping" || activeState === "deactivating"
          ? "stopping"
          : healthy
            ? "ready"
            : activeState === "failed"
              ? "failed"
              : holdsGpu
                ? "starting"
                : activeState === "unknown" || activeState === ""
                  ? "unavailable"
                  : "stopped";
      p = { activeState, holdsGpu, healthy, loaded: [], state };
    } else {
      const healthy = await httpOk(deps, spec.healthUrl);
      const loadedAll = healthy ? ((await ollamaLoaded(deps, spec.baseUrl)) ?? []) : [];
      const loaded = loadedAll
        .filter((m) => modelMatches(spec.models, m.name))
        .map((m) => ({ name: m.name, vramMb: m.sizeVramMb }));
      const holdsGpu = loaded.some((m) => m.vramMb > 0);
      p = {
        healthy,
        holdsGpu,
        loaded,
        state: !healthy ? "unavailable" : l.state === "stopping" ? "stopping" : "ready",
      };
    }
    l.healthy = p.healthy;
    l.holdsGpu = p.holdsGpu;
    l.loaded = p.loaded;
    l.activeState = p.activeState;
    if (l.state !== "starting" || p.state === "ready" || p.state === "failed") l.state = p.state;
    if (p.state === "ready" && l.readySince === undefined) l.readySince = this.opts.deps.now();
    if (p.state !== "ready") l.readySince = undefined;
    return p;
  }

  private async isReady(spec: LocalRuntimeSpec, model?: string): Promise<boolean> {
    const l = this.liveOf(spec.id);
    if (l.state === "stopping") return false;
    const p = await this.probe(spec);
    if (spec.kind === "systemd") return p.healthy;
    if (!p.healthy) return false;
    if (model && p.loaded.some((m) => modelMatches([model], m.name))) return true;
    // Not loaded yet: fine to let Ollama load on demand unless another runtime holds the GPU.
    const others = this.specs().filter((s) => s.id !== spec.id);
    const probes = await Promise.all(others.map((s) => this.probe(s)));
    return !probes.some((o) => o.holdsGpu);
  }

  // ── acquire / lease ──────────────────────────────────────────────────

  /**
   * Make `runtimeId` ready (swapping the GPU if needed) and hold a lease on
   * it until `release()`. Throws LocalRuntimeError when it can't start.
   */
  async acquire(runtimeId: string, options: AcquireOptions = {}): Promise<Lease> {
    const spec = this.spec(runtimeId);
    if (!spec) throw new LocalRuntimeError(`Unknown local runtime "${runtimeId}"`, { runtimeId });
    const policy = this.opts.getPolicy();
    const priority = options.priority ?? "interactive";
    const { deps } = this.opts;
    const waitStarted = deps.now();
    let swapped = false;
    let announcedWait = false;

    for (;;) {
      const cur = this.current;
      if (cur) {
        if (cur.target === runtimeId) {
          // Batch onto the swap that's already bringing this runtime up.
          await this.follow(cur, options.onProgress);
          return this.lease(spec, priority, true);
        }
        if (priority === "background" && policy.backgroundPriority === "interactive-first") {
          await this.waitBackground(spec, options, waitStarted, announcedWait);
          announcedWait = true;
          continue;
        }
        await cur.promise.catch(() => undefined);
        continue;
      }
      if (
        priority === "background" &&
        policy.backgroundPriority === "interactive-first" &&
        this.liveOf(runtimeId).interactive > 0
      ) {
        // Chat is using this very runtime: pause background work until it's idle.
        await this.waitBackground(spec, options, waitStarted, announcedWait, "paused");
        announcedWait = true;
        continue;
      }
      if (await this.isReady(spec, options.model)) {
        if (this.current && this.current.target !== runtimeId) continue;
        if (
          priority === "background" &&
          policy.backgroundPriority === "interactive-first" &&
          this.liveOf(runtimeId).interactive > 0
        ) {
          continue;
        }
        return this.lease(spec, priority, swapped);
      }
      if (this.current) continue;
      if (
        priority === "background" &&
        policy.backgroundPriority === "interactive-first" &&
        this.gpuBusyElsewhere(runtimeId, policy)
      ) {
        await this.waitBackground(spec, options, waitStarted, announcedWait);
        announcedWait = true;
        continue;
      }
      const op = this.beginSwap(spec, options.model, options.reason ?? priority);
      await this.follow(op, options.onProgress);
      swapped = true;
      return this.lease(spec, priority, swapped);
    }
  }

  /**
   * Run an interactive (chat) turn on `runtimeId`: makes it ready, and while
   * `fn` runs, background leases on the same runtime wait (OCR/vision pause).
   */
  withInteractive<T>(
    runtimeId: string,
    fn: () => Promise<T>,
    options: Omit<AcquireOptions, "priority"> = {},
  ): Promise<T> {
    return this.withRuntime(runtimeId, { ...options, priority: "interactive" }, fn);
  }

  /** True while an interactive turn holds `runtimeId`. */
  isInteractiveBusy(runtimeId: string): boolean {
    return this.liveOf(runtimeId).interactive > 0;
  }

  /**
   * `busy` when the first interactive lease on a runtime starts, `idle` when
   * the last one ends — background queues pause/resume on these.
   */
  onInteractive(listener: (e: InteractiveEvent) => void): () => void {
    this.interactiveListeners.add(listener);
    return () => this.interactiveListeners.delete(listener);
  }

  /** Resolves once no interactive turn holds `runtimeId` (or after timeoutMs; returns false then). */
  async waitForInteractiveIdle(runtimeId: string, timeoutMs = 30 * 60_000): Promise<boolean> {
    const start = this.opts.deps.now();
    while (this.liveOf(runtimeId).interactive > 0) {
      const left = timeoutMs - (this.opts.deps.now() - start);
      if (left <= 0) return false;
      await this.waitForChange(Math.min(5000, left));
    }
    return true;
  }

  private emitInteractive(e: InteractiveEvent): void {
    for (const fn of this.interactiveListeners) {
      try {
        fn(e);
      } catch {
        // listener errors never affect leases
      }
    }
  }

  /** Run `fn` while holding a lease on the runtime. */
  async withRuntime<T>(
    runtimeId: string,
    options: AcquireOptions,
    fn: () => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquire(runtimeId, options);
    try {
      return await fn();
    } finally {
      lease.release();
    }
  }

  private lease(spec: LocalRuntimeSpec, priority: Priority, swapped: boolean): Lease {
    const l = this.liveOf(spec.id);
    const now = this.opts.deps.now();
    l.inflight += 1;
    l.lastUsedAt = now;
    if (priority === "interactive") {
      l.lastInteractiveAt = now;
      l.interactive += 1;
      if (l.interactive === 1) this.emitInteractive({ runtimeId: spec.id, state: "busy", at: now });
    }
    let released = false;
    return {
      runtimeId: spec.id,
      swapped,
      release: () => {
        if (released) return;
        released = true;
        l.inflight = Math.max(0, l.inflight - 1);
        l.lastUsedAt = this.opts.deps.now();
        if (priority === "interactive") {
          l.lastInteractiveAt = l.lastUsedAt;
          l.interactive = Math.max(0, l.interactive - 1);
          if (l.interactive === 0) {
            this.emitInteractive({ runtimeId: spec.id, state: "idle", at: l.lastUsedAt });
          }
        }
        this.notifyChange();
      },
    };
  }

  private async follow(op: SwapOp, onProgress?: (p: SwapProgress) => void): Promise<void> {
    if (onProgress) {
      op.subscribers.add(onProgress);
      onProgress({ ...op.progress });
    }
    try {
      await op.promise;
    } finally {
      if (onProgress) op.subscribers.delete(onProgress);
    }
  }

  /** Chat is using another runtime (in flight, or recently) — background work must not evict it. */
  private gpuBusyElsewhere(runtimeId: string, policy: ManagerPolicy): boolean {
    const now = this.opts.deps.now();
    for (const s of this.specs()) {
      if (s.id === runtimeId) continue;
      const l = this.liveOf(s.id);
      if (l.inflight > 0) return true;
      if (
        l.holdsGpu &&
        l.lastInteractiveAt &&
        now - l.lastInteractiveAt < policy.backgroundSwapIdleMs
      ) {
        return true;
      }
    }
    return false;
  }

  private async waitBackground(
    spec: LocalRuntimeSpec,
    options: AcquireOptions,
    waitStarted: number,
    announced: boolean,
    why: "elsewhere" | "paused" = "elsewhere",
  ): Promise<void> {
    const policy = this.opts.getPolicy();
    const { deps } = this.opts;
    const waited = deps.now() - waitStarted;
    if (waited >= policy.backgroundWaitTimeoutMs) {
      throw new LocalRuntimeError(
        `${spec.label} is waiting for the GPU (in use by chat) — gave up after ${Math.round(waited / 1000)} s`,
        { runtimeId: spec.id },
      );
    }
    if (!announced) {
      const p: SwapProgress = {
        runtimeId: spec.id,
        label: spec.label,
        model: options.model,
        phase: "waiting",
        message:
          why === "paused"
            ? `Paused — chat is using ${spec.label}`
            : `Waiting for the GPU — chat is using another local model`,
        startedAt: waitStarted,
        elapsedSec: 0,
        etaSec: 0,
      };
      options.onProgress?.(p);
      this.log(
        "info",
        `background ${options.reason ?? "job"} ${why === "paused" ? `paused: interactive turn on ${spec.id}` : `queued for ${spec.id}: GPU busy elsewhere`}`,
      );
    }
    await this.waitForChange(Math.min(5000, policy.backgroundWaitTimeoutMs - waited));
  }

  private notifyChange(): void {
    const waiters = this.changeWaiters;
    this.changeWaiters = [];
    for (const w of waiters) w();
  }

  private waitForChange(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      this.changeWaiters.push(finish);
      void this.opts.deps.sleep(ms).then(finish);
    });
  }

  // ── swapping ──────────────────────────────────────────────────────────

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private beginSwap(spec: LocalRuntimeSpec, model: string | undefined, reason: string): SwapOp {
    const now = this.opts.deps.now();
    const op: SwapOp = {
      target: spec.id,
      model,
      subscribers: new Set(),
      progress: {
        runtimeId: spec.id,
        label: spec.label,
        model,
        phase: spec.kind === "systemd" ? "starting" : "loading",
        message:
          spec.kind === "systemd"
            ? `Starting ${spec.label}… (≈${spec.etaSec} s)`
            : `Switching GPU to ${spec.label}…`,
        startedAt: now,
        elapsedSec: 0,
        etaSec: spec.etaSec,
      },
      promise: Promise.resolve(),
    };
    this.current = op;
    op.promise = this.exclusive(() => this.doSwap(op, spec, model, reason)).finally(() => {
      if (this.current === op) this.current = null;
      this.notifyChange();
      this.opts.onStatus?.({ swap: null, reason: "swap-end" });
    });
    return op;
  }

  private setProgress(op: SwapOp, patch: Partial<SwapProgress>): void {
    const now = this.opts.deps.now();
    op.progress = {
      ...op.progress,
      ...patch,
      elapsedSec: Math.round((now - op.progress.startedAt) / 1000),
    };
    const snap = { ...op.progress };
    for (const s of op.subscribers) {
      try {
        s(snap);
      } catch {
        // a broken listener must not break the swap
      }
    }
    this.opts.onStatus?.({ swap: snap, reason: "progress" });
  }

  private vramNeed(spec: LocalRuntimeSpec, model?: string, gpu?: GpuInfo | null): number {
    if (spec.vramFraction && gpu) return Math.ceil(spec.vramFraction * gpu.totalMb);
    if (spec.kind === "ollama" && model) {
      const exact = spec.modelVramMb[model] ?? spec.modelVramMb[model.replace(/:latest$/, "")];
      if (exact !== undefined) return exact;
    }
    return spec.vramMb;
  }

  private async doSwap(
    op: SwapOp,
    spec: LocalRuntimeSpec,
    model: string | undefined,
    reason: string,
  ) {
    const { deps } = this.opts;
    const policy = this.opts.getPolicy();
    const t0 = deps.now();
    const others = this.specs().filter((s) => s.id !== spec.id);
    const probes = await Promise.all(others.map((s) => this.probe(s)));
    const holders = others
      .map((s, i) => ({ spec: s, probe: probes[i]! }))
      .filter((h) => h.probe.holdsGpu);
    const from = holders[0]?.spec;
    if (from) this.setProgress(op, { fromRuntimeId: from.id, fromLabel: from.label });
    const evicted: typeof holders = [];

    try {
      // a. drain in-flight requests on the runtimes we're about to evict
      const busy = () => holders.reduce((n, h) => n + this.liveOf(h.spec.id).inflight, 0);
      if (holders.length && busy() > 0) {
        const drainStart = deps.now();
        while (busy() > 0 && deps.now() - drainStart < policy.drainTimeoutMs) {
          this.setProgress(op, {
            phase: "draining",
            message: `Waiting for ${busy()} request(s) on ${from!.label} to finish…`,
          });
          await this.waitForChange(Math.min(this.pollMs, policy.drainTimeoutMs));
        }
        if (busy() > 0) {
          this.record({
            kind: "drain-timeout",
            runtimeId: spec.id,
            from: from?.id,
            message: `drain timeout after ${Math.round(policy.drainTimeoutMs / 1000)} s with ${busy()} request(s) in flight on ${from?.id}; swapping anyway`,
          });
        }
      }

      // b. free VRAM from the other registry runtimes (never anything else)
      let gpu = await gpuInfo(deps, policy.gpuIndex);
      const need = this.vramNeed(spec, model, gpu) + policy.reservedVramMb;
      // Ollama schedules its own models (evicts / offloads), so only a systemd
      // runtime gets the hard VRAM gate; for Ollama a shortfall is just logged.
      const hardGate = spec.kind === "systemd";
      if (hardGate && gpu && gpu.freeMb < need) {
        // Would evicting every registry runtime even be enough? If not, refuse
        // now instead of unloading the current runtime for nothing.
        const reclaimable = holders.reduce(
          (n, h) =>
            n +
            (h.spec.kind === "ollama"
              ? // size_vram excludes llama-server's compute buffers (~+20% measured).
                Math.round(h.probe.loaded.reduce((a, x) => a + x.vramMb, 0) * 1.25)
              : this.vramNeed(h.spec, undefined, gpu)),
          0,
        );
        if (gpu.freeMb + reclaimable < need) {
          throw new Error(
            `not enough VRAM: ${gpu.freeMb} MiB free + ${reclaimable} MiB from ${holders.map((h) => h.spec.id).join(", ") || "no registry runtime"} < ~${need} MiB needed (other GPU processes are left alone)`,
          );
        }
      }
      if (holders.length && (!gpu || gpu.freeMb < need)) {
        this.setProgress(op, {
          phase: "freeing",
          message: `Switching GPU to ${spec.label}…`,
        });
        for (const h of holders) {
          await this.stopRuntime(h.spec, `swap→${spec.id}`);
          evicted.push(h);
        }
        if (gpu) gpu = await this.waitForFreeVram(need, 60_000);
      }
      if (gpu && gpu.freeMb < need && !hardGate) {
        this.log(
          "warn",
          `${spec.id}: ${gpu.freeMb} MiB free < ~${need} MiB; letting Ollama place the model`,
        );
      } else if (gpu && gpu.freeMb < need) {
        throw new Error(
          `not enough free VRAM: ${gpu.freeMb} MiB free, needs ~${need} MiB (other GPU processes are left alone)`,
        );
      }

      // c/d. start + wait for health
      await this.startRuntime(op, spec, model);
      const durationMs = deps.now() - t0;
      this.record({
        kind: evicted.length ? "swap" : "start",
        runtimeId: spec.id,
        from: evicted[0]?.spec.id,
        model,
        reason,
        durationMs,
        message: evicted.length
          ? `swapped GPU ${evicted.map((h) => h.spec.id).join("+")} → ${spec.id} in ${(durationMs / 1000).toFixed(1)} s`
          : `started ${spec.id} in ${(durationMs / 1000).toFixed(1)} s`,
      });
      this.setProgress(op, { phase: "ready", message: `${spec.label} is ready` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const l = this.liveOf(spec.id);
      l.state = "failed";
      l.error = msg;
      this.record({
        kind: "failed",
        runtimeId: spec.id,
        from: from?.id,
        model,
        reason,
        durationMs: deps.now() - t0,
        message: `start of ${spec.id} failed: ${msg}`,
      });
      if (spec.kind === "systemd") {
        // Don't leave a half-started server squatting on VRAM.
        await this.stopRuntime(spec, "failed-start").catch(() => undefined);
        l.state = "failed";
      }
      let restoredTo: string | undefined;
      for (const h of evicted) {
        try {
          await this.restore(h.spec, h.probe);
          restoredTo ??= h.spec.label;
        } catch (e) {
          this.log("warn", `restore of ${h.spec.id} failed: ${String(e)}`);
        }
      }
      const text = `Couldn't start ${spec.label}: ${msg}.${restoredTo ? ` Back on ${restoredTo}.` : ""}`;
      this.setProgress(op, { phase: "failed", message: text, error: msg });
      throw new LocalRuntimeError(text, { runtimeId: spec.id, restoredTo, cause: err });
    }
  }

  private async waitForFreeVram(needMb: number, timeoutMs: number): Promise<GpuInfo | null> {
    const { deps } = this.opts;
    const policy = this.opts.getPolicy();
    const start = deps.now();
    let gpu = await gpuInfo(deps, policy.gpuIndex);
    let best = gpu?.freeMb ?? 0;
    let flat = 0;
    while (gpu && gpu.freeMb < needMb && deps.now() - start < timeoutMs) {
      await deps.sleep(1000);
      gpu = await gpuInfo(deps, policy.gpuIndex);
      if (!gpu) break;
      // Memory still draining from the stopped runtime? Give up once it plateaus.
      if (gpu.freeMb > best + 64) {
        best = gpu.freeMb;
        flat = 0;
      } else if (++flat >= 8) {
        break;
      }
    }
    return gpu;
  }

  private async startRuntime(op: SwapOp, spec: LocalRuntimeSpec, model?: string): Promise<void> {
    const { deps } = this.opts;
    const l = this.liveOf(spec.id);
    l.error = undefined;
    l.state = "starting";
    if (spec.kind === "systemd") {
      this.setProgress(op, {
        phase: "starting",
        message: `Starting ${spec.label}… (≈${spec.etaSec} s)`,
      });
      const r = await systemdStart(deps, spec.unit!);
      if (r.code !== 0)
        throw new Error(`systemctl start ${spec.unit} failed: ${r.stderr.trim() || r.code}`);
      const started = deps.now();
      for (;;) {
        if (await httpOk(deps, spec.healthUrl)) break;
        const state = await systemdActiveState(deps, spec.unit!);
        const crashLoop =
          state === "activating" && (await systemdSubState(deps, spec.unit!)) === "auto-restart";
        if (state === "failed" || state === "inactive" || crashLoop) {
          const why = await systemdLastError(deps, spec.unit!);
          throw new Error(
            `${spec.unit} ${crashLoop ? "is crash-looping" : `exited (${state})`}${why ? ` — ${why}` : ""}`,
          );
        }
        const elapsed = deps.now() - started;
        if (elapsed > spec.startupTimeoutSec * 1000) {
          throw new Error(
            `no health response from ${spec.healthUrl} after ${spec.startupTimeoutSec} s`,
          );
        }
        const left = Math.max(0, spec.etaSec - Math.round(elapsed / 1000));
        this.setProgress(op, {
          phase: "starting",
          message: `Starting ${spec.label}… (${left > 0 ? `≈${left} s left` : "almost ready"})`,
        });
        await deps.sleep(this.pollMs);
      }
    } else {
      if (!(await httpOk(deps, spec.healthUrl))) {
        throw new Error(`Ollama isn't answering at ${spec.baseUrl}`);
      }
      const loadModel = model ?? this.defaultOllamaModel(spec);
      if (loadModel) {
        this.setProgress(op, {
          phase: "loading",
          message: `Loading ${loadModel.replace(/:latest$/, "")} on Ollama… (≈${spec.etaSec} s)`,
        });
        await ollamaLoad(deps, spec.baseUrl, loadModel, {
          keepAlive: spec.keepAlive,
          timeoutMs: spec.startupTimeoutSec * 1000,
        });
      }
    }
    l.state = "ready";
    l.healthy = true;
    l.holdsGpu = true;
    l.readySince = deps.now();
    l.lastUsedAt = deps.now();
  }

  private defaultOllamaModel(spec: LocalRuntimeSpec): string | undefined {
    return spec.models.find((m) => m !== "*") ?? spec.visionModels[0];
  }

  private async stopRuntime(spec: LocalRuntimeSpec, reason: string): Promise<void> {
    const { deps } = this.opts;
    const l = this.liveOf(spec.id);
    l.state = "stopping";
    try {
      if (spec.kind === "systemd") {
        const r = await systemdStop(deps, spec.unit!);
        if (r.code !== 0) throw new Error(`systemctl stop ${spec.unit} failed: ${r.stderr.trim()}`);
      } else {
        const loaded = (await ollamaLoaded(deps, spec.baseUrl)) ?? [];
        for (const m of loaded) {
          if (!modelMatches(spec.models, m.name)) continue; // only registry models
          await ollamaUnload(deps, spec.baseUrl, m.name);
        }
      }
      l.state = spec.kind === "systemd" ? "stopped" : "ready";
      l.holdsGpu = false;
      l.loaded = [];
      l.readySince = spec.kind === "systemd" ? undefined : l.readySince;
      l.healthy = spec.kind === "systemd" ? false : l.healthy;
      if (reason !== "failed-start") {
        this.record({
          kind: reason === "idle" ? "idle-stop" : "stop",
          runtimeId: spec.id,
          reason,
          message: `stopped ${spec.id} (${reason})`,
        });
      }
    } catch (err) {
      l.state = "failed";
      l.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.notifyChange();
    }
  }

  private async restore(spec: LocalRuntimeSpec, before: Probe): Promise<void> {
    const { deps } = this.opts;
    const t0 = deps.now();
    if (spec.kind === "systemd") {
      if (!before.holdsGpu) return;
      const r = await systemdStart(deps, spec.unit!);
      if (r.code !== 0) throw new Error(r.stderr);
      while (!(await httpOk(deps, spec.healthUrl))) {
        if (deps.now() - t0 > spec.startupTimeoutSec * 1000)
          throw new Error("restore health timeout");
        const st = await systemdActiveState(deps, spec.unit!);
        if (st === "failed" || st === "inactive") throw new Error(`${spec.unit} ${st}`);
        await deps.sleep(this.pollMs);
      }
    } else {
      for (const m of before.loaded) {
        await ollamaLoad(deps, spec.baseUrl, m.name, {
          keepAlive: spec.keepAlive,
          timeoutMs: spec.startupTimeoutSec * 1000,
        });
      }
    }
    const l = this.liveOf(spec.id);
    l.state = "ready";
    l.healthy = true;
    l.holdsGpu = true;
    l.readySince = deps.now();
    this.record({
      kind: "restore",
      runtimeId: spec.id,
      durationMs: deps.now() - t0,
      message: `restored ${spec.id} after failed swap`,
    });
  }

  // ── manual control ───────────────────────────────────────────────────

  /** Start (swapping the GPU) and immediately release — owner's Start button. */
  async start(runtimeId: string, onProgress?: (p: SwapProgress) => void): Promise<void> {
    const lease = await this.acquire(runtimeId, {
      priority: "interactive",
      reason: "manual",
      onProgress,
    });
    lease.release();
  }

  /** Owner's Stop button / idle policy. Waits for in-flight requests (drain timeout). */
  async stop(runtimeId: string, reason = "manual"): Promise<void> {
    const spec = this.spec(runtimeId);
    if (!spec) throw new LocalRuntimeError(`Unknown local runtime "${runtimeId}"`, { runtimeId });
    if (this.current) await this.current.promise.catch(() => undefined);
    await this.exclusive(async () => {
      const policy = this.opts.getPolicy();
      const l = this.liveOf(spec.id);
      const start = this.opts.deps.now();
      while (l.inflight > 0 && this.opts.deps.now() - start < policy.drainTimeoutMs) {
        await this.waitForChange(Math.min(this.pollMs, policy.drainTimeoutMs));
      }
      await this.stopRuntime(spec, reason);
    });
    this.opts.onStatus?.({ swap: null, reason: "stop" });
  }

  // ── idle policy ──────────────────────────────────────────────────────

  /** Stop runtimes idle longer than their idleStopMinutes. Returns ids stopped. */
  async idleSweep(): Promise<string[]> {
    if (this.current) return [];
    const now = this.opts.deps.now();
    const stopped: string[] = [];
    for (const spec of this.specs()) {
      if (spec.kind !== "systemd" || spec.idleStopMinutes <= 0) continue;
      const l = this.liveOf(spec.id);
      const p = await this.probe(spec);
      if (!p.healthy || l.inflight > 0) continue;
      const since = Math.max(l.lastUsedAt ?? 0, l.readySince ?? now);
      if (now - since < spec.idleStopMinutes * 60_000) continue;
      this.log("info", `idle stop ${spec.id} after ${Math.round((now - since) / 60_000)} min`);
      try {
        await this.stop(spec.id, "idle");
        stopped.push(spec.id);
      } catch (err) {
        this.log("warn", `idle stop of ${spec.id} failed: ${String(err)}`);
      }
    }
    return stopped;
  }

  startIdleTimer(intervalMs = 60_000): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      void this.idleSweep().catch(() => undefined);
    }, intervalMs);
    this.idleTimer.unref?.();
  }

  dispose(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  // ── status / log ─────────────────────────────────────────────────────

  currentSwap(): SwapProgress | null {
    return this.current ? { ...this.current.progress } : null;
  }

  async status(): Promise<ManagerStatus> {
    const specs = this.specs();
    const policy = this.opts.getPolicy();
    await Promise.all(specs.map((s) => this.probe(s).catch(() => undefined)));
    const gpu = await gpuInfo(this.opts.deps, policy.gpuIndex).catch(() => null);
    return {
      enabled: policy.enabled,
      gpu,
      swap: this.currentSwap(),
      log: [...this.ring].reverse().slice(0, 20),
      runtimes: specs.map((s) => {
        const l = this.liveOf(s.id);
        const since = Math.max(l.lastUsedAt ?? 0, l.readySince ?? 0);
        return {
          id: s.id,
          label: s.label,
          kind: s.kind,
          unit: s.unit,
          baseUrl: s.baseUrl,
          providers: s.providers,
          state: this.current?.target === s.id ? "starting" : l.state,
          activeState: l.activeState,
          healthy: l.healthy,
          holdsGpu: l.holdsGpu,
          loadedModels: l.loaded,
          inflight: l.inflight,
          lastUsedAt: l.lastUsedAt,
          readySince: l.readySince,
          idleStopMinutes: s.idleStopMinutes,
          idleStopAt:
            s.kind === "systemd" && s.idleStopMinutes > 0 && l.healthy && since
              ? since + s.idleStopMinutes * 60_000
              : undefined,
          vramMb: s.vramMb,
          etaSec: s.etaSec,
          error: l.error,
        };
      }),
    };
  }

  recentLog(): SwapLogEntry[] {
    return [...this.ring];
  }

  private record(e: Omit<SwapLogEntry, "at">): void {
    const entry: SwapLogEntry = { at: this.opts.deps.now(), ...e };
    this.ring.push(entry);
    if (this.ring.length > LOG_RING) this.ring.shift();
    this.log(e.kind === "failed" || e.kind === "drain-timeout" ? "warn" : "info", e.message, {
      runtime: e.runtimeId,
      from: e.from,
      durationMs: e.durationMs,
    });
    try {
      this.opts.appendLog?.(entry);
    } catch {
      // log file is best effort
    }
    this.opts.onStatus?.({ swap: this.currentSwap(), reason: e.kind });
  }

  private log(level: "info" | "warn", message: string, meta?: Record<string, unknown>): void {
    this.opts.log?.(level, message, meta);
  }
}
