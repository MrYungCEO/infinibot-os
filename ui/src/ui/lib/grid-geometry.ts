// ============================================================
// Shared grid-placement geometry
// ============================================================
//
// Pure, view-agnostic geometry for the absolute-positioned "tile" grid used by
// both the masonry-grid view (GridPanel) and the terminals view (TerminalTile).
//
// Every function is generic over `T extends GridRect` and returns the caller's
// own objects (other fields preserved via spread), so a view can keep its rich
// per-tile metadata while reusing the drag / resize / snap / dock / tile math.
//
// The math here is a verbatim extraction of the original masonry-grid controller
// behaviour — callers pass their own constants via `GridEnv` so output is
// byte-identical to the pre-refactor implementation.

/** Minimal rectangle every grid tile must expose for placement math. */
export interface GridRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  minimized?: boolean;
  maximized?: boolean;
  /** Locked aspect ratio (width / height); resize math honours it when set. */
  aspectRatio?: number;
}

/** Placement environment: container size, snap config, min sizes, grid mode. */
export interface GridEnv {
  containerWidth: number;
  containerHeight: number;
  snapSize: number;
  snapThreshold: number;
  minWidth: number;
  minHeight: number;
  gridMode: "free" | "snap" | "masonry";
  /** Uniform gutter (px) placed between tiles and around the canvas edge by the
   *  tile* arrange helpers. Defaults to 0 (flush, edge-to-edge tiling). Set it
   *  to mirror the masonry /grid page, which lays panels out with a 12px gap. */
  gap?: number;
}

export interface SnapGuide {
  type: "vertical" | "horizontal";
  position: number;
  start: number;
  end: number;
}

export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

// ============================================================
// Position + edge snapping
// ============================================================

/** Snap edges contributed by the container and every other (visible) tile. */
function getSnapEdges<T extends GridRect>(
  rects: T[],
  excludeId: string,
  env: GridEnv,
): { vertical: number[]; horizontal: number[] } {
  const vertical: number[] = [0, env.containerWidth];
  const horizontal: number[] = [0, env.containerHeight];

  for (const p of rects) {
    if (p.id === excludeId || p.minimized) continue;
    vertical.push(p.x, p.x + p.width);
    horizontal.push(p.y, p.y + p.height);
  }

  return {
    vertical: [...new Set(vertical)].sort((a, b) => a - b),
    horizontal: [...new Set(horizontal)].sort((a, b) => a - b),
  };
}

/**
 * Move a tile to (x, y) applying grid snap, edge snap to neighbours/container,
 * and bounds clamping (10% overflow allowed). Returns a new array; only the
 * dragged tile's x/y change.
 */
export function snapRectPosition<T extends GridRect>(
  rects: T[],
  id: string,
  x: number,
  y: number,
  env: GridEnv,
  enableEdgeSnap = true,
): T[] {
  const panel = rects.find((p) => p.id === id);
  if (!panel) return rects;

  let finalX = x;
  let finalY = y;

  if (env.gridMode === "snap") {
    finalX = Math.round(x / env.snapSize) * env.snapSize;
    finalY = Math.round(y / env.snapSize) * env.snapSize;
  }

  if (enableEdgeSnap && env.gridMode !== "masonry") {
    const edges = getSnapEdges(rects, id, env);

    for (const edge of edges.vertical) {
      if (Math.abs(finalX - edge) < env.snapThreshold) {
        finalX = edge;
        break;
      }
      if (Math.abs(finalX + panel.width - edge) < env.snapThreshold) {
        finalX = edge - panel.width;
        break;
      }
    }

    for (const edge of edges.horizontal) {
      if (Math.abs(finalY - edge) < env.snapThreshold) {
        finalY = edge;
        break;
      }
      if (Math.abs(finalY + panel.height - edge) < env.snapThreshold) {
        finalY = edge - panel.height;
        break;
      }
    }
  }

  const overflow = 0.1;
  const minX = -panel.width * overflow;
  const maxX = env.containerWidth - panel.width * (1 - overflow);
  const minY = 0;
  const maxY = env.containerHeight - panel.height * (1 - overflow);

  const clampedX = Math.max(minX, Math.min(finalX, maxX));
  const clampedY = Math.max(minY, Math.min(finalY, maxY));

  return rects.map((p) =>
    p.id === id ? { ...p, x: clampedX, y: clampedY } : p,
  );
}

