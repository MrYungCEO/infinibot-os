/**
 * Guided Learn — shared schema (gateway + control UI).
 *
 * A **track** is a course about one area (a core feature or a plugin). It has
 * an overview, 3–6 **walkthroughs** (interactive overlay tours), a short
 * **quiz**, and a completion **badge**. Walkthroughs are sequences of
 * **steps**; each step can navigate to a route, spotlight a real element,
 * wait for the user to do something (click / type / toggle), verify state
 * through a read-only RPC, and branch on conditions.
 *
 * Core tracks ship in `src/learn/guided/core/`. Plugins ship their own via the
 * manifest-v2 contribution `contributes.learn` (docs/plugins/LEARN.md) and
 * only appear while the plugin is enabled.
 *
 * This file is imported by the UI bundle (relative path), so it must stay
 * dependency-free and side-effect-free.
 */

/** A CSS selector, `learn:<id>` (→ `[data-learn-id="<id>"]`), or a list of
 *  fallbacks tried in order. Selectors pierce open shadow roots. */
export type LearnTarget = string | string[];

export type LearnCondition =
  /** A plugin is installed, enabled and loaded. */
  | { kind: "pluginEnabled"; plugin: string }
  /** The gateway advertises this RPC method. */
  | { kind: "method"; method: string }
  /** A UI surface is compiled into this build (see ui/src/learn/guided/surfaces.ts). */
  | { kind: "surface"; surface: string }
  /** A target resolves to a visible element right now. */
  | { kind: "element"; target: LearnTarget }
  /** The current route starts with this path. */
  | { kind: "route"; path: string }
  /** The viewport is at most / at least this wide (CSS px). */
  | { kind: "viewport"; maxWidth?: number; minWidth?: number }
  /** A read-only RPC's result satisfies an expectation (see LearnRpcCheck). */
  | ({ kind: "rpc" } & LearnRpcCheck)
  /** Another walkthrough (`<trackId>/<walkthroughId>`) or track is complete. */
  | { kind: "completed"; ref: string }
  | { kind: "not"; condition: LearnCondition }
  | { kind: "all"; conditions: LearnCondition[] }
  | { kind: "any"; conditions: LearnCondition[] };

/**
 * A read-only RPC probe. `path` is a dotted path into the result
 * (`plugins.length`, `goals.0.status`); `*` maps over arrays
 * (`plugins.*.enabled`). With no expectation the value must be truthy.
 * Only read methods are allowed (see `isReadOnlyMethod`).
 */
export type LearnRpcCheck = {
  method: string;
  params?: Record<string, unknown>;
  path?: string;
  equals?: string | number | boolean | null;
  /** Array/string length, or number value, is at least this. */
  min?: number;
  /** When `path` hits an array (or `*`), at least one element equals this. */
  includes?: string | number | boolean;
};

/** What the user must do before the step advances. */
export type LearnAction =
  | { kind: "click"; target?: LearnTarget }
  | {
      kind: "input";
      target?: LearnTarget;
      /** Case-insensitive substring the value must contain (default: any non-empty). */
      match?: string;
      /** Text the automated audit types (and the "Do it for me" button fills). */
      sample?: string;
    }
  | { kind: "toggle"; target?: LearnTarget }
  /** The user navigates to a route (e.g. via the sidebar). */
  | { kind: "navigate"; path: string };

export type LearnPlacement = "auto" | "top" | "bottom" | "left" | "right" | "center";

/**
 * Safe-practice metadata for steps that would otherwise do something risky
 * (place an order, sign a transaction, send a message, spend credits). The
 * engine never performs the risky action: `explain` shows the note instead of
 * waiting for the action; `sandbox` means the step runs against paper / mock
 * data the note describes.
 */
export type LearnPractice = { mode: "explain" | "sandbox"; note: string };

export type LearnStep = {
  id: string;
  title: string;
  /** Short markdown-ish body (plain text, `**bold**`, `` `code` `` supported). */
  body: string;
  /** Route to open before the step (`/infinitrade/journal`). */
  route?: string;
  /** Element to spotlight. Omit for a centered card. */
  target?: LearnTarget;
  placement?: LearnPlacement;
  /** Wait for the user to act. Omit → the user clicks Next. */
  action?: LearnAction;
  /** State that must hold before Next unlocks (polled). */
  check?: LearnCondition;
  /** Human text for the check ("Enable any plugin to continue"). */
  checkHint?: string;
  /** Skip this step when the condition holds. */
  skipIf?: LearnCondition;
  /** Conditional jumps evaluated when the step completes (first match wins). */
  branches?: { when: LearnCondition; goto: string }[];
  practice?: LearnPractice;
  /** The step may be skipped without breaking the tour. */
  optional?: boolean;
  /** How long to wait for the target before offering "skip" (ms, default 8000). */
  waitMs?: number;
};

export type LearnWalkthrough = {
  id: string;
  title: string;
  summary: string;
  /** Estimated minutes. */
  estMinutes: number;
  /** Walkthrough refs (`<trackId>/<walkthroughId>` or same-track ids) to do first. */
  prerequisites?: string[];
  /** Only offered when this holds (e.g. a surface exists). */
  requires?: LearnCondition;
  steps: LearnStep[];
};

export type LearnQuizQuestion = {
  id: string;
  prompt: string;
  options: string[];
  /** Index of the correct option. Stripped from the catalog sent to clients. */
  answer: number;
  explain?: string;
};

export type LearnLevel = "beginner" | "intermediate" | "advanced";

