export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenBounds {
  width: number;
  height: number;
  padding?: number;
}

export interface SpriteObstacle {
  id: string;
  rect: ScreenRect;
}

export interface BubblePlacementInput {
  id: string;
  ownerId: string;
  preferred: ScreenRect;
  previousOffset?: { x: number; y: number };
}

export interface LabelPlacementInput {
  id: string;
  ownerId: string;
  preferred: ScreenRect;
  /** Screen-space top edge for the below-feet fallback row. */
  fallbackTop: number;
  /** tool-active=4, running=3, idle=2, resting=1. */
  priority: number;
  previousOffset?: { x: number; y: number };
  allowHide?: boolean;
}

export interface OverlayPlacement {
  rect: ScreenRect;
  offsetX: number;
  offsetY: number;
  hidden: boolean;
  movedFar: boolean;
}

export interface OverlayPlacementScene {
  sprites: SpriteObstacle[];
  bubbles: BubblePlacementInput[];
  labels: LabelPlacementInput[];
  bounds?: ScreenBounds;
  gap?: number;
  hysteresisPx?: number;
  cellSize?: number;
}

export interface OverlayPlacementResult {
  bubbles: Record<string, OverlayPlacement>;
  labels: Record<string, OverlayPlacement>;
}

interface IndexedRect {
  key: string;
  rect: ScreenRect;
}

/** Strict overlap (touching edges are allowed). */
export function screenRectsOverlap(a: ScreenRect, b: ScreenRect, gap = 0): boolean {
  return !(
    a.x + a.width + gap <= b.x ||
    b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y ||
    b.y + b.height + gap <= a.y
  );
}

class SpatialHash {
  private readonly cells = new Map<string, IndexedRect[]>();

  constructor(private readonly cellSize: number) {}

  insert(entry: IndexedRect): void {
    for (const key of this.keysFor(entry.rect)) {
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(entry);
      else this.cells.set(key, [entry]);
    }
  }

  query(rect: ScreenRect): IndexedRect[] {
    const found = new Map<string, IndexedRect>();
    for (const key of this.keysFor(rect)) {
      for (const entry of this.cells.get(key) ?? []) found.set(entry.key, entry);
    }
    return [...found.values()];
  }

  private keysFor(rect: ScreenRect): string[] {
    const x0 = Math.floor(rect.x / this.cellSize);
    const y0 = Math.floor(rect.y / this.cellSize);
    const x1 = Math.floor((rect.x + Math.max(0, rect.width - 0.001)) / this.cellSize);
    const y1 = Math.floor((rect.y + Math.max(0, rect.height - 0.001)) / this.cellSize);
    const keys: string[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) keys.push(`${x}:${y}`);
    }
    return keys;
  }
}

function translated(rect: ScreenRect, x: number, y: number): ScreenRect {
  return { x: rect.x + x, y: rect.y + y, width: rect.width, height: rect.height };
}

function insideBounds(rect: ScreenRect, bounds?: ScreenBounds): boolean {
  if (!bounds) return true;
  const p = bounds.padding ?? 4;
  return rect.x >= p && rect.y >= p && rect.x + rect.width <= bounds.width - p && rect.y + rect.height <= bounds.height - p;
}

