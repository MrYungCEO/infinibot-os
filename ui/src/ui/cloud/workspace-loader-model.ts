/**
 * Workspace loader: pure state → copy mapping (no DOM, no timers, no fetch).
 *
 * The hosted cloud app goes through several real steps between page load and a
 * usable workspace. This module turns the signals the browser can actually
 * observe into a phase, and a phase into what the member reads. The rendering
 * lives in workspace-loader.ts; this file is unit-tested on its own.
 *
 * Signals and where they come from:
 *   auth-start / auth-done   main.ts, around the Clerk gate
 *   resolve-start            fleet-connect.ts, a /fleet/resolve run begins
 *   resolve-pending          fleet-connect.ts, a 409 (cold provision in flight)
 *   resolve-ready            fleet-connect.ts, 200 with a gateway URL
 *   resolve-failed           fleet-connect.ts, 402 / 5xx / network / gave up
 *   signin-required          fleet-connect.ts, 401 after a re-minted token
 *   socket                   the <infinibot-app> element's connected/reconnecting
 *   data-ready               app-gateway.ts, plugins.list answered after hello
 *   gate                     the SaaS onboarding gate's boot screen is up / gone
 *   online                   navigator.onLine
 *   show / hide              the public API (the sleep flow calls these)
 *   tick                     the clock: promotes time-derived phases
 *
 * Nothing here invents a server state. Where a label is derived from elapsed
 * time (the provisioning sub-steps, "finding" turning into "waking"), the copy
 * says it is the usual order, and there is never a percentage.
 */

export type LoaderPhase =
  | "signing-in"
  | "finding"
  | "provisioning"
  | "waking"
  | "starting"
  | "loading"
  | "ready";

/** Why the loader is up: a page load, a wake from idle sleep, or a dropped socket. */
export type LoaderReason = "boot" | "sleep" | "reconnect";

export type LoaderProblem =
  | { kind: "upgrade"; plan?: string }
  | { kind: "error"; message: string; status?: number }
  | { kind: "signin" };

export type WorkspaceSignal =
  | { type: "auth-start" }
  | { type: "auth-done" }
  | { type: "resolve-start" }
  | { type: "resolve-pending"; provisioning: boolean }
  | { type: "resolve-ready" }
  | { type: "resolve-failed"; message: string; status?: number; plan?: string }
  | { type: "signin-required" }
  | { type: "socket"; connected: boolean; reconnecting: boolean }
  | { type: "data-ready" }
  | { type: "gate"; loading: boolean }
  | { type: "online"; online: boolean }
  | { type: "show"; phase?: LoaderPhase; reason?: LoaderReason; variant?: "auto" | "full" | "compact" }
  | { type: "hide" }
  | { type: "tick" };

export type LoaderState = {
  /** False until the first signal: nothing renders. */
  active: boolean;
  phase: LoaderPhase;
  reason: LoaderReason;
  /** When this load / wake / outage began (elapsed time counts from here). */
  startedAt: number;
  phaseStartedAt: number;
  /** A 409 arrived in a browser that has never reached a ready workspace. */
  firstRun: boolean;
  /** This browser has reached a ready workspace before (persisted by the component). */
  knownWorkspace: boolean;
  /** Phases this run actually went through, so the step list only shows real steps. */
  sawProvisioning: boolean;
  sawWaking: boolean;
  /** The app has been usable at least once in this tab. */
  everReady: boolean;
  connected: boolean;
  dataReady: boolean;
  gateLoading: boolean;
  offline: boolean;
  problem: LoaderProblem | null;
  variant: "auto" | "full" | "compact";
  /** When "ready" was reached, for the exit animation. */
  readyAt: number | null;
  /** The loader has been on screen this run (a fast load never reveals it). */
  revealed: boolean;
};

export function initialLoaderState(now: number, opts: { knownWorkspace?: boolean } = {}): LoaderState {
  return {
    active: false,
    phase: "signing-in",
    reason: "boot",
    startedAt: now,
    phaseStartedAt: now,
    firstRun: false,
    knownWorkspace: opts.knownWorkspace === true,
    sawProvisioning: false,
    sawWaking: false,
    everReady: false,
    connected: false,
    dataReady: false,
    gateLoading: false,
    offline: false,
    problem: null,
    variant: "auto",
    readyAt: null,
    revealed: false,
  };
}

