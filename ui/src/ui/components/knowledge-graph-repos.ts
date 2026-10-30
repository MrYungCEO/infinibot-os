/**
 * Knowledge graph — "Repos" mode.
 *
 * Turns `projects.repo.graph` payloads into the same GraphSnapshot the
 * normal graph uses, so repos render on the shared scene / 3D stage:
 *
 *   project (gem) → repo (chip) → directories (neuron) → files (pages)
 *
 * Files are coloured by language, sized by recent-commit heat; import
 * edges come from the gateway scan. Directories the gateway left collapsed
 * carry `meta.expandable` so a double-click asks for the next level.
 * Pure — no Lit/DOM, so it runs under plain vitest.
 */

import type { GraphEdgeIn, GraphNodeIn, GraphSnapshot } from "./knowledge-graph-scene";
import type { GraphNodeKind, ProjectHealth } from "./knowledge-graph-model";

export interface RepoGraphNodeIn {
  id: string;
  kind: "dir" | "file" | "more";
  name: string;
  parent: string | null;
  depth: number;
  lang?: string;
  ext?: string;
  size?: number;
  commits?: number;
  heat?: number;
  fileCount?: number;
  expanded?: boolean;
}

export interface RepoGraphPayload {
  root: string;
  projectId?: string;
  head: string | null;
  repo: {
    name: string;
    branch?: string;
    remoteSlug?: string;
    dirty?: boolean;
    dirtyCount?: number;
    ahead?: number;
    behind?: number;
    lastCommit?: { sha: string; subject: string; at: number };
  };
  nodes: RepoGraphNodeIn[];
  edges: Array<{ source: string; target: string; kind: "contains" | "import"; weight?: number }>;
  stats: {
    files: number;
    dirs: number;
    visibleNodes: number;
    importEdges: number;
    truncatedWalk: boolean;
    collapsedDirs: number;
    heatWindowDays: number;
    scanMs: number;
  };
}

export const REPO_KINDS: ReadonlySet<GraphNodeKind> = new Set<GraphNodeKind>([
  "project",
  "database",
  "topic",
  "file",
]);

export const ALL_HEALTH: ReadonlySet<ProjectHealth> = new Set<ProjectHealth>([
  "active",
  "review",
  "blocked",
  "at_risk",
  "backlog",
  "done",
]);

/** Language palette (also the Repos legend). */
export const LANG_COLORS: Record<string, string> = {
  ts: "#3b82f6",
  js: "#facc15",
  py: "#22c55e",
  md: "#e5e7eb",
  json: "#f97316",
  css: "#ec4899",
  html: "#ef4444",
  config: "#94a3b8",
  shell: "#84cc16",
  go: "#06b6d4",
  rust: "#d97706",
  swift: "#fb923c",
  kotlin: "#a855f7",
  java: "#b45309",
  ruby: "#dc2626",
  php: "#818cf8",
  c: "#64748b",
  cpp: "#0ea5e9",
  sql: "#14b8a6",
  image: "#c084fc",
  media: "#f472b6",
  doc: "#cbd5e1",
  other: "#6b7280",
};

export const LANG_LABELS: Record<string, string> = {
  ts: "TypeScript",
  js: "JavaScript",
  py: "Python",
  md: "Markdown",
  json: "JSON",
  css: "CSS",
  html: "HTML",
  config: "Config",
  shell: "Shell",
  image: "Images",
  doc: "Docs",
  other: "Other",
};

const REPO_GOLD = "#d4af37";
const DIR_COLOR = "#9b8cff";
const HOT = [255, 120, 48];

