/**
 * Quick capture — turn one spoken utterance into a structured item.
 *
 * The phone's InfiniBot face has capture buttons (Note, Idea, Task, Project,
 * Log). The owner taps one and speaks; the transcript comes here and is
 * structured into a draft: title, body, tags, the board project it's about
 * and, for tasks, a due date and priority. The phone shows the draft on a
 * confirm card; saving goes through capture.save → the existing stores.
 *
 * Two layers:
 *   1. heuristicDraft() — deterministic, instant, offline: lead-in phrases
 *      ("remind me to…", "new idea:"), #tags / "tag it X", relative and
 *      absolute due dates, urgency words, project names mentioned.
 *   2. an LLM pass (injectable `complete`) that rewrites title/body/tags and
 *      may pick a project from the list it is given. Its output is validated
 *      field by field and merged over the heuristic draft; any failure (no
 *      model, timeout, bad JSON) keeps the heuristic draft, flagged so the UI
 *      can say "structured without AI".
 */

import { matchClient, shortlistClients, type CaptureClient } from "./client-match.js";
import {
  describeDate,
  isHm,
  isIsoDate,
  parseSpokenDate,
  stripPhrase,
  wallClock,
  type SpokenDate,
} from "./date-parse.js";
import {
  AUTO_SELECT_CONFIDENCE,
  matchProject,
  parseConfidence,
  shortlistProjects,
  type CaptureProject,
} from "./project-match.js";

export type { CaptureProject } from "./project-match.js";
export type { CaptureClient } from "./client-match.js";
export { AUTO_SELECT_CONFIDENCE } from "./project-match.js";

