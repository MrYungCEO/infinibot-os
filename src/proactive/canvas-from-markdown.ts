/**
 * Markdown-script → infinite-canvas-walkthrough payload.
 *
 * A convenience authoring path for agents: write a plain "walkthrough script"
 * (optional `---` frontmatter + `#` title + `##` section headings with body
 * paragraphs) and get back a ready-to-emit InfiniteCanvasWalkthroughMedia with
 * nodes auto-laid-out on a grid, one scene per `##` heading, and each scene's
 * narration set to the section's body text (which the gateway then pre-bakes).
 *
 * Example:
 *
 *   ---
 *   title: The 10× Workflow
 *   voice: af_heart
 *   ---
 *   # The 10× Workflow
 *   One operator commands a parallel fleet entirely by voice.
 *
 *   ## The Problem
 *   Solo AI coding is one thread of attention: type, wait, read, repeat.
 *
 *   ## Voice Input
 *   Speaking is ~3.75× faster than typing — and your eyes never leave the work.
 */

import { getActiveVoiceId } from "../voice/active-voice.js";
import type {
  InfiniteCanvasWalkthroughMedia,
  CanvasNode,
  CanvasLink,
  CanvasScene,
  ChartSeries,
  ComparisonItem,
} from "./popup-types.js";

export interface CanvasFromMarkdownOptions {
  /** Default narration voice id (per-scene). */
  voice?: string;
  /** Nodes per row in the auto grid (default 3). */
  columns?: number;
  /** Node width in px (default 560). */
  nodeWidth?: number;
  /** Horizontal / vertical grid pitch (defaults derive from nodeWidth). */
  colGap?: number;
  rowGap?: number;
}

interface Section {
  heading: string;
  level: number;
  body: string;
}

/** Strip a leading `--- ... ---` frontmatter block; return parsed keys + rest. */
function splitFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(md);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: md.slice(m[0].length) };
}

/** Parse `#`/`##` headed sections with their following body paragraphs. */
function parseSections(body: string): Section[] {
  const lines = body.split(/\r?\n/);
  const sections: Section[] = [];
  let cur: Section | null = null;
  for (const raw of lines) {
    const h = /^(#{1,3})\s+(.+)$/.exec(raw.trim());
    if (h) {
      if (cur) sections.push(cur);
      cur = { heading: h[2].trim(), level: h[1].length, body: "" };
    } else if (cur) {
      cur.body += (cur.body ? "\n" : "") + raw;
    }
  }
  if (cur) sections.push(cur);
  return sections.map((s) => ({ ...s, body: s.body.trim() }));
}

/** First sentence (for an on-screen caption), capped. */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(flat);
  return (m ? m[1] : flat).slice(0, 180);
}

/**
 * Detect a `:::kind args\n...\n:::` fenced block at the start of a section
 * body. Returns `{ kind, args, raw }` for the first match, or null.
 */
function parseNodeBlocks(body: string): { kind: string; args: string; raw: string } | null {
  const m = /^:::([\w-]+)([^\n]*)?\n([\s\S]*?)\n:::/.exec(body.trim());
  if (!m) return null;
  return { kind: m[1].trim(), args: m[2]?.trim() ?? "", raw: m[3] };
}

/**
 * Parse `label,value` CSV rows (one per line). Returns ChartSeries[].
 */
function parseChartCsv(raw: string): ChartSeries[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const parts = l.split(",");
      return { label: parts[0]?.trim() ?? "", value: parseFloat(parts[1]?.trim() ?? "0") || 0 };
    });
}

/**
 * Parse a comparison block:
 *   L:Title
 *   + item
 *   - item
 *   ===
 *   R:Title
 *   + item
 */
