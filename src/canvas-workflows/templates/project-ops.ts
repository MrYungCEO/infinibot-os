/**
 * Template: project-ops — a live tour of active kanban projects.
 *
 * Scenes:
 *   1. Title scene
 *   2. Stats scene (active / blocked / done today)
 *   3..N. One scene per active project (status, task counts, recent insight)
 *
 * Pulls from kanban.snapshot + insights.summary. Node schema uses direct
 * fields (n.title, n.body, n.h1, n.sub, n.stats, n.kicker, n.h2) — NOT a
 * `content` object — matching the locked overlay schema in
 * ui/src/ui/components/walkthroughs/infinite-canvas-walkthrough.ts.
 */

import type { CanvasNode, CanvasScene, CanvasLink } from "../../proactive/popup-types.js";
import type { BuildCtx, CanvasPayload, CanvasWorkflow } from "../registry.js";
import type { KanbanProjectRow, KanbanTaskRow, SystemsInsightRow } from "../registry.js";
import { registerWorkflow } from "../registry.js";

const NODE_W = 560;
const COL_GAP = 760;
const ROW_GAP = 520;
const TITLE_X = 1200;
const TITLE_Y = 80;

function safeCap(s: string | undefined | null, fallback = "—"): string {
  if (!s || typeof s !== "string") return fallback;
  return s.trim() || fallback;
}

function statusAccent(status: string | undefined): string {
  switch ((status ?? "").toLowerCase()) {
    case "in progress":
    case "in_progress":
      return "gold";
    case "completed":
    case "done":
      return "green";
    case "paused":
    case "blocked":
      return "red";
    case "reviewing":
    case "review":
      return "cyan";
    default:
      return "green";
  }
}

/** Count tasks by status for a project. */
function countTasks(
  tasks: KanbanTaskRow[],
  projectId: string,
): {
  total: number;
  done: number;
  inProgress: number;
  blocked: number;
} {
  const pts = tasks.filter((t) => t.projectId === projectId);
  return {
    total: pts.length,
    done: pts.filter((t) => t.status === "done").length,
    inProgress: pts.filter((t) => t.status === "in_progress").length,
    blocked: pts.filter((t) => t.status === "backlog").length,
  };
}

/** Find the most recent insight related to a project (best-effort title match). */
function recentInsight(
  project: KanbanProjectRow,
  insights: SystemsInsightRow[],
): SystemsInsightRow | undefined {
  if (insights.length === 0) return undefined;
  const name = (project.name ?? "").toLowerCase();
  return insights.find((i) => (i.title ?? "").toLowerCase().includes(name)) ?? insights[0];
}