export const CAPTURE_KINDS = ["note", "idea", "task", "project", "log"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

/** The project / client the capture is most likely about (always a real id). */
export type CaptureSuggestion = {
  id: string;
  name: string;
  /** 0..1 */
  confidence: number;
  /** Short human reason ("named it (“KinglyVault”)", "about pricing, billing"). */
  reason: string;
  /**
   * "ai" = the model picked it, "match" = the deterministic name matcher,
   * "project" = (clients) the client of the chosen project.
   */
  source: "ai" | "match" | "project";
  /** True when confidence ≥ AUTO_SELECT_CONFIDENCE (preselected). */
  auto: boolean;
};
export type CaptureProjectSuggestion = CaptureSuggestion;

/** Where the draft's date came from: the words, and who read them. */
export type CaptureDateSuggestion = {
  /** YYYY-MM-DD in the owner's timezone. */
  date: string;
  /** HH:mm when a time was said. */
  time?: string;
  /** The spoken words ("by Friday"). */
  phrase: string;
  /** "parse" = the deterministic parser, "ai" = the model (phrase checked against the transcript). */
  source: "parse" | "ai";
  /** "Fri 17 Oct, 3 pm". */
  label: string;
};

export type CaptureDraft = {
  kind: CaptureKind;
  title: string;
  body: string;
  tags: string[];
  /** Board project this item belongs to (tasks/notes/ideas/logs). */
  projectId?: string;
  projectName?: string;
  /**
   * Automatic association: the best project guess with confidence + reason.
   * projectId is only preset from it when `auto` (high confidence); a low-
   * confidence guess stays a suggestion the phone offers but doesn't select.
   */
  projectSuggestion?: CaptureProjectSuggestion;
  /** CRM client (agency client id) this item is for. */
  clientId?: string;
  clientName?: string;
  /** Automatic client association — same rules as projectSuggestion. */
  clientSuggestion?: CaptureSuggestion;
  /**
   * The item's date, YYYY-MM-DD in the owner's timezone: tasks = due date,
   * projects = target date, ideas / notes = review-on date, logs = the day
   * it happened.
   */
  dueDate?: string;
  /** HH:mm (24 h) when a time was said / picked. */
  dueTime?: string;
  /** How the date was found ("from 'by Friday'"). */
  dateSuggestion?: CaptureDateSuggestion;
  /** Tasks: low | medium | high. */
  priority?: "low" | "medium" | "high";
  /** The transcript as spoken. */
  transcript: string;
  /** "ai" when the LLM pass succeeded, "heuristic" otherwise. */
  structuredBy: "ai" | "heuristic";
  /** Why the AI pass was skipped (shown as a hint). */
  aiError?: string;
};

export type CaptureComplete = (
  system: string,
  user: string,
  signal?: AbortSignal,
) => Promise<string>;

export function isCaptureKind(v: unknown): v is CaptureKind {
  return typeof v === "string" && (CAPTURE_KINDS as readonly string[]).includes(v);
}

// ── heuristics ────────────────────────────────────────────────────────────────

const LEAD_INS: Record<CaptureKind, RegExp[]> = {
  note: [
    /^(?:(?:take|make|add|write)\s+(?:a\s+)?note(?:\s+(?:that|to|about))?|note(?:\s+to\s+self)?)[\s,:.-]+/i,
  ],
  idea: [
    /^(?:(?:i\s+(?:have|had|got)\s+(?:an?\s+)?)?(?:new\s+)?idea(?:\s+(?:is|for|about))?|what\s+if)[\s,:.-]+/i,
  ],
  task: [
    /^(?:remind\s+me\s+to|(?:add|create|make)\s+(?:a\s+)?(?:new\s+)?task(?:\s+to)?|(?:new\s+)?task(?:\s+to)?|todo|to\s*do|i\s+(?:need|have)\s+to)[\s,:.-]+/i,
  ],
  project: [
    /^(?:(?:start|create|add|make)\s+(?:a\s+)?(?:new\s+)?project(?:\s+(?:called|named|for))?|new\s+project(?:\s+(?:called|named|for))?|project)[\s,:.-]+/i,
  ],
  log: [
    /^(?:log(?:\s+that)?|(?:add\s+to\s+(?:the\s+|my\s+)?)?(?:journal|log)(?:\s+entry)?)[\s,:.-]+/i,
  ],
};

/**
 * First due date spoken in `text`, plus the text with that phrase removed.
 * (Kept for callers/tests; see date-parse.ts for the full parser.)
 */
export function extractDueDate(
  text: string,
  now: Date,
  timeZone?: string,
): { dueDate?: string; dueTime?: string; phrase?: string; rest: string } {
  const hit = parseSpokenDate(text, { now, timeZone });
  if (!hit) return { rest: text };
  return {
    dueDate: hit.date,
    ...(hit.time ? { dueTime: hit.time } : {}),
    phrase: hit.phrase,
    rest: stripPhrase(text, hit) || text,
  };
}

/** The date a capture of `kind` carries, read from what was said. */
export function spokenDateFor(
  kind: CaptureKind,
  text: string,
  now: Date,
  timeZone?: string,
): SpokenDate | null {
  if (kind === "log") {
    // A log's date is the day it happened: today or earlier.
    const hit = parseSpokenDate(text, { now, timeZone, allowPast: true });
    const w = wallClock(now, timeZone);
    const today = `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
    return hit && hit.date <= today ? hit : null;
  }
  // Notes / ideas only take a date when one is asked for ("review next week").
  return parseSpokenDate(text, {
    now,
    timeZone,
    requireCue: kind === "note" || kind === "idea",
  });
}

function dateSuggestionOf(
  hit: { date: string; time?: string; phrase: string },
  source: CaptureDateSuggestion["source"],
  now: Date,
  timeZone?: string,
): CaptureDateSuggestion {
  return {
    date: hit.date,
    ...(hit.time ? { time: hit.time } : {}),
    phrase: hit.phrase,
    source,
    label: describeDate(hit.date, hit.time, { now, timeZone }),
  };
}

/** #hashtags and "tag(ged) (it|this) X and Y" → tags, plus the text without the tag phrase. */
export function extractTags(text: string): { tags: string[]; rest: string } {
  const tags: string[] = [];
  let rest = text;
  const phrase = rest.match(
    /[,.]?\s*\b(?:tag(?:ged)?|label(?:led)?)\s+(?:it|this|that)?\s*(?:as|with)?\s+([\w-]+(?:\s*(?:,|and)\s*[\w-]+)*)\s*[.!]?$/i,
  );
  if (phrase) {
    for (const t of phrase[1].split(/\s*(?:,|\band\b)\s*/i))
      if (t.trim()) tags.push(t.trim().toLowerCase());
    rest = rest.slice(0, phrase.index).trim();
  }
  rest = rest.replace(/(^|\s)#([\w-]{2,40})/g, (_m, sp: string, t: string) => {
    tags.push(t.toLowerCase());
    return sp;
  });
  return { tags: [...new Set(tags)].slice(0, 8), rest: rest.replace(/\s{2,}/g, " ").trim() };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The board project named in `text` (longest name wins; ≥3 chars, whole words). */
export function inferProject(text: string, projects: CaptureProject[]): CaptureProject | undefined {
  const t = text.toLowerCase();
  let best: CaptureProject | undefined;
  for (const p of projects) {
    const name = p.name?.trim();
    if (!name || name.length < 3) continue;
    const re = new RegExp(`(^|[^a-z0-9])${escapeRe(name.toLowerCase())}($|[^a-z0-9])`);
    if (re.test(t) && (!best || name.length > best.name.length)) best = p;
  }
  return best;
}

function sentenceCase(s: string): string {
  const t = s.trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

/** A short title from free speech: the first clause, ≤ 72 chars, no trailing punctuation. */
export function titleFrom(text: string, max = 72): string {
  const first = text.split(/(?<=[.!?])\s+|\s+(?:because|so that|and then)\s+/i)[0] ?? text;
  let t = first.replace(/[.!?,;:\s]+$/, "").trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    t =
      (cut.includes(" ") ? cut.slice(0, cut.lastIndexOf(" ")) : cut).replace(/[,;:\s]+$/, "") + "…";
  }
  return sentenceCase(t);
}

function suggestionOf(
  p: { id: string; name: string },
  confidence: number,
  reason: string,
  source: CaptureSuggestion["source"],
): CaptureSuggestion {
  const c = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));
  return {
    id: p.id,
    name: p.name,
    confidence: c,
    reason: reason.trim().slice(0, 140) || (source === "ai" ? "picked by AI" : "name match"),
    source,
    auto: c >= AUTO_SELECT_CONFIDENCE,
  };
}

/** Draft project fields for a suggestion: preselect only when it is confident. */
function withSuggestion(
  s: CaptureSuggestion | undefined,
): Pick<CaptureDraft, "projectId" | "projectName" | "projectSuggestion"> {
  if (!s) return {};
  return s.auto
    ? { projectId: s.id, projectName: s.name, projectSuggestion: s }
    : { projectSuggestion: s };
}

/** Draft client fields for a suggestion: preselect only when it is confident. */
function withClient(
  s: CaptureSuggestion | undefined,
): Pick<CaptureDraft, "clientId" | "clientName" | "clientSuggestion"> {
  if (!s) return {};
  return s.auto
    ? { clientId: s.id, clientName: s.name, clientSuggestion: s }
    : { clientSuggestion: s };
}

/** Resolves a board project to its CRM client (relation indexes / Notion "Clients"). */
export type ProjectClientResolver = (projectId: string) => CaptureClient | undefined;

/**
 * Fill in the client from the chosen project when nothing better was said:
 * an explicit, confident client mention wins; otherwise the project's own
 * client is used (preselected — the project already says whose work it is).
 */
export function withProjectClient(
  draft: CaptureDraft,
  clientOfProject: ProjectClientResolver | undefined,
): CaptureDraft {
  if (!clientOfProject || !draft.projectId || draft.kind === "project") return draft;
  if (draft.clientSuggestion?.auto) return draft;
  const c = clientOfProject(draft.projectId);
  if (!c) return draft;
  const s = suggestionOf(c, 0.8, `client of “${draft.projectName ?? "the project"}”`, "project");
  const out = { ...draft };
  delete out.clientId;
  delete out.clientName;
  delete out.clientSuggestion;
  return { ...out, ...withClient(s) };
}

export type CaptureContext = {
  now?: Date;
  /** Owner's IANA timezone (dates are resolved in it). */
  timeZone?: string;
  projects?: CaptureProject[];
  clients?: CaptureClient[];
  clientOfProject?: ProjectClientResolver;
};

export function heuristicDraft(
  kind: CaptureKind,
  transcript: string,
  opts: CaptureContext = {},
): CaptureDraft {
  const now = opts.now ?? new Date();
  const spoken = transcript.replace(/\s+/g, " ").trim();
  let text = spoken;
  for (const re of LEAD_INS[kind]) text = text.replace(re, "");
  text = text.trim() || spoken;
  const tagged = extractTags(text);
  text = tagged.rest || text;
  const when = spokenDateFor(kind, text, now, opts.timeZone);
  // Tasks and projects drop the deadline words from the text ("ship it by
  // Friday" → "Ship it"); notes, ideas and logs keep what was said.
  if (when && (kind === "task" || kind === "project")) text = stripPhrase(text, when) || text;
  const priority: CaptureDraft["priority"] | undefined =
    kind === "task"
      ? /\b(urgent|asap|as soon as possible|high priority|critical|important)\b/i.test(spoken)
        ? "high"
        : /\b(low priority|whenever|someday|no rush)\b/i.test(spoken)
          ? "low"
          : "medium"
      : undefined;
  const match = kind === "project" ? undefined : matchProject(spoken, opts.projects ?? []);
  const suggestion = match
    ? suggestionOf(match.project, match.confidence, match.reason, "match")
    : undefined;
  const cm = matchClient(spoken, opts.clients ?? []);
  const client = cm ? suggestionOf(cm.client, cm.confidence, cm.reason, "match") : undefined;
  const tags = [...tagged.tags];
  if (kind === "log" && !tags.includes("log")) tags.unshift("log");
  const w = wallClock(now, opts.timeZone);
  const today = `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
  const title = kind === "log" ? `Log · ${when?.date ?? today}` : titleFrom(text);
  const draft: CaptureDraft = {
    kind,
    title: title || sentenceCase(kind),
    body: sentenceCase(text),
    tags,
    ...withSuggestion(suggestion),
    ...withClient(client),
    ...(when
      ? {
          dueDate: when.date,
          ...(when.time ? { dueTime: when.time } : {}),
          dateSuggestion: dateSuggestionOf(when, "parse", now, opts.timeZone),
        }
      : {}),
    ...(priority ? { priority } : {}),
    transcript: spoken,
    structuredBy: "heuristic",
  };
  return withProjectClient(draft, opts.clientOfProject);
}

// ── LLM pass ──────────────────────────────────────────────────────────────────

function projectLine(p: CaptureProject): string {
  const extra: string[] = [];
  if (p.parentName) extra.push(`sub-project of ${p.parentName}`);
  if (p.aliases?.length) extra.push(`aka ${p.aliases.slice(0, 3).join(", ")}`);
  const desc = p.description?.replace(/\s+/g, " ").trim().slice(0, 90);
  if (desc) extra.push(desc);
  return `- ${p.id}: ${p.name}${extra.length ? ` — ${extra.join(" — ")}` : ""}`;
}

function clientLine(c: CaptureClient): string {
  const extra: string[] = [];
  if (c.aliases?.length) extra.push(`aka ${c.aliases.slice(0, 2).join(", ")}`);
  const desc = c.description?.slice(0, 70);
  if (desc) extra.push(desc);
  return `- ${c.id}: ${c.name}${extra.length ? ` — ${extra.join(" — ")}` : ""}`;
}

const DATE_MEANING: Record<CaptureKind, string> = {
  task: "the deadline",
  project: "the target / launch date",
  idea: "a date to revisit or review it — only if the speaker asked for one",
  note: "a date to review or follow up — only if the speaker asked for one",
  log: "the day it happened, if not today",
};

export function capturePrompt(
  kind: CaptureKind,
  transcript: string,
  now: Date,
  projects: CaptureProject[],
  clients: CaptureClient[] = [],
  timeZone?: string,
): { system: string; user: string } {
  const candidates = kind === "project" ? [] : shortlistProjects(transcript, projects, 40);
  const list = candidates.map(projectLine).join("\n") || "(none)";
  const clientList =
    shortlistClients(transcript, clients, 30).map(clientLine).join("\n") || "(none)";
  const system =
    "You turn one spoken voice capture into a clean structured item. Reply with ONE JSON object and nothing else. " +
    'Keys: "title" (short, ≤ 70 chars, no trailing period), "body" (the content as clean written prose or bullet points; keep every detail the speaker gave, drop filler like "um" and the lead-in phrase), ' +
    '"tags" (0-5 short lowercase single words), ' +
    (kind === "project"
      ? ""
      : '"projectId" (the id of the board project this capture belongs to, chosen ONLY from the Projects list: an explicit mention like "for the X project" or a near-spelling of a name wins; otherwise pick the project the content is clearly about from its name/description; null when none fits), ' +
        '"projectConfidence" (0-1: ≥0.85 when the project is named, 0.6-0.8 when the content clearly matches it, below 0.5 for a guess), ' +
        '"projectReason" (≤ 12 words, why that project), ') +
    '"clientId" (the id of the CRM client this is for, chosen ONLY from the Clients list: a client named or clearly meant — "for Gengu", "the SAMPLE invoice"; null when no client is meant), ' +
    '"clientConfidence" (0-1, same scale), "clientReason" (≤ 12 words), ' +
    `"dueDate" (YYYY-MM-DD — ${DATE_MEANING[kind]}; resolve relative words like "Friday", "next Tuesday", "in two weeks", "end of month" against Today; null when no date was said), ` +
    '"dueTime" ("HH:mm" 24 h only if a time was said, else null), ' +
    '"datePhrase" (the exact words from the capture the date came from, e.g. "by Friday"; null when no date)' +
    (kind === "task" ? ', "priority" ("low" | "medium" | "high")' : "") +
    ". Never invent facts, dates or ids.";
  const w = wallClock(now, timeZone);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
    w.weekday
  ];
  const tzLabel = timeZone ? ` ${timeZone}` : "";
  const user =
    `Kind: ${kind}\nToday: ${w.y}-${p2(w.m)}-${p2(w.d)} (${weekday}), now ${p2(w.hour)}:${p2(w.minute)}${tzLabel}\n` +
    `Projects:\n${list}\nClients:\n${clientList}\n\nSpoken capture:\n"""${transcript}"""`;
  return { system, user };
}

/** Pull the first JSON object out of a model reply (tolerates ```json fences / prose). */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const s = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The model's date, checked: its quoted phrase must be in the transcript; if
 * the parser reads that phrase, the parser's date wins (deterministic weekday
 * maths); otherwise the model's date is kept when it is a real date in range.
 * Null = no usable model date (keep the heuristic one).
 */