// ── Timing ──────────────────────────────────────────────────────────────────

/** Typical duration per phase, from measured cold provisions and wakes. */
export const EXPECTED_MS: Record<LoaderPhase, number> = {
  "signing-in": 3_000,
  finding: 2_000,
  provisioning: 120_000,
  waking: 15_000,
  starting: 15_000,
  loading: 8_000,
  ready: 0,
};
/** "Taking longer than usual" appears after this multiple of the expected time. */
export const SLOW_FACTOR = 1.5;
/** A fast load never flashes the loader. */
export const SHOW_AFTER_MS = 300;
/** A resolve still unanswered after this long is the orchestrator starting the Machine. */
export const FINDING_TO_WAKING_MS = 2_500;
/** A 409 in a known workspace reads as a wake at first, and as a rebuild after this. */
export const WAKE_409_GRACE_MS = 20_000;
/** A same-tab reconnect or wake stays in the compact bar this long, then goes full screen. */
export const COMPACT_MAX_MS = 10_000;
/** How long "Ready" stays up while it fades into the app. */
export const READY_EXIT_MS = 1_100;
/** Provisioning sub-steps: the usual order, by time spent polling 409s. */
export const PROVISION_ATTACH_AFTER_MS = 30_000;
export const PROVISION_BOOT_AFTER_MS = 70_000;

function enter(state: LoaderState, phase: LoaderPhase, now: number): LoaderState {
  if (state.phase === phase) return state;
  return {
    ...state,
    phase,
    phaseStartedAt: now,
    sawProvisioning: state.sawProvisioning || phase === "provisioning",
    sawWaking: state.sawWaking || phase === "waking",
    readyAt: phase === "ready" ? now : null,
  };
}

/** A new load / wake / outage: reset the per-run facts, keep what the tab knows. */
function begin(state: LoaderState, phase: LoaderPhase, reason: LoaderReason, now: number): LoaderState {
  return {
    ...state,
    active: true,
    phase,
    reason,
    startedAt: now,
    phaseStartedAt: now,
    firstRun: false,
    sawProvisioning: phase === "provisioning",
    sawWaking: phase === "waking",
    problem: null,
    readyAt: null,
    revealed: false,
    variant: "auto",
  };
}

function settle(state: LoaderState, now: number): LoaderState {
  if (state.problem) return state;
  if (state.phase !== "starting" && state.phase !== "loading") return state;
  if (!state.connected) return enter(state, "starting", now);
  if (!state.dataReady || state.gateLoading) return enter(state, "loading", now);
  return { ...enter(state, "ready", now), everReady: true, knownWorkspace: true };
}

