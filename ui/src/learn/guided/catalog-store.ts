/**
 * Guided Learn — client catalog + progress store.
 *
 * Source of truth is the gateway (`learn.guided.*`): the catalog is core
 * tracks plus tracks from enabled plugins, and progress is stored per user so
 * it syncs across devices. A localStorage mirror paints instantly and keeps
 * working offline; when the gateway predates guided Learn (method not
 * advertised), a bundled fallback catalog is used and progress stays local.
 */

import type { GatewayBrowserClient } from "../../ui/gateway";
import { pluginLinkInfo } from "../../ui/plugin-host";
import type { CatalogPlugin } from "../../../../src/learn/guided/catalog.js";
import {
  computeBadges,
  computeCertLadder,
  type EarnedBadge,
  type GuidedCertRung,
} from "../../../../src/learn/guided/status.js";
import { parseTrack } from "../../../../src/learn/guided/validate.js";
import {
  QUIZ_PASS_RATIO,
  stripQuizAnswers,
  trackStatus,
  walkthroughRef,
  type GuidedProgress,
  type LearnMissionRef,
  type PublicLearnTrack,
  type TrackStatus,
  type WalkthroughProgress,
} from "../../../../src/learn/guided/types.js";
import { isListable } from "./conditions";
import { hasSurface } from "./surfaces";

export type { CatalogPlugin, EarnedBadge, GuidedCertRung, PublicLearnTrack, TrackStatus };

export type GuidedCatalogState = {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** "gateway" = served + synced; "local" = bundled fallback, progress on this device only. */
  source: "gateway" | "local" | null;
  tracks: PublicLearnTrack[];
  plugins: CatalogPlugin[];
  missions: LearnMissionRef[];
  progress: GuidedProgress;
};

const MIRROR_KEY = "infinibot.learn.guided.v1";
const OWNER = "_owner";

function emptyProgress(): GuidedProgress {
  return { userId: OWNER, walkthroughs: {}, quizzes: {}, prefs: {}, session: null };
}

function readMirror(): GuidedProgress {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<GuidedProgress>;
      return {
        userId: p.userId ?? OWNER,
        walkthroughs: p.walkthroughs ?? {},
        quizzes: p.quizzes ?? {},
        prefs: p.prefs ?? {},
        session: p.session ?? null,
      };
    }
  } catch {
    /* corrupt mirror → start clean */
  }
  return emptyProgress();
}

function writeMirror(p: GuidedProgress): void {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(p));
  } catch {
    /* quota */
  }
}

const state: GuidedCatalogState = {
  loaded: false,
  loading: false,
  error: null,
  source: null,
  tracks: [],
  plugins: [],
  missions: [],
  progress: typeof localStorage === "undefined" ? emptyProgress() : readMirror(),
};

/** Local answer keys (fallback catalog only — the gateway grades otherwise). */
let localAnswers: Record<string, number[]> = {};
let client: GatewayBrowserClient | null = null;
const listeners = new Set<() => void>();

export const GUIDED_CHANGED = "infinibot:learn-guided-changed";

function emit(): void {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch {
      /* listener errors are non-fatal */
    }
  }
  try {
    window.dispatchEvent(new CustomEvent(GUIDED_CHANGED));
  } catch {
    /* non-DOM env */
  }
}

