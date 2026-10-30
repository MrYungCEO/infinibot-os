/**
 * Pure derivations for the global knowledge graph: project health,
 * cheap name-mention matching and the insight list. Kept free of store
 * imports so it is trivially unit-testable.
 */

export type ProjectHealth = "active" | "review" | "blocked" | "at_risk" | "done" | "backlog";

export const PROJECT_HEALTHS: ProjectHealth[] = [
  "active",
  "review",
  "blocked",
  "at_risk",
  "backlog",
  "done",
];

/** No task or project update for this long → an open project is stale. */
export const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export interface ProjectHealthInput {
  status?: string | null;
  lastActivityAt: number;
  overdue: number;
  blocked: number;
  /** Agent runs / recently-touched in-progress tasks on this project. */
  live: boolean;
  now: number;
}

export interface ProjectHealthResult {
  health: ProjectHealth;
  stale: boolean;
  /** Why the project is at risk / blocked, for tooltips + insights. */
  reasons: string[];
}

/** Map a raw kanban project status + task rollups onto the graph's health scale. */
export function deriveProjectHealth(input: ProjectHealthInput): ProjectHealthResult {
  const s = (input.status ?? "").trim().toLowerCase();
  const reasons: string[] = [];
  if (s === "completed" || s === "done" || s === "cancelled" || s === "canceled") {
    return { health: "done", stale: false, reasons };
  }
  let health: ProjectHealth;
  if (s === "reviewing" || s === "review" || s === "in review") health = "review";
  else if (s === "paused" || s === "awaiting client" || s === "blocked") {
    health = "blocked";
    reasons.push(s === "awaiting client" ? "awaiting client" : s);
  } else if (s === "in progress" || s === "updating" || s === "active") health = "active";
  else health = "backlog";

  // Live agent work promotes a backlog project to active.
  if (input.live && health === "backlog") health = "active";

  if (input.blocked > 0 && health !== "blocked") {
    health = "blocked";
    reasons.push(`${input.blocked} blocked task${input.blocked === 1 ? "" : "s"}`);
  }

  const open = health === "active" || health === "review";
  const stale =
    open &&
    !input.live &&
    input.lastActivityAt > 0 &&
    input.now - input.lastActivityAt > STALE_AFTER_MS;
  if (open && input.overdue > 0) {
    health = "at_risk";
    reasons.push(`${input.overdue} overdue task${input.overdue === 1 ? "" : "s"}`);
  }
  if (stale) {
    health = "at_risk";
    const days = Math.floor((input.now - input.lastActivityAt) / 86_400_000);
    reasons.push(`no activity for ${days} days`);
  }
  return { health, stale, reasons };
}

// ── Name-mention matching ────────────────────────────────────────

/** Names shorter than this, or in the stop list, never match (too noisy). */
const MIN_NAME_LEN = 5;
const STOP_NAMES = new Set([
  "local project",
  "landing page",
  "untitled",
  "default",
  "new project",
  "website",
  "project",
  "client",
  "test",
  "testing",
]);

export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface NameEntry {
  id: string;
  key: string;
}

/**
 * A single plain word ("workspace", "Products", "Richmond") is far too
 * common to attribute a mention to; only distinctive single-word names
 * (CamelCase like "RoboPark", or containing digits) are matchable.
 */
function isDistinctive(original: string, key: string): boolean {
  if (key.includes(" ")) return true;
  return /[a-z][A-Z]/.test(original) || /\d/.test(original);
}

/** Build the matchable entries for a set of named entities (drops noise). */
export function buildNameIndex(items: Array<{ id: string; name: string }>): NameEntry[] {
  const out: NameEntry[] = [];
  const counts = new Map<string, number>();
  for (const it of items) {
    const key = normaliseName(it.name);
    if (key.length < MIN_NAME_LEN || STOP_NAMES.has(key)) continue;
    if (!isDistinctive(it.name.trim(), key)) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    out.push({ id: it.id, key });
  }
  // Ambiguous names (shared by several entities) can't be attributed.
  return out.filter((e) => counts.get(e.key) === 1);
}

/** Whole-word containment on pre-normalised strings. */
function containsWord(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) return false;
    const before = i === 0 || haystack[i - 1] === " ";
    const after = i + needle.length === haystack.length || haystack[i + needle.length] === " ";
    if (before && after) return true;
    from = i + 1;
  }
}

/**
 * Entities from `index` whose name appears (whole-word) in `text`. `text`
 * is normalised here. Bounded by `index.length` indexOf scans — callers cap
 * the text length.
 */
export function findMentions(text: string, index: NameEntry[], max = 8): string[] {
  const hay = normaliseName(text);
  if (hay.length < MIN_NAME_LEN) return [];
  const out: string[] = [];
  for (const e of index) {
    if (e.key.length > hay.length) continue;
    if (containsWord(hay, e.key)) {
      out.push(e.id);
      if (out.length >= max) break;
    }
  }
  return out;
}

// ── Insights ─────────────────────────────────────────────────────

export type InsightKind =
  | "agents-now"
  | "blocked"
  | "overdue"
  | "stale"
  | "no-client"
  | "idle-client"
  | "orphan-notes"
  | "hubs";

export interface GraphInsight {
  id: string;
  kind: InsightKind;
  severity: "high" | "medium" | "info";
  title: string;
  detail?: string;
  /** Node ids to focus/highlight when the insight is clicked. */
  nodeIds: string[];
}

export interface InsightNode {
  id: string;
  kind: string;
  label: string;
  meta?: Record<string, unknown>;
}

export interface InsightEdge {
  source: string;
  target: string;
  rel: string;
}