export function reduceLoader(state: LoaderState, signal: WorkspaceSignal, now: number): LoaderState {
  switch (signal.type) {
    case "auth-start":
      return begin(state, "signing-in", "boot", now);
    case "auth-done":
      return state.active && state.phase === "signing-in" ? enter(state, "finding", now) : state;
    case "resolve-start": {
      // After the app has been usable, a resolve is a wake (the sleep flow) or a
      // retry; keep the run's start time when one is already in progress.
      if (state.everReady) {
        const running = state.active && state.phase !== "ready" && !state.problem;
        const reason = state.reason === "boot" ? "reconnect" : state.reason;
        return running ? enter({ ...state, problem: null }, "waking", now) : begin(state, "waking", reason, now);
      }
      if (!state.active) return begin(state, "finding", "boot", now);
      // A retry after an error starts the clock again.
      if (state.problem) return begin(state, "finding", state.reason, now);
      return enter(state, "finding", now);
    }
    case "resolve-pending": {
      if (!state.active || state.problem) return state;
      if (!signal.provisioning) return state;
      // 409 = a cold provision is in flight. Only a browser that has never
      // reached a ready workspace gets the first-run welcome.
      if (state.knownWorkspace || state.everReady) {
        if (state.phase === "provisioning") return state;
        if (state.phase === "waking" && now - state.phaseStartedAt >= WAKE_409_GRACE_MS) {
          return enter(state, "provisioning", now);
        }
        return enter(state, "waking", now);
      }
      return { ...enter(state, "provisioning", now), firstRun: true };
    }
    case "resolve-ready":
      if (!state.active) return state;
      return settle(enter({ ...state, problem: null }, "starting", now), now);
    case "resolve-failed": {
      const problem: LoaderProblem =
        signal.status === 402
          ? { kind: "upgrade", plan: signal.plan }
          : { kind: "error", message: signal.message, status: signal.status };
      return { ...state, active: true, revealed: true, problem };
    }
    case "signin-required":
      return { ...state, active: true, revealed: true, problem: { kind: "signin" } };
    case "socket": {
      const next = { ...state, connected: signal.connected };
      if (signal.connected) return settle(next, now);
      next.dataReady = false;
      // A drop after the app was usable is an outage of its own. Without
      // `reconnecting` nothing is trying (e.g. the workspace is asleep and the
      // sleep notice owns the screen), so the loader stays out of the way.
      if (state.everReady && state.phase === "ready" && signal.reconnecting) {
        return begin(next, "starting", "reconnect", now);
      }
      return settle(next, now);
    }
    case "data-ready":
      return settle({ ...state, dataReady: true }, now);
    case "gate":
      return settle({ ...state, gateLoading: signal.loading }, now);
    case "online":
      return { ...state, offline: !signal.online };
    case "show": {
      const next = begin(state, signal.phase ?? "waking", signal.reason ?? "boot", now);
      const variant = signal.variant ?? "auto";
      return { ...next, variant, revealed: variant !== "auto" };
    }
    case "hide":
      return { ...state, active: false, problem: null, variant: "auto" };
    case "tick": {
      if (!state.active || state.problem) return state;
      if (!state.revealed && state.phase !== "ready" && now - state.startedAt >= SHOW_AFTER_MS) {
        return reduceLoader({ ...state, revealed: true }, signal, now);
      }
      if (state.phase === "finding" && now - state.phaseStartedAt >= FINDING_TO_WAKING_MS) {
        return enter(state, "waking", now);
      }
      if (state.phase === "ready" && state.readyAt !== null && now - state.readyAt >= READY_EXIT_MS) {
        return { ...state, active: false, variant: "auto" };
      }
      return state;
    }
  }
}

// ── Copy ────────────────────────────────────────────────────────────────────

export type LoaderStep = { label: string; state: "done" | "current" | "pending"; note?: string };

export type LoaderAction = { id: "retry" | "reload" | "signin" | "plans"; label: string; primary?: boolean };

export type LoaderView = {
  variant: "hidden" | "full" | "compact";
  phase: LoaderPhase;
  /** For styling and tests: "ok" | "slow" | "error" | "upgrade" | "signin". */
  tone: "ok" | "slow" | "error" | "upgrade" | "signin";
  eyebrow: string;
  headline: string;
  explanation: string;
  /** "Usually takes about 2 minutes" — never a percentage. */
  expectation: string | null;
  steps: LoaderStep[];
  elapsed: string;
  slow: boolean;
  /** Longer plain-English "what's happening" text, shown on demand. */
  detail: string | null;
  offline: boolean;
  exiting: boolean;
  actions: LoaderAction[];
  /** Screen-reader announcement; changes only when the phase or problem does. */
  announce: string;
};

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

type PhaseCopy = { headline: string; explanation: string; expectation: string | null; detail: string };