function dedupeOffsets(offsets: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const seen = new Set<string>();
  return offsets.filter((offset) => {
    const key = `${Math.round(offset.x * 10)}:${Math.round(offset.y * 10)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function movementScore(
  offset: { x: number; y: number },
  previous: { x: number; y: number } | undefined,
  hysteresisPx: number,
): number {
  const preferredDistance = Math.hypot(offset.x, offset.y);
  if (!previous) return preferredDistance;
  const movedFromPrevious = Math.hypot(offset.x - previous.x, offset.y - previous.y);
  return preferredDistance + (movedFromPrevious > 0.5 ? hysteresisPx : 0);
}

function bubbleCandidates(item: BubblePlacementInput): Array<{ x: number; y: number }> {
  const xStep = Math.max(24, item.preferred.width * 0.62);
  const yStep = Math.max(18, item.preferred.height + 6);
  const candidates: Array<{ x: number; y: number }> = [];
  if (item.previousOffset) candidates.push(item.previousOffset);
  for (let row = 0; row < 10; row++) {
    const y = row === 0 ? 0 : -row * yStep;
    candidates.push({ x: 0, y });
    for (let col = 1; col <= 4; col++) {
      candidates.push({ x: -col * xStep, y }, { x: col * xStep, y });
    }
  }
  return dedupeOffsets(candidates);
}

function labelCandidates(item: LabelPlacementInput, gap: number): Array<{ x: number; y: number }> {
  const rowStep = item.preferred.height + gap;
  const colStep = Math.max(24, item.preferred.width * 0.72 + gap);
  const candidates: Array<{ x: number; y: number }> = [];
  if (item.previousOffset) candidates.push(item.previousOffset);

  // Prefer the authored position, then climb above it. Alternating columns
  // keeps dense rows compact without turning every plate into a tall tower.
  for (let row = 0; row < 12; row++) {
    const y = row === 0 ? 0 : -row * rowStep;
    candidates.push({ x: 0, y });
    for (let col = 1; col <= 3; col++) {
      candidates.push({ x: -col * colStep, y }, { x: col * colStep, y });
    }
  }

  // If the space above is saturated, place the label below the owner's feet.
  // Continue downward for crowded resting beds rather than covering a sprite.
  const fallbackOffset = item.fallbackTop - item.preferred.y;
  for (let row = 0; row < 8; row++) {
    const y = fallbackOffset + row * rowStep;
    candidates.push({ x: 0, y });
    for (let col = 1; col <= 3; col++) {
      candidates.push({ x: -col * colStep, y }, { x: col * colStep, y });
    }
  }
  return dedupeOffsets(candidates);
}

function placeOne(
  hash: SpatialHash,
  keyPrefix: string,
  id: string,
  preferred: ScreenRect,
  candidates: Array<{ x: number; y: number }>,
  previous: { x: number; y: number } | undefined,
  gap: number,
  hysteresisPx: number,
  bounds: ScreenBounds | undefined,
  allowHide: boolean,
): OverlayPlacement {
  const ranked = candidates
    .map((offset, order) => ({ offset, order, score: movementScore(offset, previous, hysteresisPx) }))
    .sort((a, b) => a.score - b.score || a.order - b.order);

  for (const candidate of ranked) {
    const rect = translated(preferred, candidate.offset.x, candidate.offset.y);
    if (!insideBounds(rect, bounds)) continue;
    const queryRect = {
      x: rect.x - gap,
      y: rect.y - gap,
      width: rect.width + gap * 2,
      height: rect.height + gap * 2,
    };
    if (hash.query(queryRect).some((entry) => screenRectsOverlap(rect, entry.rect, gap))) continue;
    hash.insert({ key: `${keyPrefix}:${id}`, rect });
    return {
      rect,
      offsetX: candidate.offset.x,
      offsetY: candidate.offset.y,
      hidden: false,
      movedFar: Math.hypot(candidate.offset.x, candidate.offset.y) > 20,
    };
  }

  if (allowHide) {
    return { rect: preferred, offsetX: 0, offsetY: 0, hidden: true, movedFar: false };
  }

  // Bubbles must remain readable. In the pathological case where the bounded
  // candidate grid is exhausted, keep walking upward until a free slot exists.
  const step = Math.max(18, preferred.height + gap);
  for (let row = 12; row < 80; row++) {
    const offset = { x: 0, y: -row * step };
    const rect = translated(preferred, offset.x, offset.y);
    if (bounds && !insideBounds(rect, bounds)) {
      // Once the top edge is exhausted, fan horizontally on the first valid row.
      for (let col = 1; col < 20; col++) {
        for (const sign of [-1, 1]) {
          const side = { x: sign * col * (preferred.width + gap), y: 0 };
          const sideRect = translated(preferred, side.x, side.y);
          if (!insideBounds(sideRect, bounds)) continue;
          const queryRect = {
            x: sideRect.x - gap,
            y: sideRect.y - gap,
            width: sideRect.width + gap * 2,
            height: sideRect.height + gap * 2,
          };
          if (hash.query(queryRect).some((entry) => screenRectsOverlap(sideRect, entry.rect, gap))) continue;
          hash.insert({ key: `${keyPrefix}:${id}`, rect: sideRect });
          return { rect: sideRect, offsetX: side.x, offsetY: side.y, hidden: false, movedFar: true };
        }
      }
      break;
    }
    const queryRect = {
      x: rect.x - gap,
      y: rect.y - gap,
      width: rect.width + gap * 2,
      height: rect.height + gap * 2,
    };
    if (hash.query(queryRect).some((entry) => screenRectsOverlap(rect, entry.rect, gap))) continue;
    hash.insert({ key: `${keyPrefix}:${id}`, rect });
    return { rect, offsetX: offset.x, offsetY: offset.y, hidden: false, movedFar: true };
  }

  // A viewport completely packed with obstacles is still better served by a
  // visible bubble than a silently missing tool call.
  return { rect: preferred, offsetX: 0, offsetY: 0, hidden: false, movedFar: false };
}

/**
 * Place tool-bubble stacks first, then agent labels by semantic priority.
 * All geometry is screen-space; callers convert the resulting offsets back to
 * world units. A spatial hash bounds collision checks for 30+ agent scenes.
 */
export function placeAgentOverlays(scene: OverlayPlacementScene): OverlayPlacementResult {
  const gap = scene.gap ?? 3;
  const hysteresisPx = scene.hysteresisPx ?? 9;
  const hash = new SpatialHash(scene.cellSize ?? 64);
  const result: OverlayPlacementResult = { bubbles: {}, labels: {} };

  for (const sprite of scene.sprites) hash.insert({ key: `sprite:${sprite.id}`, rect: sprite.rect });

  for (const bubble of [...scene.bubbles].sort((a, b) => a.id.localeCompare(b.id))) {
    result.bubbles[bubble.id] = placeOne(
      hash,
      "bubble",
      bubble.id,
      bubble.preferred,
      bubbleCandidates(bubble),
      bubble.previousOffset,
      gap,
      hysteresisPx,
      scene.bounds,
      false,
    );
  }

  const labels = [...scene.labels].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  for (const label of labels) {
    result.labels[label.id] = placeOne(
      hash,
      "label",
      label.id,
      label.preferred,
      labelCandidates(label, gap),
      label.previousOffset,
      gap,
      hysteresisPx,
      scene.bounds,
      label.allowHide ?? true,
    );
  }

  return result;
}

// ── Floating cards / tooltips ─────────────────────────────────────────────

export type FloatingSide = "right" | "left" | "bottom" | "top";

export interface FloatingPlacementInput {
  /** The thing being described (e.g. agent sprite ∪ its name tag). The card
   *  never covers it unless the viewport leaves no other option. */
  anchor: ScreenRect;
  size: { width: number; height: number };
  bounds: { width: number; height: number };
  /** Other labels to keep clear (agent name tags, floor/zone signs). */
  obstacles?: readonly ScreenRect[];
  /** Preference order; earlier sides win ties. */
  sides?: readonly FloatingSide[];
  gap?: number;
  margin?: number;
}

export interface FloatingPlacement {
  x: number;
  y: number;
  side: FloatingSide;
  /** Overlap area (px²) with the anchor, after clamping. */
  anchorOverlap: number;
  /** Total overlap area (px²) with the obstacles, after clamping. */
  obstacleOverlap: number;
}

function intersectionArea(a: ScreenRect, b: ScreenRect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function clampAxis(v: number, size: number, extent: number, margin: number): number {
  const max = extent - size - margin;
  return max < margin ? margin : Math.max(margin, Math.min(v, max));
}

/**
 * Place a floating card beside an anchor so it does not sit on the anchor's
 * own name tag or on nearby labels, flipping sides and sliding along the
 * edge (centred / start-aligned / end-aligned) to dodge collisions, and
 * clamped inside the viewport. Pure screen-space geometry.
 */
export function placeFloatingRect(input: FloatingPlacementInput): FloatingPlacement {
  const gap = input.gap ?? 14;
  const margin = input.margin ?? 12;
  const sides = input.sides ?? (["right", "left", "bottom", "top"] as const);
  const { anchor, size, bounds } = input;
  const obstacles = input.obstacles ?? [];
  const w = size.width;
  const h = size.height;
  const ax0 = anchor.x;
  const ay0 = anchor.y;
  const ax1 = anchor.x + anchor.width;
  const ay1 = anchor.y + anchor.height;
  const acx = ax0 + anchor.width / 2;
  const acy = ay0 + anchor.height / 2;

  let best: (FloatingPlacement & { score: number }) | null = null;
  sides.forEach((side, sideIdx) => {
    const raw: Array<{ x: number; y: number }> = [];
    if (side === "right" || side === "left") {
      const x = side === "right" ? ax1 + gap : ax0 - gap - w;
      raw.push({ x, y: acy - h / 2 }, { x, y: ay0 }, { x, y: ay1 - h });
    } else {
      const y = side === "bottom" ? ay1 + gap : ay0 - gap - h;
      raw.push({ x: acx - w / 2, y }, { x: ax0, y }, { x: ax1 - w, y });
    }
    raw.forEach((p, variant) => {
      const x = clampAxis(p.x, w, bounds.width, margin);
      const y = clampAxis(p.y, h, bounds.height, margin);
      const rect = { x, y, width: w, height: h };
      const anchorOverlap = intersectionArea(rect, anchor);
      let obstacleOverlap = 0;
      for (const o of obstacles) obstacleOverlap += intersectionArea(rect, o);
      const shift = Math.abs(x - p.x) + Math.abs(y - p.y);
      const score = anchorOverlap * 4 + obstacleOverlap + shift * 0.05 + sideIdx * 0.5 + variant * 0.1;
      if (!best || score < best.score) best = { x, y, side, anchorOverlap, obstacleOverlap, score };
    });
  });
  const b = best as (FloatingPlacement & { score: number }) | null;
  if (!b) {
    return {
      x: clampAxis(ax1 + gap, w, bounds.width, margin),
      y: clampAxis(acy - h / 2, h, bounds.height, margin),
      side: "right",
      anchorOverlap: 0,
      obstacleOverlap: 0,
    };
  }
  return { x: b.x, y: b.y, side: b.side, anchorOverlap: b.anchorOverlap, obstacleOverlap: b.obstacleOverlap };
}
