/**
 * "The workspace went to sleep" — client side of activity-based idle sleep
 * (hosted cloud, wake-mode plans; docs/saas/STARTER_MARGINS.md).
 *
 * A Starter Machine suspends after N minutes without real activity, even with
 * this tab open: its gateway announces `fleet.sleep` and closes the socket with
 * code 4010. Before this module the app simply reconnected, which started the
 * Machine again within seconds — so a forgotten tab kept it running 24/7.
 *
 * Rules
 *   - Close code 4010 (or the `fleet.sleep` event): sleeping. No reconnect.
 *   - Any other close while nobody is using this tab (hidden, or no pointer /
 *     key input for 90 s) on a wake-mode plan: also sleeping. That covers a
 *     Machine suspended by Fly or by the orchestrator's reaper, and an older
 *     gateway image that does not announce. A close while the member IS using
 *     the tab reconnects as before.
 *   - While sleeping nothing here touches the gateway: no socket, no fetch, no
 *     EventSource. Any of them would wake the Machine through Fly's proxy.
 *   - The next click or key press wakes it: `requestWake()` runs the wake
 *     handler (resolve through the orchestrator, which starts the Machine) and
 *     only then lets the parked sockets reconnect. One wake per interaction;
 *     a failed wake goes back to sleeping and waits for the next one.
 *   - While awake, real input is reported to the gateway (`fleet.activity`, at
 *     most once a minute). That — not the open socket, not background refreshes
 *     — is what holds off idle sleep.
 *
 * Local / self-hosted builds and always-on plans never enter this state.
 */

/** Must match FLEET_SLEEP_CLOSE_CODE in src/saas/fleet-idle.ts. */
export const FLEET_SLEEP_CLOSE_CODE = 4010;
/** gateway.ts closes with this when its own connect handshake failed. */
const CONNECT_FAILED_CLOSE_CODE = 4008;
/** No input for this long = nobody is using the tab. */
export const INACTIVE_AFTER_MS = 90_000;
/** Minimum gap between `fleet.activity` reports. */
export const ACTIVITY_PING_MS = 60_000;

export type SleepPhase = "awake" | "sleeping" | "waking";

export type SleepConfig = {
  /** Only "wake" plans sleep. */
  runMode: "wake" | "always-on";
  idleMinutes?: number;
};

type Env = {
  now: () => number;
  hidden: () => boolean;
};

const defaultEnv: Env = {
  now: () => Date.now(),
  hidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
};

let env: Env = defaultEnv;
let config: SleepConfig | null = null;
let phase: SleepPhase = "awake";
let lastInputAt = 0;
let lastPingAt = 0;
let wakeHandler: (() => Promise<boolean>) | null = null;
let pinger: (() => void) | null = null;
const listeners = new Set<(phase: SleepPhase) => void>();

/** Called once the orchestrator resolved the tenant gateway (and again on each wake). */
export function configureGatewaySleep(next: SleepConfig | null): void {
  config = next;
}

export function gatewaySleepConfig(): SleepConfig | null {
  return config;
}

export function sleepPhase(): SleepPhase {
  return phase;
}

/** True while nothing may touch the gateway (asleep, or a wake is in flight). */
export function isGatewaySleeping(): boolean {
  return phase !== "awake";
}

export function onSleepChange(cb: (phase: SleepPhase) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function setPhase(next: SleepPhase): void {
  if (phase === next) return;
  phase = next;
  for (const cb of [...listeners]) {
    try {
      cb(next);
    } catch (err) {
      console.error("[sleep] listener error:", err);
    }
  }
}

function sleeps(): boolean {
  return config?.runMode === "wake";
}

/** The gateway said it is going to sleep (`fleet.sleep` event). */
export function noteSleepAnnounced(): void {
  if (sleeps()) setPhase("sleeping");
}

/**
 * A gateway socket closed. Returns true when the client must NOT reconnect
 * (the workspace is asleep); the caller parks itself until `onSleepChange`
 * reports "awake".
 */
export function noteGatewayClosed(code: number): boolean {
  if (!sleeps()) return false;
  if (phase !== "awake") return true;
  if (code === CONNECT_FAILED_CLOSE_CODE) return false;
  const idle = env.hidden() || env.now() - lastInputAt > INACTIVE_AFTER_MS;
  if (code === FLEET_SLEEP_CLOSE_CODE || idle) {
    setPhase("sleeping");
    return true;
  }
  return false;
}

/** How the wake is done: resolve through the orchestrator. True = the gateway is up. */
export function setWakeHandler(fn: (() => Promise<boolean>) | null): void {
  wakeHandler = fn;
}

/** How real input is reported to the gateway (set by the connected client). */
export function setActivityPinger(fn: (() => void) | null): void {
  pinger = fn;
}

/** Wake the workspace. Safe to call repeatedly: one wake runs at a time. */
export async function requestWake(): Promise<boolean> {
  if (phase !== "sleeping") return phase === "awake";
  setPhase("waking");
  let ok = false;
  try {
    ok = wakeHandler ? await wakeHandler() : true;
  } catch {
    ok = false;
  }
  lastInputAt = env.now();
  lastPingAt = 0; // report this interaction as soon as the socket is back
  setPhase(ok ? "awake" : "sleeping");
  return ok;
}

/**
 * Real user input (pointer / key). `wakes` = this kind of input wakes a
 * sleeping workspace (a click or a key press; scrolling alone does not).
 */
export function noteUserInput(wakes = true): void {
  const now = env.now();
  lastInputAt = now;
  if (phase === "sleeping") {
    if (wakes) void requestWake();
    return;
  }
  if (phase !== "awake" || !sleeps()) return;
  if (now - lastPingAt < ACTIVITY_PING_MS) return;
  lastPingAt = now;
  try {
    pinger?.();
  } catch {
    // not connected: the next input retries
    lastPingAt = 0;
  }
}

/** The socket came back: report the interaction that woke it. */
export function noteGatewayConnected(): void {
  if (!sleeps() || phase !== "awake") return;
  if (env.now() - lastInputAt > INACTIVE_AFTER_MS) return;
  lastPingAt = env.now();
  try {
    pinger?.();
  } catch {
    lastPingAt = 0;
  }
}

let installed = false;

/** Listen for real input on the window. Idempotent; a no-op outside a browser. */
export function installInputTracking(target: Window | undefined = globalThis.window): void {
  if (installed || !target) return;
  installed = true;
  lastInputAt = env.now(); // the page was just opened: that is a person
  const opts = { capture: true, passive: true } as const;
  for (const type of ["pointerdown", "keydown", "touchstart"]) {
    target.addEventListener(type, () => noteUserInput(true), opts);
  }
  // Reading counts as using the app, but does not wake a sleeping one.
  for (const type of ["wheel", "scroll"]) {
    target.addEventListener(type, () => noteUserInput(false), opts);
  }
}

/** Test hook. */
export function resetGatewaySleepForTest(over: Partial<Env> = {}): void {
  env = { ...defaultEnv, ...over };
  config = null;
  phase = "awake";
  lastInputAt = 0;
  lastPingAt = 0;
  wakeHandler = null;
  pinger = null;
  listeners.clear();
  installed = false;
}
