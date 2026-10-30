/**
 * Research linking — pure logic (no Lit, no client).
 *
 * A finished research is anchored on its canonical REPORT (`report:<rptId>`).
 * That is the object the rest of InfiniBot already understands:
 *  - project page Reports  ← `reports.forObject("project", id)` (report_documents_project)
 *  - project page Relations ← `objrel.connections("project", id)`
 *  - knowledge graph       ← report nodes + objrel edges (graph.global.snapshot)
 *
 * So every link is an objrel edge FROM the research report TO the target.
 * Projects go through `reports.link` (the typed report_documents_project edge
 * the Reports panel reads); everything else is a `relates_to` edge carrying a
 * label in meta so it renders with a name even where no resolver exists.
 */

import { relevance, tokenize } from "./model";

export type LinkTargetType = "project" | "task" | "note" | "doc" | "report";

export interface LinkTarget {
  type: LinkTargetType;
  id: string;
  label: string;
  sub?: string;
}

export interface LinkPlan {
  method: "reports.link" | "objrel.link";
  params: Record<string, unknown>;
}

/** Relation-store type + id for a link target (docs are graphed as notes). */
export function relationRef(t: Pick<LinkTarget, "type" | "id">): { type: string; id: string } {
  if (t.type === "doc") return { type: "note", id: t.id.startsWith("doc:") ? t.id : `doc:${t.id}` };
  return { type: t.type, id: t.id };
}

/** Graph node id the target will appear as (`<kind>:<id>`). */
export function graphNodeId(t: Pick<LinkTarget, "type" | "id">): string {
  const r = relationRef(t);
  return `${r.type}:${r.id}`;
}

export function planLink(reportId: string, target: LinkTarget, createdBy = "research"): LinkPlan {
  if (!reportId) throw new Error("research must be saved to Reports before it can be linked");
  if (target.type === "project") {
    return {
      method: "reports.link",
      params: {
        reportId,
        targetType: "project",
        targetId: target.id,
        createdBy,
        meta: { label: target.label, via: "research" },
      },
    };
  }
  const to = relationRef(target);
  if (target.type === "report" && to.id === reportId) throw new Error("cannot link research to itself");
  return {
    method: "objrel.link",
    params: {
      fromType: "report",
      fromId: reportId,
      edge: "relates_to",
      toType: to.type,
      toId: to.id,
      createdBy,
      meta: { label: target.label, via: "research" },
    },
  };
}

export function planUnlink(reportId: string, target: Pick<LinkTarget, "type" | "id">): LinkPlan {
  if (target.type === "project") {
    return { method: "reports.unlink" as LinkPlan["method"], params: { reportId, targetType: "project", targetId: target.id } };
  }
  const to = relationRef(target);
  return {
    method: "objrel.unlink" as LinkPlan["method"],
    params: { fromType: "report", fromId: reportId, edge: "relates_to", toType: to.type, toId: to.id },
  };
}

// ── reading links back (objrel.connections on the report) ──────────

export interface ConnectionLike {
  type: string;
  id: string;
  label?: string;
  title?: string;
  status?: string;
  edge?: string;
  direction?: "in" | "out";
  relationId?: string;
  edgeMeta?: Record<string, unknown>;
}

export interface ResearchLink extends LinkTarget {
  relationId?: string;
  edge?: string;
  direction?: "in" | "out";
}

/** Map a resolved relation neighbor back to a link target (two-way: in OR out edges). */
export function linkFromConnection(c: ConnectionLike): ResearchLink | null {
  if (!c?.type || !c?.id) return null;
  const metaLabel = typeof c.edgeMeta?.label === "string" ? (c.edgeMeta.label as string) : "";
  const label = metaLabel || c.label || c.title || c.id;
  let type: LinkTargetType;
  let id = c.id;
  switch (c.type) {
    case "project":
    case "task":
    case "report":
      type = c.type;
      break;
    case "note":
      if (id.startsWith("doc:")) {
        type = "doc";
        id = id.slice(4);
      } else type = "note";
      break;
    default:
      return null;
  }
  return { type, id, label, sub: c.status, relationId: c.relationId, edge: c.edge, direction: c.direction };
}