const OPEN_HEALTH = new Set<string>(["active", "review", "blocked", "at_risk"]);
const ENGAGED_PIPELINE = new Set(["active", "in progress", "updating", "qualified"]);

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function names(nodes: InsightNode[], max = 3): string {
  const head = nodes.slice(0, max).map((n) => n.label);
  const more = nodes.length - head.length;
  return more > 0 ? `${head.join(", ")} +${more}` : head.join(", ");
}

export function computeInsights(
  nodes: InsightNode[],
  edges: InsightEdge[],
  now: number,
): GraphInsight[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const neighbours = new Map<string, Set<string>>();
  for (const e of edges) {
    (neighbours.get(e.source) ?? neighbours.set(e.source, new Set()).get(e.source)!).add(e.target);
    (neighbours.get(e.target) ?? neighbours.set(e.target, new Set()).get(e.target)!).add(e.source);
  }
  const kindOf = (id: string) => byId.get(id)?.kind;
  const projects = nodes.filter((n) => n.kind === "project");
  const health = (n: InsightNode) => String(n.meta?.health ?? "");
  const out: GraphInsight[] = [];

  const runs = nodes.filter((n) => n.kind === "run");
  const hotProjects = projects.filter((p) => p.meta?.live === true);
  if (runs.length || hotProjects.length) {
    const ids = [...runs.map((r) => r.id), ...hotProjects.map((p) => p.id)];
    out.push({
      id: "agents-now",
      kind: "agents-now",
      severity: "info",
      title: runs.length
        ? `${plural(runs.length, "agent run")} in flight`
        : `${plural(hotProjects.length, "project")} with live work`,
      detail: hotProjects.length ? names(hotProjects) : names(runs),
      nodeIds: ids,
    });
  }

  const blocked = projects.filter((p) => health(p) === "blocked");
  if (blocked.length) {
    out.push({
      id: "blocked",
      kind: "blocked",
      severity: "high",
      title: `${plural(blocked.length, "project")} blocked`,
      detail: names(blocked),
      nodeIds: blocked.map((p) => p.id),
    });
  }

  const overdue = projects
    .filter((p) => OPEN_HEALTH.has(health(p)) && Number(p.meta?.overdue ?? 0) > 0)
    .sort((a, b) => Number(b.meta?.overdue ?? 0) - Number(a.meta?.overdue ?? 0));
  if (overdue.length) {
    const tasks = overdue.reduce((acc, p) => acc + Number(p.meta?.overdue ?? 0), 0);
    out.push({
      id: "overdue",
      kind: "overdue",
      severity: "high",
      title: `${plural(tasks, "overdue task")} across ${plural(overdue.length, "project")}`,
      detail: names(overdue),
      nodeIds: overdue.map((p) => p.id),
    });
  }

  const stale = projects
    .filter((p) => p.meta?.stale === true)
    .sort((a, b) => Number(a.meta?.lastActivityAt ?? 0) - Number(b.meta?.lastActivityAt ?? 0));
  if (stale.length) {
    const oldest = Number(stale[0].meta?.lastActivityAt ?? now);
    out.push({
      id: "stale",
      kind: "stale",
      severity: "medium",
      title: `${plural(stale.length, "open project")} gone quiet`,
      detail: `${names(stale)} · oldest ${Math.floor((now - oldest) / 86_400_000)}d idle`,
      nodeIds: stale.map((p) => p.id),
    });
  }

  const noClient = projects.filter(
    (p) =>
      OPEN_HEALTH.has(health(p)) &&
      ![...(neighbours.get(p.id) ?? [])].some((id) => kindOf(id) === "client"),
  );
  if (noClient.length) {
    out.push({
      id: "no-client",
      kind: "no-client",
      severity: "info",
      title: `${plural(noClient.length, "open project")} without a client`,
      detail: names(noClient),
      nodeIds: noClient.map((p) => p.id),
    });
  }

  // Only engaged clients count — a cold lead without a project is normal.
  const engaged = (n: InsightNode) =>
    n.meta?.status === "active" ||
    ENGAGED_PIPELINE.has(String(n.meta?.pipelineStatus ?? "").toLowerCase());
  const idleClients = nodes.filter((n) => {
    if (n.kind !== "client" || !engaged(n)) return false;
    const ps = [...(neighbours.get(n.id) ?? [])]
      .map((id) => byId.get(id))
      .filter((x): x is InsightNode => x?.kind === "project");
    return !ps.some((p) => OPEN_HEALTH.has(health(p)));
  });
  if (idleClients.length) {
    out.push({
      id: "idle-client",
      kind: "idle-client",
      severity: "medium",
      title: `${plural(idleClients.length, "client")} with no active project`,
      detail: names(idleClients),
      nodeIds: idleClients.map((c) => c.id),
    });
  }

  const orphanNotes = nodes.filter((n) => n.kind === "note" && !neighbours.get(n.id)?.size);
  if (orphanNotes.length) {
    out.push({
      id: "orphan-notes",
      kind: "orphan-notes",
      severity: "info",
      title: `${plural(orphanNotes.length, "note")} not linked to anything`,
      detail: names(orphanNotes),
      nodeIds: orphanNotes.map((n) => n.id),
    });
  }

  const hubs = nodes
    .filter((n) => n.kind !== "task" && n.kind !== "row")
    .map((n) => ({ n, d: neighbours.get(n.id)?.size ?? 0 }))
    .filter((x) => x.d >= 3)
    .sort((a, b) => b.d - a.d)
    .slice(0, 5);
  if (hubs.length) {
    out.push({
      id: "hubs",
      kind: "hubs",
      severity: "info",
      title: "Most connected",
      detail: hubs.map((h) => `${h.n.label} (${h.d})`).join(", "),
      nodeIds: hubs.map((h) => h.n.id),
    });
  }
  return out;
}
