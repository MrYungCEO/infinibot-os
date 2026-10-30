/**
 * Reply Classifier — LLM-based classification of inbound replies.
 *
 * Input: reply body text + optional original email context.
 * Output: { class, urgency, suggested_action, confidence }
 *
 * Classes:
 *   "interested"     — wants to learn more / asking to proceed
 *   "not_interested" — explicit "no thanks"
 *   "unsubscribe"    — opt-out request
 *   "oof"            — auto-reply / out of office
 *   "question"       — asking a question before deciding
 *
 * If confidence < 0.7, route to "needs_review" so a human can check.
 *
 * Uses Claude Haiku (fast + cheap) by default.
 * Falls back to rule-based heuristics when ANTHROPIC_API_KEY is absent.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReplyClass =
  | "interested"
  | "not_interested"
  | "unsubscribe"
  | "oof"
  | "question"
  | "unknown";

export type ReplyUrgency = "high" | "medium" | "low";

export interface ClassificationResult {
  class: ReplyClass;
  urgency: ReplyUrgency;
  suggested_action: string;
  confidence: number;
  /** True when confidence < 0.7 and human review is recommended. */
  needsHumanReview: boolean;
  method: "llm" | "rules";
}

export interface ClassifyReplyOpts {
  replyText: string;
  /** Subject of the original outbound email. */
  originalSubject?: string;
  /** Body of the original outbound email (truncated). */
  originalBody?: string;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function classifyReply(opts: ClassifyReplyOpts): Promise<ClassificationResult> {
  const { replyText, originalSubject, log = console.log, signal } = opts;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log("[classifier] ANTHROPIC_API_KEY not set — using rule-based classifier");
    return _ruleBased(replyText);
  }

  try {
    return await _llmClassify(replyText, originalSubject, apiKey, log, signal);
  } catch (err) {
    log(`[classifier] LLM failed, falling back to rules: ${String(err)}`);
    return _ruleBased(replyText);
  }
}

// ── LLM classifier ────────────────────────────────────────────────────────────

async function _llmClassify(
  replyText: string,
  originalSubject: string | undefined,
  apiKey: string,
  log: (l: string) => void,
  signal?: AbortSignal,
): Promise<ClassificationResult> {
  const prompt = `You are classifying a reply to a cold outreach email. Output ONLY valid JSON.

Original email subject: ${originalSubject ?? "unknown"}

Reply text:
---
${replyText.slice(0, 1000)}
---

Classify this reply:
- class: one of "interested" | "not_interested" | "unsubscribe" | "oof" | "question" | "unknown"
- urgency: "high" (interested/urgent), "medium" (question/follow-up needed), or "low" (not interested/oof)
- suggested_action: what should the human or agent do next (1 sentence)
- confidence: 0.0-1.0 (how confident you are in the classification)

Output exactly this JSON (no other text):
{"class": "...", "urgency": "...", "suggested_action": "...", "confidence": 0.XX}`;

  log(`[classifier] calling Claude for reply classification`);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
    }),
    signal,
  });

  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as { content: Array<{ type: string; text: string }> };
  const text = data.content.find((c) => c.type === "text")?.text ?? "";

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in response: ${text.slice(0, 100)}`);

  const parsed = JSON.parse(jsonMatch[0]) as Partial<ClassificationResult>;

  const cls = _validClass(parsed.class as string);
  const urgency = _validUrgency(parsed.urgency as string);
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.7)));
  const suggested_action = String(parsed.suggested_action ?? _defaultAction(cls));

  log(`[classifier] LLM result: class=${cls} urgency=${urgency} confidence=${confidence}`);

  return {
    class: cls,
    urgency,
    suggested_action,
    confidence,
    needsHumanReview: confidence < 0.7,
    method: "llm",
  };
}

// ── Rule-based fallback ───────────────────────────────────────────────────────

function _ruleBased(text: string): ClassificationResult {
  const lower = text.toLowerCase();

  // OOF / auto-reply
  if (
    lower.includes("out of office") ||
    lower.includes("on vacation") ||
    lower.includes("automatic reply") ||
    lower.includes("auto-reply") ||
    lower.includes("currently away")
  ) {
    return {
      class: "oof",
      urgency: "low",
      suggested_action: "Follow up when they return",
      confidence: 0.9,
      needsHumanReview: false,
      method: "rules",
    };
  }

  // Unsubscribe
  if (
    lower.includes("unsubscribe") ||
    lower.includes("remove me") ||
    lower.includes("take me off") ||
    lower.includes("stop emailing") ||
    lower.includes("do not contact")
  ) {
    return {
      class: "unsubscribe",
      urgency: "high",
      suggested_action: "Mark as unsubscribed immediately and suppress from all campaigns",
      confidence: 0.95,
      needsHumanReview: false,
      method: "rules",
    };
  }

  // Not interested
  if (
    lower.includes("not interested") ||
    lower.includes("no thank") ||
    lower.includes("not relevant") ||
    lower.includes("don't need") ||
    lower.includes("already have") ||
    lower.includes("we're good")
  ) {
    return {
      class: "not_interested",
      urgency: "low",
      suggested_action: "Mark as not interested and close the sequence",
      confidence: 0.85,
      needsHumanReview: false,
      method: "rules",
    };
  }

  // Interested / positive
  if (
    lower.includes("interested") ||
    lower.includes("tell me more") ||
    lower.includes("sounds good") ||
    lower.includes("let's chat") ||
    lower.includes("schedule a call") ||
    lower.includes("book a meeting") ||
    lower.includes("love to learn") ||
    lower.includes("when are you available")
  ) {
    return {
      class: "interested",
      urgency: "high",
      suggested_action: "Respond within 1 hour — book a call ASAP",
      confidence: 0.85,
      needsHumanReview: false,
      method: "rules",
    };
  }

  // Question
  if (
    lower.includes("?") ||
    lower.includes("what") ||
    lower.includes("how much") ||
    lower.includes("pricing")
  ) {
    return {
      class: "question",
      urgency: "medium",
      suggested_action: "Answer their question and offer to jump on a quick call",
      confidence: 0.7,
      needsHumanReview: false,
      method: "rules",
    };
  }

  // Unknown — route to human
  return {
    class: "unknown",
    urgency: "medium",
    suggested_action: "Review manually — couldn't auto-classify",
    confidence: 0.3,
    needsHumanReview: true,
    method: "rules",
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_CLASSES: ReplyClass[] = [
  "interested",
  "not_interested",
  "unsubscribe",
  "oof",
  "question",
  "unknown",
];
const VALID_URGENCIES: ReplyUrgency[] = ["high", "medium", "low"];

function _validClass(cls: string): ReplyClass {
  return (VALID_CLASSES as string[]).includes(cls) ? (cls as ReplyClass) : "unknown";
}

function _validUrgency(u: string): ReplyUrgency {
  return (VALID_URGENCIES as string[]).includes(u) ? (u as ReplyUrgency) : "medium";
}

function _defaultAction(cls: ReplyClass): string {
  switch (cls) {
    case "interested":
      return "Respond promptly and book a discovery call";
    case "not_interested":
      return "Close this lead's outreach sequence";
    case "unsubscribe":
      return "Process opt-out immediately";
    case "oof":
      return "Reschedule follow-up for when they return";
    case "question":
      return "Answer their question and move toward a call";
    default:
      return "Review this reply manually";
  }
}
