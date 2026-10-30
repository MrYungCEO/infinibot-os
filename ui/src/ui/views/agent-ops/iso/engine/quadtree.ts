/**
 * Quadtree spatial partitioning for 2D point items (agents).
 * ──────────────────────────────────────────────────────────
 * Backs neighbour / region queries for the world viz so they scale to
 * 1000+ agents at 60fps. A linear scan is O(n) per query; with the world
 * doing flocking / collision-avoidance / hover-pick every frame that becomes
 * O(n²) and tanks the frame budget. The quadtree narrows each query to the
 * cells that actually overlap the region — typically O(log n + k).
 *
 * Design notes:
 *  - Items only need `{ x, y }`. The tree is generic over any such shape so
 *    callers keep their own agent objects (no wrapper allocation per item).
 *  - A flat backing list mirrors the tree. `insert`/`remove` mutate the list
 *    and mark the tree dirty; the next query lazily `rebuild()`s. This keeps
 *    `remove` O(1) amortised without the bookkeeping of in-tree deletion, and
 *    a render loop that mutates many items then issues many queries pays the
 *    rebuild cost exactly once.
 *  - `queryCircle` does a rect broad-phase then an exact radius² narrow-phase.
 */

export interface QuadtreeItem {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface QuadtreeOptions {
  /** Max items in a node before it subdivides. Default 8. */
  capacity?: number;
  /** Max subdivision depth (guards against coincident points). Default 8. */
  maxDepth?: number;
}

interface Node<T> {
  bounds: Rect;
  depth: number;
  items: T[];
  children: [Node<T>, Node<T>, Node<T>, Node<T>] | null;
}

export class Quadtree<T extends QuadtreeItem> {
  private readonly capacity: number;
  private readonly maxDepth: number;
  private bounds: Rect;
  private root: Node<T>;
  private all: T[] = [];
  private dirty = false;

  constructor(bounds: Rect, opts: QuadtreeOptions = {}) {
    this.bounds = { ...bounds };
    this.capacity = Math.max(1, opts.capacity ?? 8);
    this.maxDepth = Math.max(0, opts.maxDepth ?? 8);
    this.root = this.makeNode(this.bounds, 0);
  }

  /** Current item count. */
  get size(): number {
    return this.all.length;
  }

  insert(item: T): void {
    this.all.push(item);
    // Fast path: if clean, drop straight into the live tree.
    if (!this.dirty) this.insertInto(this.root, item);
  }

  /** Remove by identity (===). Returns true if found. */
  remove(item: T): boolean {
    const i = this.all.indexOf(item);
    if (i < 0) return false;
    this.all.splice(i, 1);
    this.dirty = true; // in-tree deletion is fiddly; lazily rebuild instead.
    return true;
  }

  clear(): void {
    this.all = [];
    this.root = this.makeNode(this.bounds, 0);
    this.dirty = false;
  }

  /**
   * Reset bounds (optional) and rebuild the tree from the backing list.
   * Call after mutating many item positions in place, or change the world
   * extent. Cheap to call every frame for a fully-dynamic world.
   */
  rebuild(bounds?: Rect): void {
    if (bounds) this.bounds = { ...bounds };
    this.root = this.makeNode(this.bounds, 0);
    for (const item of this.all) this.insertInto(this.root, item);
    this.dirty = false;
  }

  /** Items whose point falls inside `rect`. */
  queryRect(rect: Rect, out: T[] = []): T[] {
    if (this.dirty) this.rebuild();
    this.queryRectNode(this.root, rect, out);
    return out;
  }

  /** Items within `r` of (cx, cy). */
  queryCircle(cx: number, cy: number, r: number, out: T[] = []): T[] {
    if (this.dirty) this.rebuild();
    const r2 = r * r;
    const broad: Rect = { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r };
    const candidates: T[] = [];
    this.queryRectNode(this.root, broad, candidates);
    for (const it of candidates) {
      const dx = it.x - cx;
      const dy = it.y - cy;
      if (dx * dx + dy * dy <= r2) out.push(it);
    }
    return out;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private makeNode(bounds: Rect, depth: number): Node<T> {
    return { bounds, depth, items: [], children: null };
  }

  private insertInto(node: Node<T>, item: T): void {
    if (!pointInRect(item.x, item.y, node.bounds)) {
      // Outside root bounds: keep it at the root so it's never silently lost.
      if (node === this.root) node.items.push(item);
      return;
    }
    if (node.children) {
      this.insertInto(this.childFor(node, item.x, item.y), item);
      return;
    }
    node.items.push(item);
    if (node.items.length > this.capacity && node.depth < this.maxDepth) {
      this.subdivide(node);
    }
  }

  private subdivide(node: Node<T>): void {
    const { x, y, w, h } = node.bounds;
    const hw = w / 2;
    const hh = h / 2;
    const d = node.depth + 1;
    node.children = [
      this.makeNode({ x, y, w: hw, h: hh }, d), // NW
      this.makeNode({ x: x + hw, y, w: hw, h: hh }, d), // NE
      this.makeNode({ x, y: y + hh, w: hw, h: hh }, d), // SW
      this.makeNode({ x: x + hw, y: y + hh, w: hw, h: hh }, d), // SE
    ];
    const carried = node.items;
    node.items = [];
    for (const it of carried) this.insertInto(this.childFor(node, it.x, it.y), it);
  }

  private childFor(node: Node<T>, x: number, y: number): Node<T> {
    const { x: bx, y: by, w, h } = node.bounds;
    const east = x >= bx + w / 2;
    const south = y >= by + h / 2;
    const idx = (south ? 2 : 0) + (east ? 1 : 0);
    return node.children![idx];
  }

  private queryRectNode(node: Node<T>, rect: Rect, out: T[]): void {
    if (!rectsIntersect(node.bounds, rect)) return;
    for (const it of node.items) {
      if (pointInRect(it.x, it.y, rect)) out.push(it);
    }
    if (node.children) {
      for (const child of node.children) this.queryRectNode(child, rect, out);
    }
  }
}

export function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(
    b.x > a.x + a.w ||
    b.x + b.w < a.x ||
    b.y > a.y + a.h ||
    b.y + b.h < a.y
  );
}

/** Reference linear-scan implementation — used by the quadtree benchmark. */
export function linearQueryRect<T extends QuadtreeItem>(
  items: readonly T[],
  rect: Rect,
): T[] {
  const out: T[] = [];
  for (const it of items) if (pointInRect(it.x, it.y, rect)) out.push(it);
  return out;
}
