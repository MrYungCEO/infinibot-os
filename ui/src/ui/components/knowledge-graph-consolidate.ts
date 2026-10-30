/**
 * Consolidate sub-projects: find duplicate / near-duplicate sub-projects of a
 * parent project and plan turning them into tasks on the parent (or merging
 * each duplicate cluster into its richest member).
 *
 * Nothing is ever deleted. Originals are archived with a back-reference
 * relation (meta.convertedFromProjectId / meta.mergedIntoProjectId), and every
 * step carries its own undo so the whole batch can be reverted. Steps refer to
 * values produced by earlier steps (the new task id, created relation ids) via
 * `$ref:<key>` placeholders that the executor resolves at run time.
 *
 * Pure: no gateway, no DOM — the `<infinibot-knowledge-graph>` host gathers
 * the read-only inputs and executes the steps.
 */

import type { OpEdge, OpNode, RpcCall } from "./knowledge-graph-ops";
import { storeIdOf, tokensOf } from "./knowledge-graph-ops";

// ── Sub-projects of a parent ────────────────────────────────────────

/**
 * Project nodes attached to `parent`: children by "sub-project of" (child →
 * parent), any "relates to" project neighbour, or meta.parentProjectId. The
 * parent's own parent is excluded.
 */
export function subProjectsOf(parent: OpNode, nodes: OpNode[], edges: OpEdge[]): OpNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pid = storeIdOf(parent);
  const grand = typeof parent.meta?.parentProjectId === "string" ? parent.meta.parentProjectId : null;
  const out = new Map<string, OpNode>();
  const add = (id: string) => {
    const n = byId.get(id);
    if (!n || n.kind !== "project" || n.id === parent.id) return;
    if (grand && storeIdOf(n) === grand) return;
    out.set(n.id, n);
  };
  for (const e of edges) {
    if (e.inferred) continue;
    const rel = e.rel.toLowerCase();
    if (rel === "sub-project of") {
      if (e.target === parent.id) add(e.source);
      continue;
    }
    if (rel === "relates to" || rel === "relates_to") {
      if (e.source === parent.id) add(e.target);
      else if (e.target === parent.id) add(e.source);
    }
  }
  for (const n of nodes) if (n.kind === "project" && n.meta?.parentProjectId === pid) add(n.id);
  return [...out.values()];
}

// ── Duplicate clusters ──────────────────────────────────────────────

/** Brand words that say nothing inside their own family (former names, abbreviations). */
const BRAND_ALIASES: Record<string, string[]> = {
  infinibot: ["infinibot", "infinibotos", "ib", "moltbot", "infini", "os"],
};

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const singular = (t: string) => (t.length > 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);

/** Distinctive title tokens of a sub-project: parent/brand words, stopwords and plurals removed. */
export function subTitleTokens(label: string, parentLabel: string): string[] {
  const pc = compact(parentLabel);
  const drop = new Set<string>(tokensOf(parentLabel));
  drop.add(pc);
  for (const [brand, aliases] of Object.entries(BRAND_ALIASES)) {
    if (pc.includes(brand)) for (const a of aliases) drop.add(a);
  }
  // Plural forms of words tokensOf already treats as noise ("projects", "tasks").
  for (const w of ["project", "task", "note"]) drop.add(w);
  const toks = tokensOf(label)
    .map(singular)
    .filter((t) => !drop.has(t) && !(t.length >= 4 && pc.length >= 6 && pc.startsWith(t)));
  return [...new Set(toks)];
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice on character bigrams of the compact strings. */
export function dice(a: string, b: string): number {
  if (a === b) return a ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) ?? 0);
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

/**
 * Title similarity 0..1 of two token lists: exact/compact match → 1; token
 * Jaccard; character Dice on the joined tokens (catches "Web UI" vs "WebUI");
 * full containment of a ≥2-token title scores 0.85.
 */
