/**
 * Composing an escalation *as the employee who raised it*.
 *
 * The whole value of a per-worker `CommunicationProfile` is lost the moment
 * every escalation goes out as the same templated system notice. Every field
 * here is resolved through `effectiveChannelProfile`, so the same blocker reads
 * as two lines on Slack from a blunt/terse ops employee and as a signed-off
 * paragraph on email from a formal one, and changing the profile changes the
 * message.
 *
 * Pure — no I/O, no clock. Everything is asserted directly in tests.
 */

import {
  effectiveChannelProfile,
  type CommunicationProfile,
  type CommunicationTone,
  type CommunicationVerbosity,
  type EmojiUsage,
} from "./communication.js";
import {
  MAX_ESCALATION_SUMMARY_CHARS,
  sanitizeEscalationText,
  type Escalation,
  type EscalationKind,
} from "./escalation-types.js";
import type { ChatChannelId } from "../channels/registry.js";

/** The handle a human can type back at us. Kept short and unambiguous. */
export function escalationReferenceTag(correlationCode: string): string {
  return `[#${correlationCode}]`;
}

const REFERENCE_PATTERN = /#\s*(ESC-[A-Z0-9]{6})/i;

/**
 * Pull the correlation code out of an inbound reply. Tolerant of the ways a
 * human actually types it: `#ESC-7K2QF4`, `[#esc-7k2qf4]`, `# ESC-7K2QF4`.
 */
export function parseEscalationReference(text: string | null | undefined): string | null {
  const match = REFERENCE_PATTERN.exec(String(text ?? ""));
  return match ? match[1]!.toUpperCase() : null;
}

const KIND_EMOJI: Record<EscalationKind, string> = {
  needs_context: "❓",
  major_decision: "⚖️",
  blocked: "🚧",
  proactive_insight: "💡",
};

/**
 * How the employee opens. Deliberately per-tone rather than one template with
 * adjectives swapped: a blunt employee does not say "I wanted to flag".
 */
const KIND_LEAD: Record<EscalationKind, Record<CommunicationTone, string>> = {
  needs_context: {
    formal: "I require some information before I can proceed.",
    professional: "I need something from you before I can carry on.",
    friendly: "Quick one — I need a bit of context before I can keep going.",
    casual: "Hey, I'm stuck without a bit of info from you.",
    blunt: "Blocked. I need information only you have.",
  },
  major_decision: {
    formal: "A decision is required that exceeds my delegated authority.",
    professional: "This is above my call, so I'd like your decision.",
    friendly: "This one's above my pay grade — mind making the call?",
    casual: "Need you to pick one here, this is above my line.",
    blunt: "Your call. This is above my threshold.",
  },
  blocked: {
    formal: "Work is blocked and requires your intervention.",
    professional: "I'm blocked and can't clear it on my own.",
    friendly: "I've hit a wall on this one and can't get past it myself.",
    casual: "Hit a wall here, can't get round it.",
    blunt: "Blocked. Can't clear it myself.",
  },
  proactive_insight: {
    formal: "An observation you may wish to consider.",
    professional: "Something I noticed that seemed worth passing on.",
    friendly: "Noticed something you might find useful.",
    casual: "Spotted something worth a look.",
    blunt: "Worth knowing:",
  },
};

/** How the employee asks for the reply, keyed on what it actually needs. */
const KIND_ASK: Record<EscalationKind, string> = {
  needs_context: "Reply here with the detail and I'll pick this straight back up.",
  major_decision: "Reply with your choice and I'll run with it.",
  blocked: "Reply here with how you'd like me to proceed.",
  proactive_insight: "No action needed — reply only if you want me to act on it.",
};

const VERBOSITY_RANK: Record<CommunicationVerbosity, number> = {
  terse: 0,
  concise: 1,
  balanced: 2,
  detailed: 3,
};

function applyEmoji(kind: EscalationKind, usage: EmojiUsage, line: string): string {
  if (usage === "none") return line;
  return `${KIND_EMOJI[kind]} ${line}`;
}

/**
 * `{manager}` / `{assignee}` placeholders in the operator's own escalation and
 * hand-off phrasing. Anything unresolved is dropped rather than shown raw.
 */