function parseComparison(raw: string): {
  left: { title: string; items: ComparisonItem[] };
  right: { title: string; items: ComparisonItem[] };
} {
  const [leftPart, rightPart] = raw.split(/\n===\n/);
  const parseCol = (src: string): { title: string; items: ComparisonItem[] } => {
    const lines = (src ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    let title = "";
    const items: ComparisonItem[] = [];
    for (const line of lines) {
      const lm = /^L:(.+)$/.exec(line) ?? /^R:(.+)$/.exec(line);
      if (lm) {
        title = lm[1].trim();
        continue;
      }
      if (line.startsWith("+ ")) {
        items.push({ text: line.slice(2).trim(), positive: true });
        continue;
      }
      if (line.startsWith("- ")) {
        items.push({ text: line.slice(2).trim(), positive: false });
        continue;
      }
      items.push({ text: line, positive: undefined });
    }
    return { title, items };
  };
  return { left: parseCol(leftPart ?? ""), right: parseCol(rightPart ?? "") };
}

/**
 * Parse pricing block:
 *   price: $49/mo
 *   per: month
 *   features: A,B,C
 *   badge: Most Popular
 *   cta: Get started
 */
function parsePricing(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const kv = /^([a-z]+)\s*:\s*(.+)$/.exec(line.trim());
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

/**
 * Build an infinite-canvas-walkthrough payload from a markdown script. The
 * caller emits it as `{ kind: "infinite-canvas-walkthrough", payload }`.
 */
export function canvasFromMarkdown(
  md: string,
  opts: CanvasFromMarkdownOptions = {},
): InfiniteCanvasWalkthroughMedia {
  const { meta, body } = splitFrontmatter(md);
  const sections = parseSections(body);

  const columns = Math.max(1, opts.columns ?? 3);
  const w = opts.nodeWidth ?? 560;
  const colGap = opts.colGap ?? w + 200;
  const rowGap = opts.rowGap ?? 520;
  const voiceId = opts.voice?.trim() || meta.voice?.trim() || getActiveVoiceId();

  const nodes: CanvasNode[] = [];
  const scenes: CanvasScene[] = [];
  const links: CanvasLink[] = [];

  // Serpentine grid so sequential links stay short and the camera flows.
  const place = (i: number): { x: number; y: number } => {
    const row = Math.floor(i / columns);
    const colInRow = i % columns;
    const col = row % 2 === 0 ? colInRow : columns - 1 - colInRow;
    return { x: 160 + col * colGap, y: 160 + row * rowGap };
  };

  sections.forEach((sec, i) => {
    const id = `n${i}`;
    const { x, y } = place(i);
    const isTitle = i === 0 && sec.level === 1;

    // Check for a fenced :::kind... block in the section body.
    const fenced = parseNodeBlocks(sec.body);
    if (fenced) {
      const { kind: fkind, args, raw } = fenced;
      const baseFields = { id, x, y, w, cl: "gold", kicker: sec.heading } as const;

      if (fkind === "chart") {
        const chartKind = (args || "bar") as CanvasNode["chartKind"];
        const series = parseChartCsv(raw);
        nodes.push({ ...baseFields, kind: "chart", chartKind, series, h2: sec.heading });
      } else if (fkind === "reveal-list") {
        const items = raw
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.startsWith("- ") || l.startsWith("* "))
          .map((l) => ({ md: l.slice(2).trim() }));
        nodes.push({ ...baseFields, kind: "reveal-list", h2: sec.heading, items, pacing: "auto" });
      } else if (fkind === "timeline") {
        const events = raw
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const parts = l.split("|");
            return {
              at: parts[0]?.trim() ?? "",
              label: parts[1]?.trim() ?? "",
              kicker: parts[2]?.trim(),
            };
          });
        nodes.push({ ...baseFields, kind: "timeline", h2: sec.heading, events });
      } else if (fkind === "comparison") {
        const { left, right } = parseComparison(raw);
        nodes.push({ ...baseFields, kind: "comparison", h2: sec.heading, left, right });
      } else if (fkind === "pricing") {
        const p = parsePricing(raw);
        const price = p.price;
        const pricePer = p.per;
        const priceFeatures = p.features
          ? p.features
              .split(",")
              .map((f) => f.trim())
              .filter(Boolean)
          : undefined;
        const badge = p.badge;
        const ctaLabel = p.cta;
        nodes.push({
          ...baseFields,
          kind: "pricing",
          title: sec.heading,
          price,
          pricePer,
          priceFeatures,
          badge,
          ctaLabel,
        });
        // If a CTA label is specified, also emit a separate CTA node after this one.
        if (ctaLabel) {
          const ctaId = `${id}_cta`;
          nodes.push({
            id: ctaId,
            kind: "cta",
            x: x + w + 80,
            y,
            w: Math.min(w, 320),
            cl: "gold",
            ctaLabel,
            ctaHref: p.href,
          });
          links.push([id, ctaId]);
        }
      } else {
        // Unknown fenced kind — fall through to text node.
        nodes.push(
          isTitle
            ? {
                id,
                kind: "title",
                x,
                y,
                w,
                cl: "gold",
                h1: sec.heading,
                sub: sec.body || undefined,
              }
            : {
                id,
                kind: "text",
                x,
                y,
                w,
                cl: "gold",
                kicker: `Chapter ${String(i).padStart(2, "0")}`,
                h2: sec.heading,
                body: sec.body || undefined,
              },
        );
      }
    } else {
      nodes.push(
        isTitle
          ? { id, kind: "title", x, y, w, cl: "gold", h1: sec.heading, sub: sec.body || undefined }
          : {
              id,
              kind: "text",
              x,
              y,
              w,
              cl: "gold",
              kicker: `Chapter ${String(i).padStart(2, "0")}`,
              h2: sec.heading,
              body: sec.body || undefined,
            },
      );
    }

    const narrationText = `${sec.heading}. ${sec.body}`.trim();
    scenes.push({
      id: `s${i}`,
      focusNodeId: id,
      narration: {
        ttsText: narrationText,
        voice: voiceId,
        captionMd: firstSentence(sec.body || sec.heading),
      },
    });
    if (i > 0) links.push([`n${i - 1}`, id]);
  });

  // Size the world to comfortably contain the grid.
  const rows = Math.ceil(Math.max(1, sections.length) / columns);
  const world = {
    w: 320 + columns * colGap,
    h: 320 + rows * rowGap,
  };

  return {
    title: meta.title || (sections[0]?.heading ?? "Walkthrough"),
    world,
    nodes,
    links,
    scenes,
    autoAdvance: true,
    voiceSuppress: true,
  };
}
