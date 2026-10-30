/**
 * InfiCode — shared presentation helpers (status colors, glyphs, monospace
 * meters + sparklines). All accents route through the existing `--g-*` design
 * tokens so palette swaps recolor this view in lockstep with the rest of the
 * app. No chart library — everything is built from box-drawing / block chars.
 */

import type { MeshAgent, MeshNode } from "../../controllers/agent-mesh.js";

/** Semantic color for an agent status — gold for active, ramps to danger. */
export function statusColor(status: MeshAgent["status"]): string {
  switch (status) {
    case "working":
    case "starting":
      return "var(--g-primary)";
    case "finishing":
      return "var(--g-state-warn, #fcd34d)";
    case "blocked":
    case "failed":
      return "var(--g-state-danger, #f87171)";
    case "completed":
      return "var(--g-state-ok, #4ade80)";
    case "idle":
    default:
      return "var(--g-muted, #71717a)";
  }
}

/** Glyph for an agent — diamond for orchestrators, dot for workers. */
export function agentGlyph(agent: MeshAgent): string {
  return agent.role === "orchestrator" ? "◆" : "●";
}

/** Node status → color. */
export function nodeColor(node: MeshNode): string {
  if (node.status === "online") return "var(--g-primary)";
  if (node.status === "connecting") return "var(--g-state-warn, #fcd34d)";
  return "var(--g-muted, #71717a)";
}

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Render a numeric series as a monospace block-char sparkline. */
export function blockSparkline(values: number[], width = 32): string {
  if (values.length === 0) return "".padEnd(width, "▁");
  const slice = values.slice(-width);
  const max = Math.max(1, ...slice);
  const out = slice
    .map((v) => {
      const idx = Math.min(BLOCKS.length - 1, Math.round((v / max) * (BLOCKS.length - 1)));
      return BLOCKS[Math.max(0, idx)];
    })
    .join("");
  return out.padStart(width, "▁");
}

/** Render a 0..100 percent as a filled/empty box meter (▓▓▓░░). */
export function barMeter(pct: number, width = 18): string {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const filled = Math.round((clamped / 100) * width);
  return "▓".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

/** Color for a 0..100 load meter — gold, escalating to warn/danger. */
export function meterColor(pct: number): string {
  if (pct >= 90) return "var(--g-state-danger, #f87171)";
  if (pct >= 75) return "var(--g-state-warn, #fcd34d)";
  return "var(--g-primary)";
}

/** Short relative-time label (e.g. "12s", "4m"). */
export function shortAge(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** HH:MM:SS from an epoch ms. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
