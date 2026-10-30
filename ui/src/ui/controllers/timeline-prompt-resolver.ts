/**
 * Timeline Prompt Resolver — Phase 8 addendum
 *
 * Resolves @-mention slots in beat plans to concrete refs (characters, assets,
 * locations) drawn from the storyboard project. Produces:
 *  - per-beat prompt lines
 *  - a single concatenated prompt for multi-shot routers
 *  - a deduped, priority-ordered list of refs to attach to the generation call
 *  - validation errors for unbound mentions, overflows, and sequential gaps
 */

import type {
  StoryboardProject,
  Scene,
  CharacterRef,
  TimelineBeat,
  TimelinePromptingProject,
  ValidationError,
  StoryboardMode,
} from "../../../../src/storyboard/types.js";

const MENTION_RE = /@([a-zA-Z][\w-]*)/g;

export interface ResolveResult {
  resolved: string;
  refs: string[];
}

/**
 * Find @mentions in `text` and resolve them against the project's slot maps.
 * Unbound mentions are left in place (validator will catch them).
 */
export function resolveMentions(text: string, project: StoryboardProject): ResolveResult {
  const refs: string[] = [];
  const plan = project.timelinePrompting;
  const resolved = text.replace(MENTION_RE, (match, key: string) => {
    const slotKey = `@${key}`;

    // Character slots first
    const charId = plan?.characterSlots?.[slotKey];
    if (charId) {
      const c = project.characters.find(x => x.id === charId);
      if (c) {
        refs.push(c.name);
        return c.name;
      }
    }
    // Asset slots
    const assetId = plan?.assetSlots?.[slotKey];
    if (assetId) {
      refs.push(assetId);
      return assetId;
    }
    // Location slots
    const locId = plan?.locationSlots?.[slotKey];
    if (locId) {
      refs.push(locId);
      return locId;
    }
    // Direct character-name match (no slot binding required)
    const direct = project.characters.find(
      c => c.name.toLowerCase().replace(/\s+/g, "-") === key.toLowerCase()
    );
    if (direct) {
      refs.push(direct.name);
      return direct.name;
    }
    return match;
  });
  return { resolved, refs };
}

/**
 * Resolve a single beat into one prompt line plus its collected refs.
 */
export function resolveBeat(
  beat: TimelineBeat,
  project: StoryboardProject
): { promptLine: string; refs: string[] } {
  const refs: string[] = [];

  const collect = (text: string) => {
    const r = resolveMentions(text, project);
    refs.push(...r.refs);
    return r.resolved;
  };

  // manualOverride wins entirely if set
  if (beat.manualOverride && beat.manualOverride.trim()) {
    const out = collect(beat.manualOverride.trim());
    return { promptLine: `[${beat.startSec}–${beat.endSec}s] ${out}`, refs };
  }

  const action = collect(beat.action || "");
  const camera = collect(beat.camera || "");
  const audio = collect(beat.audioNotes || "");

  // Subjects/assets/locations → resolved names
  const subjectNames = (beat.subjects || []).map(k => {
    const id = project.timelinePrompting?.characterSlots?.[k];
    const c = id ? project.characters.find(x => x.id === id) : null;
    if (c) refs.push(c.name);
    return c?.name || k;
  });

  const parts: string[] = [];
  if (action) parts.push(action);
  if (camera) parts.push(`Camera: ${camera}`);
  if (subjectNames.length) parts.push(`Subjects: ${subjectNames.join(", ")}`);
  if (beat.onScreenText) parts.push(`On-screen text: "${beat.onScreenText}"`);
  if (audio) parts.push(`Audio: ${audio}`);
  if (beat.transition) parts.push(`Transition: ${beat.transition}`);

  return {
    promptLine: `[${beat.startSec}–${beat.endSec}s] ${parts.join(". ")}`,
    refs,
  };
}

/**
 * Resolve every beat in a plan into one combined multi-shot prompt + a
 * priority-ordered, deduped list of refs.
 *
 * Priority order for refs:
 *   1. Products / explicit assets
 *   2. Scene-explicit refs (lead characters)
 *   3. Other characters
 *   4. Locations
 */
export function resolveTimelinePrompts(
  beats: TimelineBeat[],
  project: StoryboardProject
): { prompt: string; refs: string[] } {
  if (!beats.length) {
    return { prompt: project.prompt, refs: [] };
  }
  const allRefs: string[] = [];
  const lines: string[] = [];
  for (const beat of beats) {
    const r = resolveBeat(beat, project);
    lines.push(r.promptLine);
    allRefs.push(...r.refs);
  }

  // Dedupe preserving first-seen order
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const r of allRefs) {
    if (!seen.has(r)) {
      seen.add(r);
      deduped.push(r);
    }
  }

  // Priority sort: leads (first beat's subjects) bubble up
  const leadBeat = beats[0];
  const leadNames = new Set<string>();
  const plan = project.timelinePrompting;
  for (const k of leadBeat.subjects || []) {
    const id = plan?.characterSlots?.[k];
    const c = id ? project.characters.find(x => x.id === id) : null;
    if (c) leadNames.add(c.name);
  }
  deduped.sort((a, b) => {
    const al = leadNames.has(a) ? 0 : 1;
    const bl = leadNames.has(b) ? 0 : 1;
    return al - bl;
  });

  return {
    prompt: lines.join("\n"),
    refs: deduped,
  };
}

