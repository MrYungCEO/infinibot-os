/**
 * UI target resolution: id / alias lookup, natural-language search with a
 * confidence score, availability rules, and reveal-plan building.
 *
 * Deliberately deterministic (no model call): the agent passes the user's
 * words ("where do I turn on solatrix trading") and gets either one target
 * with a confidence or a short candidate list to choose from — never a guess.
 *
 * Dependency-free (shared by the gateway, tests and the UI).
 */

import type {
  RevealPlan,
  RevealStep,
  UiTarget,
  UiTargetAvailabilityResult,
  UiTargetEnv,
  UiTargetMatch,
  UiTargetResolution,
} from "./types.js";

// ── text normalisation ──────────────────────────────────────────────────────

const STOPWORDS = new Set(
  (
    "a an the to do does did i im i'm me my mine we our you your it its is are was be been am of for in into at by with and or " +
    "where wheres where's how what whats what's which who can could would should please pls just go take bring navigate " +
    "open show find see get let lets let's there here that this these those page screen tab view place spot part thing " +
    "want need like make sure help about some any on off up turn"
  ).split(/\s+/),
);

/** Words that change *intent* but not the place. Kept out of scoring. */
const INTENT_PAGE = new Set([
  "open",
  "go",
  "navigate",
  "take",
  "bring",
  "visit",
  "page",
  "screen",
  "tab",
]);
const INTENT_CONTROL = new Set([
  "button",
  "switch",
  "toggle",
  "selector",
  "dropdown",
  "field",
  "input",
  "control",
  "chip",
  "icon",
  "click",
  "press",
  "highlight",
  "point",
]);