export function titleSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const ca = a.join("");
  const cb = b.join("");
  if (ca === cb || [...a].sort().join("") === [...b].sort().join("")) return 1;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const jac = inter / (A.size + B.size - inter);
  const contain = inter / Math.min(A.size, B.size);
  // One shared word inside a longer title ("page", "editor") is a topic, not a duplicate.
  const containScore = contain >= 1 && Math.min(A.size, B.size) >= 2 ? 0.85 : contain >= 1 ? 0.5 : 0;
  // Character Dice only counts when the strings are nearly the same (spacing/typos).
  const d = dice(ca, cb);
  return Math.max(jac, d >= 0.82 ? d : d * 0.7, containScore);
}

export const DUP_THRESHOLD = 0.8;
export const NEAR_THRESHOLD = 0.6;

export interface SubCluster {
  /** Stable key (sorted member ids). */
  key: string;
  ids: string[];
  /** "duplicate" when every link scores ≥ DUP_THRESHOLD, else "near". */
  tier: "duplicate" | "near";
  /** Best pair score inside the cluster. */
  score: number;
  /** Richest member — the merge keeper. */
  keeperId: string;
}

/** Richness: tasks weigh most, then connections, then open status. */
export function richness(n: OpNode, degree: number): number {
  const tasks = Number(n.meta?.tasks ?? 0) || 0;
  const status = String(n.meta?.status ?? "").toLowerCase();
  const open = status === "in progress" || status === "reviewing" ? 2 : status === "not started" ? 1 : 0;
  return tasks * 3 + degree + open;
}

/**
 * Group sub-projects into duplicate clusters (same parent, normalised title
 * similarity ≥ NEAR_THRESHOLD, single-link union). Sorted: duplicates first,
 * then by size. Unclustered sub-projects are not returned.
 */
