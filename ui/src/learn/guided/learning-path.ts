/**
 * "Your learning path" — a personal, ordered list of guided walkthroughs built
 * from the onboarding answers ("What are you using InfiniBot for?").
 *
 *   onboarding Finish → buildPath(plan.courses, catalog) → savePath()
 *                     → startPath() runs lesson 1 as a real guided tour
 *   each lesson done  → the tour's done card counts down into the next one
 *                       (nextInPath), until the path is finished
 *
 * Stored as refs only (`track/walkthrough`) in localStorage and in the
 * gateway's Learn prefs (key "path"), so it follows the user across devices and
 * survives catalogue changes: titles and minutes are read from the live
 * catalogue, and lessons whose plugin was turned off are simply skipped.
 */
import { walkthroughRef, type PublicLearnTrack, type WalkthroughProgress } from "../../../../src/learn/guided/types.js";
import { availableTracks, guidedState, loadGuidedCatalog, pref, setPref } from "./catalog-store";
import { startWalkthrough } from "./engine";

export const PATH_KEY = "infinibot.learn.path.v1";
export const PATH_CHANGED = "infinibot:learn-path-changed";

/** Every path teaches running agents in parallel early on (the thing new users miss most). */
export const PARALLEL_REF = "agents/parallel-sub-agents";

export interface StoredPath {
  v: 1;
  refs: string[];
  /** Onboarding use cases the path was built from. */
  useCases: string[];
  /** Courses (track ids) behind the path: lessons of plugins turned on later join it then. */
  courses: string[];
  /** Move on to the next lesson by itself when one finishes. */
  auto: boolean;
  createdAt: number;
}

export interface PathItem {
  ref: string;
  trackId: string;
  walkthroughId: string;
  title: string;
  trackTitle: string;
  estMinutes: number;
}

type Track = Pick<PublicLearnTrack, "id" | "title" | "walkthroughs">;

function splitRef(ref: string): [string, string] {
  const i = ref.indexOf("/");
  return [ref.slice(0, i), ref.slice(i + 1)];
}

/** Walkthroughs of a track in an order that respects their own prerequisites. */
function orderedWalkthroughs(track: Track): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const byId = new Map(track.walkthroughs.map((w) => [w.id, w] as const));
  const visit = (id: string, depth = 0) => {
    if (seen.has(id) || depth > 20) return;
    const w = byId.get(id);
    if (!w) return;
    for (const pre of w.prerequisites ?? []) {
      const [t, wt] = splitRef(pre);
      if (t === track.id) visit(wt, depth + 1);
    }
    seen.add(id);
    out.push(id);
  };
  for (const w of track.walkthroughs) visit(w.id);
  return out;
}

/**
 * Pure: the ordered lesson refs for these courses. Each course contributes up
 * to `perTrack` walkthroughs; the parallel sub-agents lesson goes in right
 * after the first course; at most `max` lessons so the path stays doable.
 */
export function buildPath(courses: readonly string[], tracks: readonly Track[], opts: { perTrack?: number; max?: number } = {}): string[] {
  const perTrack = opts.perTrack ?? 2;
  const max = opts.max ?? 12;
  const byId = new Map(tracks.map((t) => [t.id, t] as const));
  const refs: string[] = [];
  const add = (ref: string) => {
    if (!refs.includes(ref)) refs.push(ref);
  };
  const has = (ref: string) => {
    const [t, wt] = splitRef(ref);
    return Boolean(byId.get(t)?.walkthroughs.some((w) => w.id === wt));
  };
  courses.forEach((courseId, i) => {
    const track = byId.get(courseId);
    if (track) {
      for (const wt of orderedWalkthroughs(track).slice(0, perTrack)) add(walkthroughRef(track.id, wt));
    }
    if (i === 0 && has(PARALLEL_REF)) add(PARALLEL_REF);
  });
  if (!courses.length && has(PARALLEL_REF)) add(PARALLEL_REF);
  return refs.slice(0, max);
}

/** Resolve refs against the live catalogue (unknown / switched-off lessons drop out). */
export function resolvePath(refs: readonly string[], tracks: readonly Track[]): PathItem[] {
  const byId = new Map(tracks.map((t) => [t.id, t] as const));
  const items: PathItem[] = [];
  for (const ref of refs) {
    const [t, wt] = splitRef(ref);
    const track = byId.get(t);
    const w = track?.walkthroughs.find((x) => x.id === wt);
    if (!track || !w) continue;
    items.push({ ref, trackId: t, walkthroughId: wt, title: w.title, trackTitle: track.title, estMinutes: w.estMinutes ?? 3 });
  }
  return items;
}

export function isDone(ref: string, progress: Record<string, WalkthroughProgress | undefined>): boolean {
  return progress[ref]?.status === "completed";
}