export async function buildProjectOps(ctx: BuildCtx): Promise<CanvasPayload> {
  const [{ projects, tasks }, insightsRes] = await Promise.all([
    ctx.kanban.snapshot(),
    ctx.insights.summary(),
  ]);
  const insights = insightsRes.insights ?? [];

  // "Active" = not completed/cancelled. Cap at 8 to keep the tour tight.
  const activeStatuses = new Set([
    "in progress",
    "in_progress",
    "not started",
    "updating",
    "awaiting client",
    "reviewing",
    "",
  ]);
  const active = projects
    .filter((p) => activeStatuses.has((p.status ?? "").toLowerCase()))
    .slice(0, 8);

  const now = Date.now();
  const startOfDay = new Date(now).setHours(0, 0, 0, 0);
  const doneToday = tasks.filter(
    (t) => t.status === "done" && (t.completedAt ?? 0) >= startOfDay,
  ).length;

  const nodes: CanvasNode[] = [];
  const links: CanvasLink[] = [];
  const scenes: CanvasScene[] = [];

  // 1) Title scene
  nodes.push({
    id: "title",
    kind: "title",
    x: TITLE_X,
    y: TITLE_Y,
    w: 900,
    brand: "InfiniBot Holo-Canvas",
    h1: "Project Operations",
    sub: `${projects.length} project${projects.length === 1 ? "" : "s"} · ${active.length} active · ${tasks.length} task${tasks.length === 1 ? "" : "s"} total`,
    body: "A live spatial tour of your active kanban projects, their status, task counts, and the latest insights.",
  });
  scenes.push({
    id: "scene-title",
    focusNodeId: "title",
    narration: {
      ttsText: `Project operations. You have ${projects.length} projects, ${active.length} active, and ${tasks.length} tasks total. ${doneToday} task${doneToday === 1 ? "" : "s"} completed today. Let's walk the active ones.`,
    },
  });

  // 2) Stats scene
  nodes.push({
    id: "stats",
    kind: "stats",
    x: TITLE_X,
    y: 320,
    w: 900,
    kicker: "Board Totals",
    stats: [
      { n: String(projects.length), l: "Projects" },
      { n: String(active.length), l: "Active" },
      { n: String(tasks.length), l: "Tasks" },
      { n: String(doneToday), l: "Done Today" },
    ],
  });
  scenes.push({
    id: "scene-stats",
    focusNodeId: "stats",
    narration: {
      ttsText: `Board totals: ${projects.length} projects, ${active.length} active, ${tasks.length} tasks, ${doneToday} completed today.`,
    },
  });

  if (active.length === 0) {
    nodes.push({
      id: "project-empty",
      kind: "text",
      x: TITLE_X + 620,
      y: 600,
      w: 520,
      kicker: "No Active Projects",
      h2: "Nothing in flight",
      body: "No active kanban projects right now. Create one or move a paused project back to active.",
    });
    scenes.push({
      id: "scene-empty",
      focusNodeId: "project-empty",
      narration: { ttsText: "No active projects right now." },
    });
    return { title: "Project Operations", nodes, links, scenes, voiceSuppress: true };
  }

  // 3) Per-project scenes
  const cols = Math.min(3, active.length);
  active.forEach((proj, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const x = TITLE_X + 620 + col * COL_GAP;
    const y = 600 + row * ROW_GAP;
    const accent = statusAccent(proj.status);
    const counts = countTasks(tasks, proj.id);
    const insight = recentInsight(proj, insights);
    const bodyLines: string[] = [];
    bodyLines.push(`**Status:** ${safeCap(proj.status)}`);
    if (proj.priority) bodyLines.push(`**Priority:** ${safeCap(proj.priority)}`);
    if (typeof proj.progress === "number") bodyLines.push(`**Progress:** ${proj.progress}%`);
    bodyLines.push(
      `**Tasks:** ${counts.total} (${counts.done} done, ${counts.inProgress} in progress, ${counts.blocked} backlog)`,
    );
    if (proj.node) bodyLines.push(`**Node:** ${safeCap(proj.node)}`);
    if (insight?.title) bodyLines.push(`**Insight:** ${insight.title}`);
    const id = `project-${i}`;
    nodes.push({
      id,
      kind: "text",
      x,
      y,
      w: NODE_W,
      cl: accent,
      kicker: "PROJECT",
      h2: safeCap(proj.name, proj.id),
      body: bodyLines.join("\n"),
      stats: [
        { n: String(counts.total), l: "Tasks" },
        { n: String(counts.done), l: "Done" },
      ],
    });
    links.push(["stats", id]);
    scenes.push({
      id: `scene-${id}`,
      focusNodeId: id,
      narration: {
        ttsText: `Project ${i + 1}: ${safeCap(proj.name, proj.id)}. Status: ${safeCap(proj.status)}. ${counts.total} tasks, ${counts.done} done, ${counts.inProgress} in progress.${typeof proj.progress === "number" ? ` Progress: ${proj.progress} percent.` : ""}${insight?.title ? ` Latest insight: ${insight.title}.` : ""}`,
      },
    });
  });

  return { title: "Project Operations", nodes, links, scenes, voiceSuppress: true };
}

export const projectOpsWorkflow: CanvasWorkflow = {
  id: "project-ops",
  title: "Project Operations",
  description:
    "Live spatial tour of active kanban projects — status, task counts, and recent insights.",
  defaultVoice: "af_heart",
  build: buildProjectOps,
};

registerWorkflow(projectOpsWorkflow);
