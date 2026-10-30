export type SchedulerHandle = {
  pause(): void;
  resume(): void;
  cancel(): void;
  isRunning(): boolean;
  isCancelled(): boolean;
};

export type RafLoopCallback = (now: number) => void;

export type ManagedIntervalOptions = {
  /**
   * When provided, hidden tabs keep a low-frequency interval instead of fully
   * stopping. Omit this for decorative work that must go completely quiet.
   */
  hiddenMs?: number;
  /** Run once immediately when the interval starts or resumes. */
  immediate?: boolean;
};

const canUseDocument = typeof document !== "undefined";
const canUseWindow = typeof window !== "undefined";

const raf = (cb: FrameRequestCallback): number =>
  typeof requestAnimationFrame !== "undefined"
    ? requestAnimationFrame(cb)
    : (setTimeout(() => cb(now()), 16) as unknown as number);

const caf = (handle: number): void => {
  if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(handle);
  else clearTimeout(handle);
};

const now = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

class VisibilityRegistry {
  private handles = new Set<{ onVisibilityChange(): void }>();
  private listening = false;

  get visible(): boolean {
    return !canUseDocument || !document.hidden;
  }

  add(handle: { onVisibilityChange(): void }): void {
    this.handles.add(handle);
    this.ensureListening();
  }

  delete(handle: { onVisibilityChange(): void }): void {
    this.handles.delete(handle);
    if (this.handles.size === 0) this.stopListening();
  }

  private ensureListening(): void {
    if (this.listening || !canUseDocument) return;
    this.listening = true;
    document.addEventListener("visibilitychange", this.handleVisibility, { passive: true });
  }

  private stopListening(): void {
    if (!this.listening || !canUseDocument) return;
    this.listening = false;
    document.removeEventListener("visibilitychange", this.handleVisibility);
  }

  private readonly handleVisibility = (): void => {
    for (const handle of [...this.handles]) handle.onVisibilityChange();
  };
}

const registry = new VisibilityRegistry();

export function isDocumentVisible(): boolean {
  return registry.visible;
}

export function rafLoop(cb: RafLoopCallback): SchedulerHandle {
  let handle: number | null = null;
  let running = true;
  let cancelled = false;

  const stopFrame = () => {
    if (handle != null) {
      caf(handle);
      handle = null;
    }
  };

  const schedule = () => {
    if (cancelled || !running || !registry.visible || handle != null) return;
    handle = raf(tick);
  };

  const tick = (t: number) => {
    handle = null;
    if (cancelled || !running || !registry.visible) return;
    cb(t);
    schedule();
  };

  const controller = {
    onVisibilityChange() {
      if (!registry.visible) stopFrame();
      else schedule();
    },
  };

  registry.add(controller);
  schedule();

  return {
    pause() {
      running = false;
      stopFrame();
    },
    resume() {
      if (cancelled) return;
      running = true;
      schedule();
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      running = false;
      stopFrame();
      registry.delete(controller);
    },
    isRunning: () => running && !cancelled && registry.visible && handle != null,
    isCancelled: () => cancelled,
  };
}

export function managedInterval(
  cb: () => void,
  ms: number,
  options: ManagedIntervalOptions = {},
): SchedulerHandle {
  const visibleMs = Math.max(1, ms);
  const hiddenMs = options.hiddenMs == null ? null : Math.max(visibleMs, options.hiddenMs);
  let intervalHandle: number | null = null;
  let running = true;
  let cancelled = false;
  let currentMs: number | null = null;

  const clear = () => {
    if (intervalHandle != null) {
      clearInterval(intervalHandle);
      intervalHandle = null;
      currentMs = null;
    }
  };

  const targetMs = (): number | null => {
    if (!running || cancelled) return null;
    if (registry.visible) return visibleMs;
    return hiddenMs;
  };

  const start = (runImmediate: boolean) => {
    const nextMs = targetMs();
    if (nextMs == null) {
      clear();
      return;
    }
    if (intervalHandle != null && currentMs === nextMs) return;
    clear();
    currentMs = nextMs;
    if (runImmediate) cb();
    if (canUseWindow) intervalHandle = window.setInterval(cb, nextMs);
    else intervalHandle = setInterval(cb, nextMs) as unknown as number;
  };

  const controller = {
    onVisibilityChange() {
      start(false);
    },
  };

  registry.add(controller);
  start(options.immediate ?? false);

  return {
    pause() {
      running = false;
      clear();
    },
    resume() {
      if (cancelled) return;
      running = true;
      start(options.immediate ?? false);
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      running = false;
      clear();
      registry.delete(controller);
    },
    isRunning: () => running && !cancelled && intervalHandle != null,
    isCancelled: () => cancelled,
  };
}
