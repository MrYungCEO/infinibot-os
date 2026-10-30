/**
 * Research workspace — pure model.
 *
 * Everything here is dependency-free (no Lit, no gateway client) so it can be
 * unit-tested in node. The view/controller layer feeds it RPC results and
 * renders what it returns.
 *
 * Storage model (no new backend required):
 *  - A research RUN is a research document (src/research ResearchStore, via the
 *    `research` agent tool) with category "research-run". Its run settings live
 *    in tags (`depth-quick`, `src-both`, `project-<id>`, `report-<rptId>`) so a
 *    plain `research list` returns everything the library needs.
 *  - The finished OUTPUT is a canonical report (category "research", kind
 *    "research_brief") rendered through the `report` tool, so it gets the PDF,
 *    the markitdown copy, the /reports listing, the project association and a
 *    knowledge-graph node — all through the existing conventions.
 *  - Older research = research-category reports, research-like reports in other
 *    categories, and hand-written research documents.
 */

export type ResearchDepth = "quick" | "standard" | "deep";
export type ResearchSourceMode = "web" | "internal" | "both";
export type ResearchStatus = "running" | "complete" | "failed";
export type ResearchKind = "run" | "report" | "doc";

export const DEPTHS: Array<{ id: ResearchDepth; label: string; hint: string }> = [
  { id: "quick", label: "Quick", hint: "~1 min · a few searches" },
  { id: "standard", label: "Standard", hint: "~3 min · reads key pages" },
  { id: "deep", label: "Deep", hint: "~8 min · broad + cross-checked" },
];

export const SOURCE_MODES: Array<{ id: ResearchSourceMode; label: string }> = [
  { id: "both", label: "Web + internal" },
  { id: "web", label: "Web only" },
  { id: "internal", label: "Internal only" },
];

/** Category used for run records in the research-docs store. */
export const RUN_CATEGORY = "research-run";
/** Session key prefix for research agent runs (filtered out of chat "last active"). */
export const RESEARCH_SESSION_PREFIX = "agent:main:research-";
/** A run with no reply after this long is treated as failed/stalled. */
export const RUN_STALL_MS = 45 * 60 * 1000;
/** Research older than this is flagged for refresh. */
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface ResearchSourceRef {
  title: string;
  url?: string;
  /** "web" | "internal" | a gather kind (wikipedia, arxiv, …). */
  kind: string;
  snippet?: string;
  /** Internal sources: what object it points at (report/doc/note/project). */
  ref?: { type: string; id: string };
}

export interface ResearchItem {
  /** Stable library key: `run:<docId>`, `report:<rptId>`, `doc:<docId>`. */
  key: string;
  kind: ResearchKind;
  title: string;
  question?: string;
  status: ResearchStatus;
  createdAt: number;
  updatedAt: number;
  depth?: ResearchDepth;
  sourceMode?: ResearchSourceMode;
  projectId?: string;
  topic?: string;
  reportId?: string;
  docId?: string;
  preview?: string;
  tags: string[];
  category?: string;
  hasPdf?: boolean;
  sessionKey?: string;
}

// ── ids / session keys ─────────────────────────────────────────────

export function newRunId(now = Date.now(), rand = Math.random): string {
  const r = Math.floor(rand() * 36 ** 5)
    .toString(36)
    .padStart(5, "0");
  return `rr-${now.toString(36)}-${r}`;
}

export function sessionKeyForRun(docId: string): string {
  return `${RESEARCH_SESSION_PREFIX}${docId}`;
}

export function isResearchSessionKey(key: string | undefined | null): boolean {
  return typeof key === "string" && key.startsWith(RESEARCH_SESSION_PREFIX);
}

// ── run tags ───────────────────────────────────────────────────────

export interface RunTagInfo {
  depth?: ResearchDepth;
  sourceMode?: ResearchSourceMode;
  projectId?: string;
  reportId?: string;
  failed?: boolean;
}

