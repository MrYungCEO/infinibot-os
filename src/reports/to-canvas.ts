/**
 * Convert a ReportPayload into a Holo-Canvas walkthrough payload.
 *
 * One CanvasNode (and matching CanvasScene) is created per section. Sections
 * that contain numeric data in their table cells or bullets are rendered as
 * `stats` nodes; all other sections are `text` nodes (or `title` for the
 * document header). Nodes are laid out in a horizontal row with consistent
 * gaps so the camera has a clear fly-to path.
 *
 * This output is consumed by the infinite-canvas-walkthrough overlay renderer
 * and can be emitted via the proactive HTTP endpoint with kind
 * "report-walkthrough".
 */

import type { ReportPayload, ReportSection, ReportMetric } from "./types.js";
import type {
  InfiniteCanvasWalkthroughMedia,
  CanvasNode,
  CanvasScene,
  CanvasStat,
} from "../proactive/popup-types.js";

// ── Layout constants ──────────────────────────────────────────────────────────

const NODE_WIDTH = 480;
const NODE_GAP = 80;
const NODE_Y = 200;
const TITLE_WIDTH = 560;

// Heuristic: look for numeric-looking values in table rows or bullet items
// to decide whether a section should render as a `stats` card.
function hasNumericData(section: ReportSection): boolean {
  if (section.table) {
    for (const row of section.table.rows) {
      for (const cell of row) {
        if (typeof cell === "number") return true;
        if (typeof cell === "string" && /^\d[\d,._% ]*$/.test(cell.trim())) return true;
      }
    }
  }
  return false;
}

/**
 * Extract up to 4 `CanvasStat` entries from a section's table or body.
 * Falls back to the section heading + count when no table exists.
 */
function extractStats(section: ReportSection): CanvasStat[] {
  const stats: CanvasStat[] = [];

  if (section.table) {
    // Use the first two columns: treat col[1] as value, col[0] as label.
    for (const row of section.table.rows) {
      if (stats.length >= 4) break;
      const label = String(row[0] ?? "").trim();
      const value = String(row[1] ?? "").trim();
      if (label && value) {
        stats.push({ n: value, l: label });
      }
    }
  }

  if (stats.length === 0 && section.count != null) {
    stats.push({ n: String(section.count), l: section.heading });
  }

  return stats;
}

/**
 * Build narration text for a section: prefer the body text, fall back to
 * the first 3 bullet points joined, fall back to a generated summary line.
 */
function sectionNarration(section: ReportSection): string {
  if (section.body) {
    // Trim to ~200 chars to keep narration punchy
    const trimmed = section.body.replace(/\n+/g, " ").trim();
    return trimmed.length > 200 ? trimmed.slice(0, 197) + "…" : trimmed;
  }
  if (section.bullets && section.bullets.length > 0) {
    return section.bullets.slice(0, 3).join(". ").trim();
  }
  if (section.table) {
    const cols = section.table.columns.join(", ");
    return `${section.heading} covers ${cols}.`;
  }
  return section.heading;
}

/**
 * Build the body text shown on a text node (markdown-ish string the canvas
 * host renders). We prefer body prose, then bullets as a markdown list.
 */
function sectionBody(section: ReportSection): string | undefined {
  if (section.body) return section.body.slice(0, 400);
  if (section.bullets && section.bullets.length > 0) {
    return section.bullets
      .slice(0, 6)
      .map((b) => `- ${b}`)
      .join("\n");
  }
  return undefined;
}

/**
 * Convert a ReportPayload into an InfiniteCanvasWalkthroughMedia payload
 * ready to fire at `/api/proactive/emit` with kind `"report-walkthrough"`.
 *
 * @param payload - The structured report (same object passed to renderReport).
 * @returns       - A Holo-Canvas walkthrough with one node+scene per section.
 */