/** Snap guides to render while dragging, for visual feedback. */
export function getActiveSnapGuides<T extends GridRect>(
  rects: T[],
  id: string,
  x: number,
  y: number,
  env: GridEnv,
): SnapGuide[] {
  const panel = rects.find((p) => p.id === id);
  if (!panel || env.gridMode === "masonry") return [];

  const guides: SnapGuide[] = [];
  const edges = getSnapEdges(rects, id, env);

  for (const edge of edges.vertical) {
    if (Math.abs(x - edge) < env.snapThreshold) {
      guides.push({ type: "vertical", position: edge, start: 0, end: env.containerHeight });
    }
    if (Math.abs(x + panel.width - edge) < env.snapThreshold) {
      guides.push({ type: "vertical", position: edge, start: 0, end: env.containerHeight });
    }
  }

  for (const edge of edges.horizontal) {
    if (Math.abs(y - edge) < env.snapThreshold) {
      guides.push({ type: "horizontal", position: edge, start: 0, end: env.containerWidth });
    }
    if (Math.abs(y + panel.height - edge) < env.snapThreshold) {
      guides.push({ type: "horizontal", position: edge, start: 0, end: env.containerWidth });
    }
  }

  return guides;
}

// ============================================================
// Linked-edge resize (split-pane behaviour)
// ============================================================

export interface LinkedPanelSnapshot {
  panelId: string;
  side: "n" | "s" | "e" | "w";
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
}

const ADJACENCY_PX = 6;
const OVERLAP_PX = 24;

/**
 * Find every tile whose edge sits on the same line as `edge` of `id`, with
 * sufficient perpendicular overlap, so a shared boundary can be split-dragged.
 */
export function findLinkedPanels<T extends GridRect>(
  rects: T[],
  id: string,
  edge: ResizeEdge,
): LinkedPanelSnapshot[] {
  const me = rects.find((p) => p.id === id);
  if (!me) return [];

  const result: LinkedPanelSnapshot[] = [];
  const myLeft = me.x;
  const myRight = me.x + me.width;
  const myTop = me.y;
  const myBottom = me.y + me.height;

  const horizontalSide: "e" | "w" | null = edge.includes("e") ? "e" : edge.includes("w") ? "w" : null;
  const verticalSide: "n" | "s" | null = edge.includes("n") ? "n" : edge.includes("s") ? "s" : null;

  for (const p of rects) {
    if (p.id === id || p.minimized || p.maximized) continue;
    const pLeft = p.x;
    const pRight = p.x + p.width;
    const pTop = p.y;
    const pBottom = p.y + p.height;

    const verticalOverlap = Math.min(myBottom, pBottom) - Math.max(myTop, pTop);
    if (horizontalSide && verticalOverlap > OVERLAP_PX) {
      if (horizontalSide === "e" && Math.abs(pLeft - myRight) < ADJACENCY_PX) {
        result.push({ panelId: p.id, side: "w", startX: p.x, startY: p.y, startWidth: p.width, startHeight: p.height });
      }
      if (horizontalSide === "w" && Math.abs(pRight - myLeft) < ADJACENCY_PX) {
        result.push({ panelId: p.id, side: "e", startX: p.x, startY: p.y, startWidth: p.width, startHeight: p.height });
      }
    }

    const horizontalOverlap = Math.min(myRight, pRight) - Math.max(myLeft, pLeft);
    if (verticalSide && horizontalOverlap > OVERLAP_PX) {
      if (verticalSide === "s" && Math.abs(pTop - myBottom) < ADJACENCY_PX) {
        result.push({ panelId: p.id, side: "n", startX: p.x, startY: p.y, startWidth: p.width, startHeight: p.height });
      }
      if (verticalSide === "n" && Math.abs(pBottom - myTop) < ADJACENCY_PX) {
        result.push({ panelId: p.id, side: "s", startX: p.x, startY: p.y, startWidth: p.width, startHeight: p.height });
      }
    }
  }
  return result;
}

/** Move linked neighbours in lockstep with a dragged shared boundary. */
export function applyLinkedResize<T extends GridRect>(
  rects: T[],
  links: LinkedPanelSnapshot[],
  dxRight: number,
  dxLeft: number,
  dyBottom: number,
  dyTop: number,
  env: GridEnv,
): T[] {
  if (links.length === 0) return rects;

  const byId = new Map(links.map((l) => [l.panelId, l] as const));
  return rects.map((p) => {
    const link = byId.get(p.id);
    if (!link) return p;

    let nx = link.startX, ny = link.startY, nw = link.startWidth, nh = link.startHeight;
    if (link.side === "w") {
      nx = link.startX + dxRight;
      nw = Math.max(env.minWidth, link.startWidth - dxRight);
    }
    if (link.side === "e") {
      nw = Math.max(env.minWidth, link.startWidth + dxLeft);
    }
    if (link.side === "n") {
      ny = link.startY + dyBottom;
      nh = Math.max(env.minHeight, link.startHeight - dyBottom);
    }
    if (link.side === "s") {
      nh = Math.max(env.minHeight, link.startHeight + dyTop);
    }
    return { ...p, x: nx, y: ny, width: nw, height: nh };
  });
}