export function flattenConnections(result: unknown): ResearchLink[] {
  const groups = (result as { groups?: Array<{ items?: ConnectionLike[]; connections?: ConnectionLike[] }> })?.groups;
  const out: ResearchLink[] = [];
  const seen = new Set<string>();
  for (const g of groups ?? []) {
    for (const c of g.items ?? g.connections ?? []) {
      const l = linkFromConnection(c);
      if (!l) continue;
      const k = `${l.type}:${l.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(l);
    }
  }
  return out;
}

// ── suggestions ────────────────────────────────────────────────────

export interface Candidate extends LinkTarget {
  /** Extra text used only for matching (description, snippet, body excerpt). */
  text?: string;
}

export interface Suggestion extends LinkTarget {
  score: number;
  reason: string;
}

export interface SuggestInput {
  /** Research title + question + summary + findings (what we match against). */
  researchText: string;
  candidates: readonly Candidate[];
  /** Already-linked target keys (`type:id`) — never suggested again. */
  linked: ReadonlySet<string>;
  /** Neighbors of already-linked objects (from objrel/graph) — boosted. */
  neighborKeys?: ReadonlySet<string>;
  /** Project the research was scoped to. */
  scopeProjectId?: string;
  limit?: number;
  minScore?: number;
}

export const targetKey = (t: Pick<LinkTarget, "type" | "id">): string => `${t.type}:${t.id}`;

/**
 * Rank link suggestions by text similarity, plus a boost for objects that are
 * already one hop away in the relation graph and for the research's own scope.
 */
export function suggestLinks(input: SuggestInput): Suggestion[] {
  const text = input.researchText ?? "";
  const tokens = tokenize(text);
  if (!tokens.length && !input.scopeProjectId) return [];
  const min = input.minScore ?? 0.25;
  const out: Suggestion[] = [];
  for (const c of input.candidates) {
    const key = targetKey(c);
    if (input.linked.has(key)) continue;
    let score = 0;
    let reason = "";
    // Similarity is computed both ways: what share of the candidate's name the
    // research mentions (names are short and specific), and how much of the
    // research the candidate's text covers.
    const nameTokens = [...new Set(tokenize(c.label))];
    if (nameTokens.length) {
      const hay = new Set(tokens);
      const hits = nameTokens.filter((t) => hay.has(t)).length;
      const nameScore = hits / nameTokens.length;
      if (nameScore > score) {
        score = nameScore * (nameTokens.length === 1 ? 0.75 : 1);
        if (hits) reason = `Mentions “${c.label}”`;
      }
    }
    const textScore = relevance(text, c.label, c.text ?? "") * 0.8;
    if (textScore > score) {
      score = textScore;
      reason = "Similar topic";
    }
    if (input.scopeProjectId && c.type === "project" && c.id === input.scopeProjectId) {
      score = Math.max(score, 1);
      reason = "Research scope";
    }
    if (input.neighborKeys?.has(key)) {
      score = Math.min(1, score + 0.3);
      reason = reason ? `${reason} · connected` : "Connected to a linked item";
    }
    if (score >= min) out.push({ ...c, score: Math.round(score * 100) / 100, reason });
  }
  return out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)).slice(0, input.limit ?? 8);
}

/** Neighbor keys from an objrel.connections result of any linked object. */
export function neighborKeysFrom(results: readonly unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const r of results) for (const l of flattenConnections(r)) keys.add(targetKey(l));
  return keys;
}

// ── graph read-back helpers (used by tests and the e2e) ────────────

export interface GraphLike {
  nodes?: Array<{ id: string; kind?: string; label?: string }>;
  edges?: Array<{ source: string; target: string; rel?: string }>;
}

export function graphHasResearchEdge(g: GraphLike, reportId: string, target: Pick<LinkTarget, "type" | "id">): boolean {
  const a = `report:${reportId}`;
  const b = graphNodeId(target);
  const hasNode = (g.nodes ?? []).some((n) => n.id === a);
  return (
    hasNode &&
    (g.edges ?? []).some((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a))
  );
}
