/**
 * Heatmap renderer — a soft, Gaussian-blurred colored field over the world
 * floor. Three modes:
 *   - credit_burn       : per-agent credit spend (window.__worldHeatmap.burn)
 *   - activity_density  : agent presence weighted by active status
 *   - failure_rate      : per-agent failed-run counts (window.__worldHeatmap.failure)
 *
 * Intensity ramps gold → amber → crimson. Blobs are drawn additively under a
 * blur filter so overlapping agents pool into hotspots like a real heatmap.
 */

import type { HeatmapMode, HeatmapWeights, OverlayAgent } from "./types.js";

interface HeatPoint {
  x: number;
  y: number;
  /** Normalized 0..1 intensity. */
  t: number;
}

export class HeatmapRenderer {
  /** Color ramp: 0 = gold, 0.5 = amber, 1 = crimson. */
  static ramp(t: number): [number, number, number] {
    const c = clamp01(t);
    const gold: [number, number, number] = [212, 175, 55];
    const amber: [number, number, number] = [255, 158, 44];
    const crimson: [number, number, number] = [220, 38, 38];
    return c < 0.5 ? lerp3(gold, amber, c / 0.5) : lerp3(amber, crimson, (c - 0.5) / 0.5);
  }

  private points(agents: OverlayAgent[], mode: HeatmapMode, weights: HeatmapWeights): HeatPoint[] {
    const raw: Array<{ x: number; y: number; v: number }> = [];
    for (const a of agents) {
      let v = 0;
      if (mode === "credit_burn") v = weights.burn?.[a.id] ?? 0;
      else if (mode === "failure_rate") v = weights.failure?.[a.id] ?? 0;
      else {
        const s = (a.status ?? "").toLowerCase();
        v = s === "active" || s === "working" || s === "running" || s === "busy" ? 1 : 0.25;
      }
      if (v > 0) raw.push({ x: a.x, y: a.y, v });
    }
    if (!raw.length) return [];
    const max = Math.max(...raw.map((p) => p.v));
    return raw.map((p) => ({ x: p.x, y: p.y, t: max > 0 ? p.v / max : 0 }));
  }

  draw(
    ctx: CanvasRenderingContext2D,
    agents: OverlayAgent[],
    mode: HeatmapMode | null,
    weights: HeatmapWeights,
    now: number,
    width: number,
    height: number,
  ): void {
    if (!mode) return;
    const pts = this.points(agents, mode, weights);
    if (!pts.length) return;

    const pulse = 0.92 + 0.08 * Math.sin(now * 1.3);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    // Gaussian-ish softness. ctx.filter is supported in headless Chromium.
    const supportsFilter = "filter" in ctx;
    if (supportsFilter) ctx.filter = "blur(26px)";

    for (const p of pts) {
      const [r, g, b] = HeatmapRenderer.ramp(p.t);
      const radius = (70 + 90 * p.t) * pulse;
      const alpha = 0.10 + 0.5 * p.t;
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha})`);
      grad.addColorStop(0.6, `rgba(${r}, ${g}, ${b}, ${alpha * 0.45})`);
      grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    void width;
    void height;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}
