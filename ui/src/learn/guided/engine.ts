/**
 * Guided walkthrough engine — runs one walkthrough at a time as an overlay
 * tour over the real app.
 *
 * Per step:
 *   1. `skipIf` holds → skip.
 *   2. `route` set and not current → navigate (history + popstate, the same
 *      router the sidebar uses).
 *   3. `target` set → wait (up to `waitMs`) for a visible match, reveal it.
 *      Not found → "missing" phase: the user can retry, skip or exit — a tour
 *      never traps the UI.
 *   4. `action` set → wait for the user to click / type / toggle / navigate.
 *      `check` set → poll the condition (read-only RPCs only) until it holds.
 *   5. On completion: first matching `branches` entry jumps; else next step.
 *
 * The active tour is persisted (localStorage + gateway session pref) and
 * resumed after a reload. Esc always exits. `auto` mode (the headless audit
 * and "Do it for me") performs the action itself — never for `practice`
 * steps, which only explain.
 */

import type { LearnStep, LearnTarget, LearnWalkthrough, PublicLearnTrack } from "../../../../src/learn/guided/types.js";
import { walkthroughRef } from "../../../../src/learn/guided/types.js";
import { inferBasePathFromPathname, normalizeBasePath } from "../../ui/navigation";
import {
  findTrack,
  registerDevTrack,
  guidedClient,
  guidedState,
  loadGuidedCatalog,
  methodAdvertised,
  pluginEnabledNow,
  recordComplete,
  recordStep,
  setSession,
} from "./catalog-store";
import { evaluate, routeMatches, type ConditionEnv } from "./conditions";
import { eventHits, resolveTarget, revealElement } from "./resolve-target";
import { hasSurface } from "./surfaces";

export type TourPhase =
  | "idle"
  | "navigating"
  | "locating"
  | "missing"
  | "waiting-action"
  | "checking"
  | "ready"
  | "done";

export type StepResult = { stepId: string; ok: boolean; skipped?: boolean; reason?: string; ms: number };

export type TourState = {
  phase: TourPhase;
  track: PublicLearnTrack | null;
  walkthrough: LearnWalkthrough | null;
  index: number;
  step: LearnStep | null;
  target: Element | null;
  /** Hint shown while waiting (action / check). */
  hint: string | null;
  auto: boolean;
  minimized: boolean;
  resumed: boolean;
  /** Certificates minted by finishing this walkthrough. */
  minted: string[];
  results: StepResult[];
};

const SESSION_KEY = "infinibot.learn.tour.v1";
const RESUME_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_WAIT_MS = 8000;

const tour: TourState = {
  phase: "idle",
  track: null,
  walkthrough: null,
  index: 0,
  step: null,
  target: null,
  hint: null,
  auto: false,
  minimized: false,
  resumed: false,
  minted: [],
  results: [],
};

let runToken = 0;
let history: number[] = [];
let stepStartedAt = 0;
let detachAction: (() => void) | null = null;
let checkTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

export const TOUR_EVENT = "infinibot:learn-tour";

function emit(): void {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch {
      /* ignore */
    }
  }
  try {
    window.dispatchEvent(new CustomEvent(TOUR_EVENT, { detail: { phase: tour.phase } }));
  } catch {
    /* ignore */
  }
}

