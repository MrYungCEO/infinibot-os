/**
 * Learn-missions controller — client-side state machine for the
 * onboarding missions (the floating Learn pill + missions rail).
 *
 * All state is persisted to localStorage under a single versioned key so it
 * survives reloads and is shared across every surface that renders missions.
 * Nothing here touches the gateway — missions are self-contained walkthroughs
 * (see `extra-walkthroughs.ts`); the gateway's `learn.*` tracks are a separate,
 * server-backed system.
 *
 * Stored shape (`infinibot.learn.progress.v1`):
 *   {
 *     version: 1,
 *     progress:  { [missionId]: { completedSteps: string[], completedAt?: number } },
 *     achievements: string[],        // mission ids that minted a badge
 *     touched:   string[],           // tab ids the user has visited
 *     autoPopped: boolean,           // first-run modal has been shown once
 *   }
 */

import { BASE_MISSIONS, type LearnMission } from "../../learn/extra-walkthroughs";

export const PROGRESS_KEY = "infinibot.learn.progress.v1";

export interface MissionProgress {
  completedSteps: string[];
  completedAt?: number;
}

export interface LearnStore {
  version: 1;
  progress: Record<string, MissionProgress>;
  achievements: string[];
  touched: string[];
  autoPopped: boolean;
}

export interface MissionProgressView {
  completedSteps: string[];
  completed: number;
  total: number;
  percent: number;
  done: boolean;
  started: boolean;
}

function emptyStore(): LearnStore {
  return { version: 1, progress: {}, achievements: [], touched: [], autoPopped: false };
}

// ── Persistence ─────────────────────────────────────────────────────────────

let _cache: LearnStore | null = null;

export function loadStore(): LearnStore {
  if (_cache) return _cache;
  if (typeof localStorage === "undefined") {
    _cache = emptyStore();
    return _cache;
  }
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LearnStore>;
      _cache = {
        version: 1,
        progress: parsed.progress ?? {},
        achievements: parsed.achievements ?? [],
        touched: parsed.touched ?? [],
        autoPopped: parsed.autoPopped ?? false,
      };
      return _cache;
    }
  } catch {
    /* corrupt — reset */
  }
  _cache = emptyStore();
  return _cache;
}

function saveStore(store: LearnStore): void {
  _cache = store;
  try {
    localStorage?.setItem(PROGRESS_KEY, JSON.stringify(store));
  } catch {
    /* quota / unavailable — keep the in-memory cache */
  }
  notify();
}

// ── Subscriptions ───────────────────────────────────────────────────────────

const listeners = new Set<() => void>();

export function subscribeLearn(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify(): void {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch {
      /* listener errors are non-fatal */
    }
  }
}

// ── Progress reads ──────────────────────────────────────────────────────────

export function getMissionProgress(mission: LearnMission): MissionProgressView {
  const store = loadStore();
  const p = store.progress[mission.id];
  const total = mission.steps.length || 1;
  const completedSteps = (p?.completedSteps ?? []).filter((id) =>
    mission.steps.some((s) => s.id === id),
  );
  const completed = completedSteps.length;
  const done = !!p?.completedAt || completed >= total;
  return {
    completedSteps,
    completed,
    total,
    percent: Math.round((Math.min(completed, total) / total) * 100),
    done,
    started: completed > 0,
  };
}

export function isFirstRun(): boolean {
  const store = loadStore();
  return Object.keys(store.progress).length === 0;
}

export function hasAutoPopped(): boolean {
  return loadStore().autoPopped;
}

export function markAutoPopped(): void {
  const store = loadStore();
  if (store.autoPopped) return;
  saveStore({ ...store, autoPopped: true });
}

export function getAchievements(): string[] {
  return [...loadStore().achievements];
}

// ── Progress writes ─────────────────────────────────────────────────────────

export function markStepComplete(mission: LearnMission, stepId: string): void {
  const store = loadStore();
  const prev = store.progress[mission.id] ?? { completedSteps: [] };
  const completedSteps = prev.completedSteps.includes(stepId)
    ? prev.completedSteps
    : [...prev.completedSteps, stepId];
  const allDone = mission.steps.every((s) => completedSteps.includes(s.id));
  const next: MissionProgress = {
    completedSteps,
    completedAt: allDone ? prev.completedAt ?? Date.now() : prev.completedAt,
  };
  const achievements =
    allDone && !store.achievements.includes(mission.id)
      ? [...store.achievements, mission.id]
      : store.achievements;
  saveStore({
    ...store,
    progress: { ...store.progress, [mission.id]: next },
    achievements,
  });
}

/** Mark a whole mission complete (used when a coachmark sequence finishes). */
export function markMissionComplete(mission: LearnMission): void {
  for (const step of mission.steps) markStepComplete(mission, step.id);
}

/** Reset a mission so its CTA reads "Replay" but keeps the earned badge. */
export function resetMissionProgress(missionId: string): void {
  const store = loadStore();
  if (!store.progress[missionId]) return;
  const progress = { ...store.progress };
  delete progress[missionId];
  saveStore({ ...store, progress });
}

// ── Feature-touch tracking (drives recommended-next) ────────────────────────

export function markTouched(tab: string): void {
  const store = loadStore();
  if (store.touched.includes(tab)) return;
  saveStore({ ...store, touched: [...store.touched, tab] });
}

export function hasTouched(tab: string): boolean {
  return loadStore().touched.includes(tab);
}

/**
 * Recommend the next mission to surface.
 *
 * Heuristic, in priority order:
 *   1. If the user has opened /agents but never /workflows, push "Build a
 *      Workflow" (the canonical guided nudge).
 *   2. The first incomplete *starter* mission.
 *   3. The first incomplete mission overall.
 */
export function recommendedNextId(missions: LearnMission[]): string | null {
  const store = loadStore();
  const incomplete = missions.filter((m) => !getMissionProgress(m).done);
  if (incomplete.length === 0) return null;

  if (store.touched.includes("agents") && !store.touched.includes("workflows")) {
    const wf = incomplete.find((m) => /workflow/i.test(m.id) || /workflow/i.test(m.title));
    if (wf) return wf.id;
  }

  const starter = incomplete.find((m) => m.starter);
  if (starter) return starter.id;

  return incomplete[0]!.id;
}

/** The Day-1 starter queue, capped to the first 3 incomplete starter missions. */
export function starterQueue(missions: LearnMission[]): LearnMission[] {
  return missions
    .filter((m) => m.starter)
    .filter((m) => !getMissionProgress(m).done)
    .slice(0, 3);
}

/** Count of missions not yet complete — used for the pill's badge. */
export function incompleteCount(missions: LearnMission[]): number {
  return missions.filter((m) => !getMissionProgress(m).done).length;
}

/** Convenience: the default front-end mission catalog. */
export function defaultMissions(): LearnMission[] {
  return BASE_MISSIONS;
}
