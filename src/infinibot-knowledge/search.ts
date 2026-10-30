/**
 * Retrieval over the knowledge base: lexical scoring with phrase matching on
 * curated keywords. Deterministic and dependency-free (runs inside a tool call).
 */

import type { KnowledgeBase, KnowledgeEntry } from "./types.js";

const STOP = new Set(
  "a an and are as at be but by can do does for from how i if in into is it its me my of on or please should so that the their there this to turn use want was we what when where which who why will with you your i'd i'm there's it's can't don't isn't".split(
    " ",
  ),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9'+#.-]+/g, " ")
    .split(" ")
    .map((w) => w.replace(/^[.'-]+|[.'-]+$/g, ""))
    .filter((w) => w.length > 1 && !STOP.has(w));
}

const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "");

export type SearchHit = { entry: KnowledgeEntry; score: number };

const KIND_WEIGHT: Partial<Record<KnowledgeEntry["kind"], number>> = {
  flow: 1.25,
  control: 1.3,
  "plugin-settings": 1.2,
  page: 1.1,
  subview: 1.1,
  section: 1.1,
  plugin: 1.05,
  "setup-check": 0.9,
  "plugin-detail": 0.85,
  tool: 0.8,
  doc: 0.55,
};

export function searchKnowledge(
  kb: KnowledgeBase,
  question: string,
  opts: { limit?: number; enabledPlugins?: string[] | null } = {},
): SearchHit[] {
  const q = question.toLowerCase();
  const words = tokenize(question);
  const stems = new Set(words.map(stem));
  if (!stems.size) return [];
  const mentionedPlugins = new Set(
    kb.entries
      .filter(
        (e) =>
          e.kind === "plugin" && e.pluginId && new RegExp(`\\b${escape(e.pluginId)}\\b`).test(q),
      )
      .map((e) => e.pluginId!),
  );
  const hits: SearchHit[] = [];
  for (const e of kb.entries) {
    let score = 0;
    const title = e.title.toLowerCase();
    for (const s of stems) {
      if (containsWord(title, s)) score += 3;
      if (e.breadcrumb.some((c) => containsWord(c.toLowerCase(), s))) score += 1.5;
      if (containsWord(e.summary.toLowerCase(), s)) score += 0.6;
    }
    for (const k of e.keywords) {
      const kw = k.toLowerCase().trim();
      if (!kw) continue;
      if (kw.length > 3 && q.includes(kw)) score += 2 + Math.min(8, kw.split(" ").length * 2.5);
      else if (stems.has(stem(kw))) score += 2;
    }
    if (e.pluginId && mentionedPlugins.has(e.pluginId)) score += 3;
    if (mentionedPlugins.size && e.pluginId && !mentionedPlugins.has(e.pluginId)) score *= 0.5;
    if (e.id.startsWith("flow:learn/")) score *= 0.7;
    score *= KIND_WEIGHT[e.kind] ?? 1;
    if (score > 0) hits.push({ entry: e, score });
  }
  hits.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
  return hits.slice(0, opts.limit ?? 8);
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsWord(hay: string, stemmed: string): boolean {
  if (stemmed.length < 3) return new RegExp(`\\b${escape(stemmed)}\\b`).test(hay);
  return new RegExp(`\\b${escape(stemmed)}`).test(hay);
}
