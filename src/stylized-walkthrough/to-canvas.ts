/**
 * Convert a stylized-walkthrough chapter list into a Holo-Canvas walkthrough
 * payload.
 *
 * A "stylized walkthrough" is a premium black-gold document produced by the
 * `stylized-walkthrough` skill — it arrives as an ordered array of chapters,
 * each with a `title` and a `body` string (markdown prose). This converter
 * maps each chapter to a `text` CanvasNode and a `CanvasScene` that flies the
 * camera to that node, setting a 12-second durationMs (walkthroughs are
 * denser than plain reports).
 *
 * The output is consumed by the infinite-canvas-walkthrough overlay renderer
 * and can be emitted via the proactive HTTP endpoint with kind
 * `"stylized-walkthrough"`.
 */

import type {
  InfiniteCanvasWalkthroughMedia,
  CanvasNode,
  CanvasScene,
} from "../proactive/popup-types.js";

// ── Layout constants ──────────────────────────────────────────────────────────

const NODE_WIDTH = 520;
const NODE_GAP = 100;
const NODE_Y = 200;

/** Duration per scene in ms — longer than report scenes since chapters are denser. */
const SCENE_DURATION_MS = 12_000;

export interface WalkthroughChapter {
  title: string;
  body: string;
}

/**
 * Trim body text to a readable narration clip (~220 chars = ~80 words ≈ 30 s
 * at 2.7 wps). Preserves sentence boundaries when possible.
 */
function toNarration(body: string): string {
  const flat = body
    .replace(/#{1,6}\s+/g, "") // strip markdown headings
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1") // strip bold/italic
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1)) // strip inline code ticks
    .replace(/\n+/g, " ")
    .trim();

  if (flat.length <= 220) return flat;

  // Try to cut at a sentence boundary within the first 220 chars
  const cut = flat.slice(0, 220);
  const lastDot = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (lastDot > 100) return flat.slice(0, lastDot + 1);
  return cut.trimEnd() + "…";
}

/**
 * Convert an array of walkthrough chapters into an InfiniteCanvasWalkthroughMedia
 * payload ready to fire at `/api/proactive/emit` with kind `"stylized-walkthrough"`.
 *
 * @param chapters - Ordered chapter list from the stylized-walkthrough skill.
 * @param title    - Optional overall document title (shown on the first title node).
 * @returns        - A Holo-Canvas walkthrough with one node+scene per chapter.
 */
export function stylizedWalkthroughToCanvasPayload(
  chapters: WalkthroughChapter[],
  title?: string,
): InfiniteCanvasWalkthroughMedia {
  if (chapters.length === 0) {
    throw new Error("stylizedWalkthroughToCanvasPayload: chapters array must not be empty");
  }

  const nodes: CanvasNode[] = [];
  const scenes: CanvasScene[] = [];
  let xCursor = 100;

  // ── Optional cover/title node when a document title is supplied ───────────
  if (title) {
    const coverId = "node-cover";
    nodes.push({
      id: coverId,
      kind: "title",
      x: xCursor,
      y: NODE_Y,
      w: NODE_WIDTH,
      cl: "gold",
      brand: "Stylized Walkthrough", // title cards render brand/h1/sub
      h1: title,
      sub: `${chapters.length} chapter${chapters.length !== 1 ? "s" : ""}`,
    });
    scenes.push({
      id: "scene-cover",
      focusNodeId: coverId,
      durationMs: 6000,
      narration: {
        ttsText: title,
        captionMd: `# ${title}`,
      },
    });
    xCursor += NODE_WIDTH + NODE_GAP;
  }

  // ── One node + scene per chapter ─────────────────────────────────────────
  chapters.forEach((chapter, idx) => {
    const nodeId = `node-ch${idx}`;

    nodes.push({
      id: nodeId,
      kind: "text",
      x: xCursor,
      y: NODE_Y,
      w: NODE_WIDTH,
      cl: "gold",
      kicker: `Chapter ${idx + 1}`,
      h2: chapter.title, // text cards render kicker/h2/body
      body: chapter.body.slice(0, 500), // visible body on the node card
    });

    scenes.push({
      id: `scene-ch${idx}`,
      focusNodeId: nodeId,
      durationMs: SCENE_DURATION_MS,
      narration: {
        ttsText: toNarration(chapter.body),
        captionMd: `### ${chapter.title}`,
      },
    });

    xCursor += NODE_WIDTH + NODE_GAP;
  });

  // ── Sequential links (cover → ch0 → ch1 → …) ─────────────────────────────
  const links = nodes.slice(0, -1).map((n, i) => ({
    from: n.id,
    to: nodes[i + 1].id,
  }));

  return {
    title: title ?? chapters[0].title,
    world: { w: Math.max(9600, xCursor + 200), h: 6400 },
    nodes,
    links,
    scenes,
    autoAdvance: true,
    voiceSuppress: true,
  };
}
