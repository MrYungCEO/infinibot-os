/**
 * Viral Structure Rules — SINGLE SOURCE OF TRUTH for the viral-video structure
 * distilled from the transcribed-exemplar library (the moat).
 *
 * Both consumers read from here and ONLY here:
 *   - the script-agent system prompt (script-agent-prompt.ts) — turns these
 *     rules into instructions the agent must follow.
 *   - the post-generation lint (viral-lint.ts) — flags violations of the same
 *     rules so the agent can fix them before returning.
 *
 * If you change the structure, change it HERE. Do not re-encode hook windows,
 * banned phrases, or beat order anywhere else.
 */

import type { Platform } from "../../storyboard/types.js";

/**
 * Phrases that never appear in a high-performing script. Distilled from the
 * original storyboard generator's BANNED list plus the recurring filler the
 * exemplar transcripts conspicuously avoid. Matched case-insensitively as a
 * substring against VOICEOVER text by the lint.
 */
export const BANNED_FILLER: readonly string[] = [
  "in today's video",
  "in todays video",
  "let's dive in",
  "lets dive in",
  "hey guys",
  "what's up guys",
  "welcome back",
  "without further ado",
  "at the end of the day",
  "it is what it is",
  "in this video i'm going to",
  "in this video im going to",
  "make sure to like and subscribe",
  "smash that like button",
  "don't forget to subscribe",
  "guys",
  "basically",
  "literally just",
  "so yeah",
] as const;

/**
 * A few BANNED entries are legitimate inside an explicit CTA scene (the whole
 * point of a CTA is to ask for the follow). The lint exempts these when the
 * offending line is in the final/CTA beat.
 */
export const CTA_EXEMPT_FILLER: readonly string[] = [
  "make sure to like and subscribe",
  "smash that like button",
  "don't forget to subscribe",
] as const;

/** The ordered structural beats every viral script must move through. */
export interface StructureBeat {
  key: "hook" | "pattern_interrupt" | "value_proof" | "cta";
  label: string;
  description: string;
}

export const STRUCTURE_BEATS: readonly StructureBeat[] = [
  {
    key: "hook",
    label: "HOOK",
    description:
      "Open on the single most arresting idea. Bold claim, contrarian framing, open loop, or a pointed question. No greeting, no throat-clearing, no agenda-setting.",
  },
  {
    key: "pattern_interrupt",
    label: "PATTERN INTERRUPT",
    description:
      "Within the first few seconds, break the expected rhythm — a reframe, an unexpected stat, a 'but here's the thing' pivot — so the scroll-reflex never fires.",
  },
  {
    key: "value_proof",
    label: "VALUE / PROOF STACK",
    description:
      "Deliver a concrete payoff every few seconds: a specific number, name, place, demonstration, or story beat. Each scene must earn its place with a reveal or a detail — never a generic claim.",
  },
  {
    key: "cta",
    label: "CTA / PAYOFF",
    description:
      "Close with a clear payoff or call to action that matches the platform. Never trail off; the last line lands the promise the hook made.",
  },
] as const;

export interface PlatformPacing {
  name: string;
  /** Max words the hook (scene 1 voiceover) gets before it must land. */
  hookWindowWords: number;
  /** Target seconds per scene/beat. */
  targetSceneSec: number;
  /** How the CTA should read on this platform. */
  ctaStyle: string;
  /** Default total duration in seconds when the caller doesn't specify. */
  defaultDurationSec: number;
  notes: string;
}

/**
 * Per-platform pacing. Short-form (tiktok/shorts/instagram) gets an aggressive
 * 7-word hook window and tight scenes; YouTube longform gets a slightly wider
 * hook window and longer scenes; X sits between. `custom` is the neutral
 * default. Keyed by Platform plus the agent-only extension platforms.
 */