/** Query-side synonyms → canonical token(s). */
const SYNONYMS: Record<string, string[]> = {
  activate: ["enable"],
  enabled: ["enable"],
  allow: ["enable", "permission"],
  disable: ["enable"],
  deactivate: ["enable"],
  apikey: ["api", "key"],
  apikeys: ["api", "key"],
  creds: ["credentials"],
  credential: ["credentials"],
  config: ["settings"],
  configure: ["settings"],
  configuration: ["settings"],
  preferences: ["settings"],
  options: ["settings"],
  cli: ["coder"],
  clis: ["coder"],
  coding: ["coder"],
  trade: ["trading"],
  trades: ["trading"],
  bot: ["agent"],
  bots: ["agent"],
  ai: ["agent"],
  telegram: ["telegram"],
  kill: ["freeze"],
  killswitch: ["freeze"],
  stop: ["freeze"],
  mic: ["voice"],
  talk: ["voice", "chat"],
};

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/'s\b/g, "")
    .replace(/[›»>/:_\-.,!?()"[\]{}|+*=#@&;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Porter-lite: enough to make key/keys, enable/enabled/enabling, coder/coders equal. */
export function stem(tok: string): string {
  let t = tok;
  if (t.length > 5 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  for (const suf of ["ing", "ed", "es", "s", "e"]) {
    if (t.length > suf.length + 2 && t.endsWith(suf)) {
      t = t.slice(0, -suf.length);
      break;
    }
  }
  return t;
}

export function tokenize(s: string): string[] {
  return normalizeText(s).split(" ").filter(Boolean);
}

/** Multi-word intents collapsed before tokenising ("turn on" → enable). */
function canonicalPhrases(q: string): string {
  return normalizeText(q)
    .replace(/\b(turn|turned|turning|switch|switched|flip) on\b/g, "enable")
    .replace(/\b(turn|turned|turning|switch|switched|flip) off\b/g, "disable")
    .replace(/\bset up\b/g, "setup")
    .replace(/\bsign in\b|\blog in\b|\blogin\b/g, "signin");
}

/**
 * Query → slots. Each slot is one word of the user's query plus its synonyms;
 * a target earns the slot's credit by matching any of them.
 */
function queryTokens(q: string): {
  slots: string[][];
  tokens: string[];
  wantsPage: boolean;
  wantsControl: boolean;
} {
  const raw = canonicalPhrases(q).split(" ").filter(Boolean);
  let wantsPage = false;
  let wantsControl = false;
  const slots: string[][] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    if (INTENT_PAGE.has(t)) wantsPage = true;
    if (INTENT_CONTROL.has(t)) wantsControl = true;
    // "switch"/"button" etc. still carry meaning when a target is literally named that.
    if (STOPWORDS.has(t) && !INTENT_CONTROL.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    slots.push([...new Set([t, ...(SYNONYMS[t] ?? [])])]);
  }
  return { slots, tokens: slots.map((s) => s[0]!), wantsPage, wantsControl };
}

// ── index ───────────────────────────────────────────────────────────────────

type Indexed = {
  target: UiTarget;
  id: Set<string>;
  title: Set<string>;
  titleTokens: string[];
  keywords: Set<string>;
  phrases: string[];
  desc: Set<string>;
  pluginTokens: string[];
};

const INDEX_CACHE = new WeakMap<readonly UiTarget[], Indexed[]>();

function stems(s: string): string[] {
  return tokenize(s).map(stem);
}

function indexTargets(targets: readonly UiTarget[]): Indexed[] {
  const hit = INDEX_CACHE.get(targets);
  if (hit) return hit;
  const out = targets.map((t) => {
    const idBody = t.id.slice(t.id.indexOf(":") + 1);
    const titleTokens = stems(t.title);
    return {
      target: t,
      id: new Set([
        ...stems(idBody),
        ...(t.aliases ?? []).flatMap((a) => stems(a.slice(a.indexOf(":") + 1))),
      ]),
      title: new Set(titleTokens),
      titleTokens,
      keywords: new Set((t.keywords ?? []).flatMap(stems)),
      phrases: [t.title, ...(t.keywords ?? [])]
        .map(canonicalPhrases)
        .filter((p) => p.includes(" ") || p.length > 3),
      desc: new Set(stems(t.description ?? "")),
      pluginTokens: (() => {
        const owner = t.pluginId ?? t.availability?.plugin;
        if (!owner) return [];
        // The plugin's display name is the first word(s) of its targets' titles.
        return [...new Set([...stems(owner), ...stems(t.title.split("›")[0] ?? "")])];
      })(),
    };
  });
  INDEX_CACHE.set(targets, out);
  return out;
}

// ── lookup ──────────────────────────────────────────────────────────────────

export function findTargetById(
  targets: readonly UiTarget[],
  id: string,
): { target: UiTarget; via: "id" | "alias" } | null {
  const want = id.trim();
  if (!want) return null;
  for (const t of targets) if (t.id === want) return { target: t, via: "id" };
  for (const t of targets) if (t.aliases?.includes(want)) return { target: t, via: "alias" };
  // Case-insensitive fallback ("Page:Setup/Plugins").
  const lower = want.toLowerCase();
  for (const t of targets) if (t.id.toLowerCase() === lower) return { target: t, via: "id" };
  for (const t of targets)
    if (t.aliases?.some((a) => a.toLowerCase() === lower)) return { target: t, via: "alias" };
  return null;
}

/** Is `a` an ancestor of `b` (via `parent` links)? */
export function isAncestor(targets: readonly UiTarget[], a: string, b: string): boolean {
  const byId = new Map(targets.map((t) => [t.id, t]));
  let cur = byId.get(b)?.parent;
  for (let i = 0; cur && i < 8; i++) {
    if (cur === a) return true;
    cur = byId.get(cur)?.parent;
  }
  return false;
}

export type SearchOptions = {
  limit?: number;
  kinds?: UiTarget["kind"][];
  env?: UiTargetEnv;
  /** Include targets that are unavailable in `env` (ranked lower). Default true. */
  includeUnavailable?: boolean;
};

export function searchTargets(
  targets: readonly UiTarget[],
  query: string,
  opts: SearchOptions = {},
): UiTargetMatch[] {
  const { slots, tokens, wantsPage, wantsControl } = queryTokens(query);
  if (tokens.length === 0) return [];
  const slotStems = slots.map((sl) => sl.map(stem));
  const qStems = slotStems.flat();
  const qNorm = canonicalPhrases(query);
  const residual = tokens.join(" ");
  const raw: Array<{ target: UiTarget; score: number; matched: string[] }> = [];
  for (const ix of indexTargets(targets)) {
    const t = ix.target;
    if (opts.kinds && !opts.kinds.includes(t.kind)) continue;
    let sum = 0;
    const matched = new Set<string>();
    for (const slot of slotStems) {
      let w = 0;
      for (const q of slot) {
        if (ix.title.has(q)) ((w = Math.max(w, 1)), matched.add("title"));
        if (ix.id.has(q)) ((w = Math.max(w, 0.95)), matched.add("id"));
        if (ix.keywords.has(q)) ((w = Math.max(w, 0.85)), matched.add("keywords"));
        if (w === 0 && ix.desc.has(q)) ((w = 0.3), matched.add("description"));
      }
      sum += w;
    }
    if (sum === 0) continue;
    let score = sum / slotStems.length;
    // Exact phrase / name hits; longer phrases are stronger evidence.
    let phraseBonus = 0;
    for (const p of ix.phrases) {
      if (p === residual || p === qNorm) {
        phraseBonus = Math.max(phraseBonus, 0.35);
        matched.add("exact");
      } else if (
        p.includes(" ") &&
        (` ${qNorm} `.includes(` ${p} `) || ` ${residual} `.includes(` ${p} `))
      ) {
        phraseBonus = Math.max(phraseBonus, Math.min(0.3, 0.07 * p.split(" ").length));
        matched.add("phrase");
      }
    }
    score += phraseBonus;
    // Specificity: how much of the title the query accounts for.
    const titleHit = ix.titleTokens.filter((x) => qStems.includes(x)).length;
    if (ix.titleTokens.length) score += 0.2 * (titleHit / ix.titleTokens.length);
    // Intent priors.
    if (wantsPage && (t.kind === "page" || t.kind === "section")) score += 0.04;
    if (wantsPage && t.kind === "modal") score += 0.07;
    if (wantsControl && t.kind === "control") score += 0.04;
    if (!wantsControl && t.kind === "nav") score -= 0.03; // prefer the page over its sidebar entry
    if (t.source === "learn") score *= 0.82; // curated / derived ids beat raw walkthrough anchors (generic step titles)
    // A plugin's surfaces only win generic words ("settings", "wallet") when
    // nothing core matches as well; naming the plugin lifts the penalty.
    const owner = t.pluginId ?? t.availability?.plugin;
    if (owner && !ix.pluginTokens.some((x) => qStems.includes(x))) score *= 0.88;
    if (opts.env) {
      const a = evaluateAvailability(t, opts.env);
      if (!a.available) {
        if (opts.includeUnavailable === false) continue;
        score *= 0.85;
      }
    }
    raw.push({ target: t, score, matched: [...matched] });
  }
  raw.sort((a, b) => b.score - a.score || a.target.id.length - b.target.id.length);
  // Raw scores run past 1 (phrase + specificity bonuses); map to 0..1 without
  // flattening the ranking.
  return raw
    .slice(0, opts.limit ?? 8)
    .map((r) => ({ target: r.target, confidence: toConfidence(r.score), matched: r.matched }));
}

/** Raw score (≈0..1.5) → confidence (0..1), monotonic. */
function toConfidence(score: number): number {
  if (score <= 0) return 0;
  return Math.min(0.99, score <= 1 ? score * 0.85 : 0.85 + (score - 1) * 0.28);
}

export const RESOLVE_MIN_CONFIDENCE = 0.45;
export const RESOLVE_AMBIGUITY_GAP = 0.06;

/**
 * Resolve an id, alias or natural-language query to one target. Ambiguous or
 * weak matches come back as `ok:false` with candidates — callers should ask
 * the user (or pick explicitly) instead of guessing.
 */
export function resolveTarget(
  targets: readonly UiTarget[],
  input: { target?: string; query?: string },
  opts: SearchOptions = {},
): UiTargetResolution {
  const id = input.target?.trim();
  if (id) {
    const hit = findTargetById(targets, id);
    if (hit) return { ok: true, target: hit.target, confidence: 1, via: hit.via, alternatives: [] };
    // A bare tab id ("apikeys") or a loose phrase passed as `target`.
    const asPage = findTargetById(targets, `page:${id}`);
    if (asPage && !id.includes(":"))
      return { ok: true, target: asPage.target, confidence: 0.97, via: "alias", alternatives: [] };
  }
  const q = (input.query ?? (id && !/^[a-z-]+:/.test(id) ? id : "")).trim();
  if (!q) {
    return {
      ok: false,
      reason: id ? "not-found" : "empty",
      candidates: id ? searchTargets(targets, id.replace(/^[a-z-]+:/, ""), opts) : [],
    };
  }
  const matches = searchTargets(targets, q, { ...opts, limit: Math.max(opts.limit ?? 8, 8) });
  const top = matches[0];
  if (!top || top.confidence < RESOLVE_MIN_CONFIDENCE)
    return { ok: false, reason: "not-found", candidates: matches.slice(0, 6) };
  // Near-ties are only ambiguous between unrelated places: a page and its own
  // sidebar entry / sub-section are the same answer at different zoom.
  const rivals = matches
    .slice(1)
    .filter((m) => top.confidence - m.confidence < RESOLVE_AMBIGUITY_GAP)
    .filter(
      (m) =>
        !isAncestor(targets, top.target.id, m.target.id) &&
        !isAncestor(targets, m.target.id, top.target.id),
    )
    .filter((m) => !(m.target.kind === "nav" && m.target.tab && m.target.tab === top.target.tab));
  if (rivals.length > 0 && top.confidence < 0.95) {
    return { ok: false, reason: "ambiguous", candidates: [top, ...rivals].slice(0, 6) };
  }
  return {
    ok: true,
    target: top.target,
    confidence: top.confidence,
    via: "query",
    alternatives: matches.slice(1, 4),
  };
}

// ── availability ────────────────────────────────────────────────────────────

export function evaluateAvailability(t: UiTarget, env: UiTargetEnv): UiTargetAvailabilityResult {
  const a = t.availability;
  if (!a) return { available: true };
  if (a.cloud === false && env.cloud)
    return {
      available: false,
      reason: "Not available on InfiniBot Cloud (self-hosted installs only).",
    };
  if (a.local === false && !env.cloud)
    return { available: false, reason: "Only available on InfiniBot Cloud." };
  if (a.plugin && env.enabledPlugins && !env.enabledPlugins.has(a.plugin)) {
    const installed = !env.installedPlugins || env.installedPlugins.has(a.plugin);
    return installed
      ? {
          available: false,
          reason: `The ${a.plugin} plugin is off — turn it on in Home › Plugins first.`,
          fixTarget: `plugin:${a.plugin}/enable`,
        }
      : {
          available: false,
          reason: `The ${a.plugin} plugin isn't installed.`,
          fixTarget: "page:plugins",
        };
  }
  return { available: true };
}

// ── plans ───────────────────────────────────────────────────────────────────

export function sidebarSelectorForTab(tab: string): string {
  return `.nav-item[data-tab-pill="${tab}"]`;
}

/**
 * Turn a target into the concrete steps the browser runs: route, reveal steps
 * (inherited from ancestors that live on the same route), then the element.
 * Pages without an element of their own point at their sidebar entry.
 */
export function buildRevealPlan(targets: readonly UiTarget[], t: UiTarget): RevealPlan {
  const byId = new Map(targets.map((x) => [x.id, x]));
  // Sidebar / nav entries are global chrome: highlight them where the user is.
  const route = t.route ?? (t.kind === "nav" ? undefined : routeOfAncestor(byId, t));
  const reveal: RevealStep[] = [];
  // Ancestors on the same route contribute their reveal steps first
  // (plugin detail → settings section → control).
  const chain: UiTarget[] = [];
  let cur = t.parent ? byId.get(t.parent) : undefined;
  for (let i = 0; cur && i < 6; i++) {
    if ((cur.route ?? routeOfAncestor(byId, cur)) === route) chain.unshift(cur);
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  const seen = new Set<string>();
  for (const step of [...chain.flatMap((c) => c.reveal ?? []), ...(t.reveal ?? [])]) {
    const key = JSON.stringify(step);
    if (seen.has(key)) continue;
    seen.add(key);
    reveal.push(step);
  }
  let selectors = t.selectors ?? [];
  let fallbackSelectors = t.fallbackSelectors;
  let fallbackHint = t.fallbackHint;
  if (selectors.length === 0 && t.tab) {
    // Pages: point at the sidebar entry of the page (or of its host).
    const nav =
      byId.get(`nav:sidebar/${t.tab}`) ??
      (t.parent ? byId.get(`nav:sidebar/${byId.get(t.parent)?.tab ?? ""}`) : undefined);
    const tab = nav?.tab ?? t.tab;
    selectors = [sidebarSelectorForTab(tab)];
    reveal.push({ kind: "sidebar", tab });
    fallbackSelectors = fallbackSelectors ?? [".topbar .nav-collapse-toggle"];
    fallbackHint = fallbackHint ?? "Open the sidebar here to find it.";
  }
  return {
    targetId: t.id,
    title: t.title,
    kind: t.kind,
    ...(route ? { route } : {}),
    reveal,
    selectors,
    ...(fallbackSelectors?.length ? { fallbackSelectors } : {}),
    ...(fallbackHint ? { fallbackHint } : {}),
    ...(t.tab ? { tab: t.tab } : {}),
  };
}

function routeOfAncestor(byId: Map<string, UiTarget>, t: UiTarget): string | undefined {
  let cur = t.parent ? byId.get(t.parent) : undefined;
  for (let i = 0; cur && i < 6; i++) {
    if (cur.route) return cur.route;
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  return undefined;
}

/** Compact, agent-friendly view of a target (for list/search results). */
export function summarizeTarget(t: UiTarget, env?: UiTargetEnv): Record<string, unknown> {
  const a = env ? evaluateAvailability(t, env) : { available: true };
  return {
    id: t.id,
    kind: t.kind,
    title: t.title,
    ...(t.description ? { description: t.description } : {}),
    ...(t.route ? { route: t.route } : {}),
    ...(t.parent ? { parent: t.parent } : {}),
    ...(t.pluginId ? { plugin: t.pluginId } : {}),
    available: a.available,
    ...(a.reason ? { unavailableReason: a.reason } : {}),
    ...(a.fixTarget ? { fixTarget: a.fixTarget } : {}),
  };
}