export function reportToCanvasPayload(payload: ReportPayload): InfiniteCanvasWalkthroughMedia {
  const nodes: CanvasNode[] = [];
  const scenes: CanvasScene[] = [];

  let xCursor = 100;

  // ── Title node (document header) ─────────────────────────────────────────
  const titleId = "node-title";
  const titleNarration = payload.subtitle ? `${payload.title}. ${payload.subtitle}` : payload.title;

  const titleMetrics: CanvasStat[] | undefined =
    payload.metrics && payload.metrics.length > 0
      ? payload.metrics.slice(0, 4).map((m: ReportMetric) => ({
          n: String(m.value),
          l: m.label,
        }))
      : undefined;

  // Field names follow the overlay renderer: title cards draw brand/h1/sub,
  // text cards kicker/h2/body, stats cards kicker + stats only.
  nodes.push({
    id: titleId,
    kind: "title",
    x: xCursor,
    y: NODE_Y,
    w: TITLE_WIDTH,
    cl: "gold",
    brand: payload.eyebrow ?? "InfiniBot · Report",
    h1: payload.title,
    sub: payload.subtitle,
  });

  scenes.push({
    id: "scene-title",
    focusNodeId: titleId,
    durationMs: 7000,
    narration: {
      ttsText: titleNarration,
      captionMd: `**${payload.title}**${payload.subtitle ? `\n\n${payload.subtitle}` : ""}`,
    },
  });

  xCursor += TITLE_WIDTH + NODE_GAP;

  // ── Headline metrics get their own stats card ────────────────────────────
  if (titleMetrics) {
    const metricsId = "node-metrics";
    nodes.push({
      id: metricsId,
      kind: "stats",
      x: xCursor,
      y: NODE_Y,
      w: NODE_WIDTH,
      cl: "gold",
      kicker: "Headline numbers",
      stats: titleMetrics,
    });
    scenes.push({
      id: "scene-metrics",
      focusNodeId: metricsId,
      durationMs: 7000,
      narration: {
        ttsText: titleMetrics.map((m) => `${m.l}: ${m.n}`).join(". "),
        captionMd: "Headline numbers",
      },
    });
    xCursor += NODE_WIDTH + NODE_GAP;
  }

  // ── One node + scene per section ─────────────────────────────────────────
  payload.sections.forEach((section, idx) => {
    const nodeId = `node-s${idx}`;
    const isStats = hasNumericData(section);

    const node: CanvasNode = {
      id: nodeId,
      kind: isStats ? "stats" : "text",
      x: xCursor,
      y: NODE_Y,
      w: NODE_WIDTH,
      // Stats cards only render their eyebrow, so the heading goes there.
      kicker: isStats ? section.heading : `Section ${idx + 1}`,
      ...(isStats ? {} : { h2: section.heading }),
    };

    if (isStats) {
      node.stats = extractStats(section);
      // Also surface body text as sub-heading when available
      if (section.body) {
        node.sub = section.body.replace(/\n+/g, " ").slice(0, 100).trim();
      }
    } else {
      node.body = sectionBody(section);
    }

    if (section.count != null) {
      node.kicker = `${node.kicker} · ${section.count}`;
    }

    nodes.push(node);

    scenes.push({
      id: `scene-s${idx}`,
      focusNodeId: nodeId,
      durationMs: 9000,
      narration: {
        ttsText: sectionNarration(section),
        captionMd: `### ${section.heading}`,
      },
    });

    xCursor += NODE_WIDTH + NODE_GAP;
  });

  // ── Sequential links (title → s0 → s1 → …) ───────────────────────────────
  const links = nodes.slice(0, -1).map((n, i) => ({
    from: n.id,
    to: nodes[i + 1].id,
  }));

  return {
    title: payload.title,
    world: { w: Math.max(9600, xCursor + 200), h: 6400 },
    nodes,
    links,
    scenes,
    autoAdvance: true,
    voiceSuppress: true,
  };
}