/** First unfinished lesson after `afterRef` (or from the start). */
export function nextInPath(items: readonly PathItem[], progress: Record<string, WalkthroughProgress | undefined>, afterRef?: string): PathItem | null {
  const start = afterRef ? items.findIndex((i) => i.ref === afterRef) + 1 : 0;
  return items.slice(Math.max(0, start)).find((i) => !isDone(i.ref, progress) && i.ref !== afterRef) ?? items.find((i) => !isDone(i.ref, progress) && i.ref !== afterRef) ?? null;
}

export function pathProgress(items: readonly PathItem[], progress: Record<string, WalkthroughProgress | undefined>): { done: number; total: number; minutesLeft: number } {
  const left = items.filter((i) => !isDone(i.ref, progress));
  return { done: items.length - left.length, total: items.length, minutesLeft: left.reduce((n, i) => n + i.estMinutes, 0) };
}

// ── storage ─────────────────────────────────────────────────────────────

function parse(raw: unknown): StoredPath | null {
  const o = raw as Partial<StoredPath> | null;
  if (!o || o.v !== 1 || !Array.isArray(o.refs)) return null;
  return {
    v: 1,
    refs: o.refs.filter((r): r is string => typeof r === "string" && r.includes("/")).slice(0, 40),
    useCases: Array.isArray(o.useCases) ? o.useCases.filter((x): x is string => typeof x === "string") : [],
    courses: Array.isArray(o.courses) ? o.courses.filter((x): x is string => typeof x === "string") : [],
    auto: o.auto !== false,
    createdAt: typeof o.createdAt === "number" ? o.createdAt : Date.now(),
  };
}

/** The saved path: gateway pref first (follows the user), then this browser. */
export function loadPath(): StoredPath | null {
  const fromGateway = parse(pref<StoredPath>("path"));
  if (fromGateway) return fromGateway;
  try {
    return parse(JSON.parse(localStorage.getItem(PATH_KEY) ?? "null"));
  } catch {
    return null;
  }
}

export async function savePath(p: StoredPath | null): Promise<void> {
  try {
    if (p) localStorage.setItem(PATH_KEY, JSON.stringify(p));
    else localStorage.removeItem(PATH_KEY);
  } catch {
    /* private mode */
  }
  try {
    window.dispatchEvent(new CustomEvent(PATH_CHANGED));
  } catch {
    /* no window */
  }
  await setPref("path", p).catch(() => undefined);
}

/** Build + save the path for these courses (onboarding Finish). */
export async function createPath(courses: readonly string[], useCases: readonly string[]): Promise<PathItem[]> {
  await loadGuidedCatalog();
  const tracks = availableTracks();
  const refs = buildPath(courses, tracks);
  await savePath({ v: 1, refs, useCases: [...useCases], courses: [...courses], auto: true, createdAt: Date.now() });
  return resolvePath(refs, tracks);
}

/** The saved path resolved against today's catalogue. */
export function currentPath(): { stored: StoredPath; items: PathItem[] } | null {
  const stored = loadPath();
  if (!stored) return null;
  const tracks = availableTracks();
  // Plugins turned on after onboarding (their tracks appear later) add their lessons.
  const refs = mergeRefs(stored.refs, buildPath(stored.courses, tracks));
  return { stored, items: resolvePath(refs, tracks) };
}

/** Keep the saved order, then add new refs at the end. */
export function mergeRefs(saved: readonly string[], fresh: readonly string[], max = 16): string[] {
  const out = [...saved];
  for (const r of fresh) if (!out.includes(r) && out.length < max) out.push(r);
  return out;
}

export function walkthroughProgressMap(): Record<string, WalkthroughProgress | undefined> {
  return guidedState().progress.walkthroughs;
}

/** Start the next unfinished lesson of the path. Resolves false when there's nothing left. */
export async function startPath(afterRef?: string): Promise<boolean> {
  await loadGuidedCatalog();
  const cur = currentPath();
  if (!cur) return false;
  const next = nextInPath(cur.items, walkthroughProgressMap(), afterRef);
  if (!next) return false;
  const p = walkthroughProgressMap()[next.ref];
  return startWalkthrough(next.trackId, next.walkthroughId, { stepId: p?.status === "in_progress" ? (p.stepId ?? undefined) : undefined });
}

/** The lesson after this one, when it's part of the user's path. */
export function pathNextAfter(ref: string): PathItem | null {
  const cur = currentPath();
  if (!cur || !cur.items.some((i) => i.ref === ref)) return null;
  return nextInPath(cur.items, walkthroughProgressMap(), ref);
}

export async function setPathAuto(auto: boolean): Promise<void> {
  const p = loadPath();
  if (p) await savePath({ ...p, auto });
}