export function subscribeTour(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function tourState(): Readonly<TourState> {
  return tour;
}

export function isTourActive(): boolean {
  return tour.phase !== "idle";
}

// ── environment ───────────────────────────────────────────────────────

function basePath(): string {
  return normalizeBasePath(inferBasePathFromPathname(window.location.pathname));
}

export function currentRoute(): string {
  const base = basePath();
  let p = window.location.pathname;
  if (base && p.startsWith(base)) p = p.slice(base.length) || "/";
  return `${p}${window.location.search}`;
}

export function navigateTo(route: string): void {
  if (routeMatches(currentRoute(), route) && !route.includes("?")) return;
  const base = basePath();
  window.history.pushState({}, "", `${base}${route}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export const conditionEnv: ConditionEnv = {
  pluginEnabled: pluginEnabledNow,
  hasMethod: methodAdvertised,
  hasSurface,
  elementVisible: (t: LearnTarget) => resolveTarget(t) !== null,
  route: currentRoute,
  viewportWidth: () => window.innerWidth,
  rpc: async (method, params) => {
    const c = guidedClient();
    if (!c) throw new Error("not connected");
    return c.request(method, params ?? {});
  },
  completed: (ref) => {
    const p = guidedState().progress;
    if (ref.includes("/")) return p.walkthroughs[ref]?.status === "completed";
    const t = findTrack(ref);
    return Boolean(t && t.walkthroughs.every((w) => p.walkthroughs[walkthroughRef(t.id, w.id)]?.status === "completed"));
  },
};

// ── lifecycle ─────────────────────────────────────────────────────────

function cleanupStep(): void {
  detachAction?.();
  detachAction = null;
  if (checkTimer) clearInterval(checkTimer);
  checkTimer = null;
}

function persist(): void {
  if (!tour.track || !tour.walkthrough || !tour.step) return;
  const session = { trackId: tour.track.id, walkthroughId: tour.walkthrough.id, stepId: tour.step.id, at: Date.now() };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* ignore */
  }
  if (!tour.auto) void setSession(session);
}

function clearPersisted(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
  if (!tour.auto) void setSession(null);
}

export type StartOptions = { stepId?: string; auto?: boolean; resumed?: boolean };

/** Start (or restart) a walkthrough. Resolves once the first step is running. */
export async function startWalkthrough(trackId: string, walkthroughId: string, opts: StartOptions = {}): Promise<boolean> {
  await loadGuidedCatalog();
  const track = findTrack(trackId);
  const walkthrough = track?.walkthroughs.find((w) => w.id === walkthroughId);
  if (!track || !walkthrough) return false;
  cleanupStep();
  Object.assign(tour, {
    phase: "navigating",
    track,
    walkthrough,
    index: 0,
    step: null,
    target: null,
    hint: null,
    auto: Boolean(opts.auto),
    minimized: false,
    resumed: Boolean(opts.resumed),
    minted: [],
    results: [],
  } satisfies Partial<TourState>);
  history = [];
  ensureOverlay();
  const startIdx = opts.stepId ? Math.max(0, walkthrough.steps.findIndex((s) => s.id === opts.stepId)) : 0;
  void runStep(startIdx);
  return true;
}

/** Start the first unfinished walkthrough of a track. */
export async function startTrack(trackId: string): Promise<boolean> {
  await loadGuidedCatalog();
  const track = findTrack(trackId);
  if (!track) return false;
  const p = guidedState().progress;
  const next =
    track.walkthroughs.find((w) => p.walkthroughs[walkthroughRef(track.id, w.id)]?.status === "in_progress") ??
    track.walkthroughs.find((w) => p.walkthroughs[walkthroughRef(track.id, w.id)]?.status !== "completed") ??
    track.walkthroughs[0];
  return next ? startWalkthrough(track.id, next.id, { stepId: p.walkthroughs[walkthroughRef(track.id, next.id)]?.stepId ?? undefined }) : false;
}

export function exitTour(): void {
  cleanupStep();
  runToken++;
  clearPersisted();
  Object.assign(tour, { phase: "idle", track: null, walkthrough: null, step: null, target: null, hint: null, minimized: false });
  emit();
}

export function setMinimized(min: boolean): void {
  tour.minimized = min;
  emit();
}

/** Re-measure the target (overlay calls on scroll/resize). */
export function refreshTarget(): void {
  if (!tour.step?.target || tour.phase === "missing") return;
  if (tour.target && tour.target.isConnected) return;
  const el = resolveTarget(tour.step.target);
  if (el) {
    tour.target = el;
    emit();
  }
}

function record(ok: boolean, extra: Partial<StepResult> = {}): void {
  if (!tour.step) return;
  tour.results.push({ stepId: tour.step.id, ok, ms: Math.round(performance.now() - stepStartedAt), ...extra });
}

async function runStep(index: number): Promise<void> {
  const my = ++runToken;
  cleanupStep();
  const wt = tour.walkthrough;
  if (!wt) return;
  if (index >= wt.steps.length) {
    await finish();
    return;
  }
  const step = wt.steps[index]!;
  stepStartedAt = performance.now();
  Object.assign(tour, { index, step, target: null, hint: null, phase: "navigating" as TourPhase });
  emit();

  if (step.skipIf && (await evaluate(step.skipIf, conditionEnv))) {
    if (my !== runToken) return;
    record(true, { skipped: true, reason: "skipIf" });
    void runStep(index + 1);
    return;
  }

  if (step.route && !routeMatches(currentRoute(), step.route)) {
    navigateTo(step.route);
    await sleep(350);
    if (my !== runToken) return;
  }
  persist();

  if (step.target) {
    tour.phase = "locating";
    emit();
    const el = await waitForTarget(step.target, step.waitMs ?? DEFAULT_WAIT_MS, my);
    if (my !== runToken) return;
    if (!el) {
      tour.phase = "missing";
      tour.hint = "This part of the page isn't showing right now.";
      emit();
      if (tour.auto) {
        record(false, { reason: "target not found" });
        void advance(index);
      }
      return;
    }
    revealElement(el);
    tour.target = el;
  }
  if (!tour.auto) void recordStep(tour.track!.id, wt.id, step.id, false);

  if (step.practice?.mode === "explain") {
    tour.phase = "ready";
    emit();
    if (tour.auto) autoNext(my, index);
    return;
  }

  if (step.action) {
    tour.phase = "waiting-action";
    tour.hint = actionHint(step);
    emit();
    const done = await waitForAction(step, my);
    if (my !== runToken) return;
    if (!done) return;
  }

  if (step.check) {
    tour.phase = "checking";
    tour.hint = step.checkHint ?? "Waiting for this to happen…";
    emit();
    const ok = await waitForCheck(step, my);
    if (my !== runToken) return;
    if (!ok) {
      if (tour.auto) {
        record(false, { reason: "check never held" });
        void advance(index);
      }
      return;
    }
    if (step.action || tour.auto) {
      record(true);
      void advance(index);
      return;
    }
    tour.hint = null;
    tour.phase = "ready";
    emit();
    return;
  }

  if (step.action) {
    record(true);
    void advance(index);
    return;
  }
  tour.phase = "ready";
  emit();
  if (tour.auto) autoNext(my, index);
}

function autoNext(my: number, index: number): void {
  setTimeout(() => {
    if (my !== runToken) return;
    record(true);
    void advance(index);
  }, 120);
}

/** Complete step `index` and move on (branches first). */
async function advance(index: number): Promise<void> {
  const wt = tour.walkthrough;
  const step = wt?.steps[index];
  if (!wt || !step) return;
  const my = ++runToken;
  if (!tour.auto) void recordStep(tour.track!.id, wt.id, step.id, true);
  history.push(index);
  for (const b of step.branches ?? []) {
    if (await evaluate(b.when, conditionEnv)) {
      if (my !== runToken) return;
      const to = wt.steps.findIndex((s) => s.id === b.goto);
      if (to >= 0) {
        void runStep(to);
        return;
      }
    }
  }
  if (my !== runToken) return;
  void runStep(index + 1);
}

/** User pressed Next (only enabled in `ready`), or Skip (any phase). */
export function nextStep(skip = false): void {
  if (tour.phase === "idle" || tour.phase === "done") return;
  if (!skip && tour.phase !== "ready") return;
  if (skip) record(true, { skipped: true, reason: "user skipped" });
  else record(true);
  void advance(tour.index);
}

export function prevStep(): void {
  const prev = history.pop();
  if (prev === undefined) return;
  void runStep(prev);
}

export function retryStep(): void {
  void runStep(tour.index);
}

/** Perform the pending action for the user (never for explain-only steps). */
export function doItForMe(): void {
  const step = tour.step;
  if (!step?.action || step.practice?.mode === "explain") return;
  performAction(step);
}

async function finish(): Promise<void> {
  cleanupStep();
  const track = tour.track;
  const wt = tour.walkthrough;
  tour.phase = "done";
  tour.step = null;
  tour.target = null;
  clearPersisted();
  emit();
  if (track && wt && !tour.auto) {
    tour.minted = await recordComplete(track.id, wt.id);
    emit();
  }
}

// ── waiting ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForTarget(target: LearnTarget, waitMs: number, my: number): Promise<Element | null> {
  const until = performance.now() + waitMs;
  while (performance.now() < until) {
    if (my !== runToken) return null;
    const el = resolveTarget(target);
    if (el) return el;
    await sleep(200);
  }
  return resolveTarget(target);
}

function actionTarget(step: LearnStep): Element | null {
  const a = step.action;
  if (!a || a.kind === "navigate") return null;
  if (a.target) return resolveTarget(a.target);
  return tour.target ?? (step.target ? resolveTarget(step.target) : null);
}

function actionHint(step: LearnStep): string {
  const a = step.action!;
  switch (a.kind) {
    case "click":
      return "Click the highlighted element to continue.";
    case "toggle":
      return "Flip the highlighted switch to continue.";
    case "input":
      return a.match ? `Type something containing “${a.match}”.` : "Type into the highlighted field to continue.";
    case "navigate":
      return `Open ${a.path} to continue.`;
  }
}

function valueOf(el: Element | null): string {
  if (!el) return "";
  if (el instanceof HTMLSelectElement) return `${el.value} ${el.selectedOptions[0]?.text ?? ""}`;
  const v = (el as HTMLInputElement).value;
  if (typeof v === "string") return v;
  return (el as HTMLElement).innerText ?? el.textContent ?? "";
}

function inputSatisfied(step: LearnStep, el: Element | null): boolean {
  const a = step.action;
  if (a?.kind !== "input") return false;
  const v = valueOf(el).trim();
  if (!v) return false;
  return a.match ? v.toLowerCase().includes(a.match.toLowerCase()) : true;
}

function waitForAction(step: LearnStep, my: number): Promise<boolean> {
  const a = step.action!;
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      detachAction?.();
      detachAction = null;
      resolve(ok && my === runToken);
    };
    if (a.kind === "navigate") {
      const t = setInterval(() => {
        if (my !== runToken) return done(false);
        if (routeMatches(currentRoute(), a.path)) {
          clearInterval(t);
          done(true);
        }
      }, 250);
      detachAction = () => clearInterval(t);
      if (tour.auto) setTimeout(() => performAction(step), 150);
      return;
    }
    const onEvent = (e: Event) => {
      const el = actionTarget(step);
      if (!el || !eventHits(e, el)) return;
      if (a.kind === "input") {
        // Read the field that received the event (may be inside the target).
        const src = (e.composedPath()[0] as Element | undefined) ?? el;
        if (inputSatisfied(step, src) || inputSatisfied(step, el)) setTimeout(() => done(true), 250);
        return;
      }
      // Let the app handle the click first.
      setTimeout(() => done(true), 60);
    };
    const types = a.kind === "input" ? ["input", "change", "keyup"] : a.kind === "toggle" ? ["click", "change"] : ["click"];
    for (const t of types) document.addEventListener(t, onEvent, true);
    detachAction = () => {
      for (const t of types) document.removeEventListener(t, onEvent, true);
    };
    if (tour.auto) setTimeout(() => performAction(step), 150);
  });
}

function waitForCheck(step: LearnStep, my: number): Promise<boolean> {
  const limit = tour.auto ? performance.now() + 15_000 : Infinity;
  return new Promise((resolve) => {
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        if (my !== runToken) {
          if (checkTimer) clearInterval(checkTimer);
          resolve(false);
          return;
        }
        if (await evaluate(step.check, conditionEnv)) {
          if (checkTimer) clearInterval(checkTimer);
          checkTimer = null;
          resolve(true);
          return;
        }
        if (performance.now() > limit) {
          if (checkTimer) clearInterval(checkTimer);
          checkTimer = null;
          resolve(false);
        }
      } finally {
        busy = false;
      }
    };
    checkTimer = setInterval(() => void tick(), 1000);
    void tick();
  });
}

/** Synthesize the step's action (auto mode / "Do it for me"). */
function performAction(step: LearnStep): void {
  const a = step.action;
  if (!a || step.practice?.mode === "explain") return;
  if (a.kind === "navigate") {
    navigateTo(a.path);
    return;
  }
  const el = actionTarget(step) as HTMLElement | null;
  if (!el) return;
  if (a.kind === "input") {
    const select = (el instanceof HTMLSelectElement ? el : el.querySelector("select")) as HTMLSelectElement | null;
    if (select && !el.matches("input,textarea,[contenteditable]")) {
      // Pick the first option whose value/label contains the sample or match.
      const want = (a.sample ?? a.match ?? "").toLowerCase();
      const opt = [...select.options].find((o) => want && (o.value.toLowerCase().includes(want) || o.text.toLowerCase().includes(want)));
      if (opt) select.value = opt.value;
      select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return;
    }
    const field = (el.matches("input,textarea,[contenteditable]") ? el : el.querySelector("input,textarea,[contenteditable]")) as
      | HTMLInputElement
      | HTMLTextAreaElement
      | HTMLElement
      | null;
    const target = field ?? el;
    const text = a.sample ?? a.match ?? "hello";
    if ("value" in target) {
      const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      target.focus();
      if (setter) setter.call(target, text);
      else (target as HTMLInputElement).value = text;
    } else {
      target.focus();
      target.textContent = text;
    }
    target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return;
  }
  el.click();
}

// ── resume + overlay mount ───────────────────────────────────────────

/** Resume a tour interrupted by a reload (local session first, then the gateway's). */
export async function resumeIfPending(): Promise<boolean> {
  if (isTourActive()) return false;
  let session: { trackId: string; walkthroughId: string; stepId: string; at: number } | null = null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) session = JSON.parse(raw);
  } catch {
    session = null;
  }
  if (!session || Date.now() - session.at > RESUME_MAX_AGE_MS) return false;
  return startWalkthrough(session.trackId, session.walkthroughId, { stepId: session.stepId, resumed: true });
}

let overlayMounted = false;
export function ensureOverlay(): void {
  if (overlayMounted || typeof document === "undefined") return;
  overlayMounted = true;
  void import("../../ui/components/guided-tour-overlay").then(() => {
    // Mounted on <html>, outside the zoomed <body>, so fixed positions match
    // getBoundingClientRect() pixels exactly.
    if (!document.querySelector("guided-tour-overlay")) {
      document.documentElement.appendChild(document.createElement("guided-tour-overlay"));
    }
  });
}

// ── audit / automation hook ──────────────────────────────────────────

export type AuditReport = {
  trackId: string;
  walkthroughId: string;
  steps: number;
  passed: number;
  results: StepResult[];
  finished: boolean;
};

/** Run one walkthrough end to end in auto mode and report per-step results. */
export async function auditWalkthrough(trackId: string, walkthroughId: string, timeoutMs = 120_000): Promise<AuditReport> {
  const ok = await startWalkthrough(trackId, walkthroughId, { auto: true });
  const wt = findTrack(trackId)?.walkthroughs.find((w) => w.id === walkthroughId);
  if (!ok || !wt) return { trackId, walkthroughId, steps: 0, passed: 0, results: [], finished: false };
  const until = performance.now() + timeoutMs;
  while (tour.phase !== "done" && tour.phase !== "idle" && performance.now() < until) await sleep(200);
  const finished = tour.phase === "done";
  // One result per step id (branch loops / retries keep the last).
  const byStep = new Map<string, StepResult>();
  for (const r of tour.results) byStep.set(r.stepId, r);
  const results = wt.steps.map(
    (s) => byStep.get(s.id) ?? { stepId: s.id, ok: false, reason: finished ? "not visited (branched past)" : "timeout", ms: 0 },
  );
  // A step branched past is not a failure of its target.
  for (const r of results) if (r.reason === "not visited (branched past)") r.ok = true;
  exitTour();
  return {
    trackId,
    walkthroughId,
    steps: wt.steps.length,
    passed: results.filter((r) => r.ok).length,
    results,
    finished,
  };
}

declare global {
  interface Window {
    __infinibotLearn?: {
      start: typeof startWalkthrough;
      startTrack: typeof startTrack;
      audit: typeof auditWalkthrough;
      exit: typeof exitTour;
      state: typeof tourState;
      catalog: typeof guidedState;
      register: typeof registerDevTrack;
    };
  }
}

if (typeof window !== "undefined") {
  window.__infinibotLearn = {
    start: startWalkthrough,
    startTrack,
    audit: auditWalkthrough,
    exit: exitTour,
    state: tourState,
    catalog: guidedState,
    register: registerDevTrack,
  };
}