export function encodeRunTags(info: RunTagInfo, extra: string[] = []): string[] {
  const tags: string[] = ["research-run"];
  if (info.depth) tags.push(`depth-${info.depth}`);
  if (info.sourceMode) tags.push(`src-${info.sourceMode}`);
  if (info.projectId) tags.push(`project-${info.projectId}`);
  if (info.reportId) tags.push(`report-${info.reportId}`);
  if (info.failed) tags.push("failed");
  for (const t of extra) if (t && !tags.includes(t)) tags.push(t);
  return tags;
}

export function decodeRunTags(tags: readonly string[] | undefined): RunTagInfo & { extra: string[] } {
  const out: RunTagInfo & { extra: string[] } = { extra: [] };
  for (const raw of tags ?? []) {
    const t = String(raw).trim();
    if (!t || t === "research-run") continue;
    if (t === "failed") out.failed = true;
    else if (t.startsWith("depth-")) {
      const d = t.slice(6);
      if (d === "quick" || d === "standard" || d === "deep") out.depth = d;
    } else if (t.startsWith("src-")) {
      const s = t.slice(4);
      if (s === "web" || s === "internal" || s === "both") out.sourceMode = s;
    } else if (t.startsWith("project-")) out.projectId = t.slice(8);
    else if (t.startsWith("report-")) out.reportId = t.slice(7);
    else out.extra.push(t);
  }
  return out;
}

