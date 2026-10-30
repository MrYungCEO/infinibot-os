/**
 * Voice turn routing — who answers a turn of a live call: the fast step (one
 * direct model call, no tools) or the full agent.
 *
 * The fast step may only handle small talk, greetings and clarifications.
 * Anything that touches the user's work (projects, tasks, agents, messages,
 * files, memory, calendar, code…) or asks for something to be done belongs to
 * the full agent. Three layers decide, cheapest first:
 *
 *   1. `prefilterVoiceRoute`  deterministic pre-filter. An obvious work request
 *      goes to the agent without asking the fast model at all (the caller hears
 *      the acknowledgement at once); a follow-up to an agent-handled turn or to
 *      a refusal stays with the agent.
 *   2. the fast model's own decision: it must call `handoff_to_agent` (or write
 *      the HANDOFF marker) instead of answering.
 *   3. `looksLikeRefusal`     a guard on what the fast model wrote: a refusal
 *      or "I can't" is never spoken, the turn goes to the agent instead.
 */

import type { VoiceTurnMessage } from "./voice-llm-turn.js";

export type VoiceRoute = "agent" | "reply" | "unsure";
export type VoiceRouteDecision = { route: VoiceRoute; reason: string };

/** Written by a model that cannot call tools: the whole reply is this marker. */
export const HANDOFF_MARKER = "HANDOFF";

const WORDS = (text: string) => text.trim().split(/\s+/).filter(Boolean);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ── refusal guard ──────────────────────────────────────────────────────────────

