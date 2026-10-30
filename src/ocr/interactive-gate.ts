/**
 * Interactive-first GPU sharing for the local OCR / video-analysis queues.
 *
 * While an interactive agent turn runs on a local model (Ollama / vLLM on this
 * machine, or any Secure Mode turn), background OCR, video extraction and
 * queued analyses pause so the chat model gets the GPU. Jobs the turn itself
 * asks for (an agent tool's analyze/ask, chat attachments) keep running.
 *
 * Holds auto-expire (default 30 min) so a leaked hold can never stall the
 * queue forever.
 *
 * The GPU runtime manager (src/local-runtimes) is a second source: while it
 * reports an interactive lease on the OCR endpoint's runtime
 * (onLocalRuntimeInteractive busy/idle), background work pauses too — wired
 * in ocr/runtime.ts via setExternalInteractiveSource. The local holds cover
 * turns the manager doesn't track (manager off, model outside its registry).
 */

export type InteractiveHoldInfo = {
  runId: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
};

type Hold = InteractiveHoldInfo & { since: number; timer: NodeJS.Timeout };

const DEFAULT_MAX_HOLD_MS = 30 * 60_000;

const holds = new Map<string, Hold>();
let waiters: Array<() => void> = [];
const listeners = new Set<(paused: boolean) => void>();
let seq = 0;

function notify(paused: boolean) {
  for (const l of Array.from(listeners)) {
    try {
      l(paused);
    } catch {
      /* listener errors never break the gate */
    }
  }
}

type ExternalSource = {
  isBusy: () => boolean;
  /** Call `onChange` on busy/idle transitions; returns an unsubscribe. */
  subscribe: (onChange: () => void) => () => void;
};

let external: ExternalSource | null = null;
let unsubscribeExternal: (() => void) | null = null;
let lastPaused = false;

function externalBusy(): boolean {
  try {
    return external?.isBusy() ?? false;
  } catch {
    return false;
  }
}

/** Re-evaluate after any change: resume waiters + notify on transitions. */
function recompute() {
  const paused = backgroundPaused();
  if (!paused && waiters.length) {
    const ws = waiters;
    waiters = [];
    for (const w of ws) w();
  }
  if (paused !== lastPaused) {
    lastPaused = paused;
    notify(paused);
  }
}

/**
 * Plug in another "interactive turn is running" signal (the GPU runtime
 * manager). Pass null to detach.
 */
export function setExternalInteractiveSource(src: ExternalSource | null) {
  unsubscribeExternal?.();
  unsubscribeExternal = null;
  external = src;
  if (src) {
    try {
      unsubscribeExternal = src.subscribe(recompute);
    } catch {
      unsubscribeExternal = null;
    }
  }
  recompute();
}

/**
 * Mark an interactive local-model turn as running. Returns `release`, which is
 * idempotent. Background work resumes when the last hold is released (and the
 * runtime manager reports no interactive lease).
 */
export function beginInteractiveTurn(
  info: InteractiveHoldInfo,
  opts: { maxHoldMs?: number } = {},
): () => void {
  const key = `${info.runId}#${++seq}`;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const h = holds.get(key);
    if (h) clearTimeout(h.timer);
    holds.delete(key);
    recompute();
  };
  const timer = setTimeout(release, Math.max(1_000, opts.maxHoldMs ?? DEFAULT_MAX_HOLD_MS));
  timer.unref?.();
  holds.set(key, { ...info, since: Date.now(), timer });
  recompute();
  return release;
}

/** True while an interactive local-model turn holds the GPU. */
export function backgroundPaused(): boolean {
  return holds.size > 0 || externalBusy();
}

/** Resolve once no interactive turn holds the GPU (immediately when none does). */
export function waitForBackgroundSlot(): Promise<void> {
  if (!backgroundPaused()) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(poll);
      resolve();
    };
    waiters.push(finish);
    // Safety net for a missed external idle event.
    const poll = setInterval(() => {
      if (!backgroundPaused()) finish();
    }, 5_000);
    poll.unref?.();
  });
}

/** Subscribe to pause/resume transitions. Returns an unsubscribe function. */
export function onBackgroundPauseChange(fn: (paused: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function interactiveGateStatus(): {
  paused: boolean;
  runtimeManagerBusy: boolean;
  holds: Array<{ runId: string; provider?: string; model?: string; sinceMs: number }>;
} {
  const now = Date.now();
  return {
    paused: backgroundPaused(),
    runtimeManagerBusy: externalBusy(),
    holds: [...holds.values()].map((h) => ({
      runId: h.runId,
      provider: h.provider,
      model: h.model,
      sinceMs: now - h.since,
    })),
  };
}

/** Tests: drop every hold. */
export function resetInteractiveGateForTests() {
  for (const h of holds.values()) clearTimeout(h.timer);
  holds.clear();
  unsubscribeExternal?.();
  unsubscribeExternal = null;
  external = null;
  lastPaused = false;
  const ws = waiters;
  waiters = [];
  for (const w of ws) w();
  listeners.clear();
}
