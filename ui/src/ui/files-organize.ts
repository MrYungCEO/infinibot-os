/**
 * Files page organisation + analysis shaping (pure, unit-tested).
 *
 *  - BrowserItem: one normalised row for the normal lane (files.list /
 *    files.tree.all + files.context.list) and the secure lane (files.secure.list).
 *  - Grouping (type / date / project / folder / tag / analysis status),
 *    filtering (type, status, has-findings), sorting and per-viewer prefs.
 *  - parseFileAnalysis(): turns a sidecar (markdown description + entities +
 *    analyses[]) into the styled side-panel model (title, summary, findings,
 *    entity chips, tags, confidence meters, sections, text).
 */

export type FileKind = "image" | "video" | "document" | "other" | "folder";
export type AnalysisStatus = "done" | "pending" | "failed" | "none";
export type GroupBy = "none" | "type" | "date" | "project" | "folder" | "tag" | "status";
export type ViewMode = "grid" | "gallery" | "list";
export type SortKey = "name" | "modified" | "size" | "type";
export type Scope = "folder" | "all";

export interface BrowserItem {
  /** Stable key: rel path (normal lane) or vault id (secure lane). */
  key: string;
  name: string;
  /** Files-root relative path (normal lane). */
  path: string | null;
  /** OCR / vault entry id when indexed. */
  ocrId?: string;
  isDirectory: boolean;
  size: number;
  modified: number;
  kind: FileKind;
  ext: string;
  status: AnalysisStatus;
  rawStatus?: "queued" | "processing" | "done" | "failed";
  summary?: string;
  projectId?: string;
  /** Parent folder (rel path, "" = root). */
  folder: string;
  snippet?: string;
  secure: boolean;
  progress?: { done: number; total: number; stage: string };
  /** User-set display name (secure lane); falls back to displayName(name). */
  label?: string;
  /** User tags (secure lane organise). */
  tags?: string[];
  /** Secure collection id (null = Unfiled) and its "A / B" path. */
  collectionId?: string | null;
  notes?: string;
}

/** Lazily fetched sidecar facts (Tag/Entity grouping + has-findings). */
export interface ItemEnrichment {
  entities: string[];
  findings: number;
}

export interface OrganizePrefs {
  groupBy: GroupBy;
  view: ViewMode;
  sort: SortKey;
  asc: boolean;
  types: FileKind[];
  statuses: AnalysisStatus[];
  hasFindings: boolean;
  collapsed: string[];
  scope: Scope;
}

export const DEFAULT_PREFS: OrganizePrefs = {
  groupBy: "none",
  view: "grid",
  sort: "modified",
  asc: false,
  types: [],
  statuses: [],
  hasFindings: false,
  collapsed: [],
  scope: "folder",
};

const PREFS_KEY = "ib.files.organize.v1";

const GROUPS: GroupBy[] = ["none", "type", "date", "project", "folder", "tag", "status"];
const VIEWS: ViewMode[] = ["grid", "gallery", "list"];
const SORTS: SortKey[] = ["name", "modified", "size", "type"];