/** Blend a hex colour toward "hot" orange by heat (0..1, capped at 55 %). */
export function heatTint(hex: string, heat: number | undefined): string {
  const h = Math.max(0, Math.min(1, heat ?? 0)) * 0.55;
  if (!h) return hex;
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const mix = rgb.map((c, i) => Math.round(c + (HOT[i] - c) * h));
  return `#${mix.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

export const repoProjectNodeId = (pid: string) => `repo-project:${pid}`;
export const repoRootNodeId = (pid: string) => `repo:${pid}`;
export const repoEntryNodeId = (pid: string, rel: string) => `repo-entry:${pid}:${rel}`;

export interface RepoNodeMeta {
  repoNode: "project" | "repo" | "dir" | "file" | "more";
  projectId: string;
  root: string;
  /** Repo-relative path ("" for the root). */
  path: string;
  repoColor: string;
  lang?: string;
  size?: number;
  commits?: number;
  heat?: number;
  fileCount?: number;
  expandable?: boolean;
  branch?: string;
}

export function repoMetaOf(meta: Record<string, unknown> | undefined): RepoNodeMeta | null {
  return meta && typeof meta.repoNode === "string" ? (meta as unknown as RepoNodeMeta) : null;
}

/** Convert one or more repo scans into a KG snapshot. */
export function repoGraphsToSnapshot(
  graphs: Array<{ projectId: string; projectName: string; graph: RepoGraphPayload }>,
): GraphSnapshot {
  const nodes: GraphNodeIn[] = [];
  const edges: GraphEdgeIn[] = [];
  const typeStats: Partial<Record<GraphNodeKind, number>> = {};
  const bump = (k: GraphNodeKind) => (typeStats[k] = (typeStats[k] ?? 0) + 1);

  for (const { projectId: pid, projectName, graph } of graphs) {
    const r = graph.repo;
    const projectNode = repoProjectNodeId(pid);
    const repoNode = repoRootNodeId(pid);
    nodes.push({
      id: projectNode,
      kind: "project",
      label: projectName,
      weight: 1,
      meta: {
        repoNode: "project",
        projectId: pid,
        root: graph.root,
        path: "",
        status: "In progress",
        health: "active",
        live: r.dirty === true,
        repoColor: REPO_GOLD,
      },
    });
    bump("project");
    const branch = r.branch ? ` · ${r.branch}` : "";
    nodes.push({
      id: repoNode,
      kind: "database",
      label: `${r.remoteSlug?.split("/")[1] ?? r.name}${branch}`,
      weight: 1,
      meta: {
        repoNode: "repo",
        projectId: pid,
        root: graph.root,
        path: "",
        repoColor: REPO_GOLD,
        branch: r.branch,
        fileCount: graph.stats.files,
        dirty: r.dirty,
        dirtyCount: r.dirtyCount,
        ahead: r.ahead,
        behind: r.behind,
        lastCommit: r.lastCommit,
        remoteSlug: r.remoteSlug,
        stats: graph.stats,
      },
    });
    bump("database");
    edges.push({ source: projectNode, target: repoNode, rel: "repo", weight: 3 });

    const idOf = (rel: string) => (rel === "" ? repoNode : repoEntryNodeId(pid, rel));
    for (const n of graph.nodes) {
      if (n.id === "") continue; // the repo node stands in for the root dir
      if (n.kind === "file") {
        const color = heatTint(LANG_COLORS[n.lang ?? "other"] ?? LANG_COLORS.other, n.heat);
        nodes.push({
          id: idOf(n.id),
          kind: "file",
          label: n.name,
          // Hot files are bigger (radius scales with weight).
          weight: 0.2 + 0.8 * Math.max(0, Math.min(1, n.heat ?? 0)),
          meta: {
            repoNode: "file",
            projectId: pid,
            root: graph.root,
            path: n.id,
            repoColor: color,
            lang: n.lang,
            size: n.size,
            commits: n.commits,
            heat: n.heat,
            fileKind: n.lang === "image" ? "image" : "text",
          },
        });
        bump("file");
      } else {
        const isMore = n.kind === "more";
        const expandable = !isMore && !n.expanded && (n.fileCount ?? 0) > 0;
        nodes.push({
          id: idOf(n.id),
          kind: "topic",
          label: isMore ? n.name : expandable ? `${n.name}/ (${n.fileCount})` : `${n.name}/`,
          weight: Math.min(1, 0.3 + Math.log10(1 + (n.fileCount ?? 0)) / 3),
          meta: {
            repoNode: isMore ? "more" : "dir",
            projectId: pid,
            root: graph.root,
            path: isMore ? (n.parent ?? "") : n.id,
            repoColor: heatTint(isMore ? "#6b7280" : DIR_COLOR, n.heat),
            fileCount: n.fileCount,
            commits: n.commits,
            heat: n.heat,
            expandable: expandable || isMore,
          },
        });
        bump("topic");
      }
    }
    for (const e of graph.edges) {
      edges.push({
        source: idOf(e.source),
        target: idOf(e.target),
        rel: e.kind === "import" ? "imports" : "contains",
        weight: e.weight ?? 1,
        inferred: false,
      });
    }
  }
  return { generatedAt: Date.now(), nodes, edges, typeStats, kinds: [...REPO_KINDS] };
}

/** Node budget per repo so "All repos" stays responsive. */
export function repoNodeBudget(repoCount: number): number {
  if (repoCount <= 1) return 1200;
  return Math.max(250, Math.floor(1600 / repoCount));
}

/** Languages present in a snapshot (legend), most common first. */
export function repoLanguages(snapshot: GraphSnapshot | null): Array<{ lang: string; count: number }> {
  const counts = new Map<string, number>();
  for (const n of snapshot?.nodes ?? []) {
    const m = repoMetaOf(n.meta);
    if (m?.repoNode !== "file") continue;
    const l = m.lang ?? "other";
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  return [...counts.entries()].map(([lang, count]) => ({ lang, count })).sort((a, b) => b.count - a.count);
}