function fillPhrase(
  phrase: string,
  values: { manager?: string | null; assignee?: string | null },
): string {
  return phrase
    .replace(/\{manager\}/g, values.manager ?? "the team")
    .replace(/\{assignee\}/g, values.assignee ?? "the owner")
    .replace(/\{[a-z]+\}/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export type ComposeEscalationInput = {
  escalation: Pick<
    Escalation,
    | "kind"
    | "urgency"
    | "title"
    | "summary"
    | "question"
    | "options"
    | "reference"
    | "correlationCode"
    | "occurrences"
  >;
  profile: CommunicationProfile;
  channelId?: ChatChannelId | null;
  /** Used to fill `{manager}` in the operator's escalation phrasing. */
  managerName?: string | null;
  /** Shown as the sender identity when the channel has no per-worker handle. */
  workerName?: string | null;
};

/**
 * The message body an escalation puts on a channel.
 *
 * Structure, in order: greeting → lead-in (tone) → the ask (kind) → summary and
 * reference (verbosity) → correlation tag → sign-off/signature. Anything the
 * channel override trims is trimmed from the *middle*: the ask and the tag are
 * never dropped, because dropping either turns a protocol back into a
 * notification.
 */
export function composeEscalationMessage(input: ComposeEscalationInput): string {
  const { escalation, profile } = input;
  const effective = input.channelId
    ? effectiveChannelProfile(profile, input.channelId)
    : {
        tone: profile.tone,
        verbosity: profile.verbosity,
        emojiUse: profile.emojiUse,
        maxMessageChars: null as number | null,
        greeting: profile.greeting,
        signOff: profile.signOff,
        signature: profile.signature,
      };
  const detail = VERBOSITY_RANK[effective.verbosity];
  const lines: string[] = [];

  if (effective.greeting && detail >= 1) lines.push(effective.greeting);

  const lead = KIND_LEAD[escalation.kind][effective.tone];
  lines.push(applyEmoji(escalation.kind, effective.emojiUse, `${lead} ${escalation.title}`.trim()));

  // A blocker that has recurred is materially different information from one
  // that happened once, and is the single most useful thing to surface.
  if (escalation.occurrences > 1) {
    lines.push(`This is the ${ordinal(escalation.occurrences)} time — it's repeating.`);
  }

  if (escalation.kind === "blocked" && detail >= 1) {
    const phrase = fillPhrase(profile.escalation.escalationPhrase, {
      manager: input.managerName ?? null,
    });
    if (phrase) lines.push(phrase);
  }

  if (escalation.summary && detail >= 1) {
    lines.push(detail >= 2 ? escalation.summary : firstSentence(escalation.summary));
  }

  if (escalation.question) lines.push(escalation.question);

  if (escalation.options.length) {
    lines.push(escalation.options.map((option, index) => `${index + 1}. ${option}`).join("\n"));
  }

  // A reference is a pointer, never a payload. See `redactSecrets`.
  if (escalation.reference && detail >= 2) lines.push(`Reference: ${escalation.reference}`);

  lines.push(`${KIND_ASK[escalation.kind]} ${escalationReferenceTag(escalation.correlationCode)}`);

  if (effective.signOff && detail >= 1) lines.push(effective.signOff);
  if (effective.signature && detail >= 2) lines.push(effective.signature);

  const text = lines.filter(Boolean).join("\n\n");
  return clampMessage(text, effective.maxMessageChars, escalation.correlationCode);
}

export type ComposeDigestInput = {
  escalations: Array<
    Pick<Escalation, "kind" | "title" | "summary" | "reference" | "correlationCode" | "occurrences">
  >;
  profile: CommunicationProfile;
  channelId?: ChatChannelId | null;
  workerName?: string | null;
  /** Human label for the window, e.g. "today" / "this week". */
  windowLabel?: string;
};

/**
 * One digest, many insights.
 *
 * This is the anti-spam mechanism made concrete: proactive observations never
 * go out one message per thought. They accumulate as `batched` rows and leave
 * together on the digest cadence, in the employee's own voice, with each item
 * carrying its own correlation tag so any single one can still be replied to.
 */
export function composeDigestMessage(input: ComposeDigestInput): string {
  const { profile } = input;
  const effective = input.channelId
    ? effectiveChannelProfile(profile, input.channelId)
    : {
        tone: profile.tone,
        verbosity: profile.verbosity,
        emojiUse: profile.emojiUse,
        maxMessageChars: null as number | null,
        greeting: profile.greeting,
        signOff: profile.signOff,
        signature: profile.signature,
      };
  const detail = VERBOSITY_RANK[effective.verbosity];
  const window = input.windowLabel ?? "since my last note";
  const lines: string[] = [];
  if (effective.greeting && detail >= 1) lines.push(effective.greeting);

  const count = input.escalations.length;
  const header =
    count === 1
      ? `One thing worth your attention ${window}.`
      : `${count} things worth your attention ${window}.`;
  lines.push(applyEmoji("proactive_insight", effective.emojiUse, header));

  for (const entry of input.escalations) {
    const body = detail >= 2 && entry.summary ? ` — ${firstSentence(entry.summary)}` : "";
    lines.push(`• ${entry.title}${body} ${escalationReferenceTag(entry.correlationCode)}`);
  }

  lines.push("Reply quoting any tag above and I'll pick that one up.");
  if (effective.signOff && detail >= 1) lines.push(effective.signOff);
  return clampMessage(lines.filter(Boolean).join("\n"), effective.maxMessageChars, null);
}

// ── Draft → approve → deliver ───────────────────────────────────────────────

export const APPROVAL_VERBS = ["approve", "reject", "edit"] as const;
export type ApprovalVerb = (typeof APPROVAL_VERBS)[number];

const APPROVAL_DIRECTIVE =
  /^\s*(approve|approved|ok|send|reject|rejected|no|edit|revise|reword)\b[:,-]?\s*/i;

const VERB_ALIASES: Record<string, ApprovalVerb> = {
  approve: "approve",
  approved: "approve",
  ok: "approve",
  send: "approve",
  reject: "reject",
  rejected: "reject",
  no: "reject",
  edit: "edit",
  revise: "edit",
  reword: "edit",
};

/**
 * Read an approval reply typed on a phone.
 *
 * Accepts `approve #ESC-7K2QF4`, `#ESC-7K2QF4 approve`, `reject — too pushy`,
 * `edit #ESC-7K2QF4 <new wording>`. The verb may lead or follow the tag,
 * because humans do both. Returns null when the message is not a directive at
 * all, which is how a plain answer to a `needs_context` question stays a plain
 * answer.
 */
export function parseApprovalDirective(
  text: string | null | undefined,
): { verb: ApprovalVerb; code: string | null; body: string } | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const code = parseEscalationReference(raw);
  // Strip the tag wherever it sits, then look for a leading verb.
  const withoutTag = raw.replace(/\[?#\s*ESC-[A-Z0-9]{6}\]?/gi, " ").trim();
  const match = APPROVAL_DIRECTIVE.exec(withoutTag);
  if (!match) return null;
  const verb = VERB_ALIASES[match[1]!.toLowerCase()];
  if (!verb) return null;
  return { verb, code, body: withoutTag.slice(match[0].length).trim() };
}

export type ComposeApprovalRequestInput = {
  escalation: Pick<
    Escalation,
    | "kind"
    | "title"
    | "recipientKind"
    | "recipientLabel"
    | "correlationCode"
    | "channelId"
    | "target"
  >;
  /** The exact wording awaiting sign-off. Shown verbatim — that is the point. */
  draft: string;
  profile: CommunicationProfile;
  /** The APPROVER's channel, not the recipient's. */
  channelId?: ChatChannelId | null;
  workerName?: string | null;
};

/**
 * The message an employee sends to its *approver* asking to send something to
 * a *recipient*.
 *
 * Deliberately not composed in the employee's persona voice the way an
 * escalation is: this is an internal control surface, and the human must be
 * able to tell at a glance which words are the draft and which are the ask.
 * The draft is quoted verbatim so what is approved is exactly what is sent.
 */
export function composeApprovalRequestMessage(input: ComposeApprovalRequestInput): string {
  const { escalation } = input;
  const effective = input.channelId
    ? effectiveChannelProfile(input.profile, input.channelId)
    : { emojiUse: input.profile.emojiUse, maxMessageChars: null as number | null };
  const who =
    escalation.recipientLabel ??
    escalation.target ??
    (escalation.recipientKind === "client" ? "a client" : escalation.recipientKind);
  const marker = effective.emojiUse === "none" ? "" : "📤 ";
  const via = escalation.channelId ? ` on ${escalation.channelId}` : "";
  const lines = [
    `${marker}${input.workerName ?? "Your employee"} wants to send this to ${who}${via}. Nothing goes out until you say so.`,
    "———",
    input.draft.trim(),
    "———",
    `Reply "approve ${escalationReferenceTag(escalation.correlationCode)}" to send it, ` +
      `"reject ${escalationReferenceTag(escalation.correlationCode)} <why>" to bin it, or ` +
      `"edit ${escalationReferenceTag(escalation.correlationCode)} <your wording>" to send your version instead.`,
  ];
  return clampMessage(lines.join("\n"), effective.maxMessageChars, escalation.correlationCode);
}

function firstSentence(text: string): string {
  const match = /^[\s\S]*?[.!?](\s|$)/.exec(text.trim());
  const sentence = (match ? match[0] : text).trim();
  return sanitizeEscalationText(sentence, 280);
}

function ordinal(value: number): string {
  const suffix =
    value % 100 >= 11 && value % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][value % 10] ?? "th");
  return `${value}${suffix}`;
}

/**
 * Trim to the channel's soft cap while guaranteeing the correlation tag
 * survives — a truncated escalation that lost its tag cannot be answered.
 */
function clampMessage(text: string, maxChars: number | null, code: string | null): string {
  const limit = maxChars ?? MAX_ESCALATION_SUMMARY_CHARS * 3;
  if (text.length <= limit) return text;
  const tag = code ? ` ${escalationReferenceTag(code)}` : "";
  const room = Math.max(40, limit - tag.length - 1);
  return `${text.slice(0, room).trimEnd()}…${tag}`;
}