/** Prefs are remembered per viewer (this browser) and per lane. */
export function loadOrganizePrefs(lane: "normal" | "secure", store: Pick<Storage, "getItem"> | null = safeStorage()): OrganizePrefs {
  try {
    const raw = store?.getItem(`${PREFS_KEY}:${lane}`);
    if (!raw) return { ...DEFAULT_PREFS, ...(lane === "secure" ? { scope: "all" as Scope } : {}) };
    const p = JSON.parse(raw) as Partial<OrganizePrefs>;
    return {
      groupBy: GROUPS.includes(p.groupBy as GroupBy) ? (p.groupBy as GroupBy) : DEFAULT_PREFS.groupBy,
      view: VIEWS.includes(p.view as ViewMode) ? (p.view as ViewMode) : DEFAULT_PREFS.view,
      sort: SORTS.includes(p.sort as SortKey) ? (p.sort as SortKey) : DEFAULT_PREFS.sort,
      asc: typeof p.asc === "boolean" ? p.asc : DEFAULT_PREFS.asc,
      types: Array.isArray(p.types) ? (p.types.filter((t) => typeof t === "string") as FileKind[]) : [],
      statuses: Array.isArray(p.statuses) ? (p.statuses.filter((t) => typeof t === "string") as AnalysisStatus[]) : [],
      hasFindings: Boolean(p.hasFindings),
      collapsed: Array.isArray(p.collapsed) ? p.collapsed.filter((t) => typeof t === "string").slice(0, 200) : [],
      scope: lane === "secure" ? "all" : p.scope === "all" ? "all" : "folder",
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function saveOrganizePrefs(lane: "normal" | "secure", prefs: OrganizePrefs, store: Pick<Storage, "setItem"> | null = safeStorage()) {
  try {
    store?.setItem(`${PREFS_KEY}:${lane}`, JSON.stringify(prefs));
  } catch {
    /* storage full / blocked */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

// ── Classification ───────────────────────────────────────────────────────────

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|svg|heic|heif|tiff?|avif)$/i;
const VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;
const DOC_RE = /\.(pdf|docx?|pptx?|xlsx?|odt|ods|odp|rtf|epub|txt|md|markdown|csv|json|ya?ml|toml|xml|html?|log)$/i;

export function kindOfName(name: string, isDirectory = false): FileKind {
  if (isDirectory) return "folder";
  if (IMAGE_RE.test(name)) return "image";
  if (VIDEO_RE.test(name)) return "video";
  if (DOC_RE.test(name)) return "document";
  return "other";
}

export function isPdfName(name: string): boolean {
  return /\.pdf$/i.test(name);
}

export function analysisStatusOf(raw: string | undefined | null): AnalysisStatus {
  if (raw === "done") return "done";
  if (raw === "failed") return "failed";
  if (raw === "queued" || raw === "processing") return "pending";
  return "none";
}

export function extOf(name: string): string {
  return (/\.[^.\\/]+$/.exec(name)?.[0] ?? "").toLowerCase();
}

export function parentOf(path: string | null | undefined): string {
  if (!path) return "";
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "";
}

/** Project id from a Files-root path (projects/<id>/…, covers/project/<id>/…). */
export function projectIdFromPath(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  const m = /(?:^|\/)(?:projects|covers\/project)\/([^/]+)\//.exec(path);
  return m?.[1];
}

/** What a card shows: the user's name for the file, else a friendly file name. */
export function itemLabel(it: Pick<BrowserItem, "name" | "label">): string {
  return it.label?.trim() || displayName(it.name);
}

/** Hash-named uploads read badly; show a friendlier label. */
export function displayName(name: string): string {
  const m = /^([0-9a-f]{40,64})(\.[a-z0-9]+)$/i.exec(name);
  if (!m) return name;
  return `${m[1].slice(0, 8)}…${m[2].toLowerCase()}`;
}

// ── Grouping / filtering / sorting ──────────────────────────────────────────

export interface ItemGroup {
  id: string;
  label: string;
  /** Icon hint (key into icons.ts) for the group header. */
  icon: string;
  items: BrowserItem[];
}

const TYPE_GROUPS: Array<{ id: FileKind; label: string; icon: string }> = [
  { id: "folder", label: "Folders", icon: "folder" },
  { id: "image", label: "Images", icon: "image" },
  { id: "video", label: "Videos", icon: "video" },
  { id: "document", label: "Documents", icon: "fileText" },
  { id: "other", label: "Other", icon: "layers" },
];

const STATUS_GROUPS: Array<{ id: AnalysisStatus; label: string; icon: string }> = [
  { id: "done", label: "Analysed", icon: "checkCircle" },
  { id: "pending", label: "In progress", icon: "loader" },
  { id: "failed", label: "Failed", icon: "alertCircle" },
  { id: "none", label: "Not analysed", icon: "minus" },
];

export function dateBucket(ms: number, now = Date.now()): { id: string; label: string; order: number } {
  if (!ms) return { id: "unknown", label: "Undated", order: 9 };
  const d = new Date(now);
  const startToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  const startWeek = startToday - dow * 86_400_000;
  const startMonth = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  if (ms >= startToday) return { id: "today", label: "Today", order: 0 };
  if (ms >= startWeek) return { id: "week", label: "This week", order: 1 };
  if (ms >= startMonth) return { id: "month", label: "This month", order: 2 };
  return { id: "older", label: "Older", order: 3 };
}

export function sortBrowserItems(items: BrowserItem[], sort: SortKey, asc: boolean): BrowserItem[] {
  return [...items].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    let cmp = 0;
    switch (sort) {
      case "size":
        cmp = a.size - b.size;
        break;
      case "modified":
        cmp = a.modified - b.modified;
        break;
      case "type":
        cmp = a.kind.localeCompare(b.kind) || a.ext.localeCompare(b.ext);
        break;
      default:
        cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    }
    if (cmp === 0) cmp = a.name.localeCompare(b.name);
    return asc ? cmp : -cmp;
  });
}

export function hasFindings(item: BrowserItem, enrich?: ItemEnrichment): boolean {
  if (enrich) return enrich.findings > 0 || enrich.entities.length > 0;
  return false;
}

export function filterBrowserItems(
  items: BrowserItem[],
  prefs: Pick<OrganizePrefs, "types" | "statuses" | "hasFindings">,
  enrich: Map<string, ItemEnrichment> = new Map(),
): BrowserItem[] {
  return items.filter((it) => {
    if (prefs.types.length && !it.isDirectory && !prefs.types.includes(it.kind)) return false;
    if (prefs.types.length && it.isDirectory && !prefs.types.includes("folder")) return false;
    if (prefs.statuses.length && (it.isDirectory || !prefs.statuses.includes(it.status))) return false;
    if (prefs.hasFindings && !hasFindings(it, enrich.get(it.key))) return false;
    return true;
  });
}

export function groupBrowserItems(
  items: BrowserItem[],
  by: GroupBy,
  opts: {
    enrich?: Map<string, ItemEnrichment>;
    projectNames?: Map<string, string>;
    now?: number;
    /** Max tag groups before the rest fold into "Other tags". */
    maxTags?: number;
    /** "user" = group by the user's own tags (secure lane organise). */
    tagSource?: "entities" | "user";
  } = {},
): ItemGroup[] {
  if (by === "none") return [{ id: "all", label: "All files", icon: "layers", items }];
  const buckets = new Map<string, ItemGroup & { order: number }>();
  const add = (id: string, label: string, icon: string, order: number, it: BrowserItem) => {
    let g = buckets.get(id);
    if (!g) buckets.set(id, (g = { id, label, icon, order, items: [] }));
    if (!g.items.includes(it)) g.items.push(it);
  };
  if (by === "type") {
    for (const it of items) {
      const t = TYPE_GROUPS.find((g) => g.id === it.kind)!;
      add(`type:${t.id}`, t.label, t.icon, TYPE_GROUPS.indexOf(t), it);
    }
  } else if (by === "status") {
    for (const it of items) {
      if (it.isDirectory) {
        add("status:folder", "Folders", "folder", -1, it);
        continue;
      }
      const s = STATUS_GROUPS.find((g) => g.id === it.status)!;
      add(`status:${s.id}`, s.label, s.icon, STATUS_GROUPS.indexOf(s), it);
    }
  } else if (by === "date") {
    for (const it of items) {
      const b = dateBucket(it.modified, opts.now);
      add(`date:${b.id}`, b.label, "calendar", b.order, it);
    }
  } else if (by === "project") {
    for (const it of items) {
      const pid = it.projectId;
      if (!pid) {
        add("project:none", "No project", "minus", 1e9, it);
        continue;
      }
      const label = opts.projectNames?.get(pid) ?? `Project ${pid.slice(0, 8)}`;
      add(`project:${pid}`, label, "briefcase", 0, it);
    }
  } else if (by === "folder") {
    for (const it of items) {
      const f = it.isDirectory ? parentOf(it.path) : it.folder;
      if (it.secure) add(`folder:${f}`, f || "Unfiled", f ? "folder" : "lock", f ? 1 : 0, it);
      else add(`folder:${f}`, f ? prettyFolder(f, opts.projectNames) : "Top level", "folder", f ? 1 : 0, it);
    }
  } else if (by === "tag") {
    const tagsOf = (it: BrowserItem) => (opts.tagSource === "user" ? (it.tags ?? []) : (opts.enrich?.get(it.key)?.entities ?? []));
    const counts = new Map<string, number>();
    for (const it of items) for (const e of tagsOf(it)) counts.set(e, (counts.get(e) ?? 0) + 1);
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, opts.maxTags ?? 24)
      .map(([k]) => k);
    const topSet = new Set(top);
    for (const it of items) {
      const ents = tagsOf(it).filter((e) => topSet.has(e));
      if (!ents.length) {
        if (it.isDirectory) add("tag:folders", "Folders", "folder", -1, it);
        else add("tag:none", "Untagged", "minus", 1e9, it);
        continue;
      }
      for (const e of ents) add(`tag:${e.toLowerCase()}`, e, "tag", top.indexOf(e), it);
    }
  }
  return [...buckets.values()]
    .sort((a, b) => a.order - b.order || (by === "project" || by === "folder" ? a.label.localeCompare(b.label) : 0))
    .map(({ order: _o, ...g }) => g);
}

function prettyFolder(f: string, names?: Map<string, string>): string {
  const pid = projectIdFromPath(`${f}/x`);
  if (pid && names?.has(pid)) return `${f.split("/").slice(0, -1).join("/")}/${names.get(pid)}`;
  const parts = f.split("/");
  return parts.map((p) => (/^[0-9a-f-]{20,}$/i.test(p) ? `${p.slice(0, 8)}…` : p)).join(" / ");
}

// ── Analysis → styled panel model ───────────────────────────────────────────

export interface AnalysisInput {
  name: string;
  description?: string | null;
  markdown?: string | null;
  entities?: string[];
  summary?: string | null;
  confidence?: number | null;
  pageCount?: number;
  analyses?: Array<{
    id: string;
    analyzer: string;
    agentId?: string;
    summary: string;
    findings?: Array<{ title: string; detail?: string; severity?: string; at?: number }>;
    data?: Record<string, unknown>;
  }>;
}

export type FindingIcon = "sparkles" | "fileText" | "link" | "mail" | "dollarSign" | "calendar" | "layers" | "alert" | "lightbulb" | "eye";

export interface ParsedFinding {
  icon: FindingIcon;
  text: string;
  detail?: string;
  severity?: string;
  at?: number;
}

export interface EntityGroup {
  label: string;
  icon: "person" | "globe" | "briefcase" | "calendar" | "dollarSign" | "link" | "tag";
  items: string[];
}

export interface ConfidenceMeter {
  label: string;
  value: number;
}

export interface ParsedSection {
  heading: string;
  body: string;
}

export interface ParsedAnalysis {
  title: string;
  summary: string;
  findings: ParsedFinding[];
  entityGroups: EntityGroup[];
  tags: string[];
  meters: ConfidenceMeter[];
  /** Extra markdown sections (headings other than Summary/Text/Key entities). */
  sections: ParsedSection[];
  /** "Text in this file" — OCR/native markdown. */
  text: string;
  hasContent: boolean;
}

export function splitMarkdownSections(md: string): { intro: string; sections: ParsedSection[] } {
  const sections: ParsedSection[] = [];
  let intro = "";
  let cur: ParsedSection | null = null;
  let inFence = false;
  for (const line of (md ?? "").split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const h = !inFence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      if (cur) sections.push(cur);
      cur = { heading: h[1].replace(/[*_`]/g, "").trim(), body: "" };
      continue;
    }
    if (cur) cur.body += `${line}\n`;
    else intro += `${line}\n`;
  }
  if (cur) sections.push(cur);
  return { intro: intro.trim(), sections: sections.map((s) => ({ ...s, body: s.body.trim() })) };
}

/** First 1–2 sentences. */
export function firstSentences(text: string, n = 2, maxLen = 320): string {
  const clean = stripMd(text).replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const parts = splitSentences(clean);
  let out = parts.slice(0, n).map((x) => x.trim()).join(" ").trim();
  if (out.length > maxLen) out = `${out.slice(0, maxLen - 1).replace(/\s+\S*$/, "")}…`;
  return out;
}

/** Sentence split that keeps "$1,240.00", "v2.1" and "e.g. x" intact. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?][”"')\]]?)\s+(?=[A-Z0-9“"'(\[])/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function stripMd(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\*\*|__|`/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

const ENTITY_ICON: Array<[RegExp, EntityGroup["icon"]]> = [
  [/urls?|links?|websites?|emails?|phones?|handles?|contacts?|\bids?\b/i, "link"],
  [/people|person|names?|roles?|artists?|authors?|characters?|speakers?/i, "person"],
  [/places?|locations?|address|cit(y|ies)|countr|venues?|geograph/i, "globe"],
  [/org|compan|brands?|business|institution|team|labels?|products?|platforms?/i, "briefcase"],
  [/dates?|times?|deadlines?|periods?|years?/i, "calendar"],
  [/amounts?|prices?|money|currency|costs?|totals?|financ|invoice/i, "dollarSign"],
];

function entityIcon(label: string): EntityGroup["icon"] {
  for (const [re, icon] of ENTITY_ICON) if (re.test(label)) return icon;
  return "tag";
}

/** "**People:** Ada, Bob" → { label: People, items: [Ada, Bob] }; plain lines → Mentions. */
export function parseEntityGroups(entities: string[]): EntityGroup[] {
  const groups = new Map<string, EntityGroup>();
  const push = (label: string, item: string) => {
    let it = item.replace(/[*_`]/g, "").replace(/\.$/, "").trim();
    if ((it.match(/"/g) ?? []).length % 2 === 1) it = it.endsWith('"') ? it.slice(0, -1).trim() : `${it}"`;
    if (!it || it.length > 80 || /^(none|n\/a)\b/i.test(it)) return;
    let g = groups.get(label);
    if (!g) groups.set(label, (g = { label, icon: entityIcon(label), items: [] }));
    if (!g.items.some((x) => x.toLowerCase() === it.toLowerCase())) g.items.push(it);
  };
  for (const raw of entities ?? []) {
    const line = String(raw ?? "").trim();
    const cat = /^(?:\*\*)?([^:*\d][^:*]{1,39}?)(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+)$/.exec(line);
    if (cat && !cat[2].startsWith("//")) {
      const label = cat[1].trim();
      const rest = cat[2];
      // URLs/emails may contain commas rarely; split on ", " / "; ".
      for (const part of rest.split(/\s*[;,]\s+(?![^()]*\))/)) push(label, part);
    } else {
      push(classifyLoose(line), line);
    }
  }
  return [...groups.values()].filter((g) => g.items.length).slice(0, 12);
}

function classifyLoose(s: string): string {
  if (/https?:\/\/|www\.|\.[a-z]{2,4}\//i.test(s) || /@[\w-]+\./.test(s)) return "Links & contacts";
  if (/[$€£¥]\s?\d|\d[\d,.]*\s?(usd|eur|gbp)\b/i.test(s)) return "Amounts";
  if (/\b(19|20)\d{2}\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(s)) return "Dates";
  return "Mentions";
}

/** Flat entity names for grouping/search (category prefixes removed). */
export function flattenEntities(entities: string[]): string[] {
  const out: string[] = [];
  for (const g of parseEntityGroups(entities)) for (const it of g.items) if (!out.includes(it)) out.push(it);
  return out;
}

function detectFacts(text: string): ParsedFinding[] {
  const facts: ParsedFinding[] = [];
  if (!text) return facts;
  const tables = (text.match(/^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/gm) ?? []).length;
  if (tables) facts.push({ icon: "layers", text: tables === 1 ? "Contains a table" : `Contains ${tables} tables` });
  const urls = new Set(text.match(/\bhttps?:\/\/[^\s)>\]|]+|\bwww\.[^\s)>\]|]+/gi) ?? []);
  if (urls.size) facts.push({ icon: "link", text: urls.size === 1 ? `Links to ${[...urls][0]}` : `${urls.size} links`, detail: urls.size > 1 ? [...urls].slice(0, 4).join(" · ") : undefined });
  const emails = new Set(text.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g) ?? []);
  if (emails.size) facts.push({ icon: "mail", text: emails.size === 1 ? `Email ${[...emails][0]}` : `${emails.size} email addresses` });
  const amounts = [...new Set(text.match(/[$€£¥]\s?\d[\d,]*(?:\.\d{2})?/g) ?? [])];
  if (amounts.length) facts.push({ icon: "dollarSign", text: amounts.length === 1 ? `Amount ${amounts[0]}` : `${amounts.length} amounts`, detail: amounts.length > 1 ? amounts.slice(0, 5).join(" · ") : undefined });
  const words = stripMd(text).split(/\s+/).filter(Boolean).length;
  if (words) facts.push({ icon: "fileText", text: `${words.toLocaleString()} words of readable text` });
  return facts;
}

function findingIconFor(text: string, severity?: string): FindingIcon {
  if (severity === "high" || severity === "medium") return "alert";
  if (/\$|€|£|price|cost|amount|total/i.test(text)) return "dollarSign";
  if (/https?:|www\.|link|url/i.test(text)) return "link";
  if (/date|deadline|\b(19|20)\d{2}\b/i.test(text)) return "calendar";
  return "sparkles";
}

function bulletsOf(body: string): string[] {
  return body
    .split("\n")
    .map((l) => /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(l)?.[1]?.trim())
    .filter((l): l is string => Boolean(l));
}

const BUILTIN_SECTIONS = /^(summary|text|key entities|entities|description|overview)$/i;

export function parseFileAnalysis(input: AnalysisInput): ParsedAnalysis {
  const desc = (input.description ?? "").trim();
  const { intro, sections } = splitMarkdownSections(desc);
  const sec = (re: RegExp) => sections.find((s) => re.test(s.heading));
  const summarySec = sec(/^(summary|overview|description)$/i);
  const textSec = sec(/^text$/i);
  const text = (input.markdown ?? "").trim() || textSec?.body || "";

  // Summary: model's Summary section → intro paragraph → first analysis summary → a
  // synthesised line from the readable text (never the raw OCR dump).
  const described = summarySec?.body || intro || input.analyses?.find((a) => a.summary)?.summary || "";
  const summarySource = described || synthesizedSummary(input, text);
  const summary = firstSentences(summarySource, 2);

  // Title: a markdown H1 in the text, a quoted title in the summary, else a friendly file name.
  const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(text)?.[1] ?? /^#\s+(.+?)\s*$/m.exec(textSec?.body ?? "")?.[1];
  const quoted = /\b(?:titled|called|named|headline[d]?)\s+[“"']([^”"']{3,90})[”"']/i.exec(summarySource)?.[1];
  const title = stripMd(h1 ?? quoted ?? "").trim() || (displayName(input.name) !== input.name ? firstHeadingLine(text) : "") || prettyTitle(input.name);

  const findings: ParsedFinding[] = [];
  for (const a of input.analyses ?? []) {
    for (const f of a.findings ?? []) {
      findings.push({ icon: findingIconFor(f.title, f.severity), text: f.title, detail: f.detail, severity: f.severity, at: f.at });
    }
  }
  const extra = sections.filter((s) => !BUILTIN_SECTIONS.test(s.heading));
  for (const s of extra) {
    if (/finding|insight|highlight|observation|notes?|takeaway/i.test(s.heading)) {
      for (const b of bulletsOf(s.body)) findings.push({ icon: findingIconFor(b), text: stripMd(b) });
    }
  }
  // Remaining summary sentences beyond the card become observations.
  const rest = splitSentences(stripMd(summarySource).replace(/\s+/g, " "));
  for (const s of rest.slice(2, 5)) findings.push({ icon: "eye", text: s.trim() });
  findings.push(...detectFacts(text));
  if ((input.pageCount ?? 0) > 1) findings.push({ icon: "fileText", text: `${input.pageCount} pages` });

  const entityGroups = parseEntityGroups(input.entities ?? []);
  const tags = [...new Set([...entityGroups.map((g) => g.label), ...(text && /\|\s*:?-{2,}/.test(text) ? ["Table"] : [])])].slice(0, 10);

  const meters: ConfidenceMeter[] = [];
  if (typeof input.confidence === "number") meters.push({ label: "Text recognition", value: clamp01(input.confidence) });
  for (const a of input.analyses ?? []) {
    const c = (a.data as { confidence?: unknown } | undefined)?.confidence;
    if (typeof c === "number") meters.push({ label: String((a.data as { agentName?: string })?.agentName ?? a.agentId ?? a.analyzer), value: clamp01(c) });
  }

  return {
    title,
    summary,
    findings: dedupeFindings(findings).slice(0, 14),
    entityGroups,
    tags,
    meters,
    sections: extra.filter((s) => !/finding|insight|highlight|observation|notes?|takeaway/i.test(s.heading) && s.body),
    text,
    hasContent: Boolean(summary || text || findings.length || entityGroups.length),
  };
}

/** Short first line of a document ("INVOICE", "Quarterly report") for hash-named files. */
export function firstHeadingLine(text: string): string {
  for (const raw of text.split("\n").slice(0, 12)) {
    const line = stripMd(raw).replace(/\s+/g, " ").trim();
    if (!line || /^page \d+$/i.test(line)) continue;
    if (line.length < 3 || line.length > 70) return "";
    const letters = (line.match(/[A-Za-z]/g) ?? []).length;
    return letters / line.length >= 0.6 ? line : "";
  }
  return "";
}

/** First readable sentence of OCR text (skips page markers and garbled lines). */
export function firstReadableSentence(text: string): string {
  for (const raw of text.split("\n")) {
    const line = stripMd(raw).replace(/\s+/g, " ").trim();
    if (!line || /^page \d+$/i.test(line) || line.length < 30) continue;
    const letters = (line.match(/[A-Za-z\s,.'’-]/g) ?? []).length;
    if (letters / line.length < 0.85 || line.split(" ").length < 6) continue;
    const s = splitSentences(line)[0] ?? line;
    return s.length > 220 ? `${s.slice(0, 219).replace(/\s+\S*$/, "")}…` : s;
  }
  return "";
}

function synthesizedSummary(input: AnalysisInput, text: string): string {
  if (!text) return "";
  const k = kindOfName(input.name);
  const pages = (input.pageCount ?? 0) > 1 ? `${input.pageCount}-page ` : "";
  const what = isPdfName(input.name) ? `${pages}PDF` : k === "image" ? "image" : `${pages}document`;
  const first = firstReadableSentence(text);
  return `A ${what} with ${stripMd(text).split(/\s+/).filter(Boolean).length.toLocaleString()} words of readable text.${first ? ` Includes: “${first.replace(/[.”"]+$/, "")}.”` : ""}`;
}

function dedupeFindings(fs: ParsedFinding[]): ParsedFinding[] {
  const seen = new Set<string>();
  return fs.filter((f) => {
    const k = f.text.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
}

function prettyTitle(name: string): string {
  const shown = displayName(name);
  if (shown !== name) {
    const k = kindOfName(name);
    return k === "image" ? "Untitled image" : k === "video" ? "Untitled video" : k === "document" ? "Untitled document" : shown;
  }
  return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || name;
}

/** Count of findings for the has-findings filter (cheap, from a sidecar). */
export function enrichmentFromSidecar(sc: { entities?: string[]; analyses?: AnalysisInput["analyses"] } | null | undefined): ItemEnrichment {
  const entities = flattenEntities(sc?.entities ?? []).slice(0, 12);
  let findings = 0;
  for (const a of sc?.analyses ?? []) {
    findings += a.findings?.length ?? 0;
    const d = a.data as { moments?: unknown[]; observations?: unknown[] } | undefined;
    findings += (d?.moments?.length ?? 0) + (d?.observations?.length ?? 0);
  }
  return { entities, findings };
}

// ── Secure collections (user organisation) ──────────────────────────────────

export interface SecureCollectionInfo {
  id: string;
  name: string;
  parentId: string | null;
  path?: string;
  count?: number;
}

export interface CollectionNode extends SecureCollectionInfo {
  depth: number;
  /** Files in this collection and every sub-collection. */
  total: number;
  hasChildren: boolean;
}

/** Depth-first, name-sorted flat tree (orphans surface at the top level). */
export function buildCollectionTree(list: SecureCollectionInfo[]): CollectionNode[] {
  const ids = new Set(list.map((c) => c.id));
  const kids = new Map<string | null, SecureCollectionInfo[]>();
  for (const c of list) {
    const parent = c.parentId && ids.has(c.parentId) && c.parentId !== c.id ? c.parentId : null;
    const arr = kids.get(parent) ?? [];
    arr.push(c);
    kids.set(parent, arr);
  }
  for (const arr of kids.values()) arr.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const out: CollectionNode[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number): number => {
    let sum = 0;
    for (const c of kids.get(parent) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const node: CollectionNode = { ...c, depth, total: 0, hasChildren: (kids.get(c.id)?.length ?? 0) > 0 };
      out.push(node);
      node.total = (c.count ?? 0) + walk(c.id, depth + 1);
      sum += node.total;
    }
    return sum;
  };
  walk(null, 0);
  return out;
}

/** Ids of a collection and all its descendants. */
export function collectionSubtree(list: SecureCollectionInfo[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of list) {
      if (c.parentId && out.has(c.parentId) && !out.has(c.id)) {
        out.add(c.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Autocomplete for the tag input: prefix matches first, then substring; excludes tags already set. */
export function tagSuggestions(all: string[], query: string, existing: string[] = [], limit = 8): string[] {
  const have = new Set(existing.map((t) => t.toLowerCase()));
  const q = query.trim().replace(/^#+/, "").toLowerCase();
  const pool = [...new Set(all)].filter((t) => !have.has(t.toLowerCase()));
  if (!q) return pool.slice(0, limit);
  const starts = pool.filter((t) => t.toLowerCase().startsWith(q));
  const contains = pool.filter((t) => !t.toLowerCase().startsWith(q) && t.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, limit);
}

/** Same normalisation as the gateway (trim, drop leading #, collapse spaces, 40 chars). */
export function cleanTag(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().replace(/^#+\s*/, "").slice(0, 40).trim();
}