function phaseCopy(state: LoaderState): PhaseCopy {
  switch (state.phase) {
    case "signing-in":
      return {
        headline: "Signing you in",
        explanation: "Checking your session with the sign-in service.",
        expectation: "Usually takes a couple of seconds",
        detail:
          "Your browser is loading the sign-in service and confirming your session. A slow or blocked network is the usual cause of a delay here.",
      };
    case "finding":
      return {
        headline: "Finding your workspace",
        explanation: "Asking InfiniBot Cloud where your private workspace lives.",
        expectation: "Usually takes a second or two",
        detail: "Every member has a private machine. We are looking yours up and checking that it is awake.",
      };
    case "provisioning":
      return state.firstRun
        ? {
            headline: "Building your private InfiniBot",
            explanation:
              "This happens once. We are setting up a machine that only you use, with its own storage.",
            expectation: "Usually takes about 2 minutes",
            detail:
              "A first-time setup reserves a machine, attaches storage for your data, then starts InfiniBot on it. The steps above follow the usual order by time; this page moves on the moment your machine answers. You can leave this tab open.",
          }
        : {
            headline: "Setting up your private machine",
            explanation: "Your machine is being set up again. This can take a couple of minutes.",
            expectation: "Usually takes about 2 minutes",
            detail:
              "Your workspace has no running machine, so one is being created. The steps above follow the usual order by time; this page moves on the moment your machine answers.",
          };
    case "waking":
      return state.reason === "sleep"
        ? {
            headline: "Waking your workspace",
            explanation: "Your workspace went to sleep while it was idle. It is starting again now.",
            expectation: "Usually takes 5 to 15 seconds",
            detail:
              "Your machine pauses when nobody is using it and starts again on demand. A machine that was fully stopped takes longer than one that was only paused.",
          }
        : {
            headline: "Waking your workspace",
            explanation: "Your private machine pauses when idle. It is starting again now.",
            expectation: "Usually takes 5 to 15 seconds",
            detail:
              "Your machine pauses when nobody is using it and starts again on demand. A machine that was fully stopped takes longer than one that was only paused.",
          };
    case "starting":
      return state.reason === "reconnect"
        ? {
            headline: "Reconnecting to your workspace",
            explanation: "The connection to your workspace dropped. We are connecting again.",
            expectation: "Usually takes a few seconds",
            detail:
              "The live connection between this tab and your machine closed. This happens when your network changes, or when your workspace restarts after a settings change.",
          }
        : {
            headline: "Starting InfiniBot",
            explanation: "Your machine is on. Connecting to InfiniBot as it boots.",
            expectation: "Usually takes 5 to 15 seconds",
            detail:
              "InfiniBot is booting on your machine. This tab is opening a secure connection to it and signing in with your session.",
          };
    case "loading":
      return {
        headline: "Loading your agents and plugins",
        explanation: "Connected. Fetching your agents, plugins and settings.",
        expectation: "Usually takes a few seconds",
        detail:
          "The connection is open. InfiniBot is sending this tab your plugins and workspace state before the app appears.",
      };
    case "ready":
      return {
        headline: "Ready",
        explanation: "Your workspace is up.",
        expectation: null,
        detail: "",
      };
  }
}

const ORDER: LoaderPhase[] = ["signing-in", "finding", "provisioning", "waking", "starting", "loading", "ready"];

function buildSteps(state: LoaderState, now: number): LoaderStep[] {
  const at = ORDER.indexOf(state.phase);
  const mark = (phase: LoaderPhase): LoaderStep["state"] => {
    const i = ORDER.indexOf(phase);
    return i < at ? "done" : i === at ? "current" : "pending";
  };
  const steps: LoaderStep[] = [];
  if (state.reason === "boot") {
    steps.push({ label: "Sign in", state: mark("signing-in") });
    steps.push({ label: "Find your workspace", state: mark("finding") });
  }
  if (state.sawProvisioning) {
    const here = state.phase === "provisioning";
    const spent = here ? now - state.phaseStartedAt : Number.POSITIVE_INFINITY;
    const sub = (from: number, to: number): LoaderStep["state"] =>
      !here ? "done" : spent >= to ? "done" : spent >= from ? "current" : "pending";
    steps.push({ label: "Reserve your machine", state: sub(0, PROVISION_ATTACH_AFTER_MS) });
    steps.push({ label: "Attach storage", state: sub(PROVISION_ATTACH_AFTER_MS, PROVISION_BOOT_AFTER_MS) });
    steps.push({ label: "Boot your machine", state: sub(PROVISION_BOOT_AFTER_MS, Number.POSITIVE_INFINITY) });
  }
  // A 409 that began as "waking" and turned into a rebuild keeps only the rebuild steps.
  if (state.sawWaking && !state.sawProvisioning) {
    steps.push({ label: "Wake your workspace", state: mark("waking") });
  }
  steps.push({
    label: state.reason === "reconnect" && !state.sawWaking ? "Reconnect to InfiniBot" : "Start InfiniBot",
    state: mark("starting"),
  });
  steps.push({ label: "Load your agents and plugins", state: mark("loading") });
  return steps;
}

