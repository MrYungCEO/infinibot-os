/**
 * Deterministic project association for quick capture.
 *
 * The board has 1000+ projects, so the model can't see all of them. This
 * module (pure, no I/O) does two jobs:
 *   1. rankProjects()   — score every project against the spoken text so the
 *      model gets a shortlist of the most plausible candidates (plus the most
 *      recently active ones) instead of an arbitrary first-N slice.
 *   2. matchProject()   — the fuzzy fallback / guard: an explicit or near-
 *      explicit mention ("for the KinglyVault project", "kingly vault",
 *      "the gateway stability work") resolves to a real project id with a
 *      confidence and a short human reason. It never returns an id that is
 *      not in the list it was given.
 */

export type CaptureProject = {
  id: string;
  name: string;
  description?: string;
  aliases?: string[];
  parentId?: string;
  parentName?: string;
  /** ms epoch (or ISO) of the last activity, for recency tie-breaks. */
  updatedAt?: number | string;
  archived?: boolean;
  /** Notion CRM page ids of the project's clients (kanban rows' Notion "Clients"). */
  clientNotionIds?: string[];
};

export type ProjectMatch = {
  project: CaptureProject;
  /** 0..1 */
  confidence: number;
  reason: string;
};

/** Auto-select (preselect in the UI) at or above this confidence; below it is only a suggestion. */
export const AUTO_SELECT_CONFIDENCE = 0.6;

/** Words that carry no project identity on their own. */
const STOP = new Set(
  (
    "a an and the for of to in on at by with from about into onto under over this that these those it its " +
    "my our your their i we you me us is are was were be been am do does did have has had will would should " +
    "can could need needs want add make new idea note task todo log project projects app apps site website " +
    "page work stuff thing things fix update build create remind please also just so then some more"
  ).split(" "),
);

export function normText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function words(s: string): string[] {
  const n = normText(s);
  return n ? n.split(" ") : [];
}

function sigWords(s: string): string[] {
  return words(s).filter((w) => w.length >= 3 && !STOP.has(w));
}

/** Every run of 1..4 consecutive words joined without spaces ("kingly vault" → "kinglyvault"). */
function compactGrams(ws: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < ws.length; i += 1) {
    let acc = "";
    for (let n = 0; n < 4 && i + n < ws.length; n += 1) {
      acc += ws[i + n];
      out.add(acc);
    }
  }
  return out;
}