// ============================================================
// Edge resize
// ============================================================

export interface RectBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Resize a box by dragging `edge` by (dx, dy) relative to its start rect.
 * Honours min sizes (clamping x/y when a north/west edge would invert), and
 * an optional locked aspect ratio (width / height) for corner drags.
 */
export function resizeBox(
  start: RectBox,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  env: GridEnv,
  lockAspect?: number,
): RectBox {
  let { x, y, width, height } = start;

  if (edge.includes("e")) {
    width = Math.max(env.minWidth, start.width + dx);
  }
  if (edge.includes("w")) {
    const rawWidth = start.width - dx;
    width = Math.max(env.minWidth, rawWidth);
    x = start.x + (start.width - width);
  }
  if (edge.includes("s")) {
    height = Math.max(env.minHeight, start.height + dy);
  }
  if (edge.includes("n")) {
    const rawHeight = start.height - dy;
    height = Math.max(env.minHeight, rawHeight);
    y = start.y + (start.height - height);
  }

  // Corner drag with a locked aspect ratio: derive height from width.
  const isCorner = edge.length === 2;
  if (lockAspect && lockAspect > 0 && isCorner) {
    height = Math.max(env.minHeight, Math.round(width / lockAspect));
    width = Math.round(height * lockAspect);
    if (edge.includes("w")) x = start.x + (start.width - width);
    if (edge.includes("n")) y = start.y + (start.height - height);
  }

  return { x, y, width, height };
}

// ============================================================
// Edge dock snapping
// ============================================================

export interface DockZone {
  targetId: string;
  edge: "n" | "s" | "e" | "w" | "center";
  rect: { x: number; y: number; width: number; height: number };
  targetRect?: { x: number; y: number; width: number; height: number };
}

const DOCK_EDGE_FRACTION = 0.28;
const DOCK_CENTER_THRESHOLD = 0.18;
const DOCK_OUTSIDE_BUFFER = 16;

/** Find the dock zone (if any) under the cursor while dragging tile `draggedId`. */
export function getDockZone<T extends GridRect>(
  rects: T[],
  draggedId: string,
  cursorX: number,
  cursorY: number,
  env: GridEnv,
  options?: { preferFullHeightSides?: boolean },
): DockZone | null {
  const candidates = rects
    .filter((p) => p.id !== draggedId && !p.minimized && !p.maximized)
    .sort((a, b) => b.zIndex - a.zIndex);

  for (const t of candidates) {
    const tx = t.x;
    const ty = t.y;
    const tw = t.width;
    const th = t.height;
    if (
      cursorX < tx - DOCK_OUTSIDE_BUFFER ||
      cursorX > tx + tw + DOCK_OUTSIDE_BUFFER ||
      cursorY < ty - DOCK_OUTSIDE_BUFFER ||
      cursorY > ty + th + DOCK_OUTSIDE_BUFFER
    ) continue;

    const localX = (cursorX - tx) / tw;
    const localY = (cursorY - ty) / th;

    if (
      localX > 0.5 - DOCK_CENTER_THRESHOLD &&
      localX < 0.5 + DOCK_CENTER_THRESHOLD &&
      localY > 0.5 - DOCK_CENTER_THRESHOLD &&
      localY < 0.5 + DOCK_CENTER_THRESHOLD
    ) {
      return { targetId: t.id, edge: "center", rect: { x: tx, y: ty, width: tw, height: th } };
    }

    const dN = localY;
    const dS = 1 - localY;
    const dE = 1 - localX;
    const dW = localX;
    const minDist = Math.min(dN, dS, dE, dW);
    if (minDist > DOCK_EDGE_FRACTION) continue;

    // Terminal workspaces are most useful as tall columns. Near a corner,
    // prefer a left/right hover target while it remains inside the edge band.
    if (options?.preferFullHeightSides) {
      const sideDist = Math.min(dE, dW);
      if (sideDist <= DOCK_EDGE_FRACTION) {
        const half = Math.max(env.minWidth, Math.floor(tw / 2));
        if (dE <= dW) {
          return {
            targetId: t.id,
            edge: "e",
            rect: { x: tx + (tw - half), y: ty, width: half, height: th },
            targetRect: { x: tx, y: ty, width: tw - half, height: th },
          };
        }
        return {
          targetId: t.id,
          edge: "w",
          rect: { x: tx, y: ty, width: half, height: th },
          targetRect: { x: tx + half, y: ty, width: tw - half, height: th },
        };
      }
    }

    if (minDist === dN) {
      const half = Math.max(env.minHeight, Math.floor(th / 2));
      return {
        targetId: t.id,
        edge: "n",
        rect: { x: tx, y: ty, width: tw, height: half },
        targetRect: { x: tx, y: ty + half, width: tw, height: th - half },
      };
    }
    if (minDist === dS) {
      const half = Math.max(env.minHeight, Math.floor(th / 2));
      return {
        targetId: t.id,
        edge: "s",
        rect: { x: tx, y: ty + (th - half), width: tw, height: half },
        targetRect: { x: tx, y: ty, width: tw, height: th - half },
      };
    }
    if (minDist === dE) {
      const half = Math.max(env.minWidth, Math.floor(tw / 2));
      return {
        targetId: t.id,
        edge: "e",
        rect: { x: tx + (tw - half), y: ty, width: half, height: th },
        targetRect: { x: tx, y: ty, width: tw - half, height: th },
      };
    }
    if (minDist === dW) {
      const half = Math.max(env.minWidth, Math.floor(tw / 2));
      return {
        targetId: t.id,
        edge: "w",
        rect: { x: tx, y: ty, width: half, height: th },
        targetRect: { x: tx + half, y: ty, width: tw - half, height: th },
      };
    }
  }
  return null;
}