/** The research store's frontmatter is line-based: keep values single-line. */
export function singleLine(s: string, max = 280): string {
  const one = String(s ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/"/g, "'")
    .trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function titleFromQuestion(q: string): string {
  const t = singleLine(q, 90).replace(/[?.!]+$/, "");
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "Untitled research";
}

// ── library items ──────────────────────────────────────────────────

export interface ResearchDocLike {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  category?: string;
  status?: string;
  topic?: string;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
}

export function itemFromResearchDoc(d: ResearchDocLike, now = Date.now()): ResearchItem {
  const isRun = d.category === RUN_CATEGORY || (d.tags ?? []).includes("research-run");
  const info = decodeRunTags(d.tags);
  let status: ResearchStatus = "complete";
  if (isRun) {
    if (info.failed || d.status === "review") status = "failed";
    else if (d.status === "draft") {
      status = now - (d.updatedAt ?? d.createdAt ?? now) > RUN_STALL_MS ? "failed" : "running";
    }
  }
  return {
    key: `${isRun ? "run" : "doc"}:${d.id}`,
    kind: isRun ? "run" : "doc",
    title: d.name || d.id,
    question: d.description,
    status,
    createdAt: d.createdAt ?? 0,
    updatedAt: d.updatedAt ?? d.createdAt ?? 0,
    depth: info.depth,
    sourceMode: info.sourceMode,
    projectId: info.projectId,
    topic: d.topic,
    reportId: info.reportId,
    docId: d.id,
    preview: stripRunMeta(d.preview ?? ""),
    tags: isRun ? info.extra : (d.tags ?? []),
    category: d.category,
    sessionKey: isRun ? sessionKeyForRun(d.id) : undefined,
  };
}

export interface ReportLike {
  id: string;
  kind?: string;
  title?: string;
  status?: string;
  createdAt?: number;
  renderedAt?: number | null;
  category?: string | null;
  summaryText?: string | null;
  filePath?: string | null;
  sourceSession?: string | null;
  hasMarkdown?: boolean;
}

/** Report kinds that are system noise, never research (even if filed under "research"). */
const NOISE_KINDS = new Set([
  "oversight_event",
  "gateway_recovery",
  "credit_burn_alert",
  "incident",
  "ceo_hourly_insights",
  "daily_summary",
  "daily_operational",
  "work_review",
]);
const RESEARCH_KINDS = new Set(["research_brief", "competitive_analysis", "market_research", "research", "company_profile"]);
const RESEARCH_TITLE_RE =
  /\b(research|dossier|landscape|competitor|competitive|market (?:analysis|study|map|scan)|deep[- ]dive|feasibility|due diligence|investigation|study|whitepaper|benchmark)\b/i;

export function isResearchReport(r: ReportLike): boolean {
  const kind = String(r.kind ?? "");
  if (NOISE_KINDS.has(kind)) return false;
  if (RESEARCH_KINDS.has(kind)) return true;
  if (isResearchSessionKey(r.sourceSession ?? undefined)) return true;
  if (r.category === "research") return true;
  return RESEARCH_TITLE_RE.test(String(r.title ?? ""));
}

export function itemFromReport(r: ReportLike): ResearchItem {
  const failed = r.status === "failed";
  const running = r.status === "queued" || r.status === "rendering";
  return {
    key: `report:${r.id}`,
    kind: "report",
    title: r.title || r.id,
    status: failed ? "failed" : running ? "running" : "complete",
    createdAt: r.createdAt ?? 0,
    updatedAt: r.renderedAt ?? r.createdAt ?? 0,
    reportId: r.id,
    preview: r.summaryText ?? undefined,
    tags: [],
    category: r.category ?? undefined,
    hasPdf: !!r.filePath,
    sessionKey: r.sourceSession ?? undefined,
  };
}

/**
 * Merge runs, reports and docs into one library. A run that produced a report
 * absorbs it (one row per research, not two).
 */
export function mergeLibrary(
  docs: ResearchDocLike[],
  reports: ReportLike[],
  now = Date.now(),
): ResearchItem[] {
  const items = new Map<string, ResearchItem>();
  const claimedReports = new Set<string>();
  for (const d of docs) {
    const it = itemFromResearchDoc(d, now);
    if (it.reportId) claimedReports.add(it.reportId);
    items.set(it.key, it);
  }
  for (const r of reports) {
    if (!r?.id || claimedReports.has(r.id) || !isResearchReport(r)) continue;
    const it = itemFromReport(r);
    items.set(it.key, it);
  }
  // Runs inherit hasPdf from the report they produced.
  const byReport = new Map(reports.map((r) => [r.id, r]));
  for (const it of items.values()) {
    if (it.kind === "run" && it.reportId) {
      const rep = byReport.get(it.reportId);
      if (rep) it.hasPdf = !!rep.filePath;
    }
  }
  return [...items.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── library filter / sort ──────────────────────────────────────────

export type LibrarySort = "recent" | "oldest" | "title" | "project";
export interface LibraryFilter {
  query?: string;
  status?: ResearchStatus | "all";
  kind?: ResearchKind | "all";
  projectId?: string | "all" | "none";
  sinceMs?: number;
  sort?: LibrarySort;
}

export function filterLibrary(
  items: readonly ResearchItem[],
  f: LibraryFilter,
  projectName: (id: string) => string | undefined = () => undefined,
): ResearchItem[] {
  const q = (f.query ?? "").trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  let out = items.filter((it) => {
    if (f.status && f.status !== "all" && it.status !== f.status) return false;
    if (f.kind && f.kind !== "all" && it.kind !== f.kind) return false;
    if (f.projectId && f.projectId !== "all") {
      if (f.projectId === "none" ? !!it.projectId : it.projectId !== f.projectId) return false;
    }
    if (f.sinceMs && it.updatedAt < f.sinceMs) return false;
    if (terms.length) {
      const hay = [
        it.title,
        it.question,
        it.preview,
        it.topic,
        it.tags.join(" "),
        it.projectId ? projectName(it.projectId) : "",
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
  const sort = f.sort ?? "recent";
  out = [...out].sort((a, b) => {
    if (sort === "oldest") return a.updatedAt - b.updatedAt;
    if (sort === "title") return a.title.localeCompare(b.title);
    if (sort === "project") {
      // Items with a project first (A→Z by project name), then the rest.
      if (!!a.projectId !== !!b.projectId) return a.projectId ? -1 : 1;
      const pa = a.projectId ? (projectName(a.projectId) ?? a.projectId) : "";
      const pb = b.projectId ? (projectName(b.projectId) ?? b.projectId) : "";
      return pa.localeCompare(pb) || b.updatedAt - a.updatedAt;
    }
    return b.updatedAt - a.updatedAt;
  });
  return out;
}

export function isStale(it: ResearchItem, now = Date.now()): boolean {
  return it.status === "complete" && now - it.updatedAt > STALE_AFTER_MS;
}

export function newSince(items: readonly ResearchItem[], lastVisit: number | null): ResearchItem[] {
  if (!lastVisit) return [];
  return items.filter((it) => it.updatedAt > lastVisit && it.status !== "running");
}

// ── run metadata embedded in the research doc body ─────────────────

export interface RunMeta {
  v: 1;
  question: string;
  depth: ResearchDepth;
  sourceMode: ResearchSourceMode;
  projectId?: string;
  topic?: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  sources?: ResearchSourceRef[];
  followUpOf?: string;
}

const META_RE = /^<!--\s*ib-research\s+([\s\S]*?)\s*-->\s*/;

export function embedRunMeta(meta: RunMeta, markdown: string): string {
  // `--` can't appear inside an HTML comment; JSON never produces it except
  // inside strings, so escape it.
  const json = JSON.stringify(meta).replace(/--/g, "-\\u002d");
  return `<!-- ib-research ${json} -->\n\n${markdown.trim()}\n`;
}

export function parseRunMeta(body: string): { meta: RunMeta | null; markdown: string } {
  const m = META_RE.exec(body ?? "");
  if (!m) return { meta: null, markdown: body ?? "" };
  let meta: RunMeta | null = null;
  try {
    meta = JSON.parse(m[1]) as RunMeta;
  } catch {
    meta = null;
  }
  return { meta, markdown: (body ?? "").slice(m[0].length) };
}

export function stripRunMeta(text: string): string {
  return String(text ?? "")
    .replace(/<!--\s*ib-research[\s\S]*?(-->|$)/, "")
    .trim();
}

// ── parsing the agent's markdown output ────────────────────────────

export interface ParsedResearch {
  title?: string;
  summary: string;
  findings: string[];
  actions: string[];
  sources: ResearchSourceRef[];
  openQuestions: string[];
  markdown: string;
}

function sectionKey(heading: string): keyof Pick<ParsedResearch, "summary" | "findings" | "actions" | "sources" | "openQuestions"> | null {
  const h = heading.toLowerCase();
  if (/summary|tl;?dr|overview|answer/.test(h)) return "summary";
  if (/finding|insight|key point|takeaway|highlight/.test(h)) return "findings";
  if (/action|next step|recommend|to[- ]?do/.test(h)) return "actions";
  if (/source|reference|citation|bibliograph/.test(h)) return "sources";
  if (/open question|unknown|gap|caveat|risk/.test(h)) return "openQuestions";
  return null;
}

const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/;
const BARE_URL_RE = /(https?:\/\/[^\s)>\]]+)/;

export function parseSourceLine(line: string): ResearchSourceRef | null {
  const text = line.replace(/^\[\d+\]\s*/, "").trim();
  if (!text) return null;
  const md = MD_LINK_RE.exec(text);
  if (md) {
    const rest = text.replace(md[0], "").replace(/^[\s—–:-]+|[\s—–:-]+$/g, "");
    return { title: md[1].trim(), url: md[2], kind: "web", snippet: rest || undefined };
  }
  const bare = BARE_URL_RE.exec(text);
  if (bare) {
    const title = text.replace(bare[0], "").replace(/^[\s—–:-]+|[\s—–:(-]+$/g, "").trim();
    return { title: title || hostOf(bare[1]), url: bare[1].replace(/[.,;]+$/, ""), kind: "web" };
  }
  // Internal citation, e.g. "Internal: report rpt_123 — Title"
  const internal = /\b(report|note|doc|project|task)[: ]+([A-Za-z0-9_:.-]{4,})/i.exec(text);
  if (internal) {
    return {
      title: text,
      kind: "internal",
      ref: { type: internal[1].toLowerCase(), id: internal[2] },
    };
  }
  return { title: text, kind: "internal" };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function parseResearchMarkdown(markdown: string): ParsedResearch {
  const md = stripRunMeta(markdown ?? "");
  const out: ParsedResearch = {
    summary: "",
    findings: [],
    actions: [],
    sources: [],
    openQuestions: [],
    markdown: md,
  };
  const lines = md.split(/\r?\n/);
  let current: ReturnType<typeof sectionKey> = null;
  let preamble: string[] = [];
  const summaryLines: string[] = [];
  const pushItem = (key: "findings" | "actions" | "openQuestions", text: string) => {
    const t = text.trim();
    if (t) out[key].push(t);
  };
  for (const line of lines) {
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      if (h[1].length === 1 && !out.title) {
        out.title = h[2].trim();
        current = null;
        continue;
      }
      current = sectionKey(h[2]);
      continue;
    }
    if (current === null) {
      preamble.push(line);
      continue;
    }
    if (current === "summary") {
      summaryLines.push(line);
      continue;
    }
    const li = LIST_ITEM_RE.exec(line);
    if (current === "sources") {
      const src = parseSourceLine(li ? li[1] : line);
      if (src && (li || src.url)) out.sources.push(src);
      continue;
    }
    if (li) pushItem(current, li[1]);
    else if (line.trim() && out[current].length) {
      // continuation line of the previous bullet
      out[current][out[current].length - 1] += ` ${line.trim()}`;
    }
  }
  out.summary = summaryLines.join("\n").trim();
  if (!out.summary) {
    const firstPara = preamble.join("\n").trim().split(/\n\s*\n/)[0] ?? "";
    out.summary = firstPara.trim();
  }
  // De-duplicate sources by url/title.
  const seen = new Set<string>();
  out.sources = out.sources.filter((s) => {
    const k = (s.url ?? s.title).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return out;
}

/** Strip simple markdown so a finding reads cleanly as a task title. */
export function plainText(s: string): string {
  return String(s ?? "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/\[\d+\]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

export function taskTitleFrom(text: string, max = 110): string {
  const t = plainText(text).replace(/^(action|todo|next step)s?:\s*/i, "");
  const first = t.split(/(?<=[.!?])\s/)[0] ?? t;
  const pick = first.length >= 12 ? first : t;
  return pick.length > max ? `${pick.slice(0, max - 1)}…` : pick;
}

// ── prompts ────────────────────────────────────────────────────────

export const DEPTH_BUDGET: Record<ResearchDepth, { searches: number; reads: number; words: string }> = {
  quick: { searches: 2, reads: 1, words: "250-400" },
  standard: { searches: 5, reads: 4, words: "500-900" },
  deep: { searches: 10, reads: 8, words: "900-1600" },
};

export interface PromptInput {
  question: string;
  depth: ResearchDepth;
  sourceMode: ResearchSourceMode;
  projectLabel?: string;
  projectId?: string;
  topic?: string;
  webSources?: ResearchSourceRef[];
  internalSources?: ResearchSourceRef[];
  followUpContext?: string;
}

export function numberedSources(list: readonly ResearchSourceRef[], offset = 0): string {
  return list
    .map((s, i) => {
      const where = s.url ? s.url : s.ref ? `${s.ref.type}:${s.ref.id}` : "internal";
      const snip = s.snippet ? ` — ${singleLine(s.snippet, 220)}` : "";
      return `[${i + 1 + offset}] ${singleLine(s.title, 140)} (${where})${snip}`;
    })
    .join("\n");
}

export function buildResearchPrompt(p: PromptInput): string {
  const b = DEPTH_BUDGET[p.depth];
  const lines: string[] = [];
  lines.push(
    `You are running a ${p.depth.toUpperCase()} research task for the InfiniBot Research workspace.`,
    "",
    `QUESTION: ${p.question.trim()}`,
  );
  if (p.projectLabel) lines.push(`SCOPE: project "${p.projectLabel}"${p.projectId ? ` (id ${p.projectId})` : ""} — make findings and actions specific to it.`);
  else if (p.topic) lines.push(`SCOPE: topic "${p.topic}".`);
  if (p.followUpContext) lines.push("", "THIS IS A FOLLOW-UP. What we already know internally:", p.followUpContext.trim());
  lines.push("");
  if (p.sourceMode !== "internal") {
    lines.push(
      `WEB: use web_search (at most ${b.searches} searches) and web_read/web_fetch (at most ${b.reads} pages) to verify and go deeper.`,
    );
  } else {
    lines.push("WEB: do NOT search the web. Answer only from internal knowledge.");
  }
  if (p.sourceMode !== "web") {
    lines.push(
      "INTERNAL: you may use memory_search, research (action search), notes and reports context to pull what InfiniBot already knows.",
    );
  }
  const all = [...(p.webSources ?? []), ...(p.internalSources ?? [])];
  if (all.length) {
    lines.push("", "Sources already gathered for you (cite them by number when used):", numberedSources(all));
  }
  lines.push(
    "",
    "Do NOT create reports, notes, tasks or files yourself — the workspace saves and links the result. Just reply.",
    `Reply in Markdown (${b.words} words), exactly these sections:`,
    "# <short title>",
    "## Summary",
    "2-4 sentences that directly answer the question.",
    "## Key findings",
    "- one finding per bullet, each ending with its citation like [1] or [n]",
    "## Action items",
    "- concrete next steps for us (imperative, one per bullet)",
    "## Open questions",
    "- what is still unknown",
    "## Sources",
    "- [n] [Title](https://url) — one line each; internal sources as `Internal: <type> <id> — <title>`",
  );
  return lines.join("\n");
}

export function buildAskPrompt(question: string, sources: readonly ResearchSourceRef[]): string {
  return [
    "Answer the question using ONLY the internal InfiniBot knowledge below. Do not use the web.",
    "Cite every claim with the source number in brackets, like [2]. If the sources don't contain the answer, say so plainly and say what to research.",
    "Keep it under 250 words. Markdown is fine. Do not create files, notes, tasks or reports.",
    "",
    `QUESTION: ${question.trim()}`,
    "",
    "INTERNAL SOURCES:",
    sources.length ? numberedSources(sources) : "(none found)",
  ].join("\n");
}

// ── internal source ranking ────────────────────────────────────────

const STOP = new Set(
  "a an and are as at be by for from has have how i in is it its of on or our that the their this to was we what when where which who why will with you your about into over than then them they these those do does did can could should would vs via per".split(
    " ",
  ),
);

/** Lower-case word tokens, stop words dropped, naive plural folding (robots → robot). */
export function tokenize(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP.has(t))
    .map((t) => (t.length > 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

/**
 * Weighted token-overlap score in [0,1]: title hits count double. Normalised by
 * at most 5 query tokens, so a long question still finds a short, exact title
 * ("RoboPark") instead of drowning it in the question's other words.
 */
export function relevance(query: string, title: string, body = ""): number {
  const q = [...new Set(tokenize(query))];
  if (!q.length) return 0;
  const norm = Math.min(q.length, 5);
  const t = new Set(tokenize(title));
  const b = new Set(tokenize(body));
  let s = 0;
  for (const tok of q) {
    if (t.has(tok)) s += 2;
    else if (b.has(tok)) s += 1;
  }
  return Math.min(1, s / (norm * 2));
}

const QUESTION_WORDS = new Set(
  "best practice practices keep keeping latest know want need find out tell give list show make get use using good better great new old much many most more some any every each other others like just also really very well way ways thing things kind type".split(" "),
);

/**
 * Short keyword queries for stores that match literally (documents/notes
 * search return nothing for a whole sentence). Proper nouns and names first
 * ("ED-ROM", "RoboPark", "Unitree"), then the longest remaining words.
 */
export function keywordQueries(question: string, max = 3): string[] {
  const raw = String(question ?? "").match(/[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]|[A-Za-z0-9]/g) ?? [];
  const seen = new Set<string>();
  const proper: string[] = [];
  const rest: string[] = [];
  raw.forEach((w, i) => {
    const lw = w.toLowerCase();
    if (lw.length < 3 || STOP.has(lw) || QUESTION_WORDS.has(lw) || seen.has(lw)) return;
    seen.add(lw);
    const isProper = /[A-Z]/.test(w.slice(1)) || /-/.test(w) || (i > 0 && /^[A-Z]/.test(w));
    (isProper ? proper : rest).push(w);
  });
  rest.sort((a, b) => b.length - a.length);
  return [...proper, ...rest].slice(0, max);
}

/** Plain-language note for a memory_search failure (never a raw provider error or path). */
export function memoryNote(error: string): string {
  return /api key|embedding|401|provider|auth/i.test(error)
    ? "Semantic memory search is off (no embeddings key) — searched documents, notes, reports and projects instead."
    : "Memory search is unavailable right now — searched documents, notes, reports and projects instead.";
}

export function rankSources(
  query: string,
  candidates: ReadonlyArray<ResearchSourceRef & { body?: string }>,
  limit = 8,
  min = 0.15,
): ResearchSourceRef[] {
  return candidates
    .map((c) => ({ c, s: relevance(query, c.title, `${c.snippet ?? ""} ${c.body ?? ""}`) }))
    .filter((x) => x.s >= min)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(({ c }) => ({ title: c.title, url: c.url, kind: c.kind, snippet: c.snippet, ref: c.ref }));
}

// ── proactive suggestions ──────────────────────────────────────────

export interface ProjectLike {
  id: string;
  name: string;
  description?: string;
  status?: string;
  archived?: boolean;
  updatedAt?: number;
}

const INACTIVE_PROJECT = /done|complete|archiv|cancel|abandon|paused|on hold|backlog/i;

/** Active projects with no recent research → suggested research topics. */
export function suggestTopics(
  projects: readonly ProjectLike[],
  items: readonly ResearchItem[],
  now = Date.now(),
  limit = 4,
): Array<{ projectId: string; projectName: string; question: string; reason: string }> {
  const lastResearch = new Map<string, number>();
  for (const it of items) {
    if (it.projectId) lastResearch.set(it.projectId, Math.max(lastResearch.get(it.projectId) ?? 0, it.updatedAt));
  }
  const active = projects.filter((p) => !p.archived && !INACTIVE_PROJECT.test(p.status ?? ""));
  return active
    .map((p) => ({ p, last: lastResearch.get(p.id) ?? 0 }))
    .filter(({ last }) => now - last > STALE_AFTER_MS)
    .sort((a, b) => (b.p.updatedAt ?? 0) - (a.p.updatedAt ?? 0))
    .slice(0, limit)
    .map(({ p, last }) => ({
      projectId: p.id,
      projectName: p.name,
      question: suggestedQuestion(p),
      reason: last ? `Last researched ${Math.round((now - last) / 86_400_000)} days ago` : "Never researched",
    }));
}

export function suggestedQuestion(p: ProjectLike): string {
  const d = plainText(p.description ?? "").toLowerCase();
  if (/client|retainer|customer/.test(d)) return `What should we know right now to grow and protect ${p.name}? Competitors, risks and upsell openings.`;
  if (/launch|release|market|landing|sell|pricing/.test(d)) return `Market and competitor scan for ${p.name}: pricing, positioning and gaps we can exploit.`;
  return `Latest developments, competitors and best practices relevant to ${p.name}.`;
}

// ── formatting ─────────────────────────────────────────────────────

export function relativeTime(ts: number, now = Date.now()): string {
  if (!ts) return "—";
  const d = Math.max(0, now - ts);
  const m = Math.round(d / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days}d ago`;
  const mo = Math.round(days / 30);
  return mo < 12 ? `${mo}mo ago` : `${Math.round(mo / 12)}y ago`;
}