export function guardModelDate(
  kind: CaptureKind,
  model: Record<string, unknown>,
  transcript: string,
  now: Date,
  timeZone?: string,
): { date: string; time?: string; phrase: string; source: "parse" | "ai" } | null {
  const date = typeof model.dueDate === "string" ? model.dueDate.trim() : "";
  const phrase = typeof model.datePhrase === "string" ? model.datePhrase.trim() : "";
  if (!phrase || !transcript.toLowerCase().includes(phrase.toLowerCase())) return null;
  const parsed = spokenDateFor(kind, phrase, now, timeZone);
  if (parsed)
    return {
      date: parsed.date,
      ...(parsed.time ? { time: parsed.time } : {}),
      phrase,
      source: "parse",
    };
  if (!isIsoDate(date)) return null;
  const w = wallClock(now, timeZone);
  const today = Date.UTC(w.y, w.m - 1, w.d);
  const t = Date.parse(`${date}T00:00:00Z`);
  const dayMs = 86_400_000;
  const tooEarly = kind === "log" ? t < today - 366 * dayMs : t < today;
  if (tooEarly || t > today + 5 * 366 * dayMs || (kind === "log" && t > today)) return null;
  const time =
    typeof model.dueTime === "string" && isHm(model.dueTime.trim())
      ? model.dueTime.trim()
      : undefined;
  return { date, ...(time ? { time } : {}), phrase, source: "ai" };
}