/** Apply a dock zone: reshape the dragged tile (+ target), or swap on centre. */
export function applyDockZone<T extends GridRect>(
  rects: T[],
  draggedId: string,
  zone: DockZone,
  env: GridEnv,
): T[] {
  const dragged = rects.find((p) => p.id === draggedId);
  const target = rects.find((p) => p.id === zone.targetId);
  if (!dragged || !target) return rects;

  if (zone.edge === "center") {
    return rects.map((p) => {
      if (p.id === draggedId) {
        return { ...p, x: target.x, y: target.y, width: target.width, height: target.height };
      }
      if (p.id === target.id) {
        return { ...p, x: dragged.x, y: dragged.y, width: dragged.width, height: dragged.height };
      }
      return p;
    });
  }

  return rects.map((p) => {
    if (p.id === draggedId) {
      return {
        ...p,
        x: zone.rect.x,
        y: zone.rect.y,
        width: Math.max(env.minWidth, zone.rect.width),
        height: Math.max(env.minHeight, zone.rect.height),
      };
    }
    if (p.id === target.id && zone.targetRect) {
      return {
        ...p,
        x: zone.targetRect.x,
        y: zone.targetRect.y,
        width: Math.max(env.minWidth, zone.targetRect.width),
        height: Math.max(env.minHeight, zone.targetRect.height),
      };
    }
    return p;
  });
}

// ============================================================
// Quick tile layouts
// ============================================================

/** Lay all tiles out as equal-width vertical columns. */
export function tileHorizontal<T extends GridRect>(rects: T[], env: GridEnv): T[] {
  const count = rects.length;
  if (count === 0) return rects;
  const panelWidth = Math.floor(env.containerWidth / count);
  return rects.map((panel, i) => ({
    ...panel,
    x: i * panelWidth,
    y: 0,
    width: panelWidth,
    height: env.containerHeight,
    minimized: false,
    maximized: false,
  }));
}

/** Stack all tiles as equal-height rows. */
export function tileVertical<T extends GridRect>(rects: T[], env: GridEnv): T[] {
  const count = rects.length;
  if (count === 0) return rects;
  const panelHeight = Math.floor(env.containerHeight / count);
  return rects.map((panel, i) => ({
    ...panel,
    x: 0,
    y: i * panelHeight,
    width: env.containerWidth,
    height: panelHeight,
    minimized: false,
    maximized: false,
  }));
}