export const PLATFORM_PACING: Record<string, PlatformPacing> = {
  tiktok: {
    name: "TikTok",
    hookWindowWords: 7,
    targetSceneSec: 4,
    ctaStyle:
      "Soft, native CTA — a follow-for-part-2 or a comment prompt. Never a hard 'subscribe' read.",
    defaultDurationSec: 30,
    notes: "Fastest pacing. Payoff cadence every 3–5s. Mention a concrete detail by word 12.",
  },
  shorts: {
    name: "YouTube Shorts",
    hookWindowWords: 7,
    targetSceneSec: 4,
    ctaStyle: "Loop-friendly close or a single follow prompt. Keep it native, not salesy.",
    defaultDurationSec: 35,
    notes:
      "Vertical, sound-on. Hook must survive the first 1.5s of muted autoplay — front-load on-screen text in VISUAL.",
  },
  instagram: {
    name: "Instagram Reels",
    hookWindowWords: 7,
    targetSceneSec: 4,
    ctaStyle: "Save/share prompt or a 'follow for more' that fits the aesthetic.",
    defaultDurationSec: 30,
    notes: "Aesthetic-forward. Hook line and first VISUAL must both pop.",
  },
  youtube: {
    name: "YouTube (longform)",
    hookWindowWords: 25,
    targetSceneSec: 12,
    ctaStyle:
      "Earned CTA after value is delivered — subscribe is allowed once the payoff has landed.",
    defaultDurationSec: 480,
    notes:
      "Wider hook window but still no filler. Establish stakes in the first 25 words; re-hook every 30–45s.",
  },
  x: {
    name: "X / Twitter video",
    hookWindowWords: 12,
    targetSceneSec: 5,
    ctaStyle:
      "Reply-bait or a quote-able line as the close. Avoid platform-foreign 'subscribe' language.",
    defaultDurationSec: 45,
    notes: "Text-overlay heavy. The hook doubles as the post copy — make it screenshot-worthy.",
  },
  custom: {
    name: "Video",
    hookWindowWords: 12,
    targetSceneSec: 6,
    ctaStyle: "Clear payoff or single CTA appropriate to where it will be posted.",
    defaultDurationSec: 60,
    notes: "Neutral pacing. When in doubt, lean short-form-tight.",
  },
};

/** The set of platform keys the agent accepts (superset of storyboard Platform). */
export type AgentPlatform = Platform | "x";

export function resolvePacing(platform: string | undefined): PlatformPacing {
  if (platform && PLATFORM_PACING[platform]) return PLATFORM_PACING[platform];
  return PLATFORM_PACING.custom;
}

export function isShortForm(platform: string | undefined): boolean {
  return platform === "tiktok" || platform === "shorts" || platform === "instagram";
}

/**
 * Render the structure rules as a prompt block. This is the ONLY place the
 * structure is verbalized for the model — the agent prompt splices this in.
 */
export function buildStructureRulesBlock(platform: string | undefined): string {
  const pacing = resolvePacing(platform);
  const beats = STRUCTURE_BEATS.map((b, i) => `  ${i + 1}. ${b.label} — ${b.description}`).join(
    "\n",
  );
  return [
    `VIRAL STRUCTURE (derived from transcribed top-performing ${pacing.name} videos — this is non-negotiable):`,
    beats,
    "",
    `PLATFORM PACING — ${pacing.name}:`,
    `  - HOOK must land within the first ${pacing.hookWindowWords} words of scene 1's VOICEOVER.`,
    `  - Target ~${pacing.targetSceneSec}s per scene.`,
    `  - CTA style: ${pacing.ctaStyle}`,
    `  - ${pacing.notes}`,
    "",
    "BANNED FILLER (never use, except like/subscribe language inside an explicit CTA scene):",
    `  ${BANNED_FILLER.join(" · ")}`,
    "",
    "HARD RULES:",
    "  - Every scene earns its place with a payoff, reveal, or concrete detail (a name, number, place, or sensory beat).",
    "  - Each VOICEOVER sentence is speakable in one breath (≤ 18 words).",
    "  - Prefer concrete over abstract. Never paraphrase a generic claim when a specific number is available.",
    "  - End on a clear payoff or CTA — never trail off.",
  ].join("\n");
}