/** Merge a validated model reply over the heuristic draft. */
export function mergeModelDraft(
  base: CaptureDraft,
  model: Record<string, unknown>,
  projects: CaptureProject[],
  ctx: { clients?: CaptureClient[]; now?: Date; timeZone?: string } = {},
): CaptureDraft {
  const out: CaptureDraft = { ...base, structuredBy: "ai" };
  if (typeof model.title === "string" && model.title.trim() && base.kind !== "log")
    out.title = model.title
      .trim()
      .replace(/[.\s]+$/, "")
      .slice(0, 120);
  if (typeof model.body === "string" && model.body.trim())
    out.body = model.body.trim().slice(0, 8000);
  if (Array.isArray(model.tags)) {
    const tags = model.tags
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim().replace(/^#/, "").toLowerCase())
      .filter((t) => /^[\w-]{1,30}$/.test(t));
    out.tags = [...new Set([...(base.kind === "log" ? ["log"] : []), ...base.tags, ...tags])].slice(
      0,
      8,
    );
  }
  if (base.kind !== "project") {
    const pid = typeof model.projectId === "string" ? model.projectId.trim() : "";
    // The model may only name a project from the list; an invented id is ignored.
    const hit = pid ? projects.find((p) => p.id === pid) : undefined;
    const ai = hit
      ? suggestionOf(
          hit,
          parseConfidence(model.projectConfidence),
          typeof model.projectReason === "string" ? model.projectReason : "",
          "ai",
        )
      : undefined;
    const pick = chooseSuggestion(base.projectSuggestion, ai);
    delete out.projectId;
    delete out.projectName;
    delete out.projectSuggestion;
    Object.assign(out, withSuggestion(pick));
  }
  {
    const clients = ctx.clients ?? [];
    const cid = typeof model.clientId === "string" ? model.clientId.trim() : "";
    const hit = cid ? clients.find((c) => c.id === cid) : undefined;
    const ai = hit
      ? suggestionOf(
          hit,
          parseConfidence(model.clientConfidence),
          typeof model.clientReason === "string" ? model.clientReason : "",
          "ai",
        )
      : undefined;
    // A client inferred from the old project no longer applies once the project changed.
    const baseClient =
      base.clientSuggestion?.source === "project" ? undefined : base.clientSuggestion;
    const pick = chooseSuggestion(baseClient, ai);
    delete out.clientId;
    delete out.clientName;
    delete out.clientSuggestion;
    Object.assign(out, withClient(pick));
  }
  {
    const now = ctx.now ?? new Date();
    const d = guardModelDate(base.kind, model, base.transcript, now, ctx.timeZone);
    // The parser's own date (from the transcript) stays unless the model found
    // a checked date the parser missed.
    if (d && !base.dateSuggestion) {
      out.dueDate = d.date;
      if (d.time) out.dueTime = d.time;
      else delete out.dueTime;
      out.dateSuggestion = dateSuggestionOf(d, d.source, now, ctx.timeZone);
      if (base.kind === "log") out.title = `Log · ${d.date}`;
    }
  }
  if (base.kind === "task") {
    if (model.priority === "low" || model.priority === "medium" || model.priority === "high")
      out.priority = model.priority;
  }
  return out;
}

/**
 * Combine the deterministic match with the model's pick. Agreement boosts
 * confidence; an explicit spoken name (≥ 0.9) beats a weaker model guess;
 * otherwise the more confident one wins.
 */
export function chooseSuggestion(
  match: CaptureSuggestion | undefined,
  ai: CaptureSuggestion | undefined,
): CaptureSuggestion | undefined {
  if (!ai) return match;
  if (!match) return ai;
  if (match.id === ai.id) {
    const confidence = Math.min(0.99, Math.max(match.confidence, ai.confidence) + 0.05);
    return { ...ai, confidence, auto: confidence >= AUTO_SELECT_CONFIDENCE };
  }
  if (match.confidence >= 0.9 && ai.confidence < 0.9) return match;
  return ai.confidence >= match.confidence ? ai : match;
}

/** Final guard: drop any project id that isn't a real project in `projects`. */
export function guardDraftProject(draft: CaptureDraft, projects: CaptureProject[]): CaptureDraft {
  const ids = new Map(projects.map((p) => [p.id, p]));
  const out = { ...draft };
  if (out.projectSuggestion && !ids.has(out.projectSuggestion.id)) delete out.projectSuggestion;
  if (out.projectId) {
    const p = ids.get(out.projectId);
    if (!p) {
      delete out.projectId;
      delete out.projectName;
    } else out.projectName = p.name;
  }
  return out;
}

/** Final guard: drop any client id that isn't a real client, and any bad date. */
export function guardDraftClient(draft: CaptureDraft, clients: CaptureClient[]): CaptureDraft {
  const ids = new Map(clients.map((c) => [c.id, c]));
  const out = { ...draft };
  if (out.clientSuggestion && !ids.has(out.clientSuggestion.id)) delete out.clientSuggestion;
  if (out.clientId) {
    const c = ids.get(out.clientId);
    if (!c) {
      delete out.clientId;
      delete out.clientName;
    } else out.clientName = c.name;
  }
  if (out.dueDate && !isIsoDate(out.dueDate)) {
    delete out.dueDate;
    delete out.dueTime;
    delete out.dateSuggestion;
  }
  if (out.dueTime && !isHm(out.dueTime)) delete out.dueTime;
  return out;
}

function guardAll(draft: CaptureDraft, ctx: CaptureContext): CaptureDraft {
  const projects = ctx.projects ?? [];
  const guarded = guardDraftProject(draft, projects);
  return guardDraftClient(withProjectClient(guarded, ctx.clientOfProject), ctx.clients ?? []);
}

export type StructureCaptureDeps = CaptureContext & {
  complete?: CaptureComplete | null;
  /** Hard cap on the AI pass (default 12 s); the heuristic draft is returned after it. */
  timeoutMs?: number;
};

export async function structureCapture(
  kind: CaptureKind,
  transcript: string,
  deps: StructureCaptureDeps = {},
): Promise<CaptureDraft> {
  const now = deps.now ?? new Date();
  const ctx: CaptureContext = { ...deps, now };
  const projects = deps.projects ?? [];
  const clients = deps.clients ?? [];
  const base = heuristicDraft(kind, transcript, ctx);
  if (!deps.complete) return guardAll({ ...base, aiError: "no model available" }, ctx);
  const { system, user } = capturePrompt(
    kind,
    base.transcript,
    now,
    projects,
    clients,
    deps.timeZone,
  );
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      deps.complete(system, user, ctl.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ctl.abort();
          reject(new Error("timed out"));
        }, deps.timeoutMs ?? 12_000);
      }),
    ]);
    const parsed = parseJsonObject(raw);
    if (!parsed) return guardAll({ ...base, aiError: "model reply was not JSON" }, ctx);
    return guardAll(
      mergeModelDraft(base, parsed, projects, { clients, now, timeZone: deps.timeZone }),
      ctx,
    );
  } catch (err) {
    return guardAll({ ...base, aiError: err instanceof Error ? err.message : String(err) }, ctx);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The gateway's model for capture structuring: the main agent's fast voice
 * model (same provider + key the voice calls already use, so nothing new is
 * billed or configured). Null when no model / key resolves.
 */
export async function defaultCaptureComplete(agentId = "main"): Promise<CaptureComplete | null> {
  try {
    const [{ resolveFastVoiceModel }, { completeSimple }] = await Promise.all([
      import("../gateway/voice/voice-fast-turn.js"),
      import("@mariozechner/pi-ai"),
    ]);
    const handle = await resolveFastVoiceModel({ agentId } as Parameters<
      typeof resolveFastVoiceModel
    >[0]);
    return async (system, user, signal) => {
      const res = await completeSimple(
        handle.model,
        {
          systemPrompt: system,
          messages: [{ role: "user", content: user, timestamp: Date.now() }],
        },
        {
          apiKey: handle.apiKey,
          maxTokens: 900,
          temperature: 0.2,
          signal,
          ...(handle.model.reasoning ? { reasoning: "minimal" as const } : {}),
        },
      );
      return res.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("")
        .trim();
    };
  } catch {
    return null;
  }
}