export function subscribeGuided(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function guidedState(): GuidedCatalogState {
  return state;
}

/** The app's gateway client (the learn page passes it; the shell element has it too). */
export function guidedClient(): GatewayBrowserClient | null {
  if (client?.connected) return client;
  const app = document.querySelector("infinibot-app") as unknown as { client?: GatewayBrowserClient | null } | null;
  return app?.client ?? client;
}

function gatewayHas(c: GatewayBrowserClient | null, method: string): boolean {
  if (!c) return false;
  const set = c.serverMethods;
  return set ? set.has(method) : true;
}

export function pluginEnabledNow(id: string): boolean {
  const list = pluginLinkInfo();
  const p = list?.find((x) => x.id === id);
  return Boolean(p && p.enabled && p.status === "loaded");
}

export function methodAdvertised(method: string): boolean {
  return guidedClient()?.serverMethods?.has(method) ?? false;
}

function applyServer(res: {
  tracks?: PublicLearnTrack[];
  plugins?: CatalogPlugin[];
  missions?: LearnMissionRef[];
  progress?: GuidedProgress;
}): void {
  if (res.tracks) state.tracks = res.tracks;
  if (res.plugins) state.plugins = res.plugins;
  if (res.missions) state.missions = res.missions;
  if (res.progress) {
    // Merge: anything completed only locally (offline) is kept and pushed up.
    const local = state.progress;
    state.progress = { ...res.progress, session: res.progress.session ?? local.session };
    for (const [ref, wp] of Object.entries(local.walkthroughs)) {
      if (wp.status === "completed" && state.progress.walkthroughs[ref]?.status !== "completed") {
        state.progress.walkthroughs[ref] = wp;
        const [trackId, walkthroughId] = ref.split("/");
        void rpc("learn.guided.progress.update", { trackId, walkthroughId, event: "complete" });
      }
    }
    writeMirror(state.progress);
  }
}

async function rpc<T = unknown>(method: string, params: Record<string, unknown>): Promise<T | null> {
  const c = guidedClient();
  if (!c || state.source !== "gateway" || !gatewayHas(c, method)) return null;
  try {
    return (await c.request(method, params)) as T;
  } catch {
    return null;
  }
}

/** Load (or refresh) the catalog. Safe to call often; concurrent calls share one fetch. */
let inflight: Promise<void> | null = null;
export function loadGuidedCatalog(c?: GatewayBrowserClient | null, force = false): Promise<void> {
  if (c) client = c;
  if (inflight) return inflight;
  if (state.loaded && !force) return Promise.resolve();
  state.loading = true;
  emit();
  inflight = (async () => {
    const gw = guidedClient();
    try {
      if (gw && gatewayHas(gw, "learn.guided.catalog")) {
        const res = (await gw.request("learn.guided.catalog", {})) as Parameters<typeof applyServer>[0];
        state.source = "gateway";
        applyServer(res);
      } else {
        await loadFallback();
      }
      state.error = null;
    } catch (err) {
      // Gateway error (e.g. method unknown on an older build) → bundled content.
      try {
        await loadFallback();
        state.error = null;
      } catch {
        state.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      state.loaded = true;
      state.loading = false;
      inflight = null;
      emit();
    }
  })();
  return inflight;
}

async function loadFallback(): Promise<void> {
  const { buildFallbackCatalog } = await import("./fallback-catalog");
  const cat = await buildFallbackCatalog((id) => pluginEnabledNow(id));
  state.source = "local";
  state.tracks = cat.tracks;
  state.plugins = cat.plugins;
  state.missions = cat.missions;
  localAnswers = cat.answers;
}

/** Re-fetch when plugins change (a newly enabled plugin's tracks appear). */
export function refreshGuidedCatalog(): Promise<void> {
  return loadGuidedCatalog(null, true);
}

// ── derived views ─────────────────────────────────────────────────────

const listEnv = {
  pluginEnabled: pluginEnabledNow,
  hasMethod: methodAdvertised,
  hasSurface,
  completed: () => true,
};

/** Tracks the user can take right now (requires-guards evaluated). */
export function availableTracks(): PublicLearnTrack[] {
  return state.tracks
    .filter((t) => isListable(t.requires, listEnv))
    .map((t) => ({ ...t, walkthroughs: t.walkthroughs.filter((w) => isListable(w.requires, listEnv)) }))
    .filter((t) => t.walkthroughs.length > 0);
}

export function findTrack(id: string): PublicLearnTrack | undefined {
  return availableTracks().find((t) => t.id === id);
}

export function statusOf(track: PublicLearnTrack): TrackStatus {
  return trackStatus(track, state.progress);
}

export function walkthroughProgress(trackId: string, walkthroughId: string): WalkthroughProgress | undefined {
  return state.progress.walkthroughs[walkthroughRef(trackId, walkthroughId)];
}

export function badges(): EarnedBadge[] {
  return computeBadges(availableTracks(), state.progress);
}

export function certLadder(): GuidedCertRung[] {
  return computeCertLadder(availableTracks(), state.progress);
}

/** Track teaching the given route (longest matching `routes` prefix wins). */
export function trackForRoute(path: string): PublicLearnTrack | undefined {
  const clean = (path.split("?")[0] || "/").replace(/\/+$/, "") || "/";
  let best: { t: PublicLearnTrack; len: number } | null = null;
  for (const t of availableTracks()) {
    for (const r of t.routes ?? []) {
      const rr = r.replace(/\/+$/, "") || "/";
      if (clean === rr || (rr !== "/" && clean.startsWith(`${rr}/`))) {
        if (!best || rr.length > best.len) best = { t, len: rr.length };
      }
    }
  }
  return best?.t;
}

// ── writes (gateway first, mirror always) ────────────────────────────

function localStep(ref: string, stepId: string, done: boolean): void {
  const cur = state.progress.walkthroughs[ref];
  const completedSteps = new Set(cur?.completedSteps ?? []);
  if (done) completedSteps.add(stepId);
  state.progress.walkthroughs[ref] = {
    status: cur?.status === "completed" ? "completed" : "in_progress",
    stepId,
    completedSteps: [...completedSteps],
    updatedAt: Date.now(),
    completedAt: cur?.completedAt ?? null,
  };
}

export async function recordStep(trackId: string, walkthroughId: string, stepId: string, done: boolean): Promise<void> {
  localStep(walkthroughRef(trackId, walkthroughId), stepId, done);
  writeMirror(state.progress);
  emit();
  const res = await rpc<{ progress?: GuidedProgress }>("learn.guided.progress.update", {
    trackId,
    walkthroughId,
    event: "step",
    stepId,
    done,
  });
  if (res?.progress) {
    state.progress = { ...res.progress, session: state.progress.session };
    writeMirror(state.progress);
  }
}

export async function recordComplete(trackId: string, walkthroughId: string): Promise<string[]> {
  const ref = walkthroughRef(trackId, walkthroughId);
  const cur = state.progress.walkthroughs[ref];
  const track = state.tracks.find((t) => t.id === trackId);
  const all = track?.walkthroughs.find((w) => w.id === walkthroughId)?.steps.map((s) => s.id) ?? [];
  state.progress.walkthroughs[ref] = {
    status: "completed",
    stepId: null,
    completedSteps: [...new Set([...(cur?.completedSteps ?? []), ...all])],
    updatedAt: Date.now(),
    completedAt: cur?.completedAt ?? Date.now(),
  };
  writeMirror(state.progress);
  emit();
  const res = await rpc<{ progress?: GuidedProgress; minted?: string[] }>("learn.guided.progress.update", {
    trackId,
    walkthroughId,
    event: "complete",
  });
  if (res?.progress) {
    state.progress = { ...res.progress, session: state.progress.session };
    writeMirror(state.progress);
    emit();
  }
  return res?.minted ?? [];
}

export async function resetWalkthrough(trackId: string, walkthroughId: string): Promise<void> {
  delete state.progress.walkthroughs[walkthroughRef(trackId, walkthroughId)];
  writeMirror(state.progress);
  emit();
  await rpc("learn.guided.progress.update", { trackId, walkthroughId, event: "reset" });
}

export type QuizOutcome = {
  score: number;
  total: number;
  passed: boolean;
  results: { id: string; correct: boolean; answer: number; explain?: string }[];
  minted?: string[];
};

export async function submitQuiz(trackId: string, answers: number[]): Promise<QuizOutcome | null> {
  const res = await rpc<QuizOutcome & { progress?: GuidedProgress }>("learn.guided.quiz.submit", { trackId, answers });
  if (res) {
    if (res.progress) {
      state.progress = { ...res.progress, session: state.progress.session };
      writeMirror(state.progress);
      emit();
    }
    return res;
  }
  // Local grading (fallback catalog).
  const key = localAnswers[trackId];
  const track = state.tracks.find((t) => t.id === trackId);
  if (!key || !track) return null;
  const results = track.quiz.map((q, i) => ({ id: q.id, correct: answers[i] === key[i], answer: key[i]!, explain: q.explain }));
  const score = results.filter((r) => r.correct).length;
  const passed = score / key.length >= QUIZ_PASS_RATIO;
  const prev = state.progress.quizzes[trackId];
  if (!prev || (!prev.passed && (passed || score > prev.score))) {
    state.progress.quizzes[trackId] = { score, total: key.length, passed, at: Date.now() };
  }
  writeMirror(state.progress);
  emit();
  return { score, total: key.length, passed, results };
}

export function pref<T = unknown>(key: string): T | undefined {
  return state.progress.prefs[key] as T | undefined;
}

export async function setPref(key: string, value: unknown): Promise<void> {
  if (value === null || value === undefined) delete state.progress.prefs[key];
  else state.progress.prefs[key] = value;
  writeMirror(state.progress);
  emit();
  await rpc("learn.guided.prefs.set", { key, value: value ?? null });
}

export async function setSession(session: GuidedProgress["session"]): Promise<void> {
  state.progress.session = session;
  writeMirror(state.progress);
  await rpc("learn.guided.prefs.set", { key: "session", value: session });
}

/** Test hook. */
export function __resetGuidedStoreForTests(): void {
  state.loaded = false;
  state.loading = false;
  state.error = null;
  state.source = null;
  state.tracks = [];
  state.plugins = [];
  state.missions = [];
  state.progress = emptyProgress();
  localAnswers = {};
  client = null;
  inflight = null;
}

/** Test hook: seed the catalog directly. */
export function __seedGuidedForTests(seed: Partial<GuidedCatalogState> & { answers?: Record<string, number[]> }): void {
  Object.assign(state, { loaded: true, ...seed });
  if (seed.answers) localAnswers = seed.answers;
}

/**
 * Dev / audit hook: validate a track (same parser as the gateway) and add it to
 * the in-memory catalog, replacing any track with the same id. Lets plugin
 * authors and the audit runner try content without rebuilding or restarting.
 * Returns the validation error, or null on success.
 */
export function registerDevTrack(raw: unknown, opts: { pluginId?: string } = {}): string | null {
  const parsed = parseTrack(raw, opts);
  if (!parsed.ok) return parsed.error;
  const track = parsed.value;
  localAnswers[track.id] = track.quiz.map((q) => q.answer);
  state.tracks = [...state.tracks.filter((t) => t.id !== track.id), stripQuizAnswers(track)];
  if (opts.pluginId) {
    const p = state.plugins.find((x) => x.id === opts.pluginId);
    if (p) {
      if (!p.trackIds.includes(track.id)) p.trackIds.push(track.id);
    } else {
      const meta = pluginLinkInfo()?.find((x) => x.id === opts.pluginId);
      state.plugins = [...state.plugins, { id: opts.pluginId, name: meta?.name ?? opts.pluginId, monogram: meta?.appearance?.monogram, trackIds: [track.id] }];
    }
  }
  state.loaded = true;
  emit();
  return null;
}