/**
 * Validate a beat plan. Returns the full error list; UI gates the Generate
 * button on `valid: false`.
 */
export function validateBeats(
  beats: TimelineBeat[],
  slots: { characters?: Record<string, string | null>; assets?: Record<string, string | null>; locations?: Record<string, string | null> },
  scenes: Scene[] | undefined,
  totalDuration: number,
  mode: StoryboardMode
): { valid: boolean; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  for (const beat of beats) {
    if (beat.endSec <= beat.startSec) {
      errors.push({
        beatId: beat.id,
        code: "invalid-range",
        message: `Beat has invalid range ${beat.startSec}–${beat.endSec}s`,
      });
    }
    if (totalDuration > 0 && beat.endSec > totalDuration) {
      errors.push({
        beatId: beat.id,
        code: "overflow",
        message: `Beat ends at ${beat.endSec}s, past total duration ${totalDuration}s`,
      });
    }

    const checkSlot = (key: string, bucket: "characters" | "assets" | "locations", field: string) => {
      const map = slots[bucket] || {};
      if (!(key in map) || map[key] == null) {
        errors.push({
          beatId: beat.id,
          field,
          code: "unbound-slot",
          message: `Unbound slot ${key} in beat ${beat.id}`,
        });
      }
    };

    for (const s of beat.subjects || []) checkSlot(s, "characters", "subjects");
    for (const a of beat.assets || []) checkSlot(a, "assets", "assets");
    for (const l of beat.locations || []) checkSlot(l, "locations", "locations");

    // Mentions embedded in free-text fields also need slot bindings
    const allText = `${beat.action} ${beat.camera} ${beat.audioNotes} ${beat.manualOverride}`;
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    const re = new RegExp(MENTION_RE.source, "g");
    while ((m = re.exec(allText))) {
      const key = `@${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const inAnyBucket =
        slots.characters?.[key] || slots.assets?.[key] || slots.locations?.[key];
      if (!inAnyBucket) {
        errors.push({
          beatId: beat.id,
          field: "mention",
          code: "unbound-slot",
          message: `Unbound mention ${key} in beat ${beat.id}`,
        });
      }
    }
  }

  // Sequential mode: each beat must lie within exactly one scene boundary
  if (mode === "sequential" && scenes && scenes.length) {
    const boundaries: { start: number; end: number }[] = [];
    let t = 0;
    for (const s of scenes) {
      boundaries.push({ start: t, end: t + s.durationSeconds });
      t += s.durationSeconds;
    }
    for (const beat of beats) {
      const fitsOne = boundaries.some(b => beat.startSec >= b.start && beat.endSec <= b.end);
      if (!fitsOne) {
        errors.push({
          beatId: beat.id,
          code: "gap-crossing-boundary",
          message: `Beat ${beat.startSec}–${beat.endSec}s crosses a scene boundary (sequential mode)`,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Estimate generation cost from a beat plan.
 * Used by the pre-generation review modal's CostBadge.
 */
export function estimatePlanCost(
  beats: TimelineBeat[],
  refCount: number,
  model: string
): { beatCount: number; refCount: number; model: string; estimateLabel: string } {
  // Heuristic — concrete numbers handled by existing cost system.
  const beatCost = beats.length * 1;
  const refCost = refCount * 0.25;
  const total = beatCost + refCost;
  return {
    beatCount: beats.length,
    refCount,
    model,
    estimateLabel: `~${total.toFixed(2)} credits`,
  };
}

/**
 * Plan summary string for the review modal (per generation mode).
 */
export function describePlan(beats: TimelineBeat[], mode: StoryboardMode): string {
  if (!beats.length) return "No beats authored — using existing prompt.";
  switch (mode) {
    case "video":
      // Seedance-style multi-shot batching: ~4 beats per call
      const calls = Math.max(1, Math.ceil(beats.length / 4));
      return `Will run as ${calls} multi-shot call${calls === 1 ? "" : "s"} (${beats.length} beats)`;
    case "sequential":
      return `Will run as ${beats.length} sequential image+video pair${beats.length === 1 ? "" : "s"}`;
    case "image":
      return `Will generate ${beats.length} still image${beats.length === 1 ? "" : "s"}`;
    case "recreate":
      return `Will recreate using ${beats.length} mapped beat${beats.length === 1 ? "" : "s"}`;
    case "timeline-prompting":
      return `${beats.length} beat${beats.length === 1 ? "" : "s"} ready for generation`;
    default:
      return `${beats.length} beats authored`;
  }
}

// Convenience constructors
export function emptyTimelinePlan(): TimelinePromptingProject {
  return {
    beats: [],
    totalDurationSec: 0,
    characterSlots: {},
    assetSlots: {},
    locationSlots: {},
  };
}

export function newBeat(startSec: number, endSec: number): TimelineBeat {
  return {
    id: `beat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    startSec,
    endSec,
    action: "",
    camera: "",
    audioNotes: "",
    manualOverride: "",
    subjects: [],
    assets: [],
    locations: [],
  };
}