const REFUSAL_PATTERNS: RegExp[] = [
  /\bi(?:'m| am) sorry,? but\b/,
  /\b(?:sorry|unfortunately|apologies),? (?:but )?i (?:can(?:'t|not| not)|am (?:not able|unable)|don't|do not|won't)\b/,
  /\bi (?:can(?:'t|not| not)|could(?:n't| not)|won't|will not|am not able to|am unable to|'m not able to|'m unable to|am not allowed to|'m not allowed to|am not permitted to|'m not permitted to)\b(?! (?:wait|believe|complain|agree more|thank|help but|stress|imagine|tell you how (?:happy|glad|good)))/,
  /\bi (?:don't|do not) have (?:access|the ability|permission|the tools?|any (?:information|details|access)|information|details|that information|a way)\b/,
  /\b(?:i'm|i am) (?:not able|unable|not allowed|not permitted|not authorized|not in a position)\b/,
  /\b(?:that|this|it)(?:'s| is) (?:confidential|private|not something i can|beyond what i can|outside (?:of )?what i can)\b/,
  /\b(?:can't|cannot|can not|unable to|not able to) (?:share|discuss|disclose|reveal|do that|help with that|assist with that|provide)\b/,
  /\bas an ai\b/,
];

/**
 * True when the text is a refusal or a statement of inability ("I'm sorry,
 * but…", "I can't share that", "I'm unable to…", "I don't have access to…").
 * Only the opening of a reply is examined: that is what would be spoken first.
 */
export function looksLikeRefusal(text: string): boolean {
  const t = normalize(text).slice(0, 280);
  if (!t) return false;
  return REFUSAL_PATTERNS.some((re) => re.test(t));
}

/** The fast model wrote the marker instead of calling the tool. */
export function isHandoffMarker(text: string): boolean {
  const t = text.trim();
  // The marker itself, or a tool call printed as text (JSON / a fenced block naming the tool).
  return (
    /^\W*hand[\s_-]?off(?:_to_agent)?\b/i.test(t) ||
    /^(?:```|\{)/.test(t) ||
    /handoff_to_agent/i.test(t)
  );
}

// ── pre-filter ─────────────────────────────────────────────────────────────────

/** Pure conversation the fast step may answer even right after an agent turn. */
const SMALL_TALK =
  /^(?:(?:hi|hey|hello|yo|hiya|howdy|good (?:morning|afternoon|evening|night))(?: there| again)?(?: \w+)?|(?:hello|hi|hey),? (?:can|do) you hear me|can you hear me(?: now)?|are you (?:there|still there)|(?:who|what) (?:is|are) (?:this|you)|who am i (?:talking|speaking) (?:to|with)|what(?:'s| is) your name|how are you(?: doing)?(?: today)?|how(?:'s| is) it going|what(?:'s| is) up|thanks?(?: you)?(?: so much| a lot| very much)?|thank you|(?:that(?:'s| is) )?(?:great|cool|nice|awesome|perfect|good|fine|okay|ok|alright|all right|got it|i see|never ?mind)|(?:good)?bye(?: bye)?|see you(?: later)?|talk (?:to you )?later|(?:say that|come) again|(?:sorry|pardon),? (?:what|say that again)|what did you say|(?:can|could) you repeat that|repeat that)[\s.!?,]*$/;

/** Things the user owns or runs: mentioning one means the answer needs their data. */
const WORK_NOUNS =
  /\b(?:projects?|tasks?|to-?dos?|kanban|boards?|tickets?|backlog|infini ?bot|robo ?voice|robo ?park|(?:sub-?)?agents?|telegram|whats ?app|discord|slack|e-?mails?|gmail|inbox|messages?|dms?|files?|folders?|documents?|docs?|notes?|memory|memories|calendar|schedule|meetings?|appointments?|reminders?|alarms?|code|codebase|repos?|repository|commits?|branch(?:es)?|pull requests?|deploy(?:ment|ments|s|ed)?|builds?|servers?|gateway|logs?|clients?|customers?|leads?|crm|invoices?|revenue|sales|reports?|dashboards?|workflows?|cron|automations?|plugins?|skills?|notion|website|sites?|browser|database|spreadsheets?|sessions?|terminals?|wallets?|balance|portfolio|trades?|credits?|budget|pipeline)\b/;

/** A request to do something (as opposed to chat about something). */
const ACTION_REQUEST =
  /(?:^|\b(?:can|could|would|will) you(?: please)? |\bplease |\bi (?:need|want|would like|'d like) (?:you )?to |\bgo ahead and |\blet's |\b(?:and|then) )(?:check|look up|look into|look at|look for|find|search|google|send|make|create|spawn|start|launch|run|kick off|remind|schedule|book|open|close|stop|cancel|deploy|build|write|draft|add|remove|delete|update|change|set up|set|fix|generate|summari[sz]e|show|list|read|pull up|bring up|fetch|get|give me|post|publish|text|call|email|message|ping|notify|save|remember|note|record|track|assign|move|mark|finish|complete|review|analy[sz]e|research|browse|download|upload|install|restart|turn (?:on|off))\b/;

/** The utterance asks for something to be DONE (not just answered). */
export function isActionRequest(text: string): boolean {
  return ACTION_REQUEST.test(normalize(text));
}

/** Questions about the user's own things or live state. */
const DATA_QUESTION =
  /\b(?:(?:my|our) (?:\w+ ){0,3}(?:status|progress|plans?|priorities|numbers|stats|work|business|company|team|agency|day|week|month|today|tomorrow|list|queue|updates?|stuff|things)|what(?:'s| is| are)(?: there)? (?:on|in|for) (?:my|our)\b|(?:what|which|how many|how much)\b.{0,40}\b(?:do|did|have|are|is) (?:i|we) (?:have|got|working|doing|need|owe)|what(?:'s| is) (?:new|happening|going on|the status|the latest|pending|left)|any(?:thing)? (?:new|updates?|news|pending)|did (?:you|it|we|they|the) |have (?:you|we|they) (?:sent|done|finished|started|checked|deployed)|status of|update on|progress on|what time is it|what(?:'s| is) the (?:time|date|weather|price|news)|tell me about (?:my|our|the|your) |what about (?:my|our|the) )/;

/** A short follow-up that only makes sense with what the full agent just did or said. */
const FOLLOW_UP =
  /^(?:why(?: not| is that| so)?|how(?: so| come)?|what do you mean|what happened|what(?:'s| is) (?:that|wrong)|and(?: then)?\b.*|what about\b.*|which (?:one|ones)|(?:yes|yeah|yep|yup|sure|no|nope|nah)(?:,? (?:please|do it|do that|go ahead|thanks))?|do it|do that|go ahead|go for it|please do|try again|again|continue|go on|keep going|tell me more|more(?: details?)?|the (?:first|second|third|last|next) (?:one)?|then what|so|really|are you sure|did it work|is it done)[\s.!?,]*$/;

function lastAssistant(history: VoiceTurnMessage[] | undefined, message: string): string {
  const turns = (history ?? []).filter((m) => m.role === "user" || m.role === "assistant");
  // The provider's history normally ends with the utterance being answered.
  const last = turns[turns.length - 1];
  if (last && last.role === "user" && last.content.trim() === message.trim()) turns.pop();
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "assistant") return turns[i].content;
  }
  return "";
}

/**
 * Deterministic pre-filter. "agent" = route without asking the fast model;
 * "reply" = plain conversation; "unsure" = let the fast model decide.
 */
export function prefilterVoiceRoute(
  message: string,
  opts: {
    history?: VoiceTurnMessage[];
    /** How the previous turn of this call was answered. */
    lastRoute?: "agent" | "reply";
  } = {},
): VoiceRouteDecision {
  const text = normalize(message);
  if (!text) return { route: "unsure", reason: "empty" };
  if (SMALL_TALK.test(text)) return { route: "reply", reason: "small talk" };
  if (ACTION_REQUEST.test(text)) return { route: "agent", reason: "action request" };
  if (WORK_NOUNS.test(text)) return { route: "agent", reason: "mentions the user's work" };
  if (DATA_QUESTION.test(text)) return { route: "agent", reason: "asks for the user's data" };
  const short = WORDS(text).length <= 8;
  if (short && FOLLOW_UP.test(text)) {
    if (opts.lastRoute === "agent") return { route: "agent", reason: "follow-up to an agent turn" };
    if (looksLikeRefusal(lastAssistant(opts.history, message)))
      return { route: "agent", reason: "follow-up to a refusal" };
  }
  return { route: "unsure", reason: "no rule matched" };
}

// ── per-call memory of the last route ──────────────────────────────────────────

const MAX_CALLS = 500;
const ROUTE_TTL_MS = 10 * 60_000;
const lastRoutes = new Map<string, { route: "agent" | "reply"; at: number }>();

export function rememberVoiceRoute(callKey: string, route: "agent" | "reply", now = Date.now()) {
  lastRoutes.delete(callKey);
  lastRoutes.set(callKey, { route, at: now });
  if (lastRoutes.size > MAX_CALLS) lastRoutes.delete(lastRoutes.keys().next().value!);
}

export function recallVoiceRoute(callKey: string, now = Date.now()): "agent" | "reply" | undefined {
  const hit = lastRoutes.get(callKey);
  if (!hit) return undefined;
  if (now - hit.at > ROUTE_TTL_MS) {
    lastRoutes.delete(callKey);
    return undefined;
  }
  return hit.route;
}

export function clearVoiceRoutesForTests(): void {
  lastRoutes.clear();
}