export function clusterSubProjects(
  parent: OpNode,
  subs: OpNode[],
  degreeOf: (id: string) => number = () => 0,
): SubCluster[] {
  const toks = subs.map((s) => subTitleTokens(s.label, parent.label));
  const uf = subs.map((_, i) => i);
  const find = (i: number): number => (uf[i] === i ? i : (uf[i] = find(uf[i])));
  const pairs: Array<[number, number, number]> = [];
  for (let i = 0; i < subs.length; i++) {
    for (let j = i + 1; j < subs.length; j++) {
      // Titles that are nothing but the brand ("InfiniBot") never cluster.
      if (!toks[i].length || !toks[j].length) continue;
      const s = titleSimilarity(toks[i], toks[j]);
      if (s >= NEAR_THRESHOLD) {
        pairs.push([i, j, s]);
        uf[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < subs.length; i++) {
    const r = find(i);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(i);
  }
  const out: SubCluster[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const set = new Set(members);
    const inner = pairs.filter(([a, b]) => set.has(a) && set.has(b));
    const maxS = Math.max(...inner.map((p) => p[2]));
    // Duplicate tier only when EVERY pair is alike (a chain of look-alikes is "near").
    let minS = 1;
    for (let x = 0; x < members.length; x++) {
      for (let y = x + 1; y < members.length; y++) minS = Math.min(minS, titleSimilarity(toks[members[x]], toks[members[y]]));
    }
    const ids = members.map((i) => subs[i].id).sort();
    const keeper = members
      .map((i) => subs[i])
      .sort((a, b) => richness(b, degreeOf(b.id)) - richness(a, degreeOf(a.id)) || a.id.localeCompare(b.id))[0];
    out.push({
      key: ids.join("|"),
      ids,
      tier: minS >= DUP_THRESHOLD ? "duplicate" : "near",
      score: Math.round(maxS * 100) / 100,
      keeperId: keeper.id,
    });
  }
  return out.sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "duplicate" ? -1 : 1) || b.ids.length - a.ids.length || a.key.localeCompare(b.key));
}

// ── Plans ───────────────────────────────────────────────────────────

/** objrel row (objrel.list). */
export interface RelationRow {
  id: string;
  fromType: string;
  fromId: string;
  edge: string;
  toType: string;
  toId: string;
  createdBy?: string;
  meta?: Record<string, unknown>;
}

/** Everything read (read-only) about one sub-project before planning. */
export interface SubDetail {
  node: OpNode;
  /** Store id (Notion page / local id). */
  id: string;
  description?: string;
  status?: string;
  priority?: string;
  archived?: boolean;
  markdown?: string;
  tasks: Array<{ id: string; title: string; status?: string }>;
  relations: RelationRow[];
  /** Notes filed under the sub-project (notes.projectId). */
  notes: Array<{ id: string; label: string }>;
}

export interface ConsolidateStep {
  key: string;
  /** Sub-project this step belongs to (store id). */
  subId: string;
  label: string;
  call: RpcCall;
  /** Save `result.id` as ref `capture` (after the call). */
  capture?: string;
  /** Only capture when the gateway created a new row (result.id === params.clientRequestId). */
  captureIfCreated?: boolean;
  /** Reverts `call`; may use `$ref:` placeholders. Calls with an unresolved ref are dropped. */
  undo: RpcCall[];
  /** Failure aborts (and rolls back) the batch. */
  critical?: boolean;
}

export interface ConsolidationPlan {
  mode: "tasks" | "merge";
  parentId: string;
  parentLabel: string;
  batchId: string;
  steps: ConsolidateStep[];
  /** Per sub-project summary for the preview. */
  items: Array<{
    subId: string;
    nodeId: string;
    label: string;
    /** tasks mode: becomes a task; merge mode: merged into keeper / kept. */
    action: "to-task" | "merge-into" | "keep";
    intoLabel?: string;
    taskTitle?: string;
    taskStatus?: string;
    movedTasks: number;
    checklist: number;
    relationsCopied: number;
    detached: number;
    notesMoved: number;
  }>;
  /** Counts of each RPC method (dry-run report). */
  counts: Record<string, number>;
  /** Number of delete calls — must always be 0 for originals. */
  deletes: number;
}

/** Kanban project status → task status. */
export function taskStatusFor(projectStatus: string | undefined): string {
  switch ((projectStatus ?? "").toLowerCase()) {
    case "in progress":
      return "in_progress";
    case "reviewing":
    case "review":
      return "review";
    case "completed":
    case "done":
      return "done";
    case "paused":
    case "cancelled":
    case "canceled":
      return "backlog";
    default:
      return "todo";
  }
}

export function taskPriorityFor(p: string | undefined): string {
  const v = (p ?? "").toLowerCase();
  return v === "high" || v === "urgent" ? "high" : v === "low" ? "low" : "medium";
}

const TYPED: Record<string, string> = {
  "client>opportunity": "client_has_opportunity",
  "opportunity>project": "opportunity_becomes_project",
  "project>task": "project_has_task",
  "project>product": "project_delivers_product",
  "decision>task": "decision_guides_task",
  "task>person": "task_assigned_to_person",
  "issue>task": "issue_relates_task",
};

/** Edge for a re-pointed relation: the original when the types still fit, else a typed edge, else relates_to. */
function edgeFor(fromType: string, toType: string, original: string, originalFrom: string, originalTo: string): string {
  if (fromType === originalFrom && toType === originalTo) return original;
  return TYPED[`${fromType}>${toType}`] ?? "relates_to";
}

const isDone = (s?: string) => s === "done" || s === "completed";

function counts(steps: ConsolidateStep[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const s of steps) c[s.call.method] = (c[s.call.method] ?? 0) + 1;
  return c;
}

function deletesOf(steps: ConsolidateStep[]): number {
  return steps.filter((s) => /\.delete$/.test(s.call.method) || (s.call.method === "objrel.unlink" && !s.undo.length)).length;
}

function relCopy(rel: RelationRow, subType: string, subId: string, toType: string, toId: string): { fromType: string; fromId: string; toType: string; toId: string; edge: string } {
  const subIsFrom = rel.fromType === subType && rel.fromId === subId;
  const fromType = subIsFrom ? toType : rel.fromType;
  const fromId = subIsFrom ? toId : rel.fromId;
  const tType = subIsFrom ? rel.toType : toType;
  const tId = subIsFrom ? rel.toId : toId;
  return { fromType, fromId, toType: tType, toId: tId, edge: edgeFor(fromType, tType, rel.edge, rel.fromType, rel.toType) };
}

const otherEnd = (rel: RelationRow, subId: string) =>
  rel.fromType === "project" && rel.fromId === subId ? { type: rel.toType, id: rel.toId } : { type: rel.fromType, id: rel.fromId };

/** Relation re-create params (for undoing an unlink) — keeps the original identity + meta. */
function relinkCall(rel: RelationRow): RpcCall {
  return {
    method: "objrel.link",
    params: {
      fromType: rel.fromType,
      fromId: rel.fromId,
      edge: rel.edge,
      toType: rel.toType,
      toId: rel.toId,
      createdBy: rel.createdBy || "knowledge-graph",
      meta: { ...(rel.meta ?? {}), restoredByUndo: true },
      clientRequestId: rel.id,
    },
  };
}

export interface ConvertOpts {
  /** Sub-project tasks: re-parent to the parent project, or list them as a checklist on the new task. */
  taskMode: "move" | "checklist";
  batchId: string;
  /** ISO date for the back-reference text. */
  today: string;
}

/**
 * Plan "Convert to tasks under <parent>": each sub-project becomes a kanban
 * task on the parent, keeping title, description + page body, status,
 * priority, relations (copied onto the task) and notes (re-filed to the
 * parent). Its tasks are re-parented (`move`) or listed as checklist items.
 * The original is archived and linked from the task with
 * meta.convertedFromProjectId; its link to the parent is detached (restored
 * on undo, and recorded in the back-reference meta).
 */
export function planConvertToTasks(parent: OpNode, subs: SubDetail[], opts: ConvertOpts): ConsolidationPlan {
  const pid = storeIdOf(parent);
  const steps: ConsolidateStep[] = [];
  const items: ConsolidationPlan["items"] = [];
  let n = 0;
  const rid = () => `kgc-${opts.batchId}-${++n}`;
  for (const s of subs) {
    const sid = s.id;
    const tk = `task:${sid}`;
    const parentRels = s.relations.filter((r) => {
      const o = otherEnd(r, sid);
      return o.type === "project" && o.id === pid;
    });
    const taskRels = s.relations.filter((r) => r.edge === "project_has_task" && r.fromType === "project" && r.fromId === sid);
    const keepRels = s.relations.filter((r) => !parentRels.includes(r) && !taskRels.includes(r));
    const status = taskStatusFor(s.status ?? String(s.node.meta?.status ?? ""));
    const checklist = opts.taskMode === "checklist" ? s.tasks : [];
    const moved = opts.taskMode === "move" ? s.tasks : [];
    const md = [
      `> Converted from sub-project **${s.node.label}** (\`project:${sid}\`) on ${opts.today} — the original project is archived, not deleted.`,
      s.description?.trim() ?? "",
      s.markdown?.trim() ?? "",
      checklist.length ? `## Checklist (from the sub-project's ${checklist.length} task${checklist.length === 1 ? "" : "s"})\n\n${checklist.map((t) => `- [${isDone(t.status) ? "x" : " "}] ${t.title}`).join("\n")}` : "",
      moved.length ? `## Tasks moved to ${parent.label} (${moved.length})\n\n${moved.map((t) => `- ${t.title}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    steps.push({
      key: `${sid}:create`,
      subId: sid,
      label: `Create task “${s.node.label}” under ${parent.label}`,
      call: {
        method: "kanban.tasks.create",
        params: {
          title: s.node.label,
          projectId: pid,
          description: `${(s.description ?? "").trim().slice(0, 1800)}${s.description ? "\n\n" : ""}[Converted from sub-project project:${sid}]`,
          status,
          priority: taskPriorityFor(s.priority),
        },
      },
      capture: tk,
      undo: [{ method: "kanban.tasks.delete", params: { id: `$ref:${tk}` } }],
      critical: true,
    });
    steps.push({
      key: `${sid}:body`,
      subId: sid,
      label: "Copy description, page body and checklist",
      call: { method: "kanban.tasks.content.setMarkdown", params: { taskId: `$ref:${tk}`, markdown: md } },
      undo: [],
    });
    const backId = rid();
    steps.push({
      key: `${sid}:backref`,
      subId: sid,
      label: "Back-reference task → original sub-project",
      call: {
        method: "objrel.link",
        params: {
          fromType: "task",
          fromId: `$ref:${tk}`,
          edge: "relates_to",
          toType: "project",
          toId: sid,
          createdBy: "knowledge-graph",
          clientRequestId: backId,
          meta: {
            convertedFromProjectId: sid,
            convertedFromTitle: s.node.label,
            parentProjectId: pid,
            consolidationBatch: opts.batchId,
            detachedRelations: parentRels.map((r) => ({ ...r })),
          },
        },
      },
      capture: `rel:${backId}`,
      captureIfCreated: true,
      undo: [{ method: "objrel.unlink", params: { id: `$ref:rel:${backId}` } }],
    });
    for (const r of keepRels) {
      const c = relCopy(r, "project", sid, "task", `$ref:${tk}`);
      const id = rid();
      steps.push({
        key: `${sid}:rel:${r.id}`,
        subId: sid,
        label: `Carry link ${r.edge} → task`,
        call: { method: "objrel.link", params: { ...c, createdBy: "knowledge-graph", clientRequestId: id, meta: { copiedFrom: r.id, consolidationBatch: opts.batchId } } },
        capture: `rel:${id}`,
        captureIfCreated: true,
        undo: [{ method: "objrel.unlink", params: { id: `$ref:rel:${id}` } }],
      });
    }
    for (const t of moved) {
      steps.push({
        key: `${sid}:task:${t.id}`,
        subId: sid,
        label: `Move task “${t.title}” to ${parent.label}`,
        call: { method: "kanban.tasks.update", params: { id: t.id, projectId: pid, source: "bulk" } },
        undo: [{ method: "kanban.tasks.update", params: { id: t.id, projectId: sid, source: "bulk" } }],
      });
    }
    for (const note of s.notes) {
      steps.push({
        key: `${sid}:note:${note.id}`,
        subId: sid,
        label: `File note “${note.label}” under ${parent.label}`,
        call: { method: "notes.update", params: { id: note.id, projectId: pid } },
        undo: [{ method: "notes.update", params: { id: note.id, projectId: sid } }],
      });
    }
    for (const r of parentRels) {
      steps.push({
        key: `${sid}:detach:${r.id}`,
        subId: sid,
        label: `Detach sub-project link from ${parent.label} (saved on the back-reference)`,
        call: { method: "objrel.unlink", params: { id: r.id } },
        undo: [relinkCall(r)],
      });
    }
    steps.push({
      key: `${sid}:archive`,
      subId: sid,
      label: `Archive sub-project “${s.node.label}” (not deleted)`,
      call: { method: "kanban.projects.update", params: { id: sid, archived: true } },
      undo: [{ method: "kanban.projects.update", params: { id: sid, archived: s.archived === true } }],
    });
    items.push({
      subId: sid,
      nodeId: s.node.id,
      label: s.node.label,
      action: "to-task",
      intoLabel: parent.label,
      taskTitle: s.node.label,
      taskStatus: status,
      movedTasks: moved.length,
      checklist: checklist.length,
      relationsCopied: keepRels.length,
      detached: parentRels.length,
      notesMoved: s.notes.length,
    });
  }
  return { mode: "tasks", parentId: parent.id, parentLabel: parent.label, batchId: opts.batchId, steps, items, counts: counts(steps), deletes: deletesOf(steps) };
}

/**
 * Plan "Merge duplicates into one": per cluster, the keeper (richest member)
 * stays; every other member's relations are copied onto the keeper, its tasks
 * and notes move to the keeper, its body is appended to the keeper's page,
 * it is linked to the keeper (meta.mergedIntoProjectId) and archived.
 */
export function planMergeDuplicates(
  parent: OpNode,
  clusters: Array<{ keeper: SubDetail; others: SubDetail[] }>,
  opts: { batchId: string; today: string },
): ConsolidationPlan {
  const pid = storeIdOf(parent);
  const steps: ConsolidateStep[] = [];
  const items: ConsolidationPlan["items"] = [];
  let n = 0;
  const rid = () => `kgc-${opts.batchId}-${++n}`;
  for (const { keeper, others } of clusters) {
    const kid = keeper.id;
    const keeperOther = new Set(keeper.relations.map((r) => `${r.edge}|${otherEnd(r, kid).type}:${otherEnd(r, kid).id}`));
    items.push({ subId: kid, nodeId: keeper.node.id, label: keeper.node.label, action: "keep", movedTasks: 0, checklist: 0, relationsCopied: 0, detached: 0, notesMoved: 0 });
    if (others.length) {
      const appended = others
        .map((o) => [`## Merged from: ${o.node.label}`, `> Was sub-project \`project:${o.id}\` — archived ${opts.today}, not deleted.`, o.description?.trim() ?? "", o.markdown?.trim() ?? ""].filter(Boolean).join("\n\n"))
        .join("\n\n---\n\n");
      steps.push({
        key: `${kid}:append`,
        subId: kid,
        label: `Append ${others.length} merged page${others.length === 1 ? "" : "s"} to “${keeper.node.label}”`,
        call: { method: "kanban.projects.content.appendMarkdown", params: { projectId: kid, markdown: appended } },
        undo: [{ method: "kanban.projects.content.setMarkdown", params: { projectId: kid, markdown: keeper.markdown ?? "" } }],
      });
    }
    for (const o of others) {
      const oid = o.id;
      const parentRels = o.relations.filter((r) => {
        const e = otherEnd(r, oid);
        return e.type === "project" && e.id === pid;
      });
      const copyRels = o.relations.filter((r) => {
        if (parentRels.includes(r)) return false;
        const e = otherEnd(r, oid);
        if (e.type === "project" && e.id === kid) return false;
        if (r.edge === "project_has_task") return false; // tasks move below
        return !keeperOther.has(`${r.edge}|${e.type}:${e.id}`);
      });
      const backId = rid();
      steps.push({
        key: `${oid}:backref`,
        subId: oid,
        label: `Link “${o.node.label}” → kept “${keeper.node.label}”`,
        call: {
          method: "objrel.link",
          params: {
            fromType: "project",
            fromId: oid,
            edge: "relates_to",
            toType: "project",
            toId: kid,
            createdBy: "knowledge-graph",
            clientRequestId: backId,
            meta: { mergedIntoProjectId: kid, parentProjectId: pid, consolidationBatch: opts.batchId, detachedRelations: parentRels.map((r) => ({ ...r })) },
          },
        },
        capture: `rel:${backId}`,
        captureIfCreated: true,
        undo: [{ method: "objrel.unlink", params: { id: `$ref:rel:${backId}` } }],
        critical: true,
      });
      for (const r of copyRels) {
        const c = relCopy(r, "project", oid, "project", kid);
        const id = rid();
        steps.push({
          key: `${oid}:rel:${r.id}`,
          subId: oid,
          label: `Re-point link ${r.edge} → “${keeper.node.label}”`,
          call: { method: "objrel.link", params: { ...c, createdBy: "knowledge-graph", clientRequestId: id, meta: { copiedFrom: r.id, consolidationBatch: opts.batchId } } },
          capture: `rel:${id}`,
          captureIfCreated: true,
          undo: [{ method: "objrel.unlink", params: { id: `$ref:rel:${id}` } }],
        });
      }
      for (const t of o.tasks) {
        steps.push({
          key: `${oid}:task:${t.id}`,
          subId: oid,
          label: `Move task “${t.title}” to “${keeper.node.label}”`,
          call: { method: "kanban.tasks.update", params: { id: t.id, projectId: kid, source: "bulk" } },
          undo: [{ method: "kanban.tasks.update", params: { id: t.id, projectId: oid, source: "bulk" } }],
        });
      }
      for (const note of o.notes) {
        steps.push({
          key: `${oid}:note:${note.id}`,
          subId: oid,
          label: `File note “${note.label}” under “${keeper.node.label}”`,
          call: { method: "notes.update", params: { id: note.id, projectId: kid } },
          undo: [{ method: "notes.update", params: { id: note.id, projectId: oid } }],
        });
      }
      for (const r of parentRels) {
        steps.push({
          key: `${oid}:detach:${r.id}`,
          subId: oid,
          label: `Detach duplicate from ${parent.label}`,
          call: { method: "objrel.unlink", params: { id: r.id } },
          undo: [relinkCall(r)],
        });
      }
      steps.push({
        key: `${oid}:archive`,
        subId: oid,
        label: `Archive duplicate “${o.node.label}” (not deleted)`,
        call: { method: "kanban.projects.update", params: { id: oid, archived: true } },
        undo: [{ method: "kanban.projects.update", params: { id: oid, archived: o.archived === true } }],
      });
      items.push({
        subId: oid,
        nodeId: o.node.id,
        label: o.node.label,
        action: "merge-into",
        intoLabel: keeper.node.label,
        movedTasks: o.tasks.length,
        checklist: 0,
        relationsCopied: copyRels.length,
        detached: parentRels.length,
        notesMoved: o.notes.length,
      });
    }
  }
  return { mode: "merge", parentId: parent.id, parentLabel: parent.label, batchId: opts.batchId, steps, items, counts: counts(steps), deletes: deletesOf(steps) };
}

// ── Execution helpers ───────────────────────────────────────────────

export const UNRESOLVED = Symbol("unresolved");

/** Deep-replace "$ref:key" strings; returns UNRESOLVED when any ref is missing. */
export function resolveRefs<T>(value: T, refs: ReadonlyMap<string, string | null>): T | typeof UNRESOLVED {
  let missing = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string" && v.startsWith("$ref:")) {
      const r = refs.get(v.slice(5));
      if (r == null) {
        missing = true;
        return v;
      }
      return r;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(value) as T;
  return missing ? UNRESOLVED : out;
}

/** Ref value captured from a step result (null = nothing we own to undo). */
export function captureOf(step: ConsolidateStep, call: RpcCall, result: unknown): string | null {
  const id = result && typeof result === "object" ? (result as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || !id) return null;
  if (step.captureIfCreated && call.params.clientRequestId !== id) return null;
  return id;
}

/** Undo calls for the executed steps, newest first, with refs resolved; unresolvable calls dropped. */
export function buildUndo(executed: ConsolidateStep[], refs: ReadonlyMap<string, string | null>): RpcCall[] {
  const out: RpcCall[] = [];
  for (const s of [...executed].reverse()) {
    for (const u of s.undo) {
      const r = resolveRefs(u, refs);
      if (r !== UNRESOLVED) out.push(r);
    }
  }
  return out;
}

/** Plain-text dry-run report. */
export function describePlan(plan: ConsolidationPlan, clusters: SubCluster[], labelOf: (id: string) => string): string {
  const lines: string[] = [];
  lines.push(`DRY RUN — ${plan.mode === "tasks" ? "Convert sub-projects to tasks" : "Merge duplicates"} under “${plan.parentLabel}” (batch ${plan.batchId})`);
  lines.push(`Clusters found: ${clusters.length} (${clusters.filter((c) => c.tier === "duplicate").length} duplicate, ${clusters.filter((c) => c.tier === "near").length} near-duplicate)`);
  for (const c of clusters) {
    lines.push(`  [${c.tier} ${c.score.toFixed(2)}] ${c.ids.map((id) => `${labelOf(id)}${id === c.keeperId ? " (richest)" : ""}`).join("  ·  ")}`);
  }
  lines.push("");
  lines.push("Planned:");
  for (const it of plan.items) {
    if (it.action === "to-task") {
      lines.push(`  • “${it.label}” → task under ${it.intoLabel} [${it.taskStatus}] · ${it.movedTasks} tasks moved · ${it.checklist} checklist · ${it.relationsCopied} links carried · ${it.notesMoved} notes · ${it.detached} parent link(s) detached · original archived`);
    } else if (it.action === "merge-into") {
      lines.push(`  • “${it.label}” → merged into “${it.intoLabel}” · ${it.movedTasks} tasks moved · ${it.relationsCopied} links re-pointed · ${it.notesMoved} notes · archived`);
    } else lines.push(`  • keep “${it.label}”`);
  }
  lines.push("");
  lines.push(`Gateway writes: ${plan.steps.length} — ${Object.entries(plan.counts).map(([m, c]) => `${m}×${c}`).join(", ")}`);
  lines.push(`Deletes of originals: ${plan.deletes}`);
  return lines.join("\n");
}