/** Arrange all tiles in a near-square grid (ceil(sqrt) columns). */
export function tileGrid<T extends GridRect>(rects: T[], env: GridEnv): T[] {
  const count = rects.length;
  if (count === 0) return rects;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  // `gap` adds a uniform gutter between tiles and around the canvas edge
  // (gap === 0 reduces to the original flush, edge-to-edge layout).
  const gap = env.gap ?? 0;
  const innerW = env.containerWidth - gap * (cols + 1);
  const innerH = env.containerHeight - gap * (rows + 1);
  const panelWidth = Math.floor(innerW / cols);
  const panelHeight = Math.floor(innerH / rows);
  // Math.floor leaves up to (cols-1)/(rows-1) px of remainder; push it into the
  // trailing tiles so the grid fills snugly to the (gap-inset) canvas edge.
  const lastColExtra = innerW - panelWidth * cols;
  const lastRowExtra = innerH - panelHeight * rows;
  return rects.map((panel, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const isLastCol = col === cols - 1;
    const isLastRow = row === rows - 1;
    return {
      ...panel,
      x: gap + col * (panelWidth + gap),
      y: gap + row * (panelHeight + gap),
      width: panelWidth + (isLastCol ? lastColExtra : 0),
      height: panelHeight + (isLastRow ? lastRowExtra : 0),
      minimized: false,
      maximized: false,
    };
  });
}

/** Arrange tiles into an explicit column count (used by quick presets). */
export function tileColumns<T extends GridRect>(rects: T[], cols: number, env: GridEnv): T[] {
  const count = rects.length;
  if (count === 0 || cols < 1) return rects;
  const effectiveCols = Math.min(cols, count);
  const rows = Math.ceil(count / effectiveCols);
  // `gap` adds a uniform gutter between tiles and around the canvas edge
  // (gap === 0 reduces to the original flush, edge-to-edge layout).
  const gap = env.gap ?? 0;
  const innerW = env.containerWidth - gap * (effectiveCols + 1);
  const innerH = env.containerHeight - gap * (rows + 1);
  const panelWidth = Math.floor(innerW / effectiveCols);
  const panelHeight = Math.floor(innerH / rows);
  // Distribute sub-pixel remainder so tiles fill exactly to the (gap-inset)
  // canvas edge (same technique as tileGrid — prevents 1-px gaps).
  const lastColExtra = innerW - panelWidth * effectiveCols;
  const lastRowExtra = innerH - panelHeight * rows;
  return rects.map((panel, i) => {
    const col = i % effectiveCols;
    const row = Math.floor(i / effectiveCols);
    const isLastCol = col === effectiveCols - 1;
    const isLastRow = row === rows - 1;
    return {
      ...panel,
      x: gap + col * (panelWidth + gap),
      y: gap + row * (panelHeight + gap),
      width: panelWidth + (isLastCol ? lastColExtra : 0),
      height: panelHeight + (isLastRow ? lastRowExtra : 0),
      minimized: false,
      maximized: false,
    };
  });
}

/**
 * Focus layout: the first tile takes a wide `focusFraction` column on the
 * given side; remaining tiles stack in the leftover column.
 */
export function tileFocus<T extends GridRect>(
  rects: T[],
  side: "left" | "right",
  env: GridEnv,
  focusFraction = 0.62,
): T[] {
  const count = rects.length;
  if (count === 0) return rects;
  // `gap` adds a uniform gutter between tiles and around the canvas edge
  // (gap === 0 reduces to the original flush, edge-to-edge layout).
  const gap = env.gap ?? 0;
  const usableW = env.containerWidth - gap * 2;
  const usableH = env.containerHeight - gap * 2;
  if (count === 1) {
    return rects.map((panel) => ({
      ...panel,
      x: gap,
      y: gap,
      width: usableW,
      height: usableH,
      minimized: false,
      maximized: false,
    }));
  }

  // One gutter sits between the focus column and the stack column.
  const focusWidth = Math.floor((usableW - gap) * focusFraction);
  const sideWidth = usableW - gap - focusWidth;
  const focusX = side === "left" ? gap : env.containerWidth - gap - focusWidth;
  const sideX = side === "left" ? env.containerWidth - gap - sideWidth : gap;
  const stackCount = count - 1;
  const stackHeight = Math.floor((usableH - gap * (stackCount - 1)) / stackCount);

  return rects.map((panel, i) => {
    if (i === 0) {
      return {
        ...panel,
        x: focusX,
        y: gap,
        width: focusWidth,
        height: usableH,
        minimized: false,
        maximized: false,
      };
    }
    const idx = i - 1;
    return {
      ...panel,
      x: sideX,
      y: gap + idx * (stackHeight + gap),
      width: sideWidth,
      height: stackHeight,
      minimized: false,
      maximized: false,
    };
  });
}
