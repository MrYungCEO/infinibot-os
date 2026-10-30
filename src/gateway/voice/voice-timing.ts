/**
 * Timing of a live voice call's tool and delegated work: the settings the
 * owner can tune (Robovoice plugin settings → each turn's `voiceTiming`).
 *
 *   fast tools      answered inside the turn: `fastToolTimeoutMs` (≈6 s).
 *   slow tools      known to take longer (web reads, mail, sending to a
 *                   sub-agent…): `slowToolTimeoutMs` (20–30 s) before the work
 *                   moves to the background.
 *   delegated work  never blocks a turn: it runs on the main agent and its
 *                   progress is spoken at most every `progressIntervalMs`.
 *   hang-up         no turn and no update poll for `callIdleMs` = the call is
 *                   over: results go to the chat only.
 */

export type VoiceTimingConfig = {
  /** Budget of a fast tool before it continues in the background. */
  fastToolTimeoutMs: number;
  /** Budget of a tool listed in `slowTools`. */
  slowToolTimeoutMs: number;
  /** Tools that get the slow budget. */
  slowTools: string[];
  /** Minimum gap between two spoken progress updates on one call. */
  progressIntervalMs: number;
  /** Hand work the fast step cannot do quickly to the main agent (async). */
  delegate: boolean;
  /** No turn and no update poll for this long → the call is treated as ended. */
  callIdleMs: number;
};

export const DEFAULT_SLOW_VOICE_TOOLS = [
  "web_search",
  "web_read",
  "web_fetch",
  "research",
  "gmail",
  "sessions_send",
  "subagent_message",
  "sessions_spawn",
  "claude_coder",
  "codex_coder",
  "grok_coder",
  "opencode_coder",
  "show_panel",
] as const;

export const DEFAULT_VOICE_TIMING: Readonly<VoiceTimingConfig> = Object.freeze({
  fastToolTimeoutMs: 6_000,
  slowToolTimeoutMs: 25_000,
  slowTools: [...DEFAULT_SLOW_VOICE_TOOLS],
  progressIntervalMs: 18_000,
  delegate: true,
  callIdleMs: 120_000,
});

function clampMs(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Defaults + owner overrides, clamped to sane ranges. */
export function resolveVoiceTiming(over?: Partial<VoiceTimingConfig> | null): VoiceTimingConfig {
  const d = DEFAULT_VOICE_TIMING;
  const o = over ?? {};
  const fast = clampMs(o.fastToolTimeoutMs, 1_000, 30_000, d.fastToolTimeoutMs);
  return {
    fastToolTimeoutMs: fast,
    slowToolTimeoutMs: Math.max(
      fast,
      clampMs(o.slowToolTimeoutMs, 2_000, 60_000, d.slowToolTimeoutMs),
    ),
    slowTools:
      Array.isArray(o.slowTools) && o.slowTools.length
        ? o.slowTools.filter((t): t is string => typeof t === "string" && !!t.trim())
        : [...d.slowTools],
    progressIntervalMs: clampMs(o.progressIntervalMs, 8_000, 300_000, d.progressIntervalMs),
    delegate: typeof o.delegate === "boolean" ? o.delegate : d.delegate,
    callIdleMs: clampMs(o.callIdleMs, 15_000, 3_600_000, d.callIdleMs),
  };
}

/** The budget of one tool call on a voice turn. */
export function voiceToolTimeoutMs(name: string, timing: VoiceTimingConfig): number {
  return timing.slowTools.includes(name) ? timing.slowToolTimeoutMs : timing.fastToolTimeoutMs;
}