export type LearnBadge = { id: string; label: string; icon?: string };

export type LearnTrack = {
  id: string;
  title: string;
  summary: string;
  /** Markdown overview shown on the track page. */
  overview: string;
  category: string;
  level: LearnLevel;
  /** Total estimated minutes (defaults to the sum of the walkthroughs). */
  estMinutes?: number;
  /** Track ids to finish first (advisory — shown as "recommended before"). */
  prerequisites?: string[];
  /** Only listed when this holds. */
  requires?: LearnCondition;
  /** Owning plugin (set by the host for contributed tracks). */
  pluginId?: string;
  /** Routes this track teaches — drives the contextual "Learn this" button. */
  routes?: string[];
  /** Tab / feature ids whose use means the user already knows this area. */
  signals?: string[];
  walkthroughs: LearnWalkthrough[];
  quiz: LearnQuizQuestion[];
  badge: LearnBadge;
  /** Counts toward the core certification ladder. */
  certRequired?: boolean;
  order?: number;
  /** Medical / financial / legal disclaimer shown on the track page. */
  disclaimer?: string;
};

/** A Day-1 mission: a pointer at one walkthrough. */
export type LearnMissionRef = { walkthrough: string; starter?: boolean };

/** `contributes.learn` after parsing. */
export type PluginLearnContribution = {
  tracks: LearnTrack[];
  missions: LearnMissionRef[];
};

/** Quiz question as sent to clients (no answer key). */
export type PublicQuizQuestion = Omit<LearnQuizQuestion, "answer">;
export type PublicLearnTrack = Omit<LearnTrack, "quiz"> & { quiz: PublicQuizQuestion[] };

/** Progress for one walkthrough. */
export type WalkthroughProgress = {
  status: "not_started" | "in_progress" | "completed";
  stepId: string | null;
  completedSteps: string[];
  updatedAt: number;
  completedAt: number | null;
};

export type QuizResult = { score: number; total: number; passed: boolean; at: number };

export type GuidedProgress = {
  userId: string;
  /** Keyed by `<trackId>/<walkthroughId>`. */
  walkthroughs: Record<string, WalkthroughProgress>;
  /** Keyed by trackId. */
  quizzes: Record<string, QuizResult>;
  prefs: Record<string, unknown>;
  /** The tour in flight, for resume on another device / after reload. */
  session: { trackId: string; walkthroughId: string; stepId: string; at: number } | null;
};

export type TrackStatus = {
  trackId: string;
  walkthroughsDone: number;
  walkthroughsTotal: number;
  quizPassed: boolean;
  percent: number;
  completed: boolean;
};

export const QUIZ_PASS_RATIO = 0.7;

/** Read-only RPC names a walkthrough may probe. Anything that could mutate is refused. */
const READ_SUFFIX =
  /(^|[.])(list|get|status|snapshot|summary|search|history|query|info|stats|catalog|health|overview|state|me|current|preview|feed|board)([A-Z][A-Za-z]*)?$/;
const WRITE_WORD =
  /(^|[.])(set|create|update|delete|remove|add|send|run|start|stop|place|sign|submit|execute|enable|disable|write|patch|approve|reject|cancel|trade|order|transfer|buy|sell|spawn|install|uninstall|reset|clear|import|publish|deploy)([A-Z._]|$)/;

export function isReadOnlyMethod(method: string): boolean {
  if (!/^[a-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_]+)+$/.test(method)) return false;
  const tail = method.split(".").slice(1).join(".");
  if (WRITE_WORD.test(tail)) return false;
  return READ_SUFFIX.test(method);
}

/** `learn:<id>` → `[data-learn-id="<id>"]`; lists stay lists. */
export function expandTarget(target: LearnTarget): string[] {
  const list = Array.isArray(target) ? target : [target];
  return list
    .filter((t) => typeof t === "string" && t.trim())
    .map((t) => (t.startsWith("learn:") ? `[data-learn-id="${t.slice(6)}"]` : t));
}

export function walkthroughRef(trackId: string, walkthroughId: string): string {
  return `${trackId}/${walkthroughId}`;
}

/** Compute a track's completion from progress. */
export function trackStatus(
  track: Pick<LearnTrack, "id" | "walkthroughs"> & { quiz: readonly unknown[] },
  progress: Pick<GuidedProgress, "walkthroughs" | "quizzes"> | null,
): TrackStatus {
  // Walkthroughs behind a `requires` guard (e.g. UI a build may not have) are
  // bonus content: they never block completion or a badge.
  const core = track.walkthroughs.filter((w) => !w.requires);
  const counted = core.length > 0 ? core : track.walkthroughs;
  const total = counted.length;
  const done = counted.filter(
    (w) => progress?.walkthroughs[walkthroughRef(track.id, w.id)]?.status === "completed",
  ).length;
  const hasQuiz = track.quiz.length > 0;
  const quizPassed = hasQuiz ? Boolean(progress?.quizzes[track.id]?.passed) : true;
  const units = total + (hasQuiz ? 1 : 0);
  const got = done + (hasQuiz && quizPassed ? 1 : 0);
  const percent = units === 0 ? 0 : Math.round((got / units) * 100);
  return {
    trackId: track.id,
    walkthroughsDone: done,
    walkthroughsTotal: total,
    quizPassed,
    percent,
    completed: units > 0 && got === units,
  };
}

export function stripQuizAnswers(track: LearnTrack): PublicLearnTrack {
  return { ...track, quiz: track.quiz.map(({ answer: _answer, ...q }) => q) };
}