function compactAllowed(state: LoaderState, now: number): boolean {
  if (state.variant === "compact") return true;
  if (state.variant === "full") return false;
  if (!state.everReady || state.reason === "boot") return false;
  return now - state.startedAt < COMPACT_MAX_MS;
}

export function deriveLoaderView(state: LoaderState, now: number): LoaderView {
  const elapsedMs = Math.max(0, now - state.startedAt);
  const copy = phaseCopy(state);
  const base: LoaderView = {
    variant: "hidden",
    phase: state.phase,
    tone: "ok",
    eyebrow: "InfiniBot Cloud",
    headline: copy.headline,
    explanation: copy.explanation,
    expectation: copy.expectation,
    steps: [],
    elapsed: formatElapsed(elapsedMs),
    slow: false,
    detail: null,
    offline: state.offline,
    exiting: false,
    actions: [],
    announce: "",
  };
  if (!state.active) return base;

  if (state.problem) {
    const p = state.problem;
    if (p.kind === "upgrade") {
      return {
        ...base,
        variant: "full",
        tone: "upgrade",
        headline: "Your plan has no cloud workspace",
        explanation:
          "The Free plan is for running InfiniBot on your own computer. Upgrade to get a private cloud workspace.",
        expectation: null,
        actions: [
          { id: "plans", label: "See plans", primary: true },
          { id: "retry", label: "Check again" },
        ],
        announce: "Your plan has no cloud workspace. Upgrade to get a private cloud workspace.",
      };
    }
    if (p.kind === "signin") {
      return {
        ...base,
        variant: "full",
        tone: "signin",
        headline: "Sign in again",
        explanation: "Your sign-in couldn't be verified by the workspace service.",
        expectation: null,
        actions: [{ id: "signin", label: "Sign in", primary: true }],
        announce: "Sign in again. Your sign-in couldn't be verified.",
      };
    }
    const headline = state.offline
      ? "You're offline"
      : p.status === 0
        ? "Can't reach InfiniBot Cloud"
        : "We couldn't start your workspace";
    return {
      ...base,
      variant: "full",
      tone: "error",
      headline,
      explanation: p.message,
      expectation: null,
      detail:
        p.status && p.status >= 500
          ? `The workspace service answered with an error (${p.status}). Nothing was lost. Retrying is safe and usually works within a minute.`
          : "Retrying is safe. If this keeps happening, check your connection, then try again in a minute.",
      actions: [{ id: "retry", label: "Retry", primary: true }],
      announce: `${headline}. ${p.message}`,
    };
  }

  // A load that finished before the loader was ever revealed never flashes it.
  if (!state.revealed && (state.phase === "ready" || elapsedMs < SHOW_AFTER_MS)) return base;

  const phaseMs = Math.max(0, now - state.phaseStartedAt);
  const slow = state.phase !== "ready" && phaseMs > EXPECTED_MS[state.phase] * SLOW_FACTOR;
  const firstRun = state.firstRun && state.reason === "boot";
  return {
    ...base,
    variant: compactAllowed(state, now) ? "compact" : "full",
    tone: slow ? "slow" : "ok",
    eyebrow: firstRun ? "Welcome to InfiniBot Cloud" : "InfiniBot Cloud",
    steps: buildSteps(state, now),
    slow,
    detail: slow ? copy.detail : null,
    exiting: state.phase === "ready",
    // While a resolve or a socket connect is still in flight a second run would
    // race it, so the slow-state retry reloads the page instead.
    actions: slow ? [{ id: "reload", label: "Retry", primary: true }] : [],
    announce:
      state.phase === "ready"
        ? "Your workspace is ready."
        : `${copy.headline}. ${copy.explanation}${copy.expectation ? ` ${copy.expectation}.` : ""}${
            slow ? " Taking longer than usual, still working." : ""
          }`,
  };
}
