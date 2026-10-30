/**
 * Mission overlay renderer — highlights the critical path for the active
 * project. Draws a pulsating gold glow ring + label tag around each agent
 * working a critical-path task, and a pulsing gold halo around sector
 * buildings that hold critical tasks.
 *
 * Pure canvas drawing — the host (<world-overlays>) owns the canvas + RAF loop
 * and the agent feed; this module just paints a frame.
 */

import type { MissionData, MissionSector, OverlayAgent } from "./types.js";

const GOLD = "212, 175, 55"; // rgb of #d4af37

/**
 * Compute the critical-path agent ids + sectors from a kanban-style state.
 *
 * "Critical path" here = tasks that are in_progress/review on a critical- or
 * high-priority project, plus their assigned agents. Kept as a pure helper so a
 * controller can feed it `getKanbanStore().getState()` (read-only) without this
 * UI module importing the server store.
 */
export function computeCriticalPath(
  state: {
    projects: Array<{ id: string; priority?: string }>;
    tasks: Array<{
      projectId: string;
      status?: string;
      priority?: string;
      assignedAgent?: string | null;
      assignee?: string;
    }>;
  },
  projectId?: string,
): { criticalAgentIds: string[]; criticalTaskCount: number } {
  const ids = new Set<string>();
  let count = 0;
  for (const t of state.tasks) {
    if (projectId && t.projectId !== projectId) continue;
    const proj = state.projects.find((p) => p.id === t.projectId);
    const hot =
      t.priority === "critical" ||
      t.priority === "high" ||
      proj?.priority === "critical" ||
      proj?.priority === "high";
    const active = t.status === "in_progress" || t.status === "review";
    if (!hot || !active) continue;
    count++;
    const agent = t.assignedAgent || (t.assignee && t.assignee !== "user" ? t.assignee : null);
    if (agent) ids.add(agent);
  }
  return { criticalAgentIds: [...ids], criticalTaskCount: count };
}

export class MissionRenderer {
  draw(
    ctx: CanvasRenderingContext2D,
    agents: OverlayAgent[],
    data: MissionData | null,
    now: number,
  ): void {
    if (!data) return;
    const pulse = 0.5 + 0.5 * Math.sin(now * 2.2); // 0..1
    const critical = new Set(data.criticalAgentIds);

    // Sector buildings holding critical tasks — pulse a gold halo.
    for (const s of data.criticalSectors) {
      this.drawSectorHalo(ctx, s, pulse);
    }

    // Critical-path agents — gold glow ring + label tag.
    for (const a of agents) {
      if (!critical.has(a.id)) continue;
      this.drawAgentRing(ctx, a, pulse);
    }
  }

  private drawSectorHalo(ctx: CanvasRenderingContext2D, s: MissionSector, pulse: number): void {
    const r = s.r * (1 + 0.08 * pulse);
    ctx.save();
    const grad = ctx.createRadialGradient(s.x, s.y, r * 0.4, s.x, s.y, r);
    grad.addColorStop(0, `rgba(${GOLD}, ${0.18 + 0.12 * pulse})`);
    grad.addColorStop(1, `rgba(${GOLD}, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = `rgba(${GOLD}, ${0.5 + 0.3 * pulse})`;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.lineDashOffset = -pulse * 11;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    this.tag(ctx, s.x, s.y - s.r - 8, s.label.toUpperCase(), pulse);
  }

  private drawAgentRing(ctx: CanvasRenderingContext2D, a: OverlayAgent, pulse: number): void {
    const base = 22;
    const r = base + 4 * pulse;
    ctx.save();
    // Outer glow
    const grad = ctx.createRadialGradient(a.x, a.y, r * 0.5, a.x, a.y, r * 1.8);
    grad.addColorStop(0, `rgba(${GOLD}, ${0.35 + 0.2 * pulse})`);
    grad.addColorStop(1, `rgba(${GOLD}, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(a.x, a.y, r * 1.8, 0, Math.PI * 2);
    ctx.fill();

    // Crisp ring
    ctx.strokeStyle = `rgba(${GOLD}, ${0.85})`;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = `rgba(${GOLD}, 0.9)`;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
    ctx.stroke();

    // Rotating dash accent
    ctx.shadowBlur = 0;
    ctx.strokeStyle = `rgba(${GOLD}, ${0.5})`;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 8]);
    ctx.lineDashOffset = now2(pulse);
    ctx.beginPath();
    ctx.arc(a.x, a.y, r + 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    this.tag(ctx, a.x, a.y - r - 14, "★ CRITICAL", pulse);
  }

  private tag(ctx: CanvasRenderingContext2D, cx: number, cy: number, text: string, pulse: number): void {
    ctx.save();
    ctx.font = "700 11px ui-monospace, monospace";
    const w = ctx.measureText(text).width + 14;
    const h = 18;
    const x = cx - w / 2;
    const y = cy - h / 2;
    ctx.fillStyle = "rgba(10, 12, 20, 0.82)";
    roundRect(ctx, x, y, w, h, 5);
    ctx.fill();
    ctx.strokeStyle = `rgba(${GOLD}, ${0.6 + 0.3 * pulse})`;
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, 5);
    ctx.stroke();
    ctx.fillStyle = `rgba(${GOLD}, 1)`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, cx, cy + 0.5);
    ctx.restore();
  }
}

function now2(pulse: number): number {
  return -pulse * 12;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