function recencyOf(p: CaptureProject): number {
  const v = p.updatedAt;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

type Prepared = {
  text: string;
  padded: string;
  ws: string[];
  wordSet: Set<string>;
  grams: Set<string>;
};

function prepare(text: string): Prepared {
  const ws = words(text);
  return {
    text: ws.join(" "),
    padded: ` ${ws.join(" ")} `,
    ws,
    wordSet: new Set(ws),
    grams: compactGrams(ws),
  };
}

/** Score one name/alias against the prepared text. */
function scoreName(name: string, t: Prepared): { score: number; reason: string } | null {
  const nw = words(name);
  if (!nw.length) return null;
  const phrase = nw.join(" ");
  const compact = nw.join("");
  // 1. The whole name spoken as words ("kinglyvault", "infinibot face").
  if (phrase.length >= 3 && t.padded.includes(` ${phrase} `)) {
    // Explicit cue: "for/on/in/about the X (project)" or "X project".
    const cue = new RegExp(
      `(?:\\b(?:for|on|in|about|under|re|regarding|into|to)\\s+(?:the\\s+)?${phrase}\\b|\\b${phrase}\\s+(?:project|board|repo|app)\\b)`,
    );
    const lengthBonus = Math.min(0.04, phrase.length / 500);
    return cue.test(t.text)
      ? { score: 0.96 + lengthBonus, reason: `named it (“${name}”)` }
      : { score: 0.9 + lengthBonus, reason: `mentioned “${name}”` };
  }
  // 2. Spoken with different spacing ("kingly vault" ↔ "KinglyVault").
  if (compact.length >= 5 && t.grams.has(compact)) {
    return { score: 0.86, reason: `heard “${name}”` };
  }
  // 3. Significant-word overlap ("gateway stability" ↔ "InfiniBot gateway stability").
  const sig = sigWords(name);
  if (sig.length >= 2) {
    const hit = sig.filter((w) => t.wordSet.has(w) || t.grams.has(w));
    const f = hit.length / sig.length;
    // Every significant word of a multi-word name, in any order ("the gateway
    // stability on infinibot") — as good as the name itself, and longer names
    // (sub-projects) beat a shorter parent named in the same sentence.
    if (f === 1) {
      return { score: 0.9 + Math.min(0.04, phrase.length / 500), reason: `mentioned “${name}”` };
    }
    if (hit.length >= 2 && f >= 0.5) {
      return { score: 0.45 + 0.35 * f, reason: `words match “${name}”` };
    }
    if (hit.length === 1 && hit[0].length >= 6) {
      return { score: 0.3, reason: `“${hit[0]}” matches “${name}”` };
    }
  }
  return null;
}

export type RankedProject = { project: CaptureProject; score: number; reason: string };

/**
 * Score every (non-archived) project against `text`. Names/aliases dominate;
 * the description adds a little so implicit context can surface a project.
 * Sorted best first; ties broken by longer name then recency.
 */
export function rankProjects(text: string, projects: CaptureProject[]): RankedProject[] {
  const t = prepare(text);
  const out: RankedProject[] = [];
  for (const p of projects) {
    if (!p?.id || !p.name || p.archived) continue;
    let best: { score: number; reason: string } | null = null;
    for (const n of [p.name, ...(p.aliases ?? [])]) {
      const s = typeof n === "string" ? scoreName(n, t) : null;
      if (s && (!best || s.score > best.score)) best = s;
    }
    let score = best?.score ?? 0;
    let reason = best?.reason ?? "";
    if (p.description) {
      const dw = new Set(sigWords(p.description.slice(0, 400)));
      const overlap = [...new Set(t.ws)].filter((w) => w.length >= 4 && !STOP.has(w) && dw.has(w));
      if (overlap.length) {
        // Description-only: ≥ 2 shared words make a weak (never auto) suggestion.
        score += best
          ? Math.min(0.05, 0.02 * overlap.length)
          : Math.min(0.45, 0.15 * overlap.length);
        if (!reason) reason = `about ${overlap.slice(0, 3).join(", ")}`;
      }
    }
    if (score > 0) out.push({ project: p, score, reason });
  }
  return out.sort(
    (a, b) =>
      b.score - a.score ||
      b.project.name.length - a.project.name.length ||
      recencyOf(b.project) - recencyOf(a.project),
  );
}

/** Best deterministic match, or undefined when nothing is plausible. */
export function matchProject(text: string, projects: CaptureProject[]): ProjectMatch | undefined {
  const top = rankProjects(text, projects)[0];
  if (!top || top.score < 0.3) return undefined;
  return {
    project: top.project,
    confidence: Math.min(0.99, Math.round(top.score * 100) / 100),
    reason: top.reason,
  };
}

/**
 * The candidates handed to the model: every ranked hit (up to `max`), then the
 * most recently active projects to fill, so implicit references to current
 * work can still be picked. Order: ranked first, then recent.
 */
export function shortlistProjects(
  text: string,
  projects: CaptureProject[],
  max = 40,
): CaptureProject[] {
  const live = projects.filter((p) => p?.id && p.name && !p.archived);
  if (live.length <= max) return live;
  const ranked = rankProjects(text, live)
    .slice(0, Math.ceil(max * 0.6))
    .map((r) => r.project);
  const seen = new Set(ranked.map((p) => p.id));
  const recent = [...live]
    .sort((a, b) => recencyOf(b) - recencyOf(a))
    .filter((p) => !seen.has(p.id))
    .slice(0, max - ranked.length);
  return [...ranked, ...recent];
}

/** Model confidence as a number (accepts 0..1, 0..100, or high/medium/low). */
export function parseConfidence(v: unknown, fallback = 0.75): number {
  if (typeof v === "number" && Number.isFinite(v)) {
    const n = v > 1 ? v / 100 : v;
    return Math.max(0, Math.min(1, n));
  }
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "high") return 0.85;
    if (s === "medium" || s === "med") return 0.6;
    if (s === "low") return 0.35;
    const n = Number(s.replace("%", ""));
    if (Number.isFinite(n)) return parseConfidence(n, fallback);
  }
  return fallback;
}
