/**
 * Spoken acknowledgements on a live voice call — WHEN to say one and WHAT.
 *
 * The old path said "One moment, let me check." the instant any turn went to
 * the full agent, before every answer, whether the work took 300 ms or 30 s.
 * Callers heard the same six words in front of nearly every reply.
 *
 * Policy:
 *   - No tool / no hand-off  → never acknowledge: the answer itself is first.
 *   - Work in flight         → acknowledge only when nothing has been spoken
 *                              `ACK_DELAY_MS` after the work started. The ack
 *                              is spoken IN PARALLEL with the work (a timer,
 *                              never an awaited turn), so a fast tool answers
 *                              without any filler at all.
 *   - Varied                 → pools per intent, never the same phrase twice
 *                              in a row on a call, and the last few phrases of
 *                              the call are avoided.
 *   - Canned phrases banned  → a model-written ack that is the old canned line
 *                              (or just repeats the previous ack) is replaced.
 */

export const ACK_DELAY_MS = 700;

export type AckIntent = "lookup" | "action" | "status" | "delegate" | "generic";

/**
 * Spoken when a task is delegated (voice-delegate.ts). Never narrates a relay
 * ("handing that to the main agent"): the caller is talking to one assistant.
 */
export const DELEGATE_ACKS = [
  "On it. I'll keep you posted.",
  "Got it, working on that now. I'll update you as it goes.",
  "Sure, I'm on it and I'll let you know how it goes.",
];

const POOLS: Record<AckIntent, string[]> = {
  lookup: [
    "Sure, pulling that up.",
    "Okay, looking.",
    "Checking now.",
    "Let me see.",
    "Looking into it.",
  ],
  action: [
    "On it.",
    "Sure, doing that now.",
    "Okay, on it.",
    "Got it, working on it.",
    "Right away.",
  ],
  status: ["Let me see where that's at.", "Checking on it.", "Okay, one sec.", "Let me look."],
  delegate: [
    "On it. I'll keep you posted.",
    "Got it, working on that now. I'll update you as it goes.",
    "Sure, I'm on it and I'll let you know how it goes.",
  ],
  generic: ["Sure.", "Okay, one sec.", "Got it.", "Mm-hm, checking.", "Alright."],
};

/** Old canned lines and near variants: never spoken as an acknowledgement. */
const BANNED = [
  /^one moment,? let me check\.?$/i,
  /^one moment\.?$/i,
  /^let me check\.?$/i,
  /^on it,? one moment\.?$/i,
  /^one moment,? checking\.?$/i,
];

const MAX_CALLS = 500;
const RECENT = 3;
const recentByCall = new Map<string, string[]>();

function norm(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ");
}

export function isBannedAck(text: string): boolean {
  const t = text.trim();
  return !t || BANNED.some((re) => re.test(t));
}

/** Intent of the request, from the tools the model picked (or the utterance). */
export function ackIntentFor(toolNames: string[] = [], utterance = ""): AckIntent {
  const names = toolNames.map((n) => n.toLowerCase());
  if (names.some((n) => /spawn|coder|goal_run|queue_run|research|workflow/.test(n)))
    return "delegate";
  if (
    names.some((n) => /send|message|telegram|gmail|email|cron|schedul|remind|create|update/.test(n))
  )
    return "action";
  if (names.some((n) => /subagents|sessions_list|status|events|wait/.test(n))) return "status";
  if (names.length) return "lookup";
  const u = utterance.toLowerCase();
  if (
    /\b(send|make|create|spawn|start|launch|remind|schedule|book|write|deploy|build|fix)\b/.test(u)
  )
    return "action";
  if (/\b(status|progress|done|finished|working on|update)\b/.test(u)) return "status";
  if (/\b(check|find|look|search|what|who|when|where|how many)\b/.test(u)) return "lookup";
  return "generic";
}

/**
 * The acknowledgement to speak for this call: the model's own words when they
 * are fresh and not canned, else the next unused phrase of the intent's pool.
 */
export function pickAck(callKey: string, intent: AckIntent, modelAck?: string): string {
  const recent = recentByCall.get(callKey) ?? [];
  const recentNorm = new Set(recent.map(norm));
  let choice: string | undefined;
  const candidate = modelAck?.trim();
  if (
    candidate &&
    candidate.length <= 80 &&
    !isBannedAck(candidate) &&
    !recentNorm.has(norm(candidate))
  ) {
    choice = candidate;
  }
  if (!choice) {
    const pool = POOLS[intent] ?? POOLS.generic;
    const offset = recent.length % pool.length;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[(offset + i) % pool.length];
      if (!recentNorm.has(norm(p))) {
        choice = p;
        break;
      }
    }
    choice ??= pool[(offset + 1) % pool.length];
  }
  const next = [...recent, choice].slice(-RECENT);
  recentByCall.delete(callKey);
  recentByCall.set(callKey, next);
  if (recentByCall.size > MAX_CALLS) recentByCall.delete(recentByCall.keys().next().value!);
  return /[.!?…]$/.test(choice) ? choice : `${choice}.`;
}

export function clearAcksForTests(): void {
  recentByCall.clear();
}

/**
 * Speak `phrase()` after `delayMs` unless something was spoken first.
 * Returns a cancel function; never blocks the work it covers.
 */
export function scheduleAck(opts: {
  delayMs?: number;
  spoken: () => boolean;
  speak: (text: string) => void;
  phrase: () => string;
}): { cancel: () => void; fired: () => boolean } {
  let fired = false;
  const timer = setTimeout(() => {
    if (opts.spoken()) return;
    fired = true;
    opts.speak(opts.phrase());
  }, opts.delayMs ?? ACK_DELAY_MS);
  return {
    cancel: () => clearTimeout(timer),
    fired: () => fired,
  };
}
